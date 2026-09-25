#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   dev-prefill-batch-probe.js — is the prefill weight-traffic-bound?

     node dev-prefill-batch-probe.js [export-dir]

   Prefill is ~90% of a visitor's wait (measured: dev-answer-latency-probe.js)
   and prefill re-reads every weight matrix once *per prompt token*. A 135-token
   prompt therefore streams the same 5 MB of weights 135 times. If that traffic
   is what costs the seconds, then processing B prompt positions together — the
   weight row loaded once and multiplied into B activations while it sits in L1 —
   should cut the wait by close to B without changing a single output value.

   This probe decides whether that is true before anything is rewritten. It
   compares, in one process and interleaved:

     sequential   B calls to the shipped `matvecQ8`, one per activation
     batched      one pass with the row loop outermost and the batch inside

   over real exported weights. Minimum-of-N, because this laptop's load moves
   results by 2x between runs and only same-process comparisons survive that.
   ═══════════════════════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matvecQ8 } from './ai/engine/quant.mjs';
import { ScratchLlamaEngine } from './ai/engine/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, process.argv[2] || 'ai/model-export/aashish-ai-1');

function fileFetch(base) {
  return async (url) => {
    const name = String(url).split('/').pop();
    try {
      const buffer = readFileSync(resolve(base, name));
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength),
        json: async () => JSON.parse(buffer.toString('utf8')),
      };
    } catch {
      return { ok: false, status: 404 };
    }
  };
}

/** The batched matvec the engine would use for prefill: for each row, stream
 *  the row once and multiply it into every activation in the batch. */
function matvecQ8Batch(out, xs, tensor) {
  const { codes, scales, rows, cols } = tensor;
  const B = xs.length;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    const scale = scales[r];
    for (let b = 0; b < B; b++) {
      const x = xs[b];
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      let c = 0;
      for (; c + 4 <= cols; c += 4) {
        a0 += codes[base + c] * x[c];
        a1 += codes[base + c + 1] * x[c + 1];
        a2 += codes[base + c + 2] * x[c + 2];
        a3 += codes[base + c + 3] * x[c + 3];
      }
      for (; c < cols; c++) a0 += codes[base + c] * x[c];
      out[b * rows + r] = (a0 + a1 + a2 + a3) * scale;
    }
  }
  return out;
}

const engine = await ScratchLlamaEngine.load({
  manifestUrl: `${dir.replace(/\\/g, '/')}/manifest.json`,
  fetchImpl: fileFetch(dir),
});
const model = engine.model;

const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const D = model.d;
const mes = model.config.intermediate_size;

/* One representative layer's worth of the matrices a prompt token passes
   through: q/k/v/o read `d`, gate/up read `d` and write `mes`, down reads
   `mes`. Using the real tensors means the real sizes and the real layouts. */
const w = model.layerWeights[0];
const tensors = [w.q, w.k, w.v, w.o, w.gate, w.up, w.down];

function makeXs(B, cols, salt) {
  return Array.from({ length: B }, (_, i) => {
    const x = new Float32Array(cols);
    for (let j = 0; j < cols; j++) x[j] = Math.sin((i + 1) * 0.37 + j * 0.011 + salt);
    return x;
  });
}

const REPEATS = Number(process.env.REPEATS || 7);

/** Interleave the two variants and keep each one's *minimum*, so a burst of
 *  background load inflates both and the ratio stays meaningful. */
function duel(B) {
  /* Each matrix in the batch is fed activations of *its own* width (`down`
     reads the 768-wide FFN activation, not the 256-wide residual), so the
     batch is built per tensor rather than once. */
  const batch = tensors.map((tensor, i) => ({
    tensor,
    xs: makeXs(B, tensor.cols, i * 0.7),
    seq: new Float32Array(B * tensor.rows),
    bat: new Float32Array(B * tensor.rows),
  }));
  let bestSeq = Infinity;
  let bestBat = Infinity;
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const which of ['seq', 'bat']) {
      const t = process.hrtime.bigint();
      for (const { tensor, xs, seq, bat } of batch) {
        if (which === 'seq') {
          /* `matvecQ8` writes one activation's results per call, so each call
             gets its own slice - otherwise the comparison below would read the
             last activation twice and report a difference that is not there. */
          for (let b = 0; b < xs.length; b++) {
            matvecQ8(seq.subarray(b * tensor.rows, (b + 1) * tensor.rows), xs[b], tensor);
          }
        } else {
          matvecQ8Batch(bat, xs, tensor);
        }
      }
      const elapsed = ms(t);
      if (which === 'seq') bestSeq = Math.min(bestSeq, elapsed);
      else bestBat = Math.min(bestBat, elapsed);
    }
  }
  /* The batched path must not change the numbers, only the order they are
     computed in - float64 accumulators make it associative enough to expect
     agreement, but "expect" is not a measurement. */
  let worstDelta = 0;
  let n = 0;
  for (const { seq, bat } of batch) {
    for (let i = 0; i < seq.length; i++) {
      worstDelta = Math.max(worstDelta, Math.abs(seq[i] - bat[i]));
      n += 1;
    }
  }
  return { B, bestSeq, bestBat, worstDelta, n };
}

console.log(`prefill batch probe · ${dir.replace(`${HERE}\\`, '').replace(/\\/g, '/')}`);
console.log(`  weights ${(engine.bytes / 1e6).toFixed(2)} MB · d=${D} · ffn=${mes}`);
console.log(`  ${tensors.length} matrices per layer, ${REPEATS} interleaved reps, minimum kept\n`);
console.log('  batch   sequential    batched     speedup   worst |Δ|');
for (const B of [1, 2, 4, 8]) {
  const r = duel(B);
  console.log(`  ${String(r.B).padStart(5)}`
    + `${r.bestSeq.toFixed(1).padStart(13)} ms${r.bestBat.toFixed(1).padStart(10)} ms`
    + `${(r.bestSeq / r.bestBat).toFixed(2).padStart(11)}x`
    + `${r.worstDelta.toExponential(1).padStart(12)}`);
}
console.log('\n  A speedup near `batch` means the kernel is weight-traffic-bound and'
  + '\n  batching reclaims it; a speedup near 1 means it is not, and prefill has'
  + '\n  no headroom this way.');

engine.dispose();
