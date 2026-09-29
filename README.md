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

## Build the v1.0.4 .exe
```powershell
cd sailing-books
npm install
npm run dist -- --config.directories.output=release/1.0.4
```
Output: `sailing-books\release\1.0.4\Sailing-Books-Setup-1.0.4.exe`. Older installers remain available in their version folders.
Install it, then launch **Sailing Books** from the Start Menu or desktop shortcut.
Your library files are copied to `%APPDATA%\Sailing Books\Library`.

## Build the web app
```powershell
npm run build:web
```
The static site is written to `web\dist`. It uses the same renderer and styles as the desktop app. The Vercel project also serves its cloud-account API from the root `api` folder.

Before enabling sign-up, uploads, or server pairing, follow [`supabase/README.md`](supabase/README.md) to run the database migration and configure Vercel. The service-role key and Admin email are server-only settings.

## Where books are stored

- **Online Library:** Book files are stored in the private `sailing-books` bucket in your configured Supabase Storage project. Account records and book metadata are in Supabase Auth/Postgres. Vercel's cloud API checks ownership and enforces the app quota: 1 GiB for standard accounts; the Admin account has no app-level quota. Supabase project/plan limits still apply.
- **Desktop Local Library:** Files are on that Windows computer in `%APPDATA%\Sailing Books\Library`; the library index and covers are alongside it under `%APPDATA%\Sailing Books\`.
- **Vercel website Local Library:** Files are stored in that browser profile's IndexedDB for `sailingbooks.vercel.app`. This is device/browser-local, separate from Supabase and other devices; clearing site data can remove it. Use Download to save a regular file to the browser's Downloads folder.
- **Create local copy:** The selected active server downloads the private online file into that server's own `Library` folder. On the Vercel website, the same action also adds a browser-local copy to the website's Local Library.

Online storage is billed/limited by the Supabase project owner; Sailing Books does not provide a separate storage pool.

## Notes
- EPUB parsing is fully offline (JSZip, no server).
- DRM-protected EPUBs cannot be opened.
- Covers are extracted from the EPUB when available.
