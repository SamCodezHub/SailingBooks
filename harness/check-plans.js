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
  const cards = [...document.querySelectorAll('.plan-card')];
  const checked = cards.filter(c => c.getAttribute('aria-checked') === 'true');
  return {
    gridPresent: !!grid,
    cards: cards.length,
    names: cards.map(c => (c.querySelector('.plan-name') || {}).textContent),
    specs: cards.map(c => (c.querySelector('.plan-spec') || {}).textContent),
    seats: cards.map(c => (c.querySelector('.plan-seats') || {}).textContent),
    features: cards.map(c => [...c.querySelectorAll('.plan-features li')].map(li => li.textContent)),
    checkedCount: checked.length,
    checkedName: checked[0] ? (checked[0].querySelector('.plan-name') || {}).textContent : null,
    recommended: cards.filter(c => !!c.querySelector('.plan-pill')).map(c => (c.querySelector('.plan-name') || {}).textContent),
    // explicit instruction: no prices anywhere in the chooser
    anyCurrency: (grid ? grid.textContent : '').match(/[₹$€£¥]|\\d+\\s*\\/\\s*(month|year|mo)|per month|monthly|price/i) ? (grid.textContent.match(/[₹$€£¥]|\\d+\\s*\\/\\s*(month|year|mo)|per month|monthly|price/i)[0]) : null,
    planLine: (document.getElementById('cloudPlanLine') || {}).textContent || '',
    planLineHidden: document.getElementById('cloudPlanLine') ? document.getElementById('cloudPlanLine').classList.contains('hidden') : null,
    authSub: (document.getElementById('cloudAuthSub') || {}).textContent || '',
    submitText: (document.getElementById('cloudAuthSubmit') || {}).textContent || '',
    eyebrow: (document.getElementById('cloudAuthEyebrow') || {}).textContent || '',
    toggleExists: !!document.getElementById('cloudAuthToggle'),
    stored: localStorage.getItem('sb-cloud-plan-v1'),
    accountPlan: localStorage.getItem('sb-cloud-account-plan-v1')
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
  say('\n  the plan chooser\n');
  check(r.gridPresent, 'the chooser is on the sign-in page');
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
  check(r.checkedCount === 1, 'exactly one plan is chosen', r.checkedName);
  check(r.recommended.length === 1, 'one card is marked recommended', r.recommended.join(', '));
  check(!r.anyCurrency, 'no price or currency anywhere in the chooser', r.anyCurrency ? 'found: ' + r.anyCurrency : 'none');

  // --- choosing one plan ---
  say('\n  choosing a plan\n');
  await win.webContents.executeJavaScript(PICK('Pro'));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.checkedName === 'Pro', 'clicking a card chooses it', r.checkedName);
  check(r.checkedCount === 1, 'and it is the only one chosen');
  check(r.stored === 'pro', 'the choice is remembered on the device', r.stored);

  // --- and it survives a reload ---
  await win.reload();
  await new Promise(r2 => setTimeout(r2, 3200));
  await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnAccount');
    if (b && /sign in/i.test(b.textContent)) b.click();
    return 'ok';
  })()`);
  await new Promise(r2 => setTimeout(r2, 1000));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.checkedName === 'Pro', 'still chosen after a reload', r.checkedName);

  // --- the sign-up panel follows the choice ---
  await authReady(win);
  await win.webContents.executeJavaScript(TOGGLE_SIGNUP);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.planLineHidden === false, 'creating an account shows which plan is picked',
    'submit=' + r.submitText + ' eyebrow=' + r.eyebrow + ' toggle=' + r.toggleExists + ' | ' + r.planLine);
  check(/Pro/.test(r.planLine) && /100 GB/.test(r.planLine) && /4 people/.test(r.planLine),
    'and states its storage and readers', r.planLine);
  check(r.authSub === 'Start with 100 GB of private online book storage.',
    'the sign-up line reads properly for the chosen plan', r.authSub);

  // --- switching plans moves it ---
  await win.webContents.executeJavaScript(PICK('Library'));
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(/Library/.test(r.planLine) && /200\+/.test(r.planLine), 'choosing another plan updates the line', r.planLine);
  check(/charged per GB/i.test(r.planLine), 'with that plan\'s own wording', r.planLine);
  check(r.authSub === 'Storage is charged per GB you use.',
    'and the sign-up line reads properly for it too', r.authSub);

  // --- signing back in hides it, since the plan already belongs to them ---
  await win.webContents.executeJavaScript(TOGGLE_SIGNUP);
  await new Promise(r2 => setTimeout(r2, SETTLE));
  r = JSON.parse(await win.webContents.executeJavaScript(REPORT));
  check(r.planLineHidden === true, 'signing in does not imply changing the plan');

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'the plan chooser behaves, and shows no prices'));
  say('');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });