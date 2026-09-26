/* Harness: flowchart node-position mapping (real renderer.js, DOM stubs).
   Run: node harness/flowchart-drag.test.js                                */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'renderer', 'renderer.js');

/* ---- minimal DOM stubs (only what the flowchart helpers touch) ---- */
function makeEl(id, opts = {}) {
  const el = {
    id,
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    offsetLeft: opts.left || 0,
    offsetTop: opts.top || 0,
    offsetWidth: opts.w || 0,
    offsetHeight: opts.h || 0,
    clientWidth: opts.clientW || 0,
    clientHeight: opts.clientH || 0,
    scrollLeft: opts.sl || 0,
    scrollTop: opts.st || 0,
    appendChild(c) { this.children.push(c); return c; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: opts.rectX || 0, top: opts.rectY || 0, right: (opts.rectX || 0) + (opts.rectW || 0), bottom: (opts.rectY || 0) + (opts.rectH || 0), width: opts.rectW || 0, height: opts.rectH || 0 }),
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
    insertBefore() {}, remove() {}, closest: () => null, contains: () => false
  };
  return el;
}
function makeCtx(chartEl) {
  const doc = {
    _q: { '#flowChart': chartEl },
    querySelector(sel) { return this._q[sel] || null; },
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    addEventListener() {}, removeEventListener() {},
    elementFromPoint: () => null, body: makeEl('body'), documentElement: makeEl('html')
  };
  const borders = { borderLeftWidth: '1px', borderTopWidth: '1px', borderRightWidth: '1px', borderBottomWidth: '1px' };
  const win = {
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1104, innerHeight: 715,
    getComputedStyle: () => borders
  };
  const ctx = {
    window: win, document: doc, localStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => borders,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, console,
    confirm: () => true, alert: () => {}, prompt: () => null,
    chart: chartEl
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

/* Pull just the pure helpers out of the real source so we test shipped code. */
function loadHelpers(ctx) {
  const src = fs.readFileSync(SRC, 'utf8');
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (!depth) break; }
    }
    return src.slice(start, i + 1);
  };
  const code = [
    'const NODE_W = 150, NODE_H = 64;',
    'const $ = (s) => (s === "#flowChart" ? (globalThis.__chart || null) : null);',
    'function clamp01(v){v=Number(v);if(!isFinite(v))return 0.1;return Math.min(1,Math.max(0,v));}',
    'function clampPx(v,max){return Math.min(Math.max(0,v),Math.max(0,max));}',
    'state = globalThis.__state = {folders:[{id:"F1",name:"T",chartZoom:1,nodes:[],edges:[]}],books:[],currentFolderId:"F1"};',
    'function chartZoomOf(fid){const f=state.folders.find(x=>x.id===fid);const z=f&&isFinite(f.chartZoom)?+f.chartZoom:1;return Math.min(2.5,Math.max(0.3,z));}',
    src.slice(src.indexOf('function chartDims()'), src.indexOf('// Client point -> pixel')),
    grab('chartWorldXY'), grab('nodeSize'), grab('chartTravel'),
    grab('fracToPos'), grab('posToFrac'), grab('nodePx'),
    'module.exports={chartDims,chartWorldXY,nodeSize,chartTravel,fracToPos,posToFrac,nodePx};'
  ].join('\n');
  ctx.__chart = ctx.__chart || null;
  const mod = { exports: {} };
  ctx.module = mod;
  ctx.__chart = ctx.chart;
  vm.runInContext(code, vm.createContext(ctx));
  return mod.exports;
}

/* ---- assertions ---- */
let pass = 0, fail = 0;
const eq = (name, got, want, tol = 0) => {
  const ok = tol ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name} = ${tol ? got.toFixed(1) : JSON.stringify(got)}`); }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

/* A host viewport 1000x400 (no scrollbars) and one 1000x400 with both bars. */
function host(clientW, clientH, sl, st, rectX = 10, rectY = 20) {
  const scrollbar = 15;
  return makeEl('flowChart', {
    clientW, clientH, sl, st, rectX, rectY, rectW: clientW, rectH: clientH,
    w: clientW, h: clientH
  });
}
function hostWithBars(clientW, clientH, sl, st) {
  // offsetWidth includes the scrollbar gutters that clientW/H exclude
  return makeEl('flowChart', {
    clientW, clientH, sl, st, rectX: 10, rectY: 20, rectW: clientW, rectH: clientH,
    w: clientW + 17, h: clientH + 17
  });
}

function suite() {
  console.log('\n-- chartDims: world = viewport x zoom, immune to scrollbars --');
  {
    const h = host(1000, 400, 0, 0);
    const ctx = makeCtx(h);
    const H = loadHelpers(ctx);
    const d1 = H.chartDims();
    eq('zoom 1 -> W', d1.W, 1000);
    eq('zoom 1 -> H', d1.H, 400);
  }
  {
    // Same box, but both scrollbars are showing: world must NOT shrink.
    const h = hostWithBars(985, 385, 0, 0);
    const ctx = makeCtx(h);
    const H = loadHelpers(ctx);
    const d = H.chartDims();
    eq('W with vscrollbar', d.W, 1000);
    eq('H with hscrollbar', d.H, 400);
  }
  {
    const h = host(1000, 400, 0, 0);
    const ctx = makeCtx(h);
    const H = loadHelpers(ctx);
    ctx.__state.folders[0].chartZoom = 2.5;
    const d = H.chartDims();
    eq('zoom 2.5 -> W', d.W, 2500);
    eq('zoom 2.5 -> H', d.H, 1000);
    ctx.__state.folders[0].chartZoom = 1;
  }

  console.log('\n-- frac <-> px round trip covers the whole canvas --');
  {
    const h = host(1000, 400, 0, 0);
    const ctx = makeCtx(h);
    const H = loadHelpers(ctx);
    const size = { w: 150, h: 77 };
    const t = H.chartTravel({ W: 1000, H: 400 }, size);
    eq('travel x', t.x, 850);
    eq('travel y', t.y, 323);
    eq('fx=0 -> x', H.fracToPos(0, 0, { W: 1000, H: 400 }, size).x, 0);
    eq('fx=1 -> x (flush right)', H.fracToPos(1, 1, { W: 1000, H: 400 }, size).x, 850);
    eq('fy=1 -> y (flush bottom)', H.fracToPos(1, 1, { W: 1000, H: 400 }, size).y, 323);
    for (const f of [0, 0.13, 0.5, 0.87, 1]) {
      const p = H.fracToPos(f, f, { W: 1000, H: 400 }, size);
      const back = H.posToFrac(p.x, p.y, { W: 1000, H: 400 }, size);
      eq(`round trip fx=${f}`, back.fx, f, 1e-9);
      eq(`round trip fy=${f}`, back.fy, f, 1e-9);
    }
    // A node bigger than the world (extreme zoom-out) must not invert.
    const tiny = { w: 900, h: 380 };
    eq('travel collapses at 0', H.chartTravel({ W: 500, H: 200 }, tiny).x, 0);
    eq('posToFrac with no travel', H.posToFrac(10, 10, { W: 500, H: 200 }, tiny).fx, 0);
  }

  console.log('\n-- nodePx: grab offset honoured, full travel, scroll aware --');
  // Host rect is at (10,20) with a 1px border, so content x = clientX - 10 - 1.
  const BX = 10 + 1, BY = 20 + 1;
  const drag = (chartEl, zoom, size, grabX, grabY, clientX, clientY) => {
    const ctx = makeCtx(chartEl);
    ctx.__zoom = zoom;
    const H = loadHelpers(ctx);
    ctx.__state.folders[0].chartZoom = zoom;
    const r = H.nodePx({ canvas: chartEl, size, grabX, grabY }, clientX, clientY);
    r.dims = H.chartDims();
    return r;
  };
  const size = { w: 150, h: 42 };
  {
    // Grab the node's centre: no jump, node origin = pointer - 75.
    const r = drag(host(1000, 400, 0, 0), 1, size, 75, 21, BX + 200, BY + 100);
    eq('grab centre: x', r.x, 200 - 75);
    eq('grab centre: y', r.y, 100 - 21);
    eq('grab centre: fx', r.fx, 125 / 850, 1e-9);
  }
  {
    // Grab the node's top-left corner: node origin == pointer.
    const r = drag(host(1000, 400, 0, 0), 1, size, 0, 0, BX + 300, BY + 200);
    eq('grab corner: x', r.x, 300);
    eq('grab corner: y', r.y, 200);
  }
  {
    // Pointer at the far corner of the viewport -> node flush to far edges.
    const r = drag(host(1000, 400, 0, 0), 1, size, 0, 0, BX + 1000 - 1, BY + 400 - 1);
    eq('far corner: x == travel', r.x, 850);
    eq('far corner: y == travel', r.y, 358);
    eq('far corner: fx', r.fx, 1);
    eq('far corner: fy', r.fy, 1);
  }
  {
    // Beyond the top-left -> clamped, never negative.
    const r = drag(host(1000, 400, 0, 0), 1, size, 0, 0, BX - 500, BY - 500);
    eq('clamp top-left x', r.x, 0);
    eq('clamp top-left y', r.y, 0);
    eq('clamp fx', r.fx, 0);
    eq('clamp fy', r.fy, 0);
  }
  {
    // Panned chart: pointer at the viewport's left edge maps to world x = sl.
    const r = drag(host(1000, 400, 600, 250, 10, 20), 1, size, 0, 0, BX + 2, BY + 2);
    eq('scrolled: x', r.x, 602);
    eq('scrolled: y', r.y, 252);
  }
  {
    // Zoomed-in world (2.5x): the node travels the FULL 2500px world even
    // though only 1000px of it is on screen, and panning to the end of the
    // world puts the node flush against the world's right edge (fx = 1).
    const el = host(1000, 400, 1500, 0, 10, 20);
    const r = drag(el, 2.5, size, 0, 0, BX + 1000 - 1, BY + 1);
    eq('zoom: world W', r.dims.W, 2500);
    eq('zoom: travel x', r.dims.W - size.w, 2350);
    eq('zoom: scrolled to the end pins the node to the world edge', r.x, 2350);
    const end = drag(host(1000, 400, 1500, 0, 10, 20), 2.5, size, 0, 0, BX + 1000 - 1, BY + 1);
    eq('zoom: fx at world end', end.fx, 1, 0.01);
    const mid = drag(host(1000, 400, 0, 0), 2.5, size, 0, 0, BX + 500, BY + 1);
    eq('zoom: fx at world start (scrolled home)', mid.fx, 0.21, 0.01);
  }
  {
    // Tall node (2-line label + book chip): travel shrinks by the real height,
    // so the node can never hang off the bottom of the world.
    const tall = { w: 150, h: 77 };
    const r = drag(host(1000, 400, 0, 0), 1, tall, 0, 0, BX + 1000 - 1, BY + 400 - 1);
    eq('tall node: y + h == world H', r.y + 77, 400);
    eq('tall node: x + w == world W', r.x + 150, 1000);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
suite();
