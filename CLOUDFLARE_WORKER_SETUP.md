# Cloudflare Worker Upload Setup

This site is static GitHub Pages. Cross-device uploads need a private write service, so the Worker commits uploaded photos and ledger rows into this GitHub repo.

## 1. Create a GitHub token

Create a fine-grained GitHub token for `CaptainSeanG/Pool` with:

- Contents: Read and write
- Metadata: Read

Copy the token once. Do not paste it into website JavaScript.

## 2. Install and log in to Wrangler

```powershell
npm install -g wrangler
wrangler login
```

## 3. Configure Worker secrets

From this repo folder:

```powershell
wrangler secret put GITHUB_TOKEN
wrangler secret put UPLOAD_KEY
```

Use a private upload key/PIN for `UPLOAD_KEY`. The phone page will ask for this key the first time it uploads.

## 4. Deploy the Worker

```powershell
wrangler deploy
```

Copy the deployed Worker URL, usually like:

```text
https://pool-chemical-uploader.YOUR_SUBDOMAIN.workers.dev
```

## 5. Set the public Worker URL

Edit `app-config.js`:

```js
window.POOL_API_BASE = "https://pool-chemical-uploader.YOUR_SUBDOMAIN.workers.dev";
```

Commit and push that change. After GitHub Pages updates, uploads from `phone.html` will write:

- `uploads/YYYY-MM-DD/<upload-id>.jpg`
- `ledger.json`

The laptop dashboard reads `ledger.json`, so uploaded phone rows become visible across devices after refresh.
