# Sailing Books — phone / web access

The library stays on your laptop. Your phone signs in with a password and reads
the books over your home Wi-Fi — nothing is uploaded anywhere.

## Start it

```
npm run server
```

It prints something like:

```
  On this laptop:  http://localhost:8787
  On your phone:   http://192.168.1.106:8787   (same Wi-Fi)

  Password: 4f2a91c7kd83mz10   (generated — saved to web-auth.json)
```

Open the **phone** address in the phone's browser, type that password, done.
Add it to the Home Screen and it behaves like an app.

Set your own password and port with environment variables:

```
set SB_PASSWORD=my-password
set SB_PORT=9000
npm run server
```

## Using it from any network (not just your Wi-Fi)

Same Wi-Fi is only the simplest option. To read from mobile data, a hotel
Wi-Fi, or anywhere else, put a tunnel in front of the server:

```
npm run tunnel
```

It starts the server and prints a public HTTPS address like
`https://something.trycloudflare.com`. Open that on the phone from any network
and sign in with the same password. The books still stream from your laptop —
the tunnel only forwards the connection.

- First run downloads Cloudflare's `cloudflared`** (about 55 MB) to
  `%LOCALAPPDATA%\Sailing Books\tools\cloudflared.exe` (or
  `~/.sailing-books/tools/` on macOS/Linux). It is a single file, needs no
  installer and no admin rights. Delete it to undo. To install it yourself
  instead: `winget install --id Cloudflare.cloudflared`.
- If a saved ngrok domain is set (see below), the tunnel uses that instead of
  Cloudflare's, because only ngrok can promise the same address every run. For a
  name you choose, use `npm run funnel` (Tailscale Funnel) instead.
- If the cloudflared download is blocked, the script falls back to the SSH
  client built into Windows/macOS, which needs nothing installed but is best
  effort — the address can change or fail.
- Without a fixed domain the address is different every time you run it (that's
  normal for a quick tunnel). It is also printed to
  `%APPDATA%\Sailing Books\public-url.txt`, so the last one is never lost.
- **The laptop must be on, awake, and running this** while the phone reads.
  On Windows, set *Settings → Power → Screen and sleep → When plugged in, sleep
  after: Never* if you read for long periods.
- Because the address is public, keep the password private. The generated one is
  long; to refuse to start on a generated password: `set SB_REQUIRE_PASSWORD=1`.
- Tailscale is the other good option — install it on the laptop *and* the
  phone, and the server is only reachable on your private network, never
  publicly at all. Use `npm run server` and the Tailscale IP.

## A fixed address with a name in it

A quick tunnel changes its address every run, which is fine for a quick look
but useless as a bookmark. There are three answers, and only the first one lets
you pick the name for free.

**1. Tailscale Funnel — free, and the name is yours (best option).**

```
winget install --id tailscale.tailscale     1. install Tailscale (free)
                                               2. sign in with Google/GitHub/Microsoft
tailscale set --hostname=sailing-books       3. name the machine — this is your address
npm run funnel                               4. done
```

That gives you a permanent, public HTTPS address of the form
`https://sailing-books.<your-tailnet>.ts.net`. Set the name once and it never
changes. It costs nothing, needs no domain, and works from mobile data, a hotel
Wi-Fi, anywhere.

**Bookmark it and you are done.** The laptop serves the whole app itself, so the
page knows it is already talking to the right machine and the **Laptop address**
box does not even appear — you only ever type your password. Funnel has to be
approved once (free on every plan, including the free personal one); `npm run
funnel` prints the link if it is not on yet.

Two honest caveats: Funnel traffic goes through Tailscale's relay and has
bandwidth limits, so streaming a 1 GB audiobook may be slow (reading EPUB text
is fine), and the laptop must be awake and running this while you read.

**2. ngrok — free, but ngrok picks the name.**

```
winget install --id ngrok.ngrok
setx NGROK_AUTHTOKEN your-token-here
npm run tunnel
```

Your free account gets one permanent domain, so the address stops changing. But
ngrok assigns that name (`abc123xyz.ngrok-free.dev`) and does **not** let you
choose or reserve one — that needs a paid plan. The free plan also allows 1 GB
of transfer per month. If you want to pin the exact domain ngrok gave you:

```
npm run tunnel:fix abc123xyz.ngrok-free.dev
```

**3. A domain you own — the name you actually want.**

Buy a name such as `books.something.com` (about $10 a year at any registrar),
point it at Cloudflare, and create a named Cloudflare Tunnel, which is free
forever. Then the address is `books.yourdomain.com` and nobody else's.

**If you keep using Vercel.** The client is plain static files, so the front end
can live on Vercel and point at the laptop. Build it with `node web/build.js`.
That gives one Vercel address to bookmark, but it is a *different* address from
the tunnel, and because Vercel is not the laptop it cannot know where the laptop
is — so the sign-in screen does show the **Laptop address** box, filled from the
last five addresses you used, so you tap instead of type.

You only need Vercel if you want a front door that survives the laptop's own
address changing.

## Reading on the phone

- **Clean** in the reader bar hides every control (title, chapters, pages,
  scroll bar) and asks the phone for real full screen. **Tap the page** to bring
  them back. The choice is remembered for the next book.
- EPUBs always open in **scroll mode** on the phone — no paginated columns.
- **Keep scrolling at the end of a chapter and it turns the page** (and the same
  at the top, going back). Reaching the end on its own never skips anything.
- Audiobooks keep their chapter list, and the arrows skip forward/back with the
  same chapter roll-over.

## Notes

- **The desktop app must have been opened at least once** so the library index
  exists. The app writes `%APPDATA%\Sailing Books\library-index.json` a couple
  of seconds after any change. (If the server finds no index it falls back to
  listing the `Library` folder, so titles show as file names until you open the
  desktop app once.)
- **Phone and laptop must be on the same Wi-Fi**, and the laptop's firewall may
  ask to allow Node.js on private networks the first time.
- **Reading progress syncs back** to the laptop
  (`%APPDATA%\Sailing Books\web-progress.json`). The desktop app keeps its own
  copy in its own storage, so the two do not merge — the phone is the source of
  truth for what you read on the phone.
- **Library management stays on the desktop**: importing, folders, renames,
  deleting and the flowchart are disabled on the phone (they say so if you try).
- Chapters come from the embedded chapter data, read on the laptop, so
  audiobooks keep their chapter list on the phone.
- Large EPUBs are downloaded to the phone to be read, so the first open of a
  50 MB book takes a moment on slow Wi-Fi.

## Using Vercel (optional)

The client is plain static files, so you can host the shell on Vercel and point
it at your laptop. Two things to know:

1. A Vercel page is **HTTPS**, so it cannot call an `http://` laptop address —
   the browser blocks it as mixed content. You need an HTTPS tunnel to the
   laptop (Cloudflare Tunnel or ngrok), or host the client from the laptop
   server itself (the default, `npm run server`, which already serves it).
2. The login screen has a **Laptop address** box. Fill in the laptop (or tunnel)
   address once and it is remembered on the phone, along with the last five you
   used, so a new tunnel address is one tap rather than typing. If the page is
   being served *by the laptop itself*, the box is hidden entirely.

To deploy the shell to Vercel, upload these as the static output:

```
web/api-shim.js
web/login.js
web/login.html   (its markup is inlined into the page by the server; for Vercel,
                 paste the <div id="loginGate">…</div> block into your index.html)
```

and load them in this order before `renderer.js`:

```html
<script src="/api-shim.js"></script>
<script src="/login.js"></script>
<script src="/renderer.js"></script>
```

along with `renderer/styles.css` and the two libraries
(`jszip`, `pdfjs-dist/build/pdf.js` + `pdf.worker.js`).

## Security

- One shared password; sign-in issues an HMAC-signed token valid for 30 days.
- Wrong-password attempts are rate limited (8 per 5 minutes per device).
- The server only ever serves files that live inside the library and covers
  folders — any path that tries to escape them is refused.
- It binds to all interfaces so the phone can reach it, so only run it on a
  network you trust, and stop it (`Ctrl+C`) when you're done.
