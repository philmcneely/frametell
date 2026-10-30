// The read, write and edit tools run in this process, not in the shell's sandbox; the shell can plant links in the
// project. Every planted link and hard link is refused, and what it points at is left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileTools } from './tools/files.js';
import { liveStamp, Project } from './project.js';
import { imagesIn, listIn, readIn, writeIn } from './projectfs.js';

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-files-')));
  const root = path.join(base, 'users', 'me', 'projects', 'film');
  const other = path.join(base, 'users', 'other', 'projects', 'x');
  const api = path.join(base, 'api');
  for (const d of [root, other, api, path.join(root, 'pages'), path.join(root, '.studio')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(other, 'script.js'), 'their script');
  fs.writeFileSync(path.join(api, 'server.js'), 'api code');
  fs.writeFileSync(path.join(root, 'pages', 'p01.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(root, '.studio', 'state.json'), '{"stage":"pages"}');
  const tools = Object.fromEntries(fileTools(root).map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown>) => {
    try { const r: any = await tools[name].execute('id', args as never, undefined as never, undefined as never); return { ok: true, text: r.content.map((c: any) => c.text ?? c.data).join('') }; }
    catch (e) { return { ok: false, text: (e as Error).message }; }
  };
  return { base, root, other, api, call, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('read through a planted link (a folder of another account, a file) is refused', async () => {
  const s = setup();
  try {
    fs.symlinkSync(s.other, path.join(s.root, 'y'));
    fs.symlinkSync(path.join(s.other, 'script.js'), path.join(s.root, 'z.js'));
    for (const p of ['y/script.js', 'z.js']) {
      const r = await s.call('read', { path: p });
      assert.equal(r.ok, false, p);
      assert.doesNotMatch(r.text, /their script/);
      assert.match(r.text, /outside the project directory/);
    }
    // a picture through a link: not read either
    fs.writeFileSync(path.join(s.other, 'f.png'), 'their picture');
    fs.symlinkSync(path.join(s.other, 'f.png'), path.join(s.root, 'f.png'));
    assert.equal((await s.call('read', { path: 'f.png' })).ok, false);
    // a link to the studio's record
    fs.symlinkSync('.studio', path.join(s.root, 's'));
    const r = await s.call('read', { path: 's/state.json' });
    assert.equal(r.ok, false);
    assert.match(r.text, /studio's record/);
  } finally { s.done(); }
});

test('write and edit through a link into .studio, or to a file outside, are refused and change nothing', async () => {
  const s = setup();
  try {
    fs.symlinkSync('.studio', path.join(s.root, 's'));
    fs.symlinkSync(path.join(s.api, 'server.js'), path.join(s.root, 'z.js'));
    fs.symlinkSync(s.api, path.join(s.root, 'apidir'));
    const tries: [string, Record<string, unknown>][] = [
      ['write', { path: 's/state.json', content: 'x' }],
      ['write', { path: 's/new.json', content: 'x' }],
      ['edit', { path: 's/state.json', old_string: 'pages', new_string: 'done' }],
      ['write', { path: 'z.js', content: 'pwned' }],
      ['edit', { path: 'z.js', old_string: 'api', new_string: 'pwned' }],
      ['write', { path: 'apidir/server.js', content: 'pwned' }],
      ['write', { path: 'apidir/new.js', content: 'pwned' }],
      ['write', { path: 'apidir/deep/new.js', content: 'pwned' }],
      ['edit', { path: 'apidir/server.js', old_string: 'api', new_string: 'pwned' }],
    ];
    for (const [name, args] of tries) assert.equal((await s.call(name, args)).ok, false, `${name} ${args.path}`);
    assert.equal(fs.readFileSync(path.join(s.root, '.studio', 'state.json'), 'utf8'), '{"stage":"pages"}');
    assert.deepEqual(fs.readdirSync(path.join(s.root, '.studio')), ['state.json']);
    assert.equal(fs.readFileSync(path.join(s.api, 'server.js'), 'utf8'), 'api code');
    assert.deepEqual(fs.readdirSync(s.api), ['server.js']);
    assert.ok(fs.lstatSync(path.join(s.root, 'z.js')).isSymbolicLink());   // the link is left as a link, nothing written through it
  } finally { s.done(); }
});

test('a hard-linked file is neither read nor edited nor replaced', async () => {
  const s = setup();
  try {
    // the sandbox would deny this link (no path to the API's files); made here to test the last line of defence
    fs.linkSync(path.join(s.api, 'server.js'), path.join(s.root, 'h.js'));
    assert.match((await s.call('read', { path: 'h.js' })).text, /hard link/);
    assert.equal((await s.call('edit', { path: 'h.js', old_string: 'api', new_string: 'pwned' })).ok, false);
    assert.equal((await s.call('write', { path: 'h.js', content: 'pwned' })).ok, false);
    assert.equal(fs.readFileSync(path.join(s.api, 'server.js'), 'utf8'), 'api code');
  } finally { s.done(); }
});

test('a new file under a linked folder is refused; a folder made on the way is a real one of the project', async () => {
  const s = setup();
  try {
    fs.symlinkSync(path.join(s.other), path.join(s.root, 'out'));
    assert.equal((await s.call('write', { path: 'out/frames/a.txt', content: 'x' })).ok, false);
    assert.ok(!fs.existsSync(path.join(s.other, 'frames')));
    assert.deepEqual(fs.readdirSync(s.other), ['script.js']);
    // a lexical escape and the engine stay refused with their old messages
    assert.match((await s.call('write', { path: '../x.txt', content: 'x' })).text, /outside the project directory/);
    assert.match((await s.call('write', { path: '.studio/state.json', content: 'x' })).text, /studio's record/);
  } finally { s.done(); }
});

test('normal reads, writes, edits and new nested files work; .studio/revision.json is writable', async () => {
  const s = setup();
  try {
    const r = await s.call('read', { path: 'pages/p01.js' });
    assert.ok(r.ok); assert.match(r.text, /const a = 1;/);
    assert.match((await s.call('write', { path: 'notes/deep/n.md', content: 'hello\nworld' })).text, /wrote notes\/deep\/n\.md \(2 lines\)/);
    assert.equal(fs.readFileSync(path.join(s.root, 'notes/deep/n.md'), 'utf8'), 'hello\nworld');
    assert.ok((await s.call('write', { path: 'notes/deep/n.md', content: 'replaced' })).ok);
    assert.equal(fs.readFileSync(path.join(s.root, 'notes/deep/n.md'), 'utf8'), 'replaced');
    assert.match((await s.call('edit', { path: 'pages/p01.js', old_string: 'a = 1', new_string: 'a = 2' })).text, /edited pages\/p01\.js \(1 replacement\)/);
    assert.equal(fs.readFileSync(path.join(s.root, 'pages/p01.js'), 'utf8'), 'const a = 2;\n');
    assert.equal((await s.call('edit', { path: 'pages/p01.js', old_string: 'nope', new_string: 'x' })).text, 'old_string not found');
    assert.ok((await s.call('write', { path: '.studio/revision.json', content: '{"pages":[]}' })).ok);
    assert.equal(fs.readFileSync(path.join(s.root, '.studio/revision.json'), 'utf8'), '{"pages":[]}');
    assert.ok((await s.call('read', { path: '.studio/revision.json' })).ok);
    // a link inside the project to a file of the project is fine to read
    fs.symlinkSync('pages/p01.js', path.join(s.root, 'alias.js'));
    assert.ok((await s.call('read', { path: 'alias.js' })).ok);
    // a long page is still not rewritten whole
    fs.writeFileSync(path.join(s.root, 'pages/p02.js'), 'x\n'.repeat(50));
    assert.match((await s.call('write', { path: 'pages/p02.js', content: 'y' })).text, /use edit/);
    assert.equal(fs.readFileSync(path.join(s.root, 'pages/p02.js'), 'utf8'), 'x\n'.repeat(50));
  } finally { s.done(); }
});

test('the orchestrator\'s own reads and pictures go through the same check', () => {
  const s = setup();
  try {
    fs.symlinkSync(path.join(s.other, 'script.js'), path.join(s.root, 'script.js'));
    const project = new Project(s.root);
    assert.throws(() => project.read('script.js'), /outside the project directory/);
    assert.throws(() => project.write('script.js', 'pwned'), /link/);
    assert.equal(fs.readFileSync(path.join(s.other, 'script.js'), 'utf8'), 'their script');
    fs.writeFileSync(path.join(s.other, 'sheet.jpg'), 'their picture');
    fs.mkdirSync(path.join(s.root, 'out', 'snap'), { recursive: true });
    fs.symlinkSync(path.join(s.other, 'sheet.jpg'), path.join(s.root, 'out', 'snap', 'sheet.jpg'));
    fs.writeFileSync(path.join(s.root, 'out', 'snap', 'ok.jpg'), 'mine');
    const pics = imagesIn(s.root, [path.join(s.root, 'out/snap/sheet.jpg'), path.join(s.root, 'out/snap/ok.jpg')]);
    assert.deepEqual(pics.map((p) => p.data.toString()), ['mine']);
    assert.equal(readIn(s.root, 'pages/p01.js').toString(), 'const a = 1;\n');
  } finally { s.done(); }
});

const ffmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('posters and stills are cut only from a film of the project\'s own, through the opened file', { skip: !ffmpeg && 'no ffmpeg' }, async () => {
  const s = setup();
  try {
    const film = path.join(s.other, 'film.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', film]);
    fs.mkdirSync(path.join(s.root, 'out'));
    fs.symlinkSync(film, path.join(s.root, 'out', 'linked.mp4'));
    const project = new Project(s.root);
    const pages = [{ id: 'p01', start: 0, end: 1.5, speechEnd: 1, cues: [] }];
    assert.deepEqual(await project.posters(path.join(s.root, 'out', 'linked.mp4'), pages), {});
    assert.deepEqual(await project.posters(film, pages), {});   // a path elsewhere
    assert.ok(!fs.existsSync(path.join(s.root, 'out', 'thumbs')));
    // the same film as a file of the project
    fs.copyFileSync(film, path.join(s.root, 'out', 'own.mp4'));
    assert.deepEqual(await project.posters(path.join(s.root, 'out', 'own.mp4'), pages), { p01: 'out/thumbs/p01.jpg' });
    assert.ok(fs.statSync(path.join(s.root, 'out/thumbs/p01.jpg')).size > 0);
    assert.deepEqual(await project.stills([0.5, 1], path.join(s.root, 'out', 'own.mp4')), ['out/frames/5.jpg', 'out/frames/10.jpg']);
    assert.ok(fs.statSync(path.join(s.root, 'out/frames/10.jpg')).size > 0);
    // a link planted where a frame goes is not written through
    fs.symlinkSync(path.join(s.api, 'server.js'), path.join(s.root, 'out/frames/20.jpg'));
    await assert.rejects(project.stills([2], path.join(s.root, 'out', 'own.mp4')));
    assert.equal(fs.readFileSync(path.join(s.api, 'server.js'), 'utf8'), 'api code');
  } finally { s.done(); }
});

test('the live frames\' name follows what the film says, not when its files were touched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  try {
    fs.mkdirSync(path.join(root, 'pages'));
    fs.writeFileSync(path.join(root, 'script.js'), 's');
    fs.writeFileSync(path.join(root, 'pages', 'p01.js'), 'a');
    const first = liveStamp(root);
    // copied into a box and back: the same bytes at another time
    fs.utimesSync(path.join(root, 'pages', 'p01.js'), new Date(1e12 + 0.4), new Date(1e12 + 0.4));
    assert.equal(liveStamp(root), first);
    fs.writeFileSync(path.join(root, 'pages', 'p01.js'), 'b');
    assert.notEqual(liveStamp(root), first);
    fs.writeFileSync(path.join(root, 'pages', 'p01.js'), 'a');
    fs.writeFileSync(path.join(root, 'pages', 'p02.js'), 'c');
    assert.notEqual(liveStamp(root), first);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a folder of the project is listed only when it really is one, never through a link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listin-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'listin-out-'));
  try {
    fs.mkdirSync(path.join(root, 'out', 'thumbs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'thumbs', 'p01.jpg'), 'j');
    fs.writeFileSync(path.join(outside, 'secret.jpg'), 's');
    fs.symlinkSync(outside, path.join(root, 'pages'));
    fs.symlinkSync(outside, path.join(root, 'out', 'snap'));
    fs.mkdirSync(path.join(root, '.studio'));
    assert.deepEqual(listIn(root, 'out/thumbs'), ['p01.jpg']);
    assert.deepEqual(listIn(root, 'pages'), []);
    assert.deepEqual(listIn(root, 'out/snap'), []);
    assert.deepEqual(listIn(root, '../'), []);
    assert.deepEqual(listIn(root, '.studio'), []);
    assert.deepEqual(listIn(root, 'missing'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('on Linux, a folder swapped for a link while a write makes the folders under it leaves nothing outside', { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writein-race-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writein-out-'));
  const mkdir = fs.mkdirSync;
  let swapped = false;
  try {
    fs.mkdirSync(path.join(root, 'a'));
    // the moment the write makes folder `b` under `a`, `a` is swapped for a link to outside
    (fs as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = ((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
      if (!swapped && path.basename(String(p)) === 'b') {
        swapped = true;
        fs.renameSync(path.join(root, 'a'), path.join(root, 'a.real'));
        fs.symlinkSync(outside, path.join(root, 'a'));
      }
      return mkdir(p, o);
    }) as typeof fs.mkdirSync;
    try { writeIn(root, 'a/b/new.txt', 'x'); } catch { /* refused is fine too */ }
  } finally { (fs as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = mkdir; }
  try {
    assert.equal(swapped, true, 'the write made folder b');
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('on Linux, a new file whose folder moved out of the project as it was made is taken back', { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writein-moved-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writein-out-'));
  const open = fs.openSync;
  let moved = false;
  try {
    fs.mkdirSync(path.join(root, 'a'));
    // right after the new file is created, its folder is moved out of the project: the check of the opened file fails
    (fs as { openSync: typeof fs.openSync }).openSync = ((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = open(p, flags, mode);
      if (!moved && path.basename(String(p)) === 'new.txt' && typeof flags === 'number' && (flags & fs.constants.O_CREAT)) {
        moved = true;
        fs.renameSync(path.join(root, 'a'), path.join(outside, 'a'));
      }
      return fd;
    }) as typeof fs.openSync;
    assert.throws(() => writeIn(root, 'a/new.txt', 'x'), /outside/);
  } finally { (fs as { openSync: typeof fs.openSync }).openSync = open; }
  try {
    assert.equal(moved, true, 'the write created the file');
    assert.deepEqual(fs.readdirSync(path.join(outside, 'a')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('a write the rules refuse leaves no folder behind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writein-place-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    assert.throws(() => writeIn(root, '.git/hooks/x/pre-commit', 'x'));
    assert.equal(fs.existsSync(path.join(root, '.git', 'hooks')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a picture too large for the model service is described, not sent', async () => {
  const f = setup();
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
    return b;
  };
  fs.mkdirSync(path.join(f.root, 'assets/brand'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'assets/brand/logo.png'), png(8376, 2317));
  fs.writeFileSync(path.join(f.root, 'assets/brand/mark.png'), png(512, 512));
  const big = await f.call('read', { path: 'assets/brand/logo.png' });
  assert.match(big.text, /assets\/brand\/logo\.png is a picture of 8376×2317 px, too large to be shown to you/);
  const small = await f.call('read', { path: 'assets/brand/mark.png' });
  assert.equal(small.text, png(512, 512).toString('base64'));
  f.done();
});
