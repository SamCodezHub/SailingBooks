/* Sailing Books — web client login gate.
   Only used in the browser build; Electron has the real preload instead. */
(function () {
  const gate = document.getElementById('loginGate');
  if (!gate) return;
  const api = window.api;
  if (!api || !api.mode) return;                 // desktop: never show the gate

  const form = document.getElementById('loginForm');
  const pass = document.getElementById('loginPass');
  const serverInput = document.getElementById('loginServer');
  const err = document.getElementById('loginError');
  const status = document.getElementById('loginStatus');

  const show = (msg, bad) => { err.textContent = msg || ''; err.classList.toggle('bad', !!bad); };
  const setBusy = (on) => { form.querySelector('button').disabled = on; status.textContent = on ? 'Connecting…' : ''; };

  // Pre-fill the server address when the page is hosted somewhere else.
  if (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    serverInput.value = localStorage.getItem('sb-web-base') || '';
  } else {
    serverInput.value = localStorage.getItem('sb-web-base') || location.origin;
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
