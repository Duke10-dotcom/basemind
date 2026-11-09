import { pipeline } from "../lib/redis.js";
import { route, send, sessionAddress } from "../lib/http.js";
import { roundCredits } from "../lib/pow.js";

export default route(["GET"], async (req, res) => {
  const addr = await sessionAddress(req);
  if (!addr) return send(res, 401, { error: "Not signed in" });
  const [mined, spent, shares, rank, votes, runs] = await pipeline([
    ["ZSCORE", "leaderboard", addr],
    ["HGET", "spent", addr],
    ["GET", `shares:${addr}`],
    ["ZREVRANK", "leaderboard", addr],
    ["SMEMBERS", `votes:${addr}`],
    ["LRANGE", `runs:${addr}`, 0, 49],
  ]);
  send(res, 200, {
    address: addr,
    credits: roundCredits(Number(mined || 0) - Number(spent || 0)), // spendable balance
    mined: roundCredits(mined),
    shares: Number(shares || 0),
    rank: rank === null || rank === undefined ? null : Number(rank) + 1,
    votes: votes || [],
    runs: (runs || []).map((r) => JSON.parse(r)),
  });
});
