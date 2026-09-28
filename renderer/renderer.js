/* Sailing Books — renderer */
const $ = (s) => document.querySelector(s);

const STORE_KEY = 'sailing-books-v1';
const EPUB_EXTS = ['epub'];
const PDF_EXTS = ['pdf'];
const AUDIO_EXTS = ['mp3', 'm4a', 'm4b', 'wav', 'ogg', 'opus', 'flac', 'aac'];
const ALL_EXTS = [...EPUB_EXTS, ...PDF_EXTS, ...AUDIO_EXTS];

const PALETTE = ['#ffd9d9', '#ffe9c7', '#fff3b0', '#d9f2d0', '#d0e8ff', '#e6d9ff', '#f5f5f5'];

let state = { folders: [], books: [], settings: { fontSize: 18, fontFamily: "Georgia, 'Times New Roman', serif", lineHeight: '1.7', theme: 'light' }, currentFolderId: null, search: '' };
let currentBookId = null;
let epubObjectUrls = [];
let modalCb = null;
let saveScrollT = null;
// Pointer-based dragging for all in-app moves (book cards + chart nodes).
// Native HTML5 DnD is deliberately NOT used for these, so the file-import
// overlay can only ever appear for real files dragged in from outside.
let dragDepth = 0;
let ptrDrag = null; // {kind:'book'|'node'|'pan', ..., startX,startY, moved, ghost}
let pendingLink = null; // {fid, id} source node waiting for a connection target
let chartSelection = []; // right-drag lasso selected node ids
let sectionHi = null; // {fid, sid} highlighted section
let suppressCtxMenu = false; // a drag just ended: swallow the following contextmenu
let lasso = null; // right-button marquee: {fid, pid, x0, y0, moved, rect, ids}
let autoPanRaf = 0; // rAF handle for chart edge auto-scroll while dragging a node

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ---------- persistence ---------- */
const WEB = !!(window.api && window.api.mode === 'web');   // phone / browser client
// The web client (server/server.js) reads library-index.json instead of
// localStorage, so mirror the book list there — throttled, and never mid-drag.
let indexSaveT = null;
function publishIndex() {
  if (WEB || indexSaveT) return;
  indexSaveT = setTimeout(async () => {
    indexSaveT = null;
    if (ptrDrag) return;                       // wait until the drag settles
    try {
      await window.api?.saveLibraryIndex?.({
        books: state.books,
        folders: state.folders,
        progress: state.books.map(b => ({ id: b.id, progress: b.progress, progressSeconds: b.progressSeconds, epubChapter: b.epubChapter, pdfPage: b.pdfPage, lastOpened: b.lastOpened }))
      });
    } catch {}
  }, 2500);
}
const SETTINGS_KEY = 'sailing-books-settings';
function save() {
  if (WEB) { saveDeviceSettings(); saveRemoteProgress(); return; }
  publishIndex();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* quota - strip covers */ try { const slim = { ...state, books: state.books.map(b => ({ ...b, cover: '' })) }; localStorage.setItem(STORE_KEY, JSON.stringify(slim)); } catch {} }
}
// Settings belong to the device you are sitting at, not to the laptop, so they
// are kept locally even on the phone - where the library itself is not. Without
// this, choosing a theme on the phone was undone by the next reload.
function saveDeviceSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {}
}
function loadDeviceSettings() {
  if (!WEB) return;
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s && typeof s === 'object') state.settings = { ...state.settings, ...s };
  } catch {}
}
// On the phone the laptop owns the library; we only report where you got to.
let remoteSaveT = null;
function saveRemoteProgress() {
  if (remoteSaveT) return;
  remoteSaveT = setTimeout(() => {
    remoteSaveT = null;
    const b = currentBookId ? state.books.find(x => x.id === currentBookId) : null;
    if (!b) return;
    Promise.resolve(window.api.saveProgress(b.id, {
      progress: b.progress, progressSeconds: b.progressSeconds,
      epubChapter: b.epubChapter, pdfPage: b.pdfPage, lastOpened: b.lastOpened
    })).catch(() => {});
  }, 1200);
}
// Folders, nodes, renames and imports belong to the desktop app.
function desktopOnly() {
  if (!WEB) return false;
  toast('Manage your library in the desktop app');
  return true;
}
// Pull the library from the laptop instead of localStorage.
async function hydrateFromServer() {
  const data = await window.api.fetchLibrary();
  state.folders = Array.isArray(data.folders) ? data.folders : [];
  state.books = (Array.isArray(data.books) ? data.books : []).map(b => ({ ...b, cover: '' }));
  if (data.settings) state.settings = { ...state.settings, ...data.settings };
  return data;
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) { loadDeviceSettings(); return; }
    const s = JSON.parse(raw);
    if (Array.isArray(s.folders)) state.folders = s.folders;
    if (Array.isArray(s.books)) state.books = s.books;
    if (s.settings) state.settings = { ...state.settings, ...s.settings };
  } catch {}
  loadDeviceSettings();
}

/* ---------- helpers ---------- */
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
}
function extOf(name) { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function typeOf(name) { const e = extOf(name); if (EPUB_EXTS.includes(e)) return 'epub'; if (PDF_EXTS.includes(e)) return 'pdf'; if (AUDIO_EXTS.includes(e)) return 'audio'; return null; }
function kindLabel(t) { return t === 'epub' ? 'EPUB' : t === 'pdf' ? 'PDF' : 'Audio'; }
// Chapters embedded in an audiobook (0 when the file has none / not read yet).
function chapterCount(b) {
  if (!b || b.type !== 'audio' || !Array.isArray(b.chapters)) return 0;
  return b.chapters.filter(c => c && isFinite(c.start)).length;
}
function kindVerb(t) { return t === 'audio' ? 'Listen now' : 'Read now'; }
function folderById(id) { return state.folders.find(f => f.id === id); }
function booksInFolder(fid) { return state.books.filter(b => (b.folderId || null) === (fid || null)); }
function base64ToBytes(b64) { const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len); for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i); return bytes; }
function mimeFor(name) {
  const e = extOf(name);
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'gif') return 'image/gif';
  if (e === 'webp') return 'image/webp';
  if (e === 'svg') return 'image/svg+xml';
  return 'image/jpeg';
}
function normalizeZipPath(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}
function joinZipDir(dir, rel) {
  if (/^data:/.test(rel) || /^https?:/.test(rel) || rel.startsWith('#')) return rel;
  const clean = rel.split('#')[0].split('?')[0];
  if (clean.startsWith('/')) return normalizeZipPath(clean.slice(1));
  return normalizeZipPath((dir ? dir + '/' : '') + clean);
}
function dirOf(p) { const i = String(p).lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- modal ---------- */
function openModal({ title, value = '', showColors = false, selectedColor = PALETTE[0] }) {
  $('#modalTitle').textContent = title;
  $('#modalInput').value = value;
  const row = $('#colorRow');
  row.classList.toggle('hidden', !showColors);
  row.innerHTML = '';
  if (showColors) {
    PALETTE.forEach(c => {
      const d = document.createElement('div');
      d.className = 'swatch' + (c === selectedColor ? ' selected' : '');
      d.style.background = c;
      d.dataset.color = c;
      d.onclick = () => { row.querySelectorAll('.swatch').forEach(x => x.classList.remove('selected')); d.classList.add('selected'); };
      row.appendChild(d);
    });
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.value = /^#[0-9a-f]{6}$/i.test(selectedColor) ? selectedColor : '#ffd9d9';
    custom.title = 'Custom color';
    custom.style.cssText = 'width:30px;height:30px;border:none;background:none;cursor:pointer;';
    custom.oninput = () => { row.querySelectorAll('.swatch').forEach(x => x.classList.remove('selected')); custom.dataset.custom = custom.value; };
    row.appendChild(custom);
  }
  $('#modalOverlay').classList.remove('hidden');
  setTimeout(() => { $('#modalInput').focus(); $('#modalInput').select(); }, 30);
  return new Promise((resolve) => { modalCb = resolve; });
}
function closeModal(result) {
  $('#modalOverlay').classList.add('hidden');
  if (modalCb) { const cb = modalCb; modalCb = null; cb(result); }
}
$('#modalCancel').onclick = () => closeModal(null);
$('#modalOk').onclick = () => {
  const sel = $('#colorRow').querySelector('.swatch.selected');
  const custom = $('#colorRow').querySelector('input[type="color"]');
  let color = sel ? sel.dataset.color : null;
  if (custom && custom.dataset.custom) color = custom.dataset.custom;
  closeModal({ value: $('#modalInput').value.trim(), color });
};
$('#modalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#modalOk').click(); if (e.key === 'Escape') closeModal(null); });
$('#modalOverlay').addEventListener('mousedown', (e) => { if (e.target.id === 'modalOverlay') closeModal(null); });

async function promptName(title, initial = '', showColors = false, color = PALETTE[0]) {
  const r = await openModal({ title, value: initial, showColors, selectedColor: color });
  return r;
}

/* ---------- context menu ---------- */
function hideMenu() { $('#contextMenu').classList.add('hidden'); }
function showMenu(x, y, items) {
  const m = $('#contextMenu');
  m.innerHTML = '';
  items.forEach(it => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; m.appendChild(s); return; }
    if (it.header) { const h = document.createElement('div'); h.className = 'ctx-label'; h.textContent = it.header; m.appendChild(h); return; }
    const d = document.createElement('div');
    d.className = 'ctx-item' + (it.danger ? ' danger' : '');
    d.innerHTML = (it.icon ? `<span>${escapeHtml(it.icon)}</span>` : '') + `<span>${escapeHtml(it.label)}</span>`;
    d.onclick = () => { hideMenu(); it.action && it.action(); };
    m.appendChild(d);
  });
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 10) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 10) + 'px';
}
document.addEventListener('click', hideMenu);
// Suppress the native menu everywhere except text fields (where copy/paste is
// wanted). Without this a right-drag on empty chart space opened Chromium's
// own menu, which swallowed the press and made sections impossible to make.
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  e.preventDefault();
});
window.addEventListener('blur', hideMenu);

/* ---------- folders ---------- */
async function createFolder() {
  if (desktopOnly()) return ;
  const r = await promptName('New folder', 'Untitled folder', true, PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  if (!r || !r.value) return;
  state.folders.push({ id: uid(), name: r.value.slice(0, 60), color: r.color || PALETTE[0], createdAt: Date.now() });
  save(); render();
  toast(`Folder “${r.value}” created`);
}
async function renameFolder(f) {
  const r = await promptName('Rename folder', f.name, true, f.color);
  if (!r || !r.value) return;
  f.name = r.value.slice(0, 60);
  if (r.color) f.color = r.color;
  save(); render();
}
async function recolorFolder(f) {
  const r = await promptName(`Color — ${f.name}`, f.name, true, f.color);
  if (!r) return;
  if (r.color) { f.color = r.color; save(); render(); }
}
function deleteFolder(f) {
  const n = booksInFolder(f.id).length;
  if (!confirm(`Delete folder “${f.name}”?${n ? `\n${n} book(s) will move to Unsorted.` : ''}`)) return;
  state.folders = state.folders.filter(x => x.id !== f.id);
  state.books.forEach(b => { if (b.folderId === f.id) b.folderId = null; });
  if (state.currentFolderId === f.id) state.currentFolderId = null;
  save(); render();
  toast('Folder deleted');
}
function moveBookTo(book, folderId) {
  const wasIn = book.folderId;
  const target = folderId || null;
  book.folderId = target;
  // Charts keep their nodes, but links to a book that left the folder are cleared.
  if (wasIn && wasIn !== target) {
    const of = folderById(wasIn);
    if (of && Array.isArray(of.nodes)) of.nodes.forEach(n => { if (n.bookId === book.id) n.bookId = null; });
  }
  save(); render();
  if (target) toast(`Moved to “${folderById(target)?.name || ''}”`);
  else if (wasIn) toast(`Removed from “${folderById(wasIn)?.name || 'folder'}” — now in Unsorted`);
  else toast('Already in Unsorted');
}

/* ---------- reading flowchart (per folder): free nodes + connections ---------- */
// Each folder may carry `nodes`: [{id, label, fx, fy (0..1 pos), bookId?}]
// and `edges`: [{from, to}]. Nodes are abstract — not books.
const NODE_W = 150; // fallbacks only — real node size is measured (nodeSize)
const NODE_H = 64;
function clamp01(v) { v = Number(v); if (!isFinite(v)) return 0.1; return Math.min(1, Math.max(0, v)); }
function folderNodes(fid) { const f = folderById(fid); if (!f) return []; if (!Array.isArray(f.nodes)) f.nodes = []; return f.nodes; }
function folderEdges(fid) { const f = folderById(fid); if (!f) return []; if (!Array.isArray(f.edges)) f.edges = []; return f.edges; }
function folderSections(fid) { const f = folderById(fid); if (!f) return []; if (!Array.isArray(f.sections)) f.sections = []; return f.sections; }
function sectionOf(fid, nodeId) { return folderSections(fid).find(s => (s.nodeIds || []).includes(nodeId)) || null; }
function resetChartUi() { pendingLink = null; chartSelection = []; sectionHi = null; }
function pruneChart(fid) {
  const f = folderById(fid);
  if (!f) return;
  const nodes = folderNodes(fid);
  const ids = new Set(nodes.map(n => n.id));
  const edges = folderEdges(fid);
  const kept = edges.filter(e => ids.has(e.from) && ids.has(e.to));
  if (kept.length !== edges.length) { f.edges = kept; save(); }
  if (Array.isArray(f.sections)) {
    let touched = false;
    for (const s of f.sections) {
      const before = (s.nodeIds || []).length;
      s.nodeIds = (s.nodeIds || []).filter(id => ids.has(id));
      if (s.nodeIds.length !== before) touched = true;
    }
    const bn = f.sections.length;
    f.sections = f.sections.filter(s => (s.nodeIds || []).length > 0);
    if (f.sections.length !== bn) touched = true;
    if (touched) save();
  }
}
function createNode(fid, opts = {}) {
  if (desktopOnly()) return ;
  const f = folderById(fid);
  if (!f) return null;
  const nodes = folderNodes(fid);
  const k = nodes.length;
  const n = {
    id: uid(),
    label: String(opts.label || 'New node').slice(0, 60),
    bookId: opts.bookId || null,
    fx: clamp01(opts.fx !== undefined ? opts.fx : 0.06 + 0.2 * (k % 5)),
    fy: clamp01(opts.fy !== undefined ? opts.fy : 0.12 + 0.24 * (Math.floor(k / 5) % 3)),
  };
  nodes.push(n);
  save(); render();
  return n;
}
function deleteNode(fid, nodeId) {
  const f = folderById(fid);
  if (!f) return;
  if (Array.isArray(f.nodes)) f.nodes = f.nodes.filter(n => n.id !== nodeId);
  if (Array.isArray(f.edges)) f.edges = f.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
  if (Array.isArray(f.sections)) f.sections.forEach(s => { s.nodeIds = (s.nodeIds || []).filter(id => id !== nodeId); });
  if (pendingLink && pendingLink.id === nodeId) pendingLink = null;
  chartSelection = chartSelection.filter(id => id !== nodeId);
  save(); render();
  toast('Node deleted');
}
function clearChart(fid) {
  if (desktopOnly()) return ;
  const f = folderById(fid);
  if (!f) return;
  if ((!f.nodes || !f.nodes.length) && (!f.edges || !f.edges.length) && (!f.sections || !f.sections.length)) return;
  if (!confirm(`Clear the flowchart for “${f.name}”?`)) return;
  f.nodes = []; f.edges = []; f.sections = [];
  resetChartUi();
  save(); render();
}
function addEdge(fid, from, to) {
  if (!from || !to || from === to) return false;
  const edges = folderEdges(fid);
  if (edges.some(e => e.from === from && e.to === to)) return false;
  edges.push({ from, to });
  save(); render();
  return true;
}
function deleteEdge(fid, from, to) {
  const f = folderById(fid);
  if (!f || !Array.isArray(f.edges)) return;
  f.edges = f.edges.filter(e => !(e.from === from && e.to === to));
  save(); render();
  toast('Connection removed');
}
async function renameNode(fid, nodeId) {
  const n = folderNodes(fid).find(x => x.id === nodeId);
  if (!n) return;
  const r = await promptName('Rename node', n.label || '');
  if (!r || !r.value) return;
  n.label = r.value.slice(0, 60);
  save(); render();
}
function linkNodeBook(fid, nodeId, bookId) {
  const n = folderNodes(fid).find(x => x.id === nodeId);
  if (!n) return;
  n.bookId = bookId || null;
  const b = bookId ? state.books.find(x => x.id === bookId) : null;
  if (b && (!n.label || n.label === 'New node')) n.label = b.title.slice(0, 60);
  save(); render();
  toast(b ? 'Book linked to node' : 'Book unlinked');
}

/* ---------- chart sections (named + colored node groups) ---------- */
function createSection(fid, name, color, nodeIds) {
  const f = folderById(fid);
  if (!f) return null;
  const valid = new Set(folderNodes(fid).map(n => n.id));
  const ids = [...new Set(nodeIds || [])].filter(id => valid.has(id));
  if (!ids.length) return null;
  const secs = folderSections(fid);
  secs.forEach(s => { s.nodeIds = (s.nodeIds || []).filter(id => !ids.includes(id)); });
  const s = { id: uid(), name: String(name || 'Section').slice(0, 40), color: color || '#ffd9d9', nodeIds: ids };
  secs.push(s);
  save(); render();
  return s;
}
function deleteSection(fid, sid) {
  const f = folderById(fid);
  if (!f || !Array.isArray(f.sections)) return;
  f.sections = f.sections.filter(s => s.id !== sid);
  if (sectionHi && sectionHi.sid === sid) sectionHi = null;
  save(); render();
  toast('Section removed — nodes stay');
}
async function renameSection(fid, sid) {
  const s = folderSections(fid).find(x => x.id === sid);
  if (!s) return;
  const r = await promptName('Rename section', s.name || '', true, s.color || '#ffd9d9');
  if (!r) return;
  if (r.value) s.name = r.value.slice(0, 40);
  if (r.color) s.color = r.color;
  save(); render();
}
function moveNodesToSection(fid, sid, ids) {
  const secs = folderSections(fid);
  const s = secs.find(x => x.id === sid);
  if (!s) return false;
  const valid = new Set(folderNodes(fid).map(n => n.id));
  const clean = [...new Set(ids || [])].filter(id => valid.has(id));
  if (!clean.length) return false;
  secs.forEach(o => { if (o.id !== sid) o.nodeIds = (o.nodeIds || []).filter(id => !clean.includes(id)); });
  s.nodeIds = [...new Set([...(s.nodeIds || []), ...clean])];
  save(); render();
  return true;
}
function addSelectionToSection(fid, sid) {
  const ids = chartSelection.filter(id => folderNodes(fid).some(n => n.id === id));
  if (!ids.length) { clearSelection(); return; }
  const s = folderSections(fid).find(x => x.id === sid);
  clearSelection();
  if (moveNodesToSection(fid, sid, ids) && s) toast(`Added to “${s.name}”`);
}
function clearSelection() {
  chartSelection = [];
  document.querySelectorAll('.flow-node.selected').forEach(x => x.classList.remove('selected'));
}
function toggleSectionHi(fid, sid) {
  document.querySelectorAll('.flow-node.section-hi').forEach(x => { x.classList.remove('section-hi'); x.style.color = ''; });
  if (sectionHi && sectionHi.fid === fid && sectionHi.sid === sid) { sectionHi = null; return; }
  const s = folderSections(fid).find(x => x.id === sid);
  if (!s) { sectionHi = null; return; }
  sectionHi = { fid, sid };
  s.nodeIds.forEach(id => {
    const el = document.querySelector(`[data-node-id="${id}"]`);
    if (el) { el.style.color = s.color || '#1a1a1a'; el.classList.add('section-hi'); }
  });
}
function renderSectionBar(fid) {
  const bar = $('#sectionBar');
  if (!bar) return;
  const secs = folderSections(fid);
  bar.innerHTML = '';
  if (!secs.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  for (const s of secs) {
    const chip = document.createElement('span');
    chip.className = 'section-chip';
    chip.title = 'Click to highlight · double-click to rename';
    chip.innerHTML = `<span class="section-dot" style="background:${escapeHtml(s.color || '#999')}"></span><span>${escapeHtml(s.name)}</span><span class="section-count">${(s.nodeIds || []).length}</span>`;
    const x = document.createElement('button');
    x.className = 'section-x'; x.textContent = '×'; x.title = 'Ungroup (keep nodes)';
    x.onclick = (e) => { e.stopPropagation(); deleteSection(fid, s.id); };
    chip.appendChild(x);
    chip.onclick = () => toggleSectionHi(fid, s.id);
    chip.ondblclick = (e) => { e.stopPropagation(); renameSection(fid, s.id); };
    bar.appendChild(chip);
  }
}

/* ---------- chart zoom (view only; node fractions never change) ---------- */
function chartZoomOf(fid) {
  const f = fid ? folderById(fid) : null;
  const z = f && isFinite(f.chartZoom) ? +f.chartZoom : 1;
  return Math.min(2.5, Math.max(0.3, z));
}
function chartDims() {
  // World size = host viewport x zoom. Measured *including* the room a
  // scrollbar steals, so showing/hiding a scrollbar can never shrink the
  // world (which used to make nodes unreachable near the edges).
  const host = $('#flowChart');
  const z = chartZoomOf(state.currentFolderId);
  let baseW = 800, baseH = 380;
  if (host) {
    const cs = getComputedStyle(host);
    const bx = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    const by = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    baseW = Math.max(200, Math.round(host.clientWidth + Math.max(0, host.offsetWidth - host.clientWidth - bx)));
    baseH = Math.max(200, Math.round(host.clientHeight + Math.max(0, host.offsetHeight - host.clientHeight - by)));
  }
  return { z, W: Math.max(1, Math.round(baseW * z)), H: Math.max(1, Math.round(baseH * z)) };
}
// Client point -> pixel inside the scrolled world.
function chartWorldXY(host, clientX, clientY) {
  const r = host.getBoundingClientRect();
  const cs = getComputedStyle(host);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  return {
    x: clientX - r.left - bl + (host.scrollLeft || 0),
    y: clientY - r.top - bt + (host.scrollTop || 0)
  };
}
function nodeSize(el) {
  return { w: (el && el.offsetWidth) || NODE_W, h: (el && el.offsetHeight) || NODE_H };
}
// A node's top-left can travel from 0 to world - its own size; fx/fy are that
// fraction, so every pixel of the canvas is reachable at any zoom.
function chartTravel(dims, size) {
  return { x: Math.max(0, dims.W - size.w), y: Math.max(0, dims.H - size.h) };
}
function fracToPos(fx, fy, dims, size) {
  const t = chartTravel(dims, size);
  return { x: clamp01(fx) * t.x, y: clamp01(fy) * t.y };
}
function posToFrac(x, y, dims, size) {
  const t = chartTravel(dims, size);
  return { fx: t.x > 0 ? clamp01(x / t.x) : 0, fy: t.y > 0 ? clamp01(y / t.y) : 0 };
}
function clampPx(v, max) { return Math.min(Math.max(0, v), Math.max(0, max)); }
// Drop a freshly rendered node so its middle sits under the cursor.
function placeNodeCentered(fid, node, host, clientX, clientY) {
  if (!node || !host) return;
  const el = document.querySelector(`[data-node-id="${node.id}"]`);
  const size = nodeSize(el);
  const dims = chartDims();
  const t = chartTravel(dims, size);
  const p = chartWorldXY(host, clientX, clientY);
  const f = posToFrac(clampPx(p.x - size.w / 2, t.x), clampPx(p.y - size.h / 2, t.y), dims, size);
  node.fx = f.fx; node.fy = f.fy;
  positionNodes(fid);
  layoutEdges();
  save();
}
let chartZoomSaveT = null;
function setChartZoom(fid, z, anchor) {
  const f = folderById(fid);
  if (!f) return;
  z = Math.min(2.5, Math.max(0.3, z));
  const host = $('#flowChart');
  let cx = 0.5, cy = 0.2;
  if (host && anchor) {
    const old = chartDims();
    const p = chartWorldXY(host, anchor.x, anchor.y);
    cx = p.x / Math.max(1, old.W);
    cy = p.y / Math.max(1, old.H);
  }
  f.chartZoom = Math.round(z * 100) / 100;
  positionNodes(fid);
  layoutEdges();
  updateZoomLabel();
  if (host && anchor) {
    const d = chartDims();
    host.scrollLeft = cx * d.W - (anchor.x - host.getBoundingClientRect().left);
    host.scrollTop = cy * d.H - (anchor.y - host.getBoundingClientRect().top);
  }
  clearTimeout(chartZoomSaveT);
  chartZoomSaveT = setTimeout(save, 600);
}
function updateZoomLabel() {
  const l = $('#chartZoomLabel');
  if (l) l.textContent = Math.round(chartZoomOf(state.currentFolderId) * 100) + '%';
}
function chartWheel(e) {
  if (!state.currentFolderId) return;
  e.preventDefault();
  const fid = state.currentFolderId;
  setChartZoom(fid, chartZoomOf(fid) * Math.pow(1.0015, -e.deltaY), { x: e.clientX, y: e.clientY });
}
function handleNodeClick(fid, nodeId) {
  if (pendingLink && pendingLink.fid === fid && pendingLink.id !== nodeId) {
    const ok = addEdge(fid, pendingLink.id, nodeId);
    toast(ok ? 'Connected ✓' : 'Already connected');
    pendingLink = null;
    refreshLinkHL();
  } else if (pendingLink && pendingLink.id === nodeId) {
    pendingLink = null;
    refreshLinkHL();
  } else {
    pendingLink = { fid, id: nodeId };
    refreshLinkHL();
    toast('Node selected — click another node to connect it');
  }
}
function refreshLinkHL() {
  document.querySelectorAll('.flow-node.link-source').forEach(x => x.classList.remove('link-source'));
  if (pendingLink) {
    const el = document.querySelector(`[data-node-id="${pendingLink.id}"]`);
    if (el) el.classList.add('link-source');
  }
}

/* ---------- pointer dragging (books + nodes, no native DnD) ---------- */
function elFromPoint(x, y) {
  try {
    const el = document.elementFromPoint(x, y);
    return el && el.closest ? el : null;
  } catch { return null; }
}
function clearDropHL() {
  document.querySelectorAll('.folder-card.dragover').forEach(x => x.classList.remove('dragover'));
  const ch = $('#crumbHome');
  if (ch) ch.classList.remove('crumb-drop');
  const fc = $('#flowChart');
  if (fc) fc.classList.remove('chart-drop');
}
function makeGhost(text) {
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.textContent = text;
  document.body.appendChild(g);
  return g;
}
function beginBookPointer(e, b) {
  if (e.button !== undefined && e.button > 0) return;
  if (WEB) {
    // No reordering on the phone, but a tap must still open the book — this is
    // the same object the pointer-up handler looks at to decide "it was a tap".
    ptrDrag = { kind: 'book', bookId: b.id, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, pid: e.pointerId, tapOnly: true };
    return;
  }
  ptrDrag = { kind: 'book', bookId: b.id, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, pid: e.pointerId };
}
function beginNodePointer(e, fid, nodeId, nodeEl) {
  if (e.button !== undefined && e.button > 0) return;
  const canvas = $('#flowChart');
  const size = nodeSize(nodeEl);
  const p = chartWorldXY(canvas, e.clientX, e.clientY);
  // Keep the grab point: the node must not jump half its size under the cursor.
  ptrDrag = {
    kind: 'node', fid, nodeId, nodeEl, canvas, startX: e.clientX, startY: e.clientY,
    moved: false, pid: e.pointerId, size, grabX: p.x - nodeEl.offsetLeft, grabY: p.y - nodeEl.offsetTop,
    lastX: e.clientX, lastY: e.clientY, apx: 0, apy: 0, fx: 0, fy: 0
  };
}
function nodePx(d, clientX, clientY) {
  // Client point -> node fractions, scroll-aware and clamped to the world.
  const dims = chartDims();
  const p = chartWorldXY(d.canvas, clientX, clientY);
  const t = chartTravel(dims, d.size);
  const x = clampPx(p.x - d.grabX, t.x);
  const y = clampPx(p.y - d.grabY, t.y);
  const f = posToFrac(x, y, dims, d.size);
  return { fx: f.fx, fy: f.fy, x, y };
}
function applyNodePos(d, clientX, clientY) {
  const p = nodePx(d, clientX, clientY);
  d.fx = p.fx; d.fy = p.fy;
  d.nodeEl.style.left = p.x + 'px';
  d.nodeEl.style.top = p.y + 'px';
  layoutEdges();
}
// Hold a node near the edge of the viewport and the chart keeps scrolling, so
// the whole world stays reachable no matter how far it is zoomed or panned.
const CHART_EDGE = 56;
function nodeAutoPan(d, clientX, clientY) {
  const host = d.canvas;
  if (!host) return;
  const r = host.getBoundingClientRect();
  let vx = 0, vy = 0;
  if (clientX < r.left + CHART_EDGE) vx = -(r.left + CHART_EDGE - clientX) / CHART_EDGE;
  else if (clientX > r.right - CHART_EDGE) vx = (clientX - (r.right - CHART_EDGE)) / CHART_EDGE;
  if (clientY < r.top + CHART_EDGE) vy = -(r.top + CHART_EDGE - clientY) / CHART_EDGE;
  else if (clientY > r.bottom - CHART_EDGE) vy = (clientY - (r.bottom - CHART_EDGE)) / CHART_EDGE;
  d.apx = Math.max(-1, Math.min(1, vx));
  d.apy = Math.max(-1, Math.min(1, vy));
  if ((d.apx || d.apy) && !autoPanRaf) autoPanRaf = requestAnimationFrame(autoPanTick);
  if (!d.apx && !d.apy) stopAutoPan();
}
function autoPanTick() {
  autoPanRaf = 0;
  const d = ptrDrag;
  if (!d || d.kind !== 'node' || (!d.apx && !d.apy)) return;
  const host = d.canvas;
  const sl = host.scrollLeft, st = host.scrollTop;
  const speed = 18;
  if (d.apx) host.scrollLeft = sl + Math.sign(d.apx) * Math.max(1, Math.round(speed * Math.abs(d.apx)));
  if (d.apy) host.scrollTop = st + Math.sign(d.apy) * Math.max(1, Math.round(speed * Math.abs(d.apy)));
  if (host.scrollLeft !== sl || host.scrollTop !== st) applyNodePos(d, d.lastX, d.lastY);
  if (d.apx || d.apy) autoPanRaf = requestAnimationFrame(autoPanTick);
}
function stopAutoPan() {
  if (autoPanRaf) { cancelAnimationFrame(autoPanRaf); autoPanRaf = 0; }
  if (ptrDrag) { ptrDrag.apx = 0; ptrDrag.apy = 0; }
}
function onPointerMove(e) {
  const d = ptrDrag;
  if (!d || e.pointerId !== d.pid) return;
  const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
  // On the phone books are not draggable, so a swipe is just a swipe: cancel
  // the press and let the page scroll, keeping the tap-to-open behaviour.
  if (d.tapOnly) {
    if (Math.hypot(dx, dy) >= 7) ptrDrag = null;
    return;
  }
  if (!d.moved) {
    if (Math.hypot(dx, dy) < 7) return;
    if (e.pointerType === 'touch') { ptrDrag = null; return; } // touch scrolls natively
    d.moved = true;
    hideMenu();
    if (d.kind === 'book') {
      const b = state.books.find(x => x.id === d.bookId);
      d.ghost = makeGhost(b ? b.title.slice(0, 40) : 'book');
    }
  }
  if (d.ghost) { d.ghost.style.left = (e.clientX + 14) + 'px'; d.ghost.style.top = (e.clientY + 14) + 'px'; }
  if (d.kind === 'book') {
    clearDropHL();
    const hit = elFromPoint(e.clientX, e.clientY);
    const folderEl = hit ? hit.closest('[data-folder-id]') : null;
    const crumbEl = hit ? hit.closest('#crumbHome') : null;
    const chartEl = hit ? hit.closest('#flowChart') : null;
    d.targetFolder = folderEl ? folderEl.dataset.folderId : null;
    d.targetCrumb = !!crumbEl;
    d.targetChart = !!chartEl && !!state.currentFolderId;
    d.dropX = e.clientX; d.dropY = e.clientY;
    if (folderEl) folderEl.classList.add('dragover');
    else if (crumbEl) crumbEl.classList.add('crumb-drop');
    else if (d.targetChart && chartEl) chartEl.classList.add('chart-drop');
  } else if (d.kind === 'node') {
    d.lastX = e.clientX; d.lastY = e.clientY;
    applyNodePos(d, e.clientX, e.clientY);
    nodeAutoPan(d, e.clientX, e.clientY);
  } else if (d.kind === 'pan') {
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      hideMenu();
    }
    d.canvas.scrollLeft = d.scrollL - (e.clientX - d.startX);
    d.canvas.scrollTop = d.scrollT - (e.clientY - d.startY);
  }
}
function onPointerUp(e) {
  const d = ptrDrag;
  if (!d || e.pointerId !== d.pid) return;
  stopAutoPan();
  ptrDrag = null;
  if (d.ghost) { d.ghost.remove(); d.ghost = null; }
  clearDropHL();
  if (d.kind === 'book') {
    const b = state.books.find(x => x.id === d.bookId);
    if (!b) return;
    if (!d.moved) { openBook(b); return; } // plain click / tap opens
    if (d.targetFolder) {
      if ((b.folderId || null) !== d.targetFolder) moveBookTo(b, d.targetFolder);
    } else if (d.targetCrumb) {
      if (b.folderId) moveBookTo(b, null);
    } else if (d.targetChart && state.currentFolderId) {
      const n = createNode(state.currentFolderId, { label: b.title, bookId: b.id, fx: 0.5, fy: 0.5 });
      if (n) {
        // Re-measure now that it is rendered, so the real node size decides
        // where it lands (its book chip makes it taller than a blank node).
        placeNodeCentered(state.currentFolderId, n, $('#flowChart'), d.dropX, d.dropY);
        toast('Node added — click nodes to connect them');
      }
    }
  } else if (d.kind === 'node') {
    if (!d.moved) { handleNodeClick(d.fid, d.nodeId); return; }
    const n = folderNodes(d.fid).find(x => x.id === d.nodeId);
    if (n) { n.fx = d.fx; n.fy = d.fy; save(); } // position already live; just persist
  }
}
function onPointerCancel(e) {
  const d = ptrDrag;
  if (!d || e.pointerId !== d.pid) return;
  stopAutoPan();
  ptrDrag = null;
  if (d.ghost) { d.ghost.remove(); d.ghost = null; }
  clearDropHL();
  if (d.kind === 'node' && d.moved) {
    const n = folderNodes(d.fid).find(x => x.id === d.nodeId);
    if (n) { n.fx = d.fx; n.fy = d.fy; save(); render(); }
  }
}
document.addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerup', onPointerUp);
document.addEventListener('pointercancel', onPointerCancel);

/* ---------- right-drag lasso: marquee-select nodes, group into a section ---------- */
function chartContentXY(host, clientX, clientY) {
  return chartWorldXY(host, clientX, clientY);
}
function nodesInRect(x, y, w, h) {
  const host = $('#flowChart');
  if (!host) return [];
  const out = [];
  host.querySelectorAll('.flow-node').forEach(el => {
    const nx = el.offsetLeft, ny = el.offsetTop;
    const nw = el.offsetWidth || NODE_W, nh = el.offsetHeight || NODE_H;
    if (nx < x + w && nx + nw > x && ny < y + h && ny + nh > y) out.push(el.dataset.nodeId);
  });
  return out;
}
function beginLasso(e, fid) {
  const host = $('#flowChart');
  if (!host) return;
  const p = chartContentXY(host, e.clientX, e.clientY);
  lasso = { fid, pid: e.pointerId, x0: p.x, y0: p.y, moved: false, rect: null, ids: [] };
}
function onLassoMove(e) {
  if (!lasso || e.pointerId !== lasso.pid) return;
  const host = $('#flowChart');
  if (!host) { lasso = null; return; }
  const p = chartContentXY(host, e.clientX, e.clientY);
  if (!lasso.moved) {
    if (Math.hypot(p.x - lasso.x0, p.y - lasso.y0) < 6) return;
    lasso.moved = true;
    hideMenu();
    const inner = $('#flowInner') || host;
    const r = document.createElement('div');
    r.className = 'lasso-rect';
    inner.appendChild(r);
    lasso.rect = r;
  }
  const x = Math.min(p.x, lasso.x0), y = Math.min(p.y, lasso.y0);
  const w = Math.abs(p.x - lasso.x0), h = Math.abs(p.y - lasso.y0);
  Object.assign(lasso.rect.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  const ids = nodesInRect(x, y, w, h);
  lasso.ids = ids;
  host.querySelectorAll('.flow-node').forEach(el => {
    el.classList.toggle('selected', ids.includes(el.dataset.nodeId));
  });
}
async function onLassoUp(e) {
  if (!lasso || e.pointerId !== lasso.pid) return;
  const L = lasso;
  lasso = null;
  if (L.rect) { try { L.rect.remove(); } catch {} }
  document.querySelectorAll('.flow-node.selected').forEach(x => x.classList.remove('selected'));
  if (!L.moved) return; // plain right-click: context menus proceed normally
  suppressCtxMenu = true;
  setTimeout(() => { suppressCtxMenu = false; }, 0);
  const ids = (L.ids || []).filter(id => folderNodes(L.fid).some(n => n.id === id));
  if (!ids.length) { toast('No nodes selected'); return; }
  chartSelection = ids;
  ids.forEach(id => {
    const el = document.querySelector(`[data-node-id="${id}"]`);
    if (el) el.classList.add('selected');
  });
  const r = await promptName(`New section (${ids.length} node${ids.length === 1 ? '' : 's'})`, '', true, PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  clearSelection();
  if (!r || !r.value) { toast('Selection cleared'); return; }
  const s = createSection(L.fid, r.value, r.color, ids);
  if (s) toast(`Section “${s.name}” created`);
}
function onLassoCancel(e) {
  if (!lasso || e.pointerId !== lasso.pid) return;
  if (lasso.rect) { try { lasso.rect.remove(); } catch {} }
  lasso = null;
  suppressCtxMenu = true;
  setTimeout(() => { suppressCtxMenu = false; }, 0);
}
document.addEventListener('pointermove', onLassoMove);
document.addEventListener('pointerup', onLassoUp);
document.addEventListener('pointercancel', onLassoCancel);
function showSelectionMenu(x, y) {
  if (WEB) { showMenu(x, y, [{ label: 'Manage in the desktop app', action: desktopOnly }]); return; }
  const fid = state.currentFolderId;
  const ids = chartSelection.filter(id => folderNodes(fid).some(n => n.id === id));
  if (!ids.length) { clearSelection(); return; }
  const secs = folderSections(fid);
  showMenu(x, y, [
    { label: `Group ${ids.length} as new section…`, action: async () => {
        const r = await promptName(`New section (${ids.length})`, '', true, PALETTE[Math.floor(Math.random() * PALETTE.length)]);
        clearSelection();
        if (r && r.value) { const s = createSection(fid, r.value, r.color, ids); if (s) toast(`Section “${s.name}” created`); }
      } },
    ...(secs.length ? [{ header: 'Add to section' },
      ...secs.map(s => ({ label: `${s.name} (${(s.nodeIds || []).length})`, action: () => addSelectionToSection(fid, s.id) }))] : []),
    { sep: true },
    { label: `Delete ${ids.length} node(s)`, danger: true, action: () => {
        if (!confirm(`Delete ${ids.length} chart node(s)?`)) { clearSelection(); return; }
        const f = folderById(fid);
        const set = new Set(ids);
        if (f) {
          if (Array.isArray(f.nodes)) f.nodes = f.nodes.filter(n => !set.has(n.id));
          if (Array.isArray(f.edges)) f.edges = f.edges.filter(e => !set.has(e.from) && !set.has(e.to));
        }
        clearSelection(); save(); render();
      } },
    { label: 'Clear selection', action: clearSelection },
  ]);
}
// Kill-switch: nothing inside the app may start a native drag (book covers
// are <img> tags and browsers drag those natively, which looks exactly like
// a file drop). In-app moves use pointer dragging; real file imports come
// from outside the window and are unaffected.
window.addEventListener('dragstart', (e) => e.preventDefault());
window.addEventListener('blur', () => {
  if (ptrDrag) {
    if (ptrDrag.ghost) { try { ptrDrag.ghost.remove(); } catch {} ptrDrag = null; }
    else ptrDrag = null;
    clearDropHL();
  }
  if (lasso) {
    if (lasso.rect) { try { lasso.rect.remove(); } catch {} }
    lasso = null;
  }
});

function renderFlowchart() {
  // A re-render replaces the node elements a live drag is holding on to.
  if (ptrDrag && ptrDrag.kind === 'node') {
    if (ptrDrag.moved) {
      const n = folderNodes(ptrDrag.fid).find(x => x.id === ptrDrag.nodeId);
      if (n) { n.fx = ptrDrag.fx; n.fy = ptrDrag.fy; }
    }
    stopAutoPan();
    ptrDrag = null;
  }
  const sec = $('#orderSection');
  const fid = state.currentFolderId;
  const f = fid ? folderById(fid) : null;
  if (!f) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  pruneChart(fid);
  const nodes = folderNodes(fid);
  const edges = folderEdges(fid);
  $('#orderTitle').textContent = 'Reading flowchart';
  const acts = $('#orderActions');
  acts.innerHTML = '';
  const mkBtn = (label, title, fn) => {
    const btn = document.createElement('button');
    btn.className = 'btn small ghost';
    btn.textContent = label;
    btn.title = title;
    btn.onclick = fn;
    acts.appendChild(btn);
  };
  mkBtn('−', 'Zoom out (or scroll over the chart)', () => setChartZoom(fid, chartZoomOf(fid) / 1.2));
  const zl = document.createElement('span');
  zl.id = 'chartZoomLabel';
  zl.title = 'Zoom — click to reset to 100%';
  zl.style.cursor = 'pointer';
  zl.textContent = Math.round(chartZoomOf(fid) * 100) + '%';
  zl.onclick = () => setChartZoom(fid, 1);
  acts.appendChild(zl);
  mkBtn('+', 'Zoom in (or scroll over the chart)', () => setChartZoom(fid, chartZoomOf(fid) * 1.2));
  mkBtn('+ Node', 'Add a blank node (or drag a book here to make one)', () => {
    const n = createNode(fid);
    if (n) toast('Node added — drag to arrange, double-click to rename');
  });
  if (nodes.length || edges.length || folderSections(fid).length) mkBtn('Clear', 'Remove all nodes, connections and sections', () => clearChart(fid));
  renderSectionBar(fid);

  const host = $('#flowChart');
  host.innerHTML = '';
  const dims = chartDims();
  const inner = document.createElement('div');
  inner.id = 'flowInner';
  inner.style.width = dims.W + 'px';
  inner.style.height = dims.H + 'px';
  inner.innerHTML = '<svg id="flowEdges"><defs><marker id="flowArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#b5b5b5"></path></marker></defs></svg>';
  host.appendChild(inner);
  host.onwheel = chartWheel;
  host.onpointerdown = (e) => {
    if (e.pointerType === 'touch') return;
    if (e.button === 2) { beginLasso(e, fid); return; } // right-drag = marquee
    if (e.target.closest('.flow-node')) return;        // nodes handle their own press
    if (e.button === 0 || e.button === undefined) {
      // Left-drag empty canvas pans the view.
      ptrDrag = { kind: 'pan', canvas: host, startX: e.clientX, startY: e.clientY, scrollL: host.scrollLeft, scrollT: host.scrollTop, moved: false, pid: e.pointerId };
    }
  };
  if (!nodes.length) {
    // Nothing to place yet, so fill the visible box even when zoomed out.
    const host2 = $('#flowChart');
    inner.style.width = Math.max(dims.W, host2 ? host2.clientWidth : 0) + 'px';
    inner.style.height = Math.max(dims.H, host2 ? host2.clientHeight : 0) + 'px';
    const empty = document.createElement('div');
    empty.className = 'flow-empty';
    empty.innerHTML = `No nodes yet — <b>drag a book here</b> to turn it into a node, or start blank.<br/>`;
    const btn = document.createElement('button');
    btn.className = 'btn primary small';
    btn.textContent = '+ New node';
    btn.onclick = () => createNode(fid);
    empty.appendChild(btn);
    inner.appendChild(empty);
    requestAnimationFrame(layoutEdges);
    return;
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    const node = document.createElement('div');
    node.className = 'flow-node' + (pendingLink && pendingLink.id === n.id ? ' link-source' : '');
    node.dataset.nodeId = n.id;
    const linked = n.bookId ? state.books.find(b => b.id === n.bookId) : null;
    const sec = sectionOf(fid, n.id);
    if (sec) {
      node.style.outline = `2px solid ${sec.color || '#999'}`;
      node.style.outlineOffset = '2px';
    }
    node.title = sec ? `${n.label} — section “${sec.name}”` : n.label;
    node.title += linked ? ` — linked to “${linked.title}”` : ' — click to select, double-click to rename';
    node.innerHTML = `
      <div class="node-label">${escapeHtml(n.label || 'Untitled')}</div>
      ${linked ? `<span class="node-book" title="Open “${escapeHtml(linked.title)}”">Open</span>` : ''}
      <span class="flow-remove" title="Delete node">×</span>`;
    node.querySelector('.flow-remove').onclick = (e) => { e.stopPropagation(); deleteNode(fid, n.id); };
    const bb = node.querySelector('.node-book');
    if (bb && linked) bb.onclick = (e) => { e.stopPropagation(); openBook(linked); };
    node.ondblclick = (e) => { e.stopPropagation(); renameNode(fid, n.id); };
    node.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (suppressCtxMenu) { suppressCtxMenu = false; return; }
      if (WEB) { showMenu(e.clientX, e.clientY, [{ label: 'Manage in the desktop app', action: desktopOnly }]); return; }
      if (chartSelection.length > 1 && chartSelection.includes(n.id)) { showSelectionMenu(e.clientX, e.clientY); return; }
      const inFolder = booksInFolder(fid);
      showMenu(e.clientX, e.clientY, [
        { label: 'Rename node', action: () => renameNode(fid, n.id) },
        ...(linked ? [{ label: 'Open linked book', action: () => openBook(linked) }] : []),
        { header: 'Link a book' },
        ...inFolder.slice(0, 30).map(b => ({ label: (b.id === n.bookId ? '✓ ' : '') + b.title.slice(0, 38), action: () => linkNodeBook(fid, n.id, b.id) })),
        ...(n.bookId ? [{ label: 'Unlink book', action: () => linkNodeBook(fid, n.id, null) }] : []),
        { header: 'Section' },
        ...(sec ? [{ label: `Remove from “${sec.name}”`, action: () => { sec.nodeIds = (sec.nodeIds || []).filter(id => id !== n.id); save(); render(); } }] : []),
        ...folderSections(fid).filter(s => !sec || s.id !== sec.id).slice(0, 10).map(s => ({ label: `Put in “${s.name}”`, action: () => moveNodesToSection(fid, s.id, [n.id]) })),
        { label: 'New section with this node…', action: async () => {
            const r = await promptName('New section', '', true, PALETTE[Math.floor(Math.random() * PALETTE.length)]);
            if (r && r.value) { const s = createSection(fid, r.value, r.color, [n.id]); if (s) toast(`Section “${s.name}” created`); }
          } },
        { sep: true },
        { label: 'Delete node', danger: true, action: () => deleteNode(fid, n.id) },
      ]);
    };
    node.onpointerdown = (e) => {
      if (e.target.closest('.flow-remove') || e.target.closest('.node-book')) return;
      // A right-drag may start on a node — that is the natural way to marquee.
      if (e.button === 2) { beginLasso(e, fid); return; }
      beginNodePointer(e, fid, n.id, node);
    };
    inner.appendChild(node);
  }
  requestAnimationFrame(() => { positionNodes(fid); layoutEdges(); });
}

function positionNodes(fid) {
  const inner = $('#flowInner');
  if (!inner) return;
  const d = chartDims();
  inner.style.width = d.W + 'px';
  inner.style.height = d.H + 'px';
  const nodes = folderNodes(fid);
  inner.querySelectorAll('.flow-node').forEach(el => {
    const n = nodes.find(x => x.id === el.dataset.nodeId);
    if (!n) return;
    const pos = fracToPos(n.fx, n.fy, d, nodeSize(el));
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
  });
}

// Straight center-to-center edges, clipped to node boxes, with arrowheads.
function layoutEdges() {
  const host = $('#flowChart');
  const svg = $('#flowEdges');
  if (!host || !svg) return;
  const fid = state.currentFolderId;
  if (!fid) return;
  const d = chartDims();
  const edges = folderEdges(fid);
  const boxes = new Map();
  host.querySelectorAll('.flow-node').forEach(el => {
    boxes.set(el.dataset.nodeId, {
      x: el.offsetLeft, y: el.offsetTop,
      w: el.offsetWidth || NODE_W, h: el.offsetHeight || NODE_H
    });
  });
  svg.setAttribute('width', d.W);
  svg.setAttribute('height', d.H);
  svg.setAttribute('viewBox', `0 0 ${d.W} ${d.H}`);
  const clip = (b, cx, cy) => {
    // param t where the center-line exits rect b toward (cx,cy)
    const dx = cx - (b.x + b.w / 2), dy = cy - (b.y + b.h / 2);
    if (!dx && !dy) return [b.x + b.w / 2, b.y + b.h / 2];
    const tx = dx !== 0 ? (b.w / 2) / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? (b.h / 2) / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    return [b.x + b.w / 2 + dx * t, b.y + b.h / 2 + dy * t];
  };
  let html = '<defs><marker id="flowArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#b5b5b5"></path></marker></defs>';
  for (const e of edges) {
    const a = boxes.get(e.from), b = boxes.get(e.to);
    if (!a || !b) continue;
    const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
    const [x1, y1] = clip(a, bcx, bcy);
    const [x2, y2] = clip(b, acx, acy);
    const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    html += `<g class="edge" data-from="${e.from}" data-to="${e.to}"><path class="edge-hit" d="${d}"/><path class="edge-line" d="${d}"/></g>`;
  }
  svg.innerHTML = html;
  svg.querySelectorAll('.edge').forEach(g => {
    g.oncontextmenu = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (suppressCtxMenu) { suppressCtxMenu = false; return; }
      showMenu(ev.clientX, ev.clientY, WEB
        ? [{ label: 'Manage in the desktop app', action: desktopOnly }]
        : [{ label: 'Delete this connection', danger: true, action: () => deleteEdge(fid, g.dataset.from, g.dataset.to) }]);
    };
  });
}
window.addEventListener('resize', () => {
  if (state.currentFolderId && !$('#orderSection').classList.contains('hidden')) {
    positionNodes(state.currentFolderId);
    layoutEdges();
  }
  if (epubState && epubMode() === 'pages' && currentBookId === epubState.book.id
      && !$('#readerView').classList.contains('hidden') && !$('#epubPaged').classList.contains('hidden')) {
    paginateEpub();
  }
});

/* ---------- books ---------- */
async function renameBook(b) {
  if (desktopOnly()) return ;
  const r = await promptName('Rename book', b.title);
  if (!r || !r.value) return;
  b.title = r.value.slice(0, 120);
  b.userRenamed = true; // don't let later metadata enrichment overwrite it
  save(); render();
  if (currentBookId === b.id) { $('#readerTitle').textContent = b.title; }
}
async function deleteBook(b) {
  if (desktopOnly()) return ;
  if (!confirm(`Remove “${b.title}” from your library?\nThe file will also be deleted from the app library.`)) return;
  try { if (b.storedPath && window.api) await window.api.deleteFile(b.storedPath); } catch {}
  try { if (b.coverPath && window.api) await window.api.deleteFile(b.coverPath); } catch {}
  state.books = state.books.filter(x => x.id !== b.id);
  const ff = folderById(b.folderId);
  if (ff && Array.isArray(ff.nodes)) ff.nodes.forEach(n => { if (n.bookId === b.id) n.bookId = null; });
  save(); render();
  toast('Book removed');
}

async function importPaths(paths, targetFolderId = null) {
  if (!paths || !paths.length) return;
  const supported = paths.filter(p => typeOf(p));
  const skipped = paths.length - supported.length;
  if (!supported.length) { toast('No supported files (EPUB, MP3, M4A…)'); return; }
  toast(`Importing ${supported.length} file(s)…`);
  let results = [];
  try { results = await window.api.importFiles(supported); }
  catch (e) { toast('Import failed: ' + e.message); return; }
  let added = 0;
  for (const r of results) {
    if (!r || r.error || !r.storedPath) continue;
    const t = typeOf(r.fileName);
    if (!t) continue;
    const book = {
      id: uid(), title: r.fileName.replace(/\.[^.]+$/, ''), author: '',
      type: t, fileName: r.fileName, storedPath: r.storedPath,
      folderId: targetFolderId || state.currentFolderId || null,
      addedAt: Date.now(), cover: '', progress: 0
    };
    state.books.unshift(book);
    try { await enrichBook(book); } catch (e) { console.warn('enrich failed', e); }
    added++;
  }
  save(); render();
  toast(added + ' book(s) added' + (skipped ? ` · ${skipped} skipped` : ''));
  // refresh covers lazily already done
}

async function pickAndImport() {
  if (desktopOnly()) return ;
  try {
    const paths = await window.api.pickFiles();
    if (paths && paths.length) importPaths(paths);
  } catch (e) { toast('Could not open dialog'); }
}

/* ---------- EPUB parsing (offline, via JSZip) ---------- */
async function zipOf(storedPath) {
  // Ask for bytes when the client can produce them. A phone used to pull the
  // whole file as a base64 data URL, which inflates it by a third and makes
  // several copies in memory — enough to fail on the larger books.
  if (window.api && window.api.readFileBytes) {
    try {
      const bytes = await window.api.readFileBytes(storedPath);
      if (bytes && bytes.length) return await JSZip.loadAsync(bytes);
    } catch (e) {
      console.warn('could not read book as bytes, falling back', e);
    }
  }
  const b64 = await window.api.readFileBase64(storedPath);
  const bytes = base64ToBytes(b64);
  return await JSZip.loadAsync(bytes);
}
/* Namespace-proof XML helpers (OPF/NCX often declare default namespaces,
   which defeat plain querySelector). */
function xmlKids(el) { return el && el.children ? [...el.children] : []; }
function findKids(el, local) { return xmlKids(el).filter(c => c.localName === local); }
function findFirst(el, ...path) {
  let cur = el ? [el] : [];
  for (const p of path) { const nx = []; for (const c of cur) nx.push(...findKids(c, p)); cur = nx; }
  return cur[0] || null;
}
function xattr(el, name) { try { return el ? el.getAttribute(name) : null; } catch { return null; } }

async function readEpubMeta(storedPath) {
  const zip = await zipOf(storedPath);
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) return {};
  const cdoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfile = findFirst(cdoc, 'container', 'rootfiles', 'rootfile') || cdoc.querySelector('rootfile');
  const opfPath = (rootfile && xattr(rootfile, 'full-path')) || 'OEBPS/content.opf';
  const opfText = await zip.file(opfPath)?.async('text');
  if (!opfText) return {};
  const opf = new DOMParser().parseFromString(opfText, 'application/xml');
  const pkg = opf.documentElement;
  const md = findFirst(pkg, 'metadata');
  const title = (md && findKids(md, 'title')[0]?.textContent?.trim())
    || opf.querySelector('metadata > title, title')?.textContent?.trim() || '';
  const author = (md && (findKids(md, 'creator')[0]?.textContent?.trim() || findKids(md, 'author')[0]?.textContent?.trim()))
    || opf.querySelector('metadata > creator, creator')?.textContent?.trim() || '';
  const opfDir = dirOf(opfPath);
  const manifestEl = findFirst(pkg, 'manifest');
  const manifestItems = manifestEl ? findKids(manifestEl, 'item') : [...opf.querySelectorAll('manifest > item')];
  const byId = {};
  manifestItems.forEach(i => { byId[xattr(i, 'id')] = i; });
  // Cover candidates, best guess first: meta name=cover → manifest
  // cover-image → id/media match → guide reference → biggest other images.
  const declared = [];
  const metas = md ? findKids(md, 'meta') : [];
  const coverMeta = metas.find(m => xattr(m, 'name') === 'cover') || opf.querySelector('meta[name="cover"]');
  const coverId = coverMeta && xattr(coverMeta, 'content');
  if (coverId && byId[coverId]) declared.push(xattr(byId[coverId], 'href'));
  if (!declared.length) {
    const img = manifestItems.find(i => (xattr(i, 'properties') || '').includes('cover-image'))
      || manifestItems.find(i => /cover/i.test(xattr(i, 'id') || '') && /^image\//.test(xattr(i, 'media-type') || ''));
    if (img) declared.push(xattr(img, 'href'));
  }
  const guide = findFirst(pkg, 'guide');
  const ref = guide && findKids(guide, 'reference').find(r => /cover/i.test(xattr(r, 'type') || ''));
  if (ref && xattr(ref, 'href')) {
    const h = xattr(ref, 'href').split('#')[0];
    if (/\.(jpe?g|png|gif|webp|svg)$/i.test(h)) declared.push(h);
  }
  const rest = [];
  for (const i of manifestItems) {
    if (!/^image\//.test(xattr(i, 'media-type') || '')) continue;
    const h = xattr(i, 'href');
    if (!h || declared.includes(h)) continue;
    let sz = 0;
    try {
      const zp = joinZipDir(opfDir, h);
      const f = zip.file(zp) || zip.file(decodeURIComponent(zp));
      sz = (f && f._data && f._data.uncompressedSize) || 0;
    } catch {}
    if (sz > 1200) rest.push({ href: h, size: sz });
  }
  rest.sort((a, b) => b.size - a.size);
  const candidates = [...new Set(declared.filter(Boolean))].concat(rest.slice(0, 8).map(r => r.href));
  // Some books declare a thumbnail-sized cover, which turns into a blurred
  // smear on the tile. Take the first candidate that is big enough, else the
  // biggest one we can find.
  let cover = '', coverW = 0, coverH = 0;
  for (const href of candidates) {
    let dataUrl = '';
    try {
      const zp = joinZipDir(opfDir, href);
      const f = zip.file(zp) || zip.file(decodeURIComponent(zp));
      if (!f) continue;
      const b64 = await f.async('base64');
      if (b64.length > 4000000) continue; // far too big to be a cover
      dataUrl = `data:${mimeFor(href)};base64,${b64}`;
    } catch { continue; }
    const px = await imageSize(dataUrl);
    if (!px) continue;
    if (!px.w && !px.h) { // vector (SVG): no pixel size, scales cleanly
      if (!cover) { cover = dataUrl; coverW = 1e6; coverH = 1e6; }
      break;
    }
    if (px.w > coverW || (px.w === coverW && px.h > coverH)) {
      cover = dataUrl; coverW = px.w; coverH = px.h;
    }
    if (Math.max(coverW, coverH) >= MIN_COVER_PX) break;
  }
  if (cover && cover.length > 900000) cover = await downscaleCover(cover).catch(() => cover);
  if (cover) { const px = await imageSize(cover); if (px) { coverW = px.w; coverH = px.h; } }
  return { title, author, cover, coverW, coverH };
}

// Below this the cover is a thumbnail and gets blurry when blown up to a tile.
const MIN_COVER_PX = 220;

function imageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// A cover far smaller than the box it fills turns into a blurred smear, so
// show it at its own size instead of stretching it.
function markCover(img) {
  try {
    if (!img || !img.naturalWidth) return;
    const box = img.parentElement;
    const bw = (box && box.clientWidth) || 190, bh = (box && box.clientHeight) || 190;
    img.classList.toggle('cover-tiny', img.naturalWidth < bw * 1.4 || img.naturalHeight < bh * 1.4);
  } catch {}
}

function downscaleCover(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const max = 320;
        const scale = Math.min(1, max / img.width);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.82));
      } catch { resolve(dataUrl); }
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

function revokeEpubUrls() { epubObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch {} }); epubObjectUrls = []; }

/* ---------- covers live as files (never localStorage) + enrichment ---------- */
// Display URL for a book cover. The two clients disagree on what a cover is: in
// the app it is a file on this machine, in a browser it is an authenticated API
// URL. So each api knows how to answer for itself, and asking for the book
// rather than a path is what stops a browser pointing a cover at the book file.
function coverSrc(b) {
  if (!b) return '';
  if (window.api && window.api.coverUrl) {
    const u = window.api.coverUrl(b);
    if (u) return u;
  }
  if (b.coverPath && window.api) return window.api.fileUrl(b.coverPath);
  if (b.cover && String(b.cover).startsWith('data:')) return b.cover;
  return '';
}

// Persist a cover dataURL into userData/Covers; stores the path on the book.
async function storeBookCover(book, dataUrl) {
  if (!dataUrl || !window.api?.saveCover) return false;
  try {
    const p = await window.api.saveCover(book.id, dataUrl);
    if (p) {
      if (book.coverPath && book.coverPath !== p) { try { await window.api.deleteFile(book.coverPath); } catch {} }
      book.coverPath = p;
      if (book.cover && String(book.cover).startsWith('data:')) book.cover = '';
      return true;
    }
  } catch (e) { console.warn('store cover failed', e); }
  return false;
}

// One-time repair: books whose stored cover is a thumbnail (blurry when blown
// up) get re-picked from the EPUB with the bigger candidate.
async function repairSmallCovers() {
  if ((state.coverGen || 0) >= 4) return;
  state.coverGen = 4;
  save();
  const books = state.books.filter(b => b.type === 'epub' && b.coverPath && b.storedPath);
  let fixed = 0;
  for (const b of books) {
    try {
      const cur = coverSrc(b);
      if (!cur) continue;
      const px = await imageSize(cur);
      if (px && px.w && px.h && Math.min(px.w, px.h) >= MIN_COVER_PX) continue; // fine
      const meta = await readEpubMeta(b.storedPath);
      if (!meta.cover) continue;
      if (meta.coverW < (px ? px.w : 0) + 20) continue; // nothing better available
      if (await storeBookCover(b, meta.cover)) { fixed++; render(); }
    } catch {}
  }
  if (fixed) toast(`Sharpened ${fixed} cover${fixed === 1 ? '' : 's'}`);
}

// One-time migration: move inline covers out of localStorage into files.
async function migrateCoversToFiles() {
  if ((state.coverGen || 0) >= 3) return;
  const legacy = state.books.filter(b => b.cover && String(b.cover).startsWith('data:'));
  for (const b of legacy) {
    try {
      const p = await window.api.saveCover(b.id, b.cover);
      if (p) { b.coverPath = p; b.cover = ''; }
    } catch {}
  }
  state.coverGen = 3;
  save(); render();
}

// Enrich one book (must already be in state.books): real title/author/cover,
// plus embedded audio chapters. Saves + re-renders when something changed.
async function enrichBook(book) {
  if (!state.books.find(x => x.id === book.id)) return false;
  let changed = false;
  try {
    if (book.type === 'epub') {
      const meta = await readEpubMeta(book.storedPath);
      if (meta.title && !book.userRenamed) { book.title = meta.title; changed = true; }
      if (meta.author && !book.author) { book.author = meta.author; changed = true; }
      if (meta.cover && !book.coverPath) { if (await storeBookCover(book, meta.cover)) changed = true; }
    } else if (book.type === 'pdf') {
      const meta = await pdfBookMeta(book.storedPath);
      if (meta.title && !book.userRenamed) { book.title = meta.title; changed = true; }
      if (!book.coverPath) {
        const thumb = await pdfCoverThumb(book.storedPath).catch(() => '');
        if (thumb && await storeBookCover(book, thumb)) changed = true;
      }
    } else if (book.type === 'audio') {
      const meta = await window.api.getAudioMeta(book.storedPath).catch(() => null);
      if (meta && !meta.error) {
        if (meta.title && !book.userRenamed) { book.title = meta.title; changed = true; }
        if (meta.artist && !book.author) { book.author = meta.artist; changed = true; }
        if (Array.isArray(meta.chapters) && meta.chapters.length) { book.chapters = meta.chapters; changed = true; }
        if (meta.cover && !book.coverPath) {
          const small = await downscaleCover(meta.cover).catch(() => '');
          if (small && await storeBookCover(book, small)) changed = true;
          else if (meta.cover.length < 600000 && await storeBookCover(book, meta.cover)) changed = true;
        }
        // Only latch when chapters actually arrived: a file that failed to parse
        // (still copying, unreadable) must be retried later.
        book.audioMetaDone = !!(book.chapters && book.chapters.length);
        changed = true;
      }
    }
  } catch (e) { console.warn('enrich failed', book.fileName, e); }
  if (changed) { save(); render(); }
  return changed;
}

async function loadEpubChapters(storedPath) {
  const zip = await zipOf(storedPath);
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('Not a valid EPUB (missing container.xml)');
  const opfPath = new DOMParser().parseFromString(containerXml, 'application/xml').querySelector('rootfile')?.getAttribute('full-path') || 'OEBPS/content.opf';
  const opfText = await zip.file(opfPath)?.async('text');
  if (!opfText) throw new Error('Not a valid EPUB (missing OPF)');
  const opf = new DOMParser().parseFromString(opfText, 'application/xml');
  const opfDir = dirOf(opfPath);
  const pkgEl = opf.documentElement;
  const manifestEl = findFirst(pkgEl, 'manifest');
  const manifestList = manifestEl ? findKids(manifestEl, 'item') : [...opf.querySelectorAll('manifest > item')];
  const manifest = {};
  manifestList.forEach(i => { manifest[xattr(i, 'id')] = { href: xattr(i, 'href'), type: xattr(i, 'media-type'), props: xattr(i, 'properties') || '' }; });
  const spineEl = findFirst(pkgEl, 'spine');
  const spine = (spineEl ? findKids(spineEl, 'itemref') : [...opf.querySelectorAll('spine > itemref')])
    .map(s => xattr(s, 'idref')).filter(id => id && manifest[id]);
  const mdEl = findFirst(pkgEl, 'metadata');
  const bookTitle = (mdEl && findKids(mdEl, 'title')[0]?.textContent?.trim())
    || opf.querySelector('metadata > title, title')?.textContent?.trim() || '';

  // ---- table of contents: EPUB3 nav preferred, NCX fallback ----
  const spinePath = spine.map(idref => normalizeZipPath(joinZipDir(opfDir, manifest[idref].href)));
  const pathToSpine = {};
  spinePath.forEach((p, i) => { if (!(p in pathToSpine)) pathToSpine[p] = i; });
  const spineIndexFor = (baseDir, href) => {
    const parts = String(href || '').split('#');
    const frag = parts.slice(1).join('#');
    const p = parts[0];
    if (!p) return { idx: -1, frag };
    const norm = normalizeZipPath(joinZipDir(baseDir, p));
    const idx = pathToSpine[norm] ?? pathToSpine[decodeURIComponent(norm)] ?? -1;
    return { idx, frag };
  };
  let toc = [];
  try {
    const navEntry = Object.values(manifest).find(m => (m.props || '').split(/\s+/).includes('nav'));
    if (navEntry && navEntry.href) {
      const navPath = joinZipDir(opfDir, navEntry.href);
      const navFile = zip.file(navPath) || zip.file(decodeURIComponent(navPath));
      const navHtml = navFile ? await navFile.async('text') : '';
      if (navHtml) {
        const ndoc = new DOMParser().parseFromString(navHtml, 'text/html');
        const navs = [...ndoc.querySelectorAll('nav')].filter(n =>
          (n.getAttribute('epub:type') || n.getAttribute('type') || n.getAttribute('role') || '').toLowerCase().includes('toc'));
        const navRoot = navs[0] || ndoc.querySelector('nav');
        if (navRoot) {
          const walkNav = (ol, level) => {
            for (const li of [...ol.children].filter(c => c.tagName === 'LI')) {
              const a = li.querySelector(':scope > a, a');
              if (a && a.getAttribute('href')) {
                const { idx, frag } = spineIndexFor(joinZipDir(opfDir, dirOf(navEntry.href)), a.getAttribute('href'));
                if (idx >= 0) toc.push({ label: (a.textContent || '').trim().slice(0, 90) || 'Section', spine: idx, fragment: frag, level });
              }
              const sub = li.querySelector(':scope > ol');
              if (sub) walkNav(sub, level + 1);
            }
          };
          const topOl = navRoot.querySelector('ol');
          if (topOl) walkNav(topOl, 0);
        }
      }
    }
  } catch (e) { console.warn('nav toc failed', e); }
  if (!toc.length) {
    try {
      const ncxId = spineEl ? xattr(spineEl, 'toc') : null;
      const ncxEntry = (ncxId && manifest[ncxId])
        || Object.values(manifest).find(m => /dtbncx/i.test(m.type || '') || /\.ncx$/i.test(m.href || ''));
      if (ncxEntry && ncxEntry.href) {
        const ncxPath = joinZipDir(opfDir, ncxEntry.href);
        const ncxFile = zip.file(ncxPath) || zip.file(decodeURIComponent(ncxPath));
        const ncxText = ncxFile ? await ncxFile.async('text') : '';
        if (ncxText) {
          const nxml = new DOMParser().parseFromString(ncxText, 'application/xml');
          const navMap = findFirst(nxml.documentElement, 'navMap') || nxml.documentElement;
          const walkNcx = (parent, level) => {
            for (const np of findKids(parent, 'navPoint')) {
              const labelEl = findFirst(np, 'navLabel');
              const label = (labelEl && findKids(labelEl, 'text')[0]?.textContent?.trim()) || 'Section';
              const content = findFirst(np, 'content');
              const src = content && xattr(content, 'src');
              if (src) {
                const { idx, frag } = spineIndexFor(joinZipDir(opfDir, dirOf(ncxEntry.href)), src);
                if (idx >= 0) toc.push({ label: label.slice(0, 90), spine: idx, fragment: frag, level });
              }
              walkNcx(np, level + 1);
            }
          };
          walkNcx(navMap, 0);
        }
      }
    } catch (e) { console.warn('ncx toc failed', e); }
  }

  // preload images as blob urls for speed
  const imgCache = {};
  async function imgUrl(chapterDir, src) {
    if (!src || src.startsWith('data:') || /^https?:/.test(src) || src.startsWith('blob:')) return src;
    const key = chapterDir + '|' + src;
    if (imgCache[key]) return imgCache[key];
    const zp = joinZipDir(chapterDir, src);
    let f = zip.file(zp) || zip.file(decodeURIComponent(zp));
    if (!f) return src;
    const blob = await f.async('blob');
    const url = URL.createObjectURL(blob);
    epubObjectUrls.push(url);
    imgCache[key] = url;
    return url;
  }

  const chapters = [];
  for (const idref of spine) {
    const href = manifest[idref].href;
    const zpath = joinZipDir(opfDir, href);
    const file = zip.file(zpath) || zip.file(decodeURIComponent(zpath));
    if (!file) continue;
    const html = await file.async('text');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style').forEach(n => n.remove());
    doc.querySelectorAll('[bgcolor], [background], [text]').forEach(n => { n.removeAttribute('bgcolor'); n.removeAttribute('background'); n.removeAttribute('text'); });
    const root = doc.querySelector('body') || doc;
    const cdir = joinZipDir(opfDir, dirOf(href)) || dirOf(zpath);
    // fix images + links
    const imgs = [...root.querySelectorAll('img')];
    for (const im of imgs) {
      const src = im.getAttribute('src');
      if (src) im.src = await imgUrl(cdir, src);
      im.removeAttribute('srcset');
      im.loading = 'lazy';
    }
    root.querySelectorAll('a').forEach(a => {
      const h = a.getAttribute('href');
      if (h && !h.startsWith('#') && !/^https?:/.test(h)) a.removeAttribute('href');
      if (h && /^https?:/.test(h)) a.target = '_blank';
    });
    const title = doc.querySelector('h1, h2, title')?.textContent?.trim() || '';
    chapters.push({ title, html: root.innerHTML, href });
  }
  // Label each spine chapter: prefer the first TOC entry pointing at it.
  const spineLabel = chapters.map((c, i) => c.title || `Chapter ${i + 1}`);
  for (const t of toc) {
    if (t.spine >= 0 && t.spine < spineLabel.length && spineLabel[t.spine].startsWith('Chapter ')) {
      spineLabel[t.spine] = t.label;
    }
  }
  chapters.forEach((c, i) => { c.label = spineLabel[i]; });
  return { bookTitle, chapters, toc };
}

/* ---------- PDF (pdf.js, bundled offline) ---------- */
let pdfDoc = null;
let pdfBookId = null;
let pdfZoom = 1;
let pdfObserver = null;
let pdfRenderQueue = Promise.resolve();

function pdfReady() {
  if (!window.pdfjsLib) return Promise.reject(new Error('PDF engine failed to load.'));
  if (window.pdfjsLib.GlobalWorkerOptions.workerSrc) return Promise.resolve();
  // Load the worker from local files via a Blob URL so it works both in
  // development and inside the packaged .exe (asar).
  return (async () => {
    const url = new URL('../node_modules/pdfjs-dist/build/pdf.worker.js', location.href).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error('PDF worker not found.');
    const text = await res.text();
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      URL.createObjectURL(new Blob([text], { type: 'application/javascript' }));
  })();
}

function pdfFileUrl(storedPath) {
  return window.api.fileUrl(storedPath);
}

async function pdfBookMeta(storedPath) {
  // Fast metadata read (title) without rendering pages.
  await pdfReady();
  const doc = await window.pdfjsLib.getDocument({ url: pdfFileUrl(storedPath) }).promise;
  try {
    const md = await doc.getMetadata().catch(() => null);
    const title = md && md.info && md.info.Title ? String(md.info.Title).trim() : '';
    return { title, pages: doc.numPages };
  } finally {
    try { await doc.destroy(); } catch {}
  }
}

async function pdfCoverThumb(storedPath, width = 300) {
  await pdfReady();
  const doc = await window.pdfjsLib.getDocument({ url: pdfFileUrl(storedPath) }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c.toDataURL('image/jpeg', 0.8);
  } finally {
    try { await doc.destroy(); } catch {}
  }
}

function pdfBaseWidth() {
  // CSS pixel width available for a page.
  const wrap = $('#pdfPages');
  const w = wrap ? wrap.clientWidth - 32 : 600;
  return Math.max(320, Math.min(900, w));
}

async function openPdfBook(book) {
  closePdfDoc();
  await pdfReady();
  $('#pdfPages').innerHTML = '<p style="color:#999">Loading PDF…</p>';
  const doc = await window.pdfjsLib.getDocument({ url: pdfFileUrl(book.storedPath) }).promise;
  if (currentBookId !== book.id) { try { await doc.destroy(); } catch {} return; }
  pdfDoc = doc;
  pdfBookId = book.id;
  pdfZoom = fitPdfZoom();
  buildPdfPages();
  updatePdfLabels();
  // restore saved page
  requestAnimationFrame(() => {
    const n = Math.min(Math.max(1, book.pdfPage || 1), doc.numPages);
    const el = document.getElementById('pdfpage-' + n);
    if (el) el.scrollIntoView({ block: 'start' });
  });
}

function fitPdfZoom() {
  if (!pdfDoc) return 1;
  return pdfBaseWidth() / 612; // 612pt = standard page width
}

function buildPdfPages() {
  const host = $('#pdfPages');
  host.innerHTML = '';
  if (pdfObserver) { pdfObserver.disconnect(); pdfObserver = null; }
  // Estimated placeholders so the whole book lays out instantly; each page
  // gets its exact size the moment it renders.
  const startW = pdfBaseWidth();
  const startH = Math.floor(startW * 1.3);
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const d = document.createElement('div');
    d.className = 'pdf-page';
    d.id = 'pdfpage-' + n;
    d.dataset.page = n;
    d.style.width = startW + 'px';
    d.style.minHeight = startH + 'px';
    const tag = document.createElement('div');
    tag.className = 'pdf-page-num';
    tag.textContent = n + ' / ' + pdfDoc.numPages;
    d.appendChild(tag);
    frag.appendChild(d);
  }
  host.appendChild(frag);
  pdfObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const el = en.target;
      const n = parseInt(el.dataset.page, 10);
      if (en.isIntersecting) {
        renderPdfPage(n);
        trackPdfPage(n);
      } else if (el.dataset.rendered === '1') {
        // Virtualize far-away pages to bound memory on huge PDFs.
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        if (r.bottom < -2 * vh || r.top > 3 * vh) {
          const cv = el.querySelector('canvas');
          if (cv) cv.remove();
          delete el.dataset.rendered;
        }
      }
    }
  }, { root: $('#pdfScroll'), rootMargin: '600px 0px' });
  host.querySelectorAll('.pdf-page').forEach(el => pdfObserver.observe(el));
  updatePdfLabels();
  // Eagerly render the landing pages so the book looks fully open at once,
  // instead of waiting on scroll events.
  const b = state.books.find(x => x.id === pdfBookId);
  const cur = Math.min(Math.max(1, (b && b.pdfPage) || 1), pdfDoc.numPages);
  renderPdfPage(cur);
  renderPdfPage(cur + 1);
  renderPdfPage(cur + 2);
  if (cur > 1) renderPdfPage(cur - 1);
}

function renderPdfPage(n) {
  const el = document.getElementById('pdfpage-' + n);
  if (!el || el.dataset.rendered === '1' || el.dataset.rendering === '1') return;
  if (!pdfDoc || pdfBookId !== currentBookId) return;
  el.dataset.rendering = '1';
  pdfRenderQueue = pdfRenderQueue.then(async () => {
    try {
      if (!pdfDoc || pdfBookId !== currentBookId) return;
      const still = document.getElementById('pdfpage-' + n);
      if (!still || still.dataset.rendered === '1') return;
      const page = await pdfDoc.getPage(n);
      const fit = page.getViewport({ scale: 1 });
      const host2 = document.getElementById('pdfpage-' + n);
      if (!host2 || pdfBookId !== currentBookId) return;
      // Exact page size the moment it renders (fixes placeholder estimate).
      host2.style.width = Math.floor(fit.width * pdfZoom) + 'px';
      host2.style.minHeight = Math.floor(fit.height * pdfZoom) + 'px';
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: pdfZoom * dpr });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const live = (host2.isConnected ? host2 : document.getElementById('pdfpage-' + n));
      if (!live || pdfBookId !== currentBookId) return;
      const old = live.querySelector('canvas');
      if (old) old.remove();
      live.insertBefore(c, live.firstChild);
      live.dataset.rendered = '1';
    } catch (e) {
      console.warn('pdf render failed p' + n, e);
    } finally {
      const host3 = document.getElementById('pdfpage-' + n);
      if (host3) delete host3.dataset.rendering;
    }
  });
}

let pdfTrackT = null;
function trackPdfPage(n) {
  clearTimeout(pdfTrackT);
  pdfTrackT = setTimeout(() => {
    const b = state.books.find(x => x.id === pdfBookId);
    if (!b || !pdfDoc) return;
    b.pdfPage = n;
    b.progress = pdfDoc.numPages > 1 ? (n - 1) / (pdfDoc.numPages - 1) : 1;
    save();
    updatePdfLabels();
    render();
  }, 500);
}

function updatePdfLabels() {
  if (!pdfDoc) return;
  const b = state.books.find(x => x.id === pdfBookId);
  $('#pdfPageLabel').textContent = (b && b.pdfPage ? b.pdfPage : 1) + ' / ' + pdfDoc.numPages;
  $('#pdfZoomLabel').textContent = Math.round(pdfZoom * 100) + '%';
}

function gotoPdfPage(n) {
  if (!pdfDoc) return;
  n = Math.min(Math.max(1, n), pdfDoc.numPages);
  const el = document.getElementById('pdfpage-' + n);
  if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function setPdfZoom(z) {
  pdfZoom = Math.min(4, Math.max(0.3, z));
  state.settings.pdfZoom = pdfZoom;
  save();
  // keep current page in view across re-layout
  const b = state.books.find(x => x.id === pdfBookId);
  const cur = (b && b.pdfPage) || 1;
  buildPdfPages();
  updatePdfLabels();
  requestAnimationFrame(() => {
    const el = document.getElementById('pdfpage-' + cur);
    if (el) el.scrollIntoView({ block: 'start' });
  });
}

function closePdfDoc() {
  if (pdfObserver) { pdfObserver.disconnect(); pdfObserver = null; }
  if (pdfDoc) { try { pdfDoc.destroy(); } catch {} pdfDoc = null; }
  pdfBookId = null;
  const host = $('#pdfPages');
  if (host) host.innerHTML = '';
}

/* ---------- EPUB chapters + pagination + chapter drawer ---------- */
let epubState = null; // {book, chapters, toc, idx, page, pages}
let epubJumpPage = null; // 'last' — land on the final page of the chapter we just opened
let audioChapters = []; // [{title, start, end}] for the open audiobook
let audioChapterIdx = -1;

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(ss).padStart(2, '0');
}
// The phone always scrolls: paginated columns on a small screen are awkward,
// and scrolling past the end of a chapter moves on to the next one.
function epubMode() { return WEB ? 'scroll' : (state.settings.readMode === 'pages' ? 'pages' : 'scroll'); }
function currentBook() { return state.books.find(x => x.id === currentBookId) || null; }

function captureEpubProgress() {
  const st = epubState;
  if (!st || !st.book || currentBookId !== st.book.id) return;
  if (epubMode() === 'scroll') {
    const sc = $('#epubScroll');
    const max = sc.scrollHeight - sc.clientHeight;
    st.book.progress = max > 0 ? sc.scrollTop / max : 0;
  } else {
    st.book.progress = st.pages > 1 ? (st.page || 0) / (st.pages - 1) : 0;
  }
  save();
}

function renderEpubChapter(fragment) {
  const st = epubState;
  if (!st || !st.book || currentBookId !== st.book.id) return;
  const ch = st.chapters[st.idx];
  if (!ch) return;
  const mode = epubMode();
  $('#epubScroll').classList.toggle('hidden', mode !== 'scroll');
  $('#epubPaged').classList.toggle('hidden', mode !== 'pages');
  if (mode === 'scroll') {
    $('#epubContent').innerHTML = ch.html;
    applyReaderStyle();
    requestAnimationFrame(() => {
      if (!epubState || epubState.book.id !== st.book.id) return;
      const sc = $('#epubScroll');
      const max = sc.scrollHeight - sc.clientHeight;
      sc.scrollTop = (st.book.progress > 0 && st.book.progress < 1 && max > 0) ? st.book.progress * max : 0;
      if (fragment) jumpToFragment(fragment, false);
    });
  } else {
    const inner = $('#pagedInner');
    inner.style.transform = 'translateX(0)';
    inner.innerHTML = ch.html;
    inner.style.fontSize = state.settings.fontSize + 'px';
    inner.style.fontFamily = state.settings.fontFamily;
    inner.style.lineHeight = state.settings.lineHeight;
    paginateEpub();
    if (fragment) requestAnimationFrame(() => jumpToFragment(fragment, true));
  }
  updateChapterNav();
}

function paginateEpub() {
  const st = epubState;
  if (!st || !st.book || st.book.type !== 'epub' || currentBookId !== st.book.id) return;
  const wrap = $('#epubPaged'), inner = $('#pagedInner');
  if (!wrap || wrap.classList.contains('hidden')) return;
  const availW = Math.max(280, Math.min(700, wrap.clientWidth - 56));
  inner.style.columnWidth = availW + 'px';
  inner.style.maxWidth = availW + 'px';
  const unit = availW + 56;
  const pages = Math.max(1, Math.ceil((inner.scrollWidth + 1) / unit));
  // Position follows the saved within-chapter ratio, so font changes,
  // resizes and chapter opens all land in the right place.
  const r = Math.min(Math.max(0, st.book.progress || 0), 1);
  st.pages = pages;
  st.page = Math.min(Math.max(0, Math.round(r * (pages - 1))), pages - 1);
  if (epubJumpPage === 'last') { st.page = pages - 1; epubJumpPage = null; }
  inner.style.transform = `translateX(${-st.page * unit}px)`;
  st.book.progress = pages > 1 ? st.page / (pages - 1) : 0;
  save();
  updateChapterNav();
}

function gotoEpubPage(p) {
  const st = epubState;
  if (!st || !st.pages) return;
  st.page = Math.min(Math.max(0, p), st.pages - 1);
  const wrap = $('#epubPaged'), inner = $('#pagedInner');
  const availW = Math.max(280, Math.min(700, wrap.clientWidth - 56));
  inner.style.transform = `translateX(${-st.page * (availW + 56)}px)`;
  st.book.progress = st.pages > 1 ? st.page / (st.pages - 1) : 0;
  save();
  updateChapterNav();
}

function gotoEpubChapter(i, fragment, toEnd) {
  const st = epubState;
  if (!st) return;
  i = Math.min(Math.max(0, i), st.chapters.length - 1);
  st.idx = i;
  st.page = 0;
  st.book.epubChapter = i;
  st.book.progress = 0;
  epubJumpPage = toEnd ? 'last' : null;
  save();
  renderEpubChapter(fragment);
  if (toEnd && epubMode() === 'scroll') {
    requestAnimationFrame(() => { const sc = $('#epubScroll'); sc.scrollTop = sc.scrollHeight; });
  }
  buildTocDrawer();
}

function jumpToFragment(fragment, paged) {
  if (!fragment) return;
  try {
    const host = paged ? $('#pagedInner') : $('#epubContent');
    const el = host.querySelector('#' + CSS.escape(fragment));
    if (!el) return;
    if (!paged) {
      el.scrollIntoView({ block: 'start' });
    } else if (epubState) {
      const wrap = $('#epubPaged');
      const availW = Math.max(280, Math.min(700, wrap.clientWidth - 56));
      const p = Math.min(Math.max(0, Math.floor(el.offsetLeft / (availW + 56))), (epubState.pages || 1) - 1);
      gotoEpubPage(p);
    }
  } catch {}
}

function setViewMode(m) {
  if (WEB) return;                          // the phone reads in scroll mode only
  if (state.settings.readMode === m) return;
  captureEpubProgress();
  state.settings.readMode = m;
  save();
  renderEpubChapter();
}

/* ----- chapter drawer (EPUB TOC + audiobook chapters) ----- */
function openToc() { buildTocDrawer(); $('#tocDrawer').classList.remove('hidden'); }
function closeToc() { $('#tocDrawer').classList.add('hidden'); }
function buildTocDrawer() {
  const b = currentBook();
  const list = $('#tocList');
  if (!list) return;
  list.innerHTML = '';
  if (!b) return;
  if (b.type === 'epub' && epubState) {
    $('#tocTitle').textContent = 'Chapters';
    const items = epubState.toc.length
      ? epubState.toc
      : epubState.chapters.map((c, i) => ({ label: c.label || `Chapter ${i + 1}`, spine: i, fragment: '', level: 0 }));
    items.forEach(t => {
      const d = document.createElement('div');
      d.className = 'toc-item' + (t.spine === epubState.idx ? ' current' : '');
      d.style.paddingLeft = (10 + (t.level || 0) * 14) + 'px';
      d.textContent = t.label;
      d.onclick = () => { gotoEpubChapter(t.spine, t.fragment); closeToc(); };
      list.appendChild(d);
    });
  } else if (b.type === 'audio' && audioChapters.length) {
    $('#tocTitle').textContent = 'Audio chapters';
    const a = $('#audioEl');
    const cur = audioChapterIndex(a ? a.currentTime : 0);
    audioChapters.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'toc-item' + (i === cur ? ' current' : '');
      d.innerHTML = `<span>${escapeHtml(c.title || 'Chapter ' + (i + 1))}</span><span class="toc-time">${fmtTime(c.start)}</span>`;
      d.onclick = () => { seekAudio(c.start); closeToc(); };
      list.appendChild(d);
    });
  }
}

function updateChapterNav() {
  const b = currentBook();
  const nav = $('#chapterNav');
  if (!b || $('#readerView').classList.contains('hidden')) { if (nav) nav.classList.add('hidden'); return; }
  const isEpub = b.type === 'epub';
  const audioCh = b.type === 'audio' && audioChapters.length >= 1;
  if (!isEpub && !audioCh) { nav.classList.add('hidden'); return; }
  nav.classList.remove('hidden');
  $('#viewToggle').classList.toggle('hidden', !isEpub || WEB);   // the phone is scroll-only
  $('#pageGroup').classList.toggle('hidden', !(isEpub && epubMode() === 'pages'));
  $('#btnViewScroll').classList.toggle('active', epubMode() === 'scroll');
  $('#btnViewPages').classList.toggle('active', epubMode() === 'pages');
  if (isEpub && epubState) {
    const n = epubState.chapters.length;
    $('#chapterLabel').textContent = `${epubState.chapters[epubState.idx]?.label || 'Chapter'} · ${epubState.idx + 1}/${n}`;
    $('#pageLabel').textContent = `${(epubState.page || 0) + 1} / ${epubState.pages || 1}`;
  } else if (audioCh) {
    const a = $('#audioEl');
    const idx = audioChapterIndex(a && isFinite(a.currentTime) ? a.currentTime : 0);
    $('#chapterLabel').textContent = `${audioChapters[idx]?.title || 'Chapter'} · ${idx + 1}/${audioChapters.length}`;
  }
}

/* ----- audiobook chapters ----- */
function audioChapterIndex(t) {
  if (!audioChapters.length) return 0;
  let idx = 0;
  for (let i = 0; i < audioChapters.length; i++) {
    if ((t || 0) + 0.25 >= (audioChapters[i].start || 0)) idx = i;
    else break;
  }
  return idx;
}
function seekAudio(t) {
  const a = $('#audioEl');
  if (!a) return;
  try { a.currentTime = Math.max(0, t || 0); a.play().catch(() => {}); } catch {}
}
function gotoAudioChapter(i) {
  if (!audioChapters.length) return;
  i = Math.min(Math.max(0, i), audioChapters.length - 1);
  seekAudio(audioChapters[i].start || 0);
  updateChapterNav();
  buildTocDrawer();
}

// Read the chapters embedded in an audiobook file. A book that was latched
// "done" by an older build but never actually got chapters is retried — that
// stale flag is exactly why chapters could go missing.
async function loadAudioChapters(book, force = false) {
  if (!book || book.type !== 'audio' || !window.api?.getAudioMeta) return null;
  const have = Array.isArray(book.chapters) ? book.chapters.filter(c => c && isFinite(c.start)).length : 0;
  const tries = book.audioMetaTries || 0;
  if (!force && ((book.audioMetaDone && have) || tries >= 3)) return null;
  book.audioMetaTries = tries + 1;
  const meta = await window.api.getAudioMeta(book.storedPath).catch(() => null);
  if (!meta || meta.error) return null;
  const ch = Array.isArray(meta.chapters) ? meta.chapters.filter(c => c && isFinite(c.start)) : [];
  if (ch.length) {
    book.chapters = ch;
    book.audioMetaDone = true;
    book.audioMetaTries = 0;
    if (isFinite(meta.duration)) book.duration = meta.duration;
    save();
  }
  return meta;
}

// Background sweep: audiobooks with no chapters on record get one more attempt.
// Skipped for large files on purpose — reading a 1 GB audiobook's metadata can
// take tens of seconds, and 30 of them would freeze the app at launch. Their
// chapters are read when the book is opened instead, which is when you want
// them. The whole sweep is also capped by wall-clock time.
const SWEEP_MAX_BYTES = 250 * 1024 * 1024;
const SWEEP_BUDGET_MS = 20000;
async function refreshMissingChapters(limit = 15) {
  if (!window.api?.getAudioMeta) return 0;
  const todo = state.books.filter(b => b.type === 'audio' && b.storedPath
    && !(Array.isArray(b.chapters) && b.chapters.some(c => c && isFinite(c.start)))).slice(0, limit);
  const until = Date.now() + SWEEP_BUDGET_MS;
  let found = 0;
  for (const b of todo) {
    if (Date.now() > until) break;                      // time is up, next launch continues
    try {
      if (isFinite(b.fileSize) && b.fileSize > SWEEP_MAX_BYTES) { b.fileSize = b.fileSize; continue; }
      const meta = await loadAudioChapters(b);
      if (meta && Array.isArray(meta.chapters) && meta.chapters.length) {
        if (isFinite(meta.size)) b.fileSize = meta.size;
        found++; render();
      }
    } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  return found;
}

/* ---------- reader ---------- */
/* ---------- themes & settings ---------- */
/* Each theme is three colours the picker previews, and a matching data-theme
   name that the stylesheet turns into the full palette. The names and swatches
   live here so the picker and the CSS cannot drift apart. */
const THEMES = [
  { id: 'light', name: 'Light', sw: ['#ffffff', '#f7f7f7', '#1a1a1a'] },
  { id: 'paper', name: 'Paper', sw: ['#f6efe1', '#efe6d5', '#3b3226'] },
  { id: 'solar', name: 'Solar', sw: ['#fdf6e3', '#eee8d5', '#268bd2'] },
  { id: 'mono', name: 'Mono', sw: ['#f2f2f2', '#e9e9e9', '#1c1c1c'] },
  { id: 'midnight', name: 'Midnight', sw: ['#14161d', '#22242e', '#6d8cff'] },
  { id: 'dusk', name: 'Dusk', sw: ['#191526', '#262036', '#b388ff'] },
  { id: 'ocean', name: 'Ocean', sw: ['#07222b', '#0f303c', '#2dd4bf'] },
  { id: 'forest', name: 'Forest', sw: ['#101a13', '#1b2820', '#86c06a'] },
  { id: 'ink', name: 'Ink', sw: ['#000000', '#141418', '#ffd166'] }
];
const THEME_IDS = THEMES.map(t => t.id);

function applyTheme(name) {
  const id = THEME_IDS.includes(name) ? name : 'light';
  state.settings.theme = id;
  document.documentElement.setAttribute('data-theme', id);
  // Keep the phone's browser chrome in step with the page, so the address bar
  // does not stay bright white over a dark theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const probe = getComputedStyle(document.body);
    meta.setAttribute('content', probe.getPropertyValue('--bg').trim() || '#ffffff');
  }
}

function buildThemeGrid() {
  const grid = $('#themeGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const t of THEMES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card' + (state.settings.theme === t.id ? ' active' : '');
    card.title = t.name + ' theme';
    card.innerHTML =
      '<span class="theme-swatches">' +
        t.sw.map(c => `<i style="background:${c}"></i>`).join('') +
      '</span><span class="theme-name">' + escapeHtml(t.name) + '</span>';
    card.onclick = () => {
      applyTheme(t.id);
      save();
      buildThemeGrid();
    };
    grid.appendChild(card);
  }
}

function syncSettingsUI() {
  buildThemeGrid();
  const size = $('#setFontSize');
  if (size) size.textContent = state.settings.fontSize + 'px';
  const fam = $('#setFontFamily');
  if (fam) fam.value = state.settings.fontFamily;
  const lh = $('#setLineHeight');
  if (lh) lh.value = String(state.settings.lineHeight);
}

function openSettings() {
  applyTheme(state.settings.theme);
  syncSettingsUI();
  $('#settingsScrim').classList.remove('hidden');
  $('#settingsPanel').classList.remove('hidden');
}
function closeSettings() {
  $('#settingsScrim').classList.add('hidden');
  $('#settingsPanel').classList.add('hidden');
}
function settingsOpen() { return !$('#settingsPanel').classList.contains('hidden'); }

function applyReaderStyle() {
  applyTheme(state.settings.theme);
  const c = $('#epubContent');
  c.style.fontSize = state.settings.fontSize + 'px';
  c.style.fontFamily = state.settings.fontFamily;
  c.style.lineHeight = state.settings.lineHeight;
  $('#fontSizeLabel').textContent = state.settings.fontSize + 'px';
  $('#fontSizeLabel').title = `Text size (zoom ${Math.round(state.settings.fontSize / 18 * 100)}%) — A−/A+ or Ctrl + scroll`;
  $('#fontFamilySelect').value = state.settings.fontFamily;
  $('#lineHeightSelect').value = String(state.settings.lineHeight);
  const inner = $('#pagedInner');
  if (inner) {
    inner.style.fontSize = state.settings.fontSize + 'px';
    inner.style.fontFamily = state.settings.fontFamily;
    inner.style.lineHeight = state.settings.lineHeight;
  }
  if (epubState && epubMode() === 'pages' && currentBookId === epubState.book.id
      && !$('#epubPaged').classList.contains('hidden')) {
    paginateEpub();
  }
}
function changeFontSize(delta) {
  captureEpubProgress();
  state.settings.fontSize = Math.min(30, Math.max(12, state.settings.fontSize + delta));
  save(); applyReaderStyle();
}

async function openBook(book) {
  if (!book) return;
  // Already open (e.g. double-click after single-click opened it) — don't reload.
  if (currentBookId === book.id && !$('#readerView').classList.contains('hidden')) return;
  closePdfDoc();
  currentBookId = book.id;
  book.lastOpened = Date.now();
  save();
  $('#libraryView').classList.add('hidden');
  $('#readerView').classList.remove('hidden');
  $('#readerTitle').textContent = book.title;
  const chapCount = book.type === 'audio' && Array.isArray(book.chapters)
    ? book.chapters.filter(c => c && isFinite(c.start)).length : 0;
  $('#readerMeta').textContent = book.type === 'epub' ? `${book.author || 'EPUB'} · ${book.fileName}`
    : book.type === 'pdf' ? `${book.author ? book.author + ' · ' : ''}PDF · ${book.fileName}`
    : `Audiobook${chapCount ? ` · ${chapCount} chapter${chapCount === 1 ? '' : 's'}` : ''} · ${book.fileName}`;
  $('#epubFontControls').classList.toggle('hidden', book.type !== 'epub');
  $('#pdfControls').classList.toggle('hidden', book.type !== 'pdf');
  $('#epubScroll').classList.toggle('hidden', book.type !== 'epub');
  $('#pdfScroll').classList.toggle('hidden', book.type !== 'pdf');
  $('#audioWrap').classList.toggle('hidden', book.type !== 'audio');
  if (WEB) {
    // Remember the phone's clean-reading choice between books.
    $('#readerView').classList.toggle('immersive', !!state.settings.immersive);
    const cb = $('#btnClean');
    if (cb) cb.textContent = state.settings.immersive ? 'Show' : 'Clean';
  }

  if (book.type === 'epub') {
    $('#epubContent').innerHTML = '<p style="color:#999">Loading book…</p>';
    $('#pagedInner').innerHTML = '';
    $('#pagedInner').style.transform = 'translateX(0)';
    revokeEpubUrls();
    epubState = null;
    try {
      const { chapters, toc } = await loadEpubChapters(book.storedPath);
      if (currentBookId !== book.id) return;
      if (!chapters.length) throw new Error('No readable chapters found');
      const idx = Math.min(Math.max(0, book.epubChapter || 0), chapters.length - 1);
      book.epubChapter = idx;
      epubState = { book, chapters, toc: toc || [], idx, page: 0, pages: 1 };
      closeToc();
      buildTocDrawer();
      renderEpubChapter();
    } catch (e) {
      console.error(e);
      $('#epubContent').innerHTML = `<p style="color:#b00"><b>Could not open this EPUB.</b><br>${escapeHtml(e.message)}<br><span style="color:#999">The file may be DRM-protected or corrupted.</span></p>`;
    }
  } else if (book.type === 'pdf') {
    if (!window.pdfjsLib) {
      $('#pdfPages').innerHTML = '<p style="color:#b00"><b>PDF engine failed to load.</b><br>Please reinstall the app.</p>';
    } else {
      try {
        await openPdfBook(book);
      } catch (e) {
        console.error(e);
        $('#pdfPages').innerHTML = `<p style="color:#b00"><b>Could not open this PDF.</b><br>${escapeHtml(e.message)}</p>`;
      }
    }
  } else {
    const audio = $('#audioEl');
    audio.pause();
    audioChapters = Array.isArray(book.chapters) ? book.chapters.filter(c => c && isFinite(c.start)) : [];
    audioChapterIdx = -1;
    audio.src = window.api.fileUrl(book.storedPath);
    $('#audioTitle').textContent = book.title;
    $('#audioFile').textContent = book.fileName;
    const acov = coverSrc(book);
    $('#audioCover').innerHTML = acov ? `<img src="${acov}" alt="" onerror="this.remove()" onload="markCover(this)"/>` : '';
    audio.playbackRate = parseFloat($('#audioSpeed').value || '1');
    audio.onloadedmetadata = () => {
      if (book.progressSeconds && book.progressSeconds < (audio.duration || 1e9) - 5) {
        audio.currentTime = book.progressSeconds;
      }
    };
    audio.ontimeupdate = () => {
      if (audio.duration) {
        book.progress = audio.currentTime / audio.duration;
        book.progressSeconds = audio.currentTime;
        clearTimeout(audio._sv);
        audio._sv = setTimeout(save, 800);
        if (audioChapters.length > 1) {
          const idx = audioChapterIndex(audio.currentTime);
          if (idx !== audioChapterIdx) {
            audioChapterIdx = idx;
            updateChapterNav();
            if (!$('#tocDrawer').classList.contains('hidden')) buildTocDrawer();
          }
        }
      }
    };
    audio.onended = () => { book.progress = 1; save(); render(); };
    updateChapterNav();
    buildTocDrawer();
    // Embedded chapters arrive in the background if we don't have them yet.
    loadAudioChapters(book).then(meta => {
      if (!meta || currentBookId !== book.id) return;
      audioChapters = Array.isArray(book.chapters) ? book.chapters.filter(c => c && isFinite(c.start)) : [];
      updateChapterNav();
      buildTocDrawer();
      if (audioChapters.length) toast(`${audioChapters.length} chapters found`);
    }).catch(() => {});
  }
}

function closeReader() {
  // persist epub position (chapter + within-chapter progress)
  const b = state.books.find(x => x.id === currentBookId);
  if (b && b.type === 'epub' && epubState && epubState.book.id === b.id) {
    captureEpubProgress();
    b.epubChapter = epubState.idx;
    save();
  }
  epubState = null;
  audioChapters = [];
  audioChapterIdx = -1;
  if (b && b.type === 'pdf' && pdfBookId === b.id) {
    // progress already tracked per page; just persist
    save();
  }
  const audio = $('#audioEl');
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
  closePdfDoc();
  currentBookId = null;
  revokeEpubUrls();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#readerView').classList.add('hidden');
  $('#libraryView').classList.remove('hidden');
  render();
}

/* ---------- clean reading: hide every control, tap to bring them back ---------- */
let immersiveHintT = null;
function showImmersiveHint() {
  let h = $('.immersive-hint');
  if (!h) {
    h = document.createElement('div');
    h.className = 'immersive-hint';
    document.body.appendChild(h);
  }
  h.textContent = 'Tap the page to show the controls';
  h.classList.add('show');
  clearTimeout(immersiveHintT);
  immersiveHintT = setTimeout(() => h.classList.remove('show'), 2600);
}
function setImmersive(on) {
  const rv = $('#readerView');
  if (!rv) return;
  rv.classList.toggle('immersive', on);
  const b = $('#btnClean');
  if (b) { b.classList.toggle('active', on); b.textContent = on ? 'Show' : 'Clean'; }
  if (on) {
    // Best effort: on a phone this also drops the browser's own bars.
    try {
      const p = rv.requestFullscreen ? rv.requestFullscreen({ navigationUI: 'hide' }) : null;
      if (p && p.catch) p.catch(() => {});
    } catch {}
    if (!WEB) showImmersiveHint();
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  if (WEB) state.settings.immersive = !!on;
  if (WEB) save();
}
function toggleImmersive() { setImmersive(!$('#readerView').classList.contains('immersive')); }
$('#btnClean').onclick = toggleImmersive;

// Tap anywhere in the text/player area toggles the controls in clean mode.
// Ignored while a real drag or a scroll gesture is happening.
let immersiveTapT = 0;
document.addEventListener('pointerdown', (e) => {
  const rv = $('#readerView');
  if (!rv || !rv.classList.contains('immersive')) return;
  if (e.target.closest('button, select, input, a, .node-book, .flow-remove')) return;
  const y = e.clientY;
  const start = performance.now();
  const onUp = (ev) => {
    document.removeEventListener('pointerup', onUp, true);
    if (Math.abs(ev.clientY - y) > 12 || performance.now() - start > 600) return; // it was a scroll
    setImmersive(false);
  };
  document.addEventListener('pointerup', onUp, true);
}, true);
document.addEventListener('fullscreenchange', () => {
  // Leaving fullscreen some other way (Esc on desktop) keeps the page in step.
  const rv = $('#readerView');
  if (rv && !document.fullscreenElement && rv.classList.contains('immersive') && WEB) {
    setImmersive(false);
  }
});

/* ---------- fullscreen reader ---------- */
function toggleFullscreen() {
  if (!$('#readerView') || $('#readerView').classList.contains('hidden')) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  const el = $('#readerView');
  try {
    const p = el.requestFullscreen ? el.requestFullscreen() : document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(() => {});
  } catch {}
}
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  const b = $('#btnFullscreen');
  if (b) {
    b.textContent = on ? 'Exit' : 'Full';
    b.classList.toggle('active', on);
    b.title = on ? 'Exit fullscreen (Esc)' : 'Fullscreen (F11)';
  }
});

/* ---------- "next/previous", rolling over into the next chapter ---------- */
// Audio: skip 30s forward, but never past the end of the current chapter —
// past it means "start the next chapter". Back: 15s, or the previous chapter
// when we are already at the start of this one.
function audioStep(dir) {
  const a = $('#audioEl');
  if (!a) return false;
  if (!audioChapters.length) {
    a.currentTime = Math.max(0, Math.min(a.duration || 1e9, a.currentTime + (dir > 0 ? 30 : -15)));
    return true;
  }
  const i = audioChapterIndex(a.currentTime);
  const cur = audioChapters[i] || {};
  if (dir > 0) {
    const end = isFinite(cur.end) ? cur.end : (audioChapters[i + 1] ? audioChapters[i + 1].start : a.duration);
    if (i < audioChapters.length - 1 && a.currentTime + 30 >= end - 0.5) { gotoAudioChapter(i + 1); return true; }
    a.currentTime = Math.min(a.duration || 1e9, a.currentTime + 30);
    return true;
  }
  if (a.currentTime - (cur.start || 0) > 3) { seekAudio(cur.start || 0); return true; }
  if (i > 0) { gotoAudioChapter(i - 1); return true; }
  a.currentTime = Math.max(0, a.currentTime - 15);
  return true;
}
// EPUB: turn the page; on the last page of a chapter open the next chapter's
// first page (and symmetrically back to the previous chapter's last page).
function epubStep(dir) {
  if (!epubState) return false;
  const last = epubState.pages - 1;
  if (epubMode() === 'pages') {
    if (dir > 0) {
      if (epubState.page < last) { gotoEpubPage(epubState.page + 1); return true; }
      if (epubState.idx < epubState.chapters.length - 1) { gotoEpubChapter(epubState.idx + 1); return true; }
      return false;
    }
    if (epubState.page > 0) { gotoEpubPage(epubState.page - 1); return true; }
    if (epubState.idx > 0) { gotoEpubChapter(epubState.idx - 1, '', true); return true; }
    return false;
  }
  // scroll mode: only step when the chapter is already at its very edge
  const sc = $('#epubScroll');
  const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
  const atTop = sc.scrollTop <= 4;
  if (dir > 0 && atEnd && epubState.idx < epubState.chapters.length - 1) { gotoEpubChapter(epubState.idx + 1); return true; }
  if (dir < 0 && atTop && epubState.idx > 0) { gotoEpubChapter(epubState.idx - 1, '', true); return true; }
  return false;
}
// One entry point for arrow keys / page buttons / the audio skip buttons.
function readerStep(dir) {
  const b = currentBook();
  if (!b) return false;
  if (b.type === 'audio') return audioStep(dir);
  if (b.type === 'epub') return epubStep(dir);
  if (b.type === 'pdf') {
    const pb = state.books.find(x => x.id === pdfBookId);
    gotoPdfPage(((pb && pb.pdfPage) || 1) + dir);
    return true;
  }
  return false;
}

/* ---------- rendering ---------- */
function filteredBooks() {
  const q = state.search.trim().toLowerCase();
  let list = booksInFolder(state.currentFolderId);
  if (q) list = list.filter(b => (b.title + ' ' + (b.author || '') + ' ' + b.fileName).toLowerCase().includes(q));
  return list.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0) || b.addedAt - a.addedAt);
}

// Covers that extraction got wrong (or never found) can be replaced by hand.
// Works on the laptop and on the phone — a cover set on the phone is written
// back to the laptop and shows up in the desktop app too.
function pickCoverFor(book) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('Could not read that image'));
        fr.readAsDataURL(file);
      });
      const small = await downscaleCover(dataUrl).catch(() => '');
      if (await storeBookCover(book, small || dataUrl)) {
        toast('Cover updated');
        render();
      } else {
        toast('Could not save that cover');
      }
    } catch (e) {
      toast(e.message || 'Could not read that image');
    }
  };
  input.click();
}
async function removeCoverFor(book) {
  if (book.coverPath) { try { await window.api.deleteFile(book.coverPath); } catch {} }
  if (WEB) { try { await window.api.removeCover(book.id); } catch {} }
  book.coverPath = null;
  book.cover = '';
  save();
  toast('Cover removed');
  render();
}

function folderMenuItems(f) {
  if (WEB) return [{ label: 'Manage in the desktop app', action: desktopOnly }];
  return [
    { label: 'Open folder', action: () => { state.currentFolderId = f.id; render(); $('#libraryView').scrollTop = 0; } },
    { label: 'Rename', action: () => renameFolder(f) },
    { label: 'Change color', action: () => recolorFolder(f) },
    { sep: true },
    { label: 'Delete folder', danger: true, action: () => deleteFolder(f) },
  ];
}
function bookMenuItems(b) {
  if (WEB) return [{ label: 'Open', action: () => openBook(b) }, { label: 'Manage in the desktop app', action: desktopOnly }];
  return [
    // The one icon the app keeps: the book you right-clicked.
    { icon: '📖', label: kindVerb(b.type), action: () => openBook(b) },
    ...(b.folderId ? [{ label: 'Remove from folder', action: () => moveBookTo(b, null) }] : []),
    { header: 'Move to folder' },
    { label: 'Unsorted', action: () => moveBookTo(b, null) },
    ...state.folders.map(f => ({ label: f.name.slice(0, 32), action: () => moveBookTo(b, f.id) })),
    { sep: true },
    { label: 'Rename', action: () => renameBook(b) },
    { label: b.coverPath ? 'Change cover…' : 'Set cover…', action: () => pickCoverFor(b) },
    ...(b.coverPath ? [{ label: 'Remove cover', action: () => removeCoverFor(b) }] : []),
    ...(b.type === 'audio' ? [{ label: 'Reload chapters', action: async () => {
        toast('Reading chapters…');
        const meta = await loadAudioChapters(b, true);
        const n = (meta && meta.chapters && meta.chapters.length) || 0;
        toast(n ? `${n} chapter${n === 1 ? '' : 's'} found` : 'No chapters in this file');
        if (currentBookId === b.id) {
          audioChapters = Array.isArray(b.chapters) ? b.chapters.filter(c => c && isFinite(c.start)) : [];
          updateChapterNav();
          buildTocDrawer();
        }
        render();
      } }] : []),
    { label: 'Delete', danger: true, action: () => deleteBook(b) },
  ];
}
// Folder tile: color bar + name + count (no icon, no dot).
function folderTile(f) {
  const n = booksInFolder(f.id).length;
  const el = document.createElement('div');
  el.className = 'folder-card';
  el.dataset.folderId = f.id;
  el.innerHTML = `<div class="folder-bar" style="background:${escapeHtml(f.color || '#eee')}"></div>
    <div class="folder-name">${escapeHtml(f.name)}</div>
    <div class="folder-count">${n} book${n === 1 ? '' : 's'}</div>`;
  el.onclick = () => { resetChartUi(); state.currentFolderId = f.id; render(); $('#libraryView').scrollTop = 0; };
  el.ondblclick = () => { resetChartUi(); state.currentFolderId = f.id; render(); };
  el.oncontextmenu = (e) => {
    e.preventDefault(); e.stopPropagation();
    showMenu(e.clientX, e.clientY, folderMenuItems(f));
  };
  return el;
}
// Book tile: compact, folder-like — one book per tile, draggable.
function bookTile(b) {
  const el = document.createElement('div');
  el.className = 'book-tile';
  el.dataset.bookId = b.id;
  const cov = coverSrc(b);
  el.innerHTML = `
    ${cov ? `<img class="shelf-thumb" src="${cov}" alt="" onerror="this.remove()"/>` : `<div class="shelf-thumb"></div>`}
    <div class="shelf-meta">
      <div class="shelf-title">${escapeHtml(b.title)}</div>
      <div class="shelf-sub">${escapeHtml([b.author, kindLabel(b.type), chapterCount(b) ? chapterCount(b) + ' chapters' : ''].filter(Boolean).join(' · '))}</div>
    </div>`;
  el.onpointerdown = (e) => beginBookPointer(e, b);
  el.oncontextmenu = (e) => {
    e.preventDefault(); e.stopPropagation();
    showMenu(e.clientX, e.clientY, bookMenuItems(b));
  };
  return el;
}

function render() {
  // breadcrumb
  const bc = $('#breadcrumb');
  const cur = state.currentFolderId ? folderById(state.currentFolderId) : null;
  if (!cur) bc.innerHTML = `<b>Library</b> · ${state.books.length} book(s)`;
  else bc.innerHTML = `<span class="crumb" id="crumbHome" title="Back to library — or drop a book here to take it out of this folder">‹ Library</span> &nbsp;/&nbsp; <b>${escapeHtml(cur.name)}</b> · ${booksInFolder(cur.id).length}`;
  const ch = $('#crumbHome');
  if (ch) {
    ch.onclick = () => { resetChartUi(); state.currentFolderId = null; save(); render(); };
  }

  // Shared tile + menu builders (shelf and folder view alike).
  // books
  const list = filteredBooks();
  if (!cur) {
    // Unified shelf: folders and loose books as one tile grid.
    $('#shelfSection').style.display = '';
    $('#booksSection').style.display = 'none';
    const q = state.search.trim().toLowerCase();
    $('#shelfTitle').textContent = q ? 'Folders & Books · results' : 'Folders & Books';
    const shelf = $('#shelfGrid');
    shelf.innerHTML = '';
    $('#emptyState').style.display = (state.books.length === 0 && state.folders.length === 0 && !q) ? '' : 'none';
    const folders = [...state.folders].sort((a, b) => a.name.localeCompare(b.name))
      .filter(f => !q || f.name.toLowerCase().includes(q));
    folders.forEach(f => shelf.appendChild(folderTile(f)));
    let loose = q
      ? state.books.filter(b => (b.title + ' ' + (b.author || '') + ' ' + b.fileName).toLowerCase().includes(q))
      : state.books.filter(b => !b.folderId);
    loose.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0) || b.addedAt - a.addedAt);
    loose.forEach(b => shelf.appendChild(bookTile(b)));
    if ((q && !folders.length && !loose.length)) {
      shelf.innerHTML = `<div style="color:#bbb;font-size:13px;padding:6px 2px;">No matches.</div>`;
    }
  } else {
    $('#shelfSection').style.display = 'none';
    $('#booksSection').style.display = '';
    $('#booksTitle').textContent = `Books in “${cur.name}”`;
    const grid = $('#booksGrid');
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = `<div style="color:#bbb;font-size:13.5px;padding:18px 4px;">This folder is empty — drag books here or right-click → Import.</div>`;
    }
    list.forEach(b => {
    const el = document.createElement('div');
    el.className = 'book-card';
    el.dataset.bookId = b.id;
    const pct = b.type === 'audio' && b.progressSeconds ? Math.round((b.progress || 0) * 100) : Math.round((b.progress || 0) * 100);
    const cov = coverSrc(b);
    el.innerHTML = `
      <div class="book-cover ${b.type === 'audio' ? 'audio' : ''}">
        ${cov ? `<img src="${cov}" alt="" onerror="this.remove()" onload="markCover(this)"/>` : ''}
        <span class="type-badge">${kindLabel(b.type)}</span>
      </div>
      <div class="book-meta">
        <div class="book-title">${escapeHtml(b.title)}</div>
        <div class="book-sub">${escapeHtml(b.author || b.fileName)}${chapterCount(b) ? ` · ${chapterCount(b)} chapters` : ''}</div>
        ${pct > 2 && pct < 99 ? `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
      </div>`;
    el.onpointerdown = (e) => beginBookPointer(e, b);
    el.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      showMenu(e.clientX, e.clientY, bookMenuItems(b));
    };
    grid.appendChild(el);
    });
  }

  renderFlowchart();
  applyReaderStyle();
}

/* ---------- file import via drag & drop (real files from outside) ---------- */
// In-app moves use pointer dragging (no native DnD), so this overlay can only
// ever appear for actual files dragged in from Explorer.
window.addEventListener('dragenter', (e) => {
  if ([... (e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#dropOverlay').classList.remove('hidden'); }
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropOverlay').classList.add('hidden');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.add('hidden');
  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;
  const paths = files.map(f => (window.api?.getPathForFile ? window.api.getPathForFile(f) : f.path)).filter(Boolean);
  // If paths unavailable (browser mode), notify
  if (!paths.length) { toast('Could not read dropped files in this mode'); return; }
  // If dropped onto a folder card, file it directly
  const folderEl = e.target.closest?.('[data-folder-id]');
  const target = folderEl?.dataset.folderId || state.currentFolderId || null;
  importPaths(paths, target);
});

// right-click empty canvas
$('#libraryView').addEventListener('contextmenu', (e) => {
  if (suppressCtxMenu) { suppressCtxMenu = false; e.preventDefault(); return; }
  if (e.target.closest('.book-card') || e.target.closest('.book-tile') || e.target.closest('.folder-card')) return; // handled above
  if (chartSelection.length && e.target.closest('#flowChart')) {
    e.preventDefault();
    showSelectionMenu(e.clientX, e.clientY);
    return;
  }
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    { label: 'New folder', action: createFolder },
    { label: 'Import books…', action: pickAndImport },
    ...(state.currentFolderId ? [{ label: 'Back to library', action: () => { state.currentFolderId = null; render(); } }] : []),
  ]);
});

/* ---------- wiring ---------- */
$('#btnEmptyAdd').onclick = pickAndImport;
$('#btnEmptyFolder').onclick = createFolder;
// The top bar is just the search field, so Home lives on the breadcrumb
// ("‹ Library") and the reader's "← Library" button.
$('#btnBack').onclick = closeReader;
$('#btnFullscreen').onclick = toggleFullscreen;
$('#searchInput').oninput = (e) => { state.search = e.target.value; render(); };

$('#btnFontDec').onclick = () => changeFontSize(-1);
$('#btnFontInc').onclick = () => changeFontSize(1);
$('#fontFamilySelect').onchange = (e) => { captureEpubProgress(); state.settings.fontFamily = e.target.value; save(); applyReaderStyle(); syncSettingsUI(); };
$('#lineHeightSelect').onchange = (e) => { captureEpubProgress(); state.settings.lineHeight = e.target.value; save(); applyReaderStyle(); syncSettingsUI(); };

/* Settings panel - the same markup and code in the app and in the browser. */
$('#btnSettings').onclick = () => { settingsOpen() ? closeSettings() : openSettings(); };
$('#btnSettingsClose').onclick = closeSettings;
$('#settingsScrim').onclick = closeSettings;
$('#setFontDown').onclick = () => { changeFontSize(-1); syncSettingsUI(); };
$('#setFontUp').onclick = () => { changeFontSize(1); syncSettingsUI(); };
$('#setFontFamily').onchange = (e) => { captureEpubProgress(); state.settings.fontFamily = e.target.value; save(); applyReaderStyle(); };
$('#setLineHeight').onchange = (e) => { captureEpubProgress(); state.settings.lineHeight = e.target.value; save(); applyReaderStyle(); };
$('#setResetTheme').onclick = () => { applyTheme('light'); save(); syncSettingsUI(); toast('Appearance reset'); };
// Clicking the page behind the panel is not how you dismiss it, but on the
// phone there is no other way to reach the library without the X.
$('#settingsPanel').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'BUTTON') e.target.click(); });

$('#btnToc').onclick = () => { $('#tocDrawer').classList.contains('hidden') ? openToc() : closeToc(); };
$('#btnTocClose').onclick = closeToc;
$('#btnChapterPrev').onclick = () => {
  const b = currentBook();
  if (!b) return;
  if (b.type === 'epub' && epubState) gotoEpubChapter(epubState.idx - 1);
  else if (b.type === 'audio' && audioChapters.length > 1) {
    const a = $('#audioEl');
    const i = audioChapterIndex(a.currentTime);
    if (a.currentTime - (audioChapters[i]?.start || 0) > 3) seekAudio(audioChapters[i].start);
    else gotoAudioChapter(i - 1);
  }
};
$('#btnChapterNext').onclick = () => {
  const b = currentBook();
  if (!b) return;
  if (b.type === 'epub' && epubState) gotoEpubChapter(epubState.idx + 1);
  else if (b.type === 'audio' && audioChapters.length > 1) gotoAudioChapter(audioChapterIndex($('#audioEl').currentTime) + 1);
};
$('#btnViewScroll').onclick = () => setViewMode('scroll');
$('#btnViewPages').onclick = () => setViewMode('pages');
$('#btnPagePrev').onclick = () => { if (epubState) readerStep(-1); };
$('#btnPageNext').onclick = () => { if (epubState) readerStep(1); };

$('#btnPdfPrev').onclick = () => { const b = state.books.find(x => x.id === pdfBookId); gotoPdfPage(((b && b.pdfPage) || 1) - 1); };
$('#btnPdfNext').onclick = () => { const b = state.books.find(x => x.id === pdfBookId); gotoPdfPage(((b && b.pdfPage) || 1) + 1); };
$('#btnPdfZoomIn').onclick = () => setPdfZoom(pdfZoom * 1.2);
$('#btnPdfZoomOut').onclick = () => setPdfZoom(pdfZoom / 1.2);
$('#btnPdfFit').onclick = () => setPdfZoom(fitPdfZoom());

// Ctrl + scroll = font size (scrolling font change), plain scroll = read
$('#epubScroll').addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    changeFontSize(e.deltaY < 0 ? 1 : -1);
  }
}, { passive: false });

// persist epub progress
$('#epubScroll').addEventListener('scroll', () => {
  const sc = $('#epubScroll');
  clearTimeout(saveScrollT);
  saveScrollT = setTimeout(() => {
    const b = state.books.find(x => x.id === currentBookId);
    if (!b || b.type !== 'epub') return;
    const max = sc.scrollHeight - sc.clientHeight;
    b.progress = max > 0 ? sc.scrollTop / max : 0;
    save();
  }, 400);
}, { passive: true });

// On the phone, keep scrolling at the end of a chapter and it turns the page —
// same at the top going back. Driven by the gesture, not by reaching the end,
// so the last line of a chapter is never skipped.
let edgeBase = null;
function epubAtEnd() {
  const sc = $('#epubScroll');
  const max = sc.scrollHeight - sc.clientHeight;
  return max <= 2 || sc.scrollTop >= max - 2;
}
function epubAtTop() {
  const sc = $('#epubScroll');
  return sc.scrollTop <= 2;
}
function epubRoll(dir) {
  if (!WEB || !epubState || currentBookId !== epubState.book.id) return false;
  if (dir > 0) {
    if (!epubAtEnd() || epubState.idx >= epubState.chapters.length - 1) return false;
    gotoEpubChapter(epubState.idx + 1);
    return true;
  }
  if (!epubAtTop() || epubState.idx <= 0) return false;
  gotoEpubChapter(epubState.idx - 1, '', true);
  return true;
}
$('#epubScroll').addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) return;                 // Ctrl+wheel is still font size
  if (e.deltaY > 0 && epubRoll(1)) { e.preventDefault(); edgeBase = null; }
  else if (e.deltaY < 0 && epubRoll(-1)) { e.preventDefault(); edgeBase = null; }
}, { passive: false });
$('#epubScroll').addEventListener('touchstart', (e) => { edgeBase = e.touches[0].clientY; }, { passive: true });
$('#epubScroll').addEventListener('touchmove', (e) => {
  if (edgeBase === null || !e.touches.length) return;
  const dy = edgeBase - e.touches[0].clientY;        // finger up = scroll down
  if (Math.abs(dy) < 42) return;
  const dir = dy > 0 ? 1 : -1;
  if (epubRoll(dir)) { e.preventDefault(); edgeBase = e.touches[0].clientY; }
}, { passive: false });

$('#btnBack15').onclick = () => { readerStep(-1); };
$('#btnFwd30').onclick = () => { readerStep(1); };
$('#audioSpeed').onchange = (e) => { $('#audioEl').playbackRate = parseFloat(e.target.value); };

document.addEventListener('keydown', (e) => {
  if (e.key === 'F11') {
    if (!$('#readerView').classList.contains('hidden')) { e.preventDefault(); toggleFullscreen(); }
    return;
  }
  // F for full screen, C for clean reading. Only as bare keys: Ctrl+F is the
  // browser's find, and a modifier means the user meant something else.
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !$('#readerView').classList.contains('hidden')) {
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
    if (!typing && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleFullscreen(); return; }
    if (!typing && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); toggleImmersive(); return; }
  }
  if (e.key === 'Escape') {
    if (document.fullscreenElement) return; // let the browser exit fullscreen first
    if (settingsOpen()) closeSettings();
    else if (!$('#modalOverlay').classList.contains('hidden')) closeModal(null);
    else if (!$('#contextMenu').classList.contains('hidden')) hideMenu();
    else if (pendingLink) { pendingLink = null; refreshLinkHL(); }
    else if (chartSelection.length) { clearSelection(); }
    else if (!$('#tocDrawer').classList.contains('hidden')) closeToc();
    else if (!$('#readerView').classList.contains('hidden')) closeReader();
  }
  // Ctrl + +/- font size in reader
  if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=' || e.key === '-')) {
    if (!$('#readerView').classList.contains('hidden')) {
      e.preventDefault();
      changeFontSize(e.key === '-' ? -1 : 1);
    }
    return;
  }
  // Reader arrows / space / page keys: page within the chapter, and over the
  // chapter edge into the next/previous one. Audio: skip, then next chapter.
  const typing = e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (!typing && !$('#readerView').classList.contains('hidden') && currentBookId) {
    const b = state.books.find(x => x.id === currentBookId);
    if (b && b.type === 'audio') {
      if (e.key === 'ArrowRight') { e.preventDefault(); readerStep(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); readerStep(-1); }
    } else if (b && b.type === 'epub' && epubState) {
      if (epubMode() === 'pages') {
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); readerStep(1); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); readerStep(-1); }
      } else {
        // scroll mode: only take over the arrows at the very edge of a chapter
        if (e.key === 'ArrowRight' || e.key === 'PageDown') { if (readerStep(1)) e.preventDefault(); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { if (readerStep(-1)) e.preventDefault(); }
      }
    } else if (b && b.type === 'pdf') {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); readerStep(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); readerStep(-1); }
    }
  }
});

/* ---------- boot ---------- */
load();
// Apply the saved theme before the first paint, so a dark theme never flashes
// white on the way in.
applyTheme(state.settings.theme);
function startApp() {
  if (!state.settings) state.settings = { fontSize: 18, fontFamily: "Georgia, 'Times Roman', serif", lineHeight: '1.7', theme: 'light' };
  if (!state.settings.theme) state.settings.theme = 'light';
  if (typeof state.settings.pdfZoom !== 'number') state.settings.pdfZoom = 1;
  pdfZoom = state.settings.pdfZoom;
  if (!state.settings.readMode) state.settings.readMode = 'scroll'; // 'scroll' | 'pages' (epub)
  render();
  applyReaderStyle();
  syncSettingsUI();
  pdfReady().catch(() => {});
  if (WEB) return;   // the laptop owns the library: no migrations, no adoption
  // Covers now live as files: migrate once, then auto-adopt anything new.
  (async () => {
    try { await migrateCoversToFiles(); } catch (e) { console.warn('cover migration', e); }
    try { await repairSmallCovers(); } catch (e) { console.warn('cover repair', e); }
    // Audiobooks imported before chapters were read (or read too early) get
    // another go in the background.
    refreshMissingChapters().then(n => { if (n) { render(); toast(`Found chapters in ${n} audiobook${n === 1 ? '' : 's'}`); } }).catch(() => {});
    // Auto-adopt files already sitting in the app library folder
    // (e.g. copied there from Thorium Reader) that aren't tracked yet.
    adoptLibraryFiles();
  })();
}
if (WEB) {
  // Signing in happens after the page booted, so pull the library again then.
  window.addEventListener('sb-signed-in', () => {
    hydrateFromServer().then(() => { render(); }).catch(() => {});
  });
  hydrateFromServer().then(() => startApp())
    .catch(e => { if (window.api.isSignedIn && window.api.isSignedIn()) console.warn('library load failed', e); startApp(); });
} else {
  startApp();
}

async function adoptLibraryFiles() {
  try {
    if (!window.api?.listLibraryFiles) return;
    const files = await window.api.listLibraryFiles();
    if (!files || !files.length) return;
    const known = new Set(state.books.map(b => String(b.storedPath || '').toLowerCase()));
    const fresh = files.filter(f => f.storedPath && !known.has(String(f.storedPath).toLowerCase()) && typeOf(f.fileName));
    // Phase 1: register everything instantly (filename as title) so the
    // shelf fills in immediately, even for huge books.
    const added = [];
    if (fresh.length) {
      for (const f of fresh) {
        const t = typeOf(f.fileName);
        const book = {
          id: uid(), title: f.fileName.replace(/\.[^.]+$/, ''), author: '',
          type: t, fileName: f.fileName, storedPath: f.storedPath,
          folderId: null, addedAt: Date.now(), cover: '', progress: 0
        };
        state.books.unshift(book);
        added.push(book);
        known.add(String(f.storedPath).toLowerCase());
      }
      save(); render();
      toast(`Added ${added.length} book(s) — fetching details…`);
    }
    // Phase 2: enrich with real title/author/cover (+audio chapters) one by
    // one in the background, saving incrementally.
    // Includes previously-tracked books still missing a cover or audio
    // metadata — not just newly added ones.
    const enrich = [...added];
    for (const b of state.books) {
      if (added.includes(b)) continue;
      if ((b.type === 'epub' || b.type === 'pdf') && !b.coverPath && !(b.cover && String(b.cover).startsWith('data:'))) enrich.push(b);
      else if (b.type === 'audio' && !b.audioMetaDone) enrich.push(b);
    }
    if (!enrich.length) return;
    for (const book of enrich) {
      try { await enrichBook(book); } catch (e) { console.warn('adopt enrich failed', book.fileName, e); }
    }
  } catch (e) { console.warn('adopt failed', e); }
}
