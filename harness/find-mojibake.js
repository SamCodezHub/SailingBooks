/* Byte-accurate scan for mojibake (UTF-8 read as Windows-1252 and written back). */
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
const BAD = /[\u00C0-\u00FF]|â€|Ã[\u0080-\u00BF]?|Â[\u0080-\u00BF]?|ï¿½|\uFFFD/;
let total = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log('missing ' + f); continue; }
  const txt = fs.readFileSync(f, 'utf8');
  const lines = txt.split('\n');
  lines.forEach((line, i) => {
    if (BAD.test(line)) {
      total++;
      console.log(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  });
}
console.log(`\n${total} suspicious line(s)`);
