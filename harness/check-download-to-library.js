/* Download puts a book from the online library into this computer's library.
 *
 * A browser paired with this computer posts the book it fetched from the cloud
 * to POST /api/book, so that is checked here over real HTTP against a throwaway
 * library - never the real one, which is set aside with SB_USER_DATA. What
 * matters is that the books and folders already there survive, that the same
 * book twice does not become two copies, and that rubbish is refused.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8791 + (process.pid % 40);
const PASSWORD = 'test-password-for-this-check';
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-download-check-'));
const libraryDir = path.join(userData, 'Library');
fs.mkdirSync(libraryDir, { recursive: true });
const indexFile = path.join(userData, 'library-index.json');

// A library that already has books and a folder, so "added without disturbing
// anything" can actually be checked rather than assumed.
const seeds = [
  { name: 'First Book.epub', title: 'First Book' },
  { name: 'Second Book.epub', title: 'Second Book' }
];
const seededBooks = seeds.map((seed, i) => {
  const storedPath = path.join(libraryDir, seed.name);
  fs.writeFileSync(storedPath, 'seed-' + i);
  return { id: 'seed-' + i, title: seed.title, author: '', type: 'epub', fileName: seed.name, storedPath, coverPath: null, folderId: 'f1', addedAt: 1000 + i, progress: 0 };
});
fs.writeFileSync(indexFile, JSON.stringify({
  version: 1, updatedAt: 1, books: seededBooks, folders: [{ id: 'f1', name: 'Shelf', order: 0 }]
}));

const readIndex = () => JSON.parse(fs.readFileSync(indexFile, 'utf8'));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, {
      SB_USER_DATA: userData, SB_PORT: String(PORT), SB_HOST: '127.0.0.1',
      SB_PASSWORD: PASSWORD, SB_REQUIRE_PASSWORD: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  // Let the child go and drop its pipes before exiting, or libuv complains
  // about a handle closing twice on the way out.
  const stop = () => {
    try { server.kill(); } catch {}
    try { server.stdout.destroy(); server.stderr.destroy(); } catch {}
    server.unref();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', stop);

  const base = `http://127.0.0.1:${PORT}`;
  // Wait for it to answer.
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/ping'); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }

  say('\n  signing in to the throwaway library\n');
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD })
  });
  const session = await login.json().catch(() => ({}));
  check(login.ok && !!session.token, 'the library lets us in', 'http ' + login.status);
  const headers = { 'x-sb-token': session.token };

  say('\n  a browser without a token cannot add anything\n');
  const sneaky = await fetch(base + '/api/book?name=Sneaky.epub', { method: 'POST', body: 'x' });
  check(sneaky.status === 401, 'an unauthenticated add is turned away', 'http ' + sneaky.status);
  check(readIndex().books.length === 2, 'and the library is untouched', readIndex().books.length + ' books');

  say('\n  the book arrives\n');
  const added = await fetch(base + '/api/book?name=' + encodeURIComponent('Cloud Book.epub') + '&cloudBookId=cloud-1', {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/octet-stream' }, headers),
    body: 'the bytes of a book'
  });
  const saved = await added.json().catch(() => ({}));
  check(added.ok, 'the book is accepted', 'http ' + added.status + (saved.error ? ' ' + saved.error : ''));
  check(!!saved.storedPath && fs.existsSync(saved.storedPath), 'and the file is on disk', saved.fileName || '');
  check(fs.existsSync(saved.storedPath) && fs.readFileSync(saved.storedPath, 'utf8') === 'the bytes of a book',
    'with the bytes it was sent', saved.storedPath ? path.basename(saved.storedPath) : 'no path');

  const after = readIndex();
  check(after.books.length === 3, 'the library now holds three books', after.books.length + ' books');
  check(after.books.filter(b => seeds.some(s => s.name === b.fileName)).length === 2,
    'and the two that were already there are still there');
  check(after.folders.length === 1 && after.folders[0].name === 'Shelf', 'the folder survived', JSON.stringify(after.folders));
  const record = after.books.find(b => b.cloudBookId === 'cloud-1');
  check(!!record, 'the new book is in the index', record ? record.title : 'missing');
  check(record && record.type === 'epub', 'typed as an epub', record && record.type);

  say('\n  the same book twice is still one book\n');
  const again = await fetch(base + '/api/book?name=' + encodeURIComponent('Cloud Book.epub') + '&cloudBookId=cloud-1', {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/octet-stream' }, headers), body: 'the bytes of a book'
  });
  const againBody = await again.json().catch(() => ({}));
  check(againBody.alreadyAdded === true, 'the second try says it is already there', 'alreadyAdded=' + againBody.alreadyAdded);
  check(readIndex().books.length === 3, 'and no second copy appears', readIndex().books.length + ' books');

  say('\n  rubbish is refused\n');
  const junk = await fetch(base + '/api/book?name=' + encodeURIComponent('Trojan.exe'), {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/octet-stream' }, headers), body: 'MZ'
  });
  check(!junk.ok, 'a file that is not a book is turned away', 'http ' + junk.status);
  const nameless = await fetch(base + '/api/book', { method: 'POST', headers, body: 'x' });
  check(!nameless.ok, 'and so is a book with no name', 'http ' + nameless.status);
  check(readIndex().books.length === 3, 'the library is still just the three books', readIndex().books.length + ' books');
  check(fs.readdirSync(libraryDir).filter(n => n.endsWith('.exe')).length === 0, 'and nothing was written for it');

  say('\n  a name that would escape the library folder cannot\n');
  const sneakyName = await fetch(base + '/api/book?name=' + encodeURIComponent('../../escaped.epub'), {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/octet-stream' }, headers), body: 'x'
  });
  const sneakyBody = await sneakyName.json().catch(() => ({}));
  check(!!sneakyBody.storedPath && !path.resolve(sneakyBody.storedPath).includes('..' + path.sep) &&
    path.dirname(path.resolve(sneakyBody.storedPath)) === path.resolve(libraryDir),
    'the file lands inside the library folder', sneakyBody.storedPath || 'no path');

  say('\n  the desktop app can see it over the same API\n');
  const listing = await fetch(base + '/api/library', { headers });
  const library = await listing.json().catch(() => ({}));
  // The two seeded books, the one from the cloud, and the one with the
  // dangerous name - which was flattened to a plain file name, not refused.
  check((library.books || []).length === 4, 'the library the app reads has all four books', (library.books || []).length + ' books');

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'a book downloaded from the cloud lands in the library, once, with nothing else lost') + '\n');
  stop();
  process.exit(bad ? 1 : 0);
}

main().catch(error => { say('HARNESS ERROR: ' + (error && error.stack ? error.stack : error)); process.exit(1); });