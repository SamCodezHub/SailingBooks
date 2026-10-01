/* Checks the new "Move to online library" action on a book's right-click menu.
 *
 * The real upload needs a signed-in online account, which this does not touch.
 * Instead the bridge the cloud client publishes is replaced with a recording
 * stub, so what is verified is the part that was written here: that the action
 * appears where it should, that it hands over the right file, that it refuses
 * without a session, that it never deletes anything on its own, and that a book
 * already online is not offered the action again. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fss = require('fs');
const say = (...a) => fss.writeSync(1, a.join(' ') + '\n');

let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

const SEED = `(() => {
  const lib = {
    folders: [],
    books: [
      { id: 'b1', title: 'Local Only', author: 'A', type: 'epub', fileName: 'local-only.epub',
        storedPath: 'C:/books/local-only.epub', fileSize: 3 * 1024 * 1024, addedAt: Date.now(), progress: 0 },
      { id: 'b2', title: 'Huge Audiobook', author: 'B', type: 'audio', fileName: 'huge.m4b',
        storedPath: 'C:/books/huge.m4b', fileSize: 1500 * 1024 * 1024, addedAt: Date.now(), progress: 0 },
      { id: 'b3', title: 'Server Book', author: 'C', type: 'epub', fileName: 'remote.epub',
        storedPath: 'id:b3', fileSize: 1024, addedAt: Date.now(), progress: 0 }
    ],
    settings: { fontSize: 18, fontFamily: 'Georgia, serif', lineHeight: '1.7', theme: 'light' }
  };
  localStorage.setItem('sailing-books-v1', JSON.stringify(lib));
  return lib.books.length;
})()`;

// Records what the menu handed over, and stands in for the signed-in session.
const STUB = `(() => {
  window.__calls = [];
  window.__deletes = 0;
  window.__confirmAnswer = true;
  const realConfirm = window.confirm;
  window.confirm = (msg) => { window.__confirmMsgs = window.__confirmMsgs || []; window.__confirmMsgs.push(msg); return window.__confirmAnswer; };
  window.__realConfirm = realConfirm;
  window.__signedIn = true;
  window.__online = [];
  window.sbOnlineLibrary = {
    signedIn: () => window.__signedIn,
    onlineBooks: () => window.__online,
    uploadLocalFile: async (p, n) => {
      window.__calls.push({ path: p, name: n });
      window.__online.push({ id: 'up1', fileName: n });
      return true;
    }
  };
  return 'stubbed';
})()`;

// Open a book's menu and report its labels. Books with no folder render as
// .book-tile on the shelf; books inside a folder render as .book-card.
const MENU = (title) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const wanted = ${JSON.stringify(title)};
  let card = [...document.querySelectorAll('.book-card, .book-tile')].find(c => {
    const t = c.querySelector('.book-title, .shelf-title');
    return t && t.textContent === wanted;
  });
  if (!card) return JSON.stringify({ error: 'no card for ' + wanted,
    seen: [...document.querySelectorAll('.book-card, .book-tile')].map(c => {
      const t = c.querySelector('.book-title, .shelf-title'); return t ? t.textContent : '?'; }) });
  const r = card.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20, button: 2, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  card.dispatchEvent(new PointerEvent('pointerdown', o));
  document.dispatchEvent(new PointerEvent('pointerup', o));
  await sleep(120);
  // right-click is the reliable route to the menu on a tile
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));
  await sleep(250);
  const menu = document.getElementById('contextMenu');
  const labels = [...menu.querySelectorAll('.ctx-item')].map(e => e.textContent);
  return JSON.stringify({ open: !menu.classList.contains('hidden'), labels });
})()`;

const CLICK_ITEM = (label) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const menu = document.getElementById('contextMenu');
  const item = [...menu.querySelectorAll('.ctx-item')].find(e => e.textContent === ${JSON.stringify(label)});
  if (!item) return 'no such item';
  item.click();
  await sleep(1200);
  return 'clicked';
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2500));
  await win.webContents.executeJavaScript(SEED);
  await win.reload();
  await new Promise(r => setTimeout(r, 3200));

  // books with no folder sit on the shelf as tiles
  const shaped = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const c = document.getElementById('crumbHome');
    if (c) { c.click(); await sleep(500); }
    const tiles = document.querySelectorAll('.book-tile, .book-card').length;
    const titles = [...document.querySelectorAll('.shelf-title, .book-title')].map(e => e.textContent);
    return JSON.stringify({ tiles, titles });
  })()`);
  const s = JSON.parse(shaped);
  if (!s.tiles) {
    say('  the seeded books did not render, so nothing can be checked here: ' + shaped);
    app.exit(1);
  }
  say('  seeded tiles: ' + s.tiles + '  ' + s.titles.join(' | ') + '\n');

  await win.webContents.executeJavaScript(STUB);

  // --- the action is offered ---
  say('  menu for a local book');
  let m = JSON.parse(await win.webContents.executeJavaScript(MENU('Local Only')));
  check(m.open, 'the right-click menu opens');
  check(m.labels.includes('Move to online library'), 'it offers "Move to online library"');
  check(m.labels.includes('Delete'), 'the existing Delete is still there');

  // --- and it hands over the right file, and deletes nothing on its own ---
  // answer "no" to the delete question: the book must survive an upload
  await win.webContents.executeJavaScript(`window.__confirmAnswer = false; window.__confirmMsgs = [];`);
  await win.webContents.executeJavaScript(CLICK_ITEM('Move to online library'));
  let after = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    calls: window.__calls, online: window.__online,
    confirms: window.__confirmMsgs || [],
    stillHere: [...document.querySelectorAll('.shelf-title, .book-title')].some(e => e.textContent === 'Local Only')
  })`));
  check(after.calls.length === 1, 'it uploads once');
  check(after.calls[0] && after.calls[0].path === 'C:/books/local-only.epub',
    'it hands over the book file on disk', after.calls[0] ? after.calls[0].path : 'nothing');
  check(after.calls[0] && after.calls[0].name === 'local-only.epub',
    'with the real file name', after.calls[0] ? after.calls[0].name : 'nothing');
  check(after.confirms.some(c => /Delete the local copy/i.test(c)),
    'the local copy is only removed if asked', after.confirms.length + ' prompt(s)');
  check(after.stillHere, 'declining the delete leaves the local copy alone');

  // --- a book already online is not offered the action again ---
  m = JSON.parse(await win.webContents.executeJavaScript(MENU('Local Only')));
  check(m.open && Array.isArray(m.labels), 'the menu still opens on it');
  check(m.labels && !m.labels.includes('Move to online library'), 'a book already online is not offered it again');

  // --- saying yes does remove it ---
  await win.webContents.executeJavaScript(`window.__confirmAnswer = true; window.__online = []; window.__calls = []; window.__confirmMsgs = [];`);
  await win.webContents.executeJavaScript(MENU('Local Only'));
  await win.webContents.executeJavaScript(CLICK_ITEM('Move to online library'));
  const deleted = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    gone: ![...document.querySelectorAll('.shelf-title, .book-title')].some(e => e.textContent === 'Local Only')
  })`));
  check(deleted.gone, 'answering yes removes the local copy, as "move" implies');

  // --- a server-side book is never offered it ---
  m = JSON.parse(await win.webContents.executeJavaScript(MENU('Server Book')));
  check(m.open, 'a book with only an id: path still opens its menu');
  check(!m.labels.includes('Move to online library'), 'but is not offered an upload it cannot do');

  // --- a big file warns first ---
  await win.webContents.executeJavaScript(`window.__online = []; window.__calls = []; window.__confirmMsgs = [];`);
  await win.webContents.executeJavaScript(MENU('Huge Audiobook'));
  await win.webContents.executeJavaScript(CLICK_ITEM('Move to online library'));
  after = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    calls: window.__calls, confirms: window.__confirmMsgs || []
  })`));
  check(after.confirms.some(c => /1500 MB/.test(c)), 'a huge audiobook warns before starting');

  // --- no session means no upload ---
  // Both real-path books have been deleted by the steps above (each was asked
  // about and answered yes, which is the point of those checks), so start again
  // to have something left to try the signed-out path on.
  await new Promise(r => setTimeout(r, 1200));
  await win.webContents.executeJavaScript(SEED);
  await win.reload();
  await new Promise(r => setTimeout(r, 3200));
  await win.webContents.executeJavaScript(STUB + `
    window.__signedIn = false; window.__online = []; window.__calls = []; window.__confirmMsgs = []; true;`);
  const menuForPlain = JSON.parse(await win.webContents.executeJavaScript(MENU('Local Only')));
  check(!!menuForPlain.open && !!menuForPlain.labels && menuForPlain.labels.includes('Move to online library'),
    'signed out, the action is still offered', menuForPlain.error ? menuForPlain.error : '');
  await win.webContents.executeJavaScript(CLICK_ITEM('Move to online library'));
  await new Promise(r => setTimeout(r, 900));
  after = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    calls: window.__calls,
    confirms: window.__confirmMsgs || [],
    toast: (document.getElementById('toast')||{}).textContent || '',
    toastShown: document.getElementById('toast') ? !document.getElementById('toast').classList.contains('hidden') : false
  })`));
  check(after.calls.length === 0, 'without a session nothing is uploaded');
  check(after.confirms.length === 0, 'it does not even ask about deleting the local copy');
  check(after.toastShown && /Sign in/i.test(after.toast), 'and it says why', JSON.stringify(after.toast));

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'the online move action behaves'));
  say('');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });