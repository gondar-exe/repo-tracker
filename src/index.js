import { buildPushPayload } from "@block65/webcrypto-web-push";

const MAX_REPOS_PER_DEVICE = 30;
const MAX_DEVICES = 20;
const MAX_REPOS_PER_RUN = 45; // keeps one cron run under Workers free-plan subrequest limit
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: "server error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scan(env));
  },
};

/* ---------------- helpers ---------------- */

function normalizeRepo(input) {
  let s = String(input || "").trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/[?#].*$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const name = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`.toLowerCase();
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null;
}

function validSub(sub) {
  try {
    const u = new URL(sub.endpoint);
    if (u.protocol !== "https:") return false;
    const okHost = PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
    if (!okHost) return false;
    return typeof sub.keys?.p256dh === "string" && typeof sub.keys?.auth === "string";
  } catch {
    return false;
  }
}

const publicRepos = (dev) =>
  dev.repos.map(({ name, lastTitle, lastUrl }) => ({ name, lastTitle, lastUrl }));

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Returns { missing: true } if repo not found, or { id, url, title }.
// id is "" when the repo has no releases yet.
async function fetchLatest(repo) {
  const res = await fetch(`https://github.com/${repo}/releases.atom`, {
    headers: { "user-agent": "release-watcher" },
  });
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`atom ${repo}: ${res.status}`);
  const xml = await res.text();
  const m = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!m) return { id: "", url: null, title: "" };
  const e = m[1];
  const id = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || "";
  const url = e.match(/<link[^>]*href="([^"]+)"/)?.[1] || null;
  const title = decodeEntities((e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim());
  return { id, url, title };
}

async function sendPush(env, sub, msg) {
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const payload = await buildPushPayload(
    { data: JSON.stringify(msg), options: { ttl: 86400, urgency: "normal" } },
    sub,
    vapid
  );
  return fetch(sub.endpoint, payload);
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/* ---------------- API ---------------- */

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/config" && method === "GET") {
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY, maxRepos: MAX_REPOS_PER_DEVICE });
  }

  let body = {};
  if (method !== "GET") {
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad json" }, 400);
    }
  }

  const deviceId = method === "GET" ? url.searchParams.get("deviceId") : body.deviceId;
  if (!UUID_RE.test(deviceId || "")) return json({ error: "bad deviceId" }, 400);
  const key = `dev:${deviceId}`;
  const dev = await env.WATCH_KV.get(key, "json");

  // Create or update the device's push subscription (keeps existing repos)
  if (path === "/api/subscribe" && method === "POST") {
    const sub = body.subscription;
    if (!sub || !validSub(sub)) return json({ error: "bad subscription" }, 400);
    if (!dev) {
      const count = (await env.WATCH_KV.list({ prefix: "dev:" })).keys.length;
      if (count >= MAX_DEVICES) return json({ error: "device limit reached" }, 403);
    }
    const record = dev || { id: deviceId, repos: [], createdAt: Date.now() };
    record.sub = {
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime ?? null,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    };
    await env.WATCH_KV.put(key, JSON.stringify(record));
    return json({ ok: true, repos: publicRepos(record) });
  }

  if (path === "/api/repos" && method === "GET") {
    if (!dev) return json({ subscribed: false, repos: [] });
    return json({ subscribed: true, repos: publicRepos(dev) });
  }

  if (!dev) return json({ error: "enable notifications first" }, 400);

  if (path === "/api/repos" && method === "POST") {
    const inputs = (Array.isArray(body.repos) ? body.repos : [body.repo]).slice(0, 30);
    const have = new Set(dev.repos.map((r) => r.name));
    const added = [];
    const failed = [];
    for (const raw of inputs) {
      const name = normalizeRepo(raw);
      if (!name) { failed.push({ input: String(raw), reason: "invalid repo" }); continue; }
      if (have.has(name)) { failed.push({ input: name, reason: "already added" }); continue; }
      if (dev.repos.length >= MAX_REPOS_PER_DEVICE) {
        failed.push({ input: name, reason: `limit reached (${MAX_REPOS_PER_DEVICE})` });
        continue;
      }
      let latest;
      try {
        latest = await fetchLatest(name);
      } catch {
        failed.push({ input: name, reason: "could not reach GitHub" });
        continue;
      }
      if (latest.missing) { failed.push({ input: name, reason: "repo not found" }); continue; }
      dev.repos.push({ name, lastId: latest.id, lastTitle: latest.title, lastUrl: latest.url });
      have.add(name);
      added.push(name);
    }
    if (added.length) await env.WATCH_KV.put(key, JSON.stringify(dev));
    return json({ added, failed, repos: publicRepos(dev) });
  }

  if (path === "/api/repos" && method === "DELETE") {
    const name = normalizeRepo(body.repo);
    dev.repos = dev.repos.filter((r) => r.name !== name);
    await env.WATCH_KV.put(key, JSON.stringify(dev));
    return json({ repos: publicRepos(dev) });
  }

  if (path === "/api/test" && method === "POST") {
    const res = await sendPush(env, dev.sub, {
      title: "Test notification",
      body: "Push is working.",
      url: url.origin,
      tag: "test",
    });
    return json({ ok: res.ok, status: res.status });
  }

  if (path === "/api/device" && method === "DELETE") {
    await env.WATCH_KV.delete(key);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

/* ---------------- cron scan ---------------- */

async function scan(env) {
  const listed = await env.WATCH_KV.list({ prefix: "dev:" });
  const devices = [];
  for (const k of listed.keys) {
    const d = await env.WATCH_KV.get(k.name, "json");
    if (d) devices.push(d);
  }

  const unique = [...new Set(devices.flatMap((d) => d.repos.map((r) => r.name)))].sort();
  if (!unique.length) return;

  // If there are too many repos for one run, scan a rotating slice (stateless).
  let batch = unique;
  if (unique.length > MAX_REPOS_PER_RUN) {
    const slot = Math.floor(Date.now() / 600000);
    const start = (slot * MAX_REPOS_PER_RUN) % unique.length;
    batch = Array.from({ length: MAX_REPOS_PER_RUN }, (_, i) => unique[(start + i) % unique.length]);
  }

  const latest = new Map();
  await pool(batch, 6, async (repo) => {
    try {
      const l = await fetchLatest(repo);
      if (!l.missing) latest.set(repo, l);
    } catch (e) {
      console.error(repo, String(e));
    }
  });

  for (const dev of devices) {
    const updates = new Map();
    let dead = false;

    for (const r of dev.repos) {
      const l = latest.get(r.name);
      if (!l || l.id === r.lastId) continue;

      const res = await sendPush(env, dev.sub, {
        title: `New release: ${r.name}`,
        body: l.title || "New release published",
        url: l.url || `https://github.com/${r.name}/releases`,
        tag: r.name,
      });

      if (res.status === 404 || res.status === 410) { dead = true; break; }
      if (res.ok) updates.set(r.name, l);
      else console.error("push failed", dev.id, res.status);
    }

    if (dead) {
      await env.WATCH_KV.delete(`dev:${dev.id}`);
      continue;
    }

    if (updates.size) {
      // Re-read to avoid overwriting repos the user added/removed during this run
      const fresh = await env.WATCH_KV.get(`dev:${dev.id}`, "json");
      if (!fresh) continue;
      for (const r of fresh.repos) {
        const l = updates.get(r.name);
        if (l) { r.lastId = l.id; r.lastTitle = l.title; r.lastUrl = l.url; }
      }
      await env.WATCH_KV.put(`dev:${dev.id}`, JSON.stringify(fresh));
    }
  }
}
