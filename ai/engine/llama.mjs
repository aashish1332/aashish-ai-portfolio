/* ═══════════════════════════════════════════════════════════════
   ai/engine/llama.mjs — §7.1's architecture, in the visitor's browser.

   A decoder-only Llama-shaped transformer: pre-norm RMSNorm, RoPE, SwiGLU
   FFN, GQA, tied embeddings, causal attention, all in float32 activations
   over int8 weights (`quant.mjs`).

   This is the *third* implementation of the same graph and the one a
   visitor actually runs, so it is checked rather than trusted:
   `tests/engine.test.mjs` replays the prompts in
   `tests/fixtures/engine_reference.json` and requires the greedy
   continuation to be identical, which pins prefill and the cached decode
   path together. `inference/reference.py` is the numpy side of that
   comparison and is itself cross-checked against the trained torch graph.

   Cached decode is the part that can be wrong while looking right: with
   `past` non-empty the attention window is *positions 0…pos*, not the
   length of the current chunk. Getting that wrong changes nothing about
   shapes and everything about the answer, so `positions` is explicit here
   and never derived from an array length.
   ═══════════════════════════════════════════════════════════════ */

import { dotRowQ8, matvecQ8, rmsNorm, rowQ8, silu } from './quant.mjs';

/** `plan.rope_cache`'s (cos, sin), built at load: inv_freq = theta^(-2i/d),
 *  angles = position × inv_freq, then each frequency is duplicated (the
 *  `cat(freqs, freqs)` in the reference) so `rotateHalf` can rotate the
 *  whole head vector at once. */
export function ropeCache(headDim, theta = 10000, maxPosition = 1024) {
  const half = headDim / 2;
  const invFreq = new Float64Array(half);
  for (let i = 0; i < half; i++) invFreq[i] = 1 / Math.pow(theta, (2 * i) / headDim);
  const cos = new Float32Array(maxPosition * headDim);
  const sin = new Float32Array(maxPosition * headDim);
  for (let pos = 0; pos < maxPosition; pos++) {
    for (let i = 0; i < half; i++) {
      const angle = pos * invFreq[i];
      cos[pos * headDim + i] = Math.cos(angle);
      cos[pos * headDim + i + half] = Math.cos(angle);
      sin[pos * headDim + i] = Math.sin(angle);
      sin[pos * headDim + i + half] = Math.sin(angle);
    }
  }
  return { cos, sin, headDim, maxPosition };
}

/** `x * cos + rotateHalf(x) * sin`, in place on one head vector. */
export function applyRope(x, offset, headDim, cosRow, sinRow) {
  const half = headDim / 2;
  for (let i = 0; i < half; i++) {
    const a = x[offset + i];
    const b = x[offset + i + half];
    x[offset + i] = a * cosRow[i] - b * sinRow[i];
    x[offset + i + half] = b * cosRow[i + half] + a * sinRow[i + half];
  }
  return x;
}

export class LlamaEngine {
  /**
   * @param {object} config    HF-shaped config (manifest.config)
   * @param {Map<string, object>} weights  dequant-ready tensors by HF name
   * @param {{maxSeq?: number}} [opts]
   */
  constructor(config, weights, { maxSeq } = {}) {
    this.config = config;
    const d = config.hidden_size;
    this.d = d;
    this.headDim = config.head_dim ?? d / config.num_attention_heads;
    this.nHeads = config.num_attention_heads;
    this.nKv = config.num_key_value_heads;
    this.nRep = this.nHeads / this.nKv;
    this.layers = config.num_hidden_layers;
    this.vocab = config.vocab_size;
    this.eps = config.rms_norm_eps ?? 1e-5;
    this.maxSeq = maxSeq ?? config.max_position_embeddings;
    this.tied = config.tie_word_embeddings !== false;
    this.rope = ropeCache(this.headDim, config.rope_theta ?? 10000, this.maxSeq);
    this.weights = weights;

    for (const name of ['model.embed_tokens.weight', 'model.norm.weight']) {
      if (!weights.has(name)) throw new Error(`missing tensor ${name}`);
    }
    this.embed = weights.get('model.embed_tokens.weight');
    this.norm = weights.get('model.norm.weight').data;
    this.head = this.tied ? this.embed : weights.get('lm_head.weight');
    if (!this.head) throw new Error('untied model without lm_head.weight');

    // Scratch buffers, allocated once: a per-token allocation storm is what
    // makes a JS transformer stutter (§4: no task over ~50 ms).
    this.x = new Float32Array(d);
    this.h = new Float32Array(d);
    this.h2 = new Float32Array(d);
    this.q = new Float32Array(this.headDim * this.nHeads);
    this.k = new Float32Array(this.headDim * this.nKv);
    this.v = new Float32Array(this.headDim * this.nKv);
    this.attnOut = new Float32Array(this.headDim * this.nHeads);
    this.gate = new Float32Array(config.intermediate_size);
    this.up = new Float32Array(config.intermediate_size);
    this.projOut = new Float32Array(Math.max(d, config.intermediate_size));
    this.logits = new Float32Array(this.vocab);
    this.scores = new Float64Array(this.maxSeq);

    this.kCache = new Float32Array(this.layers * this.maxSeq * this.headDim * this.nKv);
    this.vCache = new Float32Array(this.layers * this.maxSeq * this.headDim * this.nKv);
    this.pos = 0;
    /* Set only by `rememberPrefix`: the ids whose K/V is known to occupy
       positions 0…P-1. Null means "the cache holds no reusable prefix". */
    this.prefixIds = null;
  }

  get kvBytes() {
    return this.kCache.byteLength + this.vCache.byteLength;
  }

  reset() {
    this.pos = 0;
    /* A reset means the caller may write any position next, so the cached
       prefix is no longer known to be intact. Dropping the claim here is what
       keeps reuse honest: it is never assumed, only taken when the exact ids
       are re-presented. */
    this.prefixIds = null;
  }

  /** Record that positions 0…ids.length-1 now hold `ids`, so the next
   *  generation can skip re-prefilling them. Called by the engine after a
   *  full prefill, never by a caller. */
  rememberPrefix(ids) {
    this.prefixIds = ids.length ? Int32Array.from(ids) : null;
    return this.prefixIds;
  }

  /** Rewind to a previously-prefilled prefix, when it is exactly `ids`.
   *
   * This is a latency optimisation with no effect on what is computed: the
   * attention window is position-indexed, so K/V at positions 0…P-1 does not
   * depend on how many times it was computed. Rewinding `pos` and feeding only
   * the remainder produces bit-identical logits to a full prefill, which
   * `tests/engine.test.mjs` asserts rather than assumes. */
  reusePrefix(ids) {
    const cached = this.prefixIds;
    if (!cached || cached.length !== ids.length) return false;
    for (let i = 0; i < cached.length; i++) {
      if (cached[i] !== ids[i]) return false;
    }
    this.pos = ids.length;
    return true;
  }

  /** One token at `this.pos`, appending to the KV cache. Returns the
   *  logits view (reused between calls — copy if you keep it). */
  forward(id) {
    if (this.pos >= this.maxSeq) {
      throw new Error(`context is full at ${this.maxSeq} tokens`);
    }
    const { d, headDim, nHeads, nKv, nRep, pos } = this;
    const cosRow = this.rope.cos.subarray(pos * headDim, (pos + 1) * headDim);
    const sinRow = this.rope.sin.subarray(pos * headDim, (pos + 1) * headDim);

    rowQ8(this.x, this.embed, id);

    for (let layer = 0; layer < this.layers; layer++) {
      const p = `model.layers.${layer}`;
      const w = (name) => this.weights.get(`${p}.${name}`);

      rmsNorm(this.h, this.x, w('input_layernorm.weight').data, this.eps);
      matvecQ8(this.q, this.h, w('self_attn.q_proj.weight'));
      matvecQ8(this.k, this.h, w('self_attn.k_proj.weight'));
      matvecQ8(this.v, this.h, w('self_attn.v_proj.weight'));

      for (let head = 0; head < nHeads; head++) {
        applyRope(this.q, head * headDim, headDim, cosRow, sinRow);
      }
      for (let head = 0; head < nKv; head++) {
        applyRope(this.k, head * headDim, headDim, cosRow, sinRow);
      }

      const layerBase = layer * this.maxSeq * headDim * nKv;
      const kAt = layerBase + pos * headDim * nKv;
      this.kCache.set(this.k, kAt);
      this.vCache.set(this.v, kAt);

      // Attention over positions 0…pos, GQA by contiguous groups
      // (plan.gqa_head_map: query head h reads KV head floor(h / n_rep)).
      this.#attend(layerBase, kAt, headDim, nHeads, nKv, nRep);

      matvecQ8(this.projOut.subarray(0, d), this.attnOut, w('self_attn.o_proj.weight'));
      for (let i = 0; i < d; i++) this.x[i] += this.projOut[i];

      rmsNorm(this.h2, this.x, w('post_attention_layernorm.weight').data, this.eps);
      matvecQ8(this.gate, this.h2, w('mlp.gate_proj.weight'));
      matvecQ8(this.up, this.h2, w('mlp.up_proj.weight'));
      for (let i = 0; i < this.gate.length; i++) this.gate[i] = silu(this.gate[i]) * this.up[i];
      matvecQ8(this.projOut.subarray(0, d), this.gate, w('mlp.down_proj.weight'));
      for (let i = 0; i < d; i++) this.x[i] += this.projOut[i];
    }

    rmsNorm(this.h, this.x, this.norm, this.eps);
    for (let r = 0; r < this.vocab; r++) {
      this.logits[r] = this.tied ? dotRowQ8(this.h, this.embed, r)
        : matvecHeadRow(this.h, this.head, r);
    }

    this.pos += 1;
    return this.logits;
  }

  #attend(layerBase, kAt, headDim, nHeads, nKv, nRep) {
    const window = this.pos + 1;
    this.attnOut.fill(0);
    for (let head = 0; head < nHeads; head++) {
      const kvHead = (head / nRep) | 0;
      const qOff = head * headDim;
      let maxScore = -Infinity;
      for (let t = 0; t < window; t++) {
        const kOff = layerBase + t * headDim * nKv + kvHead * headDim;
        let dot = 0;
        for (let i = 0; i < headDim; i++) dot += this.q[qOff + i] * this.kCache[kOff + i];
        const score = dot / Math.sqrt(headDim);
        this.scores[t] = score;
        if (score > maxScore) maxScore = score;
      }
      let denom = 0;
      for (let t = 0; t < window; t++) {
        const e = Math.exp(this.scores[t] - maxScore);
        this.scores[t] = e;
        denom += e;
      }
      for (let t = 0; t < window; t++) {
        const weight = this.scores[t] / denom;
        if (weight === 0) continue;
        const vOff = layerBase + t * headDim * nKv + kvHead * headDim;
        for (let i = 0; i < headDim; i++) {
          this.attnOut[qOff + i] += weight * this.vCache[vOff + i];
        }
      }
    }
  }

  /** Argmax, greedy — §5.1: no sampling, so a visitor cannot get a
   *  different answer to the same question on a second visit. */
  argmax(logits) {
    let best = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > bestValue) {
        bestValue = logits[i];
        best = i;
      }
    }
    return best;
  }
}

/** The untied-LM-head path (kept for completeness; every §7.1 config ties). */
function matvecHeadRow(hidden, head, row) {
  const { codes, scales, cols } = head;
  const base = row * cols;
  let acc = 0;
  for (let c = 0; c < cols; c++) acc += codes[base + c] * hidden[c];
  return acc * scales[row];
}
