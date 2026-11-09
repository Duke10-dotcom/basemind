import { route, send, body, sessionAddress } from "../../lib/http.js";
import { issueChallenge } from "../../lib/challenge.js";

// Gives the signed-in miner a fresh puzzle to work on.
export default route(["POST"], async (req, res) => {
  const addr = await sessionAddress(req);
  if (!addr) return send(res, 401, { error: "Please sign in again" });
  const { difficulty } = body(req);
  send(res, 200, { challenge: await issueChallenge(addr, difficulty) });
});
