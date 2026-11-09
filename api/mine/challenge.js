import { route, send, sessionAddress } from "../../lib/http.js";
import { issueChallenge } from "../../lib/challenge.js";

// Gives the signed-in miner a fresh puzzle to work on.
export default route(["POST"], async (req, res) => {
  const addr = await sessionAddress(req);
  if (!addr) return send(res, 401, { error: "Please sign in again" });
  send(res, 200, { challenge: await issueChallenge(addr) });
});
