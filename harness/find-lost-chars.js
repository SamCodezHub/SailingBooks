/* U+FFFD in a source file means text was destroyed, not merely mis-encoded:
   there is no character to restore it to, so it is listed and the line printed
   with its surroundings so it can be repaired by hand. */
const fs = require('fs');
let total = 0;
for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (l.includes('\uFFFD')) {
      total++;
      const col = l.indexOf('\uFFFD');
      console.log(f + ':' + (i + 1) + ':' + (col + 1) + '  ' + l.trim().slice(0, 120));
      console.log('        context: ...' + l.slice(Math.max(0, col - 30), col + 30).replace(/\uFFFD/g, '?') + '...');
    }
  });
}
console.log('\n' + total + ' line(s) with U+FFFD');
