// Hand edits (ENGINE.edits, runtime/engine.js): what a page draws is numbered by the order its code draws it, the same
// on every build; an edit moves, scales, hides or rewords a thing by that number, over what the code draws, and leaves
// what is drawn above and below it as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { createProject } from '../tools/project.mjs';
import { findChrome } from '../tools/bins.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');

const PAGE = (edits, before = '') => `ENGINE.visual('p01', (P) => {${before}
  P.title('Title words');                                             // 1
  P.box(200, 300, 300, 160, { color: 'ink', at: 0 });                  // 2
  ['a', 'b', 'c'].forEach((w, i) => P.text(w, { x: 200 + i * 200, y: 600, size: 60, at: 0, mode: 'fade' }));   // 3, 4, 5
  P.text(String(6 * 7), { x: 1200, y: 600, size: 60, at: 0, mode: 'fade' });   // 6: words the code works out
  P.box(1200, 300, 200, 120, { color: 'ink', at: 0 });                 // 7
});
${edits ? `ENGINE.edits('p01', ${JSON.stringify(edits)});\n` : ''}`;

async function built(edits, before) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frametell-edits-'));
  try {
    createProject(dir, { title: 'Edits', lang: 'en' });
    fs.writeFileSync(path.join(dir, 'pages/p01.js'), PAGE(edits, before));
    const browser = await chromium.launch({ executablePath: findChrome() });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('file://' + path.join(dir, 'index.html'));
      await page.evaluate(() => window.__ready);
      await page.evaluate(() => { ENGINE.renderAt(4); });
      return await page.evaluate((errors) => {
        const box = (n) => {
          // what it drew: the innermost elements of its number (a moved thing's are inside the group that moves them)
          const all = [...document.querySelectorAll(`[data-page="p01"] [data-item="${n}"]`)];
          const els = all.filter((e) => !e.querySelector(`[data-item="${n}"]`));
          const r = els.map((e) => e.getBoundingClientRect()).filter((b) => b.width || b.height);
          if (!r.length) return null;
          const x0 = Math.min(...r.map((b) => b.left)), y0 = Math.min(...r.map((b) => b.top));
          return { x: Math.round(x0), y: Math.round(y0), w: Math.round(Math.max(...r.map((b) => b.right)) - x0), h: Math.round(Math.max(...r.map((b) => b.bottom)) - y0), shown: all.every((e) => getComputedStyle(e).display !== 'none') };
        };
        // the words shown: of its outermost elements, those not hidden
        const words = (n) => [...document.querySelectorAll(`[data-page="p01"] [data-item="${n}"]`)].filter((e) => !e.parentElement.closest(`[data-item="${n}"]`) && getComputedStyle(e).display !== 'none')
          .map((e) => e.textContent).join('').replace(/\s+/g, ' ').trim();
        const order = [...document.querySelectorAll('[data-page="p01"] .cam svg.ink > [data-item]')].map((e) => e.dataset.item);
        const fps = Object.fromEntries([...document.querySelectorAll('[data-page="p01"] [data-fp]')].map((e) => [e.dataset.item, e.dataset.fp]));
        const colors = Object.fromEntries([2, 6].map((n) => { const e = document.querySelector(`[data-page="p01"] [data-item="${n}"]`); return [n, n === 2 ? e.querySelector('path[stroke]:not([stroke="none"])')?.getAttribute('stroke') : getComputedStyle(e).color]; }));
        const red = PV.col('red'), redRgb = (() => { const d = document.createElement('div'); d.style.color = red; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })();
        return { colors, red, redRgb, items: [1, 2, 3, 4, 5, 6, 7, 8].map(box), words: [1, 3, 4, 6].map(words), order, fps, orphans: ENGINE.orphans('p01'), errors };
      }, errors);
    } finally { await browser.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('edits: every thing a page draws is numbered by its code\'s order, the same on each build', async () => {
  const a = await built(null), b = await built(null);
  assert.deepEqual(a.errors, []);
  assert.ok(a.items.slice(0, 7).every(Boolean), 'all seven things are drawn and numbered');
  assert.deepEqual(a.items, b.items);
  assert.deepEqual(a.words, ['Title words', 'a', 'b', '42']);
});

test('edits: a thing is moved, scaled, hidden or reworded by its number; the rest stays where it was', async () => {
  const before = await built(null);
  const after = await built({
    2: { dx: 100, dy: -50, ox: 350, oy: 380 },
    4: { hidden: true },
    6: { text: { 0: 'forty-two' } },
    7: { scale: 2, ox: 1300, oy: 360 },
    3: { text: { 0: 'alpha' }, dx: 0, dy: 40, ox: 0, oy: 0 },
  });
  assert.deepEqual(after.errors, []);
  const [, b2, b3, b4, , b6, b7] = before.items, [a1, a2, a3, a4, a5, , a7] = after.items;
  assert.deepEqual(a1, before.items[0], 'an unedited thing is untouched');
  assert.deepEqual(a5, before.items[4]);
  assert.deepEqual([a2.x - b2.x, a2.y - b2.y, a2.w, a2.h], [100, -50, b2.w, b2.h], 'moved, its size kept');
  assert.ok(Math.abs(a7.w - 2 * b7.w) <= 2 && Math.abs(a7.x + a7.w / 2 - (b7.x + b7.w / 2)) <= 2, 'scaled about its centre');
  assert.equal(a4, null, 'hidden: nothing of it shows');
  assert.deepEqual(after.words, ['Title words', 'alpha', '', 'forty-two'], 'its words, written or worked out, replaced');
  assert.equal(a3.y - b3.y, 40);
  assert.ok(b4.shown && b6);
  // a moved thing keeps its place among the others: what was drawn after it is still over it
  assert.deepEqual(after.order, before.order);
});

test('edits: an edit names its thing by what it is too, so it follows it when the page later draws other things first', async () => {
  const plain = await built(null);
  // what each thing is: its call, its code's words, which of those it is
  assert.equal(plain.fps[3], 'text|a|0');
  assert.equal(plain.fps[2], 'box||0');
  const edits = { 4: { fp: 'text|b|0', dx: 0, dy: 100, ox: 0, oy: 0 }, 7: { fp: 'box||1', hidden: true }, 9: { fp: 'text|gone|0', hidden: true } };
  const same = await built(edits);
  // the page changed: a word drawn before everything (each thing's number is one more now)
  const later = await built(edits, "\n  P.text('new', { x: 50, y: 900, at: 0, mode: 'fade' });");
  assert.deepEqual(same.orphans, [9], 'a thing that is not there any more: its edit is an orphan');
  assert.deepEqual(later.orphans, [9]);
  assert.equal(same.items[3].y - plain.items[3].y, 100, 'b moved');
  assert.equal(later.items[4].y - plain.items[3].y, 100, 'b moved still, now the 5th thing');
  assert.equal(same.items[6], null, 'the second box hidden');
  assert.equal(later.items[7], null, 'the second box hidden still, now the 8th thing');
  assert.ok(later.items[6], 'the thing now 7th is not hidden');
});

test('edits: a thing drawn in another of the style\'s colours', async () => {
  const before = await built(null);
  const after = await built({ 2: { fp: 'box||0', color: 'red' }, 6: { fp: 'text|42|0', color: 'red' } });
  assert.notEqual(before.colors[2], after.red);
  assert.equal(after.colors[2], after.red, 'the box\'s ink');
  assert.equal(after.colors[6], after.redRgb, 'the words');
  assert.deepEqual(after.items[1], before.items[1], 'in the same place');
});

test('edits: a thing shown later: every act it registers moves by the shift, the others stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frametell-edits-'));
  try {
    createProject(dir, { title: 'Edits', lang: 'en' });
    fs.writeFileSync(path.join(dir, 'pages/p01.js'), `ENGINE.visual('p01', (P) => {
  P.text('one', { x: 100, y: 100, at: 0.5, mode: 'fade' }).hide(2);
  P.title('two');
});
ENGINE.edits('p01', { 1: { fp: 'text|one|0', shift: 1.5 } });
`);
    const browser = await chromium.launch({ executablePath: findChrome() });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto('file://' + path.join(dir, 'index.html'));
      await page.evaluate(() => window.__ready);
      const acts = await page.evaluate(() => ENGINE.pages[0].sh.acts.map((a) => ({ item: a.item, at: a.at, out: a.out ?? null })));
      assert.deepEqual(acts.filter((a) => a.item === 1).map((a) => [a.at, a.out]), [[2, 3.5]], 'shown at 0.5 + 1.5, gone at 2 + 1.5');
      assert.ok(acts.filter((a) => a.item === 2).every((a) => a.at < 1.5), 'the title untouched');
    } finally { await browser.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
