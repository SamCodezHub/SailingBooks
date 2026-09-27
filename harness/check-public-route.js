/* A check from inside the tailnet can succeed for the wrong reason: the name
   also resolves locally, so a request may never touch the public internet. This
   connects straight to the Funnel ingress addresses that public DNS hands out,
   with the name in SNI and the Host header, so the request really does go out
   and come back the way a phone's would. */
const tls = require('tls');
const https = require('https');

const NAME = process.argv[2] || 'sailing-books.tailcf4de9.ts.net';
const INGRESS = (process.argv[3] || '103.84.155.153,103.84.155.217').split(',');

function viaIngress(ip) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get({
      host: ip,
      servername: NAME,          // TLS SNI decides which funnel this is
      headers: { host: NAME },
      path: '/',
      timeout: 20000
    }, (res) => {
      let n = 0;
      res.on('data', d => n += d.length);
      res.on('end', () => resolve({ ip, status: res.statusCode, bytes: n, ms: Date.now() - started }));
    });
    req.on('error', (e) => resolve({ ip, error: e.code || e.message, ms: Date.now() - started }));
    req.on('timeout', () => { req.destroy(); resolve({ ip, error: 'timeout', ms: Date.now() - started }); });
  });
}

function tlsProbe(ip) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = tls.connect({ host: ip, port: 443, servername: NAME, rejectUnauthorized: true }, () => {
      const c = s.getPeerCertificate();
      s.destroy();
      resolve({ ip, cert: Object.values(c.subject || {}).join(','), issuer: Object.values(c.issuer || {}).join(','), ms: Date.now() - started });
    });
    s.on('error', (e) => { s.destroy(); resolve({ ip, error: e.code || e.message, ms: Date.now() - started }); });
    s.setTimeout(15000, () => { s.destroy(); resolve({ ip, error: 'timeout' }); });
  });
}

(async () => {
  console.log('\n  Funnel name: ' + NAME + '\n');
  console.log('  public ingress addresses given out by DNS: ' + INGRESS.join(', ') + '\n');

  console.log('  TLS straight to the public ingress (no local DNS involved):');
  for (const ip of INGRESS) {
    const r = await tlsProbe(ip);
    console.log('    ' + (r.error ? 'FAIL  ' : 'ok    ') + ip.padEnd(16) +
      (r.error ? r.error : (Date.now() - 0, r.ms + 'ms  ' + r.cert)));
  }

  console.log('\n  fetching the page through the public ingress:');
  let good = 0;
  for (const ip of INGRESS) {
    const r = await viaIngress(ip);
    if (!r.error && r.status === 200) good++;
    console.log('    ' + (r.error || r.status !== 200 ? 'FAIL  ' : 'ok    ') + ip.padEnd(16) +
      (r.error ? r.error + '  after ' + r.ms + 'ms' : 'HTTP ' + r.status + ', ' + r.bytes + ' bytes, ' + r.ms + 'ms'));
  }

  console.log('\n  ' + (good
    ? 'The public route works. If the phone still cannot open it, the phone is\n  holding a cached "does not exist" answer from when the record was missing.'
    : 'The public route is broken. No device outside the tailnet can reach it,\n  which matches what the phone is telling you.'));
  console.log('');
  process.exit(good ? 0 : 1);
})();
