import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Director } from './director.js';
import type { AgentRuntime } from './runtime/types.js';
import type { PageIssue } from './events.js';
import type { PageTiming, Storyboard } from './project.js';

const PAGE = "ENGINE.visual('p01', (P) => {\n  P.text('old', { x: 100, y: 100 });\n});\n";

/** a page model that answers each message with `answer` (text, or a flag with its reason), which may change the page file */
const fake = (sent: string[], answer: (n: number, dir: string) => string | { flag: string }): AgentRuntime => ({
  id: 'pi', model: { provider: 'x', id: 'flash' },
  async open(o) {
    return { ref: 'r', close: async () => {}, send: async (i) => {
      sent.push(i.text);
      const a = answer(sent.length, o.cwd);
      return { text: typeof a === 'string' ? a : '', stopReason: 'done', usage: {}, answers: typeof a === 'string' ? [] : [{ name: 'flag', args: { reason: a.flag } }] } as never;
    } };
  },
});
/** a reviewer that passes every page, keeping what it was shown */
const passing = (seen: string[]): AgentRuntime => ({
  id: 'pi', model: { provider: 'y', id: 'haiku' },
  async open() { return { ref: 'v', close: async () => {}, send: async (i) => { seen.push(i.text); return { text: '', stopReason: 'done', usage: {}, answers: [{ name: 'verdict', args: { pass: true, problems: [] } }] } as never; } }; },
});

/** the page step of a revision of p01, with the engine's checks stubbed: they find nothing */
async function revise(answer: (n: number, dir: string) => string | { flag: string }, written = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-revise-'));
  fs.mkdirSync(path.join(dir, 'pages'));
  if (written) fs.writeFileSync(path.join(dir, 'pages/p01.js'), PAGE);
  const sent: string[] = [], seen: string[] = [];
  const d = new Director({ dir, style: 'chalkboard', brief: { durationSec: 60, lang: 'zh', replyLang: 'zh' }, runtime: fake(sent, answer), reviewer: { runtime: passing(seen) } });
  Object.assign(d.project, { check: async () => ({ issues: [], sheet: 'sheet.jpg' }), lint: async () => [], snap: async () => 'sheet.jpg', commit: async () => undefined });
  const inner = d as unknown as { state: { revision?: Record<string, string>; pages: Record<string, { status: string; issues: PageIssue[] }> }; page(sb: Storyboard, t: PageTiming): Promise<void> };
  inner.state.revision = { p01: '在开头加一个标题' };
  const sb = { title: 'T', summary: 'S', pages: [{ id: 'p01', section: '开场', say: '…', beats: [] }] } as unknown as Storyboard;
  await inner.page(sb, { id: 'p01', start: 0, end: 5, speechEnd: 4, cues: [] } as unknown as PageTiming);
  return { sent, seen, page: inner.state.pages.p01, code: fs.readFileSync(path.join(dir, 'pages/p01.js'), 'utf8') };
}

test('a revision whose change never lands is not shown as done', async () => {
  // the model says it changed the page, passes the reviewer, and never edits the file
  const { sent, seen, page, code } = await revise(() => '已在第 1 页加上标题。');
  assert.equal(code, PAGE);
  assert.equal(page.status, 'flagged');
  assert.deepEqual(page.issues, [{ from: 'run', kind: 'not-made', msg: 'The change was not made: the page is as it was' }]);
  assert.match(sent[1], /exactly as it was: the change was not made/);   // asked once more
  assert.ok(seen.length && seen.every((m) => m.includes('在开头加一个标题')));   // and the reviewer is told what to look for
});

test('a revision that lands on the second ask is done', async () => {
  const { seen, page, code } = await revise((n, dir) => {
    if (n === 2) fs.writeFileSync(path.join(dir, 'pages/p01.js'), PAGE.replace("'old'", "'标题'"));
    return '已加上。';
  });
  assert.match(code, /标题/);
  assert.equal(page.status, 'ok');
  assert.ok(!seen[0].includes('在开头加一个标题'));   // a page whose code changed is checked as usual
});

test('a page that already shows the change says so, and is neither asked again nor checked', async () => {
  const { sent, page, code } = await revise(() => ({ flag: '这一页的数字本来就是黄色的' }));
  assert.equal(code, PAGE);
  assert.equal(sent.length, 1);
  assert.equal(page.status, 'flagged');
  assert.deepEqual(page.issues, [{ from: 'agent', msg: '这一页的数字本来就是黄色的' }]);
});

test('a page the change adds is drawn from nothing', async () => {
  // seen: the planner added an end card to the storyboard; reading its code (none yet) failed it on every Continue
  const { sent, page, code } = await revise((n, dir) => { fs.writeFileSync(path.join(dir, 'pages/p01.js'), PAGE); return '画好了。'; }, false);
  assert.equal(code, PAGE);
  assert.equal(page.status, 'ok');
  assert.match(sent[0], /This page is new[\s\S]*在开头加一个标题/);
  assert.doesNotMatch(sent[0], /is already written/);
});

test('a change to a film drawn in pictures is planned even when it names a page, and a picture drawn again is the change', async () => {
  // seen: four asks to fix a face on page 2 went straight to its page, written by rule from the scenes: nothing changed
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-revise-led-'));
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ title: 'T', summary: 'S', pages: [{ id: 'p01', section: 'a', say: '…', beats: [] }, { id: 'p02', section: 'b', say: '…', beats: [] }] }));
  fs.writeFileSync(path.join(dir, 'script.js'), 'const META = {};\n');
  const events: { type: string }[] = [], planned: string[] = [];
  const d = new Director({ dir, style: 'sales-training', brief: { durationSec: 60, lang: 'en', replyLang: 'en' }, runtime: fake([], () => ''), emit: (e) => events.push(e) });
  Object.assign(d.project, { timeline: async () => ({ duration: 10, pages: [] }), commit: async () => undefined });
  Object.assign(d, {
    pictureStyle: () => ({ led: true }),
    planRevision: async (request: string) => { planned.push(request); return { plan: [] }; },
    changePictures: async () => 1,
  });
  const inner = d as unknown as { state: { exported?: boolean; stage?: string } };
  inner.state.exported = true;
  await d.revise('Please change the eyes on the lady in this picture (page 2)');
  assert.deepEqual(planned, ['Please change the eyes on the lady in this picture (page 2)']);
  assert.equal(inner.state.exported, false);
  assert.ok(events.some((e) => e.type === 'ready'));
});

/** a revision of a code-drawn film whose request names p01, the decision model answering `kind` (undefined: none set up) */
async function routed(kind?: string, p = 0.95) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-revise-route-'));
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ title: 'T', summary: 'S', pages: [{ id: 'p01', section: 'a', say: '…', beats: [] }] }));
  fs.writeFileSync(path.join(dir, 'script.js'), 'const META = {};\n');
  const asked: unknown[] = [], planned: string[] = [], drawn: string[][] = [];
  const decide = kind === undefined ? undefined : { choose: async (state: unknown) => { asked.push(state); return { choice: kind, p }; } };
  const d = new Director({ dir, style: 'chalkboard', brief: { durationSec: 60, lang: 'en', replyLang: 'en' }, runtime: fake([], () => ''), decide });
  Object.assign(d.project, { timeline: async () => ({ duration: 10, pages: [] }), commit: async () => undefined });
  Object.assign(d, {
    planRevision: async (request: string) => { planned.push(request); return { plan: [] }; },
    pages: async (ids: string[]) => { drawn.push(ids); },
    review: async () => undefined,
  });
  await d.revise('Make the title on page 1 bigger <references>Page 1 0:02 “Hello”</references>');
  return { asked, planned, drawn };
}

test('a change the decision model is sure is about how the named page looks goes straight to that page', async () => {
  const r = await routed('look');
  assert.deepEqual(r.drawn, [['p01']]);
  assert.deepEqual(r.planned, []);
  assert.deepEqual(r.asked, [{ request: 'Make the title on page 1 bigger', pointsAt: 'Page 1 0:02 “Hello”' }]);
});

test('a change about the words, a picture, or one the decision model is unsure of, or with none set up, is planned', async () => {
  for (const [kind, p] of [['words', 0.99], ['picture', 0.97], ['look', 0.4], [undefined, 0]] as const) {
    const r = await routed(kind, p);
    assert.equal(r.planned.length, 1, `${kind} ${p}`);
  }
});
