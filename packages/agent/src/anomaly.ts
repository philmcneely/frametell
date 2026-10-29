// What a drawing session should never need to do, noticed as it happens. A kit or page session is handed the drawing
// API, the style's components and a worked example up front (prompts.ts pageSystem / kitSystem), so reading the
// engine's source means the reference it was given fell short: 2026-10-29, a kit session spent ~15 turns on
// `ls engine/`, `grep Builder.prototype engine/runtime/*.js` and `sed -n 185,440p engine/styles/midcentury/kit.js`, at
// up to 150k tokens a turn. The director reports the first such call of a session as an `anomaly` event (a host may
// alert on it); the call itself goes ahead.
import path from 'node:path';

/** programs that read or list files: run on engine/, they are a session reading the engine's source */
const READERS = new Set(['ls', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'cat', 'find', 'head', 'tail', 'awk', 'less', 'more', 'wc', 'tree', 'nl', 'bat', 'strings', 'xxd', 'od']);
/** the readers whose first word that is no option is a pattern or a script, not a path */
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk']);
/** the agents' read and search tools, by the names the runtimes give them (Pi: read; the Claude Agent SDK: Read, Grep, Glob) */
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'find']);

/** whether `p` (as written in a call, relative to the project or absolute) is in the engine: engine/ or engine_modules/.
 *  The film's own files (pages/, extras/, storyboard.json, materials/, script.js) never are. */
export function inEngine(p: string, cwd: string): boolean {
  let s = p.trim().replace(/^['"]|['"]$/g, '');
  if (!s || s.startsWith('-')) return false;
  if (path.isAbsolute(s)) {
    const rel = path.relative(cwd, s);
    // the shell may see the project under another root (a sandbox): an absolute path into an engine folder still counts
    if (rel.startsWith('..') || path.isAbsolute(rel)) return /\/engine(_modules)?\/(runtime|lib|styles|tools|template|vendor)(\/|$)/.test(s);
    s = rel;
  }
  s = path.posix.normalize(s.replace(/\\/g, '/'));
  return /^engine(_modules)?(\/|$)/.test(s);
}

/**
 * The engine source a tool call reads, as one line for the report (≤ 200 characters), or undefined when it reads none.
 * A read tool by its path; a shell command by each of its parts (split at `&&`, `||`, `;`, `|`): a reading program
 * (ls, grep, sed, cat, find, head, tail, …) given a path in engine/, or run after `cd engine…`. Running the engine's
 * tools (`node engine/tools/lint.mjs`) is not reading them.
 */
export function sourceReading(tool: string, input: { path?: string; command?: string } | undefined, cwd: string): string | undefined {
  if (!input) return undefined;
  const t = tool.toLowerCase();
  if (input.path && READ_TOOLS.has(t)) return inEngine(input.path, cwd) ? `${tool} ${input.path}`.slice(0, 200) : undefined;
  if (!input.command || !['bash', 'shell', 'command_execution'].includes(t)) return undefined;
  let inside = false;
  for (const part of commands(input.command)) {
    const words = part.filter((w) => !/^\w+=/.test(w));
    const [prog, ...args] = ['sudo', 'command', 'xargs', 'nice'].includes(words[0]) ? words.slice(1) : words;
    if (!prog) continue;
    if (prog === 'cd') { inside = args[0] ? inEngine(args[0], cwd) : false; continue; }
    const base = path.basename(prog);
    if (!READERS.has(base)) continue;
    // a search's pattern or an editor's script comes first: `grep -rn engine pages/` reads the film's pages
    const first = PATTERN_FIRST.has(base) ? args.findIndex((a) => !a.startsWith('-')) : -1;
    const paths = args.filter((_, i) => i !== first);
    if (inside || paths.some((a) => inEngine(a, cwd) || inEngine(a.replace(/^--?[\w-]+=/, ''), cwd))) return input.command.trim().slice(0, 200);
  }
  return undefined;
}

/** a shell command as its simple commands (split at unquoted `&&`, `||`, `;`, `|`, newlines), each as its words with
 *  the quotes taken off: `grep -E "a|b" engine/x` is one command of three words */
export function commands(cmd: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [], word = '', quote = '', has = false;
  const endWord = () => { if (has) words.push(word); word = ''; has = false; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) { if (ch === quote) quote = ''; else if (ch === '\\' && quote === '"' && i + 1 < cmd.length) word += cmd[++i]; else word += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { word += cmd[++i]; has = true; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') { endCmd(); if ((ch === '|' || ch === '&') && cmd[i + 1] === ch) i++; continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    word += ch; has = true;
  }
  endCmd();
  return out;
}

/** the sessions that draw (a kit's components, a page or a lane of pages): the ones whose source reading is reported */
export const drawingSession = (name: string) => /^(kit|page)-/.test(name) && name !== 'kit-route';
