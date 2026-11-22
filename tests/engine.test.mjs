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
import { answerGrammar, blockedCitations, factTokens, offeredFactIds,
  templatesFor } from '../ai/engine/grammar.mjs';
import ANSWER_FRAMES from '../ai/answers/answer_frames.json' with { type: 'json' };
import { LlamaEngine, applyRope, ropeCache } from '../ai/engine/llama.mjs';
import { manifestIssues, parseManifest, sha256hex } from '../ai/engine/manifest.mjs';
import { dequantiseQ8, matvecQ8, rmsNorm, rowQ8 } from '../ai/engine/quant.mjs';
import { abstainId, defaultStopIds, fitToBudget, frame, frameParts, framePrefix, promptIds }
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
  /* No `rules` passed on purpose: this is the DEFAULT frame, and since §5 the
     default voice is the third person, so an unlabelled call cannot quietly
     ask the model to answer as Aashish. */
  const text = frame({ question: 'Q', context: '[a] b', history: [['u0', 'a0']] });
  assert.equal(text, '<|sys|> ' + PROMPT_RULES.third
    + ' <|ctx|> [a] b <|user|> u0 <|asst|> a0 <|end|> <|user|> Q <|asst|>');
  assert.equal(frame({ question: 'Q', context: '', rules: 'first' }).includes(PROMPT_RULES.first),
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

/* The cache keeps the K/V of the prompt it was last given and a new prompt
   reuses however many leading token ids it shares with that. Every question
   shares at least the specials and the rules (125 tokens of a typical 135–300
   token prompt), and a repeat question shares all of it. It is a latency
   optimisation, which means the only thing worth testing is that it changes
   *nothing* the visitor can see — the alternative would be a fast wrong
   answer. */
test('ENG-15 the prompt-prefix cache changes nothing, and only fires on a real match',
  async () => {
    const engine = await loadEngine();
    const prefix = engine.tokenizer.encode(framePrefix({ rules: 'first' }));

    /* The mechanism. The match is element-wise on the ids, so the skip can only
       ever be as long as the ids genuinely agree: a caller cannot be handed
       K/V for a token it did not itself feed at that position. */
    engine.model.rememberPrefix(prefix);
    assert.equal(engine.model.reusePrefix(prefix), prefix.length,
      'the exact prefix must reuse in full');
    assert.equal(engine.model.pos, prefix.length);
    assert.ok(engine.model.reusePrefix(engine.tokenizer.encode(framePrefix({ rules: 'third' })))
      < prefix.length,
      'the third-person rules must not reuse the first-person ones in full');
    assert.equal(engine.model.reusePrefix(prefix.slice(0, -1)), prefix.length - 1,
      'a prefix one token short still reuses every position before the one that differs');
    engine.model.reset();
    assert.equal(engine.model.reusePrefix(prefix), 0,
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

    /* Warm: the cache holds a prefix of the prompt, the rest is fed.
       `reusePrefix` returning 0 here would mean the shortcut silently never
       engages and the latency win evaporates without any test noticing. */
    const cut = all.length - 2;
    assert.ok(cut > 0 && cut < all.length);
    engine.model.reset();
    for (let i = 0; i < cut; i++) engine.model.forward(all[i]);
    engine.model.rememberPrefix(all.slice(0, cut));
    assert.equal(engine.model.reusePrefix(all), cut,
      'a warm prefix must be reused up to the first token that differs');
    for (let i = cut; i < all.length; i++) engine.model.forward(all[i]);
    const warm = Float32Array.from(engine.model.logits);

    assert.equal(warm.length, cold.length);
    for (let i = 0; i < cold.length; i++) {
      assert.equal(warm[i], cold[i],
        `logit ${i} differs after reusing the prefix (${warm[i]} vs ${cold[i]})`);
    }

    /* And `generate()` must actually engage it, by remembering the prompt it
       fed. If the wrong thing is remembered, nothing is ever reused and the
       latency win silently never happens. */
    engine.model.reset();
    await collect(engine.generate({ question, context, rules: 'first', maxNewTokens: 4 }));
    assert.deepEqual([...engine.model.prefixIds], all,
      'generate() did not remember the prompt it prefilled, so nothing is reused');

    engine.dispose();
  });

test('ENG-17 a follow-up that shares facts skips more than the constant rules block',
  async () => {
    const engine = await loadEngine();
    const context = '[project.x] Goal Tracker — a habit tracker built with React.';

    /* Two different questions over the SAME retrieved facts: the prompts share
       the specials, the rules AND the whole context block, so a follow-up
       should skip past the rules block. That is the case this generalisation
       exists for — the old exact-length match could only ever skip the rules. */
    const first = engine.tokenizer.encode(
      frame({ question: 'Tell me about that project', context, rules: 'first' }));
    const second = engine.tokenizer.encode(
      frame({ question: 'What did he build it with?', context, rules: 'first' }));
    const rulesLen = engine.tokenizer.encode(framePrefix({ rules: 'first' })).length;

    engine.model.reset();
    for (const id of first) engine.model.forward(id);
    const cold = (() => {
      engine.model.reset();
      for (const id of second) engine.model.forward(id);
      return Float32Array.from(engine.model.logits);
    })();

    engine.model.reset();
    for (const id of first) engine.model.forward(id);
    engine.model.rememberPrefix(first);
    const reused = engine.model.reusePrefix(second);
    assert.ok(reused > rulesLen,
      `shared only ${reused} tokens, no more than the rules block (${rulesLen}) — ` +
      'the shared facts were not reused');
    for (let i = reused; i < second.length; i++) engine.model.forward(second[i]);
    const warm = Float32Array.from(engine.model.logits);

    for (let i = 0; i < cold.length; i++) {
      assert.equal(warm[i], cold[i],
        `logit ${i} differs after reusing the shared facts (${warm[i]} vs ${cold[i]})`);
    }

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

/* ── fitting the window ──────────────────────────────────────────────
   The model has `max_position_embeddings` positions and a prompt that wants
   one more does not degrade — `forward()` throws, and the visitor is told the
   model stopped for a question the portfolio answers in full. MEASURED: 14 of
   the 60 evaluation questions, and 3 of them still overflow even with no token
   budget at all, because the question and the frame alone are that long.

   `fitToBudget` is the fix, and it is deliberately a pure function of the
   tokenizer: the engine tests can therefore exercise the real logic on the
   tiny fixture (maxSeq 256) without the 5 MB export. */
test('ENG-18 a context that does not fit is trimmed from the tail, never thrown',
  async () => {
    const engine = await loadEngine();
    const { tokenizer } = engine;
    const maxSeq = engine.model.maxSeq;
    assert.ok(maxSeq >= 64, `fixture too small to be interesting: ${maxSeq}`);

    const lines = Array.from({ length: 60 }, (_, i) => `[fact.${i}] value number ${i}`);
    const context = lines.join('\n');
    const question = 'What is his CGPA?';
    const maxNewTokens = 8;
    const rules = 'first';
    const history = [['an earlier question', 'an earlier answer']];

    const fitted = fitToBudget({ tokenizer, question, context, history, rules,
      maxNewTokens, maxSeq });

    assert.ok(fitted.promptTokens + maxNewTokens <= maxSeq,
      `${fitted.promptTokens} + ${maxNewTokens} > ${maxSeq}`);
    assert.ok(fitted.droppedContextLines > 0, 'nothing was dropped, so nothing was tested');
    assert.equal(fitted.droppedHistoryTurns, 0, 'the context was enough, so history stays');
    /* what survives is a PREFIX of what was offered: lines arrive best-first,
       so the tail is the weakest evidence and the first line is the last to go */
    assert.equal(fitted.context,
      lines.slice(0, lines.length - fitted.droppedContextLines).join('\n'));
    assert.ok(context.startsWith(fitted.context));

    /* `contextTokens` is the context's own cost INSIDE this frame — the number
       §8.2's estimate was always trying to approximate */
    const bare = tokenizer.encode(frame({ question, context: '', history, rules })).length;
    assert.equal(fitted.contextTokens, fitted.promptTokens - bare);
    assert.ok(fitted.contextTokens > 0);

    /* history goes next, oldest turn first (§10). The budget here is DERIVED
       from the tokenizer rather than guessed, so the test states the rule
       (two turns fit, three do not) instead of a magic number. */
    const oneCtx = '[a] one';
    const withoutTurn = tokenizer.encode(
      frame({ question, context: oneCtx, history: [], rules })).length;
    const turnCost = tokenizer.encode(
      frame({ question, context: oneCtx, history: [['q1', 'a1']], rules })).length - withoutTurn;
    assert.ok(turnCost > 1, 'the fixture must charge something for a turn');
    const twoTurns = maxSeq - (withoutTurn + 2 * turnCost) - 1;
    const many = fitToBudget({ tokenizer, question, context: oneCtx,
      history: [['q1', 'a1'], ['q2', 'a2'], ['q3', 'a3']],
      rules, maxNewTokens: twoTurns, maxSeq });
    assert.equal(many.droppedHistoryTurns, 1, 'exactly the oldest turn must go');
    assert.deepEqual(many.history, [['q2', 'a2'], ['q3', 'a3']]);
    assert.ok(many.promptTokens + twoTurns <= maxSeq);

    /* a question that does not fit on its own is a real error, not a silent
       answer to a different question */
    assert.throws(() => fitToBudget({ tokenizer, question: 'x'.repeat(4000),
      context: '', history: [], rules, maxNewTokens, maxSeq }),
      /no context left to trim/);
    assert.throws(() => fitToBudget({ tokenizer, question, maxSeq: undefined }),
      /needs maxSeq/);

    /* and generate() reports what it ACTUALLY read, which is what the guard
       and the §12 sources are checked against */
    const summary = await collect(engine.generate({ question, context, maxNewTokens,
      rules, history }));
    assert.equal(summary.context, fitted.context,
      'generate() and fitToBudget must trim identically for identical inputs');
    assert.equal(summary.droppedContextLines, fitted.droppedContextLines);
    assert.equal(summary.contextTokens, fitted.contextTokens);
    assert.ok(summary.promptTokens + maxNewTokens <= maxSeq);

    engine.dispose();
  });

/* ── §10's Stop, as the worker actually receives it ─────────────────

   MEASURED 2026-09-28, and the reason these two exist: a Stop reaches the
   engine as a `postMessage`, and a message is a TASK. The decode loop used to
   await `Promise.resolve()` — a microtask — and a chain of microtasks never
   returns to the event loop, so the abort stayed in the queue until the
   generation it was meant to stop had finished. The engine looked like it
   supported Stop; what actually stopped was the answer, while the worker kept
   computing and the next question queued behind the abandoned work. The P2
   probe found it as a `Retry` that took minutes to stream.

   The event-loop property under test is not node-specific: a worker's message
   queue is a task queue there too, which is why the probe reproduced it in a
   browser and the timer below reproduces it here. */
test('ENG-19 a prefill is cut short when the Stop is delivered', async () => {
  const engine = await loadEngine();
  /* Long enough that the prefill has several breath points. The fixture's
     window is 256 tokens, so `fitToBudget` trims this back to fit. */
  const context = Array.from({ length: 120 },
    (_, i) => `[project.p${i}] a shipped thing with a name ${i}`).join('\n');
  const opts = { question: 'What is your name?', context, maxNewTokens: 8 };

  let forwards = 0;
  const realForward = engine.model.forward.bind(engine.model);
  engine.model.forward = (id) => { forwards += 1; return realForward(id); };

  const controller = new AbortController();
  /* The timer stands in for the worker's message: both are tasks, and a task
     queued before the generation starts must run DURING it. */
  let delivered = false;
  const timer = setTimeout(() => { delivered = true; controller.abort(); }, 0);
  const summary = await collect(engine.generate({ ...opts, signal: controller.signal }));
  clearTimeout(timer);

  assert.equal(delivered, true,
    'the abort must be delivered during the generation, not after it');
  assert.equal(summary.stopReason, 'stopped');
  assert.equal(summary.tokens, 0, 'a stopped prefill has no tokens to give');
  assert.ok(summary.promptTokens > 32,
    `the fixture prompt must be long enough to have breath points (${summary.promptTokens})`);
  assert.ok(forwards > 0 && forwards < summary.promptTokens,
    `the prefill must stop early: ${forwards} of ${summary.promptTokens} forwards`);

  /* And the half-filled K/V cache is NOT remembered. `reusePrefix` matches on
     token ids, so a remembered half-prompt would let the next question skip a
     prefix the model never actually read. */
  forwards = 0;
  const after = await collect(engine.generate({ ...opts, maxNewTokens: 2 }));
  assert.ok(forwards >= summary.promptTokens / 2,
    `the next question must not reuse an aborted prefill (${forwards} forwards)`);
  assert.ok(after.tokens >= 0);
  engine.dispose();
});

test('ENG-20 the decode loop hands the event loop back, so a Stop is not queued behind the answer',
  async () => {
    const engine = await loadEngine();
    const stops = defaultStopIds(engine.tokenizer);
    const abstain = abstainId(engine.tokenizer);
    let plain = 0;
    while (stops.has(plain) || plain === abstain) plain += 1;

    /* A stub model, because the fixture is random-init: whether it emits an end
       token at step 2 or at step 40 is not something this test should depend
       on, and the subject here is the LOOP's cooperation, not what the loop
       produces. Every step returns the same ordinary token. */
    const real = engine.model;
    engine.model = {
      maxSeq: real.maxSeq,
      reset() {}, reusePrefix: () => 0, rememberPrefix() {},
      forward: () => real.logits, argmax: () => plain,
    };

    const controller = new AbortController();
    const iterator = engine.generate({
      question: 'x', context: '', maxNewTokens: 60, signal: controller.signal,
    });
    const first = await iterator.next();
    assert.equal(first.done, false, 'the stub model never stops on its own');
    /* Queued DURING the decode loop: nothing but a real breath can deliver it. */
    setTimeout(() => controller.abort(), 0);
    const summary = await collect(iterator);

    assert.equal(summary.stopReason, 'stopped',
      `a Stop must stop the loop (it ran ${summary.tokens} tokens and stopped with ${summary.stopReason})`);
    assert.ok(summary.tokens > 0 && summary.tokens < 60,
      `stopped after ${summary.tokens} of 60 tokens`);
    engine.dispose();
  });

/* ── the closed answer space (ai/engine/grammar.mjs) ──────────────

   These pin the property the sft7 sweep needed and did not have: a turn can
   name a fact, but not in someone else's sentence — `His GitHub is <email>` is
   unreachable rather than merely unlikely. The measurement is in
   docs/BENCHMARKS.md (2026-10-25). */
test('ENG-23 the closed grammar is the trained frames, over offered facts only',
  async () => {
    const engine = await loadEngine();
    const tok = engine.tokenizer;

    // The table the grammar is built from is the training table, not a copy.
    assert.ok(ANSWER_FRAMES.frames['person.name'].en.third.includes('{v}'));
    /* A skill with no frame of its own is answered by its kind: the
       question-agnostic frame and the list frame, in each language. */
    assert.deepEqual(templatesFor('skill.mongodb', 'third').map((t) => t.text),
      ['He works with {v}.', 'वे {v} के साथ काम करते हैं।', 'Wo {v} ke saath kaam karte hain.',
        'His tech stack: {v}.', 'उनकी तकनीकें: {v}।', 'Unki technologies: {v}.']);
    assert.equal(templatesFor('skill.mongodb', 'third').every((t) => !t.text.startsWith('I ')),
      true, 'the first-person frames must not be offered to a third-person turn');

    const g = answerGrammar(tok, '[person.name] Aashish');
    assert.deepEqual(g.offered, ['person.name']);
    const walk = (text) => {
      let state = g.start;
      for (const id of tok.encode(text)) {
        if (!g.allowed(state).has(id)) return null;
        state = g.step(state, id);
        if (!state.size) return null;
      }
      return state;
    };
    assert.ok(walk(' His name is '), 'the trained frame must be walkable');
    assert.equal(walk(' His GitHub is '), null,
      'a frame whose fact was not offered is not a legal answer');

    const slot = walk(' His name is ');
    assert.deepEqual([...g.allowed(slot)], [tok.vocab['<|fact:person.name|>']],
      'the slot admits exactly the fact the frame names');
    const after = g.step(slot, tok.vocab['<|fact:person.name|>']);
    assert.deepEqual([...g.allowed(after)], tok.encode('.'),
      'only the frame\'s own suffix may follow the fact');
    const done = g.step(after, tok.encode('.')[0]);
    assert.deepEqual([...g.allowed(done)].sort(),
      [tok.vocab['<|end|>'], tok.vocab['<|asst|>']].sort(),
      'a finished sentence can only end');

    // A turn with nothing framed is NOT forced into a refusal by the grammar:
    // `null` sends the caller back to the weaker citation mask.
    assert.equal(answerGrammar(tok, ''), null);
    engine.dispose();
  });

/* A joined list is a LOOP through the separator, so the separator is a
   TRANSITION and not merely a permission. MEASURED before this was true, on
   the sft7 export (2026-10-26, the 60 §14 prompts): `His tech stack:
   <|fact:skill.c|>` stopped after 8 tokens with reason `grammar` and no full
   stop, because `allowed` offered `,` (from `seps`) and `step` had no node to
   walk to. Every `_conj` list could hold exactly one item. */
test('ENG-25 a list separator walks into the next fact of the same kind',
  async () => {
    const engine = await loadEngine();
    const tok = engine.tokenizer;
    const g = answerGrammar(tok, '[skill.mongodb] MongoDB\n[skill.mysql] MySQL');
    const mongo = tok.vocab['<|fact:skill.mongodb|>'];
    const mysql = tok.vocab['<|fact:skill.mysql|>'];
    const comma = tok.encode(',')[0];
    const fullStop = tok.encode('.')[0];

    const feed = (state, ids) => {
      for (const id of ids) {
        assert.ok(g.allowed(state).has(id), `token ${id} should be legal here`);
        state = g.step(state, id);
        assert.ok(state.size, 'a legal token must lead somewhere');
      }
      return state;
    };

    let state = feed(g.start, tok.encode(' His tech stack: '));
    assert.deepEqual([...g.allowed(state)].sort(), [mongo, mysql].sort(),
      'both offered skills fill the kind frame');

    state = feed(state, [mongo]);
    assert.ok(g.allowed(state).has(fullStop), 'the frame can end after one fact');
    assert.ok(g.allowed(state).has(comma), 'a second fact can follow a separator');

    state = feed(state, [comma]);
    /* The joiner is the trained text `", "`, and it tokenizes to `","` and
       `" "`: after the comma the rest of the separator is still owed. MEASURED
       before this was true (the 2026-11-01 scoped sweep): the sink sat at the
       END of the joiner's token chain, so `step` skipped every token after the
       first and the model wrote `His certifications: <a>,<b> and<c>.` — the
       words `" "` and `" aur "` it was trained to say were never written. */
    assert.deepEqual([...g.allowed(state)], tok.encode(' '),
      'the rest of the joiner is required, not skipped');
    state = feed(state, tok.encode(' '));
    assert.ok(g.allowed(state).has(mysql), 'the separator leads into the next item');
    assert.equal(g.allowed(state).has(mongo), false, 'a fact is named once per sentence');

    state = feed(state, [mysql]);
    assert.equal(g.allowed(state).has(comma), false,
      'with every fact of the kind named, the separator has nowhere to lead');
    assert.ok(g.allowed(state).has(fullStop));
    state = feed(state, [fullStop]);
    assert.deepEqual([...g.allowed(state)].sort(),
      [tok.vocab['<|end|>'], tok.vocab['<|asst|>']].sort());
    engine.dispose();
  });

/* The plan's own single-fact decision, passed to the decoder. MEASURED
   2026-10-30 (§14 d01): "What is his email?" offered `contact.email` and one
   retrieved project, and the model wrote `His main project is …`. Both frames
   were legal, so the closed space had to be narrowed by what the planner
   already knew — and only ever inside the context it read. */
test('ENG-26 the plan\'s single fact narrows the closed space, inside the context',
  async () => {
    const engine = await loadEngine();
    const tok = engine.tokenizer;
    const context = '[contact.email] a@b.test\n[project.volunteer] A monorepo';
    const email = tok.vocab['<|fact:contact.email|>'];
    const project = tok.vocab['<|fact:project.volunteer|>'];

    const g = answerGrammar(tok, context, { only: ['contact.email'] });
    assert.deepEqual(g.offered, ['contact.email'],
      'only the scoped fact may fill a slot');
    assert.equal(g.scoped, true);

    let state = g.start;
    for (const id of tok.encode(' Email him at ')) {
      assert.ok(g.allowed(state).has(id), `token ${id} must be legal in the frame`);
      state = g.step(state, id);
    }
    assert.deepEqual([...g.allowed(state)], [email], 'the slot holds the one fact');

    /* The distractor's own frame must not even be walkable. */
    let projectState = g.start;
    let reachable = true;
    for (const id of tok.encode(' His main project is ')) {
      if (!g.allowed(projectState).has(id)) { reachable = false; break; }
      projectState = g.step(projectState, id);
    }
    assert.equal(reachable, false, 'the unrelated project frame is not reachable');
    assert.ok(!g.offered.includes('project.volunteer'));
    assert.equal(project > -1, true);

    /* A scope the turn never read is not evidence: the context stays the
       bound and the turn is NOT narrowed into an empty space. */
    const fallback = answerGrammar(tok, context, { only: ['skill.gemini'] });
    assert.deepEqual(fallback.offered, ['contact.email', 'project.volunteer']);
    assert.equal(fallback.scoped, false);
    engine.dispose();
  });

/* The question's own shape, carried to the decoder. MEASURED 2026-11-06 on the
   shipping export: `i02` ("What backend technologies has he worked with?") and
   `d16` ("uske projects kaun kaun se hain?") each carried three expected facts
   and answered with one, in the ONE-FACT kind frame (`He works with …`,
   `Unhone … banaya.`) — a sentence that answers "which one", not "which ones".
   `listsOnly` removes the single-fact shapes for a whole-kind question, so the
   only legal answer is the trained list sentence. */
test('ENG-27 a whole-kind turn is decoded against the LIST sentence only',
  async () => {
    const engine = await loadEngine();
    const tok = engine.tokenizer;
    const context = '[project.volunteer] A\n[project.grocery] B\n[project.goaltracker] C';

    /* The predicate is what the answer layer passes; here it is stated
       directly so the grammar's contract is measured on its own. */
    assert.deepEqual(templatesFor('project.volunteer', 'third', { listsOnly: true })
      .map((t) => t.text),
    ['His projects: {v}.', 'उनके प्रोजेक्ट्स: {v}।', 'Unke projects: {v}.'],
    'listsOnly keeps the list frame in every language and nothing else');
    assert.ok(templatesFor('project.volunteer', 'third').length > 3,
      'without the flag the single-fact frames are still offered');

    const g = answerGrammar(tok, context, { listsOnly: true });
    const walk = (text) => {
      let state = g.start;
      for (const id of tok.encode(text)) {
        if (!g.allowed(state).has(id)) return null;
        state = g.step(state, id);
        if (!state.size) return null;
      }
      return state;
    };
    assert.ok(walk(' His projects: '), 'the list frame is walkable');
    assert.equal(walk(' He built '), null,
      'the one-fact frame is not a legal answer to a whole-kind question');

    /* And the list still holds every fact it was given: one item is a legal
       prefix, but the separator stays open until all three are named. */
    const volunteer = tok.vocab['<|fact:project.volunteer|>'];
    const grocery = tok.vocab['<|fact:project.grocery|>'];
    const goal = tok.vocab['<|fact:project.goaltracker|>'];
    let state = walk(' His projects: ');
    assert.deepEqual([...g.allowed(state)].sort(), [volunteer, grocery, goal].sort(),
      'every offered project fills the list');
    state = g.step(state, volunteer);
    assert.ok(g.allowed(state).has(tok.encode(',')[0]), 'a second item is offered');

    /* A kind with no trained list sentence is NOT forced into an empty space. */
    assert.equal(answerGrammar(tok, '[edu.lpu] A university', { listsOnly: true }), null);
    engine.dispose();
  });

test('ENG-24 with the closed grammar the answer is a trained sentence, not a fragment',
  async () => {
    const engine = await loadEngine();
    const tok = engine.tokenizer;
    const { byId } = factTokens(tok);
    const name = byId.get('person.name');
    const email = byId.get('contact.email');

    /* The stub ranks the UNOFFERED fact first — the failure the grammar exists
       for. Only `person.name` is in the context. */
    const real = engine.model;
    const logits = new Float32Array(tok.vocabSize).fill(-20);
    logits[email] = 9;
    logits[name] = 7;
    engine.model = {
      maxSeq: real.maxSeq,
      reset() {}, reusePrefix: () => 0, rememberPrefix() {},
      forward: () => logits,
      argmax: (l, blocked) => real.argmax(l, blocked),
      argmaxOf: (l, ids) => real.argmaxOf(l, ids),
    };

    const summary = await collect(engine.generate({
      question: 'Who is he?', context: '[person.name] Aashish', maxNewTokens: 40,
      answerGrammar: true,
    }));

    const text = summary.rawText.trim();
    const frames = ['en', 'hi', 'hinglish']
      .map((lang) => ANSWER_FRAMES.frames['person.name'][lang].third
        .replace('{v}', '<|fact:person.name|>').trim());
    assert.equal(summary.stopReason, 'end-token',
      `the turn must end at the frame's end (got ${summary.stopReason}: ${text})`);
    assert.ok(frames.includes(text),
      `the answer must be one of the trained frames, got ${JSON.stringify(text)}`);
    assert.equal(summary.closedAnswer?.offered, 1);
    assert.ok(summary.closedAnswer.templates >= 3);
    assert.ok(summary.maskedCitations > 0,
      'the grammar had to overrule the model at least once');

    engine.dispose();
  });

/* ── the citation grammar (ai/engine/grammar.mjs) ─────────────────

   WHY it exists is measured, not asserted here: 14 of the 19 wrong answers in
   the 2026-10-25 §14 sweep cited a fact that was not in the prompt's context
   (docs/BENCHMARKS.md). What these pin is that the constraint is derived from
   the context the model actually read, and that the decode loop obeys it. */
test('ENG-21 a turn offers exactly the facts its fitted context names', () => {
  const tokenizer = { vocab: { 'x': 0, '<|fact:person.name|>': 7, '<|fact:edu.lpu|>': 9 } };

  assert.deepEqual([...offeredFactIds('[person.name] Aashish\n[edu.lpu] a university')],
    ['person.name', 'edu.lpu']);
  // Only a LINE-LEADING `[id]` is a context line: brackets inside a value, or
  // a bracketed phrase in prose, must not extend what the turn may cite.
  assert.equal(offeredFactIds('he said [not a fact] and left').size, 0);
  assert.deepEqual([...offeredFactIds('[a.b] value with [brackets] inside')], ['a.b']);
  assert.equal(offeredFactIds('no markers at all').size, 0);
  assert.equal(offeredFactIds('').size, 0);
  assert.equal(offeredFactIds(null).size, 0);

  assert.deepEqual([...blockedCitations(tokenizer, '[person.name] Aashish')], [9],
    'the offered fact is allowed and every other fact token is removed');
  assert.deepEqual([...blockedCitations(tokenizer, '')], [7, 9],
    'no context offers no facts, so no citation is legal');
  assert.equal(factTokens(tokenizer).byId.size, 2);

  /* The frame tokens are never content: a model that emits one has fallen out
     of the answer and into the prompt layout (measured on `syn01`, which read
     "His CGPA is <|user|>."). `<|end|>`, `<|asst|>` and `<|abstain|>` are a
     stop and a result, so they stay available. */
  const framed = { vocab: { x: 0, '<|sys|>': 1, '<|ctx|>': 2, '<|user|>': 3,
    '<|asst|>': 4, '<|end|>': 5, '<|abstain|>': 6 } };
  assert.deepEqual([...blockedCitations(framed, '')], [1, 2, 3]);
  assert.equal(blockedCitations({ vocab: { x: 0 } }, '').size, 0,
    'a vocabulary with no frame tokens and no facts blocks nothing');
});

test('ENG-22 the decode loop cannot emit a fact token the turn was not offered', async () => {
  const engine = await loadEngine();
  const { byId, ids: allFactIds } = factTokens(engine.tokenizer);
  const offered = byId.get('person.name');
  const offLimits = byId.get('contact.email');
  assert.ok(offered !== undefined && offLimits !== undefined,
    'the fixture vocabulary must carry both fact tokens for this to mean anything');

  /* A stub model (as in ENG-20): the fixture is random-init, and the subject
     here is the CONSTRAINT, not what a random model happens to prefer. It
     ranks the off-limits fact ABOVE the offered one, which is the failure the
     grammar exists to catch. */
  const real = engine.model;
  const logits = new Float32Array(engine.tokenizer.vocabSize).fill(-10);
  logits[offered] = 5;
  logits[offLimits] = 8;
  engine.model = {
    maxSeq: real.maxSeq,
    reset() {}, reusePrefix: () => 0, rememberPrefix() {},
    forward: () => logits,
    argmax: (l, blocked) => real.argmax(l, blocked),
  };

  const run = (context) => collect(engine.generate({
    question: 'Who is he?', context, maxNewTokens: 2,
  }));

  const free = await run('[person.name] Aashish\n[contact.email] a@b.test');
  assert.deepEqual(free.ids, [offLimits, offLimits],
    'when both facts were offered the model keeps its own preference');
  assert.equal(free.maskedCitations, 0, 'nothing had to be blocked');
  assert.equal(free.offeredFacts, 2);

  const constrained = await run('[person.name] Aashish');
  assert.deepEqual(constrained.ids, [offered, offered],
    'the un-offered citation is skipped and the next-best token wins');
  assert.equal(constrained.maskedCitations, 2,
    'the number reported is how often the grammar overruled the model');
  assert.equal(constrained.offeredFacts, 1);

  const empty = await run('');
  assert.equal(empty.offeredFacts, 0);
  assert.ok(empty.ids.every((id) => !allFactIds.has(id)),
    'with no context no fact token is legal: ' + JSON.stringify(empty.ids));

  engine.dispose();
});
