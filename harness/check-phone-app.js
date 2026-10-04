/* The phone app has to work like the desktop app, local library and all.
 *
 * Capacitor runs the web client inside an app rather than a browser tab, so this
 * loads the built web client with a preload that stands in for the native
 * bridge. What is checked is that the local library is there, that it opens, and
 * that Download puts the book into it rather than handing back a file - which is
 * the whole point of the phone and the app behaving the same way.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

const DIST = path.join(__dirname, '..', 'web', 'dist', 'index.html');
if (!fs.existsSync(DIST)) { say('\n  web/dist/index.html is missing. Run: node web/build.js\n'); process.exit(1); }

// The phone app keeps its library on the device, so it survives between runs.
// This check needs a phone that has just come out of the box.
const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sb-phone-app-'));
app.setPath('userData', profile);

const BOOK = { id: 'cloud-9', file_name: 'Cloud Book.epub', title: 'Cloud Book', book_type: 'epub', size_bytes: 21 };
const STUB = `(() => {
  const book = ${JSON.stringify(BOOK)};
  const bytes = new Uint8Array(21).fill(7);
  const json = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  window.fetch = (url, options = {}) => {
    const u = String(url);
    if (/\\/config$/.test(u)) return json({ configured: true, serviceReady: true, url: 'https://stub.supabase.co', anonKey: 'anon' });
    if (/\\/auth\\/v1\\/token/.test(u)) return json({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
    if (/\\/auth\\/v1\\/user$/.test(u)) {
      if ((options.method || 'GET') === 'PUT') return json({ user_metadata: { plan: 'free' } });
      return json({ id: 'u1', email: 'samruddhc@example.com', user_metadata: {} });
    }
    if (/\\/me$/.test(u)) return json({ user: { email: 'samruddhc@example.com' }, usedBytes: 0, quotaBytes: 1073741824, plan: 'free' });
    if (/\\/books$/.test(u)) return json({ books: [book] });
    if (/\\/servers$/.test(u)) return json({ servers: [] });
    if (/\\/books\\/[^/]+\\/file$/.test(u)) return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes.buffer) });
    return json({});
  };
  return 'stubbed';
})()`;

const REPORT = `JSON.stringify((() => {
  const shown = id => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); };
  const visible = id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0; };
  const card = document.querySelector('.online-book-card');
  const tiles = [...document.querySelectorAll('#libraryView .book-card, #libraryView .shelf-item, #libraryView .tile')].length;
  return {
    isNative: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),
    apiBase: (() => { try { return String(window.__apiBaseProbe || ''); } catch { return ''; } })(),
    localUp: shown('libraryView'),
    onlineUp: shown('onlineLibraryView'),
    navUp: shown('libraryNav'),
    localTabUp: visible('navLocalLibrary'),
    onlineTabUp: visible('navOnlineLibrary'),
    actions: card ? [...card.querySelectorAll('.online-book-actions button')].map(b => b.textContent.trim()) : [],
    status: (document.getElementById('cloudUploadStatus') || {}).textContent || '',
    localTitles: [...document.querySelectorAll('#libraryView .book-title, #libraryView .shelf-title')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 6)
  };
})())`;

async function waitFor(win, predicate, tries = 60) {
  let r = null;
  for (let i = 0; i < tries; i++) {
    r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
    if (predicate(r)) return r;
    await new Promise(x => setTimeout(x, 250));
  }
  return r;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 412, height: 900,
    webPreferences: {
      // Stands in for the bridge Capacitor injects into the page.
      preload: path.join(__dirname, 'fake-capacitor.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  await win.loadFile(DIST);
  await new Promise(r => setTimeout(r, 2500));
  await win.webContents.executeJavaScript(STUB);
  let r = await waitFor(win, s => s.localUp === true || s.onlineUp === true);

  say('\n  the phone app is the app, not a browser tab\n');
  check(r.isNative === true, 'the native bridge is there', 'isNative=' + r.isNative);
  check(r.localUp === true, 'it opens on the local library, like the desktop app', 'localUp=' + r.localUp);
  check(r.navUp === true, 'and offers both places to go', 'navUp=' + r.navUp);
  check(r.localTabUp === true && r.onlineTabUp === true, 'Local Library and Online Library', 'local=' + r.localTabUp + ' online=' + r.onlineTabUp);

  say('\n  downloading puts the book in it\n');
  await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnAccount');
    if (b && /sign in/i.test(b.textContent)) b.click();
    return 'opened';
  })()`);
  await waitFor(win, s => s.onlineUp === true || /Choose your plan|Sign in/.test(s.status));
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('cloudEmail').value = 'samruddhc@example.com';
    document.getElementById('cloudPassword').value = 'correct horse battery';
    document.getElementById('cloudAuthForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 'submitted';
  })()`);
  r = await waitFor(win, s => s.onlineUp === true && s.actions.length > 0, 40);
  if (r.onlineUp !== true) {
    await win.webContents.executeJavaScript(`(() => { const c = document.getElementById('cloudPlanContinue'); if (c) c.click(); return 1; })()`);
    r = await waitFor(win, s => s.onlineUp === true && s.actions.length > 0, 40);
  }
  check(r.onlineUp === true, 'the online shelf opens', 'landing/local shown instead');
  check(r.actions.includes('Download'), 'with Download on the book', r.actions.join(', '));

  await win.webContents.executeJavaScript(`(() => { document.querySelector('.online-book-card [data-action="download"]').click(); return 1; })()`);
  r = await waitFor(win, s => /now in your local library|already in your local library|as a file/i.test(s.status), 40);
  check(/now in your local library/i.test(r.status), 'Download says it joined the library', r.status);
  check(!/as a file/i.test(r.status), 'and did not fall back to handing back a file', r.status);
  check(r.localUp === true, 'and the app takes you to the library', 'localUp=' + r.localUp);
  check(r.localTitles.some(t => /Cloud Book/.test(t)), 'where the book is now on the shelf', r.localTitles.join(' | ') || 'nothing on the shelf');

  say('\n  and pressing it again does not double it\n');
  await win.webContents.executeJavaScript(`(() => { document.getElementById('navOnlineLibrary').click(); return 1; })()`);
  await waitFor(win, s => s.onlineUp === true && s.actions.length > 0, 40);
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.online-book-card [data-action="download"]').click(); return 1; })()`);
  r = await waitFor(win, s => /already in your local library|as a file/i.test(s.status), 40);
  check(/already in your local library/i.test(r.status), 'the second press is told it is already there', r.status);

  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'the phone app keeps a local library, exactly like the desktop app') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });