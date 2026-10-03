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
  // The plan of the account signed in right now, so the badge beside the name
  // is right from the moment it is chosen rather than whenever the server
  // next answers.
  let currentPlan = null;
  let refreshPromise = null;
  const hostedLanding = !!(window.api && window.api.mode === 'web' && !window.SB_SERVED_BY_LAPTOP);

  /* The four ways to hold a library. Storage and simultaneous readers are what
     the plans differ by; the tick list is what each includes. No prices: what a
     plan costs is agreed with the person, not published here.
     Only Free is open today. The other three are shown so the shape of the
     service is visible, and are marked unavailable rather than hidden - quietly
     dropping them would leave someone wondering whether they missed something. */
  const PLANS = [
    {
      id: 'free', name: 'Free', tagline: 'A private shelf, just for you', available: true,
      storage: '1 GB of cloud storage', seats: '1 person signed in at a time',
      signupLine: 'Start with 1 GB of private online book storage.',
      features: ['Every book format: EPUB, PDF, audiobook', 'Read on your desktop and phone',
        'Books stay on this computer too', 'Private by default']
    },
    {
      id: 'plus', name: 'Plus', tagline: 'Room to grow', available: false,
      storage: '10 GB of cloud storage', seats: '2 people signed in at a time',
      signupLine: 'Start with 10 GB of private online book storage.',
      features: ['Everything in Free', 'Share books with one other person',
        'Send books to your own computers', 'Room for a series and its audiobooks']
    },
    {
      id: 'pro', name: 'Pro', tagline: 'A library for a few', available: false,
      storage: '100 GB of cloud storage', seats: '4 people signed in at a time',
      signupLine: 'Start with 100 GB of private online book storage.',
      features: ['Everything in Plus', 'Share with a household or a small team',
        'Priority when adding new computers', 'Room for large audio libraries']
    },
    {
      id: 'library', name: 'Library', tagline: 'For institutions and big shelves', available: false,
      storage: 'Charged per GB you use', seats: '200+ readers, each with their own sign-in',
      signupLine: 'Storage is charged per GB you use.',
      features: ['Everything in Pro', 'A separate sign-in for every reader',
        'Central management for the whole shelf', 'Best for schools, clubs and libraries']
    }
  ];
  const PLAN_IDS = PLANS.map(p => p.id);
  const planById = (id) => PLANS.find(p => p.id === id) || null;
  const planAvailable = (id) => !!(planById(id) && planById(id).available);
  const PLAN_KEY = 'sb-cloud-plan-v1';
  const ACCOUNT_PLAN_KEY = 'sb-cloud-account-plan-v1';
  let chosenPlan = 'free';
  const chosenPlanInfo = () => planById(chosenPlan);

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
    const loaded = await response.json();
    if (!loaded || typeof loaded !== 'object') throw new Error('The account service returned an invalid configuration. Refresh the page and try again.');
    cloudConfig = loaded;
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
  async function apiFile(path, retry = true) {
    const token = await accessToken();
    let response;
    try { response = await fetch(apiBase() + path, { headers: { Authorization: 'Bearer ' + token } }); }
    catch { throw new Error('Could not reach the Sailing Books cloud service. Check your connection and try again.'); }
    if (response.status === 401 && retry && session?.refresh_token) { await refreshToken(); return apiFile(path, false); }
    if (response.status === 401) {
      await expireSession();
      throw new Error('Your sign-in expired. Your books are safe; sign in again to continue.');
    }
    if (!response.ok) {
      const data = await response.clone().json().catch(() => ({}));
      let route = apiBase() + path;
      try { route = new URL(route, location.href).pathname; } catch {}
      throw new Error(data.error || `Cloud request failed (${response.status}) at ${route}.`);
    }
    return response;
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
    const email = account?.user?.email || '';
    if (btn) btn.textContent = email ? email.split('@')[0] : 'Sign in';
    $('#cloudIdentity').textContent = email || '';
    const plan = planById(accountPlanId());
    // Say which plan this account is on, next to the name that identifies it.
    const identity = $('#cloudIdentity');
    if (identity && plan) {
      identity.textContent = email;
      identity.title = plan.name + ' · ' + plan.storage + ' · ' + plan.seats;
    }
    // ...and the same in the top bar, beside the name, so it is always in sight.
    const pill = $('#accountPlanPill');
    if (pill) {
      if (email && plan) {
        pill.textContent = plan.name;
        pill.title = plan.name + ' · ' + plan.storage + ' · ' + plan.seats;
        pill.classList.remove('hidden');
      } else {
        pill.classList.add('hidden');
        pill.textContent = '';
      }
    }
    $('#libraryNav')?.classList.toggle('hidden', hostedLanding && !session);
  }
  // The panel's heading is shared by two steps, so it lives in one place: signing
  // in, creating an account, and choosing a plan all rewrite the same three lines.
  function paintAuthHeading() {
    $('#cloudAuthEyebrow').textContent = isSignup ? 'MAKE IT YOURS' : 'WELCOME BACK';
    $('#cloudAuthTitle').textContent = isSignup ? 'Create your account' : 'Sign in to your library';
    $('#cloudAuthSub').textContent = isSignup
      ? 'Pick a name and password. We will send you a link to confirm it.'
      : 'Your local books stay on this computer.';
  }
  function showAuthMode(signup) {
    isSignup = !!signup;
    paintAuthHeading();
    $('#cloudPassword').autocomplete = isSignup ? 'new-password' : 'current-password';
    $('#cloudAuthSubmit').textContent = isSignup ? 'Create account' : 'Sign in';
    $('#cloudAuthToggle').textContent = isSignup ? 'Already have an account? Sign in' : 'New here? Create an account';
    setMessage('#cloudAuthError', '');
    // Creating an account is deliberately ordinary: a name, a password, and then
    // an email to confirm. The plan is chosen after that, once the address is
    // known to be real.
    // Leaving the gate matters as much as opening it: its note and its button
    // must never outlive the step that put them there.
    hidePlanGate();
    $('#cloudPlanLine')?.classList.add('hidden');
    $('#planChooser')?.classList.add('hidden');
    renderPlanSelection();
  }

  /* ---- choosing a plan, after the address is verified ---- */
  function showPlanGate() {
    $('#planChooser')?.classList.remove('hidden');
    // While the gate is up the card is not asking anyone to sign in, so it stops
    // claiming to be.
    $('#cloudAuthEyebrow').textContent = 'ONE LAST THING';
    $('#cloudAuthTitle').textContent = 'Choose your plan';
    $('#cloudAuthSub').textContent = 'Your account is confirmed and ready.';
    const note = $('#cloudPlanGateNote');
    const plan = chosenPlanInfo();
    if (note) {
      note.classList.remove('hidden');
      note.innerHTML = plan
        ? `Pick <b>${esc(plan.name)}</b> and your library is ready to use.`
        : 'Pick a plan and your library is ready to use.';
    }
    $('#cloudPlanContinue')?.classList.remove('hidden');
    $('#cloudAuthForm')?.classList.add('hidden');
    $('#cloudAuthToggle')?.classList.add('hidden');
    $('#cloudPlanLine')?.classList.add('hidden');
  }
  function hidePlanGate() {
    paintAuthHeading();
    const note = $('#cloudPlanGateNote');
    if (note) { note.classList.add('hidden'); note.innerHTML = ''; }
    $('#cloudPlanContinue')?.classList.add('hidden');
    $('#cloudAuthForm')?.classList.remove('hidden');
    $('#cloudAuthToggle')?.classList.remove('hidden');
  }
  // Reads the plan off the signed-in account. Supabase keeps it in user metadata,
  // which is where sign-up and the choice both write it.
  async function accountPlanFromServer(token) {
    try {
      const cfg = await loadConfig();
      const response = await fetch(cfg.url + '/auth/v1/user', {
        headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + token }
      });
      if (!response.ok) return null;
      const me = await response.json().catch(() => null);
      const plan = me && me.user_metadata && me.user_metadata.plan;
      return planAvailable(plan) ? plan : null;
    } catch { return null; }
  }
  async function saveAccountPlan(token, planId) {
    const cfg = await loadConfig();
    const response = await fetch(cfg.url + '/auth/v1/user', {
      method: 'PUT',
      headers: { apikey: cfg.anonKey, 'content-type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ data: { plan: planId } })
    });
    if (!response.ok) throw new Error('Could not save your plan choice.');
    return true;
  }

  /* ---- plan chooser ---- */
  function renderPlanGrid() {
    const grid = $('#planGrid');
    if (!grid) return;
    grid.replaceChildren();
    for (const plan of PLANS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'plan-card';
      card.setAttribute('role', 'radio');
      card.dataset.planId = plan.id;
      if (plan.available) card.setAttribute('aria-checked', String(plan.id === chosenPlan));
      else card.setAttribute('aria-disabled', 'true');
      const pill = plan.available ? '' : '<span class="plan-pill soon">Unavailable for now</span>';
      card.innerHTML =
        pill +
        `<span class="plan-name">${esc(plan.name)}</span>` +
        `<span class="plan-tagline">${esc(plan.tagline)}</span>` +
        `<span class="plan-spec">${esc(plan.storage)}</span>` +
        `<span class="plan-seats">${esc(plan.seats)}</span>` +
        '<span class="plan-rule"></span>' +
        '<ul class="plan-features">' +
          plan.features.map(f => `<li>${esc(f)}</li>`).join('') +
        '</ul>';
      card.onclick = () => {
        // A plan that is not open cannot be chosen, and says so rather than
        // doing nothing at all.
        if (!plan.available) { setMessage('#cloudAuthError', `${plan.name} is not available yet. Free is open today.`); return; }
        choosePlan(plan.id);
      };
      grid.appendChild(card);
    }
    renderPlanSelection();
  }
  // Marks the chosen card and tells the sign-up panel about it, without
  // rebuilding the grid: rebuilding would drop keyboard focus mid-interaction.
  function renderPlanSelection() {
    const grid = $('#planGrid');
    if (grid) {
      for (const card of grid.querySelectorAll('.plan-card')) {
        if (card.getAttribute('aria-disabled') === 'true') continue;
        card.setAttribute('aria-checked', String(card.dataset.planId === chosenPlan));
      }
    }
    // The plan line belongs to the gate, not to signing in: an empty element with
    // no rule for its hidden state still paints, which is a stray grey bar.
    const gateOpen = !$('#planChooser')?.classList.contains('hidden');
    if (gateOpen) showPlanGate();
  }
  function choosePlan(id) {
    if (!PLAN_IDS.includes(id) || !planAvailable(id)) return;
    chosenPlan = id;
    try { localStorage.setItem(PLAN_KEY, id); } catch {}
    renderPlanSelection();
    if (isSignup) showAuthMode(true);
  }
  function restoreChosenPlan() {
    try {
      const saved = localStorage.getItem(PLAN_KEY);
      if (saved && planAvailable(saved)) { chosenPlan = saved; return; }
      // A remembered choice that is no longer open must not linger: drop it, so
      // nothing downstream can read a plan that cannot be had.
      if (saved) localStorage.removeItem(PLAN_KEY);
    } catch {}
  }
  // Remembers which plan an account was created on, so the signed-in view can
  // say so. The server may report one too; that always wins.
  function accountPlanId() {
    if (account && account.plan && PLAN_IDS.includes(account.plan)) return account.plan;
    // The plan just chosen this minute. Waiting for the server to echo it back
    // left the badge empty in the corner for as long as it took to load.
    if (PLAN_IDS.includes(currentPlan)) return currentPlan;
    const email = (account && account.user && account.user.email) || (session && session.email) || '';
    if (!email) return null;
    try {
      const saved = JSON.parse(localStorage.getItem(ACCOUNT_PLAN_KEY) || 'null');
      return saved && saved.email === email && PLAN_IDS.includes(saved.plan) ? saved.plan : null;
    } catch { return null; }
  }
  function rememberAccountPlan(email, planId) {
    if (!PLAN_IDS.includes(planId)) return;
    currentPlan = planId;
    if (!email) return;
    try { localStorage.setItem(ACCOUNT_PLAN_KEY, JSON.stringify({ email, plan: planId })); } catch {}
  }
  async function submitAuth(event) {
    event.preventDefault();
    const email = $('#cloudEmail').value.trim(), password = $('#cloudPassword').value;
    const submit = $('#cloudAuthSubmit');
    submit.disabled = true;
    setMessage('#cloudAuthError', 'Connecting…');
    try {
const data = isSignup
      // Sign-up asks for an address and a password and nothing else: no plan
      // question here, because the address has not been confirmed yet.
      ? await authCall('signup', { email, password })
        : await authCall('token?grant_type=password', { email, password });
      if (!data.access_token) {
        // The address is not confirmed yet, so the account is not finished. Go
        // back to the sign-in form and say plainly what is being waited for,
        // rather than leaving the person on a sign-up form they have finished.
        showAuthMode(false);
        setMessage('#cloudAuthError', 'We sent a verification link to ' + email + '. Sign in once you have clicked it.', 'good');
        return;
      }
      // The address is kept on the session: the badge beside the name is looked up
      // by it, and Supabase's token reply does not always carry one.
      await sessionSave({ ...data, email: data.email || email, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 });
      $('#cloudPassword').value = '';

      // Signed in. An account without a plan has not finished setting up, so the
      // plan question comes now - after the address is confirmed - and the
      // library waits until it is answered.
      const planOnAccount = await accountPlanFromServer(data.access_token);
      if (!planOnAccount) {
        setPage('landing');
        hidePlanGate();
        showPlanGate();
        updateAccountButton();
        return;
      }
      rememberAccountPlan(email, planOnAccount);
      hidePlanGate();
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
        const server = servers.find(item => item.id === targetServer);
        try {
          const result = await api(`/servers/${enc(targetServer)}/instances`, { method: 'POST', body: JSON.stringify({ bookId: book.id }) });
          const jobId = result.job?.id;
          if (!jobId) throw new Error('The server did not accept the local-copy request.');
          let browserCopyError = '';
          if (window.api?.isBrowserLocalLibrary?.()) {
            try { await addOnlineBookToBrowser(book); }
            catch (error) { browserCopyError = error.message || 'Could not add the book to this browser.'; }
          }
          setMessage('#cloudUploadStatus', `Creating a local copy on ${server?.name || 'the selected server'}…`);
          const job = await waitForInstance(targetServer, jobId);
          if (job?.status === 'complete') {
            window.dispatchEvent(new CustomEvent('sb-cloud-instance-created', { detail: { serverId: targetServer, jobId } }));
            const local = window.api?.isBrowserLocalLibrary?.();
            const message = local
              ? browserCopyError ? `The server copy was created, but this browser could not add it to Local Library: ${browserCopyError}` : `“${book.title || book.file_name}” is now in this browser’s Local Library and on ${server?.name || 'the selected server'}.`
              : `“${book.title || book.file_name}” was added to ${server?.name || 'the selected server'}’s Local Library.`;
            setMessage('#cloudUploadStatus', message, browserCopyError ? 'bad' : 'good');
          } else if (job?.status === 'failed') {
            const local = window.api?.isBrowserLocalLibrary?.();
            const prefix = local && !browserCopyError ? 'It was added to this browser’s Local Library. ' : '';
            setMessage('#cloudUploadStatus', `${prefix}The server could not create its local copy: ${job.result_message || 'please check that computer and retry.'}`, 'bad');
          } else {
            setMessage('#cloudUploadStatus', `The local-copy request is still queued on ${server?.name || 'the selected server'}. Keep it running and refresh the library shortly.`, 'good');
          }
        }
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
    // A restored sign-in session skips authCall(), so it may reach the upload
    // path before the public Supabase config has ever been loaded in this tab.
    const cfg = await loadConfig();
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
      const objectUrl = `${cfg.url}/storage/v1/object/${enc(reservation.bucket)}/${reservation.storagePath.split('/').map(enc).join('/')}`;
      const response = await fetch(objectUrl, { method: 'POST', headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + token, 'Content-Type': mimeFor(fileName), 'x-upsert': 'false' }, body });
      if (!response.ok) {
        const storageError = await response.clone().json().catch(() => ({}));
        const detail = storageError.message || storageError.error || storageError.code;
        throw new Error(`${fileName}: storage rejected this upload (${response.status})${detail ? `: ${detail}` : '.'}`);
      }
      await api(`/books/${enc(reservation.book.id)}/complete`, { method: 'POST', body: '{}' });
    } catch (error) {
      await api(`/books/${enc(reservation.book.id)}`, { method: 'DELETE' }).catch(() => {});
      throw error;
    }
  }

  /* A small, deliberate bridge for the rest of the app.
   *
   * The book right-click menu offers "Move to online library", which has no way
   * to reach uploadOne() on its own: this file is a closure and exposes nothing.
   * Rather than publish the internals, only these three things are handed over -
   * whether there is a usable session, uploading one file that already exists on
   * disk, and the list of books already online so a repeat can be recognised. */
  window.sbOnlineLibrary = {
    signedIn: () => !!session?.refresh_token,
    onlineBooks: () => books.map(b => ({ id: b.id, fileName: b.file_name })),
    async uploadLocalFile(filePath, fileName) {
      if (!session?.refresh_token) throw new Error('Sign in to your online library first.');
      await uploadOne({ path: filePath, name: fileName });
      // Keep the tab's own list in step, so switching to it shows the new book
      await refreshOnline().catch(() => {});
      return true;
    }
  };

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
  async function addOnlineBookToBrowser(book) {
    const response = await apiFile(`/books/${enc(book.id)}/file`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const saved = await window.api.saveCloudBook(book.file_name, bytes, book.id);
    if (saved?.alreadyAdded) return saved;
    if (!saved?.storedPath) throw new Error(saved?.error || 'Could not add the book to this browser’s Local Library.');
    window.dispatchEvent(new CustomEvent('sb-cloud-book-downloaded', { detail: saved }));
    return saved;
  }
  async function waitForInstance(serverId, jobId) {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const result = await api(`/servers/${enc(serverId)}/instances/${enc(jobId)}`);
      if (result.job?.status === 'complete' || result.job?.status === 'failed') return result.job;
    }
    return null;
  }
  async function downloadBook(book) {
    setMessage('#cloudUploadStatus', '');
    try {
      const response = await apiFile(`/books/${enc(book.id)}/file`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!window.api?.mode && window.api?.saveCloudBook) {
        const saved = await window.api.saveCloudBook(book.file_name, bytes);
        if (!saved?.storedPath) throw new Error(saved?.error || 'Could not save the book to this computer.');
        window.dispatchEvent(new CustomEvent('sb-cloud-book-downloaded', { detail: saved }));
      } else {
        const blob = new Blob([bytes], { type: mimeFor(book.file_name) });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = book.file_name; link.style.display = 'none';
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
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
    // currentTarget is only set while the event listener is running. Keep the
    // form reference before the async requests below so it remains available
    // after they finish.
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
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
      form.reset();
    } catch (error) { box.textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function signOut() {
    try { if (session?.access_token) await authCall('logout', {}, session.access_token); } catch {}
    await sessionSave(null); account = null; currentPlan = null; books = []; updateAccountButton();
    setPage(hostedLanding ? 'landing' : 'local');
    if (hostedLanding) showAuthMode(false);
  }
  async function init() {
    if (!$('#cloudLanding')) return;
    // The plan chooser is drawn before the session is read, not after: reading a
    // session can fail or be slow, and the sign-in page must still show its
    // plans when it does.
    restoreChosenPlan();
    renderPlanGrid();
    // Reading the stored session must never be able to take the page down with
    // it. It goes through the desktop bridge, so it can fail if that is missing
    // or the file is unreadable, and an await that rejects here would stop every
    // line below from running - leaving a sign-in form that renders but does
    // nothing when pressed. A failed read just means "not signed in".
    session = await sessionRead().catch(() => null);
    $('#navLocalLibrary').onclick = () => setPage('local');
    $('#navOnlineLibrary').onclick = () => { if (session) setPage('online'); else setPage('landing'); };
    $('#btnAccount').onclick = () => { setPage(session ? 'online' : 'landing'); if (!session) showAuthMode(false); };
    $('#cloudAuthToggle').onclick = () => showAuthMode(!isSignup);
    // Finishing setup: the plan is written to the account, and only then does the
    // library open.
    $('#cloudPlanContinue').onclick = async () => {
      const btn = $('#cloudPlanContinue');
      btn.disabled = true;
      setMessage('#cloudAuthError', 'Setting up your library.');
      try {
        await saveAccountPlan(session.access_token, chosenPlan);
        rememberAccountPlan((account && account.user && account.user.email) || session.email || '', chosenPlan);
        setMessage('#cloudAuthError', '');
        hidePlanGate();
        $('#planChooser')?.classList.add('hidden');
        await refreshOnline();
        setPage('online');
      } catch (error) {
        setMessage('#cloudAuthError', error.message, 'bad');
      } finally { btn.disabled = false; }
    };
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
