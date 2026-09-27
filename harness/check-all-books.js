/* Opens every book in the library, the way a person taps each one, and reports
   which fail. This is the real answer to "a good bit of the books don't open":
   no sampling, no guessing. */
const { app, BrowserWindow, session } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PASSWORD = process.argv[2] || '';
const ONLY = process.argv[3] || '';      // limit to a type, e.g. epub / audio / pdf

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

const failures = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000 });
  const ses = session.defaultSession;
  ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => {
    if (d.error && d.error !== 'net::ERR_ABORTED') failures.push(d.error + ' ' + d.url.slice(0, 90));
  });
  console.log('\n  ' + URL_ + '\n');
  await win.loadURL(URL_);
  await new Promise(r => setTimeout(r, 1500));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = [];
    const only = ${JSON.stringify(ONLY)};
    const tap = (card) => {
      const r = card.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2,
                  clientY: r.top + 20, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      card.dispatchEvent(new PointerEvent('pointerdown', o));
      document.dispatchEvent(new PointerEvent('pointerup', o));
    };
    const backHome = async () => {
      const b = document.getElementById('crumbHome');
      if (b) { b.click(); await sleep(1100); }
    };
    const leaveReader = async () => {
      const b = document.querySelector('#readerBar button, #btnBack');
      if (b) { b.click(); await sleep(900); }
      const rv = document.getElementById('readerView');
      if (rv && !rv.classList.contains('hidden')) { await backHome(); }
    };

    document.getElementById('loginPass').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await sleep(7000);

    // collect every book, folder by folder. Books live inside folders, so the
    // top level shows none: walk the folders, not just the first view.
    const seen = new Set();
    const FOLDERS = 12;
    for (let fi = 0; fi <= FOLDERS; fi++) {
      if (fi > 0) {
        await backHome();
        const list = document.querySelectorAll('.folder-card');
        if (!list[fi - 1]) break;
        list[fi - 1].click();
        await sleep(1600);
      }
      for (const card of [...document.querySelectorAll('.book-card')]) {
        const id = card.dataset.bookId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const title = (card.querySelector('.book-title')||{}).textContent || '?';
        const badge = (card.querySelector('.type-badge')||{}).textContent || '';
        if (only && badge.toLowerCase() !== only.toLowerCase()) continue;
        const cover = !!card.querySelector('.book-cover img');
        tap(card);
        const t0 = Date.now();
        let ok = false, chars = 0, err = null;
        const end = Date.now() + 30000;
        while (Date.now() < end) {
          await sleep(350);
          const rv = document.getElementById('readerView');
          const body = (document.getElementById('epubContent') || {}).textContent || '';
          const pdfPages = document.getElementById('pdfPages');
          const audio = document.getElementById('audioEl') || document.querySelector('audio');
          const txt = body.trim();
          if (rv && !rv.classList.contains('hidden')) {
            if (txt.length > 200) { ok = true; chars = txt.length; break; }
            if (/could not open|failed to fetch|drm|corrupt/i.test(txt)) { err = txt.replace(/\\s+/g,' ').trim().slice(0,90); break; }
            if (pdfPages && pdfPages.children.length) { ok = true; chars = 1; break; }
            if (audio) { ok = true; chars = 1; break; }
          }
        }
        out.push({ title: title.slice(0, 40), type: badge, cover, ok, secs: ((Date.now()-t0)/1000).toFixed(1), chars, err });
        await leaveReader();
        await sleep(350);
      }
    }
    return out;
  })()`);

  const good = result.filter(r => r.ok);
  const bad = result.filter(r => !r.ok);
  console.log('  opened: ' + good.length + '/' + result.length + '\n');
  result.forEach(r => {
    console.log('   ' + (r.ok ? 'ok  ' : 'FAIL') + '  ' +
      String(r.type).padEnd(5) + ' ' + (r.cover ? 'cover' : 'NOCOVER') + '  ' +
      String(r.secs).padStart(5) + 's  ' + String(r.chars).padStart(7) + ' chars  ' + r.title +
      (r.err ? '   << ' + r.err : ''));
  });
  console.log('\n  covers present: ' + result.filter(r => r.cover).length + '/' + result.length);
  if (bad.length) {
    console.log('  did not open: ' + bad.map(b => b.title).join(', '));
  } else {
    console.log('  every book opened.');
  }
  if (failures.length) {
    console.log('\n  network failures:');
    [...new Set(failures)].slice(0, 8).forEach(f => console.log('    ' + f));
  }
  app.exit(bad.length ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
