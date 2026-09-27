/* The only honest way to test this is from outside the tailnet, because a
   machine on the tailnet can reach the address without ever touching the public
   Funnel ingress. This asks public relay services (which have no Tailscale
   account and no route to 100.x) to fetch the sign-in page.
   Only GET / is requested: the sign-in page, no password, no library data. */
const https = require('https');

const TARGET = process.argv[2] || 'https://sailing-books.tailcf4de9.ts.net/';
const RELAYS = [
  ['codetabs', u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)],
  ['allorigins', u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)],
  ['corsproxy', u => 'https://corsproxy.io/?url=' + encodeURIComponent(u)]
];

function get(url) {
  return new Promise((res) => {
    const started = Date.now();
    const r = https.get(url, {
      timeout: 25000,
      headers: { 'user-agent': 'Mozilla/5.0 (sailing-books-check)', accept: '*/*' }
    }, (resp) => {
      let n = 0, head = '';
      resp.on('data', (d) => { n += d.length; if (head.length < 400) head += d.toString('utf8', 0, 400); });
      resp.on('end', () => res({ status: resp.statusCode, bytes: n, ms: Date.now() - started, head }));
    });
    r.on('error', (e) => res({ error: e.code || e.message, ms: Date.now() - started }));
    r.on('timeout', () => { r.destroy(); res({ error: 'timeout', ms: Date.now() - started }); });
  });
}

(async () => {
  console.log('\n  asking the public internet to fetch ' + TARGET + '\n');
  const results = [];
  for (const [name, build] of RELAYS) {
    const r = await get(build(TARGET));
    const got = !r.error && r.bytes > 500 && /loginPass|Sailing Books/i.test(r.head);
    results.push(got);
    console.log('  ' + (got ? 'REACHED ' : 'no     ') + name.padEnd(12) +
      (r.error ? r.error + ' after ' + r.ms + 'ms'
        : 'HTTP ' + r.status + ', ' + r.bytes + ' bytes, ' + r.ms + 'ms' +
          (got ? '  (it is the real sign-in page)' : '  ' + r.head.slice(0, 60).replace(/\s+/g, ' '))));
  }
  const any = results.some(Boolean);
  console.log('\n  ' + (any
    ? 'The Funnel address IS reachable from the public internet. If your phone\n  cannot open it, the phone is holding a cached "no such address" answer\n  from when the public record was missing. Switching network, or toggling\n  airplane mode, forces a fresh lookup.'
    : 'The Funnel address is NOT reachable from outside. No phone will ever open\n  it, and no amount of retrying on the phone will help. Use `npm run tunnel`\n  (Cloudflare) instead, or install Tailscale on the phone.'));
  console.log('');
  process.exit(any ? 0 : 1);
})();
