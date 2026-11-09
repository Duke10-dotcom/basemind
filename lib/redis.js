// Tiny Upstash Redis client over its REST API (no extra packages needed).
// Works with Vercel's "Upstash for Redis" integration (KV_REST_API_* vars)
// or a direct Upstash database (UPSTASH_REDIS_REST_* vars).

let override = null;

// Used by tests to swap in an in-memory database.
export function setRedis(fn) {
  override = fn;
}

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Database not connected. Add Upstash Redis in your Vercel project (see DEPLOY.md).");
  }
  return { url: url.replace(/\/$/, ""), token };
}

export async function redis(...cmd) {
  if (override) return override(cmd.map(String));
  const { url, token } = config();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// Run several commands in one round trip. Returns an array of results.
export async function pipeline(cmds) {
  if (override) {
    const out = [];
    for (const c of cmds) out.push(await override(c.map(String)));
    return out;
  }
  const { url, token } = config();
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
  });
  const data = await res.json();
  return data.map((d) => {
    if (d.error) throw new Error(d.error);
    return d.result;
  });
}
