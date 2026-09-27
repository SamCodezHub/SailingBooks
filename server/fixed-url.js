/* What fixed web address is this laptop set up with?
 *
 *   npm run tunnel:fix                 shows the options and what is set now
 *   npm run tunnel:fix --clear         forget a saved ngrok domain
 *
 * For a fixed address with a NAME in it that you choose, use Tailscale Funnel:
 *
 *   npm run funnel
 *
 * which needs no purchase and no domain. ngrok's free plan cannot do this: it
 * assigns you one random-looking dev domain (abc123xyz.ngrok-free.dev) and does
 * not let you choose or reserve a name. That domain is at least permanent, so
 * ngrok with an authtoken still gives you an address that never changes — just
 * not one you get to pick.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const FILE = path.join(REPO, 'tunnel.json');
const IS_WIN = process.platform === 'win32';
const has = (c) => spawnSync(IS_WIN ? 'where' : 'which', [c], { stdio: 'ignore' }).status === 0;

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const write = (o) => fs.writeFileSync(FILE, JSON.stringify(o, null, 2) + '\n');
const norm = (s) => String(s).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.+$/, '');

const args = process.argv.slice(2);
const domain = norm(args.filter(a => !a.startsWith('--'))[0] || '');

console.log('\n  Sailing Books — your web address\n');

if (args.includes('--clear')) {
  const cur = read();
  delete cur.ngrokDomain;
  write(cur);
  console.log('  Forgot the saved ngrok domain.\n');
  process.exit(0);
}

let tailscaleName = null;
if (has('tailscale')) {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  try {
    const j = JSON.parse(r.stdout);
    if (j.Self && j.Self.DNSName) tailscaleName = j.Self.DNSName.replace(/\.$/, '');
  } catch {}
}

console.log('  A fixed address with a name you choose  →  npm run funnel');
console.log('    Tailscale Funnel, free, no domain to buy. The address is your');
console.log('    machine name plus your tailnet, e.g.');
console.log('      https://sailing-books.something.ts.net');
if (tailscaleName) console.log('    On this laptop right now: https://' + tailscaleName);
else console.log('    (Tailscale is not installed on this laptop yet)');
console.log('');
console.log('  A fixed address ngrok assigns you        →  npm run tunnel');
const cur = read();
if (cur.ngrokDomain) console.log('    saved domain: https://' + cur.ngrokDomain);
console.log('    ngrok installed: ' + (has('ngrok') ? 'yes' : 'no') +
  '   NGROK_AUTHTOKEN set: ' + (process.env.NGROK_AUTHTOKEN ? 'yes' : 'no'));
console.log('    The free plan gives you one permanent domain, but ngrok picks');
console.log('    the name (abc123xyz.ngrok-free.dev) and will not let you choose it.');
console.log('');
console.log('  A name you own outright                  →  buy a domain (~$10/yr)');
console.log('    and a named Cloudflare Tunnel, which is then free forever:');
console.log('    books.yourdomain.com');
console.log('');

if (domain) {
  if (!/^[a-z0-9.-]+\.(ngrok-free\.app|ngrok-free\.dev|ngrok\.com|ngrok\.io)$/i.test(domain)) {
    console.error('  That does not look like an ngrok dev domain. Expected something');
    console.error('  like abc123xyz.ngrok-free.dev — the exact one ngrok gave you in the');
    console.error('  dashboard. For a name you choose, use `npm run funnel` instead.\n');
    process.exit(1);
  }
  cur.ngrokDomain = domain;
  write(cur);
  console.log('  Saved. `npm run tunnel` will now use this address every time:\n');
  console.log('    https://' + domain + '\n');
}
