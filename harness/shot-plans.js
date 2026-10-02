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
    await win.webContents.executeJavaScript(`document.getElementById('cloudAuthToggle').click(); 'ok'`);
    await new Promise(r => setTimeout(r, 700));

    // how the cards actually sit on the page
    const layout = await win.webContents.executeJavaScript(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.plan-card')].map(c => {
        const r = c.getBoundingClientRect();
        return { name: (c.querySelector('.plan-name')||{}).textContent, w: Math.round(r.width), h: Math.round(r.height),
                 off: (c.getBoundingClientRect().width - c.scrollWidth) };
      });
      const auth = document.querySelector('.cloud-auth-card').getBoundingClientRect();
      const grid = document.getElementById('planGrid').getBoundingClientRect();
      return {
        cards,
        rows: new Set(cards.map(() => 0)).size && [...document.querySelectorAll('.plan-card')].map(c => Math.round(c.getBoundingClientRect().top)).filter((v, i, a) => a.indexOf(v) === i).length,
        authWidth: Math.round(auth.width),
        gridWidth: Math.round(grid.width),
        pageWidth: window.innerWidth,
        anyOverflow: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    })())`);
    const L = JSON.parse(layout);
    say('\n  ' + label + ' (' + L.pageWidth + 'px)');
    say('    cards: ' + L.cards.map(c => c.name + ' ' + c.w + 'x' + c.h).join(', '));
    say('    grid ' + L.gridWidth + 'px wide, ' + L.rows + ' row(s); auth card ' + L.authWidth + 'px');
    say('    horizontal overflow: ' + (L.anyOverflow ? 'YES - bad' : 'no'));

    const image = await win.webContents.capturePage();
    fss.writeFileSync(OUT.replace('.png', '-' + label + '.png'), image.toPNG());
  }
  say('\n  written to harness/shot-plans-wide.png and harness/shot-plans-narrow.png\n');
  app.exit(0);
}).catch(e => { say('ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
