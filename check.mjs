import { readFile, writeFile } from "node:fs/promises";

const { LIST_URL, ADMIN_PASSWORD, NTFY_TOPIC, GITHUB_TOKEN, USE_API } = process.env;
if (!LIST_URL || !ADMIN_PASSWORD || !NTFY_TOPIC) throw new Error("missing env");

// ---- load list + state ----
const res = await fetch(LIST_URL, { headers: { authorization: `Bearer ${ADMIN_PASSWORD}` } });
if (!res.ok) throw new Error(`list fetch failed: ${res.status}`);
const { repos } = await res.json();

let state = {};
try { state = JSON.parse(await readFile("state.json", "utf8")); } catch {}

// ---- latest release fetchers ----
async function latestViaAtom(repo) {
  const r = await fetch(`https://github.com/${repo}/releases.atom`);
  if (!r.ok) throw new Error(`${repo}: atom ${r.status}`);
  const xml = await r.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entry) return null; // no releases yet
  const e = entry[1];
  const id = e.match(/<id>(.*?)<\/id>/)?.[1];
  const url = e.match(/<link[^>]*href="(.*?)"/)?.[1];
  const title = (e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim();
  return id ? { id, url, title } : null;
}

async function latestViaApi(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=1`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(GITHUB_TOKEN && { authorization: `Bearer ${GITHUB_TOKEN}` }),
    },
  });
  if (!r.ok) throw new Error(`${repo}: api ${r.status}`);
  const [rel] = await r.json();
  return rel ? { id: String(rel.id), url: rel.html_url, title: rel.name || rel.tag_name } : null;
}

const latest = USE_API === "1" ? latestViaApi : latestViaAtom;

// ---- notify ----
async function notify(repo, rel) {
  await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: `New release: ${repo}`,
      message: rel.title || "New release published",
      click: rel.url,
      tags: ["package"],
    }),
  });
}

// ---- main loop ----
for (const repo of repos) {
  try {
    const rel = await latest(repo);
    if (!rel) continue;
    const seen = state[repo];
    if (seen === undefined) {
      state[repo] = rel.id; // first sight: record silently, don't spam
    } else if (seen !== rel.id) {
      await notify(repo, rel);
      state[repo] = rel.id;
      console.log(`notified: ${repo} -> ${rel.title}`);
    }
  } catch (err) {
    console.error(String(err)); // one bad repo shouldn't kill the run
  }
}

// drop repos that were removed from the list
for (const k of Object.keys(state)) if (!repos.includes(k)) delete state[k];

await writeFile("state.json", JSON.stringify(state, null, 2) + "\n");
