# Online Library setup

The account and private book-storage service needs one Supabase project and four Vercel environment variables. No provider secret belongs in the desktop renderer or web bundle.

## 1. Create the database and private bucket

Open the Supabase SQL editor and run [`migrations/202609290001_cloud_library.sql`](migrations/202609290001_cloud_library.sql). It creates the account-owned book and server tables, quota reservation functions, row-level security policies, and the private `sailing-books` storage bucket.

Supabase Auth email/password sign-in is used. If email confirmation is enabled, new users must confirm their address before the first sign-in.

## 2. Configure Vercel

Add these variables to the `sailingbooks` Vercel project for Production (and Preview/Development if those deployments should use cloud accounts):

| Variable | Value |
| --- | --- |
| `SB_SUPABASE_URL` | Project URL from Supabase API settings |
| `SB_SUPABASE_ANON_KEY` | Supabase publishable/anon key |
| `SB_SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role secret; server-side only |
| `SB_ADMIN_EMAIL` | The account email that receives unlimited storage |

Redeploy after adding the variables. The public config route returns only the URL and anon key. The service-role key and Admin email are read by the Vercel function only.

The standard account limit is 1 GiB (1,073,741,824 bytes). Uploads first reserve their full size under a database transaction; the storage policy checks that the object fits that reservation. Unfinished reservations expire after 24 hours. The Admin limit is determined by an exact, case-insensitive email comparison in the authenticated server request.

## 3. Connect a computer as a local-copy server

In Online Library, choose a server name and address. On the desktop app, `http://localhost:8787` pairs this computer and starts its local-library service while the app is running. The pairing token is shown once and encrypted in the desktop app's user data when stored locally.

For another computer running `npm run server`, set `SB_CLOUD_SERVER_ID` and `SB_CLOUD_SERVER_TOKEN` to the values shown at registration, then restart the server. The service polls Vercel, downloads queued books through short-lived private-storage links, writes them into that machine's Sailing Books library, and reports job completion. Keep the paired token private. Set `SB_CLOUD_API_URL` only when pairing a non-production deployment.

The registered server address is displayed to the account owner. It does not open a network tunnel or make a laptop reachable from the public internet; network access must already be configured on that machine.

## Deployment check

`npm run build:web` writes the hosted client into `web/dist`. Vercel also deploys the root `api/cloud/[...route].js` function. After the Vercel variables and SQL migration are in place, sign-up, sign-in, private uploads, account quotas, server heartbeats, and local-copy jobs are available.
