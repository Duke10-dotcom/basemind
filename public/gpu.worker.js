// Basemind GPU miner. Runs SHA-256 proof-of-work on the graphics card with WebGPU.
// Same puzzle as the CPU miner: sha256(seed + ":" + nonce) must start with
// `difficulty` zero bits. The GPU uses fixed 16-digit nonces: 8 "high" digits set
// here, 8 "low" digits computed by each GPU thread.

const SHADER = /* wgsl */ `
struct Params {
  w: array<vec4<u32>, 4>,   // the 16 message words, with the low-digit bytes left as zero
  startLow: u32,
  iters: u32,
  mask: u32,               // zero-bit mask for hash word 0
  limit: u32,               // stop before this low value (keeps 8 digits)
  mask1: u32,               // zero-bit mask for hash word 1 (difficulty > 32)
  pad0: u32, pad1: u32, pad2: u32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> result: array<atomic<u32>, 2>;

const K = array<u32, 64>(
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
);

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

fn digit(v: u32, div: u32) -> u32 { return (v / div) % 10u + 48u; }

fn hash2(low: u32) -> vec2<u32> {
  var W: array<u32, 64>;
  for (var i = 0u; i < 16u; i++) { W[i] = P.w[i / 4u][i % 4u]; }
  // bytes 41..48 hold the 8 low digits (most significant first)
  W[10] = W[10] | (digit(low, 10000000u) << 16u) | (digit(low, 1000000u) << 8u) | digit(low, 100000u);
  W[11] = (digit(low, 10000u) << 24u) | (digit(low, 1000u) << 16u) | (digit(low, 100u) << 8u) | digit(low, 10u);
  W[12] = W[12] | (digit(low, 1u) << 24u);
  for (var i = 16u; i < 64u; i++) {
    let s0 = rotr(W[i - 15u], 7u) ^ rotr(W[i - 15u], 18u) ^ (W[i - 15u] >> 3u);
    let s1 = rotr(W[i - 2u], 17u) ^ rotr(W[i - 2u], 19u) ^ (W[i - 2u] >> 10u);
    W[i] = W[i - 16u] + s0 + W[i - 7u] + s1;
  }
  var a = 0x6a09e667u; var b = 0xbb67ae85u; var c = 0x3c6ef372u; var d = 0xa54ff53au;
  var e = 0x510e527fu; var f = 0x9b05688cu; var g = 0x1f83d9abu; var h = 0x5be0cd19u;
  for (var i = 0u; i < 64u; i++) {
    let S1 = rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u);
    let ch = (e & f) ^ (~e & g);
    let t1 = h + S1 + ch + K[i] + W[i];
    let S0 = rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u);
    let maj = (a & b) ^ (a & c) ^ (b & c);
    let t2 = S0 + maj;
    h = g; g = f; f = e; e = d + t1;
    d = c; c = b; b = a; a = t1 + t2;
  }
  return vec2<u32>(0x6a09e667u + a, 0xbb67ae85u + b);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let base = P.startLow + gid.x * P.iters;
  for (var k = 0u; k < P.iters; k++) {
    let low = base + k;
    if (low >= P.limit) { return; }
    let hw = hash2(low);
    if ((hw.x & P.mask) == 0u && (hw.y & P.mask1) == 0u) {
      atomicMin(&result[1], low);
      atomicStore(&result[0], 1u);
    }
  }
}
`;

const WORKGROUPS = 8192;
const THREADS = WORKGROUPS * 64;
const LOW_MAX = 100000000; // 8 decimal digits
const TARGET_MS = 250;     // long passes keep the GPU fully busy

let device, pipeline;
let slots = [];            // two passes in flight at once, so the GPU never waits on us
let job = null;
let runToken = 0;
let iters = 8;
let running = Promise.resolve();

async function init() {
  if (!self.navigator?.gpu) throw new Error("WebGPU not supported in this browser");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter available");
  device = await adapter.requestDevice();
  device.lost.then(() => postMessage({ type: "error", error: "GPU device lost" }));
  const module = device.createShaderModule({ code: SHADER });
  const info = await module.getCompilationInfo?.();
  const errs = info?.messages?.filter((m) => m.type === "error") || [];
  if (errs.length) throw new Error("Shader error: " + errs[0].message);
  pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
  slots = [0, 1].map(() => {
    const param = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const result = device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const read = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: param } },
        { binding: 1, resource: { buffer: result } },
      ],
    });
    return { param, result, read, bind, promise: null };
  });
  return adapter.info?.description || adapter.info?.vendor || "GPU";
}

// Message = seed(32 hex) ":" high(8 digits) low(8 digits) → 49 bytes, one SHA-256 block.
function messageWords(seed, high) {
  const bytes = new Uint8Array(64);
  const prefix = `${seed}:${high}`;
  for (let i = 0; i < prefix.length; i++) bytes[i] = prefix.charCodeAt(i);
  // bytes 41..48 are the low digits, filled in on the GPU
  bytes[49] = 0x80;
  const bitLen = 49 * 8;
  bytes[62] = (bitLen >>> 8) & 0xff;
  bytes[63] = bitLen & 0xff;
  const w = new Uint32Array(16);
  for (let i = 0; i < 16; i++) w[i] = ((bytes[i * 4] << 24) | (bytes[i * 4 + 1] << 16) | (bytes[i * 4 + 2] << 8) | bytes[i * 4 + 3]) >>> 0;
  return w;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function zeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) { bits += 8; continue; }
    return bits + Math.clz32(b) - 24;
  }
  return bits;
}

function masks(difficulty) {
  const m0 = difficulty >= 32 ? 0xffffffff : ~(0xffffffff >>> difficulty) >>> 0;
  const m1 = difficulty > 32 ? ~(0xffffffff >>> (difficulty - 32)) >>> 0 : 0;
  return [m0, m1];
}

function submit(slot, range, m0, m1) {
  const params = new Uint32Array(24);
  params.set(range.words, 0);
  params[16] = range.low;
  params[17] = range.iters;
  params[18] = m0;
  params[19] = LOW_MAX;
  params[20] = m1;
  device.queue.writeBuffer(slot.param, 0, params);
  device.queue.writeBuffer(slot.result, 0, new Uint32Array([0, 0xffffffff]));
  const enc = device.createCommandEncoder();
  const cp = enc.beginComputePass();
  cp.setPipeline(pipeline);
  cp.setBindGroup(0, slot.bind);
  cp.dispatchWorkgroups(WORKGROUPS);
  cp.end();
  enc.copyBufferToBuffer(slot.result, 0, slot.read, 0, 8);
  device.queue.submit([enc.finish()]);
  slot.range = range;
  slot.promise = slot.read.mapAsync(GPUMapMode.READ).then(() => {
    const out = new Uint32Array(slot.read.getMappedRange().slice(0));
    slot.read.unmap();
    return out[0] ? out[1] : null;
  });
}

async function run(token) {
  const { id, seed, difficulty } = job;
  const [m0, m1] = job.masks || masks(difficulty); // masks override is used by tests only
  let high = 10000000 + Math.floor(Math.random() * 89999999);
  let words = messageWords(seed, high);
  let low = 0;

  const nextRange = () => {
    if (low >= LOW_MAX) {
      high = 10000000 + Math.floor(Math.random() * 89999999);
      words = messageWords(seed, high);
      low = 0;
    }
    const r = { high, words, low, iters, count: Math.min(THREADS * iters, LOW_MAX - low) };
    low += THREADS * iters;
    return r;
  };

  submit(slots[0], nextRange(), m0, m1);
  submit(slots[1], nextRange(), m0, m1);
  let last = performance.now();
  let i = 0;

  while (true) {
    const slot = slots[i % 2];
    const found = await slot.promise;
    if (!job || token !== runToken) return;
    const now = performance.now();
    const ms = now - last;
    last = now;
    postMessage({ type: "progress", hashes: slot.range.count });

    if (found !== null) {
      const nonce = `${slot.range.high}${String(found).padStart(8, "0")}`;
      // Double-check on the CPU so a GPU driver bug can never send bad shares.
      if (zeroBits(await sha256(`${seed}:${nonce}`)) >= difficulty) {
        postMessage({ type: "found", id, nonce, hashes: 0 });
      } else {
        postMessage({ type: "error", error: "GPU result failed verification" });
      }
      job = null;
      await slots[(i + 1) % 2].promise.catch(() => {});
      return;
    }

    // Each pass should take ~250 ms: long enough to keep the GPU saturated.
    if (ms < TARGET_MS / 2 && iters < 8192) iters *= 2;
    else if (ms > TARGET_MS * 2 && iters > 1) iters = Math.max(1, Math.floor(iters / 2));

    submit(slot, nextRange(), m0, m1);
    i++;
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      const name = await init();
      postMessage({ type: "ready", name });
    } catch (err) {
      postMessage({ type: "unavailable", error: String(err.message || err) });
    }
  } else if (msg.type === "job") {
    const token = ++runToken;
    // Let any passes from the previous puzzle drain before reusing the buffers.
    await Promise.allSettled(slots.map((s) => s.promise));
    if (token !== runToken) return;
    job = { id: msg.id, seed: msg.seed, difficulty: msg.difficulty, masks: msg.masks };
    running = run(token).catch((err) => postMessage({ type: "error", error: String(err.message || err) }));
  } else if (msg.type === "stop") {
    job = null;
    runToken++;
  }
};
