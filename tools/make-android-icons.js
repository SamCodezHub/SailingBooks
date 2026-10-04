/* Android launcher icon and splash, made from the one icon in assets/.
 *
 * Run: npm run icons:android
 *
 * Capacitor ships placeholder artwork. This redraws the real mark at each density
 * the phone asks for, and repaints the splash at the exact sizes already in the
 * project so nothing is stretched. Electron's own image handling is not used for
 * the compositing - the centred, padded foreground an adaptive icon needs is
 * drawn on a canvas, which is easier to reason about than resizing in place.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const SOURCE = path.join(ROOT, 'assets', 'icon.png');

// The launcher sizes Android asks for, and the 108dp adaptive canvas.
const DENSITIES = [
  { dir: 'mipmap-mdpi', legacy: 48, adaptive: 108 },
  { dir: 'mipmap-hdpi', legacy: 72, adaptive: 162 },
  { dir: 'mipmap-xhdpi', legacy: 96, adaptive: 216 },
  { dir: 'mipmap-xxhdpi', legacy: 144, adaptive: 324 },
  { dir: 'mipmap-xxxhdpi', legacy: 192, adaptive: 432 }
];

// How much of the adaptive canvas the tile fills. Android shows the middle 72dp
// of the 108dp canvas, so a full-bleed tile would have its corners clipped.
const ADAPTIVE_SCALE = 0.68;
const SPLASH_SCALE = 0.22;
const BACKGROUND = '#ffffff';

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.png$/i.test(entry.name)) out.push(full);
  }
  return out;
}

app.whenReady().then(async () => {
  if (!fs.existsSync(SOURCE)) { console.error('assets/icon.png is missing'); process.exit(1); }
  if (!fs.existsSync(RES)) { console.error('android project is missing - run: npx cap add android'); process.exit(1); }
  const sourceDataUrl = 'data:image/png;base64,' + fs.readFileSync(SOURCE).toString('base64');

  // The splash files Capacitor generated, repainted at their own sizes.
  const splashes = walk(RES).filter(f => /splash/i.test(path.basename(f)));
  const jobs = [];
  for (const { dir, legacy, adaptive } of DENSITIES) {
    const target = path.join(RES, dir);
    if (!fs.existsSync(target)) continue;
    jobs.push({ file: path.join(target, 'ic_launcher.png'), w: legacy, h: legacy, scale: 1 });
    jobs.push({ file: path.join(target, 'ic_launcher_round.png'), w: legacy, h: legacy, scale: 1, round: true });
    jobs.push({ file: path.join(target, 'ic_launcher_foreground.png'), w: adaptive, h: adaptive, scale: ADAPTIVE_SCALE });
  }
  for (const file of splashes) {
    const size = pngSize(file);
    jobs.push({ file, w: size.width, h: size.height, scale: SPLASH_SCALE, background: BACKGROUND });
  }

  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL('data:text/html,<body></body>');

  let written = 0;
  for (const job of jobs) {
    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = ${JSON.stringify(sourceDataUrl)}; });
      const canvas = document.createElement('canvas');
      canvas.width = ${job.w}; canvas.height = ${job.h};
      const ctx = canvas.getContext('2d');
      if (${JSON.stringify(job.background || null)}) { ctx.fillStyle = ${JSON.stringify(job.background)}; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      const side = Math.round(Math.min(canvas.width, canvas.height) * ${job.scale});
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, Math.round((canvas.width - side) / 2), Math.round((canvas.height - side) / 2), side, side);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    fs.writeFileSync(job.file, Buffer.from(png, 'base64'));
    written++;
  }

  // The adaptive icon's background layer, so the tile sits on the same white it
  // was drawn for instead of whatever placeholder colour was there.
  const colors = path.join(RES, 'values', 'ic_launcher_background.xml');
  fs.writeFileSync(colors, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n');

  console.log('  wrote ' + written + ' image(s) into android/app/src/main/res');
  console.log('  adaptive icon background set to ' + BACKGROUND);
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });