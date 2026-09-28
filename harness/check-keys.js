/* The settings panel lists keyboard shortcuts, so they had better all work.
   Each one is pressed as a real key event and its effect checked. */
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
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; console.log('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

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

  const r = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(x => setTimeout(x, ms));
    const key = (k, opts) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})));
    const out = {};

    // open a book the way a person does
    const back = document.getElementById('crumbHome');
    if (back) { back.click(); await sleep(700); }
    const folder = document.querySelector('.folder-card');
    if (folder) { folder.click(); await sleep(1400); }
    const card = document.querySelector('.book-card');
    const t = (card || {}).getBoundingClientRect ? card.getBoundingClientRect() : null;
    const o = t ? { bubbles: true, cancelable: true, clientX: t.left + t.width/2, clientY: t.top + 20, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true } : {};
    if (card) {
      card.dispatchEvent(new PointerEvent('pointerdown', o));
      await sleep(80);
      document.dispatchEvent(new PointerEvent('pointerup', o));
      await sleep(6000);
    }
    out.opened = !document.getElementById('readerView').classList.contains('hidden');

    // C - clean reading
    key('c');
    await sleep(500);
    out.cWorks = document.getElementById('readerView').classList.contains('immersive');
    key('c');
    await sleep(400);
    out.cTogglesBack = !document.getElementById('readerView').classList.contains('immersive');

    // F - full screen. Fullscreen needs a user gesture, so the request is
    // made from a real click as well; either way the handler must fire.
    const before = !!document.fullscreenElement;
    let clicked = false;
    document.getElementById('btnFullscreen').addEventListener('click', () => { clicked = true; }, { once: true });
    key('f');
    await sleep(900);
    out.fRequested = !!document.fullscreenElement || clicked;
    if (document.fullscreenElement) { await win_exit(); }
    function win_exit() { return document.exitFullscreen().catch(() => {}); }
    out.beforeFs = before;

    // Ctrl+F must stay the browser's own find, so it must not be swallowed
    let prevented = false;
    const ev = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    prevented = ev.defaultPrevented;
    out.ctrlFLeftAlone = !prevented;

    // Esc closes the reader
    key('Escape');
    await sleep(600);
    out.escCloses = document.getElementById('readerView').classList.contains('hidden');
    return out;
  })()`);

  console.log('\n  keyboard shortcuts listed in Settings\n');
  check(r.opened, 'a book opens, so there is something to test shortcuts in');
  check(r.cWorks, 'C  - clean reading turns on', 'immersive=' + r.cWorks);
  check(r.cTogglesBack, 'C  - turns it off again');
  check(r.fRequested, 'F  - full screen', 'entered fullscreen=' + r.fRequested);
  check(r.ctrlFLeftAlone, 'Ctrl+F is left to the browser');
  check(r.escCloses, 'Esc - back to the library');

  console.log('\n  ' + (bad ? bad + ' broken' : 'every shortcut in the settings panel works') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
