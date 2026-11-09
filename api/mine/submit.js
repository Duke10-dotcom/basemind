import { redis, pipeline } from "../../lib/redis.js";
import { route, send, body, sessionAddress } from "../../lib/http.js";
import { isValidShare, CREDITS_PER_SHARE, MAX_SHARES_PER_MINUTE } from "../../lib/pow.js";
import { issueChallenge } from "../../lib/challenge.js";

// The miner found a solution. Check it, pay credits, and hand out the next puzzle.
export default route(["POST"], async (req, res) => {
  const addr = await sessionAddress(req);
  if (!addr) return send(res, 401, { error: "Please sign in again" });

  const { id, nonce } = body(req);
  if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) return send(res, 400, { error: "Bad challenge id" });

  // GETDEL makes every puzzle single-use, so the same answer can't be paid twice.
  const raw = await redis("GETDEL", `ch:${id}`);
  if (!raw) return send(res, 409, { error: "Puzzle expired", challenge: await issueChallenge(addr) });
  const ch = JSON.parse(raw);
  if (ch.addr !== addr) return send(res, 403, { error: "Puzzle belongs to another wallet" });

  if (!isValidShare(ch.seed, nonce, ch.difficulty)) {
    return send(res, 400, { error: "Invalid share", challenge: await issueChallenge(addr) });
  }

  const minute = Math.floor(Date.now() / 60000);
  const rateKey = `rate:${addr}:${minute}`;
  const [count] = await pipeline([
    ["INCR", rateKey],
    ["EXPIRE", rateKey, 120],
  ]);
  if (Number(count) > MAX_SHARES_PER_MINUTE) {
    return send(res, 429, { error: "Slow down", challenge: await issueChallenge(addr) });
  }

  const [total] = await pipeline([
    ["ZINCRBY", "leaderboard", CREDITS_PER_SHARE, addr],
    ["INCRBY", "stats:credits", CREDITS_PER_SHARE],
    ["INCR", "stats:shares"],
    ["INCR", `shares:${addr}`],
  ]);

  send(res, 200, {
    ok: true,
    earned: CREDITS_PER_SHARE,
    credits: Math.round(Number(total)),
    challenge: await issueChallenge(addr),
  });
});
