/* Colours and backgrounds are two separate choices.
 *
 * With a couple of hundred palettes, a picker has to be searchable, and picking
 * a colour must not silently change what is behind the text. This checks both,
 * plus that the background actually reaches the page behind the words.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900 });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // A window that was never shown does not run its animation frames or repaint,
  // so a check that measures colour in it is measuring the previous theme. Put it
  // on screen, well out of the way, and let it be a real page.
  win.setPosition(-4000, 0);
  win.showInactive();
  await new Promise(r => setTimeout(r, 1200));

  const ui = await win.webContents.executeJavaScript(`(() => ({
    themes: (window.SB_THEMES || []).length,
    backgrounds: (window.SB_BACKGROUNDS || []).length,
    hook: !!window.SB_ui,
    ids: new Set((window.SB_THEMES || []).map(t => t.id)).size
  }))()`);

  say('\n  the lists\n');
  check(ui.themes > 100, 'there are hundreds of colours', ui.themes + ' themes');
  check(ui.backgrounds >= 8, 'and a list of backgrounds', ui.backgrounds + ' backgrounds');
  check(ui.ids === ui.themes, 'no two colours share an id', ui.ids + ' of ' + ui.themes);
  check(ui.hook, 'the app exposes them so a check can drive them');

  say('\n  the picker\n');
  await win.webContents.executeJavaScript(`(() => { document.getElementById('btnSettings').click(); return 1; })()`);
  await new Promise(r => setTimeout(r, 500));
  const picker = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.theme-card')];
    return JSON.stringify({
      rows: rows.length,
      colours: rows.filter(r => r.dataset.kind === 'color').length,
      bgs: rows.filter(r => r.dataset.kind === 'background').length,
      groups: [...document.querySelectorAll('.theme-group')].map(g => g.textContent.split(' ')[0]),
      hasSearch: !!document.getElementById('themeSearch'),
      count: (document.getElementById('themeCount') || {}).textContent || '',
      scrolled: getComputedStyle(document.getElementById('themeGrid')).maxHeight
    });
  })()`);
  const p = JSON.parse(picker);
  check(p.colours === ui.themes, 'every colour is listed', p.colours + ' rows');
  check(p.bgs === ui.backgrounds, 'every background is listed', p.bgs + ' rows');
  check(p.groups.join(',') === 'Colors,Backgrounds', 'under a heading each', p.groups.join(', '));
  check(p.hasSearch, 'with a box to search them');
  check(/\d+ choices/.test(p.count), 'and a count of what is there', p.count);
  check(p.scrolled !== 'none', 'the list scrolls rather than running off the panel', p.scrolled);

  say('\n  searching\n');
  const searched = await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('themeSearch');
    s.value = 'ocean';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...document.querySelectorAll('.theme-card')];
    const out = { rows: rows.length, names: rows.map(r => r.querySelector('.theme-name').textContent) };
    s.value = 'zzzznothing';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    out.empty = (document.getElementById('themeGrid').textContent || '').includes('Nothing called');
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    out.restored = document.querySelectorAll('.theme-card').length;
    return JSON.stringify(out);
  })()`);
  const s2 = JSON.parse(searched);
  check(s2.rows > 0 && s2.rows < p.rows, 'a search narrows the list', s2.rows + ' of ' + p.rows + ' rows');
  check(s2.names.every(n => /ocean/i.test(n)), 'to names that match', s2.names.join(', '));
  check(s2.empty, 'and says so when nothing matches');
  check(s2.restored === p.rows, 'clearing it brings the whole list back', s2.restored + ' rows');

  say('\n  choosing a colour really repaints\n');
  /* Applied and read from separate calls on purpose. The palette is written as
   * custom properties on the document, and the page only catches up when it is
   * asked - asking inside the same breath as the write returns the previous
   * theme's colours, which would make every dark theme look like light text on
   * white. A real app changes theme while a window is up and repaints; this has
   * to do the same thing deliberately. */
  const READ_BG = `(() => {
    const theme = window.SB_ui.themes.find(t => t.id === document.documentElement.getAttribute('data-theme'));
    // Asked of the browser in the browser's own words, so the comparison is
    // rgb() against rgb() rather than hex against rgb().
    const probe = document.createElement('div');
    probe.style.color = theme.vars['--bg'];
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return { bg: getComputedStyle(document.body).backgroundColor, want, hex: theme.vars['--bg'], name: theme.name };
  })()`;
  const shown = {};
  for (const id of ['carbon-dark', 'bliss-dark', 'ocean']) {
    await win.webContents.executeJavaScript(`window.SB_ui.applyTheme(${JSON.stringify(id)}); 1`);
    await new Promise(r => setTimeout(r, 350));
    shown[id] = await win.webContents.executeJavaScript(READ_BG);
  }
  const carbon = shown['carbon-dark'], bliss = shown['bliss-dark'], ocean = shown.ocean;
  check(carbon.bg === carbon.want, 'a dark theme paints its own background',
    carbon.name + ': ' + carbon.bg + ' (palette says ' + carbon.hex + ')');
  check(carbon.bg !== bliss.bg, 'and two dark themes are not the same colour',
    carbon.bg + ' and ' + bliss.bg);
  check(bliss.bg === bliss.want, 'the second one too',
    bliss.name + ': ' + bliss.bg + ' (palette says ' + bliss.hex + ')');
  check(ocean.bg === ocean.want, 'and a light one', ocean.name + ': ' + ocean.bg);

  say('\n  a background is chosen on its own\n');  const independent = await win.webContents.executeJavaScript(`(() => {
    const ui = window.SB_ui;
    const read = () => ({
      theme: document.documentElement.getAttribute('data-theme'),
      bg: document.documentElement.getAttribute('data-background'),
      image: getComputedStyle(document.body).backgroundImage
    });
    ui.applyTheme('ocean'); ui.applyBackground('plain');
    const plain = read();
    ui.applyBackground('diagonal');
    const diagonal = read();
    ui.applyTheme('rose-light');
    const afterColour = read();
    ui.applyBackground('plain');
    const back = read();
    return JSON.stringify({ plain, diagonal, afterColour, back });
  })()`);
  const ind = JSON.parse(independent);
  check(ind.diagonal.theme === ind.plain.theme, 'picking a background leaves the colour alone', ind.plain.theme + ' -> ' + ind.diagonal.theme);
  check(ind.diagonal.image !== ind.plain.image, 'and the page behind the text changes',
    ind.plain.image.slice(0, 24) + ' -> ' + ind.diagonal.image.slice(0, 34));
  check(ind.afterColour.bg === 'diagonal', 'picking a colour leaves the background alone', ind.afterColour.bg);
  check(ind.back.bg === 'plain', 'and the background can be changed back', ind.back.bg);
  check(ind.back.theme === ind.afterColour.theme, 'with the colour still as chosen', ind.back.theme);

  say('\n  the two are stored apart\n');
  const stored = await win.webContents.executeJavaScript(`(() => {
    const raw = JSON.parse(localStorage.getItem('sailing-books-v1') || '{}');
    return JSON.stringify({ theme: raw.settings && raw.settings.theme, background: raw.settings && raw.settings.background });
  })()`);
  const st = JSON.parse(stored);
  check(typeof st.background === 'string' && st.background.length > 0, 'the background is its own setting', JSON.stringify(st));

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'colours and backgrounds are separate, and there are a great many colours') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });