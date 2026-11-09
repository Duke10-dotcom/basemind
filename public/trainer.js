// Basemind in-browser trainer. Trains a small neural language model on the
// recipe's examples using TensorFlow.js on the user's GPU (WebGPU), then
// generates replies word by word. Models are saved in the browser (IndexedDB).

import { TOPICS } from "./recipes-data.js";

const TF_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const TF_WEBGPU_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/dist/tf-backend-webgpu.min.js";
const CTX = 6; // words of context the model sees
const MAX_EPOCHS = 40;

let tfPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load the AI library. Check your connection."));
    document.head.append(s);
  });
}

// Loads TensorFlow.js and picks the fastest backend: WebGPU, then WebGL, then CPU.
export function loadTf() {
  if (!tfPromise) {
    tfPromise = (async () => {
      await loadScript(TF_URL);
      const tf = window.tf;
      if ("gpu" in navigator) {
        try {
          await loadScript(TF_WEBGPU_URL);
          if (await tf.setBackend("webgpu")) {
            await tf.ready();
            return tf;
          }
        } catch {}
      }
      for (const b of ["webgl", "cpu"]) {
        try {
          if (await tf.setBackend(b)) {
            await tf.ready();
            return tf;
          }
        } catch {}
      }
      throw new Error("No backend available");
    })();
  }
  return tfPromise;
}

export function tokenize(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[’`]/g, "'")
      .match(/[a-z0-9']+|[.,!?]/g) || []
  );
}

export function detokenize(tokens) {
  let out = "";
  for (const t of tokens) {
    if (/^[.,!?]$/.test(t)) out += t;
    else out += (out ? " " : "") + t;
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function buildDataset(recipeId) {
  const seqs = [];
  for (const topic of TOPICS) {
    const answer = tokenize(topic[recipeId]);
    for (const q of topic.q) seqs.push({ q: tokenize(q), a: answer });
  }
  const words = new Set();
  for (const s of seqs) [...s.q, ...s.a].forEach((w) => words.add(w));
  const vocab = ["<pad>", "<unk>", "<q>", "<a>", "<e>", ...[...words].sort()];
  const index = new Map(vocab.map((w, i) => [w, i]));

  const xs = [];
  const ys = [];
  // Each example: predict the next answer word from the previous CTX words.
  // Extra copies hide some question words so the model copes with new questions.
  for (const s of seqs) {
    for (let copy = 0; copy < 3; copy++) {
      const q = s.q.map((w) => (copy > 0 && Math.random() < 0.35 ? "<unk>" : w));
      const seq = [...Array(CTX).fill("<pad>"), "<q>", ...q, "<a>", ...s.a, "<e>"].map((w) => index.get(w));
      const start = CTX + 1 + q.length + 1; // first answer token
      for (let i = start; i < seq.length; i++) {
        xs.push(seq.slice(i - CTX, i));
        ys.push(seq[i]);
      }
    }
  }
  return { vocab, xs, ys };
}

function buildModel(tf, vocabSize) {
  const model = tf.sequential();
  model.add(tf.layers.embedding({ inputDim: vocabSize, outputDim: 48, inputLength: CTX }));
  model.add(tf.layers.flatten());
  model.add(tf.layers.dense({ units: 256, activation: "relu" }));
  model.add(tf.layers.dropout({ rate: 0.1 }));
  model.add(tf.layers.dense({ units: vocabSize, activation: "softmax" }));
  model.compile({ optimizer: tf.train.adam(0.004), loss: "sparseCategoricalCrossentropy" });
  return model;
}

const storeKey = (owner, recipeId) => `basemind-${owner}-${recipeId}`;

// Trains a model. onProgress gets { step, totalSteps, epoch, loss, seconds }.
export async function train(recipeId, owner, onProgress) {
  const tf = await loadTf();
  const { vocab, xs, ys } = buildDataset(recipeId);
  const model = buildModel(tf, vocab.length);
  const x = tf.tensor2d(Float32Array.from(xs.flat()), [xs.length, CTX]);
  const y = tf.tensor2d(Float32Array.from(ys), [ys.length, 1]);
  const batchSize = 128;
  const perEpoch = Math.ceil(xs.length / batchSize);
  const t0 = performance.now();
  let step = 0;
  let lastLoss = 0;

  await model.fit(x, y, {
    epochs: MAX_EPOCHS,
    batchSize,
    shuffle: true,
    callbacks: {
      onBatchEnd: async (_b, logs) => {
        step++;
        lastLoss = logs.loss;
        onProgress?.({ step, totalSteps: perEpoch * MAX_EPOCHS, epoch: Math.floor(step / perEpoch), loss: logs.loss, seconds: (performance.now() - t0) / 1000 });
        await tf.nextFrame();
      },
      onEpochEnd: (_e, logs) => {
        if (logs.loss < 0.08) model.stopTraining = true; // learned the recipe well enough
      },
    },
  });
  x.dispose();
  y.dispose();

  const info = {
    recipe: recipeId,
    steps: step,
    loss: lastLoss,
    seconds: (performance.now() - t0) / 1000,
    params: model.countParams(),
    examples: xs.length,
    backend: tf.getBackend(),
    vocab,
  };
  try {
    await model.save(`indexeddb://${storeKey(owner, recipeId)}`);
    localStorage.setItem(storeKey(owner, recipeId), JSON.stringify(info));
  } catch {}
  return { model, info };
}

// Loads a model this browser trained earlier, or null.
export async function load(recipeId, owner) {
  try {
    const raw = localStorage.getItem(storeKey(owner, recipeId));
    if (!raw) return null;
    const tf = await loadTf();
    const model = await tf.loadLayersModel(`indexeddb://${storeKey(owner, recipeId)}`);
    return { model, info: JSON.parse(raw) };
  } catch {
    return null;
  }
}

export function hasSaved(recipeId, owner) {
  try {
    return !!localStorage.getItem(storeKey(owner, recipeId));
  } catch {
    return false;
  }
}

// Generates a reply one word at a time.
export async function reply({ model, info }, question, { temperature = 0.6, topK = 4, maxWords = 40 } = {}) {
  const tf = await loadTf();
  const index = new Map(info.vocab.map((w, i) => [w, i]));
  const ids = (w) => index.get(w) ?? index.get("<unk>");
  const ctx = [...Array(CTX).fill("<pad>"), "<q>", ...tokenize(question), "<a>"].map(ids);
  const out = [];
  for (let i = 0; i < maxWords; i++) {
    const probs = tf.tidy(() => model.predict(tf.tensor2d([ctx.slice(-CTX)], [1, CTX])).dataSync());
    // sample from the top-k words, sharpened by temperature
    const top = [...probs.keys()].sort((a, b) => probs[b] - probs[a]).slice(0, topK);
    const weights = top.map((k) => Math.pow(probs[k], 1 / temperature));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let pick = top[0];
    for (let j = 0; j < top.length; j++) {
      r -= weights[j];
      if (r <= 0) { pick = top[j]; break; }
    }
    const word = info.vocab[pick];
    if (word === "<e>") break;
    if (!word.startsWith("<")) out.push(word);
    ctx.push(pick);
  }
  return detokenize(out) || "…";
}
