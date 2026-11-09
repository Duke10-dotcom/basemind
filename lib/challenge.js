import { redis } from "./redis.js";
import { CHALLENGE_TTL, newId, newSeed, pickDifficulty, rewardFor } from "./pow.js";

// `requested` is the difficulty the miner asks for (faster devices ask for harder
// puzzles so they don't flood the server). The server clamps it to the allowed range.
export async function issueChallenge(addr, requested) {
  const challenge = { id: newId(), seed: newSeed(), difficulty: pickDifficulty(requested) };
  await redis(
    "SET",
    `ch:${challenge.id}`,
    JSON.stringify({ ...challenge, addr, t: Date.now() }),
    "EX",
    CHALLENGE_TTL
  );
  return { ...challenge, reward: rewardFor(challenge.difficulty) };
}
