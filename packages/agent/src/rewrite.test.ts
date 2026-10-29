import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewriteRefusal } from './runtime/types.js';
import { fileTools } from './tools/files.js';

const long = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n');

test('an existing page is never rewritten whole; new pages and other files are written freely', () => {
  assert.match(rewriteRefusal('pages/p03.js', long)!, /use edit/);
  assert.equal(rewriteRefusal('pages/p03.js', undefined), undefined);        // a new page
  assert.equal(rewriteRefusal('pages/p03.js', 'short\nfile'), undefined);    // a stub
  assert.equal(rewriteRefusal('script.js', long), undefined);
  assert.equal(rewriteRefusal('.studio/revision.json', long), undefined);
});

test("a film component that exists is changed with edit too; its check lines and a short one are rewritten freely", () => {
  assert.match(rewriteRefusal('extras/kit/presenter.js', long)!, /edit the parts that need changing/);
  assert.equal(rewriteRefusal('extras/kit/presenter.js', undefined), undefined);
  assert.equal(rewriteRefusal('extras/kit/presenter.js', Array.from({ length: 39 }, () => 'x').join('\n')), undefined);
  assert.equal(rewriteRefusal('extras/kit/presenter.check.js', long), undefined);
  assert.equal(rewriteRefusal('extras/film-kit.js', long), undefined);   // the director's to write (and frozen once checked)
});

test('the write tool refuses, and edit still works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-tools-'));
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.writeFileSync(path.join(dir, 'pages/p01.js'), long);
  const tools = Object.fromEntries(fileTools(dir).map((t) => [t.name, t]));
  await assert.rejects(tools.write.execute('1', { path: 'pages/p01.js', content: 'x' } as never), /use edit/);
  await tools.edit.execute('2', { path: 'pages/p01.js', old_string: 'line 7\n', new_string: 'line seven\n' } as never);
  assert.match(fs.readFileSync(path.join(dir, 'pages/p01.js'), 'utf8'), /line seven/);
  await tools.write.execute('3', { path: 'pages/p02.js', content: 'new page' } as never);
  // a kit session's component: the first write goes through, the second whole one is refused
  await tools.write.execute('4', { path: 'extras/kit/house.js', content: long } as never);
  await assert.rejects(tools.write.execute('5', { path: 'extras/kit/house.js', content: long + '\nmore' } as never), /edit the parts that need changing/);
  await tools.edit.execute('6', { path: 'extras/kit/house.js', old_string: 'line 3\n', new_string: 'line three\n' } as never);
});

test("the studio's record of the run is out of the agents' reach, but for the planner's decision on a change", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-tools-'));
  fs.mkdirSync(path.join(dir, '.studio'));
  fs.writeFileSync(path.join(dir, '.studio/events.jsonl'), '{}');
  const tools = Object.fromEntries(fileTools(dir).map((t) => [t.name, t]));
  await assert.rejects(tools.read.execute('1', { path: '.studio/events.jsonl' } as never), /studio's record/);
  await assert.rejects(tools.read.execute('2', { path: './.studio/../.studio/state.json' } as never), /studio's record/);
  await tools.write.execute('3', { path: '.studio/revision.json', content: '{"pages":[]}' } as never);
  assert.equal(fs.readFileSync(path.join(dir, '.studio/revision.json'), 'utf8'), '{"pages":[]}');
});
