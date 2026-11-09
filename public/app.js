// Basemind front end: wallet sign-in on Base, multi-threaded browser miner, stats.

const $ = (id) => document.getElementById(id);
const BASE = { chainId: "0x2105", chainName: "Base", rpcUrls: ["https://mainnet.base.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://basescan.org"] };
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
// Credits are fractional (like a real coin): show more decimals for small amounts.
const fmtC = (n) => {
  n = Number(n || 0);
  const d = n === 0 ? 0 : n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
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
  $("m-credits").textContent = fmtC(me.credits);
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

const MIN_D = 22, TARGET_SECONDS = 15;
const maxD = () => (device === "gpu" ? 40 : 32); // the CPU miner checks 32 bits, the GPU miner 40
let device = "cpu";
let gpu = { available: false, name: "" };

// Probe for WebGPU once, in a throwaway worker.
(function probeGpu() {
  if (!("gpu" in navigator)) return setDeviceNote();
  const w = new Worker("/gpu.worker.js");
  w.onmessage = (e) => {
    if (e.data.type === "ready") {
      gpu = { available: true, name: e.data.name || "GPU" };
      device = "gpu";
    }
    w.terminate();
    setDeviceNote();
  };
  w.onerror = () => { w.terminate(); setDeviceNote(); };
  w.postMessage({ type: "init" });
})();

function setDeviceNote() {
  $("dev-gpu").disabled = !gpu.available;
  $("dev-gpu").classList.toggle("on", device === "gpu");
  $("dev-cpu").classList.toggle("on", device === "cpu");
  $("threads-wrap").hidden = device === "gpu";
  $("device-note").textContent =
    device === "gpu"
      ? `Mining on your GPU (${gpu.name}) with WebGPU.`
      : gpu.available
        ? "Mining on your CPU. Switch to GPU for much more speed."
        : "No WebGPU in this browser, so mining runs on your CPU. Lower the threads if your device gets warm.";
}

function setDevice(next) {
  if (next === device || (next === "gpu" && !gpu.available)) return;
  device = next;
  setDeviceNote();
  if (miner.running) {
    miner.rate = 0;
    miner.spawn().then(() => miner.restart());
  }
}

// Ask for a puzzle that takes ~10 s at the current hashrate.
function wantedDifficulty() {
  const rate = miner.rate || (device === "gpu" ? 2e6 : 1e6 * miner.workers.length);
  const d = Math.ceil(Math.log2(Math.max(1, rate * TARGET_SECONDS)));
  return Math.max(MIN_D, Math.min(maxD(), d));
}

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
    await this.spawn();
    const r = await api("/api/mine/challenge", { method: "POST", body: { difficulty: wantedDifficulty() } });
    if (r.status === 401) return signOut();
    if (!r.ok) {
      this.stop();
      return toast(r.data.error || "Could not start mining");
    }
    this.dispatch(r.data.challenge);
    setState("Mining", true);
    log(`Mining started on ${device === "gpu" ? "GPU" : `CPU (${this.workers.length} threads)`}`);
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

  async spawn() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    if (device === "gpu") {
      const w = new Worker("/gpu.worker.js");
      const ok = await new Promise((resolve) => {
        w.onmessage = (e) => resolve(e.data.type === "ready");
        w.onerror = () => resolve(false);
        w.postMessage({ type: "init" });
      });
      if (ok) {
        w.onmessage = (e) => this.onMessage(e.data);
        this.workers = [w];
        return;
      }
      w.terminate();
      gpu.available = false;
      device = "cpu";
      setDeviceNote();
      log("GPU unavailable, switched to CPU", "bad");
    }
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
    this.startedAt = Date.now();
    if (ch.reward) {
      $("per-share").textContent = fmtC(ch.reward);
      this.creditsPerHash = ch.reward / 2 ** ch.difficulty;
    }
    const step = this.workers.length;
    // Random start so two tabs on the same wallet don't repeat each other's work.
    const base = Math.floor(Math.random() * 1e9) * step;
    this.workers.forEach((w, i) => w.postMessage({ type: "job", id: ch.id, seed: ch.seed, difficulty: ch.difficulty, start: base + i, step }));
  },

  onMessage(msg) {
    if (msg.type === "progress" || msg.type === "found") this.hashes += msg.hashes;
    if (msg.type === "error") {
      log(`GPU problem (${msg.error}), switching to CPU`, "bad");
      gpu.available = false;
      device = "cpu";
      setDeviceNote();
      if (this.running) this.spawn().then(() => this.restart());
      return;
    }
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
      r = await api("/api/mine/submit", { method: "POST", body: { id, nonce, next: wantedDifficulty() } });
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
      log(`Share accepted  +${fmtC(r.data.earned)} credits`, "good");
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
    const r = await api("/api/mine/challenge", { method: "POST", body: { difficulty: wantedDifficulty() } });
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
  $("m-session").textContent = fmtC(miner.session);
  const est = miner.running && miner.creditsPerHash ? miner.rate * 3600 * miner.creditsPerHash : 0;
  $("est").textContent = est ? `≈ ${fmtC(est)} credits/hour at this speed.` : "";
}

// Hashrate sampling once a second.
setInterval(() => {
  const h = miner.hashes;
  miner.hashes = 0;
  miner.rate = miner.running ? miner.rate * 0.6 + h * 0.4 : 0;
  miner.history.push(miner.running ? h : 0);
  if (miner.history.length > 60) miner.history.shift();
  renderMiner();
  // If this puzzle is far too hard for the measured speed, swap it for an easier one.
  const ch = miner.challenge;
  if (miner.running && ch && miner.rate > 0 && Date.now() - miner.startedAt > 3 * TARGET_SECONDS * 1000 && wantedDifficulty() < ch.difficulty) {
    miner.challenge = null;
    miner.workers.forEach((w) => w.postMessage({ type: "stop" }));
    log("Tuning puzzle size to your device…");
    miner.restart();
  }
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
  $("s-credits").textContent = fmtC(stats.credits);
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
    li.innerHTML = `<span class="addr"></span><span>${fmtC(row.credits)} credits</span>`;
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
  if (!miner.running || device !== "cpu") return;
  miner.spawn().then(() => miner.restart());
};
$("dev-gpu").onclick = () => setDevice("gpu");
$("dev-cpu").onclick = () => setDevice("cpu");
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
