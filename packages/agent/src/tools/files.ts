// File and shell tools for the Pi runtime. Everything is confined to the project directory: the engine (engine/,
// engine_modules/) is read-only, nothing outside the project is reachable (the shell runs in a sandbox, see
// sandbox.ts), commands run with a timeout and see no keys.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nodeEnv } from '../project.js';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { rewriteRefusal } from '../runtime/types.js';
import { confine } from './sandbox.js';
import { editIn, readIn, writeIn } from '../projectfs.js';
import { sniffPicture } from '../pictures.js';

const READ_ONLY = ['engine', 'engine_modules', '.git'];
const STUDIO = '.studio';
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const MAX_TEXT = 60_000;

/** the lexical check, for its messages: what a name may reach is decided again on what is opened (projectfs.ts), since
 *  the agent's shell can plant links in the project */
export function resolveIn(root: string, p: string, write = false): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path is outside the project directory: ${p}`);
  const top = rel.split(path.sep)[0];
  if (write && READ_ONLY.includes(top)) throw new Error(`cannot change ${p}: the engine directory is read-only`);
  // the studio's own record of the run (its events, sessions, state) is not the film: an agent unsure of a change mined
  // it for minutes. Only the planner's decision on a change is written there.
  if (top === STUDIO && rel !== path.join(STUDIO, 'revision.json')) throw new Error(`${p} is the studio's record, not part of the film`);
  return abs;
}

/** what the model service takes of a picture: no side over 8000 px, at most 5 MB of base64 */
const IMAGE_SIDE_MAX = 7900, IMAGE_BYTES_MAX = 3_700_000;
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: undefined });

const ReadP = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) });
const WriteP = Type.Object({ path: Type.String(), content: Type.String() });
// finish: the last edits of a check round, sent together in one reply — the round ends as soon as they apply, with no
// further model turn just to say so (the orchestrator lints and looks again anyway). Ignored unless every call in the
// reply sets it, and a failed edit never ends the round.
const EditP = Type.Object({ path: Type.String(), old_string: Type.String(), new_string: Type.String(), replace_all: Type.Optional(Type.Boolean()),
  finish: Type.Optional(Type.Boolean({ description: 'true when this reply holds all of this round\'s edits: the round ends once they apply, no reply needed' })) });
const BashP = Type.Object({ command: Type.String() });

/** the shell's environment: only what a shell and the engine tools need (nodeEnv), never the service's secrets */
const shellEnv = () => nodeEnv();

export function fileTools(root: string, opts: { timeoutMs?: number } = {}): AgentTool<any>[] {
  const read: AgentTool<typeof ReadP> = {
    name: 'read', label: 'Read',
    description: 'Read a file in the project. Images (png/jpg) are returned as images you can look at. Optional offset/limit are line numbers for large text files.',
    parameters: ReadP,
    execute: async (_id, p) => {
      const abs = resolveIn(root, p.path);
      const bytes = readIn(root, abs, { engine: true, shown: p.path });
      if (IMAGE.test(abs)) {
        // a picture the model service refuses (a side over 8000 px, or over 5 MB once encoded) is described, never sent:
        // sent, it failed the whole turn (seen 2026-10-28: a brand's 8376 px wide logo stopped a storyboard twice)
        const size = sniffPicture(bytes);
        if ((size && Math.max(size.w, size.h) > IMAGE_SIDE_MAX) || bytes.length > IMAGE_BYTES_MAX) {
          return text(`${p.path} is a picture${size ? ` of ${size.w}×${size.h} px` : ''}, too large to be shown to you (${size && Math.max(size.w, size.h) > IMAGE_SIDE_MAX ? `the limit is ${IMAGE_SIDE_MAX} px a side` : `${(bytes.length / 1e6).toFixed(1)} MB`}). Go by its name and what the brief says it is; it can still be placed on a page.`);
        }
        const mime = /\.png$/i.test(abs) ? 'image/png' : /\.webp$/i.test(abs) ? 'image/webp' : /\.gif$/i.test(abs) ? 'image/gif' : 'image/jpeg';
        return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: mime }], details: undefined };
      }
      const lines = bytes.toString('utf8').split('\n');
      const from = Math.max(0, (p.offset ?? 1) - 1), to = p.limit ? from + p.limit : lines.length;
      let out = lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`).join('\n');
      if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT) + `\n… (truncated; read with offset/limit)`;
      return text(out);
    },
  };
  const write: AgentTool<typeof WriteP> = {
    name: 'write', label: 'Write',
    description: 'Create a new file in the project (or replace a small one). To change a page (pages/*.js) or a component (extras/kit/*.js) that already exists, use edit: rewriting it whole is refused.',
    parameters: WriteP,
    executionMode: 'sequential',
    execute: async (_id, p) => {
      const abs = resolveIn(root, p.path, true);
      writeIn(root, abs, p.content, { shown: p.path, before: (existing) => {
        const refused = rewriteRefusal(path.relative(root, abs), existing);
        if (refused) throw new Error(refused);
      } });
      return text(`wrote ${p.path} (${p.content.split('\n').length} lines)`);
    },
  };
  const edit: AgentTool<typeof EditP> = {
    name: 'edit', label: 'Edit',
    description: 'Replace an exact string in a file. old_string must occur exactly once unless replace_all is true.',
    parameters: EditP,
    executionMode: 'sequential',
    execute: async (_id, p) => {
      const abs = resolveIn(root, p.path, true);
      let n = 0;
      editIn(root, abs, (src) => {
        n = src.split(p.old_string).length - 1;
        if (n === 0) throw new Error('old_string not found');
        if (n > 1 && !p.replace_all) throw new Error(`old_string occurs ${n} times; add context or set replace_all`);
        return p.replace_all ? src.split(p.old_string).join(p.new_string) : src.replace(p.old_string, () => p.new_string);
      }, { shown: p.path });
      return { ...text(`edited ${p.path} (${p.replace_all ? n : 1} replacement${n > 1 && p.replace_all ? 's' : ''})`), terminate: p.finish === true };
    },
  };
  const bash: AgentTool<typeof BashP> = {
    name: 'bash', label: 'Shell',
    description: 'Run a shell command in the project directory (e.g. node engine/tools/lint.mjs --only p03). No network access is expected; long-running renders are not allowed.',
    parameters: BashP,
    executionMode: 'sequential',
    execute: (_id, p, signal) => new Promise((resolve, reject) => {
      if (/\brender\.mjs\b|\bnpm (i|install)\b|\bcurl\b|\bwget\b/.test(p.command)) return reject(new Error('this command is not allowed in a page session'));
      const [cmd, argv]: [string, string[]] = process.platform === 'win32' && process.env.FRAMETELL_SANDBOX_REQUIRED !== '1' && process.env.FRAMETELL_SANDBOX_NONET !== '1' ? ['cmd.exe', ['/d', '/s', '/c', p.command]] : confine(root, 'bash', ['-lc', p.command]);
      // its own process group, ended whole on a stop or the timeout: killing the sandbox alone left what it had started
      // running (seen: a page's lint.mjs, and its Chrome, still going 17 minutes after the film was paused)
      const win = process.platform === 'win32';
      const child = spawn(cmd, argv, { cwd: root, env: shellEnv(), detached: !win });
      const end = () => { try { if (win || !child.pid) child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* gone already */ } };
      if (signal?.aborted) end();
      signal?.addEventListener('abort', end, { once: true });
      let out = '';
      const add = (d: Buffer) => { out += d.toString(); if (out.length > MAX_TEXT * 2) out = out.slice(-MAX_TEXT * 2); };
      child.stdout.on('data', add); child.stderr.on('data', add);
      const timer = setTimeout(end, opts.timeoutMs ?? 180_000);
      child.on('error', (e) => { clearTimeout(timer); signal?.removeEventListener('abort', end); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer); signal?.removeEventListener('abort', end);
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        const body = (out.length > MAX_TEXT ? '…' + out.slice(-MAX_TEXT) : out).trim() || '(no output)';
        resolve(text(code === 0 ? body : `exit ${code}\n${body}`));
      });
    }),
  };
  return [read, write, edit, bash] as AgentTool<any>[];
}
