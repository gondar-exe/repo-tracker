const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

function authed(request, env) {
  const h = request.headers.get("authorization") || "";
  return env.ADMIN_PASSWORD && h === `Bearer ${env.ADMIN_PASSWORD}`;
}

// Accepts "owner/repo" or full github.com URLs, returns clean unique list
function normalize(list) {
  const out = new Set();
  for (const raw of list) {
    const m = String(raw)
      .trim()
      .match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (m) out.add(`${m[1]}/${m[2]}`);
  }
  return [...out];
}

export async function onRequest({ request, env }) {
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);

  if (request.method === "GET") {
    const repos = JSON.parse((await env.REPOS_KV.get("repos")) || "[]");
    return json({ repos });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const repos = normalize(Array.isArray(body.repos) ? body.repos : []);
    await env.REPOS_KV.put("repos", JSON.stringify(repos));
    return json({ repos });
  }

  return json({ error: "method not allowed" }, 405);
}
