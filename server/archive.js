/* Sailing Books Archives — a plain shelf of books that lives on this laptop.
 *
 *   %APPDATA%\Sailing Books\Archives\
 *     Books\      the books, exactly as they arrived
 *     Covers\     cover images pulled out of audio files
 *     index.json  what is on the shelf
 *
 * No folders, no flowcharts, no sets: a book goes up, a book comes down, and
 * you drag it into the app like any other import.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const LIB_EXTS = ['epub', 'pdf', 'mp3', 'm4a', 'm4b', 'wav', 'ogg', 'opus', 'flac', 'aac'];
const ADMIN = 'admin';

function create(ctx) {
  const { userDataDir, sendJson, send, readBody, verifyToken, sign, readIndex } = ctx;
  const DIR = path.join(userDataDir(), 'Archives');
  const BOOKS = path.join(DIR, 'Books');
  const COVERS = path.join(DIR, 'Covers');
  const INDEX = path.join(DIR, 'index.json');
  for (const d of [DIR, BOOKS, COVERS]) fs.mkdirSync(d, { recursive: true });

  const extOf = (n) => (String(n).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const typeOf = (e) => (e === 'epub' ? 'epub' : e === 'pdf' ? 'pdf' : 'audio');
  const safeName = (n) => String(n || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'book';

  function read() {
    try { const j = JSON.parse(fs.readFileSync(INDEX, 'utf8')); return { items: Array.isArray(j.items) ? j.items : [] }; }
    catch { return { items: [] }; }
  }
  function write(db) {
    fs.writeFileSync(INDEX, JSON.stringify({ version: 1, updatedAt: Date.now(), items: db.items }, null, 1));
  }
  const publicItem = (it) => ({
    id: it.id, title: it.title, author: it.author || '', type: it.type,
    fileName: it.fileName, size: it.size, addedAt: it.addedAt,
    duration: it.duration || 0, chapters: (it.chapters || []).length || 0
  });

  // Titles, covers and chapters for audio are read here, where music-metadata
  // works. EPUB/PDF details arrive when the book is imported into the app.
  async function audioMeta(file) {
    try {
      const mm = require('music-metadata');
      const m = await mm.parseFile(file, { duration: true, includeChapters: true });
      const chapters = Array.isArray(m.format.chapters)
        ? m.format.chapters.filter(c => c && isFinite(c.start))
          .map(c => ({ title: String(c.title || '').slice(0, 120), start: +c.start, end: isFinite(c.end) ? +c.end : null }))
        : [];
      const pic = m.common.picture && m.common.picture[0];
      const cover = pic && pic.data && pic.data.length > 512 && pic.data.length < 8 * 1024 * 1024
        ? { mime: pic.format && pic.format.includes('/') ? pic.format : 'image/jpeg', b64: Buffer.from(pic.data).toString('base64') }
        : null;
      return {
        duration: isFinite(m.format.duration) ? +m.format.duration : null,
        chapters, cover, title: m.common.title || null, artist: m.common.artist || null
      };
    } catch {
      return { duration: null, chapters: [], cover: null, title: null, artist: null };
    }
  }
  function saveCover(id, cover) {
    if (!cover || !cover.b64) return null;
    const ext = cover.mime.includes('png') ? 'png' : cover.mime.includes('gif') ? 'gif' : 'jpg';
    const file = path.join(COVERS, id + '.' + ext);
    try { fs.writeFileSync(file, Buffer.from(cover.b64, 'base64')); return file; } catch { return null; }
  }

  // A book that arrived as a file on disk: describe it and put it on the shelf.
  async function addFile(srcPath, fileName) {
    const name = safeName(fileName || path.basename(srcPath));
    const ext = extOf(name);
    if (!LIB_EXTS.includes(ext)) return { error: 'That file type is not a book' };
    let size = 0;
    try { size = fs.statSync(srcPath).size; } catch { return { error: 'Could not read that file' }; }
    if (!size) return { error: 'That file is empty' };
    const dest = path.join(BOOKS, name);
    if (path.resolve(srcPath) !== path.resolve(dest)) {
      try { fs.copyFileSync(srcPath, dest); } catch (e) { return { error: 'Copy failed: ' + e.message }; }
    }
    const id = crypto.createHash('sha1').update(name + '|' + size).digest('hex').slice(0, 14);
    const meta = ext === 'epub' || ext === 'pdf'
      ? { duration: null, chapters: [], cover: null, title: null, artist: null }
      : await audioMeta(dest);
    const item = {
      id, title: meta.title || name.replace(/\.[^.]+$/, ''), author: meta.artist || '',
      type: typeOf(ext), fileName: name, size, addedAt: Date.now(),
      stored: name, coverPath: saveCover(id, meta.cover),
      duration: meta.duration, chapters: meta.chapters
    };
    const db = read();
    db.items = db.items.filter(x => x.id !== id);
    db.items.unshift(item);
    write(db);
    return { item: publicItem(item) };
  }

  // Uploaded from a device: stream to disk so a 1 GB book never sits in memory.
  function receiveUpload(name, req) {
    return new Promise((resolve, reject) => {
      const file = path.join(BOOKS, safeName(name));
      const out = fs.createWriteStream(file);
      let size = 0;
      req.on('data', c => { size += c.length; });
      req.on('error', reject);
      out.on('error', reject);
      req.pipe(out);
      out.on('finish', () => resolve({ file, name: path.basename(file), size }));
    });
  }

  function findItem(id) {
    const db = read();
    return { db, item: db.items.find(x => x.id === id) || null };
  }

  async function handle(req, res, url, p) {
    // --- sign in: one account ---
    if (p === '/api/archive/login' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch {}
      const user = String(body.username || '').trim().toLowerCase();
      const pass = String(body.password || '');
      const want = ctx.password();
      const ok = user === ADMIN && pass.length === want.length
        && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(want));
      if (!ok) return sendJson(res, 401, { error: 'Wrong username or password' });
      return sendJson(res, 200, { token: sign(Date.now() + 30 * 24 * 3600 * 1000), user: ADMIN });
    }

    if (!verifyToken(req.headers['x-sb-token'] || url.searchParams.get('token') || '')) {
      return sendJson(res, 401, { error: 'Not signed in' });
    }
    const m = (re) => { const x = re.exec(p); return x ? decodeURIComponent(x[1]) : null; };

    // --- the shelf ---
    if (p === '/api/archive' && req.method === 'GET') {
      const db = read();
      return sendJson(res, 200, { dir: DIR, user: ADMIN, items: db.items.map(publicItem) });
    }

    // --- send a book here from a device ---
    if (p === '/api/archive/upload' && req.method === 'POST') {
      const rawName = url.searchParams.get('name') || '';
      if (!LIB_EXTS.includes(extOf(rawName))) return sendJson(res, 400, { error: 'That file type is not a book' });
      let got;
      try { got = await receiveUpload(rawName, req); } catch (e) {
        return sendJson(res, 500, { error: 'Upload failed: ' + (e.message || e) });
      }
      if (!got.size) { try { fs.unlinkSync(got.file); } catch {} return sendJson(res, 400, { error: 'That file is empty' }); }
      const out = await addFile(got.file, got.name);
      if (out.error) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, { ok: true, item: out.item });
    }

    // --- export a book that is already in the library (the server copies it,
    //     so nothing has to travel through the browser) ---
    if ((m(/^\/api\/archive\/export\/([^/]+)$/)) && req.method === 'POST') {
      const bookId = m(/^\/api\/archive\/export\/([^/]+)$/);
      const rec = (readIndex().books || []).find(b => b && b.id === bookId);
      if (!rec || !rec.storedPath) return sendJson(res, 404, { error: 'That book is not in the library' });
      if (!fs.existsSync(rec.storedPath)) return sendJson(res, 404, { error: 'The file is missing from the Library folder' });
      const out = await addFile(rec.storedPath, rec.fileName || path.basename(rec.storedPath));
      if (out.error) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, { ok: true, item: out.item });
    }

    // --- take a book off the shelf ---
    if ((m(/^\/api\/archive\/item\/([^/]+)$/)) && req.method === 'DELETE') {
      const id = m(/^\/api\/archive\/item\/([^/]+)$/);
      const db = read();
      const it = db.items.find(x => x.id === id);
      if (it) {
        try { fs.unlinkSync(path.join(BOOKS, it.stored)); } catch {}
        if (it.coverPath) { try { fs.unlinkSync(it.coverPath); } catch {} }
        db.items = db.items.filter(x => x.id !== id);
        write(db);
      }
      return sendJson(res, 200, { ok: true });
    }

    // --- download a book ---
    if ((m(/^\/api\/archive\/download\/([^/]+)$/))) {
      const id = m(/^\/api\/archive\/download\/([^/]+)$/);
      const { item } = findItem(id);
      if (!item) return send(res, 404, 'No such book');
      const file = path.join(BOOKS, item.stored);
      if (!fs.existsSync(file)) return send(res, 404, 'The file is missing from the archive');
      const st = fs.statSync(file);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': st.size,
        'content-disposition': `attachment; filename="${item.fileName.replace(/"/g, '')}"`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
      });
      return fs.createReadStream(file).pipe(res);
    }

    return sendJson(res, 404, { error: 'Unknown archive request' });
  }

  return { handle, dir: DIR };
}

module.exports = { create };
