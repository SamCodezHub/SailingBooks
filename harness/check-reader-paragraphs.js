/* How paragraphs are set, which is the difference between a page of text and a
 * wall of it.
 *
 * A book is allowed to bring its own inline styles, and one of those can rule a
 * line under every paragraph. So this opens a reader with a book that does
 * exactly that, and checks the reader wins. It also checks the indenting is book
 * shaped: paragraphs indented, the one that opens a section flush, and both
 * reader views set the same way. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
let bad = 0;
const check = (ok, label, extra) => { if (!ok) bad++; say('   ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra ? '   ' + extra : '')); };

ipcMain.handle('get-cloud-session', () => null);
ipcMain.handle('save-cloud-session', () => true);
ipcMain.handle('list-library-files', () => []);
ipcMain.handle('save-library-index', () => true);

// A chapter that fights the reader: a rule under every paragraph, and its own
// background. Also a heading and a break, to see the first paragraph after them.
const HOSTILE = `
  <h2>A Chapter</h2>
  <p>First paragraph of the chapter, which should sit flush because it opens a section.</p>
  <p style="border-bottom:2px solid #f00; background:#fee; margin:0">Second paragraph, dragged across with a rule under it.</p>
  <p>Third paragraph, plain, and it should be indented.</p>
  <hr class="chapter-break"/>
  <p>Fourth paragraph, after the break, and it should be flush too.</p>
  <p style="text-indent: 9em">Fifth paragraph, with a huge indent of its own, which the reader should replace with the book indent.</p>
  <p>Sixth paragraph, indented the book way.</p>`;

const STUB = `(() => {
  window.__sbRead = null;
  // Stand in for opening a book: put the hostile chapter into the reader.
  const paint = () => {
    const c = document.getElementById('epubContent');
    if (!c) return false;
    c.innerHTML = ${JSON.stringify(HOSTILE)};
    return true;
  };
  return 'ready';
})()`;

const REPORT = `JSON.stringify((() => {
  const c = document.getElementById('epubContent');
  if (!c) return '{}';
  const ps = [...c.querySelectorAll('p')];
  const d = el => { const s = getComputedStyle(el); return {
    indent: s.textIndent, align: s.textAlign, border: s.borderBottomWidth + ' ' + s.borderBottomStyle,
    background: s.backgroundColor, margin: s.marginBottom, block: s.display }; };
  return {
    count: ps.length,
    first: ps[0] ? d(ps[0]) : null,
    ruled: ps[1] ? d(ps[1]) : null,
    third: ps[2] ? d(ps[2]) : null,
    afterBreak: ps[3] ? d(ps[3]) : null,
    ownIndent: ps[4] ? d(ps[4]) : null,
    sixth: ps[5] ? d(ps[5]) : null,
    // the paged view is the same words set the other way up
    paged: (() => { const p = document.getElementById('pagedInner'); if (!p) return null;
      p.innerHTML = ${JSON.stringify(HOSTILE)};
      const q = p.querySelectorAll('p')[2]; const s = getComputedStyle(q);
      return { indent: s.textIndent, align: s.textAlign, border: s.borderBottomWidth + ' ' + s.borderBottomStyle }; })()
  };
})())`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2500));
  await win.webContents.executeJavaScript(STUB);
  await win.webContents.executeJavaScript(`document.getElementById('epubContent').innerHTML = ${JSON.stringify(HOSTILE)}; 'painted'`);
  const r = JSON.parse(await win.webContents.executeJavaScript(REPORT));

  say('\n  a book cannot rule a line under the text\n');
  check(r.count === 6, 'the chapter is in the reader', r.count + ' paragraphs');
  check(r.ruled && /^0px none/.test(r.ruled.border), 'the rule under a paragraph is gone', r.ruled && r.ruled.border);
  check(r.ruled && r.ruled.background === 'rgba(0, 0, 0, 0)', 'and so is the background it set', r.ruled && r.ruled.background);
  check(r.paged && /^0px none/.test(r.paged.border), 'in the paged view too', r.paged && r.paged.border);

  say('\n  paragraphs are set like a book\n');
  check(r.third && r.third.block === 'block', 'each paragraph starts on its own line', r.third && r.third.block);
  const indent = parseFloat(r.third.indent);
  check(indent > 4 && indent < 40, 'and the first line is indented', 'text-indent: ' + r.third.indent);
  check(r.ownIndent && parseFloat(r.ownIndent.indent) === indent, "a book's own absurd indent is replaced", r.ownIndent && r.ownIndent.indent);
  check(r.first && parseFloat(r.first.indent) === 0, 'the paragraph that opens a section is flush', r.first && r.first.indent);
  check(r.afterBreak && parseFloat(r.afterBreak.indent) === 0, 'and the one after a break too', r.afterBreak && r.afterBreak.indent);
  check(parseFloat(r.third.margin) > 4, 'with a clear gap between paragraphs', 'margin-bottom: ' + r.third.margin);
  check(r.third.align === 'justify', 'and the lines are even at both edges', r.third.align);

  say('\n  and the two reader views agree\n');
  check(r.paged && r.paged.indent === r.third.indent, 'the paged view indents the same way',
    'scroll ' + r.third.indent + ', paged ' + (r.paged && r.paged.indent));
  check(r.paged && r.paged.align === r.third.align, 'and justifies the same way',
    'scroll ' + r.third.align + ', paged ' + (r.paged && r.paged.align));

  say('');
  say('  ' + (bad ? bad + ' problem(s)' : 'paragraphs read like a book: on their own line, indented, nothing between them') + '\n');
  app.exit(bad ? 1 : 0);
}).catch(e => { say('HARNESS ERROR: ' + (e && e.stack ? e.stack : e)); app.exit(1); });