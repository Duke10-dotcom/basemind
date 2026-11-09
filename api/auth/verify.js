import { randomBytes } from "node:crypto";
import { redis, pipeline } from "../../lib/redis.js";
import { route, send, body, isAddress } from "../../lib/http.js";
import { verifySignature } from "../../lib/verify.js";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

// Step 2 of wallet sign-in: check the signature, then hand back a session token.
export default route(["POST"], async (req, res) => {
  const { address, signature } = body(req);
  if (!isAddress(address) || typeof signature !== "string" || !signature.startsWith("0x")) {
    return send(res, 400, { error: "Missing address or signature" });
  }
  const addr = address.toLowerCase();
  const message = await redis("GETDEL", `login:${addr}`);
  if (!message) return send(res, 400, { error: "Sign-in expired. Please try again." });

  const ok = await verifySignature({ address, message, signature });
  if (!ok) return send(res, 401, { error: "Signature check failed" });

  const token = randomBytes(32).toString("hex");
  await pipeline([
    ["SET", `session:${token}`, addr, "EX", SESSION_TTL],
    ["SADD", "miners", addr],
    ["SETNX", `joined:${addr}`, Date.now()],
  ]);
  send(res, 200, { token, address: addr });
});
