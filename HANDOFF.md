# Sailing Books — handoff notes

Written by an AI that worked on this project across one long session. It is a
map of what exists, what was done, what is broken, and the traps that cost time —
so the next person (or the next AI) does not have to rediscover them.

> **Architecture update (2026-09):** The notes below began as documentation for
> the original laptop-only app. The current release also has Supabase accounts,
> a private Online Library, Vercel server APIs, a browser-local library, and
> laptop server pairing. Treat claims below that say there are no accounts or
> uploads as historical. Current storage locations and setup are documented in
> `README.md` and `supabase/README.md`.

---

## 1. What this is

A library and reader for EPUBs, PDFs and audiobooks, written as an Electron
desktop app with a matching web app. It supports a local desktop library, a
browser-local library, and an authenticated Supabase Online Library. A paired
laptop server can download online books into its own local library.

**The one architectural idea that explains everything else:**

```
┌─ LAPTOP ───────────────────────────────┐        ┌─ PHONE ──────────┐
│ 1. Desktop app (Electron)              │        │ 3. Browser client│
│    main.js   → filesystem, IPC         │        │    same files    │
│    preload.js → window.api             │  HTTPS │    api-shim.js   │
│    renderer.js → ALL the UI + logic    │◄──────►│    over fetch()  │
│                                       │        │                 │
│ 2. server/server.js  (node, no fw)     │        └─────────────────┘
│    serves the SAME renderer.js         │        everything stays on
│    + a JSON API over the library       │          the laptop
└───────────────────────────────────────┘
```

`renderer.js` never talks to Electron directly. Everything goes through
`window.api`. In Electron, `preload.js` provides it over IPC; in a browser,
`web/api-shim.js` provides the **same interface** over `fetch`. One bug fix
appears in both. The server serves the desktop's own `renderer.js`, so there is
only ever one copy of the app.

`const WEB = !!(window.api && window.api.mode === 'web')` selects the browser
bridge. The hosted app uses `renderer/cloud-client.js` for Supabase auth, online
books, and paired servers; `web/api-shim.js` stores the hosted website's Local
Library in that browser's IndexedDB. Electron uses `preload.js` and the Windows
filesystem.

---

## 2. Current state

- Repo: `C:\Users\Manjunath\Documents\SailingBooks`
- Current app version: 1.0.4. Previous release installers are retained in their
  versioned output folders.
- Production web frontend: `https://sailingbooks.vercel.app`; its serverless
  cloud API is in `api/cloud/[...route].js`.
- Account, metadata, and private book files are owned by the configured Supabase
  project. A standard account has a 1 GiB app quota; the configured Admin email
  has no app-level quota. Supabase plan/storage limits still apply.
- Desktop Local Library files are under `%APPDATA%\Sailing Books\Library`.
  The hosted website Local Library uses IndexedDB in the current browser profile.
- The optional laptop server agent polls cloud jobs and writes local copies into
  that computer's library folder when it is running and paired.
- Current work may be uncommitted while a release is being prepared. Check Git
  status and the latest deployment before assuming a change is live.

---

## 3. What I did this session, in order

### a. Removed the "Archives" feature (built, then scrapped on request)
Built a private archive (one `admin` account, books stored in
`%APPDATA%\Sailing Books\Archives`, sets + flowcharts, install-into-library, zip
download), then the user wanted it gone and back to plain tunnel access. All of it
was removed: `server/archive.js`, the Archives button and view, the desktop IPC
bridge, the shim methods, the styles.
**Leftover on disk:** `%APPDATA%\Sailing Books\Archives\Books\` still holds **24
EPUBs** the user uploaded. They are separate from the library, harmless, and
invisible to the app. I deliberately did **not** delete them. The user has never
answered whether to.

### b. A fixed website address (three attempts, one real lesson)
- `npm run tunnel` (Cloudflare quick tunnel) → works from any network, but the
  address is **different every run**.
- `npm run funnel` (Tailscale Funnel) → a *named, fixed* address
  (`https://sailing-books.tailcf4de9.ts.net`). Free. **Its public side is
  currently broken** — see §5.
- `npm run tunnel:fix` (server/fixed-url.js) → prints the options and pins an
  ngrok dev domain if asked.
- The login page hides the **Laptop address box** when the page is served by the
  laptop (`window.SB_SERVED_BY_LAPTOP`), so a bookmarked address needs no typing.
  When hosted on Vercel it offers the **last five addresses as tap-able chips**.

**Correction I had to make:** I first told the user ngrok's free plan lets you
reserve a name like `books.ngrok-free.app`. It does not — the free plan assigns
one random-looking domain and will not let you choose it. The code and docs were
corrected.

### c. Fixed the character-encoding corruption
Text read as `Library Ã‚Â·` instead of `Library ·`. Cause: some of my earlier edits
went through Windows PowerShell, which reads files as Windows-1252 and writes them
back as UTF-8, re-encoding every non-ASCII character (some lines three times).
`harness/fix-encoding.js` reverses it — the damage is byte-local and invertible,
so each stretch is walked back and scored, and stretches mangled to different
depths are fixed by their own pass count. 193 markers → 0.

### d. Fixed covers in the browser
Every cover pointed at the **book file**. The server sent `coverPath` as
`id:<bookId>`, the same form used for book files, so `fileUrl()` produced
`/api/book/:id/file`; the `<img>` was handed an EPUB, failed to decode, and
`onerror="this.remove()"` deleted it. 36 empty cover boxes, no error anywhere.
Fixed by addressing covers **by book** rather than by path: the server sends
`hasCover`, and each api answers `coverUrl(book)` for itself (file path in the
app, authenticated endpoint in a browser, because an `<img>` cannot send headers).

### e. EPUBs are no longer read as base64
The web client pulled each EPUB as a base64 data URL — 33% inflation plus copies
before JSZip saw it. Added `readFileBytes()` on both sides; `zipOf()` asks for
bytes. A 30 MB EPUB now costs 30 MB.

### f. The client is served `no-store`
Otherwise a phone sits on an old `renderer.js` after a fix ships, which looks
exactly like the fix not working. Bundled libraries stay cacheable.

### g. Settings panel and nine themes
Gear in the top bar → theme, text size, typeface, line spacing, keyboard
reference, reset. Same markup and code in the app and the browser.
Themes: **Light, Paper, Solar, Mono, Midnight, Dusk, Ocean, Forest, Ink**.
Every colour in the app was converted from hardcoded hex to CSS variables, which
is what lets a theme repaint everything; the reader has its own surface so the
page you are reading goes dark too, and the phone's browser chrome follows.

**Bug found on the way:** `save()` deliberately never writes localStorage on the
web (the laptop owns the library), so a theme chosen on the phone was lost every
reload. Settings now live under `sailing-books-settings`, per device.

### h. Made every control readable, and made the documented keys work
- **`<button>` and `<select>` do not inherit `color`.** Every button in the reader
  bar was black-on-dark: contrast **1.26:1** on Midnight, **1.07:1** on Ink.
- `--muted` / `--faint` were too light at 12–13px.
- **`F` did nothing** — I had written it into the settings panel without
  implementing it. Rather than delete the label, `F` and `C` now work as bare
  keys (`Ctrl+F` deliberately left to the browser).

---

## 4. Live configuration

| Thing | Value |
|---|---|
| Laptop data | `%APPDATA%\Sailing Books\` |
| Books / covers / index | `Library\`, `Covers\`, `library-index.json` |
| Progress from phone | `web-progress.json` |
| Legacy laptop-server auth | `web-auth.json` (contains a local secret; do not copy it into docs or logs) |
| Server port | 8787 (`SB_PORT` to change) |
| Vercel front door | `https://sailingbooks.vercel.app` |
| Funnel address | `https://sailing-books.tailcf4de9.ts.net` |
| Tunnel binary | `%LOCALAPPDATA%\Sailing Books\tools\cloudflared.exe` |

Commands: `npm start` · `npm run server` · `npm run tunnel` · `npm run funnel` ·
`npm run check` · `npm run check:outside` · `npm run check:books` ·
`npm run build:web` · `npm run dist`

Env: `SB_PORT` `SB_PASSWORD` `SB_REQUIRE_PASSWORD` `SB_USER_DATA` `SB_PARENT_PID`
`NGROK_AUTHTOKEN` `SB_NGROK_DOMAIN` `SB_FUNNEL_NAME`

The hosted account flow uses Supabase Auth. Never put Supabase secret/service
keys or local server credentials in client files, screenshots, commits, or
handoff notes. Vercel cloud secrets belong in server-only environment settings.

---

## 5. Known issues, honestly

1. **Tailscale Funnel's public side is broken for this account.** DNS resolves and
   the cert is valid, but public relays get **522 / 408** connecting to the Funnel
   ingress. `tailscale funnel reset` and re-arming do not help; restarting the
   service needs admin. This is Tailscale-side (their issue tracker has a cluster
   of identical reports). **Consequence: no device outside the tailnet can open
   the funnel address — the laptop can, because it is inside the tailnet.**
   Working fallbacks: `npm run tunnel` (Cloudflare), or install Tailscale on the
   phone so the phone joins the tailnet and the tailnet-internal address works.
2. **The laptop cannot be trusted to test reachability.** Inside the tailnet the
   Funnel name also resolves locally, so "works on my laptop" proves nothing.
   Test with `npm run check:outside`.
3. **A phone that failed while the record was missing caches that failure.**
   Negative DNS answers get cached; switching Wi-Fi ↔ mobile data or toggling
   airplane mode forces a fresh lookup.
4. **24 archived EPUBs** still sit in `Archives\Books\` (see §3a).
5. Reading position does **not** merge back: the phone's `web-progress.json` and
   the app's localStorage are separate.

---

## 6. Verification tooling (`harness/`)

Run these rather than reasoning about whether something works.

| Script | What it answers |
|---|---|
| `tunnel-access.test.js` | 25 assertions over the whole web path: sign-in, library, file, cover, progress, refused traversal, static client. **25/25.** |
| `check-all-books.js` | Opens **every** book in real Chromium through the public address, tapping each one as a person would. Currently **73 books, 73 covers.** |
| `check-contrast.js` | WCAG ratio of 13 kinds of text in all nine themes. Any theme below 4.5 (3.0 for large text) fails. Currently clean. |
| `check-keys.js` | Presses every shortcut the settings panel advertises, for real. |
| `check-settings-both.js` | Panel and themes on a 390px phone window and in the app with the real preload. |
| `check-themes.js` | Applies all nine, reads what the browser painted, reloads to prove persistence. |
| `check-phone.js` (`npm run check`) | "Can the phone open this?" — DNS retries, then the phone's own steps. |
| `check-from-outside.js` | Asks public relays to fetch the address. The only honest reachability test. |
| `fix-encoding.js` / `find-lost-chars.js` | The encoding repair, and a scanner for destroyed characters. |
| `fix-missing-covers.js` | Adds artwork to books that have none; backs up the index first. |
| `check-desktop-covers.js` | The app still resolves covers to files on disk. |

---

## 7. Traps that cost real time

**Never edit a source file through PowerShell here.** `Get-Content` reads as
Windows-1252 and `Set-Content`/`WriteAllText` writes UTF-8, so every non-ASCII
character is re-encoded. Use the editor tools or a Node script. It happened
twice and corrupted ~85 lines.

**PowerShell's console also lies about characters.** It renders `→` and `·` as
`?` or `�`, which looks exactly like file corruption. Before believing a file is
damaged, read it with Node and look for `U+FFFD` specifically.

**A `<button>`, `<select>` or `<input>` does not inherit `color`.** Give every
control both a background and a text colour, or it will be black on a dark
theme. This is invisible until someone measures contrast.

**Inside a tailnet, "it works on my machine" is not evidence.** Both the funnel
name and the tailnet name resolve locally; only an outside vantage point tells
you whether the public path is real.

**A failing screenshot in an automated test often means a stale DOM node.** The
theme picker rebuilds its grid on click, so a node measured after the click
reports a zero rect. Two of my "failures" were that, not real bugs. Re-query the
DOM after anything that re-renders.

---

## 8. File map

- `main.js` — Electron main: IPC, library dir, covers, audio metadata, archiving of covers.
- `preload.js` — the `window.api` bridge (and `coverUrl`).
- `renderer/renderer.js` — all UI and logic (~2900 lines): library, readers, flowchart, settings, themes.
- `renderer/index.html` — structure, including the settings panel.
- `renderer/styles.css` — every colour is a variable; nine themes; the panel and picker.
- `server/server.js` — auth (HMAC tokens, rate limiting, CORS), library API, Range streaming, static client, `no-store`.
- `server/tunnel.js` — Cloudflare / ngrok / SSH tunnels, prints the address.
- `server/funnel.js` — Tailscale Funnel, the one-time approval link, port reuse.
- `server/fixed-url.js` — what fixed address is set, and the honest options.
- `web/api-shim.js` — `window.api` over `fetch` for the browser.
- `web/login.js` / `web/login.html` — the sign-in gate, recent-address chips.
- `web/build.js` — writes the static bundle to `web/dist`.
- `README-web.md` — phone access, tunnels, the fixed-address options.
