/* Sailing Books — web client login gate.
   Only used in the browser build; Electron has the real preload instead. */
(function () {
  const gate = document.getElementById('loginGate');
  if (!gate) return;
  const api = window.api;
  if (!api || !api.mode) return;                 // desktop: never show the gate
  // The hosted Vercel app now uses cloud accounts. The legacy laptop password
  // gate remains only for pages served directly by server/server.js.
  if (!window.SB_SERVED_BY_LAPTOP) return;

  const form = document.getElementById('loginForm');
  const pass = document.getElementById('loginPass');
  const serverInput = document.getElementById('loginServer');
  const addrField = document.getElementById('loginAddrField');
  const recentBox = document.getElementById('loginRecent');
  const err = document.getElementById('loginError');
  const status = document.getElementById('loginStatus');

  const show = (msg, bad) => { err.textContent = msg || ''; err.classList.toggle('bad', !!bad); };
  const setBusy = (on) => { form.querySelector('button[type=submit]').disabled = on; status.textContent = on ? 'Connecting…' : ''; };

  /* Addresses this device has used before, newest first. The tunnel address
     changes when the laptop restarts, so rather than typing a new one, tap the
     old one. */
  const LS_RECENT = 'sb-web-recent';
  const recent = () => { try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); } catch { return []; } };
  const remember = (base) => {
    const b = String(base || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(b)) return;
    const list = [b, ...recent().filter(x => x !== b)].slice(0, 5);
    localStorage.setItem(LS_RECENT, JSON.stringify(list));
    drawRecent(b);
  };
  const drawRecent = (current) => {
    if (!recentBox) return;
    recentBox.innerHTML = '';
    for (const b of recent()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = b.replace(/^https?:\/\//, '').replace(/\/$/, '');
      chip.title = b;
      if (b === String(current || '').replace(/\/+$/, '')) chip.className = 'current';
      chip.onclick = () => {
        serverInput.value = b;
        api.setBase(b);
        pass.focus();
      };
      recentBox.appendChild(chip);
    }
  };

  // Pre-fill the server address when the page is hosted somewhere else.
  const saved = (localStorage.getItem('sb-web-base') || '').replace(/\/+$/, '');
  if (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    serverInput.value = saved;
  } else {
    serverInput.value = saved || location.origin;
  }
  // The laptop is serving this very page, so the phone is already at the right
  // address: no address box, no typing — bookmark the link and it just works.
  if (window.SB_SERVED_BY_LAPTOP) {
    if (addrField) addrField.classList.add('hidden');
    const sub = document.getElementById('loginSub');
    if (sub) sub.textContent = 'Sign in to the library on your laptop';
    const hint = document.getElementById('loginHint');
    if (hint) hint.innerHTML = 'Keep <code>npm run tunnel</code> running on the laptop, and bookmark this page.';
    serverInput.value = location.origin;
    api.setBase(location.origin);
  } else {
    drawRecent(serverInput.value);
  }
  serverInput.addEventListener('change', () => api.setBase(serverInput.value.trim()));

  const start = async () => {
    gate.classList.remove('hidden');
    document.getElementById('app').style.visibility = 'hidden';
    if (api.isSignedIn()) {
      try { await api.session(); return enter(); } catch { api.logout(); }
    }
    pass.focus();
  };
  const enter = () => {
    gate.classList.add('hidden');
    document.getElementById('app').style.visibility = '';
    window.dispatchEvent(new CustomEvent('sb-signed-in'));
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    show(''); setBusy(true);
    try {
      if (serverInput.value.trim() !== (localStorage.getItem('sb-web-base') || '')) api.setBase(serverInput.value.trim());
      await api.login(pass.value);
      remember(serverInput.value);
      pass.value = '';
      enter();
    } catch (err2) {
      show(err2 && err2.message === 'Failed to fetch'
        ? 'Cannot reach the laptop — check it is running the server and the address is right'
        : (err2 && err2.message) || 'Sign-in failed', true);
    } finally { setBusy(false); }
  });

  // Any request that 401s (token expired) drops back to the login gate.
  window.addEventListener('sb-signed-out', () => { gate.classList.remove('hidden'); document.getElementById('app').style.visibility = 'hidden'; });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
