import { redis } from "./redis.js";

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export function isAddress(a) {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

// Returns the signed-in wallet address (lowercase) or null.
export async function sessionAddress(req) {
  const header = req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return (await redis("GET", `session:${token}`)) || null;
}

// Wraps a handler: method check + error handling so the app never shows a raw crash.
export function route(methods, fn) {
  return async (req, res) => {
    if (!methods.includes(req.method)) return send(res, 405, { error: "Method not allowed" });
    try {
      await fn(req, res);
    } catch (err) {
      console.error(err);
      send(res, 500, { error: err.message || "Server error" });
    }
  };
}
