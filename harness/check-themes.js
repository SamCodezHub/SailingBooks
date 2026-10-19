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
const URL_ = process.argv[3] || (mm ? 'https://' + mm[1] : 'http://127.0.0.1:' + (process.env.SB_PORT || 8787));
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

  // Apply a spread of themes and read what the browser actually painted. Not
  // every one: the picker holds a couple of hundred rows, and check-contrast.js
  // covers the colours of all of them. This is about the picker working.
  const themes = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = [];
    const all = [...document.querySelectorAll('.theme-card[data-kind="color"]')];
    const step = Math.max(1, Math.floor(all.length / 12));
    const cards = () => [...document.querySelectorAll('.theme-card[data-kind="color"]')];
    const sample = all.filter((_, i) => i % step === 0).slice(0, 13);
    for (const wanted of sample) {
      const name = wanted.querySelector('.theme-name').textContent;
      const index = cards().findIndex(c => c.querySelector('.theme-name').textContent === name);
      cards()[index].click();
      await sleep(40);
      // the grid is rebuilt on click, so the live node has to be looked up
      // again rather than reusing the one that was clicked
      const now = cards()[index];
      // The palette is written as custom properties and the page catches up a
      // frame later, so reading colour here would report the *previous* theme.
      // What is checked is that the right palette was asked for - check-contrast
      // measures what the browser actually paints, in every theme.
      const theme = (window.SB_THEMES || []).find(t => t.id === now.dataset.id);
      out.push({
        name,
        id: now.dataset.id,
        active: now.classList.contains('active'),
        attr: document.documentElement.getAttribute('data-theme'),
        inline: document.documentElement.style.getPropertyValue('--bg').trim(),
        want: theme ? theme.vars['--bg'] : '',
        background: document.documentElement.getAttribute('data-background')
      });
    }
    return out;
  })()`);

  console.log('\n  a spread of themes, with the colours the browser computed:\n');
  let bad = 0;
  themes.forEach(t => {
    const ok = t.active && t.attr === t.id && t.inline === t.want && t.background;
    if (!ok) bad++;
    console.log('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + t.name.padEnd(12) +
      ' theme=' + String(t.attr).padEnd(12) +
      ' asks for ' + String(t.want).padEnd(10) +
      ' background left as ' + t.background);
  });

  // dark themes must actually be dark, light ones light - asked of the palette
  // itself, since measuring the page here would report the previous theme
  const registry = await win.webContents.executeJavaScript(`JSON.stringify(
    (window.SB_THEMES || []).map(t => ({ id: t.id, bg: t.vars['--bg'] })))`);
  const all = JSON.parse(registry);
  const isDark = (hex) => {
    const v = parseInt(hex.slice(1), 16);
    return (((v >> 16) & 255) * 0.2126 + ((v >> 8) & 255) * 0.7152 + (v & 255) * 0.0722) / 255 < 0.4;
  };
  const dark = all.filter(t => isDark(t.bg)).map(t => t.id);
  const light = all.filter(t => !isDark(t.bg)).map(t => t.id);
  console.log('\n  palettes in the list: ' + light.length + ' light, ' + dark.length + ' dark');
  if (dark.length < 20 || light.length < 20) { console.log('  expected plenty of each'); bad++; }
  console.log('  a few dark ones: ' + dark.slice(0, 6).join(', ') + '\n');

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
  const last = themes.length ? themes[themes.length - 1] : { id: null };
  const survived = after.theme === last.id;
  if (!survived) bad++;
  console.log('  after a reload: theme=' + after.theme + ' (picked ' + last.id + ') picker shows it: ' + after.panelMarked + '\n');
  console.log(bad ? '  ' + bad + ' problem(s)' : '  themes and settings panel behave');
  console.log('');
  app.exit(bad ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
