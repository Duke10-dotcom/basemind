// Verifies a wallet signature. Uses a Base public client so it works for
// regular wallets (MetaMask, Rabby) AND smart wallets (Coinbase Smart Wallet),
// which sign with ERC-1271 / ERC-6492 instead of a plain signature.

let override = null;

export function setVerifier(fn) {
  override = fn;
}

let client = null;

export async function verifySignature({ address, message, signature }) {
  if (override) return override({ address, message, signature });
  if (!client) {
    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");
    client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
  }
  try {
    return await client.verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}
