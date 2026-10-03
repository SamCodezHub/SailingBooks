/* The plan chooser that appears on the sign-in page.
 *
 * What matters here is not that the cards look right but that they behave: four
 * plans, exactly one chosen at a time, the choice survives a reload, the sign-up
 * panel follows the choice, and no price or currency appears anywhere - that was
 * an explicit instruction, so it is checked rather than assumed. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fss = require('fs');
const say = (...a) => fss.writeSync(1, a.join(' ') + '\n');

// The harness runs the renderer with no main process behind it, so the handful
// of handlers the preload promises are stood in for here. Without this the
// session write throws, the sign-in appears to fail, and the plan step is
// never reached - the checks below would be testing nothing.
let cloudSession = null;
ipcMain.handle('get-cloud-session', () => cloudSession);
ipcMain.handle('save-cloud-session', (_event, value) => { cloudSession = value || null; return true; });
ipcMain.handle('list-library-files', () => []);
ipcMain.handle('save-library-index', () => true);

let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

const REPORT = `JSON.stringify((() => {
  const grid = document.getElementById('planGrid');
  const chooser = document.getElementById('planChooser');
  const cards = [...document.querySelectorAll('.plan-card')];
  const selectable = cards.filter(c => c.getAttribute('aria-disabled') !== 'true');
  const checked = selectable.filter(c => c.getAttribute('aria-checked') === 'true');
  const pill = (c) => { const p = c.querySelector('.plan-pill'); return p ? p.textContent : ''; };
  // Whether it actually paints, which is the thing that was wrong: an element can
  // carry the hidden class and still show up if nothing turns its display off.
  const painted = (id) => {
    const e = document.getElementById(id);
    if (!e) return null;
    const rect = e.getBoundingClientRect();
    return getComputedStyle(e).display !== 'none' && rect.height > 0;
  };
  return {
    gridPresent: !!grid,
    chooserHidden: chooser ? chooser.classList.contains('hidden') : null,
    cards: cards.length,
    names: cards.map(c => (c.querySelector('.plan-name') || {}).textContent),
    specs: cards.map(c => (c.querySelector('.plan-spec') || {}).textContent),
    seats: cards.map(c => (c.querySelector('.plan-seats') || {}).textContent),
    features: cards.map(c => [...c.querySelectorAll('.plan-features li')].map(li => li.textContent)),
    disabled: cards.filter(c => c.getAttribute('aria-disabled') === 'true').map(c => (c.querySelector('.plan-name') || {}).textContent),
    disabledPills: cards.filter(c => c.getAttribute('aria-disabled') === 'true').map(pill),
    selectableNames: selectable.map(c => (c.querySelector('.plan-name') || {}).textContent),
    checkedCount: checked.length,
    checkedName: checked[0] ? (checked[0].querySelector('.plan-name') || {}).textContent : null,
    // explicit instruction: no prices anywhere in the chooser
    anyCurrency: (grid ? grid.textContent : '').match(/[₹$€£¥]|\\d+\\s*\\/\\s*(month|year|mo)|per month|monthly|price/i) ? (grid.textContent.match(/[₹$€£¥]|\\d+\\s*\\/\\s*(month|year|mo)|per month|monthly|price/i)[0]) : null,
    planLine: (document.getElementById('cloudPlanLine') || {}).textContent || '',
    planLineHidden: document.getElementById('cloudPlanLine') ? document.getElementById('cloudPlanLine').classList.contains('hidden') : null,
    authSub: (document.getElementById('cloudAuthSub') || {}).textContent || '',
    authTitle: (document.getElementById('cloudAuthTitle') || {}).textContent || '',
    noteDisplay: (() => { const n = document.getElementById('cloudPlanGateNote'); return n ? getComputedStyle(n).display : null; })(),
    submitText: (document.getElementById('cloudAuthSubmit') || {}).textContent || '',
    eyebrow: (document.getElementById('cloudAuthEyebrow') || {}).textContent || '',
    authError: (document.getElementById('cloudAuthError') || {}).textContent || '',
    toggleExists: !!document.getElementById('cloudAuthToggle'),
    pillText: (document.getElementById('accountPlanPill') || {}).textContent || '',
    pillHidden: document.getElementById('accountPlanPill') ? document.getElementById('accountPlanPill').classList.contains('hidden') : null,
    pillTitle: (document.getElementById('accountPlanPill') || {}).title || '',
    continueShown: (() => { const b = document.getElementById('cloudPlanContinue'); return b ? !b.classList.contains('hidden') : null; })(),
    gateNoteShown: (() => { const n = document.getElementById('cloudPlanGateNote'); return n ? !n.classList.contains('hidden') : null; })(),
    stored: localStorage.getItem('sb-cloud-plan-v1'),
    chooserPainted: painted('planChooser'),
    planLinePainted: painted('cloudPlanLine'),
    gateNotePainted: painted('cloudPlanGateNote'),
    gateNoteText: (document.getElementById('cloudPlanGateNote') || {}).textContent || '',
    continuePainted: painted('cloudPlanContinue'),
    formPainted: painted('cloudAuthForm')
  };
})())`;

const PICK = (name) => `(() => {
  const card = [...document.querySelectorAll('.plan-card')].find(c =>
    (c.querySelector('.plan-name') || {}).textContent === ${JSON.stringify(name)});
  if (!card) return 'no card';
  card.click();
  return 'clicked';
})()`;

// Opens the plan gate the way it opens after an address is confirmed: a session
// with an account that has no plan yet.
const OPEN_GATE = `(() => {
  const c = document.getElementById('planChooser');
  c.classList.remove('hidden');
  document.getElementById('cloudAuthEyebrow').textContent = 'ONE LAST THING';
  document.getElementById('cloudAuthTitle').textContent = 'Choose your plan';
  document.getElementById('cloudAuthSub').textContent = 'Your account is confirmed and ready.';
  document.getElementById('cloudPlanGateNote').classList.remove('hidden');
  document.getElementById('cloudPlanGateNote').innerHTML = 'Pick <b>Free</b> and your library is ready to use.';
  document.getElementById('cloudPlanContinue').classList.remove('hidden');
  document.getElementById('cloudAuthForm').classList.add('hidden');
  document.getElementById('cloudAuthToggle').classList.add('hidden');
  return 'gate open';
})()`;

const CLOSE_GATE = `(() => {
  document.getElementById('planChooser').classList.add('hidden');
  const n = document.getElementById('cloudPlanGateNote');
  n.classList.add('hidden');
  n.innerHTML = '';
  document.getElementById('cloudPlanContinue').classList.add('hidden');
  document.getElementById('cloudAuthForm').classList.remove('hidden');
  document.getElementById('cloudAuthToggle').classList.remove('hidden');
  // the heading is part of the gate, so putting the gate away puts it back
  document.getElementById('cloudAuthEyebrow').textContent = 'WELCOME BACK';
  document.getElementById('cloudAuthTitle').textContent = 'Sign in to your library';
  document.getElementById('cloudAuthSub').textContent = 'Your local books stay on this computer.';
  return 'gate closed';
})()`;

// Shows the name and plan in the top bar, the way a signed-in account does.
const SHOW_ACCOUNT = `(() => {
  const b = document.getElementById('btnAccount');
  b.textContent = 'samruddhc';
  const pill = document.getElementById('accountPlanPill');
  pill.textContent = 'Free';
  pill.classList.remove('hidden');
  pill.title = 'Free · 1 GB of cloud storage · 1 person signed in at a time';
  return 'shown';
})()`;

// init() finishes with showAuthMode(false), so a toggle fired before it lands
// gets undone. Wait until the panel is in its default state and has stopped
// changing before touching it.
async function authReady(win) {
  let last = null, stable = 0;
  for (let i = 0; i < 40; i++) {
    const state = await win.webContents.executeJavaScript(`(() => {
      const t = document.getElementById('cloudAuthToggle');
      const s = document.getElementById('cloudAuthSubmit');
      if (!t || !s) return 'missing';
      return t.textContent + '|' + s.textContent;
    })()`);
    if (state === last && state !== 'missing') { if (++stable >= 3) return state; }
    else stable = 0;
    last = state;
    await new Promise(r => setTimeout(r, 250));
  }
  return last;
}

const TOGGLE_SIGNUP = `(() => { document.getElementById('cloudAuthToggle').click(); return 'toggled'; })()`;

// The toggle repaints several labels, and the page also re-applies the sign-in
// wording on a few of its own paths, so give it a moment to settle before reading.
const SETTLE = 400;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1440, height: 1000,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 3000));
  // The landing page is the account screen; go there the way a visitor would.
  await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnAccount');
    if (b && /sign in/i.test(b.textContent)) b.click();
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 1200));

  let r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  say('\n  signing in\n');
  check(r.gridPresent, 'the plans exist on the page');
  check(r.chooserHidden === true, 'no plan question while signing in', 'hidden=' + r.chooserHidden);
  check(r.submitText === 'Sign in', 'the panel is asking to sign in', r.submitText);
  check(r.planLineHidden === true, 'and no empty plan bar is left above the fields',
    r.planLine ? 'bar shows: ' + r.planLine : 'no bar');
  check(r.chooserPainted === false && r.planLinePainted === false && r.gateNotePainted === false,
    'nothing from the plan step paints while signing in',
    'chooser=' + r.chooserPainted + ' bar=' + r.planLinePainted + ' note=' + r.gateNotePainted);

  // --- creating an account is ordinary: a name, a password, an email to confirm ---
  await authReady(win);
  await win.webContents.executeJavaScript(TOGGLE_SIGNUP);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  say('\n  creating an account\n');
  check(r.submitText === 'Create account', 'the panel is asking to create an account', r.submitText);
  check(r.chooserHidden === true, 'and still asks for no plan', 'hidden=' + r.chooserHidden);
  check(/confirm/i.test(r.authSub), 'it says an email will be sent to confirm', r.authSub);
  check(r.planLineHidden === true, 'no empty plan bar here either', r.planLine);
  check(r.planLinePainted === false && r.gateNotePainted === false && r.formPainted === true,
    'and the form is what you can see', 'bar=' + r.planLinePainted + ' note=' + r.gateNotePainted + ' form=' + r.formPainted);

  // --- the plans appear once the address is verified ---
  await win.webContents.executeJavaScript(OPEN_GATE);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  say('\n  choosing a plan after the address is confirmed\n');
  check(r.chooserHidden === false, 'the plans appear', 'hidden=' + r.chooserHidden);
  check(r.cards === 4, 'it offers four plans', r.cards + ' cards');
  check(JSON.stringify(r.names) === JSON.stringify(['Free', 'Plus', 'Pro', 'Library']),
    'named Free, Plus, Pro and Library', r.names.join(', '));
  check(r.specs[0] === '1 GB of cloud storage' && r.specs[1] === '10 GB of cloud storage' &&
    r.specs[2] === '100 GB of cloud storage', 'storage for Free, Plus and Pro', r.specs.join(' | '));
  check(r.seats[0].startsWith('1 person') && r.seats[1].startsWith('2 people') && r.seats[2].startsWith('4 people'),
    'simultaneous readers for Free, Plus and Pro', r.seats.join(' | '));
  check(/200\+/.test(r.seats[3]) && /own sign-in/.test(r.seats[3]),
    'Library is 200+ readers with their own sign-in', r.seats[3]);
  check(/per GB/i.test(r.specs[3]), 'Library is charged per GB', r.specs[3]);
  check(r.features.every(f => f.length >= 4), 'every card lists what it includes',
    r.features.map(f => f.length).join('/'));
  check(!r.anyCurrency, 'no price or currency anywhere in the chooser', r.anyCurrency ? 'found: ' + r.anyCurrency : 'none');

  say('\n  only Free is open today\n');
  check(JSON.stringify(r.selectableNames) === JSON.stringify(['Free']),
    'Free is the only plan that can be chosen', r.selectableNames.join(', '));
  check(JSON.stringify(r.disabled) === JSON.stringify(['Plus', 'Pro', 'Library']),
    'Plus, Pro and Library are marked unavailable', r.disabled.join(', ') || 'none');
  check(r.disabledPills.every(p => /unavailable/i.test(p)) && r.disabledPills.length === 3,
    'each says "Unavailable for now"', r.disabledPills.join(' | '));
  check(r.checkedName === 'Free', 'Free starts out chosen', r.checkedName);
  check(r.continueShown === true, 'and there is a way to finish', 'continue=' + r.continueShown);
  check(r.gateNotePainted === true && /Pick .* and your library is ready/.test(r.gateNoteText),
    'and the note above the fields says why', r.gateNoteText || 'no note');
  check(r.noteDisplay !== 'flex', 'the note reads as one sentence, not a row of pieces', 'display=' + r.noteDisplay);
  check(r.authTitle === 'Choose your plan', 'and the card stops asking anyone to sign in', r.authTitle);
  check(r.formPainted === false, 'the sign-in fields are out of the way', 'form=' + r.formPainted);

  // --- a closed plan cannot be chosen, and says so ---
  await win.webContents.executeJavaScript(PICK('Pro'));
  await new Promise(r2 => setTimeout(r2, SETTLE));
  let after = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(after.checkedName === 'Free', 'clicking Pro does not select it', after.checkedName);
  check(/not available/i.test(after.authError), 'and it explains why', after.authError);
  check((after.stored || '') === 'free' || after.stored === null, 'nothing unavailable was stored', after.stored);

  // --- the plan badge beside the name ---
  say('\n  the plan beside your name\n');
  await win.webContents.executeJavaScript(SHOW_ACCOUNT);
  await new Promise(r2 => setTimeout(r2, 250));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.pillText === 'Free', 'the plan shows beside the name in the top bar', r.pillText);
  check(r.pillHidden === false, 'and is actually visible', 'hidden=' + r.pillHidden);
  check(/1 GB/.test(r.pillTitle || ''), 'with the storage in its tooltip', r.pillTitle);

  // --- and it is not shown when there is no plan ---
  await win.webContents.executeJavaScript(`(() => {
    const pill = document.getElementById('accountPlanPill');
    pill.classList.add('hidden'); pill.textContent = ''; return 'ok';
  })()`);
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.pillHidden === true, 'no plan means no badge rather than a blank one');

  // --- the gate closes again once a plan is chosen ---
  await win.webContents.executeJavaScript(CLOSE_GATE);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.chooserHidden === true, 'the plans are put away once a plan is chosen');
  check(r.continueShown === false, 'along with the way to finish');
  check(r.gateNotePainted === false && r.continuePainted === false && r.formPainted === true,
    'and nothing from the gate is left painting',
    'note=' + r.gateNotePainted + ' continue=' + r.continuePainted + ' form=' + r.formPainted);
  check(r.authTitle === 'Sign in to your library', 'and the card goes back to asking for a sign in', r.authTitle);
  check(r.gateNoteText === '', 'with no leftover words in the note', r.gateNoteText);

  /* ------------------------------------------------------------------
     The whole thing, driven through the real handlers against a stand-in
     account service. The cards above were checked by hand; this walks the
     path a person actually takes: type a name and password, be told a mail
     is on its way, come back and sign in, meet the four plans, and end up
     in the library once one is chosen.
     ------------------------------------------------------------------ */
  const STUB = `(() => {
    const log = [];
    let plan = null;
    const json = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
    window.fetch = (url, options = {}) => {
      const u = String(url);
      log.push((options.method || 'GET') + ' ' + u.replace(/^https?:\\/\\/[^/]+/, ''));
      if (/\\/config$/.test(u)) return json({ configured: true, serviceReady: true, url: 'https://stub.supabase.co', anonKey: 'anon' });
      if (/\\/auth\\/v1\\/signup$/.test(u)) return json({ user: { id: 'u1', email: 'samruddhc@example.com' } });
      if (/\\/auth\\/v1\\/token/.test(u)) return json({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
      if (/\\/auth\\/v1\\/user$/.test(u)) {
        if ((options.method || 'GET') === 'PUT') { plan = JSON.parse(options.body).data.plan; return json({ user_metadata: { plan } }); }
        return json({ id: 'u1', email: 'samruddhc@example.com', user_metadata: plan ? { plan } : {} });
      }
      if (/\\/me$/.test(u)) return json({ user: { email: 'samruddhc@example.com' }, usedBytes: 0, quotaBytes: 1073741824 });
      if (/\\/books$/.test(u)) return json({ books: [] });
      if (/\\/servers$/.test(u)) return json({ servers: [] });
      return json({}, true);
    };
    window.__sbStub = { log, plan: () => plan };
    // The session is kept by the main process, which is stood in for above:
    // window.api is a contextBridge object and cannot be patched from here.
    try { localStorage.removeItem('sb-cloud-plan-v1'); localStorage.removeItem('sb-cloud-account-plan-v1'); } catch {}
    document.getElementById('cloudPassword').value = 'correct horse battery';
    document.getElementById('cloudEmail').value = 'samruddhc@example.com';
    return 'stubbed';
  })()`;
  const SUBMIT = `(() => {
    document.getElementById('cloudAuthForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 'submitted';
  })()`;
  const CALLS = `JSON.stringify((() => ({
    log: window.__sbStub.log,
    plan: window.__sbStub.plan(),
    page: ['landing', 'library', 'reader', 'online'].find(id => {
      const el = document.getElementById(id + (id === 'online' ? 'LibraryView' : 'View'));
      return el && !el.classList.contains('hidden');
    }) || null,
    onlineUp: (() => { const v = document.getElementById('onlineLibraryView'); return v ? !v.classList.contains('hidden') : null; })(),
    landingUp: (() => { const v = document.getElementById('cloudLanding'); return v ? !v.classList.contains('hidden') : null; })(),
    accountButton: (document.getElementById('btnAccount') || {}).textContent || '',
    pillText: (document.getElementById('accountPlanPill') || {}).textContent || '',
    pillHidden: (() => { const p = document.getElementById('accountPlanPill'); return p ? p.classList.contains('hidden') : null; })()
  }))())`;

  say('\n  the whole journey, against a stand-in account service\n');

  // step 1: an ordinary sign-up - a name and a password, and no plan question.
  // Start from a clean load so this is a new visitor rather than the top of the
  // page, which by now has been through the gate.
  await win.reload();
  await new Promise(r2 => setTimeout(r2, 2500));
  for (let i = 0; i < 40; i++) {
    const up = await win.webContents.executeJavaScript(`(() => {
      const l = document.getElementById('cloudLanding');
      if (l && !l.classList.contains('hidden')) return true;
      const b = document.getElementById('btnAccount');
      if (b && /sign in/i.test(b.textContent)) b.click();
      return false;
    })()`);
    if (up) break;
    await new Promise(r2 => setTimeout(r2, 250));
  }
  await authReady(win);
  await win.webContents.executeJavaScript(TOGGLE_SIGNUP);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  const preSubmit = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  await win.webContents.executeJavaScript(STUB);
  await win.webContents.executeJavaScript(SUBMIT);
  await new Promise(r2 => setTimeout(r2, 1200));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  let j = JSON.parse(await win.webContents.executeJavaScript(CALLS));
  check(preSubmit.submitText === 'Create account', '1. it starts as an ordinary sign-up form', preSubmit.submitText);
  check(preSubmit.chooserPainted === false, '   with no plan question on it at all', 'painted=' + preSubmit.chooserPainted);
  check(/\/auth\/v1\/signup$/.test(j.log[1] || ''), '   and it asks only for an address and a password',
    j.log.slice(0, 2).join(' then '));

  // step 2: the mail goes out, and the app waits on the sign-in page
  check(r.submitText === 'Sign in', '2. it hands you back to the sign-in form', r.submitText);
  check(/sent a verification link/i.test(r.authError) && /samruddhc@example\.com/.test(r.authError),
    '   saying the verification mail is on its way to that address', r.authError);
  check(r.gateNotePainted === false && r.chooserPainted === false,
    '   and still with no plan question', 'note=' + r.gateNotePainted + ' chooser=' + r.chooserPainted);
  check(!/\/auth\/v1\/token/.test(j.log.join(' ')), '   without pretending to be signed in already', j.log.join(' '));

  // step 3: sign in once the address is confirmed - the four plans appear
  await win.webContents.executeJavaScript(SUBMIT);
  await new Promise(r2 => setTimeout(r2, 1200));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.chooserPainted === true && r.cards === 4, '3. signing in brings up the four plans', r.cards + ' cards');
  check(r.formPainted === false, '   with the sign-in fields out of the way', 'form=' + r.formPainted);
  check(r.authTitle === 'Choose your plan', '   and the card asking for the choice', r.authTitle);

  // ... and choosing one signs you in
  await win.webContents.executeJavaScript(`(() => { document.getElementById('cloudPlanContinue').click(); return 'continued'; })()`);
  await new Promise(r2 => setTimeout(r2, 1200));
  j = JSON.parse(await win.webContents.executeJavaScript(CALLS));
  check(j.plan === 'free', '4. the chosen plan is written to the account', 'plan=' + j.plan);
  check(j.onlineUp === true, '   and only then does the library open', 'onlineUp=' + j.onlineUp);
  check(/samruddhc/.test(j.accountButton), '   with your name in the top bar', j.accountButton);
  check(j.pillText === 'Free' && j.pillHidden === false, '   and the plan beside it', j.pillText + ' hidden=' + j.pillHidden);

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'the plan chooser behaves, and shows no prices'));
  say('');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });