import type { Decider } from './decide.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Director, planPageId, readRevisionPlan } from './director.js';
import type { AgentRuntime, TurnResult } from './runtime/types.js';
import type { StudioEvent } from './events.js';

const IDS = ['p01', 'p02', 'p03', 'p04'];
const SCRIPT = "export default { voice: { id: 'v' }, pages: [{ id: 'p01', cues: [{ t: '一' }] }] };\n";
const storyboard = (ids = IDS) => JSON.stringify({ title: 'T', summary: 'S', lang: 'zh', pages: ids.map((id) => ({ id, section: id, say: '…', beats: [] })) });

test("a plan's page id is matched to the storyboard's however the planner wrote it", () => {
  for (const raw of ['p03', 'P03', 'p3', '3', 3, ' p03 ', 'page 3']) assert.equal(planPageId(raw, IDS), 'p03', String(raw));
  assert.equal(planPageId('p09', IDS), undefined);
  assert.equal(planPageId({ id: 'p03' }, IDS), undefined);
  // ids that carry no number: a number is the page's place in the film
  assert.equal(planPageId(2, ['intro', 'middle', 'end']), 'middle');
});

test('a plan that cannot be used says what is wrong with it', () => {
  assert.deepEqual(readRevisionPlan(undefined, IDS), { problem: '.studio/revision.json was not written' });
  assert.match((readRevisionPlan('{ "pages": [{ "id": "p02", "note": "a "quoted" word" }] }', IDS) as { problem: string }).problem, /not valid JSON/);
  assert.match((readRevisionPlan('{ "changes": [] }', IDS) as { problem: string }).problem, /no "pages" list/);
  assert.match((readRevisionPlan('{ "pages": [{ "id": "p09" }] }', IDS) as { problem: string }).problem, /not in storyboard\.json.*p01, p02, p03, p04/);
  assert.deepEqual(readRevisionPlan('{ "pages": [] }', IDS), { plan: [] });
  // the same page twice is one page, with both notes
  assert.deepEqual(readRevisionPlan('{ "pages": [{ "id": "p3", "note": "红色" }, { "id": "p03", "note": "更大" }, { "id": 4 }] }', IDS), { plan: [{ id: 'p03', note: '红色\n更大' }, { id: 'p04', note: undefined }] });
});

type Step = (dir: string, text: string) => Partial<TurnResult> | void;
/** a finished film and a planner that takes `steps` in turn, one per message, across the sessions it is opened in */
async function change(request: string, steps: Step[], drew?: (inner: Record<string, unknown>) => void, decide?: Decider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-plan-'));
  fs.mkdirSync(path.join(dir, 'pages')); fs.mkdirSync(path.join(dir, '.studio'));
  fs.writeFileSync(path.join(dir, 'storyboard.json'), storyboard());
  fs.writeFileSync(path.join(dir, 'script.js'), SCRIPT);
  for (const id of IDS) fs.writeFileSync(path.join(dir, `pages/${id}.js`), `ENGINE.visual('${id}', () => {});\n`);
  fs.writeFileSync(path.join(dir, '.studio/state.json'), JSON.stringify({ stage: 'done', pages: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  const sent: string[] = [], opened: string[] = [], events: StudioEvent[] = [];
  const runtime: AgentRuntime = {
    id: 'pi', model: { provider: 'x', id: 'opus' },
    async open(o) {
      opened.push(o.name);
      return { ref: 'r', close: async () => {}, send: async (i) => {
        sent.push(i.text);
        const r = steps[sent.length - 1]?.(o.cwd, i.text) ?? {};
        return { ok: true, text: '', turns: 1, usage: {}, stopReason: 'done', answers: [], ...r } as TurnResult;
      } };
    },
  };
  const d = new Director({ dir, style: 'chalkboard', brief: { durationSec: 60, lang: 'zh', replyLang: 'zh' }, runtime, emit: (e) => events.push(e), decide });
  const drawn: { ids: string[]; revision?: Record<string, string> }[] = [];
  let reviewed = 0;
  const inner = d as unknown as Record<string, unknown> & { state: { change?: string; exported?: boolean; stage: string } };
  Object.assign(d.project, { timeline: async () => ({ duration: 12, pages: [] }) });
  Object.assign(inner, {
    serverMeta: () => {},
    pages: async (ids: string[]) => { drawn.push({ ids, revision: { ...(inner.state as { revision?: Record<string, string> }).revision } }); drew?.(inner); inner.state.stage = 'review'; },
    review: async () => { reviewed++; (inner.beforeReady as (() => void) | undefined)?.(); inner.state.stage = 'done'; },
  });
  let error: Error | undefined;
  await d.revise(request).catch((e: Error) => { error = e; });
  return { dir, sent, opened, events, drawn, reviewed, error, state: inner.state };
}
const plan = (dir: string, json: string) => fs.writeFileSync(path.join(dir, '.studio/revision.json'), json);
const errors = (events: StudioEvent[]) => events.filter((e) => e.type === 'error');

test('a question, thanks or a change a revision cannot make leaves the film as it was, with no error', async () => {
  // seen: 「你是什么模型」, 「这次感觉很不错了」, 「换一个风格」, 「1.5倍速度」: the planner answered and wrote no pages
  const r = await change('你是什么模型', [(dir) => plan(dir, '{ "pages": [] }\n')]);
  assert.equal(r.error, undefined);
  assert.deepEqual(errors(r.events), []);
  assert.deepEqual(r.drawn, []);
  assert.equal(r.reviewed, 0);
  assert.ok(r.events.some((e) => e.type === 'ready'));
  assert.equal(r.state.change, undefined);   // Continue does not ask the same question again
  assert.equal(r.state.stage, 'done');
});

test('a change to the narration alone is voiced again and checked, no page redrawn', async () => {
  // seen: 「垛子的垛读第三声」: the planner wrote the reading into script.js and an empty plan
  const r = await change('垛子的垛读第三声', [(dir) => { fs.writeFileSync(path.join(dir, 'script.js'), SCRIPT.replace("'一'", "'一，垛读 duǒ'")); plan(dir, '{ "pages": [] }'); }]);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.drawn, []);
  assert.equal(r.reviewed, 1);
  assert.equal(r.state.exported, false);
  assert.ok(r.events.some((e) => e.type === 'note' && /只改了文字/.test(e.text)));
  assert.equal(r.state.change, undefined);
});

test('a planner that forgot the plan is reminded once, and the change goes ahead', async () => {
  // seen: the planner edited script.js and storyboard.json for a new end page, told the user, and never wrote the plan
  const r = await change('结尾新增一个页面', [
    (dir) => { fs.writeFileSync(path.join(dir, 'storyboard.json'), storyboard([...IDS, 'p05'])); },
    (dir) => plan(dir, '{ "pages": [{ "id": "p05", "note": "片尾页" }] }'),
  ]);
  assert.equal(r.error, undefined);
  assert.match(r.sent[1], /\.studio\/revision\.json was not written/);
  assert.equal(r.opened.length, 1);   // in the same conversation
  // the page the planner added is drawn, though it was not in the storyboard when the change began
  assert.deepEqual(r.drawn.map((x) => x.ids), [['p05']]);
});

test('a plan that does not parse is written again', async () => {
  const r = await change('竹林这个效果不太好', [
    (dir) => plan(dir, '{ "pages": [{ "id": "p02", "note": "the "雨打竹林" card" }] }'),
    (dir) => plan(dir, '{ "pages": [{ "id": "p02", "note": "the \\"雨打竹林\\" card" }] }'),
  ]);
  assert.equal(r.error, undefined);
  assert.match(r.sent[1], /not valid JSON/);
  assert.deepEqual(r.drawn, [{ ids: ['p02'], revision: { p02: 'the "雨打竹林" card' } }]);
});

test('a planner whose model gave no answer is asked again in a session of its own', async () => {
  const r = await change('视频画面需要更具卡通儿童益智风格', [
    () => ({ ok: false, stopReason: 'error', error: '529 overloaded' }),
    (dir) => plan(dir, '{ "pages": [{ "id": "3" }] }'),
  ]);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.opened, ['reviser', 'reviser']);
  assert.equal(r.sent[0], r.sent[1]);   // the whole question again
  // an id written its own way is the storyboard's page; a page with no note is changed as the user asked
  assert.deepEqual(r.drawn, [{ ids: ['p03'], revision: { p03: '视频画面需要更具卡通儿童益智风格' } }]);
});

test('a planner that gives no plan twice fails in words the user can act on', async () => {
  const busy = await change('换个说法', [() => ({ ok: false, stopReason: 'error', error: '529 overloaded' }), () => ({ ok: false, stopReason: 'error', error: '529 overloaded' })]);
  assert.match(busy.error!.message, /太忙/);
  const none = await change('换个说法', [() => {}, () => {}]);
  assert.match(none.error!.message, /换个说法再说一次/);
  assert.deepEqual(none.drawn, []);
  assert.equal(errors(none.events).length, 1);
});

test('a plan naming a page the film does not have is asked for again with the pages it has', async () => {
  const r = await change('改一下最后一页', [(dir) => plan(dir, '{ "pages": [{ "id": "p09" }] }'), (dir) => plan(dir, '{ "pages": [{ "id": "p04", "note": "x" }] }')]);
  assert.equal(r.error, undefined);
  assert.match(r.sent[1], /p01, p02, p03, p04/);
  assert.deepEqual(r.drawn.map((x) => x.ids), [['p04']]);
});

test('a change drawn says, page by page, what each page agent changed', async () => {
  const r = await change('第 2 页和第 4 页的圆再大一点', [], (inner) => {
    (inner.changed as Map<string, string>).set('p02', '把圆放大到原来的两倍');
    (inner.unchanged as Map<string, string | undefined>).set('p04', '已经是最大了');
  }, { choose: async () => ({ choice: 'look', p: 0.98 }) });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.drawn.map((d) => d.ids), [['p02', 'p04']]);
  const revised = r.events.filter((e) => e.type === 'revised');
  // p04 was left as it was (its own note says why): only p02 is in the list
  assert.deepEqual(revised, [{ type: 'revised', pages: [{ id: 'p02', n: 2, section: 'p02', what: '把圆放大到原来的两倍' }] }]);
  assert.ok(r.events.some((e) => e.type === 'note' && e.text.includes('第 4 页没有改：已经是最大了')));
});
