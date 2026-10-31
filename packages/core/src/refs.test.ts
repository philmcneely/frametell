import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attach, cleanRefs, withRefs } from './refs.js';

test('references lead the message, with times in the film and paths the director can open', () => {
  const out = withRefs('这里节奏再慢一点', [
    { kind: 'page', page: 'p04', label: '第 4 页「节奏」' },
    { kind: 'line', page: 'p04', label: 'x', at: 35.2, text: '连续完成 4 个番茄钟之后，' },
    { kind: 'frame', page: 'p04', label: 'x', at: 36.4, path: 'out/frames/364.jpg', text: '连续完成' },
  ]);
  assert.match(out, /^<references>/);
  assert.match(out, /<page id="p04" file="pages\/p04.js">第 4 页「节奏」<\/page>/);
  assert.match(out, /<line page="p04" at="0:35">连续完成 4 个番茄钟之后，<\/line>/);
  assert.match(out, /image="out\/frames\/364.jpg"/);
  assert.match(out, /\n\n这里节奏再慢一点$/);
  assert.equal(withRefs('只有字', []), '只有字');
});

test('references that point outside the project are dropped', () => {
  const kept = cleanRefs([
    { kind: 'file', label: 'a', path: '../../etc/passwd', image: false },
    { kind: 'frame', label: 'b', page: 'p01', at: 1, path: '/abs.jpg' },
    { kind: 'file', label: 'c', path: 'refs/x.png', image: true },
    { kind: 'nope', label: 'd' },
  ]);
  assert.deepEqual(kept.map((r) => r.label), ['c']);
});

test('attached files land in refs/, and unsupported ones are refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-refs-'));
  const r = await attach(dir, '截图 1.png', new Uint8Array([137, 80, 78, 71]));
  assert.equal(r.kind, 'file');
  assert.ok(r.kind === 'file' && r.image && /^refs\/\d{14}-截图_1\.png$/.test(r.path) && fs.existsSync(path.join(dir, r.path)));
  await assert.rejects(attach(dir, 'x.exe', new Uint8Array([1])), /格式还不支持|isn't a supported format/);
});

test('a voice to switch to is applied by the server: kept when well formed, never put before the director', () => {
  const voice = { kind: 'voice', label: '换成「云舟」', provider: 'volcengine', id: 'zh_male_m191_uranus_bigtts', name: '云舟' };
  assert.equal(cleanRefs([voice]).length, 1);
  assert.equal(cleanRefs([{ ...voice, id: '../x' }]).length, 0);
  assert.equal(cleanRefs([{ ...voice, provider: 'azure' }]).length, 0);
  const [v] = cleanRefs([voice]);
  assert.equal(withRefs('语速再慢一点', [v]), '语速再慢一点');
  assert.doesNotMatch(withRefs('这页', [v, { kind: 'page', page: 'p02', label: '第 2 页' }]), /voice|云舟/);
});

test('a picture of the film\'s own is pointed at with its size and note, to be placed', () => {
  const ref = { kind: 'file', label: 'Logo', path: 'assets/user/our-logo-0123456789.svg', image: true, asset: true };
  assert.equal(cleanRefs([ref]).length, 1);
  assert.equal(cleanRefs([{ ...ref, path: 'refs/x.png' }]).length, 0, 'an asset lives in assets/user/');
  assert.equal(cleanRefs([{ ...ref, path: 'assets/user/thumbs/x.webp' }]).length, 0);
  assert.equal(cleanRefs([{ ...ref, asset: 'yes' }]).length, 0);
  const assets = [{ file: 'our-logo-0123456789.svg', name: 'Our logo', note: 'the <mark>', type: 'svg' as const, w: 600, h: 200, alpha: true, bytes: 1, addedAt: '' }];
  const out = withRefs('放进片尾', cleanRefs([ref]), assets);
  assert.match(out, /<asset path="assets\/user\/our-logo-0123456789.svg" w="600" h="200">Our logo — the &lt;mark&gt;; the user wants this in the film: place it with P.img<\/asset>/);
  // gone from the list meanwhile: still pointed at, by its label
  assert.match(withRefs('x', cleanRefs([ref])), /<asset path="assets\/user\/our-logo-0123456789.svg">Logo; the user wants this/);
});

test('a thing picked on the picture: where it is, what draws it, the film then; malformed ones are dropped', () => {
  const thing = { kind: 'thing' as const, page: 'p03', label: 'summer', at: 36, box: { x: 626.4, y: 572, w: 160, h: 44 }, fp: 'text|summer|1', path: 'out/frames/live-1-360.jpg' };
  const out = withRefs('让它从左边飞进来', cleanRefs([thing]));
  assert.match(out, /<thing page="p03" file="pages\/p03\.js" at="0:36" box="626,572 160×44" drawn-by="P\.text\(“summer”…\), number 2 of those calls" image="out\/frames\/live-1-360\.jpg">summer: what the user picked/);
  assert.match(out, /让它从左边飞进来$/);
  assert.deepEqual(cleanRefs([{ ...thing, box: { x: 1, y: 2, w: 3 } }, { ...thing, path: '../x.jpg' }, { ...thing, fp: 7 }]), []);
  assert.equal(cleanRefs([{ kind: 'thing', page: 'p01', label: 'box', at: 1, box: { x: 0, y: 0, w: 1, h: 1 } }]).length, 1, 'fp and image are optional');
});

test('lines changed by hand: a revoice reference is kept for the runner and never shown to the director', () => {
  const refs = cleanRefs([{ kind: 'revoice', label: '重新配音' }]);
  assert.equal(refs.length, 1);
  assert.equal(withRefs('', refs), '');
  assert.equal(withRefs('再快一点', refs), '再快一点');
});
