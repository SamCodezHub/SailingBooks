/* Sailing Books Archives — a private, single-admin archive that lives entirely
 * on this laptop.
 *
 *   %APPDATA%\Sailing Books\Archives\
 *     Books\      uploaded files, as uploaded
 *     Covers\     extracted cover images
 *     index.json  items + sets
 *
 * A "set" groups books with a folder (name + colour) and a flowchart, and can
 * be installed straight into the library — the books are copied into the
 * Library folder and the folder + its nodes come with them, so the desktop app
 * picks the whole thing up on its next launch.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const LIB_EXTS = ['epub', 'pdf', 'mp3', 'm4a', 'm4b', 'wav', 'ogg', 'opus', 'flac', 'aac'];
const MIME = {
  epub: 'application/epub+zip', pdf: 'application/pdf', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', m4b: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac'
};

function create(ctx) {
  const { userDataDir, sendJson, send, readBody, verifyToken, sign } = ctx;
  const DIR = path.join(userDataDir(), 'Archives');
  const BOOKS = path.join(DIR, 'Books');
  const COVERS = path.join(DIR, 'Covers');
  const INDEX = path.join(DIR, 'index.json');
  const ADMIN = 'admin';
  for (const d of [DIR, BOOKS, COVERS]) fs.mkdirSync(d, { recursive: true });

  function read() {
    try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return { items: [], sets: [] }; }
  }
  function write(db) {
    fs.writeFileSync(INDEX, JSON.stringify({ version: 1, updatedAt: Date.now(), items: db.items || [], sets: db.sets || [] }, null, 1));
  }
  const extOf = (n) => (String(n).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const typeOf = (e) => (e === 'epub' ? 'epub' : e === 'pdf' ? 'pdf' : 'audio');

  // Audio covers + chapters are read here on the laptop, where music-metadata
  // works natively. EPUB/PDF covers appear once a set is installed, because the
  // normal enrichment then runs on the real library files.
  async function audioMeta(file) {
    try {
      const mm = require('music-metadata');
      const m = await mm.parseFile(file, { duration: true, includeChapters: true });
      const chapters = Array.isArray(m.format.chapters)
        ? m.format.chapters.filter(c => c && isFinite(c.start))
          .map(c => ({ title: String(c.title || '').slice(0, 120), start: +c.start, end: isFinite(c.end) ? +c.end : null }))
        : [];
      const pic = m.common.picture && m.common.picture[0];
      let cover = null;
      if (pic && pic.data && pic.data.length > 512 && pic.data.length < 8 * 1024 * 1024) {
        const mime = pic.format && pic.format.includes('/') ? pic.format : 'image/jpeg';
        cover = { mime, b64: Buffer.from(pic.data).toString('base64') };
      }
      return { duration: isFinite(m.format.duration) ? +m.format.duration : null, chapters, cover, title: m.common.title || null, artist: m.common.artist || null };
    } catch {
      return { duration: null, chapters: [], cover: null };
    }
  }

  function saveCover(bookId, cover) {
    if (!cover || !cover.b64) return null;
    const ext = cover.mime.includes('png') ? 'png' : cover.mime.includes('gif') ? 'gif' : 'jpg';
    const file = path.join(COVERS, bookId + '.' + ext);
    try { fs.writeFileSync(file, Buffer.from(cover.b64, 'base64')); return file; } catch { return null; }
  }

  // Streams the upload straight to disk so a 2 GB audiobook never sits in RAM.
  function receiveUpload(name, req) {
    return new Promise((resolve, reject) => {
      const safe = String(name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'book.bin';
      const file = path.join(BOOKS, safe);
      const out = fs.createWriteStream(file);
      let size = 0;
      req.on('data', c => { size += c.length; });
      req.on('error', reject);
      out.on('error', reject);
      req.pipe(out);
      out.on('finish', () => resolve({ file, name: safe, size }));
    });
  }

  function publicItem(it) {
    return {
      id: it.id, title: it.title, author: it.author || '', type: it.type,
      fileName: it.fileName, size: it.size, addedAt: it.addedAt,
      duration: it.duration || 0, chapters: it.chapters || null
    };
  }
  function publicSet(s, db) {
    return {
      id: s.id, name: s.name, color: s.color || '#d9f2d0', createdAt: s.createdAt,
      itemIds: s.itemIds || [], nodes: s.nodes || [], edges: s.edges || [],
      sections: s.sections || [], installedAt: s.installedAt || null,
      items: (s.itemIds || []).map(id => { const it = db.items.find(x => x.id === id); return it ? publicItem(it) : null; }).filter(Boolean)
    };
  }

  async function handle(req, res, url, p) {
    // --- sign in: one account, the server password ---
    if (p === '/api/archive/login' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch {}
      const user = String(body.username || '').trim().toLowerCase();
      const pass = String(body.password || '');
      if (user !== ADMIN || !pass || pass.length !== ctx.password().length
        || !crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ctx.password()))) {
        return sendJson(res, 401, { error: 'Wrong username or password' });
      }
      return sendJson(res, 200, { token: sign(Date.now() + 30 * 24 * 3600 * 1000), user: ADMIN });
    }

    // --- everything below needs the token ---
    if (!verifyToken(req.headers['x-sb-token'] || url.searchParams.get('token') || '')) {
      return sendJson(res, 401, { error: 'Not signed in' });
    }

    const db = read();
    const match = (re) => { const x = re.exec(p); return x ? x[1] : null; };

    if ((/^\/api\/archive\/upload$/.exec(p)) && req.method === 'POST') {
      const rawName = decodeURIComponent(url.searchParams.get('name') || '');
      const ext = extOf(rawName);
      if (!LIB_EXTS.includes(ext)) return sendJson(res, 400, { error: 'That file type is not a book' });
      let saved;
      try { saved = await receiveUpload(rawName, req); } catch (e) {
        return sendJson(res, 500, { error: 'Upload failed: ' + (e.message || e) });
      }
      if (!saved.size) { try { fs.unlinkSync(saved.file); } catch {} return sendJson(res, 400, { error: 'Empty file' }); }
      const id = crypto.createHash('sha1').update(saved.file + saved.size).digest('hex').slice(0, 14);
      const meta = saved.name.toLowerCase().match(/\.(mp3|m4a|m4b|wav|ogg|opus|flac|aac)$/)
        ? await audioMeta(saved.file) : { duration: null, chapters: [], cover: null, title: null, artist: null };
      const coverPath = saveCover(id, meta.cover);
      const item = {
        id, title: meta.title || saved.name.replace(/\.[^.]+$/, ''), author: meta.artist || '',
        type: typeOf(ext), fileName: saved.name, size: saved.size, addedAt: Date.now(),
        stored: path.relative(BOOKS, saved.file), coverPath: coverPath || null,
        duration: meta.duration, chapters: meta.chapters
      };
      db.items = db.items.filter(x => x.id !== id);
      db.items.unshift(item);
      write(db);
      return sendJson(res, 200, { ok: true, item: publicItem(item), cover: !!coverPath });
    }

    if (p === '/api/archive' && req.method === 'GET') {
      return sendJson(res, 200, {
        dir: DIR, user: ADMIN,
        items: db.items.map(publicItem),
        sets: (db.sets || []).map(s => publicSet(s, db))
      });
    }

    if (match(/^\/api\/archive\/item\/([^/]+)$/) && req.method === 'DELETE') {
      const id = decodeURIComponent(match(/^\/api\/archive\/item\/([^/]+)$/));
      const it = db.items.find(x => x.id === id);
      if (it) {
        try { fs.unlinkSync(path.join(BOOKS, it.stored)); } catch {}
        if (it.coverPath) { try { fs.unlinkSync(it.coverPath); } catch {} }
        db.items = db.items.filter(x => x.id !== id);
        db.sets.forEach(s => { s.itemIds = (s.itemIds || []).filter(x => x !== id); });
        write(db);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/archive/set' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch {}
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return sendJson(res, 400, { error: 'Give the set a name' });
      const set = {
        id: 'set_' + crypto.randomBytes(5).toString('hex'),
        name, color: body.color || '#d9f2d0', createdAt: Date.now(),
        itemIds: (body.itemIds || []).filter(id => db.items.some(x => x.id === id)),
        nodes: Array.isArray(body.nodes) ? body.nodes.slice(0, 200) : [],
        edges: Array.isArray(body.edges) ? body.edges.slice(0, 400) : [],
        sections: Array.isArray(body.sections) ? body.sections.slice(0, 100) : []
      };
      db.sets = db.sets || [];
      db.sets.unshift(set);
      write(db);
      return sendJson(res, 200, { ok: true, set: publicSet(set, db) });
    }

    if (match(/^\/api\/archive\/set\/([^/]+)$/) && req.method === 'DELETE') {
      const id = decodeURIComponent(match(/^\/api\/archive\/set\/([^/]+)$/));
      db.sets = (db.sets || []).filter(s => s.id !== id);
      write(db);
      return sendJson(res, 200, { ok: true });
    }

    // --- install a set: books into the Library, folder + flowchart into the index ---
    if (match(/^\/api\/archive\/install\/([^/]+)$/) && req.method === 'POST') {
      const set = (db.sets || []).find(s => s.id === decodeURIComponent(match(/^\/api\/archive\/install\/([^/]+)$/)));
      if (!set) return sendJson(res, 404, { error: 'No such set' });
      const idx = ctx.readIndex();
      const folderId = 'arcf_' + set.id;
      let added = 0, skipped = 0;
      const bookIds = [];
      for (const id of set.itemIds) {
        const it = db.items.find(x => x.id === id);
        if (!it) continue;
        const src = path.join(BOOKS, it.stored);
        if (!fs.existsSync(src)) { skipped++; continue; }
        const dest = path.join(ctx.libraryDir(), it.fileName);
        if (!fs.existsSync(dest)) { try { fs.copyFileSync(src, dest); } catch { skipped++; continue; } }
        const bookId = 'arc_' + it.id;
        bookIds.push(bookId);
        if (!idx.books.some(b => b.id === bookId)) {
          idx.books.push({
            id: bookId, title: it.title, author: it.author || '', type: it.type,
            fileName: it.fileName, storedPath: dest, coverPath: it.coverPath || null,
            folderId, addedAt: it.addedAt, progress: 0, chapters: it.chapters || null
          });
          added++;
        }
      }
      if (!idx.folders.some(f => f.id === folderId)) {
        idx.folders.push({
          id: folderId, name: set.name, color: set.color, createdAt: Date.now(),
          nodes: set.nodes || [], edges: set.edges || [], sections: set.sections || []
        });
      }
      ctx.writeIndex({ version: 1, books: idx.books, folders: idx.folders });
      set.installedAt = Date.now();
      write(db);
      return sendJson(res, 200, { ok: true, added, skipped, books: bookIds.length, folderId });
    }

    // --- download a set as one archive (books + a manifest the app can read) ---
    if (match(/^\/api\/archive\/zip\/([^/]+)$/)) {
      const set = (db.sets || []).find(s => s.id === decodeURIComponent(match(/^\/api\/archive\/zip\/([^/]+)$/)));
      if (!set) return send(res, 404, 'No such set');
      const JSZip = require('jszip');
      const zip = new JSZip();
      const manifest = {
        app: 'sailing-books', version: 1, name: set.name, color: set.color,
        nodes: set.nodes || [], edges: set.edges || [], sections: set.sections || [],
        books: []
      };
      for (const id of set.itemIds) {
        const it = db.items.find(x => x.id === id);
        if (!it) continue;
        const src = path.join(BOOKS, it.stored);
        if (!fs.existsSync(src)) continue;
        zip.file(it.fileName, fs.readFileSync(src));
        manifest.books.push({ title: it.title, author: it.author, type: it.type, fileName: it.fileName, duration: it.duration || 0, chapters: it.chapters || null });
      }
      zip.file('manifest.json', JSON.stringify(manifest, null, 1));
      if (!set.nodes.length && !set.edges.length) zip.file('README.txt', `Sailing Books set: ${set.name}\nOpen each file in Sailing Books.\n`);
      const file = `${set.name.replace(/[^\w -]+/g, '').trim() || 'set'}-sailing-books.zip`;
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${file}"`,
        'cache-control': 'no-store'
      });
      return zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true }).pipe(res);
    }

    return sendJson(res, 404, { error: 'Unknown archive request' });
  }

  return { handle, dir: DIR };
}

module.exports = { create };
