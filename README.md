# Sailing Books ⛵

Local-first library and reader for EPUBs, PDFs and audiobooks, with a matching browser companion.

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
- Shared desktop and web interface with a modern library and reader, responsive motion, and nine complete visual identities: Light, Paper, Solar, Mono, Midnight, Dusk, Ocean, Forest and Ink. Themes use their own type, borders, shadows and textures and are remembered per device.
- Settings panel (the gear in the top bar, in the app and on the phone): nine
  themes that repaint the whole interface - library, reader, menus and all - plus
  text size, typeface, line spacing, a keyboard reference and a reset. Themes are
  Light, Paper, Solar, Mono, Midnight, Dusk, Ocean, Forest and Ink; the choice is
  remembered per device, and the phone's browser chrome follows it.
- Separate Local Library and Online Library views, with Supabase email/password accounts, private book uploads and downloads, a 1 GiB standard storage quota, and an Admin account limit controlled by server configuration.
- Desktop pairing for local-copy servers: select an active computer and queue online books into that computer's local library. Server jobs are downloaded directly from private storage by the paired server agent.

## Run (dev)
```powershell
cd sailing-books
npm install
npm start
```

## Build the v1.0.1 .exe
```powershell
cd sailing-books
npm install
npm run dist -- --config.directories.output=release/1.0.1
```
Output: `sailing-books\release\1.0.1\Sailing-Books-Setup-1.0.1.exe`. The 1.0.0 installer remains in `dist`.
Install it, then launch **Sailing Books** from the Start Menu or desktop shortcut.
Your library files are copied to `%APPDATA%\Sailing Books\Library`.

## Build the web app
```powershell
npm run build:web
```
The static site is written to `web\dist`. It uses the same renderer and styles as the desktop app. The Vercel project also serves its cloud-account API from the root `api` folder.

Before enabling sign-up, uploads, or server pairing, follow [`supabase/README.md`](supabase/README.md) to run the database migration and configure Vercel. The service-role key and Admin email are server-only settings.

## Notes
- EPUB parsing is fully offline (JSZip, no server).
- DRM-protected EPUBs cannot be opened.
- Covers are extracted from the EPUB when available.
