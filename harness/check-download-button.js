/* The Download button on the online shelf.
 *
 * The server side is checked in check-download-to-library.js. This is the button
 * itself: that it offers Download and Remove and no longer offers the local-copy
 * request that never worked, that Download hands the book to the local library
 * rather than saving a stray file, and that the desktop app keeps its own Local
 * Library.
 *
 * The account service is stood in for, and the session starts empty, so the app
 * signs in through its own form rather than talking to the real service. The app
 * points at production when it runs from a file, so letting it ask would be both
 * slow and rude.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

// A throwaway folder to stand in for the real library, and a record of every
// save the page asks for. The handler below stands in for the desktop one in
// main.js, duplicate check included - the button's half of that contract is what
// this file is about, and the server's is checked in check-download-to-library.js.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-download-button-'));
const indexFile = path.join(tempDir, 'library-index.json');
const saves = [];
const readIndex = () => { try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return { books: [] }; } };
ipcMain.handle('get-cloud-session', () => null);
ipcMain.handle('save-cloud-session', () => true);
ipcMain.handle('save-cloud-book', (_event, { fileName, bytes, cloudBookId }) => {
  if (cloudBookId) {
    const prior = readIndex().books.find(b => b.cloudBookId === cloudBookId && fs.existsSync(b.storedPath));
    if (prior) return { alreadyAdded: true, fileName: prior.fileName, storedPath: prior.storedPath, size: fs.statSync(prior.storedPath).size };
  }
  saves.push({ fileName, cloudBookId, size: bytes.length });
  const storedPath = path.join(tempDir, fileName);
  fs.writeFileSync(storedPath, Buffer.from(bytes));
  const index = readIndex();
  fs.writeFileSync(indexFile, JSON.stringify({ books: [...index.books, { fileName, storedPath, cloudBookId }] }));
  return { fileName, storedPath, size: bytes.length, ...(cloudBookId ? { cloudBookId } : {}) };
});
ipcMain.handle('list-library-files', () => []);
ipcMain.handle('save-library-index', () => true);

const BOOK = { id: 'cloud-9', file_name: 'Cloud Book.epub', title: 'Cloud Book', author: 'A Writer', book_type: 'epub', size_bytes: 21 };

// The account service, stood in for. 21 bytes stands in for a whole book.
const STUB = `(() => {
  const book = ${JSON.stringify(BOOK)};
  const bytes = new Uint8Array(21).fill(7);
  const json = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  window.fetch = (url, options = {}) => {
    const u = String(url);
    if (/\\/config$/.test(u)) return json({ configured: true, serviceReady: true, url: 'https://stub.supabase.co', anonKey: 'anon' });
    if (/\\/auth\\/v1\\/token/.test(u)) return json({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
    if (/\\/auth\\/v1\\/user$/.test(u)) {
      if ((options.method || 'GET') === 'PUT') return json({ user_metadata: { plan: 'free' } });
      return json({ id: 'u1', email: 'samruddhc@example.com', user_metadata: {} });
    }
    if (/\\/me$/.test(u)) return json({ user: { email: 'samruddhc@example.com' }, usedBytes: 0, quotaBytes: 1073741824, plan: 'free' });
    if (/\\/books$/.test(u)) return json({ books: [book] });
    if (/\\/servers$/.test(u)) return json({ servers: [] });
    if (/\\/books\\/[^/]+\\/file$/.test(u)) return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes.buffer) });
    return json({});
  };
  return 'stubbed';
})()`;

const REPORT = `JSON.stringify((() => {
  const card = document.querySelector('.online-book-card');
  const actions = card ? [...card.querySelectorAll('.online-book-actions button')].map(b => b.textContent.trim()) : [];
  const shown = id => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); };
  return {
    actions,
    nav: [...document.querySelectorAll('#libraryNav .nav-tab')].map(b => b.textContent.trim()),
    onlineUp: shown('onlineLibraryView'),
    localUp: shown('libraryView'),
    localTabUp: shown('navLocalLibrary'),
    gateUp: shown('cloudPlanContinue'),
    status: (document.getElementById('cloudUploadStatus') || {}).textContent || '',
    pages: ['cloudLanding', 'onlineLibraryView', 'libraryView']
      .map(id => id.replace('View', '').replace('cloud', '') + '=' + (shown(id) ? 'SHOWN' : 'hidden')).join(' ')
  };
})())`;

// Poll until the page looks like this, so the test is not racing the app.
async function waitFor(win, predicate, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
    if (predicate(r)) return r;
    await new Promise(x => setTimeout(x, 250));
  }
  return JSON.parse(await win.webContents.executeJavaScript(REPORT));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2500));
  await win.webContents.executeJavaScript(STUB);

  // Sign in the way a person does: account button, then the form.
  await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnAccount');
    if (b && /sign in/i.test(b.textContent)) b.click();
    return 'opened';
  })()`);
  let r = await waitFor(win, s => s.gateUp === false && /landing/.test(s.pages));
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('cloudEmail').value = 'samruddhc@example.com';
    document.getElementById('cloudPassword').value = 'correct horse battery';
    document.getElementById('cloudAuthForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 'submitted';
  })()`);
  r = await waitFor(win, s => s.gateUp === true);

  say('\n  signing in, then choosing a plan\n');
  check(r.gateUp === true, 'a new account is asked for its plan before the library opens', r.pages);
  await win.webContents.executeJavaScript(`(() => { document.getElementById('cloudPlanContinue').click(); return 'continued'; })()`);
  r = await waitFor(win, s => s.onlineUp === true && s.actions.length > 0);

  say('\n  what the book offers\n');
  check(r.onlineUp === true, 'the online shelf is on show', r.pages);
  check(r.actions.includes('Download'), 'Download is there', r.actions.join(', '));
  check(r.actions.includes('Remove'), 'Remove is there', r.actions.join(', '));
  check(!r.actions.some(a => /local copy/i.test(a)), 'and the local-copy request that never worked is gone', r.actions.join(', '));

  say('\n  the desktop app keeps its own library\n');
  check(r.localTabUp === true, 'the Local Library tab is still there in the app', 'hidden=' + r.localTabUp);
  check(r.nav.includes('Local Library') && r.nav.includes('Online Library'), 'with both places to go', r.nav.join(' | '));

  say('\n  pressing Download\n');
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.online-book-card [data-action="download"]').click(); return 'clicked'; })()`);
  for (let i = 0; i < 40 && !saves.length; i++) await new Promise(x => setTimeout(x, 150));
  await new Promise(x => setTimeout(x, 700));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(saves.length === 1, 'the book was handed to the library exactly once', saves.length + ' saves');
  check(saves[0] && saves[0].fileName === BOOK.file_name, 'with the name it has in the cloud', saves[0] && saves[0].fileName);
  check(saves[0] && saves[0].cloudBookId === BOOK.id, 'and the cloud id, so a second press cannot double it', saves[0] && saves[0].cloudBookId);
  check(saves[0] && saves[0].size === 21, 'with all its bytes', saves[0] && saves[0].size + ' bytes');
  check(fs.readdirSync(tempDir).includes(BOOK.file_name), 'and the file really landed in the library folder', fs.readdirSync(tempDir).join(', '));
  check(/now in your local library/i.test(r.status), 'and it says so', r.status);
  check(r.localUp === true, 'and the app shows you its library', r.pages);

  say('\n  pressing Download again\n');
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.online-book-card [data-action="download"]').click(); return 'clicked'; })()`);
  await new Promise(x => setTimeout(x, 1500));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(/already in your local library/i.test(r.status), 'the second press is told it is already there', r.status);

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'Download puts the book in the library, and only in the library') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });