/* The chart's edges used to be painted from measurements taken while the library
   view's entrance animation was scaling it, so every line ended up detached from
   the nodes it should join. This seeds a chart, then measures the gap between
   each line end and its node at three moments: while the animation is running,
   once it has settled, and after a resize. Over 3px counts as detached.

   Output goes through writeSync because app.exit() discards buffered stdout,
   which is exactly how an earlier version of this script lost its own error. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fss = require('fs');

const say = (...a) => fss.writeSync(1, a.join(' ') + '\n');

const MEASURE = String.raw`
(() => {
  const inner = document.getElementById('flowInner');
  if (!inner) return JSON.stringify({ error: 'no chart' });
  const ir = inner.getBoundingClientRect();
  const boxes = {};
  document.querySelectorAll('.flow-node').forEach(el => {
    const r = el.getBoundingClientRect();
    boxes[el.dataset.nodeId] = { x: r.left - ir.left, y: r.top - ir.top, w: r.width, h: r.height };
  });
  const gapTo = (px, py, b) => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const dx = cx - px, dy = cy - py;
    const len = Math.hypot(dx, dy);
    if (!len) return 0;
    const ux = dx / len, uy = dy / len;
    const tx = Math.abs(dx) > b.w / 2 ? (dx > 0 ? b.w / 2 : -b.w / 2) / ux : Infinity;
    const ty = Math.abs(dy) > b.h / 2 ? (dy > 0 ? b.h / 2 : -b.h / 2) / uy : Infinity;
    const t = Math.min(tx, ty);
    return isFinite(t) ? Math.abs(t - len) : 0;
  };
  const edges = [];
  document.querySelectorAll('#flowEdges .edge').forEach(g => {
    const line = g.querySelector('.edge-line');
    const d = line ? (line.getAttribute('d') || '') : '';
    const m = /M\s*([-\d.]+)\s+([-\d.]+)\s*L\s*([-\d.]+)\s+([-\d.]+)/.exec(d);
    if (!m) { edges.push({ bad: 'no path data' }); return; }
    const a = boxes[g.dataset.from], b = boxes[g.dataset.to];
    edges.push({
      gapFrom: a ? Math.round(gapTo(+m[1], +m[2], a) * 10) / 10 : null,
      gapTo: b ? Math.round(gapTo(+m[3], +m[4], b) * 10) / 10 : null,
      missing: (!a ? 'from' : '') + (!b ? ' to' : '')
    });
  });
  return JSON.stringify({ nodes: document.querySelectorAll('.flow-node').length, edges: edges });
})()`;

const SEED = `(() => {
  const nodes = [];
  const places = [[0.05,0.08],[0.62,0.05],[0.30,0.55],[0.80,0.62],[0.12,0.85],[0.55,0.90],[0.95,0.30],[0.45,0.35]];
  places.forEach((p, i) => nodes.push({ id: 'n' + i, fx: p[0], fy: p[1], label: 'Book ' + (i + 1) }));
  const edges = [];
  for (let i = 1; i < nodes.length; i++) edges.push({ from: nodes[i - 1].id, to: nodes[i].id });
  edges.push({ from: 'n0', to: 'n7' });
  edges.push({ from: 'n3', to: 'n6' });
  const lib = {
    folders: [{ id: 'f1', name: 'Reading Order', color: '#a3d3ff', createdAt: Date.now(), nodes: nodes, edges: edges, sections: [] }],
    books: [],
    settings: { fontSize: 18, fontFamily: 'Georgia, serif', lineHeight: '1.7', theme: 'light' }
  };
  localStorage.setItem('sailing-books-v1', JSON.stringify(lib));
  return nodes.length + ' nodes, ' + edges.length + ' edges';
})()`;

const OPEN_FOLDER = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const f = document.querySelector('.folder-card');
  if (!f) return 'no folder';
  f.click();
  await sleep(300);
  return 'clicked';
})()`;

async function run(win, code, label) {
  try {
    return await win.webContents.executeJavaScript(code);
  } catch (e) {
    say('  !! ' + label + ' threw: ' + e.message);
    return null;
  }
}
async function measure(win, label) {
  const raw = await run(win, MEASURE, label);
  if (raw == null) return { error: 'threw' };
  try { return JSON.parse(raw); } catch { return { error: 'unreadable: ' + String(raw).slice(0, 80) }; }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    // No preload: this is a pure rendering test, and the bridge only adds IPC
    // noise. The page boots from localStorage, which is where the chart lives.
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  say('  window created');
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2500));
  say('  page loaded');

  const seeded = await run(win, SEED, 'seed');
  say('  seeded: ' + seeded);
  if (!seeded) { say('  cannot seed, stopping'); app.exit(1); }

  await win.reload();
  await new Promise(r => setTimeout(r, 3500));
  say('  reloaded');

  const opened = await run(win, OPEN_FOLDER, 'open folder');
  say('  folder: ' + opened);

  const during = await measure(win, 'during');
  await new Promise(r => setTimeout(r, 1100));
  const settled = await measure(win, 'settled');
  win.setSize(1100, 800);
  await new Promise(r => setTimeout(r, 900));
  const resized = await measure(win, 'resized');
  win.setSize(1280, 900);
  await new Promise(r => setTimeout(r, 600));

  let worst = 0;
  const failures = [];
  say('');
  for (const pair of [['during animation', during], ['once settled', settled], ['after resize', resized]]) {
    const when = pair[0], snap = pair[1];
    if (!snap || snap.error) { say('   ' + when.padEnd(18) + (snap && snap.error ? snap.error : 'no data')); continue; }
    if (!snap.edges || !snap.edges.length) { say('   ' + when.padEnd(18) + 'no edges'); continue; }
    const broken = snap.edges.filter(e => e.bad || e.missing || e.gapFrom > 3 || e.gapTo > 3);
    for (const e of snap.edges) {
      if (typeof e.gapFrom === 'number' && e.gapFrom > worst) worst = e.gapFrom;
      if (typeof e.gapTo === 'number' && e.gapTo > worst) worst = e.gapTo;
    }
    say('   ' + when.padEnd(18) + snap.edges.length + ' edges  ' + (broken.length ? broken.length + ' DETACHED' : 'all attached'));
    if (broken.length) failures.push({ when, broken });
  }
  say('');
  say('  largest gap between a line end and its node: ' + Math.round(worst * 10) / 10 + 'px');
  say('');

  if (failures.length) {
    for (const f of failures) {
      say('   ' + f.when + ':');
      for (const e of f.broken.slice(0, 6)) {
        say('      ' + (e.bad ? 'no path data'
          : 'gapFrom=' + e.gapFrom + ' gapTo=' + e.gapTo + (e.missing ? '  missing:' + e.missing : '')));
      }
    }
    say('');
    say('  ' + failures.length + ' snapshot(s) with detached edges');
    say('');
    app.exit(1);
    return;   // app.exit is not immediate: stop before printing the verdict
  }
  say('  every line is attached to both of its nodes: during the animation,');
  say('  once it settles, and after a resize.');
  say('');
  app.exit(0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
