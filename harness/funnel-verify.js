/* Proves the Tailscale path works end to end and times it, using `tailscale
   serve` (the private, tailnet-only address) so no Funnel approval is needed.
   If the library comes back over Tailscale's own HTTPS, the only thing Funnel
   adds is the public internet hop. */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TS = (() => {
  for (const d of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!d) continue;
    const p = path.join(d, 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tailscale';
})();
const PORT = +(process.env.SB_PORT || 8787);
const PASSWORD = process.env.SB_PASSWORD || '589e8bb2';
const ts = (a, t) => spawnSync(TS, a, { encoding: 'utf8', timeout: t || 15000, killSignal: 'SIGKILL' });
const bare = (s) => String(s).replace(/\x1b\[[0-9;;]*[A-Za-z]/g, '');

(async () => {
  let t0 = Date.now();
  const ms = () => (Date.now() - t0) + 'ms';

  console.log('=== 1. ask Tailscale for an address on this machine ===');
  const r = ts(['serve', '--bg', String(PORT)], 20000);
  const out = bare(r.stdout + '\n' + r.stderr);
  const m = /https:\/\/([a-z0-9-]+\.[a-z0-9-]+\.ts\.net)/i.exec(out);
  if (!m) { console.log('could not start serve:\n' + out); process.exit(1); }
  const url = 'https://' + m[1];
  console.log('  address: ' + url);
  console.log('  ready in ' + ms() + '\n');

  console.log('=== 2. first request (TLS handshake + proxy hop) ===');
  t0 = Date.now();
  const page = await fetch(url + '/', { redirect: 'manual' });
  const html = await page.text();
  console.log('  GET /            HTTP ' + page.status + ' in ' + ms() + ', ' + html.length + ' bytes');
  console.log('  sign-in gate present: ' + /id="loginPass"/.test(html));
  console.log('  served by laptop marker: ' + /SB_SERVED_BY_LAPTOP/.test(html));

  console.log('\n=== 3. sign in and read the library over Tailscale ===');
  t0 = Date.now();
  const li = await fetch(url + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD })
  });
  const j = await li.json().catch(() => ({}));
  console.log('  POST /api/login  HTTP ' + li.status + (j.token ? '  token issued' : '  ' + JSON.stringify(j)));
  if (!j.token) { ts(['serve', 'off']); process.exit(1); }
  console.log('  signed in in ' + ms());

  t0 = Date.now();
  const lib = await (await fetch(url + '/api/library', { headers: { 'x-sb-token': j.token } })).json();
  console.log('  GET /api/library ' + (lib.books || []).length + ' books, ' + (lib.folders || []).length +
    ' folders in ' + ms());
  const first = (lib.books || [])[0];
  if (first) {
    t0 = Date.now();
    const head = await fetch(url + '/api/book/' + first.id + '/file', { headers: { 'x-sb-token': j.token } });
    const buf = Buffer.from(await head.arrayBuffer());
    console.log('  GET book file     ' + buf.length + ' bytes in ' + ms() + ' (HTTP ' + head.status + ')');
    t0 = Date.now();
    const cv = await fetch(url + '/api/book/' + first.id + '/cover?token=' + encodeURIComponent(j.token));
    const cb = Buffer.from(await cv.arrayBuffer());
    console.log('  GET cover         ' + cb.length + ' bytes in ' + ms() + ' (HTTP ' + cv.status + ')');
  }

  console.log('\n=== 4. second request (warm) ===');
  t0 = Date.now();
  await fetch(url + '/renderer.js');
  console.log('  GET /renderer.js  in ' + ms());

  ts(['serve', 'off']);
  console.log('\n  serve turned back off.');
  console.log('  So the only thing left to switch on is the Funnel toggle, which');
  console.log('  makes the same address reachable from the public internet.');
})().catch(e => { console.error('FAILED', e); spawnSync(TS, ['serve', 'off']); process.exit(1); });
