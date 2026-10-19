/* The app bar is the title bar, the way Chrome's tab strip is.
 *
 * Hiding the title bar takes away the window buttons with it, so they are handed
 * back by the platform over the right-hand end of the bar. That has three things
 * to get right, and none of them are visible in a screenshot: the bar has to be
 * the drag region or the window cannot be moved, everything clickable inside it
 * has to opt back out or it cannot be clicked, and the window buttons have to be
 * told which colour to be or they vanish into a dark theme.
 *
 * So this opens a real window with the same options the app uses, and asks the
 * page what it made of them.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sb-titlebar-')));

// Everything else the renderer asks for while it boots.
ipcMain.handle('get-cloud-session', () => null);
ipcMain.handle('save-cloud-session', () => true);
ipcMain.handle('list-library-files', () => []);
ipcMain.handle('save-library-index', () => true);
ipcMain.handle('get-library-dir', () => app.getPath('userData'));
ipcMain.handle('get-library-index', () => ({ books: [], folders: [] }));

const overlayCalls = [];
ipcMain.handle('set-title-bar-overlay', (_event, options) => { overlayCalls.push(options); return true; });

const REPORT = `JSON.stringify((() => {
  const q = s => document.querySelector(s);
  const region = el => el ? getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue('-webkit-app-region') : '';
  const bar = q('#topbar'), gear = q('#btnSettings'), search = q('#searchInput'), nav = q('#libraryNav');
  const r = bar.getBoundingClientRect();
  const g = gear.getBoundingClientRect();
  const reserve = parseFloat(getComputedStyle(bar).paddingRight) - 22;
  return {
    barTop: Math.round(r.top), barHeight: Math.round(r.height), barWidth: Math.round(r.width),
    windowWidth: window.innerWidth,
    reserve: Math.round(reserve),
    barRegion: region(bar),
    gearRegion: region(gear), searchRegion: region(search), navRegion: region(nav),
    brandRegion: region(q('.topbar-brand')),
    gearRight: Math.round(r.right - g.right),
    // is the gear clear of where the window buttons are drawn?
    gearClear: g.right <= r.right - reserve + 1,
    accountRight: Math.round(r.right - q('.account-group').getBoundingClientRect().right),
    wco: !!navigator.windowControlsOverlay,
    titlebarArea: getComputedStyle(document.documentElement).getPropertyValue('padding-top')
  };
})())`;

const READER = `(() => {
  document.getElementById('libraryView').classList.add('hidden');
  document.getElementById('readerView').classList.remove('hidden');
  document.getElementById('readerBar').style.display = 'flex';
  const bar = document.getElementById('readerBar');
  const cs = getComputedStyle(bar);
  const b = document.getElementById('btnClean').getBoundingClientRect();
  return {
    region: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
    reserve: Math.round(parseFloat(cs.paddingRight) - 20),
    height: Math.round(bar.getBoundingClientRect().height),
    clean: Math.round(b.right),
    width: Math.round(bar.getBoundingClientRect().width)
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 900, show: false,
    // exactly what the app asks for
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#1a1a1a', height: 62 },
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  // A window that was never shown answers nothing about layout.
  win.setPosition(-4000, 0);
  win.showInactive();
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1500));
  const r = JSON.parse(await win.webContents.executeJavaScript(REPORT));

  say('\n  the window keeps its buttons\n');
  check(r.wco, 'the platform has put its window controls over the page', 'widthControlsOverlay=' + r.wco);
  check(r.reserve > 60, 'and we have left room for them', r.reserve + 'px reserved of ' + r.windowWidth + 'px');
  check(r.barTop === 0, 'so the bar really is at the top of the window', 'top ' + r.barTop + 'px');
  check(r.barHeight > 0 && r.barHeight <= 70, 'and it is a bar, not a title bar above one', r.barHeight + 'px tall');

  say('\n  the window can still be moved\n');
  check(r.barRegion === 'drag', 'the bar is the drag region', r.barRegion || 'none');
  check(r.brandRegion !== 'no-drag', 'and the empty space on it is not carved out of it', r.brandRegion || 'inherits the bar');

  say('\n  and everything on it still works\n');
  check(r.searchRegion === 'no-drag', 'the search box can be clicked and typed into', r.searchRegion || 'none');
  check(r.gearRegion === 'no-drag', 'the gear can be clicked', r.gearRegion || 'none');
  check(r.navRegion === 'no-drag', 'the library tabs can be clicked', r.navRegion || 'none');
  check(r.gearClear, 'the gear is clear of the window buttons', 'gear ' + r.gearRight + 'px from the edge, ' + r.reserve + 'px reserved');
  check(r.accountRight >= 0, 'and the account and its badge are on screen', r.accountRight + 'px from the edge');

  say('\n  the window buttons are told what colour to be\n');
  const light = overlayCalls.filter(c => c && c.symbolColor).pop();
  check(!!light, 'the theme told Windows a symbol colour', light ? light.symbolColor : 'never asked');
  await win.webContents.executeJavaScript(`window.SB_ui.applyTheme('midnight'); 1`);
  await new Promise(r2 => setTimeout(r2, 600));
  const dark = overlayCalls.filter(c => c && c.symbolColor).pop();
  check(!!dark && dark.symbolColor !== light.symbolColor, 'and it changes with the theme',
    (light && light.symbolColor) + ' -> ' + (dark && dark.symbolColor));

  say('\n  the reader bar does the same\n');
  const reader = await win.webContents.executeJavaScript(READER);
  check(reader.region === 'drag', 'it is a drag region too', reader.region || 'none');
  check(reader.reserve > 60, 'with the same room kept for the window buttons', reader.reserve + 'px');
  check(reader.height >= 56, 'and it is tall enough to line up with the bar above', reader.height + 'px');
  check(reader.clean <= reader.width - reader.reserve + 1, 'so Clean is not underneath them', 'clean ends ' + reader.clean + ' of ' + reader.width);

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'one bar, the window still has its buttons, and everything on the bar still works') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
