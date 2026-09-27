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
  const q = new URLSearchParams(location.search);
  if (q.get('server')) localStorage.setItem(LS.base, q.get('server').replace(/\/+$/, ''));

  // Same origin unless the page was hosted elsewhere (e.g. Vercel) and a
  // server address was given.
  let base = localStorage.getItem(LS.base) || '';
  const api = {
    [SHIM]: true,
    mode: 'web',
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
    // Books live on the laptop already; there is nothing to adopt here.
    async listLibraryFiles() { return []; },
    async importFiles() { return []; },
    async pickFiles() { throw new Error('Importing is only available in the desktop app'); },
    getPathForFile(file) { return (file && file.name) || ''; },
    fileUrl(storedPath) {
      const id = String(storedPath || '');
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
      if (book.hasCover === false) return '';
      return this.url('/api/book/' + encodeURIComponent(book.id) + '/cover') + this.auth();
    },
    auth() {
      const tok = localStorage.getItem(LS.token);
      return tok ? '?token=' + encodeURIComponent(tok) : '';
    },
    async readFileBase64(storedPath) {
      const id = String(storedPath || '');
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
      if (!id.startsWith('id:')) return new Uint8Array(0);
      const r = await fetch(this.fileUrl(id), { headers: this.headers() });
      if (!r.ok) throw new Error('Could not read the file (' + r.status + ')');
      return new Uint8Array(await r.arrayBuffer());
    },
    async fileExists(storedPath) { return !!String(storedPath || '').startsWith('id:'); },
    async deleteFile() { return true; },
    // Saving a cover from the phone writes it back to the laptop, so the same
    // cover shows up in the desktop app.
    async saveCover(bookId, dataUrl) {
      if (!dataUrl || !bookId) return null;
      try {
        const r = await this.req('/book/' + encodeURIComponent(bookId) + '/cover', { method: 'POST', json: { dataUrl } });
        const out = await r.json().catch(() => ({}));
        return out.ok ? 'id:' + bookId : null;
      } catch { return null; }
    },
    async getAudioMeta(storedPath) { return this.api('/book/' + encodeURIComponent(String(storedPath).replace(/^id:/, '')) + '/meta'); },
    async saveLibraryIndex() { return false; },
    async saveProgress(id, patch) {
      return this.req('/book/' + encodeURIComponent(id) + '/progress', { method: 'POST', json: patch });
    },
    async fetchLibrary() { return this.api('/library'); },
    async removeCover(bookId) {
      try {
        await fetch(this.url('/api/book/' + encodeURIComponent(bookId) + '/cover') + this.auth(), { method: 'DELETE' });
        return true;
      } catch { return false; }
    }
  };
  window.api = api;
})();
