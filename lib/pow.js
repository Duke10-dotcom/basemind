import { createHash, randomBytes } from "node:crypto";

// Difficulty = number of leading zero bits the share hash must have.
// Rewards are proportional to work, like a real mining pool: a share at
// BASE_DIFFICULTY pays CREDITS_PER_SHARE, and each extra bit doubles work and reward.
// Default: 1 credit = 2^32 ≈ 4.3 billion hashes, so most shares pay a fraction of a credit.
export const BASE_DIFFICULTY = clamp(parseInt(process.env.MINING_DIFFICULTY || "32", 10), 8, 40);
export const CREDITS_PER_SHARE = clamp(parseInt(process.env.CREDITS_PER_SHARE || "1", 10), 1, 1000);
export const MIN_DIFFICULTY = Math.min(22, BASE_DIFFICULTY + 2);
export const MAX_DIFFICULTY = 40; // GPU miner checks up to 40 bits
export const DIFFICULTY = MIN_DIFFICULTY; // default when the miner doesn't ask for one
export const CHALLENGE_TTL = 900; // seconds a challenge stays valid
export const MAX_SHARES_PER_MINUTE = 60;

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function pickDifficulty(requested) {
  const d = parseInt(requested, 10);
  if (Number.isNaN(d)) return DIFFICULTY;
  return clamp(d, MIN_DIFFICULTY, Math.max(MIN_DIFFICULTY, MAX_DIFFICULTY));
}

export function rewardFor(difficulty) {
  return CREDITS_PER_SHARE * 2 ** (difficulty - BASE_DIFFICULTY);
}

// Credits are fractional; keep 8 decimal places like a real coin.
export function roundCredits(n) {
  return Math.round(Number(n || 0) * 1e8) / 1e8;
}

export function newSeed() {
  return randomBytes(16).toString("hex");
}

export function newId() {
  return randomBytes(12).toString("hex");
}

// The share hash: sha256(utf8(seed + ":" + nonce)). Must match the miners in public/.
export function shareHash(seed, nonce) {
  return createHash("sha256").update(`${seed}:${nonce}`, "utf8").digest();
}

export function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function isValidShare(seed, nonce, difficulty) {
  if (!/^\d{1,16}$/.test(String(nonce))) return false;
  return leadingZeroBits(shareHash(seed, String(nonce))) >= difficulty;
}
