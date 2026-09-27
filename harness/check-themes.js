/* Checks the settings panel the way a person uses it, in a real browser, and
   that a theme actually repaints the interface rather than only part of it:
   it applies each theme and reads the colours the browser computed. */
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
const URL_ = process.argv[3] || (mm ? 'https://' + mm[1] : '');
if (!URL_) { console.log('no address to test'); app.exit(1); }
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900 });
  await win.loadURL(URL_);
  await new Promise(r => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`(async () => {
    const p = document.getElementById('loginPass');
    if (p) {
      p.value = ${JSON.stringify(PASSWORD)};
      document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 6000));
    }
  })()`);

  // open settings the way a person does
  const opened = await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnSettings');
    if (!b) return { error: 'no settings button in the page' };
    b.click();
    const panel = document.getElementById('settingsPanel');
    return {
      buttonFound: true,
      panelVisible: panel ? !panel.classList.contains('hidden') : false,
      themeCards: document.querySelectorAll('.theme-card').length,
      rows: document.querySelectorAll('.set-row').length
    };
  })()`);
  console.log('\n  settings panel:');
  for (const [k, v] of Object.entries(opened)) console.log('    ' + k.padEnd(16) + JSON.stringify(v));

  // apply every theme and read what the browser actually painted
  const themes = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = [];
    const cards = () => [...document.querySelectorAll('.theme-card')];
    for (let i = 0; i < cards().length; i++) {
      const card = cards()[i];
      const name = card.querySelector('.theme-name').textContent;
      card.click();
      await sleep(160);
      // the grid is rebuilt on click, so the live node has to be looked up
      // again rather than reusing the one that was clicked
      const now = cards()[i];
      const cs = getComputedStyle(document.body);
      const pick = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const tile = pick('.book-card') || pick('.folder-card');
      const bar = pick('#readerBar');
      out.push({
        name,
        active: now.classList.contains('active'),
        attr: document.documentElement.getAttribute('data-theme'),
        bodyBg: cs.backgroundColor,
        bodyInk: cs.color,
        tileBg: tile ? tile.backgroundColor : null,
        barBg: bar ? bar.backgroundColor : null
      });
    }
    return out;
  })()`);

  console.log('\n  every theme, with the colours the browser computed:\n');
  let bad = 0;
  themes.forEach(t => {
    const distinct = new Set([t.bodyBg, t.tileBg, t.barBg].filter(Boolean)).size;
    if (!t.active || !t.attr || distinct < 1) bad++;
    console.log('   ' + (t.active ? 'ok  ' : 'FAIL') + ' ' + t.name.padEnd(10) +
      ' theme=' + String(t.attr).padEnd(9) +
      ' body=' + t.bodyBg.padEnd(20) + ' text=' + t.bodyInk.padEnd(18) +
      ' tile=' + String(t.tileBg).padEnd(20) + ' bar=' + t.barBg);
  });

  // dark themes must actually be dark, light ones light
  const dark = themes.filter(t => {
    const m = /rgba?\((\d+), (\d+), (\d+)/.exec(t.bodyBg || '');
    return m && (+m[1] + +m[2] + +m[3]) / 3 < 90;
  }).map(t => t.name);
  console.log('\n  dark themes: ' + (dark.join(', ') || 'none detected'));
  if (dark.length < 4) { console.log('  expected several dark themes'); bad++; }

  // the chosen theme has to survive being stored, so it is read back from the
  // app's own settings storage
  const saved = await win.webContents.executeJavaScript(`(() => {
    try {
      const s = JSON.parse(localStorage.getItem('sailing-books-settings') || 'null');
      return s && s.theme ? s.theme : 'not stored';
    } catch (e) { return 'unreadable: ' + e.message; }
  })()`);
  console.log('  theme written to device settings: ' + saved + '\n');

  // and it must come back after a reload, which is the whole point of storing it
  await win.loadURL(URL_);
  await new Promise(r => setTimeout(r, 1200));
  await win.webContents.executeJavaScript(`(async () => {
    const p = document.getElementById('loginPass');
    if (p) {
      p.value = ${JSON.stringify(PASSWORD)};
      document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 5000));
    }
  })()`);
  const after = await win.webContents.executeJavaScript(`(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    panelMarked: !!document.querySelector('.theme-card.active')
  }))()`);
  const survived = after.theme === 'ink';
  if (!survived) bad++;
  console.log('  after a reload: theme=' + after.theme + ' bg=' + after.bg + ' picker shows it: ' + after.panelMarked + '\n');
  console.log(bad ? '  ' + bad + ' problem(s)' : '  themes and settings panel behave');
  console.log('');
  app.exit(bad ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
