import { redis, pipeline } from "../../lib/redis.js";
import { route, send, body, sessionAddress } from "../../lib/http.js";
import { isValidShare, rewardFor, MAX_SHARES_PER_MINUTE } from "../../lib/pow.js";
import { issueChallenge } from "../../lib/challenge.js";

// The miner found a solution. Check it, pay credits, and hand out the next puzzle.
// `next` is the difficulty the miner wants for its next puzzle.
export default route(["POST"], async (req, res) => {
  const addr = await sessionAddress(req);
  if (!addr) return send(res, 401, { error: "Please sign in again" });

  const { id, nonce, next } = body(req);
  if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) return send(res, 400, { error: "Bad challenge id" });

  // GETDEL makes every puzzle single-use, so the same answer can't be paid twice.
  const raw = await redis("GETDEL", `ch:${id}`);
  if (!raw) return send(res, 409, { error: "Puzzle expired", challenge: await issueChallenge(addr, next) });
  const ch = JSON.parse(raw);
  if (ch.addr !== addr) return send(res, 403, { error: "Puzzle belongs to another wallet" });

  if (!isValidShare(ch.seed, nonce, ch.difficulty)) {
    return send(res, 400, { error: "Invalid share", challenge: await issueChallenge(addr, next) });
  }

  const minute = Math.floor(Date.now() / 60000);
  const rateKey = `rate:${addr}:${minute}`;
  const [count] = await pipeline([
    ["INCR", rateKey],
    ["EXPIRE", rateKey, 120],
  ]);
  if (Number(count) > MAX_SHARES_PER_MINUTE) {
    return send(res, 429, { error: "Slow down", challenge: await issueChallenge(addr, next) });
  }

  const earned = rewardFor(ch.difficulty);
  const [total] = await pipeline([
    ["ZINCRBY", "leaderboard", earned, addr],
    ["INCRBY", "stats:credits", earned],
    ["INCR", "stats:shares"],
    ["INCR", `shares:${addr}`],
  ]);

  send(res, 200, {
    ok: true,
    earned,
    credits: Math.round(Number(total)),
    challenge: await issueChallenge(addr, next),
  });
});
