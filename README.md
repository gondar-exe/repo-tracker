# GitHub Release Watcher (Repo Tracker)

Paste a list of GitHub repos into a clean web UI. When any repo publishes a new release, your phone gets an instant push notification. Tapping it opens the release page.

---

## ⚡ Tech Stack & Cost

| Piece | Tech | Cost |
|---|---|---|
| **UI** | Single `index.html`, vanilla JS | Free |
| **List Storage + API** | Cloudflare Pages Functions + KV | Free |
| **Poller** | Node 20 script on GitHub Actions cron | Free (public repo) |
| **Push Notifications** | [ntfy.sh](https://ntfy.sh) + ntfy mobile app | Free (no account required) |

*Zero frameworks, zero npm dependencies, zero build steps.*

---

## 🏗 Architecture

```
[index.html] --POST list (password)--> [Pages Function] --> [KV: "repos"]
                                                              ^
[GitHub Actions cron, every 10 min]                           |
  1. GET /api/repos (password) ------------------------------+
  2. For each repo: fetch releases.atom (or GitHub API if token mode)
  3. Compare latest release id with state.json
  4. New release? POST to ntfy.sh with click = release URL
  5. Commit updated state.json (built-in GITHUB_TOKEN)

[ntfy Android / iOS app] <-- push -- ntfy.sh   (tap -> opens release URL)
```

---

## 📁 Repository Layout

```
repo tracker/
├── index.html                  # Simple frontend UI for managing repo lists
├── functions/
│   └── api/
│       └── repos.js            # Cloudflare Pages Function with KV storage
├── check.mjs                   # Node 20 polling script (Atom/API + ntfy)
├── state.json                  # Tracks last seen release IDs (managed by workflow)
├── .github/
│   └── workflows/
│       └── check.yml           # GitHub Actions scheduled workflow
├── .gitignore
└── README.md
```

---

## 🚀 Setup & Deployment Guide

### Step 1: Initialize Git and Push to GitHub
1. Create a new **public** repository on GitHub (e.g. `repo-tracker` or `release-watcher`).
   > **Note:** Public repositories receive unlimited free GitHub Actions minutes.
2. Initialize and push your local directory:
   ```bash
   cd "D:\repo tracker"
   git init
   git add .
   git commit -m "Initial commit: release watcher system"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```

### Step 2: Set up Cloudflare Pages & KV
1. In the **Cloudflare Dashboard**, navigate to **Workers & Pages** > **KV** > **Create a namespace**:
   - Name: `REPOS_KV`
2. Go to **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**:
   - Select your repository.
   - **Framework preset**: `None`
   - **Build command**: *(leave blank)*
   - **Build output directory**: `/` (root)
   - Click **Save and Deploy**.
3. Configure KV Binding:
   - Go to your Pages project > **Settings** > **Bindings**.
   - Under **KV namespace bindings**, click **Add binding**:
     - Variable name: `REPOS_KV`
     - KV namespace: Select `REPOS_KV`.
4. Add Admin Password Secret:
   - In Pages project > **Settings** > **Variables and Secrets**.
   - Add Secret: `ADMIN_PASSWORD` = *(generate a secure random password)*.
5. Trigger a **Redeploy** on Cloudflare Pages so the binding and environment variables take effect.

### Step 3: Configure GitHub Actions Secrets
In your GitHub repo, go to **Settings** > **Secrets and variables** > **Actions** and add:

| Secret Name | Value Description |
|---|---|
| `LIST_URL` | `https://<your-project>.pages.dev/api/repos` |
| `ADMIN_PASSWORD` | Same password you set in Cloudflare Pages |
| `NTFY_TOPIC` | A secret random topic string (e.g., `rw-8f3k2j9x7q1m4z`) |

> `GITHUB_TOKEN` is automatically provided by GitHub Actions with `contents: write` permission to update `state.json`.

### Step 4: Set Up the ntfy Mobile App
1. Install **ntfy** on your phone ([Google Play Store](https://play.google.com/store/apps/details?id=io.heckel.ntfy) or [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/) or iOS App Store).
2. Tap **+** and subscribe to your topic (`NTFY_TOPIC`).
3. *(Recommended)* Exempt the ntfy app from battery optimization in Android settings for immediate push delivery.

---

## 🧪 Verification & Testing

1. **Test Frontend & API**:
   - Open `https://<your-project>.pages.dev`.
   - Enter your `ADMIN_PASSWORD`.
   - Paste repo identifiers or URLs (e.g., `facebook/react` or `https://github.com/facebook/react`).
   - Click **Save**. Verify that it displays `Saved X repos.` and reload to confirm persistence.
2. **First Run (Initial State Record)**:
   - In GitHub, go to the **Actions** tab > **check-releases** > **Run workflow**.
   - On the first run, existing releases are recorded quietly into `state.json` without sending spam notifications.
3. **Trigger a Notification Test**:
   - Edit `state.json` in GitHub to change one recorded ID to `"test-id"`, commit, and re-run the workflow.
   - You will immediately receive a push notification on your phone via ntfy!
   - Tap the notification to confirm it opens the release page.

---

## ⚙️ Options & Gotchas

- **More than ~50 repos**: In `.github/workflows/check.yml`, set `USE_API: "1"`. This switches from the public Atom feed to the authenticated GitHub API using the built-in `GITHUB_TOKEN` (high rate limits).
- **Public vs. Private Repos**: Public repos have free unlimited Action minutes. If kept private, you share your account's 2,000 monthly quota (a 10-minute cron runs ~4,300 times/month). Slow the cron to every 30-60 minutes if using a private repo.
- **ntfy Security**: Anyone knowing your `NTFY_TOPIC` can read or publish notifications to it; keep the topic name random and secret.
