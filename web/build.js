/* Build the static client for hosting somewhere else (Vercel, Netlify, any
 * static host). The desktop app and `npm run server` do not need this — the
 * server serves the same files itself.
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
fs.writeFileSync(path.join(OUT, 'vercel.json'), JSON.stringify({ cleanUrls: true }, null, 2));

console.log('Static client written to ' + OUT);
console.log('Files:');
for (const f of fs.readdirSync(OUT)) console.log('  ' + f);
console.log('\nDeploy: drag web/dist onto https://vercel.com/new (or `npx vercel deploy`),');
console.log('then open the site and type your tunnel address into "Laptop address".');
