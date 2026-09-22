/* ═══════════════════════════════════════════════════════════════
   tests/governor.test.mjs — §6 tiers, frame health and the degrade ladder

   The environment is injected, so every branch is testable in Node with no
   browser. Frozen regressions from the build:

     GOV-1 SIMD_PROBE_BYTES was malformed (v128.const with five immediates
           instead of sixteen). `hasSimd` therefore returned false on every
           engine, and chooseTier forced EVERY device to T0 — the model could
           never have run anywhere, on any hardware. The snippet is now
           validated against V8 itself, which is the same engine Chrome ships.
     GOV-2 the ladder could move more than one step per window, and could
           oscillate between degrade and restore on alternating frames.

   THRESHOLDS is a documented "starting heuristic" (§6.2), not a measured
   constant — these tests pin the DECISION RULES, not the tuning.
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, THRESHOLDS, tierInfo, probeCapabilities, chooseTier, hasSimd,
  SIMD_PROBE_BYTES, probeWebGPU, createFrameMonitor, createDegradeLadder, LADDER,
} from '../ai/governor/index.mjs';

/** A fake `globalThis`-shaped environment. */
function fakeEnv(over = {}) {
  return {
    navigator: {
      hardwareConcurrency: 8,
      deviceMemory: 8,
      connection: { effectiveType: '4g', saveData: false },
      ...(over.navigator || {}),
    },
    matchMedia: (q) => ({ matches: !!(over.media && over.media[q]) }),
    Worker: over.worker === false ? undefined : function () {},
    Blob: over.worker === false ? undefined : function () {},
    URL: over.worker === false ? undefined : { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    WebAssembly: over.wasm === false ? undefined : WebAssembly,
    crossOriginIsolated: false,
    ...over.top,
  };
}

/* ── the hard requirement ───────────────────────────────────────── */
test('GOV-1: the SIMD probe module is valid, and a broken one is detected', () => {
  /* the same V8 that ships in Chrome validates the bytes */
  assert.equal(WebAssembly.validate(SIMD_PROBE_BYTES), true,
    'SIMD_PROBE_BYTES is not a valid wasm module — this silently forces every device to T0');
  assert.equal(hasSimd(WebAssembly), true);
  /* …and a module that does not compile must report false, not throw */
  assert.equal(hasSimd({ Module: function () { throw new Error('no simd'); } }), false);
  assert.equal(hasSimd({}), false);
  /* the malformed shape that caused GOV-1 stays invalid, so the fix is real */
  const broken = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00,
    0x0a, 0x0a, 0x01, 0x08, 0x00, 0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b]);
  assert.equal(WebAssembly.validate(broken), false);
});

/* ── §6.1 probing ───────────────────────────────────────────────── */
test('§6.1: probing never throws, and a missing API is a fact not an error', () => {
  const bare = probeCapabilities({}, {});
  assert.equal(bare.worker, false);
  assert.equal(bare.wasm, false);
  assert.equal(bare.threads, 0);
  assert.equal(bare.memoryReported, false);
  assert.equal(bare.coarsePointer, false);
  assert.equal(bare.wasmSimd, null, 'unknown is null, not false');

  const rich = probeCapabilities(fakeEnv({ media: { '(pointer: coarse)': true, '(prefers-reduced-motion: reduce)': true } }),
    { benchmarkMs: 3, wasmSimd: true, storageBytes: 500 * 1024 * 1024 });
  assert.equal(rich.worker, true);
  assert.equal(rich.wasm, true);
  assert.equal(rich.wasmSimd, true);
  assert.equal(rich.threads, 8);
  assert.equal(rich.memory, 8);
  assert.equal(rich.memoryReported, true);
  assert.equal(rich.coarsePointer, true);
  assert.equal(rich.reducedMotion, true);
  assert.equal(rich.benchmarkMs, 3);
});

test('§6.1: WebGPU is probed asynchronously and an absent adapter is false', async () => {
  assert.equal(await probeWebGPU({}), false);
  assert.equal(await probeWebGPU({ navigator: { gpu: {} } }), false);
  assert.equal(await probeWebGPU({ navigator: { gpu: { requestAdapter: async () => ({}) } } }), true);
  assert.equal(await probeWebGPU({ navigator: { gpu: { requestAdapter: async () => { throw new Error('x'); } } } }), false);
});

/* ── §6.2 tiers ─────────────────────────────────────────────────── */
test('§6.2: hard blockers fall to T0 (Quick Answers still work)', () => {
  const passing = { worker: true, wasm: true, wasmSimd: true, threads: 8, memory: 8, memoryReported: true, coarsePointer: false, saveData: false, effectiveType: '4g', storageBytes: 500e6, benchmarkMs: 3 };
  assert.equal(chooseTier(passing), 3, 'the happy path must reach T3');
  assert.equal(chooseTier({ ...passing, worker: false }), 0);
  assert.equal(chooseTier({ ...passing, wasm: false }), 0);
  assert.equal(chooseTier({ ...passing, wasmSimd: false }), 0, 'SIMD is required, not optional');
  assert.equal(chooseTier({ ...passing, storageBytes: 10 * 1024 * 1024 }), 0, 'no room to cache a model');
  assert.equal(chooseTier({ ...passing, saveData: true }), 0, 'saveData means do not download');
  assert.equal(chooseTier(null), 0);
});

test('§6.2: thin devices and slow networks land on T1, never T3', () => {
  const base = { worker: true, wasm: true, wasmSimd: true, threads: 8, memory: 8, memoryReported: true, coarsePointer: false, saveData: false, effectiveType: '4g', storageBytes: 500e6, benchmarkMs: 3 };
  for (const over of [{ coarsePointer: true }, { threads: 2 }, { threads: 0 }, { memory: 2 },
    { effectiveType: '3g' }, { effectiveType: '2g' }, { benchmarkMs: 40 }]) {
    assert.equal(chooseTier({ ...base, ...over }), 1, JSON.stringify(over));
  }
  /* An unreported memory figure (Safari/Firefox) keeps a device out of T3.
     T3 is deliberately the only tier that requires a REPORTED memory figure:
     §6.2 says a session may move down at runtime and "never silently up", so
     the top tier is the one that should be hard to reach. Such a device
     still gets the standard T2 experience, which is the intended default. */
  assert.equal(chooseTier({ ...base, memory: 0, memoryReported: false }), 2);
  /* a middling laptop is T2 */
  assert.equal(chooseTier({ ...base, threads: 4, memoryReported: false, benchmarkMs: 9 }), 2);
});

test('§6.2: tierInfo is total and T0 promises no model', () => {
  assert.equal(TIERS.length, 4);
  for (const t of TIERS) assert.ok(t.name && t.label && t.note);
  assert.equal(TIERS[0].llm, false);
  assert.equal(TIERS[0].context, 0);
  for (const t of TIERS.slice(1)) { assert.equal(t.llm, true); assert.ok(t.context > 0 && t.maxNew > 0); }
  assert.equal(tierInfo(-5).name, 'T0');
  assert.equal(tierInfo(99).name, 'T3');
});

/* ── §6.3 frame health ──────────────────────────────────────────── */
test('§6.3: the monitor ignores noise and reports ema/p95', () => {
  const m = createFrameMonitor({ sampleWindow: 10 });
  m.push(0); m.push(-5); m.push(2000); m.push(NaN);
  assert.equal(m.count, 0, 'a paused or backgrounded tab must not poison the window');
  for (let i = 0; i < 10; i++) m.push(10);
  assert.equal(m.count, 10);
  assert.equal(m.ema, 10);
  assert.equal(m.fps, 100);
  assert.equal(m.p95, 10);
  m.push(40);
  assert.equal(m.count, 10, 'the window is capped');
  assert.equal(m.p95, 40);
});

test('§6.3: sustained slowness and sustained health both accumulate', () => {
  const m = createFrameMonitor();
  m.push(40); m.push(40);
  assert.equal(m.slowFor, 80);
  assert.equal(m.healthyFor, 0, 'a slow frame resets the healthy run');
  m.push(8);
  assert.equal(m.slowFor, 0, 'a healthy frame resets the slow run');
  assert.equal(m.healthyFor, 8);
  m.reset();
  assert.equal(m.count, 0);
  assert.equal(m.status().fps, 0);
});

/* ── §6.3 degrade ladder ────────────────────────────────────────── */
const slow = (ladder, frames, dt = 33) => { for (let i = 0; i < frames; i++) ladder.tick(dt); };
const fast = (ladder, frames, dt = 16) => { for (let i = 0; i < frames; i++) ladder.tick(dt); };

test('GOV-2: the ladder moves ONE step at a time and then waits', () => {
  const steps = [];
  const l = createDegradeLadder({ onStep: (s) => steps.push(s) });
  slow(l, 20);
  assert.equal(l.step, 0, 'no signal yet — under the minimum sample count');
  slow(l, 10);
  assert.equal(l.step, 1, 'slow for 500 ms + enough samples → one step');
  slow(l, 4);                       /* still inside the dwell window */
  assert.equal(l.step, 1, 'a second step inside the dwell window would be a stampede');
  slow(l, 50);
  assert.equal(l.step, 2, 'one more step once the dwell passed');
  assert.deepEqual(steps, [1, 2]);
});

test('GOV-2: the ladder climbs back when the device recovers, and never oscillates', () => {
  const l = createDegradeLadder({});
  slow(l, 60);
  const climbed = l.step;
  assert.ok(climbed >= 1);
  fast(l, 20);
  assert.equal(l.step, climbed, 'health must persist before restoring');
  fast(l, 200);
  assert.equal(l.step, 0, 'it should restore fully');
  /* alternating frames must not thrash the ladder */
  const before = l.step;
  for (let i = 0; i < 120; i++) l.tick(i % 2 ? 40 : 16);
  assert.ok(Math.abs(l.step - before) <= 1, `oscillation: ${before} → ${l.step}`);
});

test('§6.3: step 4 is the floor, and the ladder can be capped', () => {
  const l = createDegradeLadder({});
  slow(l, 400);
  assert.equal(l.step, LADDER.length, 'it descends to the last rung and stops');
  assert.equal(LADDER.length, 4);
  assert.deepEqual(LADDER.map((x) => x.key), ['pace', 'shorten', 'scene', 'extractive']);

  const capped = createDegradeLadder({ maxStep: 2 });
  slow(capped, 400);
  assert.equal(capped.step, 2, 'a session with no model need not descend past the scene step');
});

test('§6.3-GATE: an idle ladder never degrades the scene, however slow the page is', () => {
  /* THE REGRESSION. Opening the panel used to arm the ladder for as long as
     the panel was open. On a device the film already struggles on, it reached
     rung 3 after ~4.5 s and called setQuality('low') — which changes the
     render path and makes three.js recompile every material's program.
     MEASURED: 21 programs relinked, 1221 ms of blocked main thread, with the
     assistant doing nothing at all (docs/RESOURCES.json). */
  const steps = [];
  const l = createDegradeLadder({ active: false, onStep: (s) => steps.push(s), maxStep: 4 });
  slow(l, 2000);                                   /* 66 s of 33 ms frames */
  assert.equal(l.step, 0, 'idle frames are not evidence about work');
  assert.deepEqual(steps, [], 'rung 3 must not fire just because the page is slow');
  assert.equal(l.status().active, false);
  assert.equal(l.monitor.count, 0, 'nothing accumulated while idle');

  /* …and the same ladder still works when it IS armed, so the gate cannot be
     what makes the ladder look healthy */
  l.setActive(true);
  slow(l, 2000);
  assert.ok(l.step >= 1, 'armed, it still degrades');
  assert.ok(steps.length >= 1);
});

test('§6.3-GATE: going idle gives the scene back exactly once', () => {
  const restored = [];
  const l = createDegradeLadder({ onRestore: (s) => restored.push(s) });
  slow(l, 400);
  assert.ok(l.step >= 1);
  l.setActive(false);
  assert.equal(l.step, 0, 'idle resets the ladder');
  assert.deepEqual(restored, [0], 'quality is handed back');
  assert.equal(l.status().effect, null);

  /* no scene was taken → no restore is reported, so the caller cannot mistake
     an idle cycle for a recovery */
  l.setActive(false);
  assert.equal(l.setActive(true).changed, true);
  l.setActive(false);
  assert.deepEqual(restored, [0], 'nothing to give back means no call');

  /* a re-arm needs its own signal: if the idle reset did not clear the
     monitor, the frames from the previous round would still satisfy the
     sample gate and the ladder would degrade on stale evidence */
  const l2 = createDegradeLadder({});
  slow(l2, 40);
  assert.ok(l2.step >= 1, 'armed: it degrades');
  l2.setActive(false);
  l2.setActive(true);
  slow(l2, 25);                                    /* below minSamples alone */
  assert.equal(l2.step, 0, 'the previous round\'s frames must not count');
  assert.equal(l2.monitor.count, 25);
  slow(l2, 10);
  assert.ok(l2.step >= 1, 'it still degrades on its own signal');
});

test('§6.3: reset returns to full quality and reports it', () => {
  const restored = [];
  const l = createDegradeLadder({ onRestore: (s) => restored.push(s) });
  slow(l, 60);
  assert.ok(l.step > 0);
  l.reset({ notify: true });
  assert.equal(l.step, 0);
  assert.equal(l.status().effect, null);
  assert.deepEqual(restored, [0]);
});

test('thresholds are exported heuristics, not magic numbers in the code', () => {
  for (const k of ['slowFrameMs', 'sustainMs', 'restoreMs', 'dwellMs', 'sampleWindow']) {
    assert.equal(typeof THRESHOLDS[k], 'number', `${k} must be tunable`);
  }
  /* the ladder honours an override — including a smaller sample gate, which a
     hardcoded minimum used to make impossible (minSamples is clamped to the
     window so the two can never contradict each other) */
  const l = createDegradeLadder({ sustainMs: 100, sampleWindow: 5, minSamples: 5, dwellMs: 1 });
  slow(l, 40);
  assert.ok(l.step >= 1, 'an overridden threshold must actually be used');

  /* and the default gate cannot exceed the window */
  const narrow = createDegradeLadder({ sampleWindow: 8, sustainMs: 100, dwellMs: 1 });
  slow(narrow, 60);
  assert.ok(narrow.step >= 1, 'a small window must still be able to trigger the ladder');
});
