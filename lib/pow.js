import { createHash, randomBytes } from "node:crypto";

// Difficulty = number of leading zero bits the share hash must have.
// 20 bits ≈ 1 million hashes on average, a few seconds on a laptop.
export const DIFFICULTY = clamp(parseInt(process.env.MINING_DIFFICULTY || "20", 10), 8, 30);
export const CREDITS_PER_SHARE = clamp(parseInt(process.env.CREDITS_PER_SHARE || "10", 10), 1, 1000);
export const CHALLENGE_TTL = 900; // seconds a challenge stays valid
export const MAX_SHARES_PER_MINUTE = 60;

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function newSeed() {
  return randomBytes(16).toString("hex");
}

export function newId() {
  return randomBytes(12).toString("hex");
}

// The share hash: sha256(utf8(seed + ":" + nonce)). Must match public/miner.worker.js.
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
