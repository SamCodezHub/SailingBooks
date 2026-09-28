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
const URL_ = mm ? 'https://' + mm[1] : '';
if (!URL_) { console.log('no address to test'); app.exit(1); }
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900 });
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
    const names = ['Light','Paper','Solar','Mono','Midnight','Dusk','Ocean','Forest','Ink'];
    for (const name of names) {
      document.getElementById('btnSettings').click();
      await sleep(120);
      const card = [...document.querySelectorAll('.theme-card')].find(c => c.textContent.includes(name));
      if (card) card.click();
      await sleep(150);
      document.getElementById('settingsPanel').classList.add('hidden');
      await sleep(80);

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
      out.push({ name, rows });
    }
    return out;
  })()`);

  // 3.0 is the floor for large text and interface chrome; body copy should do
  // better than that, so small text is held to 4.5
  const LARGE = new Set(['book title', 'folder name', 'theme name']);
  let bad = 0;
  console.log('\n  contrast of every piece of text, per theme (WCAG ratio)\n');
  for (const t of report) {
    const fails = t.rows.filter(r => r.missing || r.noColor || r.r < (LARGE.has(r.label) ? 3 : 4.5));
    const worst = t.rows.filter(r => r.r).sort((a, b) => a.r - b.r)[0];
    console.log('  ' + (fails.length ? 'FAIL ' : 'ok   ') + t.name.padEnd(9) +
      (worst ? 'worst: ' + worst.label + ' ' + worst.r : ''));
    for (const f of fails) {
      bad++;
      console.log('         ' + f.label + ': ' + (f.missing ? 'not on the page' : f.noColor ? 'no colour' :
        f.r + '  ' + f.fg + ' on ' + f.bg));
    }
  }

  console.log('\n  ' + (bad ? bad + ' unreadable combination(s)' : 'every piece of text is readable in every theme') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
