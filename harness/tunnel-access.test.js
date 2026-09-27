/* Confirms the tunnel-style phone access still works after the archive was
   removed: sign in, list the library, read a book, read a cover, save progress,
   and that the client bundle the laptop serves has no archive code in it. */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const UD = path.join(os.tmpdir(), 'sb-tun-' + Date.now());
const PORT = 8933;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const root = path.join(__dirname, '..');

(async () => {
  fs.mkdirSync(path.join(UD, 'Library'), { recursive: true });
  fs.mkdirSync(path.join(UD, 'Covers'), { recursive: true });
  const book = path.join(UD, 'Library', 'phone-book.epub');
  const cover = path.join(UD, 'Covers', 'phone-book.jpg');
  fs.writeFileSync(book, 'PK' + Buffer.alloc(2048));
  fs.writeFileSync(cover, Buffer.alloc(600, 7));
  fs.writeFileSync(path.join(UD, 'library-index.json'), JSON.stringify({
    version: 1,
    books: [{ id: 'b1', title: 'Phone Book', author: 'A', type: 'epub', storedPath: book, coverPath: cover, size: 2050 }],
    folders: [{ id: 'f1', name: 'Shelf One', color: '#eee', nodes: [{ id: 'n1', x: 1, y: 2, label: 'Start' }], edges: [], sections: [] }]
  }));

  const srv = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
    env: { ...process.env, SB_USER_DATA: UD, SB_PORT: String(PORT), SB_PASSWORD: 'tunnelpw99', SB_REQUIRE_PASSWORD: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });

  let token = null;
  for (let i = 0; i < 60 && !token; i++) {
    try {
      const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'tunnelpw99' }) });
      if (r.ok) token = (await r.json()).token;
    } catch {}
    if (!token) await new Promise(r => setTimeout(r, 200));
  }
  ok(!!token, 'phone can sign in with the laptop password');
  if (!token) { console.error(log); process.exit(1); }
  const H = { 'x-sb-token': token };

  const noAuth = await fetch(BASE + '/api/library');
  ok(noAuth.status === 401, 'library needs the token');
  const wrong = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  ok(wrong.status === 401, 'wrong password refused');

  const lib = await (await fetch(BASE + '/api/library', { headers: H })).json();
  ok(Array.isArray(lib.books) && lib.books.length === 1, 'library lists the book');
  ok(lib.books[0].id === 'b1' && lib.books[0].title === 'Phone Book', 'with its title');
  ok(!String(lib.books[0].storedPath || '').includes('Library'), 'the phone never sees the laptop file path');
  ok(lib.books[0].storedPath === 'id:b1', 'it is addressed by id instead');
  ok(Array.isArray(lib.folders) && lib.folders[0].name === 'Shelf One', 'folders come through');
  ok(Array.isArray(lib.folders[0].nodes) && lib.folders[0].nodes.length === 1, 'the flowchart comes through');

  const file = await fetch(BASE + '/api/book/b1/file', { headers: H });
  const bytes = Buffer.from(await file.arrayBuffer());
  ok(file.ok && bytes.equals(fs.readFileSync(book)), 'the phone can read the book itself');

  const cv = await fetch(BASE + '/api/book/b1/cover' + '?token=' + encodeURIComponent(token));
  ok(cv.ok, 'cover works with the token in the query (images cannot send headers)');
  const audio = await fetch(BASE + '/api/book/b1/meta');
  ok(audio.status === 401, 'book metadata is protected');

  await fetch(BASE + '/api/book/b1/progress', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ progress: 0.42, epubChapter: 7 }) });
  const after = await (await fetch(BASE + '/api/library', { headers: H })).json();
  ok(Math.abs(after.books[0].progress - 0.42) < 0.001 && after.books[0].epubChapter === 7, 'reading position is remembered');

  const esc = await fetch(BASE + '/api/book/..%2F..%2Fwindows%2Fsystem.ini/file', { headers: H });
  ok(esc.status === 404 || esc.status === 400, 'path traversal is refused');

  // The static client the laptop serves for the phone
  const page = await fetch(BASE + '/');
  const html = await page.text();
  ok(page.ok && /api-shim/.test(html), 'the phone page is served');
  for (const f of ['/api-shim.js', '/renderer.js', '/styles.css', '/login.js']) {
    const r = await fetch(BASE + f);
    ok(r.ok, 'serves ' + f);
  }
  ok(/id="loginPass"/i.test(html) && /id="loginServer"/i.test(html),
    'the sign-in gate (password + laptop address) is inlined into the page the phone opens');
  const shim = await (await fetch(BASE + '/api-shim.js')).text();
  ok(!/archive/i.test(shim), 'the client has no archive code left');
  const rend = await (await fetch(BASE + '/renderer.js')).text();
  ok(!/archive/i.test(rend), 'nor does the renderer');
  const arc = await fetch(BASE + '/api/archive', { headers: H });
  ok(arc.status === 404, 'the archive endpoint is gone');

  srv.kill();
  await new Promise(r => setTimeout(r, 200));
  await fsp.rm(UD, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
