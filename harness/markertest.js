const MARKER = /\uFFFD|\u00C3[\u0080-\u00BF\u00A0-\u00FF]|\u00C2[\u0080-\u00BF\u00A0-\u00FF]|\u00E2\u20AC|\u00C3\u201A|\u00E2\u0080[\u009C\u009D]|\u00C3\u0092/g;
const s = 'Library \u00E2\u20AC\u201D 36 book(s)  Folder \u00E2\u20AC\u0153X';
console.log('sample:', JSON.stringify(s));
console.log('score:', (s.match(MARKER) || []).length);
console.log('matches:', JSON.stringify(s.match(MARKER)));
const fs = require('fs');
const t = fs.readFileSync('renderer/renderer.js', 'utf8');
console.log('file score:', (t.match(MARKER) || []).length);
