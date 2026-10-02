/* The plan chooser that appears on the sign-in page.
 *
 * What matters here is not that the cards look right but that they behave: four
 * plans, exactly one chosen at a time, the choice survives a reload, the sign-up
 * panel follows the choice, and no price or currency appears anywhere - that was
 * an explicit instruction, so it is checked rather than assumed. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fss = require('fs');
const say = (...a) => fss.writeSync(1, a.join(' ') + '\n');

let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

const REPORT = `JSON.stringify((() => {
  const grid = document.getElementById('planGrid');
  const chooser = document.getElementById('planChooser');
  const cards = [...document.querySelectorAll('.plan-card')];
  const selectable = cards.filter(c => c.getAttribute('aria-disabled') !== 'true');
  const checked = selectable.filter(c => c.getAttribute('aria-checked') === 'true');
  const pill = (c) => { const p = c.querySelector('.plan-pill'); return p ? p.textContent : ''; };
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
    submitText: (document.getElementById('cloudAuthSubmit') || {}).textContent || '',
    eyebrow: (document.getElementById('cloudAuthEyebrow') || {}).textContent || '',
    authError: (document.getElementById('cloudAuthError') || {}).textContent || '',
    toggleExists: !!document.getElementById('cloudAuthToggle'),
    stored: localStorage.getItem('sb-cloud-plan-v1')
  };
})())`;

const PICK = (name) => `(() => {
  const card = [...document.querySelectorAll('.plan-card')].find(c =>
    (c.querySelector('.plan-name') || {}).textContent === ${JSON.stringify(name)});
  if (!card) return 'no card';
  card.click();
  return 'clicked';
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
  say('\n  signing in: no plan question\n');
  check(r.gridPresent, 'the plans exist on the page');
  check(r.chooserHidden === true, 'they are hidden while signing in', 'hidden=' + r.chooserHidden);
  check(r.submitText === 'Sign in', 'the panel is asking to sign in', r.submitText);

  // --- now create an account, which is where the plan question belongs ---
  await authReady(win);
  await win.webContents.executeJavaScript(TOGGLE_SIGNUP);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));

  say('\n  creating an account: the four plans\n');
  check(r.chooserHidden === false, 'choosing to create an account reveals them', 'hidden=' + r.chooserHidden);
  check(r.submitText === 'Create account', 'the panel is asking to create an account', r.submitText);
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

  // --- a closed plan cannot be chosen, and says so ---
  await win.webContents.executeJavaScript(PICK('Pro'));
  await new Promise(r2 => setTimeout(r2, SETTLE));
  let after = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(after.checkedName === 'Free', 'clicking Pro does not select it', after.checkedName);
  check(/not available/i.test(after.authError), 'and it explains why', after.authError);
  check((after.stored || '') === 'free' || after.stored === null, 'nothing unavailable was stored', after.stored);

  // --- the panel reflects the plan that is chosen ---
  check(r.planLineHidden === false, 'it says which plan new accounts start on', r.planLine);
  check(/Free/.test(r.planLine) && /1 GB/.test(r.planLine) && /1 person/.test(r.planLine),
    'with its storage and readers', r.planLine);
  check(r.authSub === 'Start with 1 GB of private online book storage.',
    'and the sign-up line reads properly', r.authSub);

  // --- and it survives a reload ---
  await win.reload();
  await new Promise(r2 => setTimeout(r2, 3200));
  await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnAccount');
    if (b && /sign in/i.test(b.textContent)) b.click();
    return 'ok';
  })()`);
  await new Promise(r2 => setTimeout(r2, 1000));
  await authReady(win);
  await win.webContents.executeJavaScript(TOGGLE_SIGNUP);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.chooserHidden === false && r.checkedName === 'Free',
    'still offering the plans with Free chosen after a reload', r.checkedName);

  // --- signing back in hides them again ---
  await win.webContents.executeJavaScript(TOGGLE_SIGNUP);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.chooserHidden === true, 'signing in puts the plan question away again');

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'the plan chooser behaves, and shows no prices'));
  say('');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });