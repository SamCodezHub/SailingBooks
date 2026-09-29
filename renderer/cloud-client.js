/* Shared cloud account + online-library UI for Electron and the hosted web app.
 * Secrets never ship to this file; only the public Supabase URL and anon key do. */
(function () {
  const ACCOUNT_KEY = 'sb-cloud-session-v1';
  const API_BASE = 'https://sailingbooks.vercel.app/api/cloud';
  const $ = (selector) => document.querySelector(selector);
  const enc = encodeURIComponent;
  let cloudConfig = null;
  let session = null;
  let isSignup = false;
  let books = [];
  let servers = [];
  let account = null;
  let refreshPromise = null;
  const hostedLanding = !!(window.api && window.api.mode === 'web' && !window.SB_SERVED_BY_LAPTOP);

  function apiBase() {
    // Keep hosted builds on their own origin, including Vercel preview/custom
    // domains. That avoids cross-origin preflights for the account API. A page
    // served by the laptop or Electron still uses the production cloud API.
    if (location.protocol !== 'file:' && !window.SB_SERVED_BY_LAPTOP) return location.origin + '/api/cloud';
    return API_BASE;
  }
  function setMessage(id, message, kind = '') {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('bad', kind === 'bad');
    el.classList.toggle('good', kind === 'good');
  }
  function invalidRefreshToken(error) {
    const message = String(error && (error.message || error.code) || '').toLowerCase();
    return message.includes('refresh token') && /invalid|not found|already used|reuse|revoked|expired/.test(message);
  }
  async function expireSession() {
    await sessionSave(null);
    account = null; books = []; servers = [];
    updateAccountButton();
    showAuthMode(false);
    setPage('landing');
    setMessage('#cloudAuthError', 'Your sign-in expired. Your books are safe; sign in again to continue.', 'bad');
  }
  async function sessionRead() {
    if (!window.api?.mode && window.api?.getCloudSession) return await window.api.getCloudSession();
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null'); } catch { return null; }
  }
  async function sessionSave(value) {
    session = value || null;
    if (!window.api?.mode && window.api?.saveCloudSession) {
      await window.api.saveCloudSession(session);
      return;
    }
    try { if (session) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(session)); else localStorage.removeItem(ACCOUNT_KEY); } catch {}
  }
  function setPage(page) {
    const library = $('#libraryView'), reader = $('#readerView'), landing = $('#cloudLanding'), online = $('#onlineLibraryView');
    if (reader && !reader.classList.contains('hidden') && page !== 'local' && window.closeReader) window.closeReader();
    library?.classList.toggle('hidden', page !== 'local');
    reader?.classList.toggle('hidden', page !== 'reader');
    landing?.classList.toggle('hidden', page !== 'landing');
    online?.classList.toggle('hidden', page !== 'online');
    $('#libraryNav')?.classList.toggle('hidden', (hostedLanding && page === 'landing') || page === 'reader');
    $('#searchInput')?.classList.toggle('hidden', page !== 'local');
    $('#btnSettings')?.classList.toggle('hidden', page === 'landing');
    $('#btnAccount')?.classList.toggle('hidden', page === 'landing');
    $('#navLocalLibrary')?.classList.toggle('active', page === 'local');
    $('#navOnlineLibrary')?.classList.toggle('active', page === 'online');
    if (page === 'online' && session) refreshOnline().catch((error) => setMessage('#cloudUploadStatus', error.message, 'bad'));
  }
  async function loadConfig() {
    if (cloudConfig) return cloudConfig;
    let response;
    try { response = await fetch(apiBase() + '/config', { cache: 'no-store' }); }
    catch { throw new Error('Could not reach the Sailing Books account service. Check your connection and refresh the page.'); }
    if (!response.ok) throw new Error('Could not load the account service.');
    cloudConfig = await response.json();
    if (!cloudConfig.configured) throw new Error('Online Library is waiting for its Supabase setup. Add the project URL, anon key, and service key to Vercel, then run the database setup SQL.');
    if (cloudConfig.serviceReady === false) throw new Error('The account server key cannot access the library tables. In Vercel Production, set SB_SUPABASE_SERVICE_ROLE_KEY to the Supabase secret key (sb_secret_…) or legacy service_role key, then redeploy.');
    return cloudConfig;
  }
  async function authCall(path, body, token) {
    const cfg = await loadConfig();
    let response;
    try {
      response = await fetch(cfg.url + '/auth/v1/' + path, {
        method: 'POST', headers: { apikey: cfg.anonKey, 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body)
      });
    } catch { throw new Error('Could not reach the sign-in service. Check your connection and try again.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.msg || data.message || data.error_description || data.error || 'Account request failed.');
      error.status = response.status;
      error.code = data.code || data.error || data.error_description || '';
      throw error;
    }
    return data;
  }
  async function rotateToken() {
    const latest = await sessionRead();
    if (latest?.refresh_token && latest.refresh_token !== session?.refresh_token && Number(latest.expires_at || 0) >= Date.now() + 30000) {
      session = latest;
      return session;
    }
    if (!session?.refresh_token) throw new Error('Your session ended. Please sign in again.');
    const fresh = await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    await sessionSave({ ...fresh, expires_at: Date.now() + Number(fresh.expires_in || 3600) * 1000 });
    return session;
  }
  async function refreshToken() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const runWithLock = async () => {
          const latest = await sessionRead();
          if (latest?.refresh_token && latest.refresh_token !== session?.refresh_token && Number(latest.expires_at || 0) >= Date.now() + 30000) {
            session = latest;
            return session;
          }
          return rotateToken();
        };
        if (navigator.locks?.request) {
          try { return await navigator.locks.request('sailing-books-cloud-session-refresh', runWithLock); }
          catch (error) { if (error?.name !== 'SecurityError') throw error; }
        }
        return await runWithLock();
      } catch (error) {
        if (invalidRefreshToken(error)) {
          await expireSession();
          throw new Error('Your sign-in expired. Your books are safe; sign in again to continue.');
        }
        throw error;
      }
    })();
    try { return await refreshPromise; }
    finally { refreshPromise = null; }
  }
  async function accessToken() {
    if (!session?.access_token) {
      await expireSession();
      throw new Error('Sign in to continue.');
    }
    if (Number(session.expires_at || 0) < Date.now() + 30000) await refreshToken();
    return session.access_token;
  }
  async function api(path, options = {}, retry = true) {
    const token = await accessToken();
    let response;
    try {
      response = await fetch(apiBase() + path, {
        ...options, headers: { ...(options.body && !(options.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}), Authorization: 'Bearer ' + token }
      });
    } catch { throw new Error('Could not reach the Sailing Books cloud service. Check your connection and try again.'); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && retry && session?.refresh_token) { await refreshToken(); return api(path, options, false); }
    if (response.status === 401) {
      await expireSession();
      throw new Error('Your sign-in expired. Your books are safe; sign in again to continue.');
    }
    if (!response.ok) {
      let route = apiBase() + path;
      try { route = new URL(route, location.href).pathname; } catch {}
      throw new Error(data.error || `Cloud request failed (${response.status}) at ${route}.`);
    }
    return data;
  }
  function ext(name) { return String(name || '').split('.').pop().toLowerCase(); }
  function typeFor(name) { const e = ext(name); return e === 'epub' ? 'epub' : e === 'pdf' ? 'pdf' : ['mp3','m4a','m4b','wav','ogg','opus','flac','aac'].includes(e) ? 'audio' : ''; }
  function mimeFor(name) {
    const e = ext(name);
    return ({ epub: 'application/epub+zip', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' })[e] || 'application/octet-stream';
  }
  function humanBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || Number.isInteger(v) ? 0 : 1) + ' ' + units[i];
  }
  function esc(value) { return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function updateAccountButton() {
    const btn = $('#btnAccount');
    if (btn) btn.textContent = account?.user?.email ? account.user.email.split('@')[0] : 'Sign in';
    $('#cloudIdentity').textContent = account?.user?.email || '';
    $('#libraryNav')?.classList.toggle('hidden', hostedLanding && !session);
  }
  function showAuthMode(signup) {
    isSignup = !!signup;
    $('#cloudAuthEyebrow').textContent = isSignup ? 'MAKE IT YOURS' : 'WELCOME BACK';
    $('#cloudAuthTitle').textContent = isSignup ? 'Create your account' : 'Sign in to your library';
    $('#cloudAuthSub').textContent = isSignup ? 'Start with 1 GB of private online book storage.' : 'Your local books stay on this computer.';
    $('#cloudPassword').autocomplete = isSignup ? 'new-password' : 'current-password';
    $('#cloudAuthSubmit').textContent = isSignup ? 'Create account' : 'Sign in';
    $('#cloudAuthToggle').textContent = isSignup ? 'Already have an account? Sign in' : 'New here? Create an account';
    setMessage('#cloudAuthError', '');
  }
  async function submitAuth(event) {
    event.preventDefault();
    const email = $('#cloudEmail').value.trim(), password = $('#cloudPassword').value;
    const submit = $('#cloudAuthSubmit');
    submit.disabled = true;
    setMessage('#cloudAuthError', 'Connecting…');
    try {
      const data = isSignup
        ? await authCall('signup', { email, password })
        : await authCall('token?grant_type=password', { email, password });
      if (!data.access_token) {
        setMessage('#cloudAuthError', 'Check your email to confirm the account, then sign in.', 'good');
        return;
      }
      await sessionSave({ ...data, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 });
      $('#cloudPassword').value = '';
      await refreshOnline();
      updateAccountButton();
      setPage('online');
    } catch (error) { setMessage('#cloudAuthError', error.message, 'bad'); }
    finally { submit.disabled = false; }
  }
  function renderQuota() {
    if (!account) return;
    const used = Number(account.usedBytes || 0);
    const quota = account.quotaBytes == null ? null : Number(account.quotaBytes);
    $('#quotaLabel').textContent = account.isAdmin ? 'Admin storage' : 'Storage used';
    $('#quotaText').textContent = quota == null ? humanBytes(used) + ' used · unlimited' : `${humanBytes(used)} of ${humanBytes(quota)} used`;
    $('#quotaBar').style.width = quota == null ? '4%' : Math.min(100, used / Math.max(1, quota) * 100) + '%';
  }
  function renderBooks() {
    const host = $('#onlineBooks');
    if (!host) return;
    host.replaceChildren();
    if (!books.length) { host.innerHTML = '<div class="online-empty">Your online shelf is ready for its first book.</div>'; return; }
    for (const book of books) {
      const card = document.createElement('article');
      card.className = 'online-book-card';
      const extension = ext(book.file_name).toUpperCase();
      card.innerHTML = `<div class="online-book-icon">${book.book_type === 'audio' ? '♫' : book.book_type === 'pdf' ? '▤' : '▧'}</div>
        <div class="online-book-info"><strong title="${esc(book.title || book.file_name)}">${esc(book.title || book.file_name)}</strong><small>${esc(book.author || extension)} · ${humanBytes(book.size_bytes)}</small></div>
        <div class="online-book-actions"><button type="button" data-action="download">Download</button><button type="button" data-action="delete">Remove</button><button type="button" data-action="instance" ${servers.some(s => s.active) ? '' : 'disabled'}>Create local copy</button></div>`;
      card.querySelector('[data-action="download"]').onclick = () => downloadBook(book);
      card.querySelector('[data-action="delete"]').onclick = () => removeBook(book);
      const makeCopy = card.querySelector('[data-action="instance"]');
      if (makeCopy) makeCopy.onclick = async () => {
        makeCopy.disabled = true;
        const targetServer = $('#targetServerSelect').value;
        if (!targetServer) { makeCopy.disabled = false; setMessage('#cloudUploadStatus', 'Choose an active server first.', 'bad'); return; }
        try { await api(`/servers/${enc(targetServer)}/instances`, { method: 'POST', body: JSON.stringify({ bookId: book.id }) }); setMessage('#cloudUploadStatus', `“${book.title || book.file_name}” is queued for a local copy.`, 'good'); }
        catch (error) { setMessage('#cloudUploadStatus', error.message, 'bad'); }
        finally { makeCopy.disabled = false; }
      };
      host.appendChild(card);
    }
  }
  async function renderServers() {
    const host = $('#serverList');
    if (!host) return;
    const data = await api('/servers');
    servers = data.servers || [];
    const select = $('#targetServerSelect');
    const preferred = localStorage.getItem('sb-cloud-target-server') || select.value;
    select.replaceChildren(new Option('Choose a server', ''));
    for (const server of servers.filter(s => s.active)) select.add(new Option(server.name, server.id));
    if (servers.some(server => server.id === preferred && server.active)) select.value = preferred;
    select.onchange = () => { if (select.value) localStorage.setItem('sb-cloud-target-server', select.value); };
    host.replaceChildren();
    if (!servers.length) { host.innerHTML = '<div class="online-empty">No servers registered yet. Add a computer that runs Sailing Books.</div>'; return; }
    for (const server of servers) {
      const card = document.createElement('article');
      card.className = 'server-card';
      card.innerHTML = `<div class="server-info"><strong>${esc(server.name)}</strong><small>${esc(server.base_url)}</small></div><span class="server-state ${server.active ? 'active' : ''}">${server.active ? 'Active' : 'Offline'}</span><button class="server-remove" type="button">Remove</button>`;
      card.querySelector('.server-remove').onclick = async () => {
        if (!confirm(`Remove “${server.name}” from your server list?`)) return;
        try {
          await api(`/servers/${enc(server.id)}`, { method: 'DELETE' });
          if (server.base_url === 'http://localhost:8787' && window.api?.configureCloudAgent) await window.api.configureCloudAgent({ disconnect: true });
          await refreshOnline();
        }
        catch (error) { setMessage('#cloudUploadStatus', error.message, 'bad'); }
      };
      host.appendChild(card);
    }
  }
  async function refreshOnline() {
    const [usage, listing] = await Promise.all([api('/me'), api('/books')]);
    account = usage;
    books = listing.books || [];
    renderQuota(); renderBooks(); updateAccountButton();
    await renderServers();
  }
  async function uploadOne(item) {
    const fileName = item.name;
    const bookType = typeFor(fileName);
    if (!bookType) throw new Error(`${fileName}: choose an EPUB, PDF, or audiobook file.`);
    let body;
    if (item.path) {
      const bytes = await window.api.readFileBytes(item.path);
      body = new Blob([bytes], { type: mimeFor(fileName) });
    } else body = item;
    if (!body.size) throw new Error(`${fileName}: the file is empty or could not be read.`);
    const reservation = await api('/books/reserve', { method: 'POST', body: JSON.stringify({ fileName, sizeBytes: body.size }) });
    try {
      const token = await accessToken();
      const objectUrl = `${cloudConfig.url}/storage/v1/object/${enc(reservation.bucket)}/${reservation.storagePath.split('/').map(enc).join('/')}`;
      const response = await fetch(objectUrl, { method: 'POST', headers: { apikey: cloudConfig.anonKey, Authorization: 'Bearer ' + token, 'Content-Type': mimeFor(fileName), 'x-upsert': 'false' }, body });
      if (!response.ok) throw new Error(`${fileName}: storage rejected this upload (${response.status}).`);
      await api(`/books/${enc(reservation.book.id)}/complete`, { method: 'POST', body: '{}' });
    } catch (error) {
      await api(`/books/${enc(reservation.book.id)}`, { method: 'DELETE' }).catch(() => {});
      throw error;
    }
  }
  async function handleUpload(event) {
    const input = event.currentTarget;
    let items = Array.from(input.files || []);
    input.value = '';
    if (!items.length && window.api?.pickFiles) {
      const paths = await window.api.pickFiles();
      items = (paths || []).map(path => ({ path, name: path.split(/[\\/]/).pop() }));
    }
    if (!items.length) return;
    setMessage('#cloudUploadStatus', `Uploading ${items.length} book${items.length === 1 ? '' : 's'}…`);
    for (const item of items) {
      try { await uploadOne(item); }
      catch (error) { setMessage('#cloudUploadStatus', error.message, 'bad'); return; }
    }
    setMessage('#cloudUploadStatus', `${items.length} book${items.length === 1 ? '' : 's'} added to your online library.`, 'good');
    await refreshOnline();
  }
  async function downloadBook(book) {
    try {
      const { url } = await api(`/books/${enc(book.id)}/download`);
      const response = await fetch(url);
      if (!response.ok) throw new Error('Could not download this book.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (window.api?.saveCloudBook) {
        const saved = await window.api.saveCloudBook(book.file_name, bytes);
        if (!saved?.storedPath) throw new Error(saved?.error || 'Could not save the book to this computer.');
        window.dispatchEvent(new CustomEvent('sb-cloud-book-downloaded', { detail: saved }));
        setMessage('#cloudUploadStatus', `“${book.title || book.file_name}” is now in Local Library.`, 'good');
      } else {
        const blob = new Blob([bytes], { type: mimeFor(book.file_name) });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = book.file_name; link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 30000);
      }
    } catch (error) { setMessage('#cloudUploadStatus', error.message, 'bad'); }
  }
  async function removeBook(book) {
    if (!confirm(`Remove “${book.title || book.file_name}” from your online library?`)) return;
    try { await api(`/books/${enc(book.id)}`, { method: 'DELETE' }); await refreshOnline(); }
    catch (error) { setMessage('#cloudUploadStatus', error.message, 'bad'); }
  }
  async function registerServer(event) {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
    const box = $('#serverPairing'); box.classList.remove('hidden'); box.textContent = 'Registering server…';
    try {
      const result = await api('/servers/register', { method: 'POST', body: JSON.stringify({ name: $('#serverName').value.trim(), baseUrl: $('#serverUrl').value.trim() }) });
      let paired = false;
      if (window.api?.configureCloudAgent && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(result.server.base_url)) {
        paired = await window.api.configureCloudAgent({ id: result.server.id, token: result.pairingToken });
      }
      const msg = paired
        ? 'This desktop is paired. Keep Sailing Books open to keep its server active.'
        : 'Copy the one-time pairing token to the computer that runs this server. The token is shown only now.';
      box.innerHTML = `<strong>${esc(msg)}</strong><p>${esc(result.server.name)} · ${esc(result.server.base_url)}</p><code>${esc(result.pairingToken)}</code><button type="button" class="btn small ghost" id="copyServerToken">Copy token</button><p>On a separate server, set SB_CLOUD_SERVER_ID to <code>${esc(result.server.id)}</code> and SB_CLOUD_SERVER_TOKEN to the token, then restart Sailing Books Server.</p>`;
      $('#copyServerToken').onclick = async () => { await navigator.clipboard?.writeText(result.pairingToken); $('#copyServerToken').textContent = 'Copied'; };
      await renderServers();
      event.currentTarget.reset();
    } catch (error) { box.textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function signOut() {
    try { if (session?.access_token) await authCall('logout', {}, session.access_token); } catch {}
    await sessionSave(null); account = null; books = []; updateAccountButton();
    setPage(hostedLanding ? 'landing' : 'local');
    if (hostedLanding) showAuthMode(false);
  }
  async function init() {
    if (!$('#cloudLanding')) return;
    session = await sessionRead();
    $('#navLocalLibrary').onclick = () => setPage('local');
    $('#navOnlineLibrary').onclick = () => { if (session) setPage('online'); else setPage('landing'); };
    $('#btnAccount').onclick = () => { setPage(session ? 'online' : 'landing'); if (!session) showAuthMode(false); };
    $('#cloudAuthToggle').onclick = () => showAuthMode(!isSignup);
    $('#cloudAuthForm').addEventListener('submit', submitAuth);
    $('#cloudFileInput').addEventListener('change', handleUpload);
    $('#cloudRefresh').onclick = () => refreshOnline().catch(error => setMessage('#cloudUploadStatus', error.message, 'bad'));
    $('#cloudServerRefresh').onclick = () => renderServers().catch(error => setMessage('#cloudUploadStatus', error.message, 'bad'));
    $('#serverRegisterForm').addEventListener('submit', registerServer);
    $('#cloudSignOut').onclick = signOut;
    updateAccountButton();
    showAuthMode(false);
    if (!window.api?.mode) {
      $('#serverName').value = 'This computer';
      $('#serverUrl').value = 'http://localhost:8787';
    }
    if (hostedLanding) {
      if (session?.refresh_token) api('/me').then(() => setPage('online')).catch(() => { sessionSave(null); setPage('landing'); });
      else setPage('landing');
    } else {
      $('#libraryNav').classList.remove('hidden');
      setPage('local');
      if (session?.refresh_token) api('/me').then(refreshOnline).catch(() => sessionSave(null));
    }
    window.addEventListener('sb-cloud-book-downloaded', () => setPage('local'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
