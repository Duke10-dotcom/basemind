import { pipeline } from "../lib/redis.js";
import { route, send, sessionAddress } from "../lib/http.js";

export default route(["GET"], async (req, res) => {
  const addr = await sessionAddress(req);
  if (!addr) return send(res, 401, { error: "Not signed in" });
  const [credits, shares, rank, votes] = await pipeline([
    ["ZSCORE", "leaderboard", addr],
    ["GET", `shares:${addr}`],
    ["ZREVRANK", "leaderboard", addr],
    ["SMEMBERS", `votes:${addr}`],
  ]);
  send(res, 200, {
    address: addr,
    credits: Math.round(Number(credits || 0)),
    shares: Number(shares || 0),
    rank: rank === null || rank === undefined ? null : Number(rank) + 1,
    votes: votes || [],
  });
});
