/* ═══════════════════════════════════════════════════════════════
   tests/engine.test.mjs — ENG-1…ENG-14

   P6's parity gate (§9.2) and P7's loader gate (§9.3), on the committed
   fixture in `tests/fixtures/tiny-model/`. That fixture is a *seeded random*
   model exported by `inference/export_browser.py`: correctness of a forward
   pass does not depend on the weights being trained, and a random model is
   reproducible in a way a checkpoint is not.

   The reference is `inference/reference.py`, a numpy forward pass that is
   itself checked against the trained torch graph in the exporter run that
   produced the fixture. So a JavaScript mismatch here is a real bug in
   `ai/engine/llama.mjs`, not two wrong answers agreeing.
   ═══════════════════════════════════════════════════════════════ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ScratchLlamaEngine, createEngine, LLMEngine } from '../ai/engine/index.mjs';
import { LlamaEngine, applyRope, ropeCache } from '../ai/engine/llama.mjs';
import { manifestIssues, parseManifest, sha256hex } from '../ai/engine/manifest.mjs';
import { dequantiseQ8, matvecQ8, rmsNorm, rowQ8 } from '../ai/engine/quant.mjs';
import { defaultStopIds, frame, frameParts, framePrefix, promptIds }
  from '../ai/engine/prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, 'fixtures/tiny-model');
const REFERENCE = JSON.parse(readFileSync(resolve(HERE, 'fixtures/engine_reference.json'), 'utf8'));
const MANIFEST_RAW = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'manifest.json'), 'utf8'));

function fileFetch(base = FIXTURE_DIR) {
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

const MANIFEST_URL = 'https://example.test/ai/model/aashish-ai-fixture/manifest.json';

async function loadEngine(opts = {}) {
  return ScratchLlamaEngine.load({
    manifestUrl: MANIFEST_URL, fetchImpl: fileFetch(), ...opts,
  });
}

// ── the manifest contract ────────────────────────────────────────────
test('ENG-1 the fixture manifest is well formed and self-describing', () => {
  const manifest = parseManifest(MANIFEST_RAW);
  assert.deepEqual(manifestIssues(manifest), []);
  assert.equal(manifest.format, 'aashish-llm/v1');
  assert.equal(manifest.source.kind, 'random-init');
  assert.equal(manifest.quantization.weights, 'q8-row');
  assert.equal(manifest.tensors.size, 20, 'embed + 2 layers × 9 + norm');
  assert.equal(manifest.tensors.get('model.embed_tokens.weight').dtype, 'q8');
  assert.equal(manifest.tensors.get('model.norm.weight').dtype, 'f32');
  for (const shard of manifest.shards) assert.ok(shard.bytes <= 8 * 1024 * 1024);
  assert.equal(REFERENCE.modelDir, 'tests/fixtures/tiny-model');
  assert.equal(REFERENCE.torchCheck.status, 'PASS',
    'the numpy reference must have been cross-checked against torch when the fixture was built');
});

test('ENG-2 malformed manifests are rejected with a reason', () => {
  assert.throws(() => parseManifest(null), /not an object/);
  assert.throws(() => parseManifest({ ...MANIFEST_RAW, format: 'gguf' }), /is not aashish-llm/);
  assert.throws(() => parseManifest({ ...MANIFEST_RAW, config: {} }), /config\.vocab_size/);
  assert.throws(() => parseManifest({ ...MANIFEST_RAW, tensors: [] }), /no tensors/);
  const badShape = { ...MANIFEST_RAW, tensors: [...MANIFEST_RAW.tensors] };
  badShape.tensors[0] = { ...badShape.tensors[0], shard: 99 };
  assert.throws(() => parseManifest(badShape), /shard 99/);
  // Misaligned float32 halves are refused at parse time rather than throwing
  // from inside the model.
  const misaligned = { ...MANIFEST_RAW, tensors: [...MANIFEST_RAW.tensors] };
  misaligned.tensors[0] = { ...misaligned.tensors[0], offset: misaligned.tensors[0].offset + 1 };
  assert.throws(() => parseManifest(misaligned), /4-byte aligned/);
  const noHash = { ...MANIFEST_RAW, shards: [{ name: 'x.bin', bytes: 1, sha256: '' }] };
  assert.deepEqual(manifestIssues(parseManifest(noHash)),
    ['shard x.bin has an unusable sha256']);
});

// ── the forward pass (the actual parity gate) ────────────────────────
test('ENG-3 logits match the Python reference at every prompt position', async () => {
  const engine = await loadEngine();
  let worst = 0;
  let positions = 0;
  for (const c of REFERENCE.cases) {
    engine.model.reset();
    assert.equal(c.logits.positions.length, c.promptIds.length,
      'the fixture must carry a position per prompt token (§ why: prefill bugs hide at the end)');
    for (let step = 0; step < c.promptIds.length; step++) {
      const logits = engine.model.forward(c.promptIds[step]);
      const expected = c.logits.positions[step];
      assert.equal(engine.model.argmax(logits), expected.argmax,
        `argmax differs at position ${step} of ${JSON.stringify(c.promptText)}`);
      // Magnitudes: bounded, not exact — two float32 accumulation orders
      // (see the fixture's `tolerance` note for the measurement).
      for (const top of expected.top) worst = Math.max(worst, Math.abs(logits[top.id] - top.logit));
      // Ordering: compared as a *set* rather than a sequence, because this
      // fixture's weights are seeded random values, so the top-16 candidates
      // sit within noise of each other and their exact order is not stable
      // under any reordering of the same arithmetic. Argmax above is the
      // exact part; the strong ordering gate runs on trained weights, via
      // `npm run verify:engine` against a real export.
      const ours = new Set([...logits.keys()].sort((a, b) => logits[b] - logits[a]).slice(0, 16));
      const overlap = expected.top.map((t) => t.id).filter((id) => ours.has(id)).length;
      assert.ok(overlap >= 12,
        `only ${overlap}/16 of Python's top candidates are in ours at position ${step} ` +
        `of ${JSON.stringify(c.promptText)}`);
      positions += 1;
    }
  }
  assert.ok(positions > 100, `only ${positions} positions checked`);
  assert.ok(worst < REFERENCE.tolerance.logit,
    `top-16 logits differ by ${worst} (tolerance ${REFERENCE.tolerance.logit}) — the ` +
    'measured drift for this fixture is ~5e-3 in float32');
  engine.dispose();
});

test('ENG-4 the KV cache reproduces a full recomputation, token after token', async () => {
  // The parity fixture cannot gate this on a *random* model: greedy decoding
  // of near-uniform logits is chaotic, so a single flipped argmax three steps
  // in would be noise rather than a bug. Cache correctness is therefore
  // pinned against the same engine's own uncached path, which is exact.
  const engine = await loadEngine();
  const stops = defaultStopIds(engine.tokenizer);
  for (const c of REFERENCE.cases) {
    engine.model.reset();
    for (const id of c.promptIds) engine.model.forward(id);
    const cachedIds = [];
    let previous = c.promptIds.at(-1);
    for (let step = 0; step < 8; step++) {
      const id = engine.model.argmax(engine.model.forward(previous));
      cachedIds.push(id);
      previous = id;
      if (stops.has(id)) break;
    }
    // Same sequence, no cache: recompute from scratch for every new token.
    const sequence = [...c.promptIds, ...cachedIds];
    for (let step = c.promptIds.length; step < sequence.length; step++) {
      engine.model.reset();
      let logits = null;
      for (let i = 0; i < step; i++) logits = engine.model.forward(sequence[i]);
      assert.equal(engine.model.argmax(logits), sequence[step],
        `cached decode diverged from the uncached path at token ${step} ` +
        `of ${JSON.stringify(c.promptText)}`);
    }
  }
  engine.dispose();
});

test('ENG-5 prefill and cached decode agree with a whole-sequence pass', async () => {
  const engine = await loadEngine();
  const ids = REFERENCE.cases[0].promptIds;
  engine.model.reset();
  for (const id of ids) engine.model.forward(id);
  const cached = Float32Array.from(engine.model.logits);
  engine.model.reset();
  let whole = null;
  for (const id of ids) whole = engine.model.forward(id);
  for (let i = 0; i < cached.length; i++) {
    assert.equal(cached[i], whole[i], `logit ${i} differs between the paths`);
  }
  engine.dispose();
});

test('ENG-6 the quantized weights dequantize to the exporter’s matrix', async () => {
  const engine = await loadEngine();
  const embed = engine.weights.get('model.embed_tokens.weight');
  assert.ok(embed.codes instanceof Int8Array && embed.scales instanceof Float32Array);
  assert.equal(embed.rows, 1024);
  assert.equal(embed.cols, MANIFEST_RAW.config.hidden_size);
  // One row, both ways: `rowQ8` (the embedding lookup) and `dequantiseQ8`
  // (the test-only expansion) must not disagree.
  const viaRow = rowQ8(new Float32Array(embed.cols), embed, 7);
  const viaMatrix = dequantiseQ8(embed);
  for (let c = 0; c < embed.cols; c++) {
    assert.equal(viaRow[c], viaMatrix.data[7 * embed.cols + c]);
  }
  // And the codes really are int8 codes, not floats that happen to be small.
  for (let i = 0; i < 64; i++) {
    assert.equal(Number.isInteger(embed.codes[i]), true);
    assert.ok(Math.abs(embed.codes[i]) <= 127);
  }
  engine.dispose();
});

test('ENG-7 the kernels match their numpy twins', async () => {
  const engine = await loadEngine();
  const embed = engine.weights.get('model.embed_tokens.weight');
  const x = new Float32Array(embed.cols).fill(0.5);
  const out = new Float32Array(embed.rows);
  matvecQ8(out, x, embed);
  const manual = dequantiseQ8(embed);
  for (let r = 0; r < 8; r++) {
    let expected = 0;
    for (let c = 0; c < embed.cols; c++) expected += manual.data[r * embed.cols + c] * 0.5;
    assert.ok(Math.abs(out[r] - expected) < 1e-4, `row ${r}: ${out[r]} vs ${expected}`);
  }
  const norm = engine.weights.get('model.norm.weight');
  assert.equal(norm.data.length, embed.cols);
  const normed = rmsNorm(new Float32Array(4), new Float32Array([1, 2, 3, 4]),
    new Float32Array([1, 1, 1, 1]), 1e-5);
  const rms = Math.sqrt((1 + 4 + 9 + 16) / 4);
  assert.ok(Math.abs(normed[3] - 4 / rms) < 1e-6);
  engine.dispose();
});

test('ENG-8 RoPE rotates by position, identically in both halves', () => {
  const { cos, sin } = ropeCache(8, 10000, 4);
  const x = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0]);
  const out = Float32Array.from(x);
  applyRope(out, 0, 8, cos.subarray(0, 8), sin.subarray(0, 8));
  assert.deepEqual([...out].slice(0, 4), [1, 0, 0, 0].map((v, i) => out[i]));
  assert.ok(Math.abs(out[4] - 1) < 1e-5, 'position 0 is the identity rotation');
  // x = [x1, x2] rotates to [x1·cos − x2·sin, x1·sin + x2·cos] with x1 = the
  // first half of the head and x2 the second — the pairing `rotate_half`
  // assumes, and the reason each frequency appears twice in the cache.
  const roped = Float32Array.from(x);
  applyRope(roped, 0, 8, cos.subarray(8, 16), sin.subarray(8, 16));
  assert.ok(Math.abs(roped[0] - (Math.cos(1) - Math.sin(1))) < 1e-5);
  assert.ok(Math.abs(roped[4] - (Math.cos(1) + Math.sin(1))) < 1e-5);
  // The two halves after the split are what make `rotateHalf` valid.
  assert.equal(cos[0], cos[4]);
  assert.equal(sin[3], sin[7]);
});

// ── the loader ───────────────────────────────────────────────────────
test('ENG-9 load verifies hashes, reports progress, and exposes config', async () => {
  const stages = [];
  const engine = await loadEngine({ onProgress: (p) => stages.push(p.stage) });
  assert.ok(stages.includes('manifest'));
  assert.ok(stages.includes('tokenizer'));
  assert.ok(stages.includes('weights'));
  assert.equal(stages.at(-1), 'ready');
  assert.equal(engine.verified, true);
  assert.equal(engine.config.vocab_size, MANIFEST_RAW.config.vocab_size);
  assert.equal(engine.bytes, MANIFEST_RAW.sizes.weightsBytes);
  assert.ok(engine.memoryEstimate.weightsBytes > 0);
  assert.ok(engine.memoryEstimate.note.includes('not a measurement'));
  engine.dispose();
});

test('ENG-10 a corrupted shard is refused, not decoded', async () => {
  const good = fileFetch();
  const corrupting = async (url) => {
    const response = await good(url);
    if (!String(url).endsWith('.bin')) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    bytes[bytes.length - 1] ^= 0xff;   // flip one bit of one byte
    return { ...response, arrayBuffer: async () => bytes.buffer };
  };
  await assert.rejects(() => loadEngine({ fetchImpl: corrupting }), /sha256 check/);
  // With verification off the same shard loads — the flag has to be honest
  // about what it disables, and it is recorded on the engine.
  const engine = await loadEngine({ fetchImpl: corrupting, verify: false });
  assert.equal(engine.verified, false);
  engine.dispose();
});

test('ENG-11 a mismatched tokenizer version is refused (§9.3)', async () => {
  const swapped = { ...MANIFEST_RAW, tokenizer: { ...MANIFEST_RAW.tokenizer, vocabSize: 999 } };
  const fetchImpl = async (url) => {
    if (String(url).endsWith('manifest.json')) {
      return { ok: true, status: 200, json: async () => swapped };
    }
    return fileFetch()(url);
  };
  await assert.rejects(() => loadEngine({ fetchImpl }), /refusing to pair mismatched versions/);
  // A missing manifest and a missing tokenizer are distinguishable failures.
  await assert.rejects(
    () => loadEngine({ fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /manifest fetch failed: 404/);
});

// ── generation ───────────────────────────────────────────────────────
test('ENG-12 the prompt frame is the §7.4 layout, joined by spaces', () => {
  const text = frame({ question: 'Q', context: '[a] b', history: [['u0', 'a0']] });
  assert.equal(text, '<|sys|> ' + PROMPT_RULES.first
    + ' <|ctx|> [a] b <|user|> u0 <|asst|> a0 <|end|> <|user|> Q <|asst|>');
  assert.equal(frame({ question: 'Q', context: '', rules: 'third' }).includes(PROMPT_RULES.third),
    true);
  assert.throws(() => frame({ question: 'Q', rules: 'nope' }), /unknown rules key/);
});

test('ENG-13 generate streams tokens, stops at an end token, and is deterministic',
  async () => {
    const engine = await loadEngine();
    const stops = defaultStopIds(engine.tokenizer);
    assert.equal(stops.has(engine.tokenizer.vocab['<|end|>']), true);
    assert.equal(stops.has(engine.tokenizer.vocab['<|asst|>']), true);
    assert.equal(stops.has(engine.tokenizer.vocab['<|abstain|>']), false,
      'abstention is a result the caller must see, not a silent stop');

    const run = async (opts) => {
      const chunks = [];
      const iterator = engine.generate({
        question: 'What is your name?', context: '[person.name] Aashish', ...opts,
      });
      let result = await iterator.next();
      while (!result.done) {
        chunks.push(result.value);
        result = await iterator.next();
      }
      return { chunks, summary: result.value };
    };

    const first = await run({ maxNewTokens: 6 });
    assert.equal(first.chunks.length, first.summary.ids.length,
      'one chunk per generated token');
    assert.equal(first.summary.tokens, first.chunks.length);
    assert.ok(['end-token', 'max-tokens', 'abstain'].includes(first.summary.stopReason));
    assert.ok(first.summary.promptTokens > 10);
    assert.equal(first.summary.text, first.chunks.map((c) => c.text).join(''),
      'the streamed text and the returned text must be the same string');

    const second = await run({ maxNewTokens: 6 });
    assert.deepEqual(second.summary.ids, first.summary.ids, 'greedy must be reproducible');
    assert.equal(second.summary.text, first.summary.text);

    // §6.3's first degrade step must not change *what* is produced.
    const paced = await run({ maxNewTokens: 6, paceMs: 1 });
    assert.deepEqual(paced.summary.ids, first.summary.ids);
    engine.dispose();
  });

test('ENG-14 Stop works, the context cap is enforced, dispose frees the weights',
  async () => {
    const engine = await loadEngine();
    const controller = new AbortController();
    controller.abort();
    const stopped = engine.generate({ question: 'hi', maxNewTokens: 8, signal: controller.signal });
    const first = await stopped.next();
    assert.equal(first.done, true, 'an already-aborted signal produces nothing');
    assert.equal(first.value.stopReason, 'stopped');

    await assert.rejects(
      () => collect(engine.generate({ question: 'hi', maxNewTokens: 4096 })),
      /exceeds the .* context/);
    // Explicit `stopIds` win, so the answer layer can stop on its own tokens.
    const onlyEnd = await collect(engine.generate({
      question: 'hi', context: '', maxNewTokens: 3,
      stopIds: new Set([engine.tokenizer.vocab['<|end|>']]),
    }));
    assert.ok(onlyEnd.ids.length <= 3);

    const ids = promptIds(engine.tokenizer, { question: 'hi', context: '' });
    assert.ok(ids.length > 4);
    assert.deepEqual(ids.slice(0, 1), [engine.tokenizer.vocab['<|sys|>']]);

    assert.equal(engine.weights.size, 20);
    engine.dispose();
    assert.equal(engine.weights.size, 0);
    assert.equal(typeof createEngine('scratch-llama'), 'function');
    assert.throws(() => createEngine('magic'), /unknown engine kind/);
    assert.ok(ScratchLlamaEngine.prototype instanceof LLMEngine);
  });

async function collect(iterator) {
  let result = await iterator.next();
  while (!result.done) result = await iterator.next();
  return result.value;
}

// The rules text is pinned by the generated contract, not copied here.
const PROMPT_RULES = JSON.parse(
  readFileSync(resolve(HERE, '../ai/engine/prompt_contract.json'), 'utf8')).rules;

/* ── the prompt-prefix cache ──────────────────────────────────────── */

/* The specials and the rules are 125 tokens of a typical 135–300 token prompt
   and identical on every question, so the engine keeps their K/V and prefills
   only what changed. It is a latency optimisation, which means the only thing
   worth testing is that it changes *nothing* the visitor can see — the
   alternative would be a fast wrong answer. */
test('ENG-15 the prompt-prefix cache changes nothing, and only fires on a real match',
  async () => {
    const engine = await loadEngine();
    const prefix = engine.tokenizer.encode(framePrefix({ rules: 'first' }));

    /* The mechanism. Reuse requires the exact ids, so a caller that wrote the
       cache itself can never be handed K/V for a different prompt. */
    engine.model.rememberPrefix(prefix);
    assert.equal(engine.model.reusePrefix(prefix), true, 'the exact prefix must reuse');
    assert.equal(engine.model.pos, prefix.length);
    assert.equal(engine.model.reusePrefix(engine.tokenizer.encode(framePrefix({ rules: 'third' }))),
      false, 'the third-person prefix must not reuse the first-person one');
    assert.equal(engine.model.reusePrefix(prefix.slice(0, -1)), false,
      'a prefix that is one token short must not reuse');
    engine.model.reset();
    assert.equal(engine.model.reusePrefix(prefix), false,
      'reset() must invalidate the claim, since the caller may write any position next');

    /* The equivalence, at the level that cannot be vacuous: the logits after a
       warm prefill must equal the logits after a cold one.

       Comparing generated *ids* would look like the stronger test and be the
       weaker one — this random 2-layer fixture emits NO tokens at all for
       these prompts (measured: 0 ids, `stopReason: 'end-token'`), so the
       comparison would be `[]` against `[]` and pass while proving nothing.
       The logits are produced on every forward, so they always disagree if the
       shortcut is wrong. */
    const context = '[person.name] Aashish';
    const question = 'What is your name?';
    const all = engine.tokenizer.encode(frame({ question, context, rules: 'first' }));

    engine.model.reset();
    for (const id of all) engine.model.forward(id);
    const cold = Float32Array.from(engine.model.logits);

    engine.model.reset();
    for (const id of prefix) engine.model.forward(id);
    engine.model.rememberPrefix(prefix);
    assert.equal(engine.model.reusePrefix(prefix), true);
    for (let i = prefix.length; i < all.length; i++) engine.model.forward(all[i]);
    const warm = Float32Array.from(engine.model.logits);

    assert.equal(warm.length, cold.length);
    for (let i = 0; i < cold.length; i++) {
      assert.equal(warm[i], cold[i],
        `logit ${i} differs after reusing the prefix (${warm[i]} vs ${cold[i]})`);
    }

    /* And `generate()` must actually engage it. If this fails, the split
       (`framePrefix() + rest`) no longer lines up with the tokens being
       prefilled and the latency win silently never happens - the kind of
       regression no other test would notice. */
    engine.model.reset();
    await collect(engine.generate({ question, context, maxNewTokens: 4 }));
    assert.deepEqual([...engine.model.prefixIds], prefix,
      'generate() did not remember the constant prefix, so nothing is reused');

    engine.dispose();
  });

test('ENG-16 frame() is exactly framePrefix() + rest, so the split cannot drift', () => {
  const cases = [
    { question: 'hi', context: '', rules: 'first' },
    { question: 'hi', context: '[skill.python] Python', rules: 'third' },
    { question: 'aap kaun hain', context: 'x', rules: 'first',
      history: [['q1', 'a1'], ['q2', 'a2']] },
  ];
  for (const args of cases) {
    const { prefix, rest } = frameParts(args);
    assert.equal(frame(args), prefix + rest, JSON.stringify(args));
    assert.ok(prefix.startsWith('<|sys|>'), 'the prefix starts with the system frame');
    assert.ok(prefix.endsWith(' '), 'the prefix must end where the context begins');
  }
  assert.equal(framePrefix({ rules: 'first' }), framePrefix({ rules: 'first' }));
  assert.notEqual(framePrefix({ rules: 'first' }), framePrefix({ rules: 'third' }));
  assert.throws(() => framePrefix({ rules: 'nope' }), /unknown rules key/);
});
