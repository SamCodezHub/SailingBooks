# Sailing Books ⛵

Minimal white desktop app for EPUB, PDF + audiobook reading.

## Features
- Drag & drop `.epub`, `.pdf`, `.mp3`, `.m4a`, `.m4b`, `.wav`, `.ogg`, `.opus`, `.flac`, `.aac`
- EPUB reader: scrolling view, font size (A−/A+, Ctrl+scroll, Ctrl++/−), font type, line spacing, progress saved
- Paginated EPUB view: Scroll/Pages toggle, one page at a time (←/→, space, PgUp/PgDn), zoom reflows pages
- Chapters: EPUB TOC drawer with one chapter open at a time (‹ › nav); audiobooks with embedded chapters get a seekable chapter list + prev/next + current highlight
- Covers stored as files (never lost to storage limits); audiobook covers extracted from files
- PDF reader (fully offline): scrolling pages, zoom (+/−/Fit), page navigation, progress saved, first-page covers
- Audiobook player: play/pause, seek, −15s/+30s, speed, position saved
- Fullscreen reading: ⛶ Full button in the reader or F11 (Esc exits)
- Reading flowchart per folder: books on top, free node chart below — drag a book in to make a node, drag nodes to arrange, scroll to zoom (positions stay), drag empty space to pan, click one then another to connect (many-to-many), right-drag over nodes to group a named + colored section, double-click renames, right-click links books / deletes
- Empty-canvas library: one unified "Folders & Books" shelf — folders (color bar, no clutter) and single-book tiles side by side, all draggable
- Folders: rename, color-code, delete (books move to Unsorted)
- Double-click a book → read / listen view
- Right-click book / folder / empty space → Rename, Move, Color, Delete
- White minimalistic UI

## Run (dev)
```powershell
cd sailing-books
npm install
npm start
```

## Build the .exe
```powershell
cd sailing-books
npm install
npm run dist
```
Output: `sailing-books\dist\Sailing-Books-Setup-1.0.0.exe`
Install it, launch **Sailing Books** from Start Menu / Desktop shortcut.
Your library files are copied to `%APPDATA%\Sailing Books\Library`.

## Notes
- EPUB parsing is fully offline (JSZip, no server).
- DRM-protected EPUBs cannot be opened.
- Covers are extracted from the EPUB when available.
