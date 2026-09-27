const fs = require('fs');
const HI = new Set([0x20AC,0x201A,0x0192,0x201E,0x2026,0x2020,0x2021,0x02C6,0x2030,0x0160,0x2039,0x0152,
  0x017D,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0x02DC,0x2122,0x0161,0x203A,0x0153,0x017E,0x0178]);
for (const f of process.argv.slice(2)) {
  const t = fs.readFileSync(f, 'utf8');
  const m = new Map();
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c > 0xFF && !HI.has(c)) m.set(ch, (m.get(ch) || 0) + 1);
  }
  const list = [...m].map(([k, v]) => 'U+' + k.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ' x' + v);
  console.log(f + ': ' + (list.join(', ') || 'nothing above U+00FF that is not cp1252'));
}
