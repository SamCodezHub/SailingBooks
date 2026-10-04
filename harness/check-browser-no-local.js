/* What the browser is allowed to show.
 *
 * The local library belongs to the app. In a browser there is no library of its
 * own - books reach the computer over Download - so the online shelf is the only
 * page, and a browser with no computer to talk to says so instead of pretending
 * it saved the book somewhere.
 *
 * Runs against the built web client (web/dist) with no preload, which is how a
 * browser gets it.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

const DIST = path.join(__dirname, '..', 'web', 'dist', 'index.html');
if (!fs.existsSync(DIST)) {
  say('\n  web/dist/index.html is missing. Run: node web/build.js\n');
  process.exit(1);
}

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
  // Whether it is actually on screen, which is not the same as not carrying the
  // hidden class: these tabs live inside a nav that is hidden as a whole.
  const visible = id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0; };
  const card = document.querySelector('.online-book-card');
  return {
    mode: String(window.api && window.api.mode),
    isBrowserLibrary: !!(window.api && window.api.isBrowserLocalLibrary && window.api.isBrowserLocalLibrary()),
    landingUp: shown('cloudLanding'),
    onlineUp: shown('onlineLibraryView'),
    localUp: shown('libraryView'),
    navUp: shown('libraryNav'),
    localTabUp: visible('navLocalLibrary'),
    onlineTabUp: visible('navOnlineLibrary'),
    actions: card ? [...card.querySelectorAll('.online-book-actions button')].map(b => b.textContent.trim()) : [],
    status: (document.getElementById('cloudUploadStatus') || {}).textContent || ''
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
  // No preload: this is the browser's own client.
  const win = new BrowserWindow({ show: false, width: 1100, height: 900 });
  await win.loadFile(DIST);
  await new Promise(r => setTimeout(r, 2500));
  await win.webContents.executeJavaScript(STUB);
  let r = await waitFor(win, s => s.landingUp === true || s.onlineUp === true);

  say('\n  a browser has one page, and it is not the local library\n');
  check(r.mode === 'web', 'this really is the browser client', 'mode=' + r.mode);
  check(r.localUp === false, 'no local library on show', 'localUp=' + r.localUp);
  check(r.navUp === false, 'and no switch between two libraries to offer', 'navUp=' + r.navUp);
  check(r.localTabUp === false, 'the Local Library tab is not there either', 'localTabUp=' + r.localTabUp);
  check(r.onlineTabUp === false, 'nor the Online Library tab', 'onlineTabUp=' + r.onlineTabUp);

  say('\n  asking for the local library anyway changes nothing\n');
  await win.webContents.executeJavaScript(`(() => {
    const tab = document.getElementById('navLocalLibrary');
    tab.classList.remove('hidden');
    tab.click();
    return 'clicked';
  })()`);
  await new Promise(x => setTimeout(x, 600));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.localUp === false, 'the local library still does not open', 'localUp=' + r.localUp);
  check(r.onlineUp === true || r.landingUp === true, 'it lands on the online shelf instead',
    'online=' + r.onlineUp + ' landing=' + r.landingUp);

  say('\n  signing in from the browser\n');
  await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnAccount');
    if (b && /sign in/i.test(b.textContent)) b.click();
    return 'opened';
  })()`);
  await waitFor(win, s => s.landingUp === true);
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('cloudEmail').value = 'samruddhc@example.com';
    document.getElementById('cloudPassword').value = 'correct horse battery';
    document.getElementById('cloudAuthForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 'submitted';
  })()`);
  const gated = await waitFor(win, s => s.onlineUp === true || s.status.length > 0);
  if (gated.onlineUp !== true) {
    await win.webContents.executeJavaScript(`(() => { const c = document.getElementById('cloudPlanContinue'); if (c) c.click(); return 'continued'; })()`);
  }
  r = await waitFor(win, s => s.onlineUp === true && s.actions.length > 0);
  check(r.onlineUp === true, 'the online shelf opens', 'landing=' + r.landingUp);
  check(r.actions.includes('Download'), 'with Download on the book', r.actions.join(', '));
  check(r.localUp === false, 'and still no local library', 'localUp=' + r.localUp);

  say('\n  a browser with no computer connected cannot add to a library\n');
  check(r.isBrowserLibrary === true, 'this browser is its own library, which is the case in question', 'browserLibrary=' + r.isBrowserLibrary);
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.online-book-card [data-action="download"]').click(); return 'clicked'; })()`);
  r = await waitFor(win, s => /as a file|not connected|could not/i.test(s.status), 30);
  check(/not connected to your computer/i.test(r.status),
    'and it says the book could not join the library', r.status);
  check(/as a file instead/i.test(r.status),
    'while still handing the file over', r.status);

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'the browser shows the online shelf only, and is honest when it cannot reach the library') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });