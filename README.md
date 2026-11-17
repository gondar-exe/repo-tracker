# Release Watcher

A lightweight web service that tracks GitHub repository releases and sends native Web Push notifications directly to devices (Chrome / Android).

---

## ⚡ Stack

- **Frontend**: Vanilla HTML5 + JavaScript (no framework, no bundler) in `public/index.html`
- **Service Worker**: `public/sw.js` (Web Push handling via Push API + Notifications API)
- **Backend & Poller**: Cloudflare Worker in `src/index.js` (serves static assets, REST API, and scheduled cron)
- **Database**: Cloudflare KV (`WATCH_KV`)
- **Push Delivery**: Standard Web Push Protocol (RFC 8291/8292) via `@block65/webcrypto-web-push` with VAPID authentication

---

## 📁 Repository Layout

```
D:\repo tracker/
├── package.json
├── wrangler.toml
├── src/
│   └── index.js
├── public/
│   ├── index.html
│   └── sw.js
├── .gitignore
└── README.md
```

---

## 🚀 Deployment Steps

### 1. Authenticate with Cloudflare
Run in terminal:
```bash
npx wrangler login
```

### 2. Create the KV Namespace
```bash
npx wrangler kv namespace create WATCH_KV
```
Copy the generated namespace ID and paste it into `wrangler.toml` replacing `PASTE_KV_ID_HERE`.

### 3. Set the VAPID Private Key Secret
```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```
When prompted, paste your generated VAPID private key.

### 4. Deploy the Worker
```bash
npx wrangler deploy
```
Once deployed, your service will be live at `https://release-watcher.<your-subdomain>.workers.dev`.
Verify under Cloudflare Dashboard > Workers & Pages > release-watcher > Settings > Triggers that the cron `*/10 * * * *` is active.

---

## 🧪 Acceptance Testing

Follow Section 9 of the implementation plan on Chrome (Android or Desktop):
1. **Load Page**: Navigate to the deployed URL. Verify UI and no console errors.
2. **Enable Notifications**: Tap "Enable notifications", grant permission.
3. **Send Test Notification**: Tap "Send test notification" and verify the push appears.
4. **Add Repos**: Add `https://github.com/cli/cli` and `denoland/deno`. Verify baseline release detection.
5. **Validation**: Test invalid repos (e.g. `hello` or non-existent repo).
6. **Persistence & Deletion**: Remove a repo and reload the page.
7. **Simulate Release / Cron**: Modify a repo's `lastId` in KV and test cron trigger.
8. **Restore**: Clear site data and restore using the recovery UUID code.
