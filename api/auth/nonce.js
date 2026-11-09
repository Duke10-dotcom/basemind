import { randomBytes } from "node:crypto";
import { redis } from "../../lib/redis.js";
import { route, send, isAddress } from "../../lib/http.js";

// Step 1 of wallet sign-in: build a Sign-In With Ethereum message for this wallet.
export default route(["GET"], async (req, res) => {
  const address = String(req.query?.address || "");
  if (!isAddress(address)) return send(res, 400, { error: "Invalid wallet address" });

  const host = req.headers?.host || "basemind.app";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const nonce = randomBytes(8).toString("hex");
  const message = [
    `${host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to Basemind to start mining credits. This is free and does not send a transaction.",
    "",
    `URI: ${proto}://${host}`,
    "Version: 1",
    "Chain ID: 8453",
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");

  await redis("SET", `login:${address.toLowerCase()}`, message, "EX", 300);
  send(res, 200, { message });
});
