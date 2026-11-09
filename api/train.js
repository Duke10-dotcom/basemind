import { redis, pipeline } from "../lib/redis.js";
import { route, send, body, sessionAddress } from "../lib/http.js";
import { RECIPES } from "../lib/recipes.js";
import { roundCredits } from "../lib/pow.js";

// Spend credits to start a training run. The model itself trains in the
// miner's browser on their own GPU; the server only checks and records the spend.
// Balance = credits mined (leaderboard) - credits spent.
export default route(["POST"], async (req, res) => {
  const addr = await sessionAddress(req);
  if (!addr) return send(res, 401, { error: "Sign in to train a model" });
  const recipe = RECIPES.find((r) => r.id === body(req).recipe);
  if (!recipe) return send(res, 400, { error: "Unknown recipe" });

  const [mined] = await pipeline([["ZSCORE", "leaderboard", addr]]);
  const newSpent = Number(await redis("HINCRBYFLOAT", "spent", addr, recipe.cost));
  const balance = roundCredits(Number(mined || 0) - newSpent);
  if (balance < 0) {
    // Not enough: undo the spend.
    await redis("HINCRBYFLOAT", "spent", addr, -recipe.cost);
    return send(res, 402, { error: `Not enough credits. ${recipe.name} costs ${recipe.cost}.`, credits: roundCredits(Number(mined || 0) - newSpent + recipe.cost) });
  }

  const run = { id: Date.now().toString(36), recipe: recipe.id, cost: recipe.cost, t: Date.now() };
  await pipeline([
    ["LPUSH", `runs:${addr}`, JSON.stringify(run)],
    ["LTRIM", `runs:${addr}`, 0, 49],
    ["INCR", "stats:runs"],
    ["INCR", `stats:runs:${recipe.id}`],
  ]);
  send(res, 200, { ok: true, run, credits: balance });
});
