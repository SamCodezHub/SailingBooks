/* These checks read the real library over the laptop's own server. The address
 * it is reached at depends on whether the funnel happens to be running, and a
 * check that cannot run when the funnel is down is a check nobody runs.
 *
 *   node harness/fix-harness-addresses.js
 */
const fs = require('fs');
const path = require('path');

const FILES = ['browser-check.js', 'check-all-books.js', 'check-contrast.js', 'check-keys.js', 'check-settings-both.js'];
const FROM = "const URL_ = mm ? 'https://' + mm[1] : '';";
const TO = "const URL_ = mm ? 'https://' + mm[1] : 'http://127.0.0.1:' + (process.env.SB_PORT || 8787);";

let changed = 0;
for (const f of FILES) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) { console.log('  missing ' + f); continue; }
  const before = fs.readFileSync(p, 'utf8');
  if (!before.includes(FROM)) { console.log('  ' + f + ': already addressed, or the line moved'); continue; }
  fs.writeFileSync(p, before.replace(FROM, TO));
  changed++;
  console.log('  ' + f + ': falls back to this machine when the funnel is not up');
}
console.log('\n' + changed + ' file(s) updated.');
