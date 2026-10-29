# Writing a component (extras/kit/*.js)

A component is drawn with the same API as a page: everything in the drawing API above as `P.xxx` is `this.xxx` inside it. This is all of it; **don't read engine/ to find more** (no ls / grep / sed / cat there, not the style's kit.js either): what is not written here or in the API above is not for a component to use.

```js
(function () {
  const { col, clamp, lerp, ease, Builder } = PV;
  const B = Builder.prototype;
  /** lamp(x, y, o): the desk lamp, dark, then lit. o: { at, on (when it lights), tilt (when its head dips), color } */
  B.lamp = function (x, y, o = {}) {
    const at = o.at ?? 0;
    const L = this.layer();                                        // a layer of its own, so it moves as one
    const base = L.box(x - 60, y, 120, 24, { fill: 'paper', at, dur: 0.4 });
    L.path(`M${x} ${y} L${x + 40} ${y - 160} L${x - 20} ${y - 220}`, { sw: 6, at: at + 0.2, dur: 0.5 });
    const head = L.circle(x - 20, y - 220, 90, { fill: 'paper', at: at + 0.5 });
    const lit = o.on != null ? L.circle(x - 20, y - 220, 90, { fill: o.color || 'yellow', at: o.on, dur: 0.3 }) : undefined;
    if (o.tilt != null) this.move(L, (lt) => ({ rot: 8 * PV.K(lt, o.tilt, 0.4, 'out') }), [x, y]);   // from lt alone
    return { layer: L, head, lit, base, end: head.end };           // handles for the pages
  };
})();
```

- **`this`** is the page's builder: `this.box / rect / circle / ellipse / line / path / curve / arrow / ring / text / icon / liveRough / follow / bars / code / chip / card / show / layer / tick / move / c(i)`, as in the table above, with the same arguments. The style's own components, listed below, are `this.name(…)` too: build on them (pass their options) rather than drawing the same thing again.
- **What a call returns.** A drawn shape (`box`, `circle`, `path`, `arrow`, …) and `text` return a handle `{ el, hide(t, dur), end }`: `el` is its element (an SVG group; a `div` for text), `hide(t)` fades it out at `t`, `end` is when its drawing is done. `this.layer()` returns a child builder (the same calls) whose `.wrap` moves as a whole: drive it with `this.move(L, (lt) => ({ x, y, s, rot, op }))`. `follow` returns its element.
- **Time.** Every drawing call takes `at` (when it starts, seconds in the page) and `dur`. Anything that changes after that goes in `this.tick((lt) => …)`, which runs on every frame with the page's time `lt`: set styles and attributes there from `lt` alone (`PV.K(lt, at, dur, ease)` is the eased progress 0→1, `clamp(x)` keeps x in 0..1, `lerp(a, b, k)`, `ease.out` / `ease.inOut`). No state carried between frames, no `Math.random()` (`PV.rng(seed)` returns a seeded generator), no CSS animation.
- **Colours** by the style's names (`color: 'blue'`, `fill: 'blueF'`, as in the API above); `col('blue')` gives the value for a raw element. Never a colour the style's palette doesn't name.
- **Raw elements**, only for what the calls above cannot draw: `PV.s(tag, attrs, this.svg)` makes an SVG element in the layer's SVG, `PV.h(tag, className, html, this.html)` an HTML one; `this.show(el, { at, dur })` fades it in. The stage is `STAGE.w` × `STAGE.h` (1920 × 1080).
- **Options a page may pass** are all read from the last argument `o`, each with a default; positions and sizes come first (`x, y`, a size), as in the API. Return what the pages will want to move, light or label later.
- The style's own helpers (the private functions inside its kit.js) are not reachable from your file; its components are. To match the style, use its components and its colours, or draw with the calls above in the way its grammar describes.
