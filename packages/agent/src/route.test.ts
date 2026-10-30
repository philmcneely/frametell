import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Director } from './director.js';
import { ROUTE, cleanCredits, creditsToFinish, routeAsk } from './prompts.js';
import type { AgentRuntime } from './runtime/types.js';
import type { StudioEvent } from './events.js';

/** a model that answers every session with `answer` (or throws it); `seen` keeps who was asked what, on which runtime */
function model(id: string, answer: unknown, seen: { runtime: string; name: string; text: string; tools?: string; answers?: string[] }[]): AgentRuntime {
  return {
    id: 'pi', model: { provider: 'x', id },
    async open(s) {
      return { ref: s.name, close: async () => {}, send: async ({ text }: { text: string }) => {
        seen.push({ runtime: id, name: s.name, text, tools: s.tools, answers: s.answers?.map((a) => a.name) });
        if (answer instanceof Error) throw answer;
        return { text: '', stopReason: 'done', usage: {}, answers: answer ? [{ name: ROUTE.name, args: answer }] : [] } as never;
      } };
    },
  };
}

function film(answer: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-route-'));
  const seen: Parameters<typeof model>[2] = [], events: StudioEvent[] = [];
  const d = new Director({ dir, style: 'whiteboard', brief: { durationSec: 120, lang: 'en', replyLang: 'en' }, runtime: model('director', answer, seen), reviewer: { runtime: model('reviewer', answer, seen) }, emit: (e) => events.push(e) });
  const sb = { title: 'T', summary: 'S', pages: [{ id: 'p01' }, { id: 'p02' }, { id: 'p03' }] };
  Object.assign(d.project, { storyboard: () => sb, timeline: async () => ({ duration: 90, pages: [] }) });
  const state = (d as unknown as { state: { stage: string; firstPage?: string; pages: Record<string, { status: string }>; notes?: string[] } }).state;
  state.stage = 'pages'; state.pages = { p01: { status: 'ok' } as never, p02: { status: 'drawing' } as never };
  return { d, seen, events, state };
}

const credits = { available: 500, spent: 120, perMinute: 150, exportQuote: 9 };

test('a question gets the reply and is not noted; the router is one tool-less session on the reviewer model', async () => {
  const f = film({ change: false, question: true, reply: 'About 114 more credits; you have 500.' });
  const r = await f.d.route('how many credits do I need to finish the vdieo', credits);
  assert.deepEqual(r, { kind: 'question', reply: 'About 114 more credits; you have 500.' });
  assert.equal(f.seen.length, 1);
  assert.deepEqual({ ...f.seen[0], text: undefined }, { runtime: 'reviewer', name: 'route', text: undefined, tools: 'none', answers: ['route'] });
  // what it knows: the narration's length, the pages, and the credits still needed, worked out in code
  // (90 s at 150 a minute is 225, less 120 spent, plus the export's 9)
  assert.match(f.seen[0].text, /how many credits do I need/);
  assert.match(f.seen[0].text, /Pages drawn: 1 of 3/);
  assert.match(f.seen[0].text, /1\.5 min \(the narration as written\)/);
  assert.match(f.seen[0].text, /about 114 \(worked out/);
  assert.match(f.seen[0].text, /has enough/);
  assert.equal(f.state.notes, undefined, 'routing notes nothing itself');
  // its words are not shown as the agent's; only its turn is counted
  assert.ok(!f.events.some((e) => e.type === 'agent' && e.session === 'route' && e.event.type !== 'turn'));
});

test('both: a change with a question is answered and taken as a change', async () => {
  const f = film({ change: true, question: true, reply: 'Sure, and it will take about two more minutes.' });
  assert.deepEqual(await f.d.route('make it blue, and how long is left?'), { kind: 'both', reply: 'Sure, and it will take about two more minutes.' });
});

test('a change, a failed turn, no call, or a question with nothing to say back are all read as a change', async () => {
  for (const answer of [{ change: true, question: false, reply: '' }, new Error('model down'), undefined, { change: false, question: true, reply: '  ' }]) {
    const f = film(answer);
    assert.deepEqual(await f.d.route('thicker lines please', credits), { kind: 'change' });
  }
});

test('the credits still needed: minutes at the rate, less what was spent, plus the export; never below the export', () => {
  assert.deepEqual(creditsToFinish(90, credits), { needed: 114, covered: true });
  assert.deepEqual(creditsToFinish(61, { available: 100, spent: 0, perMinute: 150 }), { needed: 153, covered: false });
  // spent past the quote: only the export is left
  assert.deepEqual(creditsToFinish(60, { available: 10, spent: 400, perMinute: 150, exportQuote: 9 }), { needed: 9, covered: true });
  assert.equal(creditsToFinish(undefined, credits), undefined);
  assert.equal(creditsToFinish(0, credits), undefined);
});

test('credit facts from the wire are kept only when their numbers are numbers', () => {
  assert.deepEqual(cleanCredits({ available: 5, spent: 1, perMinute: 150, exportQuote: 2, x: 'y' }), { available: 5, spent: 1, perMinute: 150, exportQuote: 2 });
  assert.deepEqual(cleanCredits({ available: 5, spent: 1, perMinute: 150, exportQuote: '2' }), { available: 5, spent: 1, perMinute: 150 });
  assert.equal(cleanCredits({ available: '5', spent: 1, perMinute: 150 }), undefined);
  assert.equal(cleanCredits(null), undefined);
  assert.equal(cleanCredits(undefined), undefined);
});

test('without credits the router is told the money spent, and nothing about credits; a short account is said', () => {
  const open = routeAsk('how much has this cost?', { stage: 'pages', pagesDone: 2, cost: { amount: 0.4321, currency: 'USD' } });
  assert.match(open, /Spent on the model so far: 0\.43 USD/);
  assert.doesNotMatch(open, /credits/i);
  const short = routeAsk('enough?', { stage: 'pages', pagesDone: 0, durationSec: 120 }, { available: 100, spent: 0, perMinute: 150 });
  assert.match(short, /about 300 .*is 200 short/);
  assert.doesNotMatch(short, /Spent on the model/);
  const unknown = routeAsk('enough?', { stage: 'storyboard', pagesDone: 0 }, { available: 100, spent: 0, perMinute: 150 });
  assert.match(unknown, /can't be worked out yet/);
});

/** the same film with a decision model that answers `choice` at `p` (the director's `decide`) */
function decided(choice: string, p: number, answer: unknown = { change: false, question: true, reply: 'About 3 minutes.' }) {
  const f = film(answer), asked: unknown[] = [];
  (f.d as unknown as { o: { decide: unknown } }).o.decide = { ask: async (state: unknown) => { asked.push(state); return { q: { type: 'choice', choice, probabilities: { [choice]: p } } }; } };
  return { ...f, asked };
}

test('a change or a go-ahead the decision model is sure of opens no session; anything else is read by the model', async () => {
  const change = decided('change', 0.97);
  assert.deepEqual(await change.d.route('make the background dark blue'), { kind: 'change' });
  assert.equal(change.seen.length, 0);
  assert.deepEqual(change.asked, [{ message: 'make the background dark blue', filmWaitingForTheUser: false }]);
  // a go-ahead only counts while the film waits for the user
  const go = decided('go', 0.99);
  go.state.firstPage = 'waiting';
  assert.deepEqual(await go.d.route('continue'), { kind: 'go' });
  assert.equal(go.seen.length, 0);
  for (const [choice, p] of [['question', 0.99], ['both', 0.95], ['change', 0.7]] as const) {
    const f = decided(choice, p);
    assert.deepEqual(await f.d.route('how long will it take?'), { kind: 'question', reply: 'About 3 minutes.' }, `${choice} ${p}`);
    assert.equal(f.seen.length, 1);
  }
});

test('the components a first-page change reaches: taken from the decision model only when it is sure of every one', async () => {
  const items = [{ name: 'fox', what: 'the host, orange with a scarf' }, { name: 'frame', what: 'the frame charts sit in' }];
  const reach = async (ps: number[] | undefined) => {
    const f = film(undefined);
    (f.d as unknown as { o: { decide: unknown } }).o.decide = { ask: async () => (ps ? Object.fromEntries(ps.map((p, i) => [`c${i}`, { type: 'boolean', probability: p }])) : undefined) };
    return (f.d as unknown as { kitReached(i: unknown, c: string): Promise<string[] | undefined> }).kitReached(items, 'the scarf in blue');
  };
  assert.deepEqual(await reach([0.95, 0.03]), ['fox']);
  assert.deepEqual(await reach([0.04, 0.1]), []);
  assert.equal(await reach([0.95, 0.5]), undefined);   // unsure of one: the model's session decides
  assert.equal(await reach(undefined), undefined);     // no answer: likewise
});
