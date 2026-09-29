/* Web/phone client shim.
   Implements the same `window.api` surface the Electron preload exposes, but
   over HTTP against the laptop server (server/server.js). Loaded only in the
   browser; in Electron the real preload wins and this file is never used. */
(function () {
  const SHIM = 'SB_REMOTE';
  if (window.api && !window.api[SHIM]) return;   // Electron preload already there
  const LS = {
    token: 'sb-web-token',
    base: 'sb-web-base',
    book: 'sb-web-book'
  };
  const LOCAL_DB = 'sailing-books-browser-library';
  const localUrls = new Map();
  const q = new URLSearchParams(location.search);
  if (q.get('server')) localStorage.setItem(LS.base, q.get('server').replace(/\/+$/, ''));

  // Same origin unless the page was hosted elsewhere (e.g. Vercel) and a
  // server address was given.
  let base = localStorage.getItem(LS.base) || '';
  function browserLibrary() {
    return !window.SB_SERVED_BY_LAPTOP && (!base || base === location.origin);
  }
  function openLocalDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('This browser does not support local book storage.')); return; }
      const req = indexedDB.open(LOCAL_DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('records')) req.result.createObjectStore('records', { keyPath: 'key' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open local book storage.'));
    });
  }
  async function localGet(key) {
    const db = await openLocalDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction('records', 'readonly').objectStore('records').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Could not read local book storage.'));
    });
  }
  async function localPut(record) {
    const db = await openLocalDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save local book storage.'));
    });
  }
  async function localDelete(key) {
    const db = await openLocalDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not update local book storage.'));
    });
  }
  function localObjectUrl(storedPath, blob) {
    if (!localUrls.has(storedPath)) localUrls.set(storedPath, URL.createObjectURL(blob));
    return localUrls.get(storedPath);
  }
  function localRecordKey(storedPath) {
    const value = String(storedPath || '');
    if (value.startsWith('web:')) return 'file:' + value.slice(4);
    if (value.startsWith('web-cover:')) return 'cover:' + value.slice(10);
    return '';
  }
  function localMime(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    return ({ epub: 'application/epub+zip', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' })[ext] || 'application/octet-stream';
  }
  async function localBytes(storedPath) {
    const key = localRecordKey(storedPath);
    const record = key && await localGet(key);
    if (!record || !record.blob) return new Uint8Array(0);
    return new Uint8Array(await record.blob.arrayBuffer());
  }
  async function cacheLocalUrls(library) {
    const paths = [];
    for (const book of library.books || []) {
      if (book.storedPath) paths.push(book.storedPath);
      if (book.coverPath) paths.push(book.coverPath);
    }
    for (const storedPath of paths) {
      if (localUrls.has(storedPath)) continue;
      const key = localRecordKey(storedPath);
      const record = key && await localGet(key);
      if (record?.blob) localObjectUrl(storedPath, record.blob);
    }
  }
  async function addLocalFile(item, requestedName, batchNames = new Set()) {
    const source = item instanceof Blob ? item : item?.blob;
    const originalName = String(requestedName || item?.name || '').trim();
    if (!(source instanceof Blob) || !originalName) return { error: 'Could not read that book file.' };
    const library = await localGet('library') || { books: [], folders: [] };
    const names = new Set((library.books || []).map(book => String(book.fileName || '').toLowerCase()));
    for (const name of batchNames) names.add(String(name).toLowerCase());
    const dot = originalName.lastIndexOf('.');
    const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
    const suffix = dot > 0 ? originalName.slice(dot) : '';
    let fileName = originalName, index = 1;
    while (names.has(fileName.toLowerCase())) fileName = `${stem} (${index++})${suffix}`;
    batchNames.add(fileName);
    const id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    const storedPath = 'web:' + id;
    const blob = source.slice(0, source.size, source.type || 'application/octet-stream');
    await localPut({ key: 'file:' + id, blob, fileName, size: blob.size });
    localObjectUrl(storedPath, blob);
    return { fileName, storedPath, size: blob.size };
  }
  const api = {
    [SHIM]: true,
    mode: 'web',
    isBrowserLocalLibrary: browserLibrary,
    get base() { return base; },
    setBase(v) { base = String(v || '').replace(/\/+$/, ''); localStorage.setItem(LS.base, base); },

    url(p) { return base + (String(p).startsWith('/api') ? p : '/api' + p); },
    headers() {
      const h = {};
      const tok = localStorage.getItem(LS.token);
      if (tok) h['x-sb-token'] = tok;
      return h;
    },
    async req(path, opts = {}) {
      const headers = Object.assign({}, this.headers(), opts.headers || {});
      const tok = localStorage.getItem(LS.token);
      if (opts.json !== undefined) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
      const r = await fetch(this.url(path), Object.assign({}, opts, { headers }));
      if (r.status === 401) { localStorage.removeItem(LS.token); window.dispatchEvent(new CustomEvent('sb-signed-out')); throw new Error('Not signed in'); }
      if (!r.ok) throw new Error('Request failed: ' + r.status);
      return r;
    },
    async api(path) { return (await this.req(path)).json(); },

    /* ---- auth ---- */
    async login(password) {
      const r = await fetch(this.url('/api/login'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.token) throw new Error(data.error || 'Wrong password');
      localStorage.setItem(LS.token, data.token);
      return data;
    },
    async session() { return this.api('/session'); },
    async logout() { localStorage.removeItem(LS.token); },
    isSignedIn() { return !!localStorage.getItem(LS.token); },

    /* ---- library ---- */
    async getLibraryDir() { return 'Library'; },
    async listLibraryFiles() {
      if (!browserLibrary()) return [];
      const library = await localGet('library') || { books: [] };
      return (library.books || []).map(book => ({ fileName: book.fileName, storedPath: book.storedPath }));
    },
    async importFiles(items) {
      if (!browserLibrary()) return [];
      const results = [];
      const batchNames = new Set();
      for (const item of items || []) results.push(await addLocalFile(item, undefined, batchNames));
      return results;
    },
    async pickFiles() {
      if (!browserLibrary()) throw new Error('Importing is only available in the desktop app');
      return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.multiple = true;
        input.accept = '.epub,.pdf,.mp3,.m4a,.m4b,.wav,.ogg,.opus,.flac,.aac';
        input.style.cssText = 'position:fixed;left:-10000px;top:-10000px';
        document.body.appendChild(input);
        input.onchange = () => { const files = [...(input.files || [])]; input.remove(); resolve(files); };
        input.oncancel = () => { input.remove(); resolve([]); };
        input.click();
      });
    },
    getPathForFile(file) { return browserLibrary() ? file : (file && file.name) || ''; },
    fileUrl(storedPath) {
      const id = String(storedPath || '');
      if (browserLibrary() && localUrls.has(id)) return localUrls.get(id);
      if (id.startsWith('id:')) {
        // <img>, <audio> and pdf.js fetch this URL themselves and cannot send
        // an auth header, so the token has to ride along in the query string.
        return this.url('/api/book/' + encodeURIComponent(id.slice(3)) + '/file') + this.auth();
      }
      return id;
    },
    // A cover is fetched by the book id through its own endpoint, never through
    // the book file. It has to be a usable URL straight away because <img>
    // cannot send the auth header, so the token rides in the query string.
    coverUrl(book) {
      if (!book || !book.id) return '';
      if (browserLibrary()) return book.coverPath && localUrls.get(book.coverPath) || '';
      if (book.hasCover === false) return '';
      return this.url('/api/book/' + encodeURIComponent(book.id) + '/cover') + this.auth();
    },
    auth() {
      const tok = localStorage.getItem(LS.token);
      return tok ? '?token=' + encodeURIComponent(tok) : '';
    },
    async readFileBase64(storedPath) {
      const id = String(storedPath || '');
      if (browserLibrary() && id.startsWith('web:')) {
        const bytes = await localBytes(id);
        let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      }
      if (!id.startsWith('id:')) return id;
      const r = await fetch(this.fileUrl(id), { headers: this.headers() });
      if (!r.ok) throw new Error('Could not read the file (' + r.status + ')');
      const blob = await r.blob();
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
        fr.onerror = () => reject(new Error('Could not read the file'));
        fr.readAsDataURL(blob);
      });
    },
    // Straight bytes, no base64 round trip: a 30 MB EPUB costs 30 MB here
    // instead of 40 MB of string plus the copies that decoding it needs.
    async readFileBytes(storedPath) {
      const id = String(storedPath || '');
      if (browserLibrary() && id.startsWith('web:')) return localBytes(id);
      if (!id.startsWith('id:')) return new Uint8Array(0);
      const r = await fetch(this.fileUrl(id), { headers: this.headers() });
      if (!r.ok) throw new Error('Could not read the file (' + r.status + ')');
      return new Uint8Array(await r.arrayBuffer());
    },
    async fileExists(storedPath) {
      const id = String(storedPath || '');
      if (browserLibrary() && localRecordKey(id)) return !!(await localGet(localRecordKey(id)));
      return id.startsWith('id:');
    },
    async deleteFile(storedPath) {
      if (!browserLibrary()) return true;
      const id = String(storedPath || ''), key = localRecordKey(id);
      if (!key) return true;
      try { await localDelete(key); } catch { return false; }
      const url = localUrls.get(id); if (url) URL.revokeObjectURL(url);
      localUrls.delete(id); return true;
    },
    async saveCloudBook(fileName, bytes, cloudBookId) {
      if (!browserLibrary()) return { error: 'This browser is connected to a laptop library.' };
      const library = await localGet('library') || { books: [], folders: [] };
      if (cloudBookId && (library.books || []).some(book => book.cloudBookId === cloudBookId)) return { alreadyAdded: true, cloudBookId };
      const saved = await addLocalFile({ name: fileName, blob: new Blob([bytes], { type: localMime(fileName) }) }, fileName);
      if (saved?.storedPath && cloudBookId) saved.cloudBookId = cloudBookId;
      return saved;
    },
    // Saving a cover from the phone writes it back to the laptop, so the same
    // cover shows up in the desktop app.
    async saveCover(bookId, dataUrl) {
      if (!dataUrl || !bookId) return null;
      if (browserLibrary()) {
        try {
          const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl));
          if (!match) return null;
          const mime = match[1] || 'image/jpeg';
          const blob = match[2] ? new Blob([Uint8Array.from(atob(match[3]), c => c.charCodeAt(0))], { type: mime }) : new Blob([decodeURIComponent(match[3])], { type: mime });
          const storedPath = 'web-cover:' + bookId;
          await localPut({ key: 'cover:' + bookId, blob });
          const old = localUrls.get(storedPath); if (old) URL.revokeObjectURL(old);
          localUrls.delete(storedPath); localObjectUrl(storedPath, blob);
          return storedPath;
        } catch { return null; }
      }
      try {
        const r = await this.req('/book/' + encodeURIComponent(bookId) + '/cover', { method: 'POST', json: { dataUrl } });
        const out = await r.json().catch(() => ({}));
        return out.ok ? 'id:' + bookId : null;
      } catch { return null; }
    },
    async getAudioMeta(storedPath) {
      if (browserLibrary()) return { duration: null, chapters: [] };
      return this.api('/book/' + encodeURIComponent(String(storedPath).replace(/^id:/, '')) + '/meta');
    },
    async saveLibraryIndex(index) {
      if (!browserLibrary()) return false;
      const library = { key: 'library', books: Array.isArray(index?.books) ? index.books : [], folders: Array.isArray(index?.folders) ? index.folders : [] };
      await localPut(library);
      await cacheLocalUrls(library);
      return true;
    },
    async saveProgress(id, patch) {
      if (browserLibrary()) {
        const library = await localGet('library') || { books: [], folders: [] };
        const book = (library.books || []).find(item => item.id === id);
        if (book) Object.assign(book, patch || {});
        await localPut({ key: 'library', books: library.books || [], folders: library.folders || [] });
        return true;
      }
      return this.req('/book/' + encodeURIComponent(id) + '/progress', { method: 'POST', json: patch });
    },
    async fetchLibrary() {
      if (browserLibrary()) {
        const library = await localGet('library') || { books: [], folders: [] };
        await cacheLocalUrls(library);
        return { books: library.books || [], folders: library.folders || [] };
      }
      return this.api('/library');
    },
    async removeCover(bookId) {
      if (browserLibrary()) return this.deleteFile('web-cover:' + bookId);
      try {
        await fetch(this.url('/api/book/' + encodeURIComponent(bookId) + '/cover') + this.auth(), { method: 'DELETE' });
        return true;
      } catch { return false; }
    }
  };
  window.api = api;
})();
