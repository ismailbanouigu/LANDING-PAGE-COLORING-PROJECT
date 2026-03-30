## Firebase Deploy (Hosting + Pollinations API)

### 1) Local dev (all features work)

Option A (Recommended): create a `.env.local` file (never commit it) with:

```
POLLINATIONS_API_KEY=sk_...
```

Then run:

```powershell
npm run dev
```

Option B: start the dev server with a server-side key via PowerShell (never put `sk_...` in the browser or in URLs):

```powershell
$sec = Read-Host "POLLINATIONS_API_KEY" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$env:POLLINATIONS_API_KEY = $plain
npm run dev
```

Check:

- `http://127.0.0.1:PORT/api/pollinations/status` → `{ "keyPresent": true }`

### 2) Production (live)

Build:

```powershell
npm run build
```

Login (one time):

```powershell
npx firebase-tools login
```

Set Pollinations key as a **Firebase Functions secret**:

```powershell
npx firebase-tools functions:secrets:set POLLINATIONS_API_KEY
```

Deploy:

```powershell
npx firebase-tools deploy --only functions,hosting
```

### Notes

- `/api/pollinations/image` and `/api/pollinations/chat` are served by Firebase Functions in production (see `firebase.json` rewrites).
- If `keyPresent` is false, Photo→Coloring and Colorize Drawing are disabled (they require chat, which requires the server key).

### Cloudflare / External Hosting

If you host the frontend on Cloudflare (or any other domain) but keep the API on Firebase Hosting, set:

```
VITE_API_BASE=https://YOUR-PROJECT.web.app
```

### Cloudflare Worker (API Only)

If you want `/api/pollinations/*` to work directly on Cloudflare without Firebase, deploy the Worker in this repo:

```powershell
npx wrangler login
npx wrangler secret put POLLINATIONS_API_KEY
npx wrangler deploy
```

Then set:

```
VITE_API_BASE=https://YOUR-WORKER.workers.dev
```
