/* Remembers the laptop's public address so it never has to be typed again.
 *
 *   npm run tunnel:fix                       (shows what is set and what to do)
 *   npm run tunnel:fix books.ngrok-free.app  (claims that address for good)
 *   npm run tunnel:fix --clear               (back to a changing address)
 *
 * A free ngrok account is the only free way to get an address that never
 * changes. Once a domain is set here, `npm run tunnel` opens that same address
 * every time, so it can be bookmarked on the phone forever. Without it you
 * still get a working address, just a different one each run.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const FILE = path.join(REPO, 'tunnel.json');
const IS_WIN = process.platform === 'win32';

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const write = (o) => fs.writeFileSync(FILE, JSON.stringify(o, null, 2) + '\n');
const norm = (s) => String(s).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.+$/, '');

const args = process.argv.slice(2);
const clear = args.includes('--clear');
const domain = norm(args.filter(a => !a.startsWith('--'))[0] || '');

console.log('\n  Sailing Books — fixed website address\n');

if (clear) {
  const cur = read();
  delete cur.ngrokDomain;
  write(cur);
  console.log('  Cleared. `npm run tunnel` will use a changing address again.\n');
  process.exit(0);
}

if (!domain) {
  const cur = read();
  console.log('  Address set on this laptop: ' + (cur.ngrokDomain ? 'https://' + cur.ngrokDomain : '(none — it changes every run)'));
  const has = (c) => (spawnSync(IS_WIN ? 'where' : 'which', [c], { stdio: 'ignore' }).status === 0);
  console.log('  ngrok installed: ' + (has('ngrok') ? 'yes' : 'no'));
  console.log('  NGROK_AUTHTOKEN set: ' + (process.env.NGROK_AUTHTOKEN ? 'yes' : 'no'));
  console.log('\n  To get an address that never changes:\n');
  console.log('    1. Install ngrok:      winget install ngrok.ngrok        (or https://ngrok.com/download)');
  console.log('    2. Create a free account at https://dashboard.ngrok.com');
  console.log('    3. Copy your authtoken, then set it for good:');
  console.log('         setx NGROK_AUTHTOKEN <your-token>');
  console.log('    4. In the ngrok dashboard, reserve a free domain, e.g. books');
  console.log('       (you get https://books.ngrok-free.app)');
  console.log('    5. Tell this app about it:');
  console.log('         npm run tunnel:fix books.ngrok-free.app');
  console.log('    6. npm run tunnel — and from now on that address is the same');
  console.log('       every single time. Bookmark it on the phone.\n');
  process.exit(0);
}

if (!/^[a-z0-9.-]+\.(ngrok-free\.app|ngrok\.com|ngrok\.io)$/i.test(domain)) {
  console.error('  That does not look like an ngrok domain. Expected something like');
  console.error('  books.ngrok-free.app\n');
  process.exit(1);
}

const cur = read();
cur.ngrokDomain = domain;
write(cur);
console.log('  Saved. `npm run tunnel` will now open this address every time:\n');
console.log('    https://' + domain + '\n');
if (!spawnSync(IS_WIN ? 'where' : 'which', ['ngrok'], { stdio: 'ignore' }).status === 0) {
  console.log('  ngrok is not installed yet, so the tunnel will fall back to a changing');
  console.log('  address until you install it. See the steps above.\n');
} else if (!process.env.NGROK_AUTHTOKEN) {
  console.log('  NGROK_AUTHTOKEN is not set in this window. Run  setx NGROK_AUTHTOKEN <token>');
  console.log('  once and open a new terminal.\n');
}
