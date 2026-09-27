/* Sailing Books — a fixed, named web address, free.
 *
 *   npm run funnel
 *
 * Where `npm run tunnel` hands out a random address each run (Cloudflare) or an
 * address ngrok assigns for you, this gives you an address with a name in it
 * that you choose and never changes:
 *
 *   https://sailing-books.your-tailnet.ts.net
 *
 * It uses Tailscale Funnel: your laptop keeps running the same server, and
 * Tailscale gives it a permanent HTTPS name on the public internet. No domain to
 * buy, no account to pay for, and the name is yours to pick (rename the machine
 * once and the address changes with it).
 *
 * The laptop must be on, awake, and running this while the phone reads.
 * Nothing is uploaded: the books still stream from your laptop.
 */
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = +(process.env.SB_PORT || 8787);
const SERVER = path.join(__dirname, 'server.js');
const IS_WIN = process.platform === 'win32';

function have(cmd) { return spawnSync(IS_WIN ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0; }
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(900, () => { s.destroy(); resolve(false); });
  });
}
function tailscale(args) {
  const r = spawnSync('tailscale', args, { encoding: 'utf8' });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function userData() {
  if (IS_WIN) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}
function urlFile() { return path.join(userData(), 'Sailing Books', 'public-url.txt'); }
function rememberUrl(url) {
  try {
    fs.mkdirSync(path.dirname(urlFile()), { recursive: true });
    fs.writeFileSync(urlFile(), url + '\n');
  } catch {}
}
const bare = (s) => String(s).replace(/\x1b\[[0-9;;]*[A-Za-z]/g, '');

function installHelp() {
  console.log('\n  Tailscale is not installed. It is free, and takes a minute.\n');
  console.log('    1. winget install tailscale.tailscale      (or https://tailscale.com/download)');
  console.log('    2. Sign in with any account — Google, GitHub, Microsoft all work');
  console.log('    3. Give this machine a good name, which becomes your address:');
  console.log('         tailscale set --hostname=sailing-books');
  console.log('    4. npm run funnel\n');
  console.log('  Prefer to buy the name outright? A domain costs about $10 a year and a');
  console.log('  named Cloudflare Tunnel is then free forever: books.yourdomain.com\n');
}

function notReadyHelp(res) {
  const msg = (res.out + ' ' + res.err);
  console.log('\n  Tailscale is installed but not signed in yet.\n');
  console.log('    tailscale up        (sign in with Google/GitHub/Microsoft)\n');
  if (/funnel/i.test(msg)) {
    console.log('  Funnel also needs approving once. Run:  tailscale funnel --bg ' + PORT);
    console.log('  and follow the link it prints to switch it on. It is free on every plan.\n');
  }
}

(async () => {
  console.log('\n  Sailing Books — fixed named address\n');
  if (!have('tailscale')) { installHelp(); process.exit(1); }

  const status = tailscale(['status', '--json']);
  if (status.status !== 0) { notReadyHelp(status); process.exit(1); }
  let info = {};
  try { info = JSON.parse(status.out); } catch {}
  if (info.BackendState && info.BackendState !== 'Running') {
    console.log('\n  Tailscale is installed but not signed in yet.\n');
    console.log('    tailscale up        (sign in with Google/GitHub/Microsoft)\n');
    process.exit(1);
  }

  // Start the library server, then hand it a permanent name. If one is already
  // listening on the port (a plain `npm run server`, or a tunnel already open)
  // then use that one rather than failing to bind.
  const already = await portOpen(PORT);
  let srv = null;
  if (already) {
    console.log('  Using the Sailing Books server already running on port ' + PORT + '.\n');
  } else {
    srv = spawn(process.execPath, [SERVER], {
      stdio: 'inherit',
      env: Object.assign({}, process.env, { SB_PARENT_PID: String(process.pid) })
    });
    srv.on('exit', code => process.exit(code === null ? 1 : code));
    await new Promise(r => setTimeout(r, 1200));
  }
  const bye = () => {
    try { spawnSync('tailscale', ['funnel', 'off'], { stdio: 'ignore' }); } catch {}
    try { if (srv) srv.kill(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  // The device name is the first half of the address, so make it readable.
  const wantName = (process.env.SB_FUNNEL_NAME || '').trim();
  if (wantName && info.Self && info.Self.HostName !== wantName) {
    const r = tailscale(['set', '--hostname=' + wantName]);
    if (r.status === 0) console.log('  Named this machine "' + wantName + '".\n');
  }

  console.log('  Opening your named address…\n');
  const res = tailscale(['funnel', '--bg', String(PORT)]);
  const out = bare(res.out + '\n' + res.err);
  const m = /https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net)/i.exec(out);
  if (!m) {
    if (/funnel/i.test(out) && /(enable|approve|login|https:\/\/login|not enabled)/i.test(out)) {
      notReadyHelp(res);
    } else {
      console.log('  Could not start the funnel. Tailscale said:\n');
      console.log(out.split('\n').filter(Boolean).slice(-8).map(l => '    ' + l).join('\n'));
      console.log('');
    }
    process.exit(1);
  }

  const url = 'https://' + m[1];
  rememberUrl(url);
  console.log('  ------------------------------------------------');
  console.log('  Open this on your phone, from any network:');
  console.log('');
  console.log('    ' + url);
  console.log('');
  console.log('  Sign in with the password printed above.');
  console.log('');
  console.log('  This name is yours and it never changes. Bookmark it on');
  console.log('  the phone and you will never type an address again.');
  console.log('  The page is served by the laptop, so there is no address');
  console.log('  box to fill in — just your password.');
  console.log('');
  console.log('  Keep this window open while you read.');
  console.log('  ------------------------------------------------\n');

  // Nothing else to supervise when the server was already running: the funnel
  // lives in Tailscale's own daemon, so just stay up until Ctrl+C.
  if (srv) setInterval(() => { if (srv.exitCode !== null) process.exit(srv.exitCode || 0); }, 5000);
  else setInterval(() => {}, 1 << 30);
})();
