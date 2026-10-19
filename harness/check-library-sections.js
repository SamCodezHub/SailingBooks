/* The library root is two headings: folders, then the books that are in none.
 *
 * Books used to sit in the same grid as the folders, which made the shelf
 * unreadable once there were folders to speak of. Splitting them is only worth
 * anything if the split is honest - the unsorted list must hold exactly the
 * books without a folder, and a book standing in it must still behave like a
 * book anywhere else: dragged onto a folder it goes in, right-clicked it opens
 * the same menu. This checks all of that against a seeded library, never the
 * real one.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sections-'));
app.setPath('userData', profile);

const book = (id, title, folderId) => ({
  id, title, fileName: title + '.epub', type: 'epub', folderId: folderId || null,
  author: 'A. Writer', addedAt: 1, lastOpened: 0, progress: 0
});
const SEED = {
  folders: [
    { id: 'f-sail', name: 'Sailing', color: '#4a90d9' },
    { id: 'f-engine', name: 'Engineering', color: '#d98f4a' }
  ],
  books: [
    book('b-loose-1', 'Loose One'),
    book('b-loose-2', 'Loose Two'),
    book('b-sail-1', 'Inside Sail', 'f-sail'),
    book('b-engine-1', 'Inside Engine', 'f-engine')
  ],
  settings: {}
};
let savedIndex = null;

// The app asks the bridge for a few things while it boots. Answer them from a
// throwaway library so the check never sees or touches the real one.
ipcMain.handle('get-library-dir', () => profile);
ipcMain.handle('get-library-index', () => JSON.parse(JSON.stringify(SEED)));
ipcMain.handle('save-library-index', (_event, index) => { savedIndex = index; return true; });
ipcMain.handle('list-library-files', () => []);
ipcMain.handle('get-cloud-session', () => null);

const HELPERS = `
window.__sbSnapshot = () => {
  const vis = id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0; };
  const titles = sel => [...document.querySelectorAll(sel)].map(e => e.textContent.trim());
  return JSON.stringify({
    shelfTitle: (document.getElementById('shelfTitle') || {}).textContent || '',
    looseTitle: (document.getElementById('looseTitle') || {}).textContent || '',
    shelfUp: vis('shelfSection'), shelfTitleUp: vis('shelfTitle'),
    shelfFolders: titles('#shelfGrid .folder-name'),
    looseUp: vis('looseSection'), looseBooks: titles('#looseGrid .shelf-title'),
    shelfBookIds: [...document.querySelectorAll('#shelfGrid .book-tile')].map(e => e.dataset.bookId),
    looseIds: [...document.querySelectorAll('#looseGrid .book-tile')].map(e => e.dataset.bookId),
    booksTitle: (document.getElementById('booksTitle') || {}).textContent || '',
    booksUp: vis('booksSection'), looseUpInsideFolder: vis('looseSection'),
    order: document.getElementById('shelfSection').compareDocumentPosition(document.getElementById('looseSection')) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0,
    menuItems: [...document.querySelectorAll('#contextMenu .ctx-item, #contextMenu .ctx-label')].map(e => e.textContent.trim()),
    menuUp: !document.getElementById('contextMenu').classList.contains('hidden')
  });
};
window.__sbStored = (id) => {
  const raw = localStorage.getItem('sailing-books-v1');
  const s = raw ? JSON.parse(raw) : { books: [] };
  const b = (s.books || []).find(x => x.id === id);
  return JSON.stringify(b || null);
};
window.__sbRightClick = (id) => {
  const tile = document.querySelector('#looseGrid .book-tile[data-book-id="' + id + '"]');
  if (!tile) return 'missing';
  const r = tile.getBoundingClientRect();
  tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
  return 'done';
};
window.__sbClickMenu = (label) => {
  const row = [...document.querySelectorAll('#contextMenu .ctx-item')].find(e => e.textContent.trim() === label);
  if (!row) return 'missing';
  row.click();
  return 'done';
};
window.__sbDrag = (bookId, folderId) => {
  const tile = document.querySelector('#looseGrid .book-tile[data-book-id="' + bookId + '"]');
  const target = document.querySelector('#shelfGrid .folder-card[data-folder-id="' + folderId + '"]');
  if (!tile) return 'missing book';
  if (!target) return 'missing folder';
  const t = tile.getBoundingClientRect(), f = target.getBoundingClientRect();
  const sx = t.left + t.width / 2, sy = t.top + t.height / 2;
  const fx = f.left + f.width / 2, fy = f.top + f.height / 2;
  const fire = (el, type, x, y, buttons) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
    pointerId: 7, pointerType: 'mouse', button: 0, buttons: buttons, isPrimary: true
  }));
  fire(tile, 'pointerdown', sx, sy, 1);
  fire(document, 'pointermove', sx + 25, sy + 25, 1);
  fire(document, 'pointermove', fx, fy, 1);
  return 'dragging';
};
window.__sbDrop = () => {
  fire = (el, type, x, y, buttons) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
    pointerId: 7, pointerType: 'mouse', button: 0, buttons: buttons, isPrimary: true
  }));
  const f = document.querySelector('#shelfGrid .folder-card.dragover');
  if (!f) return 'no target highlighted';
  const r = f.getBoundingClientRect();
  fire(document, 'pointerup', r.left + r.width / 2, r.top + r.height / 2, 0);
  return 'dropped';
};
window.__sbOpenFolder = (id) => {
  const f = document.querySelector('#shelfGrid .folder-card[data-folder-id="' + id + '"]');
  if (!f) return 'missing';
  f.click();
  return 'opened';
};
window.__sbHome = () => { const c = document.getElementById('crumbHome'); if (!c) return 'missing'; c.click(); return 'home'; };
window.__sbSearch = (q) => {
  const box = document.getElementById('searchInput') || document.getElementById('search');
  if (!box) return 'missing';
  box.value = q;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return 'searched';
};
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  // Dragging works out what is under the pointer, which a window that was never
  // shown cannot answer. Put it on screen, well out of the way.
  win.setPosition(-4000, 0);
  win.showInactive();

  // Desktop state lives in localStorage, so seed it and load again.
  await win.loadFile(INDEX);
  await win.webContents.executeJavaScript(`localStorage.setItem('sailing-books-v1', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  await win.loadFile(INDEX);
  await new Promise(r => setTimeout(r, 900));
  await win.webContents.executeJavaScript(HELPERS + '\n1;');
  const snap = async () => JSON.parse(await win.webContents.executeJavaScript('window.__sbSnapshot()'));

  say('\n  two headings, folders first\n');
  let s = await snap();
  check(s.shelfUp && s.shelfTitleUp, 'the folders heading is on screen', JSON.stringify(s.shelfTitle));
  check(s.shelfTitle === 'Folders', 'and it is called Folders', s.shelfTitle);
  check(s.order === 1, 'folders come before the books');
  check(s.looseUp && s.looseTitle === 'Unsorted books', 'then Unsorted books', JSON.stringify(s.looseTitle));

  say('\n  what sits under each one\n');
  check(s.shelfFolders.join(',') === 'Engineering,Sailing', 'every folder is listed', s.shelfFolders.join(', '));
  check(s.shelfBookIds.length === 0, 'and no books are mixed in with them', s.shelfBookIds.join(', '));
  check(s.looseBooks.sort().join(',') === 'Loose One,Loose Two', 'the unsorted list holds the books without a folder', s.looseBooks.join(', '));
  check(!s.looseIds.includes('b-sail-1') && !s.looseIds.includes('b-engine-1'), 'books already in a folder are not in it');

  say('\n  dragging an unsorted book into a folder\n');
  await win.webContents.executeJavaScript(`window.__sbDrag('b-loose-1', 'f-sail')`);
  const dragging = await win.webContents.executeJavaScript('window.__sbDrop()');
  check(dragging === 'dropped', 'the folder highlights while the book is over it', dragging);
  await new Promise(r => setTimeout(r, 700));
  s = await snap();
  check(!s.looseIds.includes('b-loose-1'), 'the book left the unsorted list', s.looseIds.join(', '));
  const stored = JSON.parse(await win.webContents.executeJavaScript(`window.__sbStored('b-loose-1')`));
  check(stored && stored.folderId === 'f-sail', 'and it was saved into the folder', stored ? String(stored.folderId) : 'not saved');
  // The mirror the laptop web client reads is written on a debounce, so give it
  // the time it is actually allowed to take.
  await new Promise(r => setTimeout(r, 3200));
  const filed = savedIndex && (savedIndex.books || []).find(b => b.id === 'b-loose-1');
  check(filed && filed.folderId === 'f-sail', 'the mirrored index catches up too', filed ? String(filed.folderId) : 'no mirror');

  say('\n  right-clicking an unsorted book\n');
  const rc = await win.webContents.executeJavaScript(`window.__sbRightClick('b-loose-2')`);
  s = await snap();
  check(rc === 'done' && s.menuUp, 'the book menu opens', rc);
  check(s.menuItems.includes('Move to folder'), 'with the move list in it', s.menuItems.slice(0, 4).join(' / '));
  check(s.menuItems.includes('Unsorted') && s.menuItems.includes('Sailing') && s.menuItems.includes('Engineering'), 'offering Unsorted and every folder');
  await win.webContents.executeJavaScript(`window.__sbClickMenu('Engineering')`);
  await new Promise(r => setTimeout(r, 700));
  s = await snap();
  check(!s.looseIds.includes('b-loose-2') && s.looseUp === false, 'so the book went in from the menu too', s.looseIds.join(', ') + ' / heading ' + (s.looseUp ? 'still up' : 'gone'));

  say('\n  the other headings behave\n');
  check(s.looseUp === false, 'no empty Unsorted books heading is left behind');
  await win.webContents.executeJavaScript(`window.__sbSearch('Inside')`);
  await new Promise(r => setTimeout(r, 400));
  s = await snap();
  check(/results/.test(s.looseTitle) && s.looseBooks.length > 0, 'searching still finds books that are filed', s.looseTitle + ' -> ' + s.looseBooks.join(', '));
  await win.webContents.executeJavaScript(`window.__sbSearch('')`);
  await new Promise(r => setTimeout(r, 300));
  await win.webContents.executeJavaScript(`window.__sbOpenFolder('f-sail')`);
  await new Promise(r => setTimeout(r, 500));
  s = await snap();
  check(s.booksUp && /Books in/.test(s.booksTitle), 'opening a folder still works', s.booksTitle);
  check(s.looseUp === false && s.shelfUp === false, 'and the root headings step aside');
  await win.webContents.executeJavaScript(`window.__sbHome()`);
  await new Promise(r => setTimeout(r, 400));
  s = await snap();
  check(s.shelfUp && s.shelfFolders.length === 2, 'coming back shows both headings again');

  say('\n');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  app.exit(bad ? 1 : 0);
});
