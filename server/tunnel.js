/* Start the library server and put a public HTTPS address in front of it, so
 * the phone can reach the laptop from any network — home, mobile data, a
 * café Wi-Fi — without touching the router.
 *
 *   npm run tunnel
 *
 * Uses Cloudflare's quick tunnel (no account needed). If cloudflared is not
 * installed it says how to get it. Nothing is uploaded: the bytes still travel
 * from your laptop, the tunnel just forwards them.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const PORT = +(process.env.SB_PORT || 8787);
const server = path.join(__dirname, 'server.js');

function have(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}
function installHint() {
  if (process.platform === 'win32') {
    return [
      '  cloudflared is not installed. Install it with:',
      '',
      '    winget install --id Cloudflare.cloudflared',
      '',
      '  (or download https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)',
      '  then run `npm run tunnel` again.'
    ].join('\n');
  }
  return '  Install cloudflared, then run `npm run tunnel` again: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

if (!have('cloudflared')) {
  console.log('\n  Sailing Books — public tunnel\n');
  console.log(installHint());
  console.log('');
  process.exit(1);
}

console.log('\n  Sailing Books — starting the library server…\n');
const srv = spawn(process.execPath, [server], { stdio: 'inherit', env: process.env });
srv.on('exit', code => process.exit(code === null ? 1 : code));

setTimeout(() => {
  console.log('  Opening a public address with Cloudflare…\n');
  const tun = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const say = (line) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
    if (m && !say.done) {
      say.done = true;
      console.log('  ------------------------------------------------');
      console.log('  Open this on your phone, from any network:');
      console.log('');
      console.log('    ' + m[0]);
      console.log('');
      console.log('  Sign in with the password printed above.');
      console.log('  The address changes every time you run this.');
      console.log('  ------------------------------------------------\n');
    }
  };
  readline.createInterface({ input: tun.stdout }).on('line', say);
  readline.createInterface({ input: tun.stderr }).on('line', say);
  tun.on('error', e => { console.error('  cloudflared failed to start:', e.message); process.exit(1); });
  const bye = () => { try { tun.kill(); srv.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}, 1200);
