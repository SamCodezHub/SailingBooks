/* Real Chromium: sign in, open a folder, then look at the book covers in it and
   try to open one. This is the view the phone actually shows. */
const { app, BrowserWindow, session } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PASSWORD = process.argv[2] || '';
const WANT = (process.argv[3] || '').toLowerCase();

const tsExe = (() => {
  if (process.platform !== 'win32') return 'tailscale';
  for (const d of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!d) continue;
    const p = path.join(d, 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tailscale';
})();
const bare = (s) => String(s).replace(/\x1b\[[0-9;;]*[A-Za-z]/g, '');
const st = spawnSync(tsExe, ['funnel', 'status'], { encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL' });
const mm = /https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net)/i.exec(bare((st.stdout || '') + (st.stderr || '')));
const URL_ = mm ? 'https://' + mm[1] : '';
if (!URL_) { console.log('no funnel address'); app.exit(1); }
app.disableHardwareAcceleration();

const failures = [], errors = [], replies = new Map();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000 });
  const ses = session.defaultSession;
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => replies.set(d.url, d.statusCode));
  ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => {
    if (d.error && d.error !== 'net::ERR_ABORTED') failures.push(d.error + '  ' + d.method + '  ' + d.url);
  });
  win.webContents.on('console-message', (e) => {
    const msg = (e && e.message) || '';
    if (/error|failed|uncaught|cors/i.test(msg)) errors.push(msg.slice(0, 240));
  });

  console.log('\n  ' + URL_ + '\n');
  await win.loadURL(URL_);
  await new Promise(r => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.getElementById('loginPass').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await sleep(7000);
    window.__want = ${JSON.stringify(WANT)};
    window.__find = async () => {
      // walk every folder until the wanted title shows up
      for (let i = 0; i < 12; i++) {
        const hit = [...document.querySelectorAll('.book-card')]
          .find(c => (c.textContent || '').toLowerCase().includes(window.__want));
        if (hit) return true;
        const back = document.getElementById('crumbHome');
        if (back) { back.click(); await sleep(1200); }
        const folders = [...document.querySelectorAll('.folder-card')];
        if (!folders[i]) return false;
        folders[i].click();
        await sleep(1800);
      }
      return false;
    };
    await window.__find();
  })()`);

  const shelf = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('.book-card')];
    const imgs = cards.map(c => c.querySelector('.book-cover img')).filter(Boolean);
    const coverBoxes = cards.map(c => c.querySelector('.book-cover')).filter(Boolean);
    return {
      bookCards: cards.length,
      coverBoxes: coverBoxes.length,
      imgTagsPresent: imgs.length,
      imgActuallyRendered: imgs.filter(i => i.naturalWidth > 0).length,
      srcExample: imgs[0] ? imgs[0].getAttribute('src') : '(no img tag at all)'
    };
  })()`);
  console.log('  folder view, as the browser sees it:');
  for (const [k, v] of Object.entries(shelf)) console.log('    ' + k.padEnd(22) + JSON.stringify(v));

  const target = WANT || (await win.webContents.executeJavaScript(
    `(document.querySelector('.book-card .book-title')||{}).textContent || ''`)) || '';

  const opened = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const want = ${JSON.stringify(target.toLowerCase())};
    let cards = [...document.querySelectorAll('.book-card')];
    let card = cards.find(c => (c.textContent||'').toLowerCase().includes(want));
    if (!card) {
      const back = document.getElementById('crumbHome');
      if (back) { back.click(); await sleep(1200); }
      const folders = [...document.querySelectorAll('.folder-card')];
      for (const f of folders) {
        f.click(); await sleep(1800);
        card = [...document.querySelectorAll('.book-card')]
          .find(c => (c.textContent||'').toLowerCase().includes(want));
        if (card) break;
        const b2 = document.getElementById('crumbHome');
        if (b2) { b2.click(); await sleep(900); }
      }
    }
    if (!card) return { error: 'could not find "' + want + '" in any folder' };
    const title = (card.querySelector('.book-title')||{}).textContent;
    const t0 = Date.now();
    // The app tells a tap from a drag with pointer events, so drive those and
    // not a synthetic click, or nothing opens.
    const r = card.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + 20;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    card.dispatchEvent(new PointerEvent('pointerdown', opts));
    await sleep(90);
    // the tap is decided in a pointerup listener on document, and the pointer
    // id has to match, so both matter
    document.dispatchEvent(new PointerEvent('pointerup', opts));
    const waitFor = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const rv = document.getElementById('readerView');
        const c = document.getElementById('epubContent');
        if (rv && !rv.classList.contains('hidden') && c && (c.textContent||'').trim().length > 200) return true;
        await sleep(400);
      }
      return false;
    };
    const openedOk = await waitFor(40000);
    const ms = Date.now() - t0;
    const rv = document.getElementById('readerView');
    const content = document.getElementById('epubContent');
    const txt = content ? (content.textContent||'').trim() : '';
    const err = (document.getElementById('epubContent')||{textContent:''}).textContent;
    return {
      clicked: title,
      openedIn: openedOk ? (ms/1000).toFixed(1) + 's' : 'did not open in 40s',
      readerShown: rv ? !rv.classList.contains('hidden') : null,
      visibleTextChars: txt.length,
      firstWords: txt.replace(/\\s+/g,' ').slice(0, 110),
      errorText: /could not open|failed to fetch|drm/i.test(err) ? err.replace(/\\s+/g,' ').trim().slice(0,160) : null
    };
  })()`);
  console.log('\n  opening "' + target + '":');
  for (const [k, v] of Object.entries(opened)) console.log('    ' + k.padEnd(20) + JSON.stringify(v));

  console.log('\n  failed requests (' + failures.length + '):');
  [...new Set(failures)].slice(0, 10).forEach(f => console.log('    ' + f.replace(URL_, '…').slice(0, 150)));
  if (!failures.length) console.log('    none');
  if (errors.length) { console.log('\n  console errors:'); [...new Set(errors)].slice(0, 6).forEach(e => console.log('    ' + e)); }

  console.log('\n  response codes:');
  const codes = {};
  for (const [u, s] of replies) {
    const k = u.replace(URL_, '').replace(/\?.*/, '').replace(/[0-9a-f]{10,}/g, ':id');
    codes[k] = codes[k] || new Set(); codes[k].add(s);
  }
  Object.entries(codes).forEach(([k, v]) => console.log('    ' + [...v].join(',') + '  ' + k.slice(0, 100)));
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
