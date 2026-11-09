import { pipeline } from "../lib/redis.js";
import { route, send, body, sessionAddress } from "../lib/http.js";
import { RECIPES } from "../lib/recipes.js";

// Miner votes for a recipe and joins the training waitlist.
export default route(["POST"], async (req, res) => {
  const addr = await sessionAddress(req);
  if (!addr) return send(res, 401, { error: "Sign in to join the waitlist" });
  const { recipe } = body(req);
  if (!RECIPES.some((r) => r.id === recipe)) return send(res, 400, { error: "Unknown recipe" });
  await pipeline([
    ["SADD", "waitlist", addr],
    ["SADD", `recipe:${recipe}`, addr],
    ["SADD", `votes:${addr}`, recipe],
  ]);
  send(res, 200, { ok: true });
});
