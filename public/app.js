// Basemind front end: wallet sign-in on Base, multi-threaded browser miner, stats.

const $ = (id) => document.getElementById(id);
const BASE = { chainId: "0x2105", chainName: "Base", rpcUrls: ["https://mainnet.base.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://basescan.org"] };
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---------- session ----------
let session = loadSession();

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem("basemind.session")) || null;
  } catch {
    return null;
  }
}
function saveSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem("basemind.session", JSON.stringify(s));
    else localStorage.removeItem("basemind.session");
  } catch {}
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, data };
}

function toast(msg, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- wallet ----------
function toHex(str) {
  return "0x" + Array.from(new TextEncoder().encode(str), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function connect() {
  const eth = window.ethereum;
  if (!eth) {
    $("no-wallet").hidden = false;
    toast("No wallet found in this browser");
    return;
  }
  try {
    const [address] = await eth.request({ method: "eth_requestAccounts" });
    if (!address) return;

    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE.chainId }] });
    } catch (err) {
      if (err?.code === 4902) {
        await eth.request({ method: "wallet_addEthereumChain", params: [BASE] }).catch(() => {});
      }
    }

    const nonce = await api(`/api/auth/nonce?address=${address}`);
    if (!nonce.ok) throw new Error(nonce.data.error || "Could not start sign-in");

    const signature = await eth.request({ method: "personal_sign", params: [toHex(nonce.data.message), address] });
    const verify = await api("/api/auth/verify", { method: "POST", body: { address, signature } });
    if (!verify.ok) throw new Error(verify.data.error || "Sign-in failed");

    saveSession({ token: verify.data.token, address: verify.data.address });
    toast("Signed in. Hit Start mining.");
    await refreshMe();
    render();
  } catch (err) {
    if (err?.code === 4001) toast("Request cancelled in wallet");
    else toast(err.message || "Something went wrong");
  }
}

function signOut() {
  miner.stop();
  saveSession(null);
  me = { credits: 0, shares: 0, rank: null, votes: [] };
  renderMe();
  render();
}

// ---------- account ----------
let me = { credits: 0, shares: 0, rank: null, votes: [] };

async function refreshMe() {
  if (!session) return;
  const r = await api("/api/me");
  if (r.status === 401) return signOut();
  if (r.ok) me = r.data;
  renderMe();
}

function renderMe() {
  $("m-credits").textContent = fmt(me.credits);
  $("m-shares").textContent = fmt(me.shares);
  $("m-rank").textContent = me.rank ? `rank #${me.rank}` : "unranked";
}

function render() {
  const signedIn = !!session;
  $("signed-out").hidden = signedIn;
  $("signed-in").hidden = !signedIn;
  const btn = $("connect");
  btn.textContent = signedIn ? short(session.address) : "Connect wallet";
  btn.title = signedIn ? "Click to sign out" : "";
  btn.className = signedIn ? "btn" : "btn btn-primary";
  renderRecipes();
  renderLeaderboard();
}

// ---------- miner ----------
const cores = navigator.hardwareConcurrency || 4;
const threadsInput = $("threads");
threadsInput.max = String(Math.max(1, cores));
threadsInput.value = String(Math.max(1, Math.min(cores - 1, Math.floor(cores / 2)) || 1));
$("threads-val").textContent = threadsInput.value;

const miner = {
  running: false,
  workers: [],
  challenge: null,
  hashes: 0,
  rate: 0,
  session: 0,
  history: [],
  flash: 0,

  async start() {
    if (this.running) return;
    this.running = true;
    setState("Starting…");
    const r = await api("/api/mine/challenge", { method: "POST" });
    if (r.status === 401) return signOut();
    if (!r.ok) {
      this.running = false;
      setState("Idle");
      return toast(r.data.error || "Could not start mining");
    }
    this.spawn();
    this.dispatch(r.data.challenge);
    setState("Mining", true);
    log("Mining started");
  },

  stop() {
    this.running = false;
    this.challenge = null;
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.rate = 0;
    setState("Idle");
    renderMiner();
  },

  spawn() {
    this.workers.forEach((w) => w.terminate());
    const n = Number(threadsInput.value);
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker("/miner.worker.js");
      w.onmessage = (e) => this.onMessage(e.data);
      return w;
    });
  },

  dispatch(ch) {
    if (!this.running || !ch) return;
    this.challenge = ch;
    if (ch.reward) $("per-share").textContent = fmt(ch.reward);
    const step = this.workers.length;
    // Random start so two tabs on the same wallet don't repeat each other's work.
    const base = Math.floor(Math.random() * 1e9) * step;
    this.workers.forEach((w, i) => w.postMessage({ type: "job", id: ch.id, seed: ch.seed, difficulty: ch.difficulty, start: base + i, step }));
  },

  onMessage(msg) {
    if (msg.type === "progress" || msg.type === "found") this.hashes += msg.hashes;
    if (msg.type === "found" && this.challenge && msg.id === this.challenge.id) {
      const id = this.challenge.id;
      this.challenge = null;
      this.workers.forEach((w) => w.postMessage({ type: "stop" }));
      this.submit(id, msg.nonce);
    }
  },

  async submit(id, nonce) {
    let r;
    try {
      r = await api("/api/mine/submit", { method: "POST", body: { id, nonce } });
    } catch {
      log("Network hiccup, retrying…", "bad");
      setTimeout(() => this.running && this.restart(), 3000);
      return;
    }
    if (r.status === 401) return signOut();
    if (r.ok) {
      this.session += r.data.earned;
      this.flash = 1;
      me.credits = r.data.credits;
      me.shares += 1;
      renderMe();
      log(`Share accepted  +${r.data.earned} credits`, "good");
      if (me.shares % 5 === 1) refreshStats();
    } else {
      log(r.data.error || "Share rejected", "bad");
    }
    if (r.status === 429) {
      // Too many shares this minute: cool down before mining again.
      setState("Cooling down", true);
      setTimeout(() => {
        if (!this.running) return;
        setState("Mining", true);
        this.dispatch(r.data.challenge);
      }, 20000);
      return;
    }
    if (r.data.challenge) this.dispatch(r.data.challenge);
    else setTimeout(() => this.running && this.restart(), 3000);
  },

  async restart() {
    const r = await api("/api/mine/challenge", { method: "POST" });
    if (r.ok) this.dispatch(r.data.challenge);
    else setTimeout(() => this.running && this.restart(), 5000);
  },
};

function setState(text, on = false) {
  const el = $("miner-state");
  el.textContent = text;
  el.classList.toggle("on", on);
  const t = $("toggle");
  t.textContent = miner.running ? "Stop mining" : "Start mining";
  t.className = miner.running ? "btn btn-big btn-stop" : "btn btn-primary btn-big";
}

function log(text, cls = "") {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  if (cls) li.className = cls;
  const list = $("log");
  list.prepend(li);
  while (list.children.length > 30) list.lastChild.remove();
}

function renderMiner() {
  $("m-rate").textContent = miner.rate >= 1e6 ? `${(miner.rate / 1e6).toFixed(2)}M` : miner.rate >= 1e3 ? `${(miner.rate / 1e3).toFixed(0)}k` : String(Math.round(miner.rate));
  $("m-session").textContent = fmt(miner.session);
}

// Hashrate sampling once a second.
setInterval(() => {
  const h = miner.hashes;
  miner.hashes = 0;
  miner.rate = miner.running ? miner.rate * 0.6 + h * 0.4 : 0;
  miner.history.push(miner.running ? h : 0);
  if (miner.history.length > 60) miner.history.shift();
  renderMiner();
}, 1000);

// Little live activity chart.
const canvas = $("viz");
function draw() {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const data = miner.history;
  const max = Math.max(1, ...data);
  const bw = w / 60;
  data.forEach((v, i) => {
    const bh = (v / max) * (h - 16);
    const x = w - (data.length - i) * bw;
    ctx.fillStyle = i === data.length - 1 ? "#5ce1e6" : "rgba(61,123,255,0.75)";
    ctx.fillRect(x + 1, h - bh - 4, bw - 2, bh);
  });
  if (miner.flash > 0) {
    ctx.fillStyle = `rgba(62,224,143,${miner.flash * 0.25})`;
    ctx.fillRect(0, 0, w, h);
    miner.flash = Math.max(0, miner.flash - 0.03);
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ---------- stats, leaderboard, recipes ----------
let stats = null;

async function refreshStats() {
  const r = await api("/api/stats").catch(() => null);
  if (!r?.ok) return;
  stats = r.data;
  $("s-miners").textContent = fmt(stats.miners);
  $("s-credits").textContent = fmt(stats.credits);
  $("s-shares").textContent = fmt(stats.shares);
  $("waitlist-count").textContent = stats.waitlist ? `${fmt(stats.waitlist)} on the waitlist.` : "";
  renderLeaderboard();
  renderRecipes();
}

function renderLeaderboard() {
  const list = $("leaderboard");
  if (!stats) return;
  if (!stats.leaderboard.length) {
    list.innerHTML = '<li class="empty">No miners yet. Be the first.</li>';
    return;
  }
  list.innerHTML = "";
  for (const row of stats.leaderboard) {
    const li = document.createElement("li");
    if (session && row.address === session.address) li.className = "me";
    li.innerHTML = `<span class="addr"></span><span>${fmt(row.credits)} credits</span>`;
    li.querySelector(".addr").textContent = short(row.address) + (li.className ? " (you)" : "");
    list.append(li);
  }
}

function renderRecipes() {
  if (!stats) return;
  const wrap = $("recipes");
  wrap.innerHTML = "";
  for (const r of stats.recipes) {
    const voted = me.votes?.includes(r.id);
    const card = document.createElement("div");
    card.className = "recipe";
    card.innerHTML = `<h3></h3><p></p><div class="recipe-foot"><span>${fmt(r.cost)} credits · ${fmt(r.votes)} votes</span><button class="btn btn-small"></button></div>`;
    card.querySelector("h3").textContent = r.name;
    card.querySelector("p").textContent = r.blurb;
    const b = card.querySelector("button");
    b.textContent = voted ? "Voted ✓" : "Vote + join waitlist";
    if (voted) b.classList.add("btn-done");
    b.disabled = voted;
    b.onclick = () => vote(r.id);
    wrap.append(card);
  }
}

async function vote(recipe) {
  if (!session) {
    toast("Connect your wallet to vote");
    return connect();
  }
  const r = await api("/api/waitlist", { method: "POST", body: { recipe } });
  if (r.status === 401) return signOut();
  if (!r.ok) return toast(r.data.error || "Could not save vote");
  me.votes = [...(me.votes || []), recipe];
  toast("You're on the waitlist");
  refreshStats();
}

// ---------- wiring ----------
$("connect").onclick = () => (session ? confirm("Sign out of Basemind?") && signOut() : connect());
document.querySelectorAll("[data-connect]").forEach((b) => (b.onclick = connect));
$("toggle").onclick = () => (miner.running ? miner.stop() : miner.start());
threadsInput.oninput = () => {
  $("threads-val").textContent = threadsInput.value;
};
threadsInput.onchange = () => {
  if (!miner.running) return;
  const ch = miner.challenge;
  miner.spawn();
  if (ch) miner.dispatch(ch);
  else miner.restart();
};
window.ethereum?.on?.("accountsChanged", (accounts) => {
  if (session && accounts[0]?.toLowerCase() !== session.address) signOut();
});
window.addEventListener("beforeunload", (e) => {
  if (miner.running) e.preventDefault();
});

render();
refreshMe();
refreshStats();
setInterval(refreshStats, 15000);
