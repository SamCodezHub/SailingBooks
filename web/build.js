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
console.log('Files:');
for (const f of fs.readdirSync(OUT)) console.log('  ' + f);
console.log('\nDeploy the repository root with `npm run deploy` so the /api/cloud functions are included.');
console.log('Run the Supabase migration and add the Vercel environment settings first.');
