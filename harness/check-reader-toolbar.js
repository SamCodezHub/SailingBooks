/* The reader bar keeps only what belongs to reading a book right now.
 *
 * Typeface and line spacing were in the reader bar and in settings, which meant
 * two places to look for the same setting and two ways to end up disagreeing.
 * They live in settings now, so the bar is left with the text size and the two
 * buttons that are about the screen rather than the page - and settings has to
 * still reach the reader while it is open, which is the part worth checking.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

// A reader with somebody else's reading settings already in it proves nothing.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sb-reader-bar-')));

ipcMain.handle('get-cloud-session', () => null);
ipcMain.handle('save-cloud-session', () => true);
ipcMain.handle('list-library-files', () => []);
ipcMain.handle('save-library-index', () => true);

const BAR = `JSON.stringify((() => {
  const bar = document.getElementById('readerBar');
  const ctrls = document.getElementById('readerControls');
  const labels = el => el ? el.textContent.trim() : '';
  return {
    barUp: !!bar && bar.getClientRects().length > 0,
    buttons: [...bar.querySelectorAll('button')].map(labels),
    selects: [...bar.querySelectorAll('select')].map(s => s.id || s.title || s.textContent.trim()),
    size: labels(document.getElementById('fontSizeLabel')),
    gap: Math.round(bar.getBoundingClientRect().right - ctrls.getBoundingClientRect().right),
    barWidth: Math.round(bar.getBoundingClientRect().width),
    overflow: Math.round(ctrls.scrollWidth - ctrls.clientWidth)
  };
})())`;

const READER = `(() => {
  const c = document.getElementById('epubContent');
  const s = getComputedStyle(c);
  return { font: s.fontFamily, line: s.lineHeight, size: c.style.fontSize };
})()`;

const SETTINGS = `JSON.stringify({
  family: !!document.getElementById('setFontFamily'),
  spacing: !!document.getElementById('setLineHeight'),
  familyLabel: (document.getElementById('setFontFamily') || {}).options ? [...document.getElementById('setFontFamily').options].map(o => o.textContent) : [],
  spacingLabel: (document.getElementById('setLineHeight') || {}).options ? [...document.getElementById('setLineHeight').options].map(o => o.textContent.trim()) : []
})`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2200));
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('libraryView').classList.add('hidden');
    document.getElementById('readerView').classList.remove('hidden');
    document.getElementById('epubScroll').classList.remove('hidden');
    document.getElementById('epubContent').innerHTML = '<p>A paragraph of the book, so the reader has something to set.</p>';
    return 1;
  })()`);
  await new Promise(r => setTimeout(r, 400));

  say('\n  what is left on the bar\n');
  let bar = JSON.parse(await win.webContents.executeJavaScript(BAR));
  check(bar.barUp, 'the reader bar is on screen');
  check(bar.buttons.includes('A−') && bar.buttons.includes('A+'), 'the text size buttons are still there', bar.buttons.join(' '));
  check(/\d+px/.test(bar.size), 'with the size it is at', bar.size);
  check(bar.buttons.includes('Clean') && bar.buttons.includes('Full'), 'and Clean and Full', bar.buttons.join(' '));
  check(bar.selects.length === 0, 'no dropdowns are left on it', bar.selects.join(', ') || 'none');

  say('\n  and no overflow now that they are gone\n');
  check(bar.overflow <= 1, 'the controls fit the bar', bar.overflow + 'px over');
  await win.setSize(390, 844);
  await new Promise(r => setTimeout(r, 500));
  const phone = JSON.parse(await win.webContents.executeJavaScript(BAR));
  check(phone.overflow <= 1, 'on a phone-sized window too', phone.overflow + 'px over, bar ' + phone.barWidth + 'px');
  await win.setSize(1100, 900);
  await new Promise(r => setTimeout(r, 400));

  say('\n  settings is where those two live now\n');
  await win.webContents.executeJavaScript(`document.getElementById('btnSettings').click(); 1`);
  await new Promise(r => setTimeout(r, 500));
  const set = JSON.parse(await win.webContents.executeJavaScript(SETTINGS));
  check(set.family && set.familyLabel.length > 1, 'Typeface is in settings', set.familyLabel.join(', '));
  check(set.spacing && /snug|compact|comfort|relaxed/i.test(set.spacingLabel.join(' ')), 'and line spacing', set.spacingLabel.join(', '));
  await win.webContents.executeJavaScript(`document.getElementById('btnSettings').click(); 1`);
  await new Promise(r => setTimeout(r, 400));

  say('\n  and changing them there still changes the book in front of you\n');
  // Compare two settings rather than a remembered "before": what matters is that
  // the choice in settings reaches the page being read, from wherever it started.
  const setOption = (id, match) => `(() => {
    const el = document.getElementById('${id}');
    const want = [...el.options].find(o => ${match});
    if (!want) return 'no such option';
    el.value = want.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return want.textContent.trim();
  })()`;
  await win.webContents.executeJavaScript(setOption('setFontFamily', "/sans/i.test(o.textContent)"));
  await new Promise(r => setTimeout(r, 300));
  const sans = await win.webContents.executeJavaScript(READER);
  await win.webContents.executeJavaScript(setOption('setFontFamily', "/old style/i.test(o.textContent)"));
  await new Promise(r => setTimeout(r, 300));
  const oldStyle = await win.webContents.executeJavaScript(READER);
  check(sans.font !== oldStyle.font, 'the typeface reaches the reader', sans.font);
  check(/sans/i.test(sans.font), 'and is the one that was chosen', sans.font);

  await win.webContents.executeJavaScript(setOption('setLineHeight', "parseFloat(o.value) < 1.5"));
  await new Promise(r => setTimeout(r, 300));
  const tight = await win.webContents.executeJavaScript(READER);
  await win.webContents.executeJavaScript(setOption('setLineHeight', "parseFloat(o.value) > 2"));
  await new Promise(r => setTimeout(r, 300));
  const loose = await win.webContents.executeJavaScript(READER);
  check(parseFloat(loose.line) > parseFloat(tight.line), 'and so does the line spacing', tight.line + ' -> ' + loose.line);

  say('\n  the size buttons still work, though\n');
  const start = await win.webContents.executeJavaScript(READER);
  await win.webContents.executeJavaScript(`document.getElementById('btnFontInc').click(); 1`);
  await new Promise(r => setTimeout(r, 300));
  const bigger = await win.webContents.executeJavaScript(READER);
  await win.webContents.executeJavaScript(`document.getElementById('btnFontDec').click(); 1`);
  await new Promise(r => setTimeout(r, 300));
  const back = await win.webContents.executeJavaScript(READER);
  check(parseFloat(bigger.size) > parseFloat(start.size), 'A+ makes the text bigger', start.size + ' -> ' + bigger.size);
  check(parseFloat(back.size) === parseFloat(start.size), 'and A− puts it back', back.size);

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'the bar is about the book, the settings are about the page') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
