// Basemind GPU miner. Runs SHA-256 proof-of-work on the graphics card with WebGPU.
// Same puzzle as the CPU miner: sha256(seed + ":" + nonce) must start with
// `difficulty` zero bits. The GPU uses fixed 16-digit nonces: 8 "high" digits set
// here, 8 "low" digits computed by each GPU thread.

const SHADER = /* wgsl */ `
struct Params {
  w: array<vec4<u32>, 4>,   // the 16 message words, with the low-digit bytes left as zero
  startLow: u32,
  iters: u32,
  mask: u32,
  limit: u32,               // stop before this low value (keeps 8 digits)
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

fn firstWord(low: u32) -> u32 {
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
  return 0x6a09e667u + a;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let base = P.startLow + gid.x * P.iters;
  for (var k = 0u; k < P.iters; k++) {
    let low = base + k;
    if (low >= P.limit) { return; }
    if ((firstWord(low) & P.mask) == 0u) {
      atomicMin(&result[1], low);
      atomicStore(&result[0], 1u);
    }
  }
}
`;

const WORKGROUPS = 4096;
const THREADS = WORKGROUPS * 64;
const LOW_MAX = 100000000; // 8 decimal digits

let device, pipeline, paramBuf, resultBuf, readBuf, bindGroup;
let job = null;
let runToken = 0;
let iters = 4; // adapted so each GPU pass takes ~120 ms

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
  paramBuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  resultBuf = device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  readBuf = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramBuf } },
      { binding: 1, resource: { buffer: resultBuf } },
    ],
  });
  const name = adapter.info?.description || adapter.info?.vendor || "GPU";
  return name;
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

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(d);
}

function zeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) { bits += 8; continue; }
    return bits + Math.clz32(b) - 24;
  }
  return bits;
}

async function pass(words, startLow, mask) {
  const params = new Uint32Array(20);
  params.set(words, 0);
  params[16] = startLow;
  params[17] = iters;
  params[18] = mask;
  params[19] = LOW_MAX;
  device.queue.writeBuffer(paramBuf, 0, params);
  device.queue.writeBuffer(resultBuf, 0, new Uint32Array([0, 0xffffffff]));
  const enc = device.createCommandEncoder();
  const cp = enc.beginComputePass();
  cp.setPipeline(pipeline);
  cp.setBindGroup(0, bindGroup);
  cp.dispatchWorkgroups(WORKGROUPS);
  cp.end();
  enc.copyBufferToBuffer(resultBuf, 0, readBuf, 0, 8);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  return out[0] ? out[1] : null;
}

async function run(token) {
  const { id, seed, difficulty } = job;
  const mask = difficulty >= 32 ? 0xffffffff : ~(0xffffffff >>> difficulty) >>> 0;
  let high = 10000000 + Math.floor(Math.random() * 89999999);
  let low = 0;
  let words = messageWords(seed, high);

  while (job && token === runToken) {
    const span = THREADS * iters;
    const t0 = performance.now();
    const found = await pass(words, low, mask);
    const ms = performance.now() - t0;
    if (!job || token !== runToken) return;

    const done = Math.min(span, LOW_MAX - low);
    postMessage({ type: "progress", hashes: done });

    if (found !== null) {
      const nonce = `${high}${String(found).padStart(8, "0")}`;
      // Double-check on the CPU so a GPU driver bug can never send bad shares.
      const hash = await sha256Hex(`${seed}:${nonce}`);
      if (zeroBits(hash) >= difficulty) {
        postMessage({ type: "found", id, nonce, hashes: 0 });
        job = null;
        return;
      }
      postMessage({ type: "error", error: "GPU result failed verification" });
      job = null;
      return;
    }

    // Tune work per pass to ~120 ms so the page stays responsive.
    if (ms < 60 && iters < 512) iters *= 2;
    else if (ms > 250 && iters > 1) iters = Math.max(1, Math.floor(iters / 2));

    low += span;
    if (low >= LOW_MAX) {
      high = 10000000 + Math.floor(Math.random() * 89999999);
      words = messageWords(seed, high);
      low = 0;
    }
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
    job = { id: msg.id, seed: msg.seed, difficulty: msg.difficulty };
    const token = ++runToken;
    run(token).catch((err) => postMessage({ type: "error", error: String(err.message || err) }));
  } else if (msg.type === "stop") {
    job = null;
    runToken++;
  }
};
