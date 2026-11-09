import { redis } from "./redis.js";
import { DIFFICULTY, CHALLENGE_TTL, CREDITS_PER_SHARE, newId, newSeed } from "./pow.js";

export async function issueChallenge(addr) {
  const challenge = { id: newId(), seed: newSeed(), difficulty: DIFFICULTY };
  await redis(
    "SET",
    `ch:${challenge.id}`,
    JSON.stringify({ ...challenge, addr, t: Date.now() }),
    "EX",
    CHALLENGE_TTL
  );
  return { ...challenge, reward: CREDITS_PER_SHARE };
}
