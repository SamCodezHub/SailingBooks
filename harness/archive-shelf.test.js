/* End-to-end check of the simplified Archives: books only, no sets/folders.
   Runs against a throwaway userData folder and its own port. */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const UD = path.join(os.tmpdir(), 'sb-arc2-' + Date.now());
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

(async () => {
  fs.mkdirSync(path.join(UD, 'Library'), { recursive: true });

  // A tiny real m4a so audio metadata is exercised for real.
  const { execFileSync } = require('child_process');
  const ffmpeg = path.join(process.env.LOCALAPPDATA || '', 'Sailing Books', 'tools', 'ffmpeg.exe');
  const audio = path.join(UD, 'sample.m4a');
  if (fs.existsSync(ffmpeg)) {
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'aac', '-b:a', '32k', audio],
      { stdio: 'ignore' });
  }

  // An EPUB and a library book to export.
  const epub = path.join(UD, 'sample.epub');
  fs.writeFileSync(epub, 'PK' + Buffer.alloc(600));
  const libBook = path.join(UD, 'Library', 'my-book.epub');
  fs.writeFileSync(libBook, 'PK' + Buffer.alloc(400));
  const idx = {
    version: 1,
    books: [{ id: 'bk1', title: 'My Book', fileName: 'my-book.epub', storedPath: libBook, type: 'epub' }],
    folders: []
  };
  fs.writeFileSync(path.join(UD, 'library-index.json'), JSON.stringify(idx));

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, SB_USER_DATA: UD, SB_PORT: String(PORT), SB_PASSWORD: 'testpw1234', SB_REQUIRE_PASSWORD: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });

  const wait = async () => { for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'testpw1234' }) }); if (r.ok) return (await r.json()).token; } catch {} await new Promise(r => setTimeout(r, 200)); } throw new Error('server never came up\n' + log); };
  const T = await wait();
  const H = { 'x-sb-token': T };

  console.log('\n--- sign in: one admin account ---');
  const bad = await fetch(BASE + '/api/archive/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
  ok(bad.status === 401, 'wrong password refused');
  const badUser = await fetch(BASE + '/api/archive/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'someone', password: 'testpw1234' }) });
  ok(badUser.status === 401, 'any other username refused');
  const li = await fetch(BASE + '/api/archive/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'testpw1234' }) });
  const login = await li.json();
  ok(li.ok && login.user === 'admin' && !!login.token, 'admin signs in');
  const noAuth = await fetch(BASE + '/api/archive');
  ok(noAuth.status === 401, 'archive needs a token');

  console.log('\n--- the shelf ---');
  const empty = await (await fetch(BASE + '/api/archive', { headers: H })).json();
  ok(Array.isArray(empty.items) && empty.items.length === 0, 'starts empty');
  ok(!('sets' in empty), 'no sets in the response any more');

  const up = await fetch(BASE + '/api/archive/upload?name=sample.epub', { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream' }, body: fs.readFileSync(epub) });
  const upJ = await up.json();
  ok(up.ok && upJ.item && upJ.item.id, 'upload a book');
  ok(fs.existsSync(path.join(UD, 'Archives', 'Books', 'sample.epub')), 'file is on the laptop');
  if (fs.existsSync(audio)) {
    const a = await fetch(BASE + '/api/archive/upload?name=sample.m4a', { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream' }, body: fs.readFileSync(audio) });
    const aJ = await a.json();
    ok(a.ok && aJ.item && aJ.item.type === 'audio', 'upload an audiobook');
    ok(aJ.item && aJ.item.duration > 7 && aJ.item.duration < 9, `duration read on the laptop (${aJ.item && aJ.item.duration}s)`);
  }
  const again = await fetch(BASE + '/api/archive/upload?name=sample.epub', { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream' }, body: fs.readFileSync(epub) });
  ok(again.ok, 're-uploading the same book is allowed');
  const list = await (await fetch(BASE + '/api/archive', { headers: H })).json();
  ok(list.items.filter(i => i.fileName === 'sample.epub').length === 1, 'and it does not duplicate');

  console.log('\n--- export from the library (server copies it, nothing travels) ---');
  const ex = await fetch(BASE + '/api/archive/export/bk1', { method: 'POST', headers: H });
  const exJ = await ex.json();
  ok(ex.ok && exJ.item, 'export a library book');
  ok(fs.existsSync(path.join(UD, 'Archives', 'Books', 'my-book.epub')), 'copy is on the shelf');
  const ex404 = await fetch(BASE + '/api/archive/export/nope', { method: 'POST', headers: H });
  ok(ex404.status === 404, 'unknown book is refused');

  console.log('\n--- download ---');
  const dl = await fetch(BASE + '/api/archive/download/' + exJ.item.id, { headers: H });
  const bytes = Buffer.from(await dl.arrayBuffer());
  const srcBytes = fs.readFileSync(libBook);
  ok(dl.ok && bytes.length === srcBytes.length, `download returns the exact file (${bytes.length} of ${srcBytes.length} bytes)`);
  ok(bytes.equals(srcBytes), 'and it is byte-for-byte identical');
  ok(/attachment/.test(dl.headers.get('content-disposition') || ''), 'sent as a download');
  const dlNo = await fetch(BASE + '/api/archive/download/' + exJ.item.id);
  ok(dlNo.status === 401, 'download needs a token');

  console.log('\n--- sets are gone ---');
  for (const [m, p] of [['POST', '/api/archive/set'], ['POST', '/api/archive/install/1'], ['GET', '/api/archive/zip/1']]) {
    const r = await fetch(BASE + p, { method: m, headers: { ...H, 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    ok(r.status === 404, `${m} ${p} no longer exists`);
  }
  const idxNow = JSON.parse(fs.readFileSync(path.join(UD, 'library-index.json'), 'utf8'));
  ok(idxNow.folders.length === 0, 'library index untouched (no folders invented)');

  console.log('\n--- delete ---');
  const del = await fetch(BASE + '/api/archive/item/' + exJ.item.id, { method: 'DELETE', headers: H });
  ok(del.ok, 'delete a book');
  ok(!fs.existsSync(path.join(UD, 'Archives', 'Books', 'my-book.epub')), 'the file went too');
  const after = await (await fetch(BASE + '/api/archive', { headers: H })).json();
  ok(!after.items.some(i => i.id === exJ.item.id), 'gone from the shelf');

  srv.kill();
  await new Promise(r => setTimeout(r, 200));
  await fsp.rm(UD, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
