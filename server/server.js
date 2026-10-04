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
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const SHIM = path.join(ROOT, 'web', 'api-shim.js');
const CLOUD_CLIENT = path.join(RENDERER, 'cloud-client.js');

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
  // Human-typable but long enough to survive a public tunnel (~80 bits).
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  const raw = crypto.randomBytes(24);
  for (let i = 0; i < 20; i++) password += alphabet[raw[i] % alphabet.length];
  const a = { password: process.env.SB_PASSWORD || password, secret: crypto.randomBytes(32).toString('hex') };
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
// Write the index back after something on disk changed (e.g. a cover).
function writeIndex() {
  const cur = readIndex();
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify({
      version: 1, updatedAt: Date.now(),
      books: cur.books, folders: cur.folders
    }));
  } catch (e) { console.warn('write index failed', e); }
  indexCache = { mtime: 0, books: cur.books, folders: cur.folders };
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
      // Covers are addressed by the book id through their own endpoint, not by
      // path. Sending "id:<id>" here used to be read as the book *file*, so
      // every cover pointed at the EPUB, failed to decode as an image and was
      // removed by onerror — which is why no covers appeared in the browser.
      coverPath: null,
      hasCover: !!(b.coverPath && safeInside(COVERS_DIR, b.coverPath))
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

// The client may be hosted elsewhere (Vercel), so it calls us from another
// origin. Auth is a bearer token rather than a cookie, so a wildcard is safe.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-sb-token',
  'access-control-max-age': '86400'
};

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
// The client is the app. If a phone is allowed to hold on to renderer.js, a fix
// that has already shipped never reaches it and it looks like nothing happened,
// so these are always re-fetched. Only the third-party libraries are cacheable.
const CLIENT_NOSTORE = { 'cache-control': 'no-store, must-revalidate' };
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
        // This copy is being served BY the laptop, so the phone is already at the
        // right address: the sign-in gate can hide the address box entirely and a
        // bookmarked tunnel link is all you ever need.
        html = html.replace('<head>', '<head>\n<script>window.SB_SERVED_BY_LAPTOP=1;</script>');
        clientCache.set('index.html', html);
      }
      return send(res, 200, html, Object.assign({ 'content-type': MIME['.html'] }, CLIENT_NOSTORE));
    }
  // The client pulls its libraries from the same place as the desktop app.
  const map = {
    '/styles.css': path.join(RENDERER, 'styles.css'),
    '/renderer.js': path.join(RENDERER, 'renderer.js'),
    '/api-shim.js': SHIM,
    '/login.js': path.join(ROOT, 'web', 'login.js'),
    '/cloud-client.js': CLOUD_CLIENT,
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
  const isVendor = urlPath.startsWith('/node_modules/');
  send(res, 200, body, Object.assign(
    { 'content-type': mimeOf(file) },
    isVendor ? { 'cache-control': 'public, max-age=604800' } : CLIENT_NOSTORE
  ));
}

/* ---------------- routing ---------------- */
const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'Bad request'); }
  const p = url.pathname;

  // Preflight, and CORS on everything (the client may live on Vercel).
  res.setHeader('access-control-allow-origin', CORS['access-control-allow-origin']);
  res.setHeader('access-control-allow-methods', CORS['access-control-allow-methods']);
  res.setHeader('access-control-allow-headers', CORS['access-control-allow-headers']);
  res.setHeader('access-control-max-age', CORS['access-control-max-age']);
  res.setHeader('timing-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

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

  // ---- everything else needs the token (but the sign-in pages themselves must
  // be reachable before you have one) ----
  const needsAuth = p.startsWith('/api/') && p !== '/api/login';
  if (needsAuth) {
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
    if ((m = /^\/api\/book\/([^/]+)\/cover$/.exec(p)) && req.method === 'POST') {
      // A cover set on the phone is written into the laptop's covers folder, so
      // the desktop app shows it too.
      const id = decodeURIComponent(m[1]);
      let patch = {};
      try { patch = JSON.parse(await readBody(req, 12e6)) || {}; } catch {}
      const dm = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s.exec(patch.dataUrl || '');
      const book = readIndex().books.find(x => x.id === id);
      if (!dm || !book) return sendJson(res, 400, { error: 'Unknown book or bad image' });
      const ext = dm[1].includes('png') ? 'png' : dm[1].includes('gif') ? 'gif' : dm[1].includes('webp') ? 'webp' : 'jpg';
      const file = path.join(COVERS_DIR, id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) + '.' + ext);
      try {
        await fsp.writeFile(file, Buffer.from(dm[2], 'base64'));
      } catch (e) {
        return sendJson(res, 500, { error: 'Could not write the cover' });
      }
      if (book.coverPath && book.coverPath !== file) { try { fs.unlinkSync(book.coverPath); } catch {} }
      book.coverPath = file;
      writeIndex();
      return sendJson(res, 200, { ok: true, path: file });
    }
    if ((m = /^\/api\/book\/([^/]+)\/cover$/.exec(p)) && req.method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      const book = readIndex().books.find(x => x.id === id);
      if (book && book.coverPath) {
        try { fs.unlinkSync(book.coverPath); } catch {}
        book.coverPath = null;
        writeIndex();
      }
      return sendJson(res, 200, { ok: true });
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
    // A book from the online library, saved into this computer's library by the
    // Download button in the app or in a browser paired with this computer. The
    // bytes arrive as the request body and the name in the query string.
    if ((m = /^\/api\/book$/.exec(p)) && req.method === 'POST') {
      const wanted = url.searchParams.get('name') || '';
      const cloudBookId = url.searchParams.get('cloudBookId') || '';
      const title = url.searchParams.get('title') || '';
      const author = url.searchParams.get('author') || '';
      if (!wanted) return sendJson(res, 400, { error: 'No file name given' });
      const already = cloudBookId
        ? readIndex().books.find(b => b.cloudBookId === cloudBookId && b.storedPath && fs.existsSync(b.storedPath))
        : null;
      if (already) return sendJson(res, 200, { alreadyAdded: true, fileName: already.fileName, storedPath: already.storedPath, size: fs.statSync(already.storedPath).size });
      const stored = await storeLocalBook(req, wanted);
      try {
        adoptLocalBook({ ...stored, title, author, cloudBookId });
      } catch (error) {
        try { fs.unlinkSync(stored.targetPath); } catch {}
        throw error;
      }
      // The app is usually open. Telling it means the book appears there without
      // waiting for a restart.
      process.emit('sb-cloud-instance-added', { fileName: stored.targetName, storedPath: stored.targetPath, size: stored.size });
      return sendJson(res, 200, { fileName: stored.targetName, storedPath: stored.targetPath, size: stored.size });
    }
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

/* ---------------- optional online-library server agent ---------------- */
/* Take a book that is already sitting in the library folder and give it an entry
 * in the index, keeping every book and folder that was already there. Shared by
 * the cloud instance installer and by a browser asking to add a book, so both
 * land in the library the same way. Returns the record that was added. */
function adoptLocalBook({ targetPath, title, author, type, cloudBookId, cloudJobId }) {
  const targetName = path.basename(targetPath);
  const indexExists = fs.existsSync(INDEX_FILE);
  const current = readIndex();
  const existing = current.books.length ? current : scanLibrary();
  const record = {
    id: crypto.randomUUID(),
    title: String(title || path.basename(targetName, path.extname(targetName))).slice(0, 180),
    author: String(author || '').slice(0, 180),
    type: type || 'epub',
    fileName: targetName, storedPath: targetPath, coverPath: null, folderId: null,
    addedAt: Date.now(), progress: 0, progressSeconds: 0,
    ...(cloudBookId ? { cloudBookId: String(cloudBookId) } : {}),
    ...(cloudJobId ? { cloudJobId } : {})
  };
  const nextBooks = [...existing.books, record];
  const nextFolders = existing.folders || [];
  if (indexExists) {
    indexCache = { mtime: fs.statSync(INDEX_FILE).mtimeMs, books: nextBooks, folders: nextFolders };
    writeIndex();
  } else {
    fs.writeFileSync(INDEX_FILE, JSON.stringify({ version: 1, updatedAt: Date.now(), books: nextBooks, folders: nextFolders }));
    indexCache = { mtime: 0, books: nextBooks, folders: nextFolders };
  }
  return record;
}
// Stream a book into the library folder without ever leaving a half-written file
// behind, then adopt it. Returns the stored name and size.
async function storeLocalBook(stream, fileName) {
  const ext = path.extname(String(fileName || '')).slice(1).toLowerCase();
  if (!LIB_EXTS.includes(ext)) throw new Error('Unsupported book format');
  const safeName = path.basename(String(fileName)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || `book.${ext}`;
  const targetName = uniqueLocalTarget(LIBRARY_DIR, safeName);
  const targetPath = path.join(LIBRARY_DIR, targetName);
  const tempPath = targetPath + '.download-' + crypto.randomBytes(6).toString('hex');
  try {
    await pipeline(stream, fs.createWriteStream(tempPath, { flags: 'wx' }));
    const stat = fs.statSync(tempPath);
    if (stat.size < 1 || stat.size > 2 * 1024 * 1024 * 1024) throw new Error('Book has an invalid size');
    fs.renameSync(tempPath, targetPath);
    return { targetName, targetPath, size: stat.size };
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

async function installCloudInstance(job) {
  if (!job || !job.book || !job.downloadUrl) throw new Error('The cloud job is incomplete');
  const prior = readIndex().books.find(item => item.cloudJobId === job.jobId);
  if (prior && prior.storedPath && fs.existsSync(prior.storedPath)) return path.basename(prior.storedPath);
  const book = job.book;
  const ext = path.extname(String(book.fileName || '')).slice(1).toLowerCase();
  if (!LIB_EXTS.includes(ext)) throw new Error('Unsupported book format');
  const response = await fetch(job.downloadUrl);
  if (!response.ok || !response.body) throw new Error('Could not download the online book');
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 2 * 1024 * 1024 * 1024) throw new Error('Book is larger than the local-copy limit');
  const { targetName, targetPath, size } = await storeLocalBook(Readable.fromWeb(response.body), book.fileName);
  try {
    adoptLocalBook({
      targetPath,
      title: book.title, author: book.author,
      type: ext === 'epub' ? 'epub' : ext === 'pdf' ? 'pdf' : 'audio',
      cloudJobId: job.jobId
    });
  } catch (error) {
    try { fs.unlinkSync(targetPath); } catch {}
    throw error;
  }
  process.emit('sb-cloud-instance-added', { fileName: targetName, storedPath: targetPath, size });
  return targetName;
}
function uniqueLocalTarget(dir, fileName) {
  const ext = path.extname(fileName), base = path.basename(fileName, ext);
  let candidate = fileName, i = 1;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${base} (${i++})${ext}`;
  return candidate;
}
let cloudAgentTimer = null;
function startCloudAgent(config = {}) {
  const id = String(config.id || process.env.SB_CLOUD_SERVER_ID || '');
  const token = String(config.token || process.env.SB_CLOUD_SERVER_TOKEN || '');
  const endpoint = String(process.env.SB_CLOUD_API_URL || 'https://sailingbooks.vercel.app/api/cloud').replace(/\/+$/, '');
  if (!id || token.length < 30) return;
  if (cloudAgentTimer) clearInterval(cloudAgentTimer);
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const response = await fetch(`${endpoint}/servers/${encodeURIComponent(id)}/agent/jobs`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}'
      });
      if (!response.ok) throw new Error(`Cloud agent returned ${response.status}`);
      const data = await response.json();
      for (const job of data.jobs || []) {
        let error = '';
        try { await installCloudInstance(job); }
        catch (e) { error = String(e && e.message || e); console.error('Online local-copy failed:', error); }
        try {
          await fetch(`${endpoint}/servers/${encodeURIComponent(id)}/agent/complete`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: job.jobId, error })
          });
        } catch (e) { console.warn('Could not report local-copy status:', e && e.message); }
      }
    } catch (error) {
      console.warn('Online server agent is not connected:', error && error.message || error);
    } finally { running = false; }
  };
  poll();
  cloudAgentTimer = setInterval(poll, 25000);
  cloudAgentTimer.unref();
}
function stopCloudAgent() {
  if (cloudAgentTimer) clearInterval(cloudAgentTimer);
  cloudAgentTimer = null;
}
// Exposing this to the internet with a weak password would be a bad idea, so
// make that an explicit choice.
if (process.env.SB_REQUIRE_PASSWORD === '1' && AUTH.generated) {
  console.error('\n  Refusing to start: set SB_PASSWORD before exposing this to the internet.');
  console.error('  Example (PowerShell):  $env:SB_PASSWORD="something long and private"\n');
  process.exit(1);
}
// If we were started by server/tunnel.js, don't outlive it: on Windows a
// killed parent never runs its cleanup, which would leave this holding the port.
if (process.env.SB_PARENT_PID) {
  const parentPid = +process.env.SB_PARENT_PID;
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch { console.log('  parent gone — shutting down.'); process.exit(0); }
  }, 4000).unref();
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — Sailing Books may already be running,`);
    console.error(`  or another program has it. Try another port:  set SB_PORT=9000 && npm run server\n`);
  } else if (e && e.code === 'EACCES') {
    console.error(`\n  Not allowed to listen on port ${PORT}. Try a port above 1024:  set SB_PORT=9000\n`);
  } else {
    console.error('\n  Server error:', e && e.message ? e.message : e, '\n');
  }
  if (!process.env.SB_DESKTOP_EMBEDDED) process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log('\n  Sailing Books — library server');
  console.log('  ------------------------------------------------');
  console.log(`  On this laptop:  http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  On your phone:   http://${a}:${PORT}   (same Wi-Fi)`);
  if (!process.env.SB_DESKTOP_EMBEDDED) console.log(`\n  Password: ${AUTH.password}${AUTH.generated ? '   (generated — saved to ' + authFile() + ')' : '   (SB_PASSWORD)'}`);
  if (!process.env.SB_PASSWORD) console.log('  Want to reach it from anywhere? Run:  npm run tunnel');
  console.log('  The laptop must stay on and awake while the phone is reading.\n');
  startCloudAgent();
});

module.exports = { startAgent: startCloudAgent, stopAgent: stopCloudAgent };
