/* The settings panel has to work on a phone as well as the laptop, and the
   desktop app has to get the same themes. Both are checked here: a phone-sized
   window against the web address, and a window with the real preload. */
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
app.disableHardwareAcceleration();
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; console.log('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

const signIn = (win) => win.webContents.executeJavaScript(`(async () => {
  const p = document.getElementById('loginPass');
  if (!p) return 'no gate';
  p.value = ${JSON.stringify(PASSWORD)};
  document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 5000));
  return 'ok';
})()`);

app.whenReady().then(async () => {
  /* ---------- the phone ---------- */
  if (URL_) {
    console.log('\n  phone-sized window against the web address\n');
    const win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { backgroundThrottling: false } });
    await win.loadURL(URL_);
    await new Promise(r => setTimeout(r, 1200));
    await signIn(win);
    const r = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(x => setTimeout(x, ms));
      document.getElementById('btnSettings').click();
      await sleep(300);
      const p = document.getElementById('settingsPanel');
      const box = p.getBoundingClientRect();
      const cards = [...document.querySelectorAll('#themeColorGrid .theme-card, #themeBgGrid .theme-card')];
      const rect = cards[0] ? cards[0].getBoundingClientRect() : { width: 0, height: 0 };
      // measure before tapping: tapping rebuilds the grid, so the node measured
      // afterwards would be a detached one reporting a zero rect
      const size = { w: Math.round(rect.width), h: Math.round(rect.height) };
      // start from a known theme so "it repainted" means something
      const light = cards.find(c => c.textContent.includes('Light'));
      if (light) { light.click(); await sleep(250); }
      // Which theme the page has adopted is what this can see honestly: a window
      // that was never shown does not recalculate, so reading its colours back
      // reports the previous theme. check-contrast.js measures what is actually
      // painted, in all 243 of them, against a window that does paint.
      const before = document.documentElement.getAttribute('data-theme');
      const dark = [...document.querySelectorAll('#themeColorGrid .theme-card, #themeBgGrid .theme-card')].find(c => c.textContent.includes('Dusk'));
      if (dark) dark.click();
      await sleep(300);
      return {
        opensOnTap: !p.classList.contains('hidden'),
        fullWidth: Math.round(box.width) >= window.innerWidth - 1,
        cardCount: cards.length,
        cardSize: size.w,
        // a row in a list rather than a card: it has to be wide enough to read
        // and tall enough to tap with a thumb
        cardTallEnough: size.w >= 240 && size.h >= 30,
        themeNow: document.documentElement.getAttribute('data-theme'),
        changed: document.documentElement.getAttribute('data-theme') !== before,
        before,
        now: document.documentElement.getAttribute('data-theme'),
        themeColor: (document.querySelector('meta[name=theme-color]') || {}).content
      };
    })()`);
    check(r.opensOnTap, 'the settings panel opens by tapping the gear');
    check(r.fullWidth, 'it fills the phone screen', r.fullWidth ? '' : 'not full width');
    check(r.cardCount > 100, 'the whole list of themes and backgrounds is on the phone', r.cardCount + ' rows, grid ' + r.gridWidth + 'px');
    check(r.cardTallEnough, 'each row is big enough to tap', r.cardSize + 'px wide');
    check(r.changed, 'tapping a theme repaints the app', r.before + ' -> ' + r.now);
    check(/19|25|38/.test(r.themeColor || ''), 'the browser chrome follows the theme', 'theme-color=' + r.themeColor);

    // escape closes it
    const closed = await win.webContents.executeJavaScript(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return document.getElementById('settingsPanel').classList.contains('hidden');
    })()`);
    check(closed, 'Escape closes the settings panel');
  }

  /* ---------- the desktop app ---------- */
  console.log('\n  desktop app, with the real preload\n');
  const win2 = new BrowserWindow({
    show: false, width: 1200, height: 860,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await win2.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const d = await win2.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(x => setTimeout(x, ms));
    document.getElementById('btnSettings').click();
    await sleep(250);
    const cards = document.querySelectorAll('#themeColorGrid .theme-card, #themeBgGrid .theme-card').length;
    const ocean = [...document.querySelectorAll('#themeColorGrid .theme-card, #themeBgGrid .theme-card')].find(c => c.textContent.includes('Ocean'));
    ocean.click();
    await sleep(400);
    // The palette is written as custom properties on the document, and the page
    // only catches up when it recalculates. Reading in the same breath reports
    // the theme that was on before.
    void document.body.offsetHeight;
    await new Promise(r => requestAnimationFrame(r));
    return {
      cards,
      opens: !document.getElementById('settingsPanel').classList.contains('hidden'),
      theme: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
      stored: (() => { try { return JSON.parse(localStorage.getItem('sailing-books-v1') || '{}').settings?.theme; } catch { return null; } })(),
      gearRight: Math.round(document.getElementById('btnSettings').getBoundingClientRect().right)
    };
  })()`);
  check(d.cards > 100, 'the whole list in the app too', d.cards + ' rows');
  check(d.opens, 'the panel opens in the app');
  check(d.theme === 'ocean', 'a theme applies in the app', d.theme);
  check(/^rgb\(7, 34, 43\)$/.test(d.bg), 'the app repaints', d.bg);
  check(d.stored === 'ocean', 'the app remembers it', 'stored=' + d.stored);
  check(d.gearRight > 1000, 'the gear sits in the corner, search stays centred', 'right edge ' + d.gearRight);

  // The plan badge sits next to the name, and the gear is pinned to the edge.
  // Nothing in between may land on top of the gear, which is what happened when
  // the badge was added outside the gap the account button reserved for it.
  const bar = JSON.parse(await win2.webContents.executeJavaScript(`(() => {
    const box = id => { const b = document.getElementById(id).getBoundingClientRect();
      return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
    const pill = document.getElementById('accountPlanPill');
    pill.textContent = 'Free';
    pill.classList.remove('hidden');
    const shown = { pill: box('accountPlanPill'), name: box('btnAccount'), gear: box('btnSettings'), on: getComputedStyle(pill).display !== 'none' };
    pill.classList.add('hidden');
    pill.textContent = '';
    return JSON.stringify({ shown, off: { name: box('btnAccount'), gear: box('btnSettings') } });
  })()`));
  const s = bar.shown;
  check(s.on, 'the plan badge shows beside the name', 'w=' + s.pill.w);
  check(s.pill.l >= s.name.r, 'and it does not sit on top of the name',
    'name ends ' + s.name.r + ', badge starts ' + s.pill.l);
  check(s.pill.r <= s.gear.l, 'nor on top of the settings gear',
    'badge ends ' + s.pill.r + ', gear starts ' + s.gear.l);
  check(bar.off.name.r <= bar.off.gear.l, 'and the name alone stays clear of the gear either way',
    'name ends ' + bar.off.name.r + ', gear starts ' + bar.off.gear.l);

  console.log('\n  ' + (bad ? bad + ' problem(s)' : 'settings and themes work in both') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
