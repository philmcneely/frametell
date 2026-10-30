// Every git the studio runs goes through here (a test fails on any other). The studio's git runs outside the agent's
// sandbox, as this process's user, in a folder the agent writes; what git reads there must not run anything.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';

/** a hooks folder that can never exist on any platform: a path below a file (this program) is never a folder, so no
 *  one, the agent included, can put a hook there. /dev/null is no folder on Windows, and NUL there is a name the agent
 *  could create as a folder of its project on Linux and macOS */
const NO_HOOKS = path.join(process.execPath, 'no-hooks');

/** what every studio git is run with: no fsmonitor command (git runs it on every add and status, and a repo's own
 *  config can name any program) and no hooks. Given on the command line, they also reach the gits git starts itself,
 *  and override any config file */
export const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS}`];

type Env = Record<string, string | undefined>;
export const gitSync = (cwd: string | undefined, args: string[], env?: Env) =>
  spawnSync('git', [...GIT_SAFE, ...args], { cwd, encoding: 'utf8', env, timeout: 120_000 });

export const gitAsync = (cwd: string, args: string[], env?: Env) =>
  new Promise<{ status: number; stdout: string }>((ok) => execFile('git', [...GIT_SAFE, ...args], { cwd, encoding: 'utf8', maxBuffer: 16 << 20, env, timeout: 120_000 }, (e, stdout) => ok({ status: e ? 1 : 0, stdout: stdout || '' })));

/**
 * A shallow clone of a public repository for the research (https only, as findSources makes them), with the safe
 * settings, links checked out as plain files (a link in someone's repository never points the research outside it), no
 * prompt for a password, and killed after three minutes. Only a host with a network clones: one whose reach has no web
 * never calls this.
 */
export function gitClone(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  if (!/^https:\/\//.test(url)) return Promise.reject(new Error('only https repositories are cloned'));
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', [...GIT_SAFE, '-c', 'core.symlinks=false', 'clone', '--depth', '1', '--single-branch', '--filter=blob:limit=2m', '--no-tags', '--', url, dest], { signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `git clone exited ${code}`)); });
  });
}

/**
 * Removes every `.git` below `root` (a folder, a file with `gitdir:` pointing anywhere, or a link), case-insensitively
 * (macOS and Windows find `.GIT` as `.git`). A repo inside the project is one git looks into with its own config: on
 * the next commit the studio's git checks whether it changed, and its config (core.fsmonitor, a clean filter for its
 * .gitattributes) runs a program outside the sandbox. The agent has no use for one. Links are not followed: the
 * project's own engine links, or one the agent made to /, are not walked. Returns what was removed.
 */
export function removeNestedRepos(root: string, warn: (msg: string) => void = (m) => console.warn(m)): string[] {
  const removed: string[] = [];
  const walk = (dir: string, top: boolean) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name.toLowerCase() === '.git') {
        if (top) continue;   // the project's own history (read-only to the agent)
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(path.relative(root, p));
        warn(`frametell: removed a git repository planted in the project: ${path.relative(root, p)}`);
      } else if (e.isDirectory()) walk(p, false);
    }
  };
  walk(root, true);
  return removed;
}

/** the index's gitlinks (mode 160000: an embedded repo or submodule), which commit and status look into */
const gitlinks = async (dir: string, env?: Env) =>
  (await gitAsync(dir, ['ls-files', '-s', '-z'], env)).stdout.split('\0').filter((l) => l.startsWith('160000 ')).map((l) => l.slice(l.indexOf('\t') + 1));
/** what the index still holds that the rules keep out: media committed before they were kept out of the history. Taken
 *  out of the index (the files stay where they are), so the next commit no longer carries them */
const keptOut = async (dir: string, env?: Env) =>
  (await gitAsync(dir, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], env)).stdout.split('\0').filter(Boolean);
const keptOutSync = (dir: string, env?: Env) =>
  (gitSync(dir, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], env).stdout || '').split('\0').filter(Boolean);
const dropGitlinks = async (dir: string, env?: Env) => {
  const links = await gitlinks(dir, env);
  if (links.length) await gitAsync(dir, ['update-index', '--force-remove', '--', ...links], env);
  return links;
};
const gitlinksSync = (dir: string, env?: Env) =>
  (gitSync(dir, ['ls-files', '-s', '-z'], env).stdout || '').split('\0').filter((l) => l.startsWith('160000 ')).map((l) => l.slice(l.indexOf('\t') + 1));

/** what a project's history never holds, whatever its .gitignore says (the agent can edit or delete that file): the
 *  engine links, the studio's record and the exported films. On Windows the links are junctions, which git walks into:
 *  without this, staging a project with no .gitignore read the whole engine and its node_modules and ran into the
 *  two-minute timeout. Kept in .git/info/exclude, which the agent cannot write.
 *  Nor any picture, sound, video, document or font: the history is the film's text (its pages, script, storyboard and
 *  the records naming its media), a few hundred KB. Its media are named by their content (pictures.ts, the voice's
 *  takes), so an old version's text still names files that are there; a film's voice once took 18 MB of its 21 MB
 *  history, every take kept for good */
export const MEDIA = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'ico', 'psd',
  'wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'key', 'pages', 'numbers', 'epub', 'zip', 'ttf', 'otf', 'woff', 'woff2'];
/** `*.png` in any case (`*.[pP][nN][gG]`): a pattern of info/exclude matches by case unless the repo ignores it */
const anyCase = (ext: string) => `*.${[...ext].map((c) => (c.toUpperCase() !== c ? `[${c}${c.toUpperCase()}]` : c)).join('')}`;
const KEEP_OUT = ['/engine', '/engine_modules', '/out/', '/.studio/', ...MEDIA.map(anyCase)].join('\n') + '\n';
function keepOut(dir: string) {
  const git = path.join(dir, '.git');
  try { if (!fs.lstatSync(git).isDirectory()) return; } catch { return; }
  const file = path.join(git, 'info', 'exclude');
  try { if (fs.readFileSync(file, 'utf8') === KEEP_OUT) return; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, KEEP_OUT);
}

/**
 * Stages everything in the project, so that git never looks into a repo nested in it: none is left on disk, the index
 * holds no gitlink when `add` runs (an old one included), and none is left when the commit runs (one planted between
 * the sweep and `add` is added as a gitlink by reading its HEAD only, and is taken out again here).
 */
export async function stageAll(dir: string, env?: Env) {
  keepOut(dir);
  removeNestedRepos(dir);
  await dropGitlinks(dir, env);
  await gitAsync(dir, ['add', '-A'], env);
  await dropGitlinks(dir, env);
  const out = await keptOut(dir, env);
  if (out.length) await gitAsync(dir, ['update-index', '--force-remove', '--', ...out], env);
}
export function stageAllSync(dir: string, env?: Env) {
  keepOut(dir);
  removeNestedRepos(dir);
  const drop = () => { const l = gitlinksSync(dir, env); if (l.length) gitSync(dir, ['update-index', '--force-remove', '--', ...l], env); };
  drop();
  gitSync(dir, ['add', '-A'], env);
  drop();
  const out = keptOutSync(dir, env);
  if (out.length) gitSync(dir, ['update-index', '--force-remove', '--', ...out], env);
}
