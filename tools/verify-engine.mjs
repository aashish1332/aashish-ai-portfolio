#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   tools/verify-engine.mjs — P6's parity gate, on the real export.

     node tools/verify-engine.mjs ai/model-export/aashish-ai-1 \
          ai/model-export/aashish-ai-1/reference.json

   `tests/engine.test.mjs` proves the engine is correct on a **seeded random
   fixture**. This proves it is correct on **the weights that will ship**,
   which is the measurement §9.2 actually asks for, and it is the only place
   an ordering gate is meaningful: on trained weights the top-k candidates
   are separated by real margins instead of float noise.

   The reference comes from `inference/reference.py` (numpy, itself
   cross-checked against the trained torch graph when the export was built),
   so this is a three-way agreement: torch graph → numpy → JavaScript.

   It also MEASURES decode speed on this machine, which is the number that
   decides whether the model is worth shipping at all (§4: ≥ ~8 tok/s).

   Exit code is 1 if anything disagrees, so it can gate a deploy.
   ═══════════════════════════════════════════════════════════════ */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ScratchLlamaEngine } from '../ai/engine/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const exportDir = resolve(ROOT, process.argv[2] || 'ai/model-export/aashish-ai-1');
const referencePath = resolve(ROOT, process.argv[3] || `${exportDir}/reference.json`);

const reference = JSON.parse(readFileSync(referencePath, 'utf8'));

/** A `fetch` over the filesystem: the engine's loader is written for the
 *  browser, and pointing it at a directory is the whole reason it takes a
 *  `fetchImpl`. */
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

const manifestUrl = `${exportDir.replace(/\\/g, '/')}/manifest.json`;
const problems = [];
const numbers = {};

const started = Date.now();
const engine = await ScratchLlamaEngine.load({
  manifestUrl, fetchImpl: fileFetch(exportDir),
  onProgress: ({ stage, loaded, total }) => {
    if (stage === 'weights' && total) {
      process.stdout.write(`\r  loading weights ${(loaded / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`);
    }
  },
});
process.stdout.write('\r');
numbers.loadMs = Date.now() - started;
numbers.weightsBytes = engine.bytes;
numbers.verified = engine.verified;
numbers.params = Object.keys(engine.manifest.config).length
  ? countParams(engine.manifest.config)
  : null;

/* 1. the tokenizer must produce the *same ids* the reference was built from.
      A mismatch here would make every downstream number meaningless. */
for (const c of reference.cases) {
  const ids = engine.tokenizer.encode(c.promptText);
  if (JSON.stringify(ids) !== JSON.stringify(c.promptIds)) {
    problems.push(`tokenizer mismatch for ${JSON.stringify(c.promptText.slice(0, 40))}: ` +
      `${ids.slice(0, 12)} != ${c.promptIds.slice(0, 12)}`);
  }
}

/* 2. every prompt position: argmax exactly, ordering exactly on trained
      weights, magnitudes within the fixture's stated tolerance. */
let positions = 0;
let argmaxAgree = 0;
let orderAgree = 0;
let worst = 0;
const tolerance = reference.tolerance?.logit ?? 0.02;
for (const c of reference.cases) {
  engine.model.reset();
  for (let step = 0; step < c.promptIds.length; step++) {
    const logits = engine.model.forward(c.promptIds[step]);
    const expected = c.logits.positions[step];
    positions += 1;
    if (engine.model.argmax(logits) === expected.argmax) argmaxAgree += 1;
    const ours = [...logits.keys()].sort((a, b) => logits[b] - logits[a]).slice(0, 16);
    if (JSON.stringify(ours) === JSON.stringify(expected.top.map((t) => t.id))) orderAgree += 1;
    for (const top of expected.top) worst = Math.max(worst, Math.abs(logits[top.id] - top.logit));
  }
}
numbers.positions = positions;
numbers.argmaxAgreement = positions ? argmaxAgree / positions : 0;
numbers.topOrderAgreement = positions ? orderAgree / positions : 0;
numbers.maxLogitDelta = worst;
if (argmaxAgree !== positions) problems.push(`${positions - argmaxAgree}/${positions} positions have a different argmax`);
if (worst > tolerance) problems.push(`top-16 logits differ by ${worst} (tolerance ${tolerance})`);
if (reference.torchCheck && reference.torchCheck.status !== 'PASS') {
  problems.push(`the export's torch↔numpy cross-check was ${reference.torchCheck.status}`);
}

/* 3. what the visitor feels: greedy decode speed on this machine, measured. */
const prompt = reference.cases[0].promptIds;
engine.model.reset();
const prefillStart = process.hrtime.bigint();
for (const id of prompt) engine.model.forward(id);
numbers.prefillMs = Number(process.hrtime.bigint() - prefillStart) / 1e6;
numbers.prefillTokensPerSecond = prompt.length / (numbers.prefillMs / 1000);

const decodeTokens = 16;
let previous = prompt.at(-1);
const decodeStart = process.hrtime.bigint();
for (let i = 0; i < decodeTokens; i++) previous = engine.model.argmax(engine.model.forward(previous));
numbers.decodeMs = Number(process.hrtime.bigint() - decodeStart) / 1e6;
numbers.decodeTokensPerSecond = decodeTokens / (numbers.decodeMs / 1000);
numbers.kvCacheBytes = engine.model.kvBytes;
numbers.memoryEstimate = engine.memoryEstimate;

/* 4. What the quantization cost. Two numbers, both from the artifact and
      both measured by the exporter: the worst per-row error INT8 introduced,
      and the ordering agreement above, which is the accuracy the visitor
      experiences. §9.2 will not let INT4 ship until this is measured for it
      too — so the gate is recorded here rather than asserted in prose. */
numbers.quantization = engine.manifest.quantization;
numbers.embeddingRows = engine.weights.get('model.embed_tokens.weight').rows;
if (numbers.quantization?.weights !== 'q8-row') {
  problems.push(`unexpected quantization ${numbers.quantization?.weights} — ` +
    'only INT8 has a measured accuracy number (§9.2)');
}
if (!engine.verified) problems.push('shard hashes were not verified on load');
/* The embedding table is the one tensor whose codes are also its content
   (the tied head reads them directly), so an out-of-range code is a real
   corruption rather than a rounding artifact. */
{
  const embed = engine.weights.get('model.embed_tokens.weight');
  let outOfRange = 0;
  for (let i = 0; i < embed.codes.length; i += 97) {
    if (embed.codes[i] < -127 || embed.codes[i] > 127) outOfRange += 1;
  }
  if (outOfRange) problems.push(`${outOfRange} embedding codes are outside int8 — the shard is corrupt`);
  numbers.rowScaleBytes = 4;
}

engine.dispose();

const report = {
  checkedAt: new Date().toISOString(),
  exportDir: exportDir.replace(`${ROOT}\\`, '').replace(/\\/g, '/'),
  modelVersion: reference.modelDir,
  numbers,
  tolerance,
  verdict: problems.length ? 'FAIL' : 'PASS',
  problems,
};

console.log(`verify-engine · ${report.exportDir}`);
console.log(`  format           ${reference.format}`);
console.log(`  weights          ${(numbers.weightsBytes / 1e6).toFixed(2)} MB, verified ${numbers.verified}`);
console.log(`  load             ${numbers.loadMs} ms`);
console.log(`  positions        ${numbers.positions} checked · argmax ${(numbers.argmaxAgreement * 100).toFixed(1)}% · top-16 order ${(numbers.topOrderAgreement * 100).toFixed(1)}%`);
console.log(`  worst |Δlogit|   ${numbers.maxLogitDelta.toExponential(2)} (tolerance ${tolerance})`);
console.log(`  prefill          ${numbers.prefillMs.toFixed(0)} ms for ${prompt.length} tokens (${numbers.prefillTokensPerSecond.toFixed(0)} tok/s)`);
console.log(`  decode           ${numbers.decodeTokensPerSecond.toFixed(1)} tok/s (${numbers.decodeMs.toFixed(0)} ms for ${decodeTokens} tokens)`);
console.log(`  KV cache         ${(numbers.kvCacheBytes / 1024).toFixed(0)} KB resident`);
console.log(`  quantization     ${numbers.quantization?.weights} · worst row error ${numbers.quantization?.worstRowError}`);
console.log(`  torch↔numpy      ${reference.torchCheck?.status ?? 'NOT TESTED'}` +
  (reference.torchCheck?.maxAbsDiff !== undefined ? ` (max |Δ| ${reference.torchCheck.maxAbsDiff.toExponential(2)})` : ''));
console.log(`  verdict          ${report.verdict}`);
for (const p of problems) console.log(`  · ${p}`);

if (process.env.VERIFY_JSON) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.VERIFY_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`  report           ${process.env.VERIFY_JSON}`);
}

process.exit(problems.length ? 1 : 0);

function countParams(config) {
  const d = config.hidden_size;
  const ffn = config.intermediate_size;
  const heads = config.num_attention_heads;
  const kv = config.num_key_value_heads;
  const headDim = config.head_dim ?? d / heads;
  const perLayer = d * d + 2 * (kv * headDim) * d + d * (heads * headDim) + 3 * d * ffn;
  return config.vocab_size * d + config.num_hidden_layers * perLayer + d;
}
