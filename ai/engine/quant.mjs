/* ═══════════════════════════════════════════════════════════════
   ai/engine/quant.mjs — the int8 weight kernels.

   The counterpart of `inference/export_browser.py`'s `quantize_rows`. A
   weight matrix ships as two typed arrays and nothing else:

     codes  Int8Array(rows * cols)   round(w / scale) clipped to [-127, 127]
     scales Float32Array(rows)       max|w_row| / 127, or 1 for an empty row

   and dequantisation is `codes[i] * scales[row]`. There is no per-block
   table, no lookup, no format parsing — a chunk of the shard *is* the
   tensor.

   Why the weights stay int8 instead of being expanded to float32 at load
   (§4's RAM budget): the expansion is 4×, and on config A that is 152 MB
   of extra tab memory to buy nothing but a faster inner loop. Multiplying
   an int8 code by a float32 activation costs one conversion per element
   and keeps the resident set at a quarter.

   The activation is deliberately *not* quantized. Q8×Q8 needs an
   activation scale per token, and a wrong one is invisible until Hindi
   answers start dropping numbers — the guard would catch that, but the
   point of §8.4 is to catch model *lies*, not arithmetic drift.
   ═══════════════════════════════════════════════════════════════ */

/** out[r] = scale[r] * Σ_c codes[r*cols + c] * x[c]  — one weight matrix. */
export function matvecQ8(out, x, tensor) {
  const { codes, scales, rows, cols } = tensor;
  if (x.length !== cols) {
    throw new Error(`matvec: activation is ${x.length}, matrix wants ${cols}`);
  }
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let acc = 0;
    // Four independent accumulators: the loop is memory-bound on `codes`,
    // and one dependency chain per row leaves the multiply unit idle.
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
    acc = a0 + a1 + a2 + a3;
    out[r] = acc * scales[r];
  }
  return out;
}

/** One row of a quantized matrix, dequantised into `out` (the embedding
 *  lookup and the tied LM head, where a full matvec would waste 1023 rows). */
export function rowQ8(out, tensor, index) {
  const { codes, scales, rows, cols } = tensor;
  if (index < 0 || index >= rows) {
    throw new Error(`row ${index} is outside a ${rows}-row tensor`);
  }
  const base = index * cols;
  const scale = scales[index];
  for (let c = 0; c < cols; c++) out[c] = codes[base + c] * scale;
  return out;
}

/** logits = W_row · x for the LM head: the same matvec, dotted with `x`
 *  rather than materialised, because only the value is needed. */
export function dotRowQ8(x, tensor, index) {
  const { codes, scales, cols } = tensor;
  const base = index * cols;
  let acc = 0;
  for (let c = 0; c < cols; c++) acc += codes[base + c] * x[c];
  return acc * scales[index];
}

/** The full logit vector when the head is tied to the embedding — which is
 *  every config in §7.1, and the reason the LM head costs 0 bytes. */
export function logitsTiedQ8(out, hidden, embed) {
  const { rows } = embed;
  for (let r = 0; r < rows; r++) out[r] = dotRowQ8(hidden, embed, r);
  return out;
}

/** Rebuild the float32 matrix — used by the tests to compare against the
 *  Python reference, never on the inference path. */
export function dequantiseQ8(tensor) {
  const { codes, scales, rows, cols } = tensor;
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) out[base + c] = codes[base + c] * scales[r];
  }
  return { data: out, rows, cols };
}

/** int8 view, then float32 view, of one contiguous tensor block. The block
 *  is padded to a 4-byte boundary by the exporter, so the float32 half is
 *  always aligned; a view starting at an odd offset throws in JS. */
export function tensorFromBlock(bytes, offset, meta) {
  const { dtype, shape } = meta;
  const rows = meta.rows ?? 1;
  const cols = meta.cols ?? shape.reduce((a, b) => a * b, 1);
  if (dtype === 'q8') {
    const codes = new Int8Array(bytes.buffer, bytes.byteOffset + offset, rows * cols);
    const scaleAt = offset + rows * cols;
    const scales = new Float32Array(bytes.buffer, bytes.byteOffset + scaleAt, rows);
    return { codes, scales, rows, cols };
  }
  if (dtype === 'f32' || dtype === 'f16') {
    if (dtype === 'f16') throw new Error('f16 tensors are not decoded yet (§9.2)');
    return { data: new Float32Array(bytes.buffer, bytes.byteOffset + offset, cols),
             rows: 1, cols };
  }
  throw new Error(`unknown tensor dtype ${dtype}`);
}

/** RMSNorm in float32, matching `plan.rms_norm`. */
export function rmsNorm(out, x, weight, eps = 1e-5) {
  const n = x.length;
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += x[i] * x[i];
  const inv = 1 / Math.sqrt(sumSq / n + eps);
  for (let i = 0; i < n; i++) out[i] = x[i] * inv * weight[i];
  return out;
}

export function silu(x) {
  return x / (1 + Math.exp(-x));
}
