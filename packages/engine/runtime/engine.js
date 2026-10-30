/* Engine: lays out pages on the timeline, cross-fades between them, drives camera, the header and subtitles. */
(function () {
  const { h, clamp, lerp, smooth, ease, Builder, applyAct } = PV;
  const visuals = {};
  // A page's own error stays on that page: it shows a placeholder and the rest of the film still builds and plays.
  // Every error is recorded once per page (where in the page's code it happened) for the tools to report; the live
  // preview simply keeps working while a page is being drawn.
  const errors = [];
  // a page file that does not even load (a syntax error) never registers its visual: remember why, by page
  const loadErrors = {};
  addEventListener('error', (ev) => { const m = /pages(-portrait)?\/(p\w+)\.js/.exec(ev.filename || ''); if (m) loadErrors[m[2]] = Object.assign(new Error(ev.message), { stack: `${ev.message}\n    at pages/${m[2]}.js:${ev.lineno}:${ev.colno}` }); });
  function fail(p, phase, e, t) {
    if (!errors.some((x) => x.page === p.pg.id)) {
      // the film's own code too (its components in extras/, a kit's check page): a kit's error is sent to the session
      // whose component it is raised in, found by these frames
      const at = String(e?.stack || '').split('\n').map((l) => /pages(-portrait)?\/\w+\.js:\d+:\d+|extras\/[\w./-]+\.js:\d+:\d+|engine\/(runtime|lib)\/[\w.-]+:\d+:\d+|runtime\/[\w.-]+:\d+:\d+/.exec(l)?.[0]).filter(Boolean).slice(0, 4);
      errors.push({ page: p.pg.id, phase, t: t == null ? null : +t.toFixed(2), local: t == null ? null : +(t - p.pg.start).toFixed(2), message: String(e?.message || e), at });
      console.error(`page ${p.pg.id} ${phase}${t == null ? '' : ` @${t.toFixed(2)}s`}: ${e?.message || e}`);
    }
    if (!p.placeholder) {
      p.placeholder = h('div', 'page-placeholder', `<b></b><span>…</span>`, p.root);
      p.placeholder.querySelector('b').textContent = p.pg.section || p.pg.title || p.pg.id;
    }
  }
  let layout, pages = [], frame, stage, chrome, subs, mark;

  function visual(id, fn) { visuals[id] = fn; }

  // ── hand edits ───────────────────────────────────────────
  // What a page draws is a list of things, each one call its code makes to the builder (P.text, P.box, a kit's card),
  // numbered 1, 2, 3… in the order the code makes them: the same every time the page is built. An editor names a thing
  // by that number, and what was done to it by hand is written after the page's code as ENGINE.edits('<page>', {…}):
  //   { "<n>": { dx, dy, scale, ox, oy, hidden, text: { "<j>": "words" } } }
  // moved by dx/dy and scaled by `scale` about (ox, oy) (stage px), taken off the picture, or its j-th words (its
  // calls to P.text, from 0) shown as others. The page's code is never changed: the edits are laid over what it draws.
  // Each thing's outermost elements carry data-item="<n>" and data-call (the builder's call that drew it: text, box…).
  const edits = {};
  function editsOf(id, map) { edits[id] = map && typeof map === 'object' ? map : {}; }
  /** the builder's helpers that tell a time, make a layer, move the camera or work for other calls: not things */
  const NOT_THINGS = new Set(['constructor', 'c', 'cw', 'ce', 'seed', 'act', 'tick', 'handle', 'ro', 'shapeOf', 'texture', 'layer', 'cam', 'push', 'pan', 'slam', 'shake', 'back']);
  let building = null;   // the page being built: { id, n, watch }
  let thing = null;      // the thing being drawn: { n, j, ed }
  let counted = false;
  /** every drawing call of the builder (the runtime's, a style's kit, a lib's: all are on its prototype by the first build)
   *  counted when a page's code makes it, the words of an edited thing put in */
  function countThings() {
    if (counted) return;
    counted = true;
    const B = Builder.prototype;
    for (const name of Object.getOwnPropertyNames(B)) {
      const d = Object.getOwnPropertyDescriptor(B, name);
      if (NOT_THINGS.has(name) || !d || typeof d.value !== 'function') continue;
      const f = d.value;
      B[name] = function (...args) {
        if (thing) {
          if (name === 'text') { const w = thing.ed?.text?.[thing.j++]; if (typeof w === 'string') args[0] = w; }
          return f.apply(this, args);
        }
        if (!building) return f.apply(this, args);
        const n = ++building.n, ed = edits[building.id]?.[n];
        building.watch.takeRecords();
        thing = { n, j: 0, ed };
        if (name === 'text') { const w = ed?.text?.[thing.j++]; if (typeof w === 'string') args[0] = w; }
        try { return f.apply(this, args); } finally {
          const added = building.watch.takeRecords().flatMap((r) => [...r.addedNodes]).filter((x) => x.nodeType === 1);
          thing = null;
          place(added, n, ed, name);
        }
      };
    }
  }
  const num = (v, or) => (typeof v === 'number' && Number.isFinite(v) ? v : or);
  /** a thing's outermost elements, numbered; moved or hidden as it was edited. A move puts them, where they were, into
   *  a group of their own (an SVG <g>, or a stage-sized <div>) that is moved: the engine's own animation of each goes on
   *  inside it, and what was drawn over or under it still is */
  function place(added, n, ed, call) {
    const tops = added.filter((x) => x.isConnected && !added.some((o) => o !== x && o.contains(x)));
    for (const x of tops) { x.setAttribute('data-item', n); x.setAttribute('data-call', call); }
    if (!ed || !tops.length) return;
    if (ed.hidden) for (const x of tops) x.style.display = 'none';
    const dx = num(ed.dx, 0), dy = num(ed.dy, 0), sc = num(ed.scale, 1), ox = num(ed.ox, 0), oy = num(ed.oy, 0);
    if (!dx && !dy && sc === 1) return;
    const byParent = new Map();
    for (const x of tops) { if (!byParent.has(x.parentNode)) byParent.set(x.parentNode, []); byParent.get(x.parentNode).push(x); }
    for (const [parent, xs] of byParent) {
      const svg = parent.namespaceURI === 'http://www.w3.org/2000/svg';
      const g = svg ? document.createElementNS(parent.namespaceURI, 'g') : document.createElement('div');
      g.setAttribute('data-item', n);
      g.setAttribute('data-call', call);
      g.setAttribute('class', 'edited');   // a group that only moves what is in it: an editor looks through it
      if (svg) g.setAttribute('transform', `translate(${ox + dx} ${oy + dy}) scale(${sc}) translate(${-ox} ${-oy})`);
      else Object.assign(g.style, { position: 'absolute', inset: '0', transformOrigin: `${ox}px ${oy}px`, transform: `translate(${dx}px, ${dy}px) scale(${sc})` });
      parent.insertBefore(g, xs[0]);
      for (const x of xs) g.appendChild(x);
    }
  }

  // ── optional header: META.course · META.no | current section (no page counter) ──
  function buildChrome(parent) {
    const el = h('div', 'chrome', null, parent);
    const meta = SCRIPT.META || {};
    const no = meta.no ?? (decodeURIComponent(location.pathname).match(/-(\d+)\/index\.html$/) || [])[1] ?? '';
    const left = h('div', 'ch-left', '<b></b><i>·</i><span class="ch-no"></span><em class="ch-sec"></em>', el);
    left.querySelector('b').textContent = meta.course ?? '';
    left.querySelector('.ch-no').textContent = no;
    return { el, sec: left.querySelector('.ch-sec') };
  }
  function updateChrome(t) {
    let cur = pages[0];
    for (const p of pages) if (t >= p.pg.start - 0.3) cur = p;
    const txt = cur.pg.section;
    if (chrome.sec.textContent !== txt) chrome.sec.textContent = txt;
    const prev = pages[cur.pg.index - 1];
    const changed = !prev || prev.pg.section !== txt;
    chrome.sec.style.opacity = changed ? smooth(cur.pg.start - 0.3, cur.pg.start + 0.4, t).toFixed(3) : '1';
    chrome.el.style.opacity = smooth(0.2, 1.2, t).toFixed(3);
    // a camera push-in could slide content under the header: fade in a paper band behind it
    chrome.el.classList.toggle('masked', cur.sh.cams.length > 0 && t > cur.pg.start + (cur.sh.cams[0].at - 0.2));
  }

  // ── the brand's corner mark: META.mark = { src, dark?, corner: 'tr' | 'br' | 'bl', w, h, signOff? } ──
  // The same small logo in the same corner of every page, above the pages and not moved by the camera. It fades in with
  // the film and out before the brand's sign-off (signOff: the last page ends on the large logo), so one logo shows at a time.
  const CORNERS = { tr: ['top', 'right'], br: ['bottom', 'right'], bl: ['bottom', 'left'] };
  function buildMark(parent, m) {
    if (!m || typeof m.src !== 'string' || !CORNERS[m.corner]) return null;
    const paper = window.STYLE?.palette?.paper;
    const dark = /^#[0-9a-f]{6}$/i.test(paper || '') && [1, 3, 5].reduce((s, i, k) => s + parseInt(paper.slice(i, i + 2), 16) * [0.299, 0.587, 0.114][k], 0) < 110;
    const src = dark && m.dark ? m.dark : m.src;
    PV.preload?.(src);
    // fits a box of the corner: wide logos by width, square and tall ones by height
    const k = Math.min(170 / (m.w || 1), (STAGE.portrait ? 90 : 84) / (m.h || 1));
    const el = h('img', 'brand-mark', null, parent);
    el.src = src; el.alt = '';
    el.style.width = `${Math.round((m.w || 1) * k)}px`; el.style.height = `${Math.round((m.h || 1) * k)}px`;
    const [v, hz] = CORNERS[m.corner];
    el.style[v] = `${v === 'top' ? 44 : STAGE.portrait ? 300 : 40}px`; el.style[hz] = '48px';
    return { el, m };
  }
  function updateMark(t) {
    const last = pages[pages.length - 1].pg;
    const FO = SCRIPT.META?.fadeOut ?? TIMING.FADE_OUT;
    const gone = mark.m.signOff ? smooth(last.speechEnd, last.speechEnd + 0.4, t) : (FO > 0 ? smooth(last.end - FO, last.end, t) : 0);
    mark.el.style.opacity = (smooth(0.3, 1.1, t) * (1 - gone)).toFixed(3);
  }

  // ── subtitles ─────────────────────────────────────────────
  function updateSubs(t) {
    if (!subs) return;
    let txt = '';
    for (const p of pages) {
      if (t < p.pg.start || t > p.pg.end) continue;
      for (const c of p.pg.cues) if (t >= c.start && t < c.end) txt = c.sub;
    }
    if (subs._t !== txt) { subs._t = txt; subs.firstChild.textContent = txt; subs.style.opacity = txt ? '1' : '0'; }
  }

  // ── camera ───────────────────────────────────────────────
  // key.ease: 'inOut' (default, a calm move) · 'out' (pulse: fast, then settle) · 'slam' (lands past the target, settles back)
  // key.shake: { amp, dur } — a short deterministic jolt starting at key.at (no target, keeps the current framing)
  const SLAM = (x) => (x < 0.55 ? lerp(0, 1.08, ease.out(x / 0.55)) : lerp(1.08, 1, ease.inOut((x - 0.55) / 0.45)));
  function camAt(keys, lt) {
    const CX = STAGE.w / 2, CY = STAGE.h / 2;
    let st = { x: CX, y: CY, s: 1 }, jx = 0, jy = 0;
    for (const k of keys) {
      if (lt <= k.at) break;
      if (k.shake) {
        const p = (lt - k.at) / (k.shake.dur ?? 0.25);
        if (p < 1) { const a = (k.shake.amp ?? 10) * (1 - p); jx += a * Math.sin(p * 47); jy += a * Math.cos(p * 39); }
        continue;
      }
      const x = clamp((lt - k.at) / (k.dur ?? 1.2));
      const e = k.ease === 'slam' ? SLAM(x) : (ease[k.ease] || ease.inOut)(x);
      st = { x: lerp(st.x, k.x ?? CX, e), y: lerp(st.y, k.y ?? CY, e), s: k.keepScale ? st.s : lerp(st.s, k.s ?? 1, e) };
    }
    return { x: st.x - jx / st.s, y: st.y - jy / st.s, s: st.s };
  }

  // ── lifecycle ────────────────────────────────────────────
  function init(opts = {}) {
    frame = document.getElementById('frame');
    stage = document.getElementById('stage');
    stage.innerHTML = '';
    pages = [];
    errors.length = 0;
    PV.unknownColors.clear();
    for (const el of frame.querySelectorAll('.chrome, .subs, .brand-mark')) el.remove();
    layout = TIMING.layout(SCRIPT.PAGES, { ...(SCRIPT.META || {}), voice: SCRIPT.VOICE });
    const only = opts.only ? new Set(opts.only) : null;
    for (const pg of layout.pages) {
      const root = h('div', 'page', null, stage);
      root.dataset.page = pg.id;
      const cam = h('div', 'cam', null, root);
      // hud: above the camera layer and not moved by it — page titles stay put while the camera pushes in
      const hud = h('div', 'hud', null, root);
      const B = new Builder(pg, cam);
      B.hud = new Builder(pg, hud, B.sh);
      const obj = { pg, root, cam, hud, sh: B.sh, B, vis: 0 };
      pages.push(obj);
      if (!only || only.has(pg.id)) {
        const fn = visuals[pg.id];
        PV.colorPage = pg.id;
        countThings();
        const watch = new MutationObserver(() => {});
        watch.observe(root, { childList: true, subtree: true });
        building = { id: pg.id, n: 0, watch };
        try { if (loadErrors[pg.id]) throw loadErrors[pg.id]; if (fn) fn(B, pg); else B.title(pg.title); }
        catch (e) { cam.innerHTML = ''; hud.innerHTML = ''; obj.sh.acts.length = 0; obj.sh.ticks.length = 0; fail(obj, 'build', e); }
        finally { PV.colorPage = undefined; building = null; thing = null; watch.disconnect(); }
      }
    }
    chrome = (SCRIPT.META || {}).chrome === true ? buildChrome(frame) : null;   // META.chrome: true → series header (META.course · META.no | section)
    mark = buildMark(frame, (SCRIPT.META || {}).mark);
    if (opts.subs) { subs = h('div', 'subs', '<span></span>', frame); }
  }

  function renderAt(t) {
    const F = Math.min(TIMING.FADE, layout.gap);   // short gaps fade faster, never into the speech
    // The cross-fade ends D seconds after the page boundary: a new page draws its first stroke a moment after it starts,
    // and ending the fade at the boundary showed empty paper in between. The outgoing page stays a pure function of t.
    const D = SCRIPT.META?.fadeDelay ?? 0.3;
    const FO = SCRIPT.META?.fadeOut ?? TIMING.FADE_OUT;   // META.fadeOut: the film's closing fade in seconds, 0 for a hard cut
    for (const p of pages) {
      const { start, end, index } = p.pg;
      const last = index === pages.length - 1;
      const inK = index === 0 ? 1 : smooth(start - F + D, start + D, t);
      // the last page fades to the ground over the film's final moments
      const outK = last ? (FO > 0 ? smooth(end - FO, end, t) : 0) : smooth(end - F + D, end + D, t);
      const vis = inK * (1 - outK);
      p.vis = vis;
      if (vis <= 0.001) { if (p.root.style.display !== 'none') p.root.style.display = 'none'; continue; }
      p.root.style.display = 'block';
      p.root.style.opacity = vis.toFixed(4);
      if (SCRIPT.META?.pageMotion !== false) {   // META.pageMotion: false → plain cross-fade (films: the pages do their own transitions)
        const turn = last ? 0 : outK;   // the film's own ending is a plain fade, not a page turn
        p.root.style.transform = `translate(${(-turn * 36 + (1 - inK) * 24).toFixed(2)}px, 0)`;
        p.root.style.filter = turn > 0.02 ? `blur(${(turn * 5).toFixed(2)}px)` : 'none';
      }
      const lt = t - start;
      const c = camAt(p.sh.cams, lt);
      const cx0 = STAGE.w / 2, cy0 = STAGE.h / 2;
      p.cam.style.transform = c.s === 1 && c.x === cx0 && c.y === cy0 ? '' : `translate(${(cx0 - c.x * c.s).toFixed(2)}px, ${(cy0 - c.y * c.s).toFixed(2)}px) scale(${c.s.toFixed(4)})`;
      // while the camera is pushed in, a paper band fades in behind the fixed title so content can slide under it
      p.hud.style.setProperty('--band', clamp((c.s - 1) * 10).toFixed(3));
      PV.colorPage = p.pg.id;
      try {
        for (const a of p.sh.acts) applyAct(a, lt);
        for (const fn of p.sh.ticks) fn(lt, t);
        if (p.broken) { p.broken = false; p.cam.style.visibility = ''; if (p.placeholder) p.placeholder.style.display = 'none'; }
      } catch (e) {
        fail(p, 'render', e, t);
        p.broken = true; p.cam.style.visibility = 'hidden'; p.placeholder.style.display = '';
      } finally { PV.colorPage = undefined; }
    }
    if (chrome) updateChrome(t);
    if (mark) updateMark(t);
    updateSubs(t);
    for (const fn of window.FRAME_HOOKS || []) fn(t, layout);   // extras can draw things that live across pages (a host character)
  }

  window.ENGINE = { visual, edits: editsOf, init, renderAt, get layout() { return layout; }, get pages() { return pages; }, get errors() { return errors; }, get colors() { return [...PV.unknownColors].map(([page, names]) => ({ page, names: [...names] })); }, source: (id) => visuals[id]?.toString() };
})();
