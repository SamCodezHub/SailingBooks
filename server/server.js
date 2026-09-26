/* Sailing Books — library server for the phone / web client.
 *
 * Serves the same reader UI the desktop app uses (renderer/*), plus a small
 * JSON API over the library that lives on this machine. No cloud: the files
 * never leave the laptop.
 *
 *   node server/server.js            # http://<this-machine>:8787
 *   SB_PORT=9000 SB_PASSWORD=secret node server/server.js
 *
 * The book list comes from library-index.json, which the desktop app writes
 * into its userData folder. If that file is missing the server falls back to
 * scanning the Library folder, so it also works before the desktop app runs.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const SHIM = path.join(ROOT, 'web', 'api-shim.js');

const PORT = +(process.env.SB_PORT || 8787);
const HOST = process.env.SB_HOST || '0.0.0.0';
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

const LIB_EXTS = ['epub', 'pdf', 'mp3', 'm4a', 'm4b', 'wav', 'ogg', 'opus', 'flac', 'aac'];

/* ---------------- paths (same layout as the desktop app) ---------------- */
function userDataDir() {
  if (process.env.SB_USER_DATA) return process.env.SB_USER_DATA;
  const appName = 'Sailing Books';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), appName);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', appName);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}
const USER_DATA = userDataDir();
const LIBRARY_DIR = path.join(USER_DATA, 'Library');
const COVERS_DIR = path.join(USER_DATA, 'Covers');
const INDEX_FILE = path.join(USER_DATA, 'library-index.json');
const PROGRESS_FILE = path.join(USER_DATA, 'web-progress.json');

for (const d of [USER_DATA, LIBRARY_DIR, COVERS_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------- auth ---------------- */
function authFile() { return path.join(USER_DATA, 'web-auth.json'); }
function loadAuth() {
  const pass = process.env.SB_PASSWORD;
  if (pass) return { password: pass, secret: crypto.randomBytes(32).toString('hex'), generated: false };
  try {
    const a = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    if (a && a.password && a.secret) return { ...a, generated: false };
  } catch {}
  const a = {
    password: process.env.SB_PASSWORD || crypto.randomBytes(4).toString('hex'),
    secret: crypto.randomBytes(32).toString('hex')
  };
  try { fs.writeFileSync(authFile(), JSON.stringify(a, null, 2)); a.generated = true; } catch {}
  return a;
}
const AUTH = loadAuth();

function sign(expires) {
  const body = `sb.${expires}`;
  const mac = crypto.createHmac('sha256', AUTH.secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const parts = tok.split('.');
  if (parts.length !== 3 || parts[0] !== 'sb') return false;
  const expires = +parts[1];
  if (!isFinite(expires) || expires < Date.now()) return false;
  const mac = crypto.createHmac('sha256', AUTH.secret).update(`sb.${expires}`).digest('base64url');
  const a = Buffer.from(parts[2]), b = Buffer.from(mac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const attempts = new Map(); // ip -> {n, until}
function rateLimited(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) { attempts.delete(ip); return false; }
  return rec.n >= 8;
}
function noteFailure(ip) {
  const rec = attempts.get(ip) || { n: 0, until: 0 };
  rec.n++; rec.until = Date.now() + 5 * 60 * 1000;
  attempts.set(ip, rec);
}

/* ---------------- library index ---------------- */
let indexCache = { mtime: 0, books: [], folders: [] };
function readIndex() {
  try {
    const st = fs.statSync(INDEX_FILE);
    if (st.mtimeMs !== indexCache.mtime) {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      indexCache = { mtime: st.mtimeMs, books: raw.books || [], folders: raw.folders || [] };
    }
    return indexCache;
  } catch {}
  return { books: [], folders: [] };
}
// Progress the phone changed, merged over whatever the desktop app last wrote.
function readProgress() { try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return {}; } }
function writeProgress(p) {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p)); } catch {}
}
function mergeProgress(books) {
  const p = readProgress();
  if (!Object.keys(p).length) return books;
  return books.map(b => (p[b.id] ? { ...b, ...p[b.id] } : b));
}
// Fallback: no index file yet — scan the library folder.
function scanLibrary() {
  let files = [];
  try { files = fs.readdirSync(LIBRARY_DIR); } catch { return { books: [], folders: [] }; }
  const books = [];
  for (const name of files) {
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!LIB_EXTS.includes(ext)) continue;
    const full = path.join(LIBRARY_DIR, name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const id = crypto.createHash('sha1').update(full).digest('hex').slice(0, 16);
    books.push({
      id, title: name.replace(/\.[^.]+$/, ''), author: '', type: ext === 'epub' ? 'epub' : ext === 'pdf' ? 'pdf' : 'audio',
      fileName: name, storedPath: full, coverPath: null, folderId: null, addedAt: st.mtimeMs, progress: 0
    });
  }
  return { books, folders: [] };
}
// What the client gets: ids, not machine paths.
function publicBooks() {
  const idx = readIndex().books.length ? readIndex() : scanLibrary();
  const books = mergeProgress(idx.books).map(b => {
    const storedPath = b.storedPath || '';
    const inLibrary = storedPath ? safeInside(LIBRARY_DIR, storedPath) : null;
    return {
      id: b.id,
      title: b.title || b.fileName,
      author: b.author || '',
      type: b.type,
      fileName: b.fileName,
      folderId: b.folderId || null,
      addedAt: b.addedAt || 0,
      lastOpened: b.lastOpened || 0,
      progress: b.progress || 0,
      progressSeconds: b.progressSeconds || 0,
      epubChapter: b.epubChapter,
      pdfPage: b.pdfPage,
      chapters: Array.isArray(b.chapters) ? b.chapters : null,
      duration: b.duration || 0,
      userRenamed: !!b.userRenamed,
      storedPath: inLibrary ? 'id:' + b.id : null,     // shim maps this to /api/book/:id/file
      coverPath: b.coverPath && safeInside(COVERS_DIR, b.coverPath) ? 'id:' + b.id : null
    };
  }).filter(b => b.storedPath);
  return { books, folders: idx.folders || [] };
}
// Never let a stored path escape the library / covers folders.
function safeInside(root, p) {
  try {
    const full = path.resolve(p);
    const r = path.resolve(root) + path.sep;
    return full.startsWith(r) ? full : null;
  } catch { return null; }
}
function bookFile(id) {
  const b = publicBooks().books.find(x => x.id === id);
  if (!b) return null;
  const stored = (readIndex().books.find(x => x.id === id) || {}).storedPath;
  const full = stored ? safeInside(LIBRARY_DIR, stored) : null;
  return full && fs.existsSync(full) ? { path: full, book: b } : null;
}
function bookCover(id) {
  const rec = readIndex().books.find(x => x.id === id);
  if (!rec || !rec.coverPath) return null;
  const full = safeInside(COVERS_DIR, rec.coverPath);
  return full && fs.existsSync(full) ? full : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.epub': 'application/epub+zip',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac'
};
const mimeOf = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/* ---------------- audio metadata (chapters / cover) ---------------- */
const metaCache = new Map(); // path -> {mtime, value}
async function audioMeta(file) {
  try {
    const st = fs.statSync(file);
    const hit = metaCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.value;
    const mm = require('music-metadata');
    const meta = await mm.parseFile(file, { duration: true, includeChapters: true });
    const chapters = Array.isArray(meta.format.chapters)
      ? meta.format.chapters.filter(c => c && isFinite(c.start))
        .map(c => ({ title: String(c.title || '').slice(0, 120), start: +c.start, end: isFinite(c.end) ? +c.end : null }))
      : [];
    const pic = meta.common.picture && meta.common.picture[0];
    let cover = null;
    if (pic && pic.data && pic.data.length > 512 && pic.data.length < 8 * 1024 * 1024) {
      const mime = pic.format && pic.format.includes('/') ? pic.format : 'image/jpeg';
      cover = `data:${mime};base64,${pic.data.toString('base64')}`;
    }
    const value = {
      duration: isFinite(meta.format.duration) ? +meta.format.duration : null,
      chapters, cover, title: meta.common.title || null, artist: meta.common.artist || null
    };
    metaCache.set(file, { mtime: st.mtimeMs, value });
    return value;
  } catch {
    return { duration: null, chapters: [], cover: null };
  }
}

/* ---------------- http helpers ---------------- */
function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'cache-control': 'no-store' }, headers));
  res.end(body);
}
const sendJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

// Range-aware streaming: the <audio> element needs 206 to seek.
async function sendFile(req, res, file, mime) {
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'Not found'); }
  const type = mime || mimeOf(file);
  const range = req.headers.range;
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=0' };
  if (!range) {
    res.writeHead(200, Object.assign({ 'content-length': st.size }, base));
    return fs.createReadStream(file).pipe(res);
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? +m[1] : 0;
  let end = m && m[2] ? +m[2] : st.size - 1;
  if (isNaN(start) || start >= st.size) {
    res.writeHead(416, Object.assign({ 'content-range': `bytes */${st.size}` }, base));
    return res.end();
  }
  end = Math.min(end, st.size - 1);
  res.writeHead(206, Object.assign({
    'content-range': `bytes ${start}-${end}/${st.size}`,
    'content-length': end - start + 1
  }, base));
  fs.createReadStream(file, { start, end }).pipe(res);
}

/* ---------------- static client ---------------- */
let clientCache = new Map();
async function serveClient(res, urlPath) {
    if (urlPath === '/' || urlPath === '/index.html') {
      let html = clientCache.get('index.html');
      if (!html) {
        const gate = await fsp.readFile(path.join(ROOT, 'web', 'login.html'), 'utf8');
        html = await fsp.readFile(path.join(RENDERER, 'index.html'), 'utf8');
        // Browser build only: the window.api shim + the sign-in gate.
        html = html.replace('<div id="app">', gate + '\n<div id="app">');
        html = html.replace(/<script src="renderer\.js"><\/script>/,
          '<script src="/api-shim.js"></script>\n<script src="/login.js"></script>\n<script src="/renderer.js"></script>');
        clientCache.set('index.html', html);
      }
      return send(res, 200, html, { 'content-type': MIME['.html'] });
    }
  // The client pulls its libraries from the same place as the desktop app.
  const map = {
    '/styles.css': path.join(RENDERER, 'styles.css'),
    '/renderer.js': path.join(RENDERER, 'renderer.js'),
    '/api-shim.js': SHIM,
    '/login.js': path.join(ROOT, 'web', 'login.js'),
    '/node_modules/jszip/dist/jszip.min.js': path.join(ROOT, 'node_modules', 'jszip', 'dist', 'jszip.min.js'),
    '/node_modules/pdfjs-dist/build/pdf.js': path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.js'),
    '/node_modules/pdfjs-dist/build/pdf.worker.js': path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.js')
  };
  const file = map[urlPath];
  if (!file) {
    // any /node_modules/... request, but only from the allow-list above
    return send(res, 404, 'Not found');
  }
  const body = await fsp.readFile(file);
  send(res, 200, body, { 'content-type': mimeOf(file) });
}

/* ---------------- routing ---------------- */
const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'Bad request'); }
  const p = url.pathname;

  // ---- login ----
  if (p === '/api/login' && req.method === 'POST') {
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many attempts — wait 5 minutes' });
    let pass = '';
    try { pass = (JSON.parse(await readBody(req)) || {}).password || ''; } catch {}
    const ok = pass.length > 0 && pass.length === AUTH.password.length
      && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(AUTH.password));
    if (!ok) { noteFailure(ip); return sendJson(res, 401, { error: 'Wrong password' }); }
    attempts.delete(ip);
    return sendJson(res, 200, { token: sign(Date.now() + TOKEN_TTL_MS), name: 'Laptop library' });
  }

  // ---- everything else needs the token (but the sign-in page itself must be
  // reachable before you have one) ----
  if (process.env.SB_LOG) console.log(`  ${req.method} ${p}` + (url.search ? url.search : ''));
  if (p.startsWith('/api/')) {
    const token = req.headers['x-sb-token'] || url.searchParams.get('token') || '';
    if (!verifyToken(token)) return sendJson(res, 401, { error: 'Not signed in' });
  }

  try {
    if (p === '/api/session') {
      return sendJson(res, 200, { ok: true, name: 'Laptop library', libraryDir: LIBRARY_DIR });
    }
    if (p === '/api/library') {
      const { books, folders } = publicBooks();
      return sendJson(res, 200, { books, folders, updatedAt: readIndex().mtime || 0 });
    }
    let m;
    if ((m = /^\/api\/book\/([^/]+)\/file$/.exec(p))) {
      const hit = bookFile(decodeURIComponent(m[1]));
      if (!hit) return send(res, 404, 'File not in the library');
      return sendFile(req, res, hit.path);
    }
    if ((m = /^\/api\/book\/([^/]+)\/cover$/.exec(p))) {
      const cover = bookCover(decodeURIComponent(m[1]));
      if (!cover) return send(res, 404, 'No cover');
      return sendFile(req, res, cover);
    }
    if ((m = /^\/api\/book\/([^/]+)\/meta$/.exec(p))) {
      const hit = bookFile(decodeURIComponent(m[1]));
      if (!hit) return sendJson(res, 404, { error: 'Unknown book' });
      const known = readIndex().books.find(x => x.id === hit.book.id);
      if (known && Array.isArray(known.chapters) && known.chapters.length) {
        return sendJson(res, 200, {
          duration: known.duration || null, chapters: known.chapters,
          cover: null, title: known.title || null, artist: known.author || null
        });
      }
      if (hit.book.type !== 'audio') return sendJson(res, 200, { duration: null, chapters: [], cover: null });
      return sendJson(res, 200, await audioMeta(hit.path));
    }
    if ((m = /^\/api\/book\/([^/]+)\/progress$/.exec(p)) && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      let patch = {};
      try { patch = JSON.parse(await readBody(req)) || {}; } catch {}
      const allowed = ['progress', 'progressSeconds', 'epubChapter', 'pdfPage', 'lastOpened'];
      const clean = {};
      for (const k of allowed) if (k in patch) clean[k] = patch[k];
      const all = readProgress();
      all[id] = Object.assign({}, all[id], clean, { at: Date.now() });
      writeProgress(all);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/ping') return sendJson(res, 200, { ok: true, at: Date.now() });
  } catch (e) {
    console.error('api error', p, e);
    return sendJson(res, 500, { error: String(e && e.message || e) });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  try { return await serveClient(res, p); } catch (e) { return send(res, 500, String(e && e.message || e)); }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}
server.listen(PORT, HOST, () => {
  console.log('\n  Sailing Books — library server');
  console.log('  ------------------------------------------------');
  console.log(`  On this laptop:  http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  On your phone:   http://${a}:${PORT}`);
  console.log(`\n  Password: ${AUTH.password}${AUTH.generated ? '   (generated — saved to ' + authFile() + ')' : '   (SB_PASSWORD)'}`);
  console.log('  Phone and laptop must be on the same Wi-Fi.\n');
});
