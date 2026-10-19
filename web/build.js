/* Build the static client portion of the Vercel project. Deploy from the repo
 * root so Vercel includes both web/dist and the root api/ serverless functions.
 * The desktop app and `npm run server` serve the shared renderer directly.
 *
 *   node web/build.js        ->  web/dist/
 *
 * Upload web/dist as a static site. On first load you type the laptop's public
 * address (from `npm run tunnel`) into the "Laptop address" box; it is
 * remembered on the device.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'dist');
function read(p) { return fs.readFileSync(p, 'utf8'); }

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// index.html: inline the sign-in gate, load the shim before the renderer
let html = read(path.join(ROOT, 'renderer', 'index.html'));
const gate = read(path.join(__dirname, 'login.html'));
html = html.replace('<div id="app">', gate + '\n<div id="app">');
html = html.replace(/<script src="renderer\.js"><\/script>/,
    '<script src="api-shim.js"></script>\n<script src="login.js"></script>\n<script src="renderer.js"></script>');
  // The app runs from renderer/, so it reaches the icon in ../assets/. This copy
  // sits at the root of the site, where that would point outside it and leave a
  // broken image where the brand mark should be.
  html = html.replace(/\.\.\/assets\//g, 'assets/');
  fs.writeFileSync(path.join(OUT, 'index.html'), html);

fs.writeFileSync(path.join(OUT, 'styles.css'), read(path.join(ROOT, 'renderer', 'styles.css')));
fs.writeFileSync(path.join(OUT, 'renderer.js'), read(path.join(ROOT, 'renderer', 'renderer.js')));
fs.writeFileSync(path.join(OUT, 'api-shim.js'), read(path.join(__dirname, 'api-shim.js')));
fs.writeFileSync(path.join(OUT, 'login.js'), read(path.join(__dirname, 'login.js')));
fs.writeFileSync(path.join(OUT, 'cloud-client.js'), read(path.join(ROOT, 'renderer', 'cloud-client.js')));
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'icon-header.png'), path.join(OUT, 'assets', 'icon-header.png'));
fs.writeFileSync(path.join(OUT, 'vercel.json'), JSON.stringify({ cleanUrls: true }, null, 2));

// index.html and the PDF worker reach for ../node_modules/... — on a static
// host that resolves to /node_modules/..., so the libraries have to travel with
// the bundle or EPUBs and PDFs silently break. Vercel installs the runtime
// dependencies first (see vercel.json), so the files are there to copy.
const VENDOR = [
  ['node_modules/jszip/dist/jszip.min.js', 'node_modules/jszip/dist/jszip.min.js'],
  ['node_modules/pdfjs-dist/build/pdf.js', 'node_modules/pdfjs-dist/build/pdf.js'],
  ['node_modules/pdfjs-dist/build/pdf.worker.js', 'node_modules/pdfjs-dist/build/pdf.worker.js']
];
let missing = 0;
for (const [from, to] of VENDOR) {
  const src = path.join(ROOT, from);
  const dest = path.join(OUT, to);
  if (!fs.existsSync(src)) {
    console.error('  MISSING ' + from + ' — run `npm install` first, or EPUBs and PDFs will not work here.');
    missing++;
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('  + ' + to + '  ' + (fs.statSync(dest).size / 1024).toFixed(0) + ' kB');
}
if (missing) process.exitCode = 1;

console.log('Static client written to ' + OUT);

/* ------------------------------------------------------------------
   The website itself: web/site/
   The copy above is what the phone app bundles and what `npm run server`
   hands out, so it must stay exactly as it is. The site is built separately:
   the front page is an advertisement for the product, with the library still
   reachable at /app for anyone who wants it.
   ------------------------------------------------------------------ */
const SITE = path.join(__dirname, 'site');
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
const version = pkg.version;

fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(SITE, { recursive: true });
// the library itself, at /app
fs.cpSync(OUT, path.join(SITE, 'app'), { recursive: true });
fs.rmSync(path.join(SITE, 'app', 'vercel.json'), { force: true });
fs.writeFileSync(path.join(SITE, 'vercel.json'), JSON.stringify({ cleanUrls: true }, null, 2));
fs.mkdirSync(path.join(SITE, 'assets'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'icon-header.png'), path.join(SITE, 'assets', 'icon-header.png'));

// Downloads. The phone app is small enough to serve from here. The Windows
// installer is over Vercel's 100 MB limit, so its address is set in
// web/downloads.json and has to point somewhere the file actually lives.
const downloads = fs.existsSync(path.join(__dirname, 'downloads.json'))
  ? JSON.parse(read(path.join(__dirname, 'downloads.json'))) : {};
const mb = f => (fs.existsSync(f) ? (fs.statSync(f).size / 1024 / 1024).toFixed(1) + ' MB' : null);
const apkSrc = path.join(ROOT, 'release', version, `Sailing-Books-${version}.apk`);
const exeSrc = path.join(ROOT, 'release', version, `Sailing-Books-Setup-${version}.exe`);

let apkUrl = downloads.apk || '';
let apkSize = mb(apkSrc);
if (!apkUrl && fs.existsSync(apkSrc)) {
  fs.mkdirSync(path.join(SITE, 'downloads'), { recursive: true });
  fs.copyFileSync(apkSrc, path.join(SITE, 'downloads', path.basename(apkSrc)));
  apkUrl = `downloads/${path.basename(apkSrc)}`;
  console.log('  + downloads/' + path.basename(apkSrc) + '  ' + apkSize + ' MB');
}
const exeUrl = downloads.exe || '';
const exeSize = mb(exeSrc);

const note = apkUrl
  ? (exeUrl
      ? 'Both are free. The phone app signs in to your own shelf; the installer runs on your computer.'
      : 'The phone app is ready to install. The Windows installer is being published — check back shortly.')
  : 'Build the phone app with `npm run apk` to put a download here.';

let landing = read(path.join(__dirname, 'landing.html'));
const put = (token, value) => { landing = landing.split(token).join(value); };
// A download with nowhere to send people is not a download button. Until the
// address is known the item says so instead of pretending.
const item = (url, glyph, title, sub) => url
  ? `<a class="dl" href="${url}" download><span class="glyph">${glyph}</span><span><b>${title}</b><span>${sub}</span></span></a>`
  : `<div class="dl soon"><span class="glyph">${glyph}</span><span><b>${title}</b><span>${sub}</span></span></div>`;
put('__VERSION__', version);
put('__APK_ITEM__', item(apkUrl, '&#9742;', 'Get it on your phone',
  apkUrl ? `Android &middot; ${apkSize} &middot; install directly` : 'Building &mdash; run npm run apk'));
put('__EXE_ITEM__', item(exeUrl, '&#128187;', 'Get it on your computer',
  exeUrl ? `Windows &middot; ${exeSize} &middot; one installer` : 'Being published &mdash; address to follow'));
put('__NOTE__', note);
fs.writeFileSync(path.join(SITE, 'index.html'), landing);

console.log('\nWebsite written to ' + SITE);
console.log('  front page: the product, with ' + (apkUrl ? 'the phone app to download' : 'no phone app yet') +
  (exeUrl ? ' and the installer' : ' and no installer address yet'));
console.log('  library still reachable at /app');
if (!exeUrl) console.log('  set "exe" in web/downloads.json to where the Windows installer is published.');

console.log('\nDeploy the repository root with `npm run deploy` so the /api/cloud functions are included.');
