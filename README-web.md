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

- **First run downloads Cloudflare's `cloudflared`** (about 55 MB) to
  `%LOCALAPPDATA%\Sailing Books\tools\cloudflared.exe` (or
  `~/.sailing-books/tools/` on macOS/Linux). It is a single file, needs no
  installer and no admin rights. Delete it to undo. To install it yourself
  instead: `winget install --id Cloudflare.cloudflared`.
- If that download is blocked, the script falls back to the SSH client built
  into Windows/macOS, which needs nothing installed but is best effort — the
  address can change or fail. For a permanent address, create a named
  Cloudflare Tunnel.
- The address is different every time you run it (that's normal for a quick
  tunnel).
- **The laptop must be on, awake, and running this** while the phone reads.
  On Windows, set *Settings → Power → Screen and sleep → When plugged in, sleep
  after: Never* if you read for long periods.
- Because the address is public, keep the password private. The generated one is
  long; to refuse to start on a generated password: `set SB_REQUIRE_PASSWORD=1`.
- Tailscale is the other good option — install it on the laptop *and* the
  phone, and the server is only reachable on your private network, never
  publicly at all. Use `npm run server` and the Tailscale IP.

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
   address once and it is remembered on the phone.

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
