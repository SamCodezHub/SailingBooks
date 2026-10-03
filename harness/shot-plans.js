/* Renders the account page as a person sees it, in the create-account step, and
   saves a picture of it. Layout is judged by eye; behaviour is judged by
   harness/check-plans.js. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fss = require('fs');
const say = (...a) => fss.writeSync(1, a.join(' ') + '\n');

const OUT = path.join(__dirname, '..', 'harness', 'shot-plans.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, deviceScaleFactor: 1 });
  for (const [label, width, height] of [['wide', 1440, 1000], ['narrow', 900, 1150]]) {
    win.setSize(width, height);
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise(r => setTimeout(r, 2000));
    // Earlier checks seed a library into this profile; clear it so the picture
    // shows the account page rather than somebody's test books.
    await win.webContents.executeJavaScript(`(() => { try { localStorage.removeItem('sailing-books-v1'); } catch {} return 'ok'; })()`);
    await win.reload();
    await new Promise(r => setTimeout(r, 3000));

    // Wait until the account screen is actually on show before touching it.
    let landing = false;
    for (let i = 0; i < 40; i++) {
      landing = await win.webContents.executeJavaScript(`(() => {
        const l = document.getElementById('cloudLanding');
        if (l && !l.classList.contains('hidden')) return true;
        const b = document.getElementById('btnAccount');
        if (b && /sign in/i.test(b.textContent)) b.click();
        return false;
      })()`);
      if (landing) break;
      await new Promise(r => setTimeout(r, 250));
    }
    if (!landing) { say('\n  ' + label + ': could not reach the account page'); continue; }
    // wait for the panel to settle, then switch to creating an account
    for (let i = 0; i < 30; i++) {
      const s = await win.webContents.executeJavaScript(`(() => {
        const t = document.getElementById('cloudAuthToggle');
        return t ? t.textContent : 'missing';
      })()`);
      if (/create an account/i.test(s)) break;
      await new Promise(r => setTimeout(r, 250));
    }
    // The plans appear only once an address is confirmed, so open that step
    // rather than the sign-in form, which correctly shows none. Opening it this
    // way is artificial, and a session check landing afterwards closes the gate
    // again, so wait until it is genuinely on screen before the shutter.
    const GATE = `(() => {
      document.getElementById('planChooser').classList.remove('hidden');
      const n = document.getElementById('cloudPlanGateNote');
      n.classList.remove('hidden');
      document.getElementById('cloudAuthEyebrow').textContent = 'ONE LAST THING';
      document.getElementById('cloudAuthTitle').textContent = 'Choose your plan';
      document.getElementById('cloudAuthSub').textContent = 'Your account is confirmed and ready.';
      n.innerHTML = 'Pick <b>Free</b> and your library is ready to use.';
      document.getElementById('cloudPlanContinue').classList.remove('hidden');
      document.getElementById('cloudAuthForm').classList.add('hidden');
      document.getElementById('cloudAuthToggle').classList.add('hidden');
      return 'ok';
    })()`;
    const gateUp = `(() => {
      const c = document.getElementById('planChooser');
      return getComputedStyle(c).display !== 'none' &&
        document.querySelectorAll('.plan-card').length === 4;
    })()`;
    let open = false;
    for (let i = 0; i < 12; i++) {
      await win.webContents.executeJavaScript(GATE);
      await new Promise(r => setTimeout(r, 350));
      if (await win.webContents.executeJavaScript(gateUp)) { open = true; break; }
    }
    if (!open) { say('\n  ' + label + ': the plan step would not stay open'); continue; }

    // how the cards actually sit on the page
    const layout = await win.webContents.executeJavaScript(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.plan-card')].map(c => {
        const r = c.getBoundingClientRect();
        return { name: (c.querySelector('.plan-name')||{}).textContent, w: Math.round(r.width), h: Math.round(r.height),
                 off: (c.getBoundingClientRect().width - c.scrollWidth) };
      });
      const auth = document.querySelector('.cloud-auth-card').getBoundingClientRect();
      const grid = document.getElementById('planGrid').getBoundingClientRect();
      const chooser = document.getElementById('planChooser').getBoundingClientRect();
      return {
        cards,
        rows: new Set(cards.map(() => 0)).size && [...document.querySelectorAll('.plan-card')].map(c => Math.round(c.getBoundingClientRect().top)).filter((v, i, a) => a.indexOf(v) === i).length,
        authWidth: Math.round(auth.width),
        gridWidth: Math.round(grid.width),
        chooserTop: Math.round(chooser.top),
        chooserHeight: Math.round(chooser.height),
        onScreen: chooser.top < window.innerHeight && chooser.bottom > 0,
        pageWidth: window.innerWidth,
        anyOverflow: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    })())`);
    const L = JSON.parse(layout);
    say('\n  ' + label + ' (' + L.pageWidth + 'px)');
    say('    cards: ' + L.cards.map(c => c.name + ' ' + c.w + 'x' + c.h).join(', '));
    say('    grid ' + L.gridWidth + 'px wide, ' + L.rows + ' row(s); auth card ' + L.authWidth + 'px');
    say('    chooser at y=' + L.chooserTop + ', ' + L.chooserHeight + 'px tall, on screen: ' + L.onScreen);
    say('    horizontal overflow: ' + (L.anyOverflow ? 'YES - bad' : 'no'));

    // A window that was never shown does not reliably repaint just because a
    // class changed, so put it on screen (well off to the left, out of the way)
    // and let a frame land before the shutter.
    win.setPosition(-4000, 0);
    win.showInactive();
    await new Promise(r => setTimeout(r, 900));

    const image = await win.webContents.capturePage();
    fss.writeFileSync(OUT.replace('.png', '-' + label + '.png'), image.toPNG());
  }
  say('\n  written to harness/shot-plans-wide.png and harness/shot-plans-narrow.png\n');
  app.exit(0);
}).catch(e => { say('ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
