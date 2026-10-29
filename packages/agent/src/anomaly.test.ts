import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands, drawingSession, inEngine, sourceReading } from './anomaly.js';
import { toolInput } from './runtime/types.js';

const cwd = '/work/film';
const bash = (command: string) => sourceReading('bash', { command }, cwd);

test("the engine's source read through the shell is noticed, as the 2026-10-29 kit session read it", () => {
  for (const c of ['ls engine/', 'ls engine', 'grep -n "Builder.prototype" engine/runtime/*.js', 'sed -n 40,260p engine/runtime/core.js', 'sed -n 185,440p engine/styles/midcentury/kit.js',
    "grep -rn 'text(' engine/runtime/core.js engine/runtime/text.js | head -40", 'cd engine/runtime && grep -n tick core.js', 'find ./engine -name "*.js"', 'cat /work/film/engine/runtime/live.js',
    'node engine/tools/lint.mjs --only p03; cat engine/lib/cells.js', 'grep -E "a|b" engine/runtime/core.js', 'head -c 400 engine_modules/three/build/three.module.js', 'xargs grep x engine/lib/notes.js'])
    assert.equal(bash(c), c, c);
  assert.equal(bash('x'.repeat(10) + ' && cat engine/' + 'y'.repeat(300))!.length, 200);
});

test("the film's own files, and the engine's tools run as tools, are not reading its source", () => {
  for (const c of ['node engine/tools/lint.mjs --only p03', 'node engine/tools/use-extra.mjs cells.js', 'cat pages/p01.js', 'grep -n P.globe extras/film-kit.js', 'sed -n 1,40p extras/kit/presenter.js',
    'cat storyboard.json | head', 'ls materials/', 'cat script.js', 'node engine/tools/script.mjs 2>&1 | tail -5', 'ls', 'grep -rn engine pages/', 'echo engine/runtime/core.js'])
    assert.equal(bash(c), undefined, c);
});

test('a read tool on the engine is noticed by its path, under any runtime\'s name for it', () => {
  assert.equal(sourceReading('read', { path: 'engine/runtime/core.js' }, cwd), 'read engine/runtime/core.js');
  assert.equal(sourceReading('Read', { path: '/work/film/engine/styles/midcentury/kit.js' }, cwd), 'Read /work/film/engine/styles/midcentury/kit.js');
  assert.equal(sourceReading('Grep', { path: './engine/../engine/lib' }, cwd), 'Grep ./engine/../engine/lib');
  for (const p of ['pages/p02.js', 'extras/kit/house.js', 'storyboard.json', 'materials/a.md', 'script.js', 'out/snap/kit-r1.jpg', 'engineering.md'])
    assert.equal(sourceReading('read', { path: p }, cwd), undefined, p);
  assert.equal(sourceReading('edit', { path: 'engine/runtime/core.js' }, cwd), undefined);   // refused by the tool anyway; no read
  assert.equal(sourceReading('read', undefined, cwd), undefined);
});

test('paths and commands are taken as written', () => {
  assert.ok(inEngine('engine', cwd) && inEngine('"engine/lib"', cwd) && inEngine('/elsewhere/engine/runtime/core.js', cwd));
  assert.ok(!inEngine('-n', cwd) && !inEngine('/work/film/pages/p01.js', cwd) && !inEngine('../engine', cwd));
  assert.deepEqual(commands(`grep -E "a|b" engine/x && sed -n '1,5p' y; cat z | head`), [['grep', '-E', 'a|b', 'engine/x'], ['sed', '-n', '1,5p', 'y'], ['cat', 'z'], ['head']]);
  assert.deepEqual(toolInput({ path: 'pages/p01.js', content: 'x' }), { path: 'pages/p01.js' });
  assert.deepEqual(toolInput({ file_path: 'a.js' }), { path: 'a.js' });
  assert.deepEqual(toolInput({ command: 'ls' }), { command: 'ls' });
  assert.equal(toolInput({ pass: true }), undefined);
  assert.ok(drawingSession('kit-presenter') && drawingSession('page-p01'));
  assert.ok(!drawingSession('planner') && !drawingSession('check-p01') && !drawingSession('kit-route') && !drawingSession('review'));
});
