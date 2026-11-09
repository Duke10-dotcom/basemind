import { pipeline } from "../lib/redis.js";
import { route, send } from "../lib/http.js";
import { RECIPES } from "../lib/recipes.js";

// Public numbers + top 10 miners + recipe waitlist counts, in one call.
export default route(["GET"], async (req, res) => {
  const results = await pipeline([
    ["SCARD", "miners"],
    ["GET", "stats:credits"],
    ["GET", "stats:shares"],
    ["ZREVRANGE", "leaderboard", 0, 9, "WITHSCORES"],
    ["SCARD", "waitlist"],
    ...RECIPES.map((r) => ["SCARD", `recipe:${r.id}`]),
  ]);
  const [miners, credits, shares, top, waitlist, ...recipeCounts] = results;

  const leaderboard = [];
  for (let i = 0; i < (top || []).length; i += 2) {
    leaderboard.push({ address: top[i], credits: Math.round(Number(top[i + 1])) });
  }

  res.setHeader("Cache-Control", "s-maxage=5");
  send(res, 200, {
    miners: Number(miners || 0),
    credits: Number(credits || 0),
    shares: Number(shares || 0),
    waitlist: Number(waitlist || 0),
    leaderboard,
    recipes: RECIPES.map((r, i) => ({ ...r, votes: Number(recipeCounts[i] || 0) })),
  });
});
