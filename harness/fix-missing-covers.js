/* Five of the library's EPUBs have no cover file at all, so the shelf shows an
   empty box. This looks inside each of those EPUBs for cover artwork, writes it
   to the Covers folder using exactly the naming the app uses
   (Covers/<bookId>.<ext>), and records it in library-index.json.
 *
 * Safe by design: it only ever adds a coverPath for a book that has none, it
   backs up the index first, and it writes each cover atomically. */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const JSZip = require('jszip');

const UD = process.env.SB_USER_DATA || path.join(process.env.APPDATA || '', 'Sailing Books');
const COVERS = path.join(UD, 'Covers');
const INDEX = path.join(UD, 'library-index.json');

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

async function pickCoverFromEpub(file) {
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const read = (p) => zip.file(p);
  const opfPath = await (async () => {
    const c = read('META-INF/container.xml');
    if (!c) return null;
    const xml = await c.async('text');
    const m = /full-path\s*=\s*"([^"]+)"/i.exec(xml);
    return m ? m[1] : null;
  })();
  if (!opfPath) return null;
  const opf = read(opfPath);
  if (!opf) return null;
  const opfText = await opf.async('text');

  // every image the manifest mentions, best candidates first
  const items = [...opfText.matchAll(/<item\b[^>]*>/gi)].map(m => m[0]);
  const imgs = items.filter(t => /image\//i.test(t) || /cover/i.test(t)).map(t => {
    const id = (/id\s*=\s*"([^"]+)"/i.exec(t) || [])[1];
    const href = (/href\s*=\s*"([^"]+)"/i.exec(t) || [])[1];
    const props = (/properties\s*=\s*"([^"]+)"/i.exec(t) || [])[1] || '';
    const type = (/media-type\s*=\s*"([^"]+)"/i.exec(t) || [])[1] || '';
    return { id, href, props, type };
  }).filter(x => x.href);

  const dir = path.posix.dirname(opfPath);
  const resolve = (href) => {
    const clean = decodeURIComponent(href.split('#')[0]);
    return path.posix.normalize(path.posix.join(dir, clean)).replace(/^\//, '');
  };
  // 1. an item whose properties literally say cover-image
  // 2. an item whose id says cover
  // 3. the largest image by byte size
  const scored = await Promise.all(imgs.map(async (im) => {
    const p = resolve(im.href);
    const f = read(p);
    if (!f) return null;
    const ext = (p.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const mime = im.type || (ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : '');
    if (!MIME_EXT[mime]) return null;
    const size = (await f.async('uint8array')).length;
    if (size < 1500) return null;                  // a speck, not a cover
    let score = 0;
    if (/cover-image/i.test(im.props)) score += 1000;
    if (/cover/i.test(im.id || '')) score += 500;
    if (/cover/i.test(im.href)) score += 200;
    score += Math.min(size / 1000, 200);
    return { path: p, mime, size, score, data: f };
  }));
  const good = scored.filter(Boolean).sort((a, b) => b.score - a.score);
  if (!good.length) return null;
  const best = good[0];
  return { data: await best.data.async('nodebuffer'), mime: best.mime, from: best.path, size: best.size };
}

(async () => {
  const idx = JSON.parse(await fsp.readFile(INDEX, 'utf8'));
  const need = (idx.books || []).filter(b => !b.coverPath);
  console.log('\n  books with no cover: ' + need.length + '\n');

  const backup = INDEX + '.bak-covers';
  await fsp.copyFile(INDEX, backup);
  console.log('  index backed up to ' + path.basename(backup) + '\n');

  let added = 0;
  for (const b of need) {
    if (!b.storedPath || !fs.existsSync(b.storedPath)) { console.log('  ?  file missing: ' + b.title); continue; }
    try {
      const found = await pickCoverFromEpub(b.storedPath);
      if (!found) { console.log('  -  no artwork inside: ' + (b.title || b.fileName).slice(0, 44)); continue; }
      const safeId = String(b.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'cover';
      const ext = MIME_EXT[found.mime] || 'jpg';
      const target = path.join(COVERS, safeId + '.' + ext);
      const tmp = target + '.part';
      await fsp.writeFile(tmp, found.data);
      await fsp.rename(tmp, target);              // atomic: never a half cover
      b.coverPath = target;
      added++;
      console.log('  ok ' + String(Math.round(found.size / 1024)).padStart(5) + 'KB  ' +
        (b.title || b.fileName).slice(0, 40) + '   <- ' + found.from);
    } catch (e) {
      console.log('  !  ' + (b.title || b.fileName).slice(0, 40) + '  ' + e.message);
    }
  }

  if (added) {
    idx.updatedAt = Date.now();
    const tmp = INDEX + '.part';
    await fsp.writeFile(tmp, JSON.stringify(idx, null, 0));
    await fsp.rename(tmp, INDEX);
  }
  console.log('\n  ' + added + ' cover(s) written, index updated');
  console.log('  now ' + (idx.books || []).filter(b => b.coverPath).length + ' of ' + (idx.books || []).length + ' books have one\n');
})().catch(e => { console.error(e); process.exit(1); });
