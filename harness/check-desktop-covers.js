/* The covers fix touched the desktop bridge too, so check that path as well:
   the app must still get a usable file:// URL for a cover, and must not be
   handed an API URL that means nothing on a local machine. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const UD = process.env.APPDATA || '';
const idx = path.join(UD, 'Sailing Books', 'library-index.json');

app.whenReady().then(async () => {
  // The real preload, so this exercises the same bridge the app uses.
  const win = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 3000));

  const idxData = JSON.parse(fs.readFileSync(idx, 'utf8'));
  const sample = idxData.books.slice(0, 3).map(b => ({ id: b.id, coverPath: b.coverPath, title: b.title }));

  const hasApi = await win.webContents.executeJavaScript('!!(window.api && window.api.coverUrl)');
  console.log('\n  preload bridge present: ' + hasApi);
  if (!hasApi) { console.log('  window.api.coverUrl is missing — the fix did not reach the app'); app.exit(1); }

  const out = await win.webContents.executeJavaScript(`(() => {
    const books = ${JSON.stringify(sample)};
    return books.map(b => ({
      title: b.title,
      hasCoverPath: !!b.coverPath,
      coverUrl: window.api.coverUrl ? window.api.coverUrl(b) : '(no coverUrl on the bridge)',
      fileUrl: window.api.fileUrl(b.coverPath)
    }));
  })()`);

  let bad = 0;
  console.log('\n  desktop cover bridge:');
  for (const r of out) {
    const isFile = /^file:\/\//i.test(r.coverUrl);
    const ok = isFile && r.coverUrl === r.fileUrl;
    if (!ok) bad++;
    console.log('   ' + (ok ? 'ok  ' : 'FAIL') + '  ' + String(r.title).slice(0, 34).padEnd(36) +
      (r.coverUrl || '(empty)').slice(0, 90));
  }
  const noCover = await win.webContents.executeJavaScript(
    `window.api.coverUrl({ id: 'x', title: 'no cover' }) === ''`);
  console.log('   ' + (noCover ? 'ok  ' : 'FAIL') + '  a book with no cover yields no URL');
  if (!noCover) bad++;

  console.log('\n  ' + (bad ? bad + ' problem(s)' : 'the desktop app still resolves covers to files on disk') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
