/* Start the library server and put a public HTTPS address in front of it, so
 * the phone can reach the laptop from any network — home, mobile data, a
 * café Wi-Fi — without touching the router.
 *
 *   npm run tunnel
 *
 * Needs Cloudflare's cloudflared. If it isn't on the machine this downloads the
 * official standalone binary once (no installer, no admin rights) to
 *   Windows: %LOCALAPPDATA%\Sailing Books\tools\cloudflared.exe
 *   macOS/Linux: ~/.sailing-books/tools/cloudflared
 * Delete that file to undo it. If the download cannot happen, the built-in SSH
 * client is used instead as a best-effort fallback.
 *
 * Nothing is uploaded: the books still stream from your laptop, the tunnel only
 * forwards the connection.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const readline = require('readline');
const https = require('https');

const PORT = +(process.env.SB_PORT || 8787);
const server = path.join(__dirname, 'server.js');
const IS_WIN = process.platform === 'win32';
const BIN = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
const DL = {
  'win32': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'darwin': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  'linux': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'
};

function toolsDir() {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Sailing Books', 'tools');
  return path.join(os.homedir(), '.sailing-books', 'tools');
}
function candidates() {
  return [
    path.join(toolsDir(), BIN),
    path.join(__dirname, '..', 'tools', BIN),
    BIN // rely on PATH
  ];
}
function findCloudflared() {
  for (const c of candidates()) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {}
    if (!path.isAbsolute(c) || c.includes(path.sep)) {
      const r = spawnSync(IS_WIN ? 'where' : 'which', [c], { stdio: 'ignore' });
      if (r.status === 0) return c;
    }
  }
  return null;
}
function version(exe) {
  const r = spawnSync(exe, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 6) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'user-agent': 'sailing-books' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const tmp = dest + '.part';
        const f = fs.createWriteStream(tmp);
        res.pipe(f);
        f.on('finish', () => f.close(() => { try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); } }));
        f.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}
async function ensureCloudflared() {
  let exe = findCloudflared();
  if (exe) return exe;
  const url = DL[process.platform];
  if (!url) return null;
  const dir = toolsDir();
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, BIN);
  if (IS_WIN) {
    console.log('  cloudflared is not installed — fetching the official one-off binary (55 MB)…');
    console.log('  It goes to ' + dest + ' and needs no admin rights. Delete it any time.\n');
    await download(url, dest);
  } else {
    // tarball for macOS
    const tgz = path.join(dir, 'cloudflared.tgz');
    console.log('  cloudflared is not installed — fetching it (needs `tar`)…');
    await download(url, tgz);
    spawnSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'inherit' });
    try { fs.renameSync(path.join(dir, 'cloudflared'), dest); } catch {}
    try { fs.unlinkSync(tgz); } catch {}
    try { fs.chmodSync(dest, 0o755); } catch {}
  }
  if (!findCloudflared()) return null;
  const v = version(dest);
  console.log('  Ready: ' + (v || 'cloudflared') + '\n');
  return dest;
}

function announce(url, how) {
  console.log('  ------------------------------------------------');
  console.log('  Open this on your phone, from any network:');
  console.log('');
  console.log('    ' + url);
  console.log('');
  console.log('  Sign in with the password printed above.');
  if (how) console.log('  Relaying through: ' + how);
  console.log('  Keep this window open. The address changes each run.');
  console.log('  ------------------------------------------------\n');
}
const bare = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Each tool announces its address in its own way; anything else in the output
// (terms of use, docs links) must never be mistaken for it.
const MATCHERS = {
  cloudflare: (line) => /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i.exec(line),
  ssh: (line) => /tunneled[^,]*,\s*(https:\/\/[^\s]+)/i.exec(line)
};
function findUrl(text, mode) {
  const re = MATCHERS[mode];
  if (!re) return null;
  for (const line of bare(text).split('\n')) {
    const m = re(line.trim());
    if (m) return m[1].replace(/[.,/|]$/, '');
  }
  return null;
}
function watch(child, how, mode) {
  let seen = '', announced = false;
  const onLine = (line) => {
    seen += line + '\n';
    if (announced) return;
    const url = findUrl(seen, mode);
    if (url) { announced = true; announce(url, how); }
  };
  readline.createInterface({ input: child.stdout }).on('line', onLine);
  readline.createInterface({ input: child.stderr }).on('line', onLine);
  child.on('error', e => console.error('\n  Could not start the tunnel:', e.message, '\n'));
  child.on('exit', code => {
    if (!announced) {
      console.error('\n  The tunnel closed (code ' + code + ') before giving an address. Output:\n');
      console.error(bare(seen).split('\n').filter(Boolean).slice(-8).map(l => '    ' + l).join('\n'));
      console.error('');
    }
    process.exit(1);
  });
}
function instructions() {
  console.log('\n  Could not open a public address from this machine.\n');
  console.log('  Options:');
  console.log('    • allow the cloudflared download above and try again');
  console.log('    • install Tailscale on the laptop and the phone, run `npm run server`,');
  console.log('      and use the Tailscale IP (private, never public)');
  console.log('    • stay on the same Wi-Fi: `npm run server`\n');
}

(async () => {
  console.log('\n  Sailing Books — starting the library server…\n');
  const srv = spawn(process.execPath, [server], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { SB_PARENT_PID: String(process.pid) })
  });
  srv.on('exit', code => process.exit(code === null ? 1 : code));
  const bye = () => { try { srv.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  await sleep(1200);
  const exe = await ensureCloudflared().catch(e => { console.error('  download failed:', e.message); return null; });
  if (exe) {
    console.log('  Opening a public address with Cloudflare…\n');
    watch(spawn(exe, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] }), 'Cloudflare', 'cloudflare');
    return;
  }
  if (spawnSync(IS_WIN ? 'where' : 'which', ['ssh'], { stdio: 'ignore' }).status === 0) {
    console.log('  Falling back to the built-in SSH client (best effort, address may change)…\n');
    watch(spawn('ssh', [
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes', '-R', `80:localhost:${PORT}`, 'nokey@localhost.run'
    ], { stdio: ['ignore', 'pipe', 'pipe'] }), 'localhost.run (SSH)', 'ssh');
    return;
  }
  instructions();
})();
