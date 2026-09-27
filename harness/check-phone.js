/* `npm run check` — will the phone actually be able to open this?
 *
 * The trap with Tailscale Funnel is that it *looks* fine: the tunnel says
 * "Funnel on", the certificate is valid, and the page loads on the laptop. But
 * the laptop is inside the tailnet, so MagicDNS answers for it. A phone on
 * mobile data is outside, and it depends on a public DNS record existing. If
 * that record is missing the laptop works and the phone cannot, with no error
 * on the laptop to explain why.
 *
 * So this asks the public resolvers directly, then, if they answer, walks the
 * same steps the phone would: load the page, sign in, list the library.
 */
const https = require('https');
const os = require('os');
const net = require('net');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = +(process.env.SB_PORT || 8787);
const PASSWORD = process.env.SB_PASSWORD || process.argv[2] || '';

const tsExe = (() => {
  if (process.platform !== 'win32') return 'tailscale';
  for (const d of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!d) continue;
    const p = path.join(d, 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tailscale';
})();
const ts = (a) => spawnSync(tsExe, a, { encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL' });
const bare = (s) => String(s).replace(/\x1b\[[0-9;;]*[A-Za-z]/g, '');

const doh = (url) => new Promise((res, rej) => {
  // No destroy() on completion: tearing down an already-finished request trips a
  // libuv assertion on Windows at exit.
  const req = https.get(url, { timeout: 10000, headers: { accept: 'application/dns-json' } }, (r) => {
    let b = '';
    r.on('data', d => b += d);
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
});
const lanIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

let fails = 0;
const say = (ok, label, extra) => {
  if (!ok) fails++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (extra ? '   ' + extra : ''));
};

(async () => {
  console.log('\n  Sailing Books — can the phone open this?\n');

  // --- 1. what does Tailscale think the address is? ---
  const st = ts(['funnel', 'status']);
  const text = bare(st.stdout + st.stderr);
  const m = /https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net)/i.exec(text);
  if (!m) {
    say(false, 'no Funnel address', '(run `npm run funnel` first)');
    process.exit(1);
  }
  const url = 'https://' + m[1];
  console.log('  Funnel address:  ' + url);
  const funnelOn = /funnel on/i.test(text);
  say(funnelOn, 'Tailscale reports the funnel is on');
  console.log('');

  // --- 2. the decisive test: does the PUBLIC internet know this name? ---
  // Tailscale's public record is known to come and go, and a single NXDOMAIN
  // from one resolver means little, so ask several resolvers a few times over a
  // minute before concluding anything.
  console.log('  Asking public resolvers (this is what a phone on mobile data uses):');
  const RESOLVERS = [
    ['Google', 'https://dns.google/resolve?name=%s&type=A'],
    ['Cloudflare', 'https://cloudflare-dns.com/dns-query?name=%s&type=A'],
    ['Quad9', 'https://dns.quad9.net:5053/dns-query?name=%s&type=A']
  ];
  const seen = new Set();
  let publicIPs = [];
  const ROUNDS = 3;
  for (let round = 1; round <= ROUNDS && !publicIPs.length; round++) {
    for (const [label, tpl] of RESOLVERS) {
      try {
        const j = await doh(tpl.replace('%s', m[1]));
        const ips = (j.Answer || []).map(a => a.data).filter(d => /^\d+\.\d+\.\d+\.\d+$/.test(d));
        if (ips.length) { publicIPs = ips; seen.add(label); break; }
      } catch {}
    }
    if (!publicIPs.length) {
      console.log('        round ' + round + '/' + ROUNDS + ': no public record yet' +
        (round < ROUNDS ? ', waiting 20s…' : ''));
      if (round < ROUNDS) await new Promise(r => setTimeout(r, 20000));
    }
  }
  if (publicIPs.length) {
    say(true, 'the public internet resolves it', publicIPs.join(', ') + '  (via ' + [...seen].join(', ') + ')');
  } else {
    say(false, 'the public internet resolves it', 'no A record from any resolver after ' + ROUNDS + ' tries');
  }

  if (!publicIPs.length) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────────┐');
    console.log('  │  THE PHONE WILL NOT WORK.                                    │');
    console.log('  │                                                              │');
    console.log('  │  The name only exists inside your own tailnet, so your laptop');
    console.log('  │  resolves it and the phone, which is outside, cannot.         │');
    console.log('  │  This is a known Tailscale problem, not anything you did.    │');
    console.log('  └──────────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('  Fix, in order of how likely it is to work:');
    console.log('');
    console.log('   1. Wait it out. Tailscale\'s own docs say the public DNS record');
    console.log('      can take up to 10 minutes to appear. Re-run: npm run check');
    console.log('');
    console.log('   2. Re-create the funnel, which makes them rebuild the record:');
    console.log('        tailscale funnel reset');
    console.log('        npm run funnel');
    console.log('        npm run check');
    console.log('');
    console.log('   3. Toggle the Funnel permission in Access Controls at');
    console.log('      https://login.tailscale.com/admin/acls — remove the "funnel"');
    console.log('      nodeAttr block, Save, then put it back and Save again. That');
    console.log('      is the change that makes Tailscale recreate the public record.');
    console.log('');
    console.log('   4. Install Tailscale on the PHONE as well (free, same account).');
    console.log('      Then the phone is inside the tailnet, the name resolves for it,');
    console.log('      and this address works — privately, with nothing public. This');
    console.log('      is the most reliable option and needs no fix at all.');
    console.log('');
    console.log('   5. Or go back to `npm run tunnel`, which uses Cloudflare and works');
    console.log('      from any network today. The address changes each run, but the');
    console.log('      sign-in screen now offers your last few addresses to tap.');
    console.log('');
    process.exit(1);
  }

  // --- 3. public DNS answers, so walk the phone's path ---
  console.log('');
  console.log('  Now walking the same steps a phone would:');
  let page, html;
  try {
    page = await fetch(url + '/', { redirect: 'manual' });
    html = await page.text();
    say(page.ok, 'the page loads over the public internet', 'HTTP ' + page.status);
    say(/id="loginPass"/.test(html), 'the sign-in gate is there');
    say(/SB_SERVED_BY_LAPTOP/.test(html), 'served by the laptop, so no address box to fill in');
  } catch (e) {
    say(false, 'the page loads over the public internet', e.message);
    process.exit(1);
  }

  if (!PASSWORD) {
    console.log('');
    console.log('  Pass your password to check reading too:  npm run check -- <password>');
    console.log('');
    console.log('  THE PHONE WILL WORK — the name resolves publicly and the page answers.');
    process.exit(0);
  }

  try {
    const li = await fetch(url + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD })
    });
    const j = await li.json().catch(() => ({}));
    say(li.ok && !!j.token, 'signing in works', 'HTTP ' + li.status);
    if (j.token) {
      const lib = await (await fetch(url + '/api/library', {
        headers: { 'x-sb-token': j.token }
      })).json();
      const n = (lib.books || []).length;
      say(n > 0, 'the library comes through', n + ' books, ' + (lib.folders || []).length + ' folders');
      const b = (lib.books || [])[0];
      if (b) {
        // Read only the first few MB: enough to prove bytes flow, without
        // pulling a 1 GB audiobook over the tunnel just to check.
        const CAP = 3 * 1024 * 1024;
        const got = await new Promise((res) => {
          let bytes = 0, finished = false;
          const finish = (r) => { if (!finished) { finished = true; res(r); } };
          const req = https.get(url + '/api/book/' + b.id + '/file', {
            headers: { 'x-sb-token': j.token }, timeout: 30000
          }, (r) => {
            r.on('data', (d) => {
              bytes += d.length;
              if (bytes >= CAP) finish({ status: r.statusCode, bytes });
            });
            r.on('end', () => finish({ status: r.statusCode, bytes }));
            r.on('error', () => finish({ status: r.statusCode, bytes }));
          });
          req.on('error', (e) => finish({ status: 0, bytes, error: e.message }));
          req.on('timeout', () => finish({ status: 0, bytes, error: 'timed out' }));
        });
        say(got.status === 200 && got.bytes > 0, 'a book file downloads', got.bytes + ' bytes' +
          (got.bytes >= CAP ? ' (capped)' : ''));
      }
    }
  } catch (e) { say(false, 'signing in works', e.message); }

  console.log('');
  console.log(fails
    ? '  ' + fails + ' problem(s) above — the phone will struggle.'
    : '  ALL GOOD. Open that address on the phone and sign in.');
  console.log('');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
