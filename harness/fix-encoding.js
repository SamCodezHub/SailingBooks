/* Repairs mojibake: text that was read as Windows-1252 and written back as
 * UTF-8, sometimes more than once.
 *
 * The damage is byte-local and invertible:  B' = utf8(cp1252_decode(B)).
 * Each stretch is walked back one pass at a time. A stretch that cannot be
 * undone (it would overshoot, or it is not mangled at all) is split in half and
 * retried, so stretches mangled to different depths in the same file are each
 * fixed by their own number of passes and genuine characters are left alone.
 */
const fs = require('fs');

const CP1252_HIGH = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
  0x017E: 0x9E, 0x0178: 0x9F
};
const TO_BYTE = new Map(Object.entries(CP1252_HIGH).map(([ch, b]) => [Number(ch), b]));

function encodeCp1252(str) {
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (TO_BYTE.has(cp)) { out.push(TO_BYTE.get(cp)); continue; }
    if (cp > 0xFF) return null;              // not representable: not this encoding
    out.push(cp);
  }
  return Buffer.from(out);
}

// Sequences that only ever show up as a side effect of mis-decoding.
const MARKER = /\uFFFD|\u00C3[\u0080-\u00BF\u00A0-\u00FF]|\u00C2[\u0080-\u00BF\u00A0-\u00FF]|\u00E2\u20AC|\u00C3\u201A|\u00E2\u0080[\u009C\u009D]|\u00C3\u0092/g;
const score = (t) => (t.match(MARKER) || []).length;

// One pass back, or null if that is not safe/helpful here.
function undoOnce(seg) {
  if (seg.includes('\uFFFD')) return null;
  const enc = encodeCp1252(seg);
  if (!enc) return null;
  const text = enc.toString('utf8');
  if (text.includes('\uFFFD')) return null;
  return score(text) < score(seg) ? text : null;
}

function repair(seg, depth = 0) {
  if (seg.length < 2 || depth > 24) return seg;
  if (score(seg) === 0) return seg;                       // nothing to fix here
  const one = undoOnce(seg);
  if (one !== null) return repair(one, depth + 1);        // keep peeling
  // Split, without cutting a surrogate pair in half.
  let mid = Math.floor(seg.length / 2);
  if (mid > 0 && /[\uD800-\uDBFF]/.test(seg[mid - 1])) mid--;
  if (mid === 0) return seg;
  return repair(seg.slice(0, mid), depth + 1) + repair(seg.slice(mid), depth + 1);
}

let changed = 0;
for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) { console.log('  missing  ' + f); continue; }
  const text = fs.readFileSync(f, 'utf8');
  const before = score(text);
  if (before === 0) { console.log(`  clean    ${f}`); continue; }
  const fixed = repair(text);
  const after = score(fixed);
  if (after === 0 && fixed !== text) fs.writeFileSync(f, fixed, 'utf8');
  changed++;
  console.log(`  fixed    ${f}  (${before} -> ${after} markers)`);
}
console.log(`\n${changed} file(s) processed`);
