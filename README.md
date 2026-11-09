# Basemind

Mine credits in your browser. Spend them to train your own AI model. Built on Base.

**MVP (live now):** wallet sign-in on Base (free signature, works with regular and smart wallets),
multi-threaded in-browser SHA-256 miner, server-verified shares, credits, leaderboard, and a
training-recipe waitlist. **Next:** GPU fine-tuning runs paid with credits, then chatting with your model.

## How mining works

1. The server hands a signed-in wallet a random puzzle (`seed`, `difficulty`).
2. Web Workers search for a `nonce` where `sha256(seed + ":" + nonce)` starts with `difficulty` zero bits.
3. The server re-checks the hash, deletes the puzzle (single use), and pays credits.
4. Puzzles are tied to one wallet and expire after 15 minutes; shares are rate-limited per minute.

Credits are off-chain points stored in Redis, not a token.

## Project layout

```
public/          the website (index.html, app.js, styles.css, miner.worker.js)
api/             Vercel serverless functions
  auth/nonce.js    build the sign-in message
  auth/verify.js   check signature, start session
  mine/challenge.js new puzzle
  mine/submit.js   check a share, pay credits, next puzzle
  me.js            your credits, rank, votes
  stats.js         public totals, leaderboard, recipe votes
  waitlist.js      vote for a training recipe
lib/             shared helpers (Redis REST client, proof-of-work, signature check)
test/            tests and a local dev server
```

## Run locally

```
npm test                 # unit + end-to-end API tests (no database needed)
node test/devserver.js   # http://localhost:3000 with an in-memory database
```

Deploying: see [DEPLOY.md](DEPLOY.md).
