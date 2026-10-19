/* Contrast is the thing a dark theme quietly breaks: a <select> or a button
   keeps the browser's own black text and simply disappears. Rather than eyeball
   nine themes, this walks the real interface in a real browser, in every theme,
   and computes the WCAG contrast ratio of each piece of text against what it
   actually sits on. */
const { app, BrowserWindow } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PASSWORD = process.argv[2] || '';
const tsExe = (() => {
  if (process.platform !== 'win32') return 'tailscale';
  for (const d of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!d) continue;
    const p = path.join(d, 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tailscale';
})();
const bare = (s) => String(s).replace(/\x1b\[[0-9;;]*[A-Za-z]/g, '');
const st = spawnSync(tsExe, ['funnel', 'status'], { encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL' });
const mm = /https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net)/i.exec(bare((st.stdout || '') + (st.stderr || '')));
const URL_ = mm ? 'https://' + mm[1] : 'http://127.0.0.1:' + (process.env.SB_PORT || 8787);
if (!URL_) { console.log('no address to test'); app.exit(1); }
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
  show: false, width: 1280, height: 900,
  // A hidden window has its animation frames throttled to a crawl, and the
  // measurement waits for a frame after every theme. Without this, walking a
  // couple of hundred themes takes half an hour.
  webPreferences: { backgroundThrottling: false }
});
  await win.loadURL(URL_);
  await new Promise(r => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`(async () => {
    const p = document.getElementById('loginPass');
    if (p) { p.value = ${JSON.stringify(PASSWORD)};
      document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 6000)); }
  })()`);

  const report = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // measure the real book tiles, so the text people actually read is covered
    const back = document.getElementById('crumbHome');
    if (back) { back.click(); await sleep(800); }
    const folder = document.querySelector('.folder-card');
    if (folder) { folder.click(); await sleep(1500); }
    // The interface crossfades between themes. Measuring colour while that is in
    // flight pairs one theme's text with another theme's background, which reads
    // as unreadable and is not. Animations off, so the measurement is of colours
    // rather than of timing.
    const kill = document.createElement('style');
    kill.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    document.head.appendChild(kill);
    await sleep(120);

    // WCAG relative luminance + contrast ratio
    const parse = (c) => {
      const m = /rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?/.exec(c || '');
      if (!m) return null;
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    };
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1
    });
    const ratio = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    // what is actually behind an element, walking up until something opaque
    const bgOf = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.85) return c;
        n = n.parentElement;
      }
      return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    };
    const textOf = (el) => {
      const c = parse(getComputedStyle(el).color);
      if (!c) return null;
      return c.a < 1 ? over(c, bgOf(el)) : c;
    };

    const TARGETS = [
      ['book title', '.book-title'],
      ['book author', '.book-sub'],
      ['folder name', '.folder-name'],
      ['search box', '#searchInput'],
      ['section title', '.section-title'],
      ['reader dropdowns', '#readerControls select'],
      ['reader button', '#btnClean'],
      ['font size label', '#fontSizeLabel'],
      ['settings row', '.set-row'],
      ['theme name', '.theme-name'],
      ['hint text', '#libHint'],
      ['breadcrumb', '#breadcrumb'],
      ['modal input', '#modalInput']
    ];

    const out = [];
    // Every colour there is, not a chosen nine. The palettes are applied through
    // the app's own function rather than by clicking a row, so a couple of
    // hundred themes can be measured in a sensible time.
    const names = (window.SB_ui?.themes || []).map(t => t.name);
    for (const name of names) {
      // switch by applying the palette rather than by clicking a card: one source
      // of truth, no dependence on the picker's own re-render
      const theme = (window.SB_ui?.themes || []).find(t => t.name === name);
      window.SB_ui?.applyTheme(theme.id);
      document.getElementById('settingsPanel') && document.getElementById('settingsPanel').classList.add('hidden');
      // The palette is written straight onto the document as custom properties,
      // and the page does not recalculate until it is asked to. Reading in the
      // same breath as writing gets the *previous* theme's background, which made
      // every dark theme look like it was light text on white - and that passed.
      void document.body.offsetHeight;
      await new Promise(r => requestAnimationFrame(r));

      const rows = [];
      for (const [label, sel] of TARGETS) {
        let el = null;
        try { el = document.querySelector(sel); } catch {}
        if (!el) { rows.push({ label, missing: true }); continue; }
        const t = textOf(el);
        if (!t) { rows.push({ label, noColor: true }); continue; }
        const bg = bgOf(el);
        const r = ratio(t, bg);
        rows.push({ label, r: Math.round(r * 100) / 100, fg: getComputedStyle(el).color, bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')' });
      }
      out.push({ name, rows, bodyBg: getComputedStyle(document.body).backgroundColor });
    }
    return out;
  })()`);

  // 3.0 is the floor for large text and interface chrome; body copy should do
  // better than that, so small text is held to 4.5
  const LARGE = new Set(['book title', 'folder name', 'theme name']);
  let bad = 0;
  const failures = [];
  let worstOverall = null;
  for (const t of report) {
    const fails = t.rows.filter(r => r.missing || r.noColor || r.r < (LARGE.has(r.label) ? 3 : 4.5));
    const worst = t.rows.filter(r => r.r).sort((a, b) => a.r - b.r)[0];
    if (worst && (!worstOverall || worst.r < worstOverall.r)) worstOverall = { name: t.name, ...worst };
    for (const f of fails) failures.push({ theme: t.name, ...f });
    bad += fails.length;
  }
  console.log('\n  contrast of every piece of text, in every theme (WCAG ratio)\n');
  console.log('    themes measured : ' + report.length);
  console.log('    pieces measured : ' + report.reduce((n, t) => n + t.rows.length, 0));
  const dirty = new Set(failures.map(f => f.theme)).size;
  console.log('    thin text       : ' + (report.length - dirty) + ' themes clear of it, ' + dirty + ' with something unreadable');
  if (worstOverall) console.log('    thinnest pair   : ' + worstOverall.name + ' - ' + worstOverall.label + ' ' + worstOverall.r);
  if (failures.length) {
    console.log('\n  what could not be read:\n');
    for (const f of failures.slice(0, 25)) {
      console.log('    ' + (f.theme + ' / ' + f.label).padEnd(34) +
        (f.missing ? 'not on the page' : f.noColor ? 'no colour' : f.r + '  ' + f.fg + ' on ' + f.bg));
    }
    if (failures.length > 25) console.log('    ... and ' + (failures.length - 25) + ' more');
  }

  console.log('\n  ' + (bad ? bad + ' unreadable combination(s)' : 'every piece of text is readable in every theme') + '\n');

  /* A measurement that never left white would call every dark theme perfect -
   * light text on white is a huge ratio - so the backgrounds themselves are
   * checked for both kinds. This is the check that would have caught it. */
  const lum = (c) => {
    const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c || '');
    if (!m) return null;
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
  };
  const shades = report.map(t => ({ name: t.name, l: lum(t.bodyBg) })).filter(x => x.l !== null);
  const dark = shades.filter(x => x.l < 0.3), light = shades.filter(x => x.l > 0.6);
  console.log('  backgrounds actually measured: ' + dark.length + ' dark, ' + light.length + ' light' +
    (dark.length && light.length ? '' : '   <- this measurement is not looking at the themes') + '\n');
  app.exit(bad || !dark.length || !light.length ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
