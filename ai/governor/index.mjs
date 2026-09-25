/* ═══════════════════════════════════════════════════════════════
   ai/governor/index.mjs — §6 device tiers, capability probing,
   the live frame-health monitor and the degrade ladder (§6.3)

   One module, used by chat and (later) voice. Two rules shape it:

     1. Feature-detect, never UA-sniff (§6.1). Everything is asked of the
        environment, and every answer is optional — a missing API is a fact,
        not an error.
     2. The tier is a STARTING point. The session may move down at runtime
        and never silently up (§6.2).

   No globals are read: `env` is injected, so `tests/governor.test.mjs` can
   drive the whole thing with a fake navigator and a fake clock. The browser
   is one caller among many.

   THRESHOLDS ARE UNMEASURED HEURISTICS. §6.2 calls the table "starting
   heuristics — validate and adjust", so they live here in one exported
   object to be tuned against real hardware, and they are labelled as such
   everywhere they are read.
   ═══════════════════════════════════════════════════════════════ */

/** §6.2 tiers. `context`/`maxNew` are the text-chat budgets for P5+. */
export const TIERS = [
  { id: 0, name: 'T0', llm: false, context: 0, maxNew: 0, voice: 'none', label: 'Quick answers', note: 'no model, no download' },
  { id: 1, name: 'T1', llm: true, context: 512, maxNew: 96, voice: 'tap', label: 'Lite', note: 'phones, iOS, low benchmark' },
  { id: 2, name: 'T2', llm: true, context: 768, maxNew: 160, voice: 'both', label: 'Standard', note: 'normal laptops, mid phones' },
  { id: 3, name: 'T3', llm: true, context: 1024, maxNew: 256, voice: 'all', label: 'High', note: 'modern desktop, many cores' },
];

/** §6.2 starting heuristics — tune with measurements, never silently. */
export const THRESHOLDS = {
  /* worker micro-benchmark: ms for the matmul loop (§6.1). Slower than this
     and the device is treated as lite regardless of its core count. */
  benchFastMs: 5,
  benchSlowMs: 14,
  /* a device needs this much headroom before a download is worth offering */
  minStorageBytes: 80 * 1024 * 1024,
  /* §6.3 frame health */
  slowFrameMs: 24,          /* "slow" frame */
  sustainMs: 500,           /* slow must persist this long before degrading */
  restoreMs: 2500,          /* fast must persist this long before restoring */
  dwellMs: 1500,            /* minimum gap between ladder moves */
  sampleWindow: 90,
  /* frames needed before the ladder trusts its own signal. Kept in the
     threshold set (and clamped to the window) because a hardcoded 30 made
     every other knob a lie: with a smaller window the ladder could never
     fire at all. */
  minSamples: 30,
};

export const tierInfo = (id) => TIERS[Math.max(0, Math.min(TIERS.length - 1, id | 0))];

/**
 * §6.1 capability probe. Synchronous, side-effect free, never throws.
 *
 * @param {object} [env]  globalThis-shaped: navigator, matchMedia, Worker, WebAssembly…
 * @param {object} [opts]
 * @param {number|null} [opts.benchmarkMs] measured worker micro-benchmark
 * @param {boolean|null} [opts.wasmSimd]   result of validating a tiny SIMD module
 * @param {number|null} [opts.storageBytes] from navigator.storage.estimate()
 */
export function probeCapabilities(env = globalThis, opts = {}) {
  const nav = env.navigator || {};
  const has = (v) => typeof v !== 'undefined' && v !== null;
  const media = (q) => {
    try { return has(env.matchMedia) ? !!env.matchMedia(q).matches : false; } catch { return false; }
  };

  const conn = nav.connection || nav.mozConnection || nav.webkitConnection || {};
  const threads = Number(nav.hardwareConcurrency) || 0;
  const memory = Number(nav.deviceMemory) || 0;   /* Chromium-only, coarse */

  return {
    worker: has(env.Worker) && has(env.Blob) && has(env.URL) && has(env.URL.createObjectURL),
    wasm: has(env.WebAssembly) && typeof env.WebAssembly.instantiate === 'function',
    wasmSimd: opts.wasmSimd === undefined ? null : opts.wasmSimd,
    crossOriginIsolated: !!env.crossOriginIsolated,
    threads,
    /* 0 means "not reported" (Safari, Firefox) — not "no memory" */
    memory,
    memoryReported: memory > 0,
    saveData: !!conn.saveData,
    effectiveType: conn.effectiveType || null,
    storageBytes: opts.storageBytes === undefined ? null : opts.storageBytes,
    coarsePointer: media('(pointer: coarse)'),
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    webgpu: null,               /* filled by probeWebGPU() — it is async */
    benchmarkMs: opts.benchmarkMs === undefined ? null : opts.benchmarkMs,
  };
}

/* ── §6.1 the SIMD check ─────────────────────────────────────────
   SIMD is a hard requirement for the runtime, so it is validated by
   compiling a real module rather than by testing a string capability.

   The first version of this byte array was malformed (a v128.const with
   five immediates instead of sixteen), so `validate` returned false on
   every engine and the governor forced EVERY device to T0 — the model could
   never have run anywhere. It is exported so `tests/governor.test.mjs` can
   validate it against the same V8 the browser ships, which makes that class
   of bug impossible to reintroduce silently. Module: () -> v128, body =
   i32.const 0; i32x4.splat; end. */
export const SIMD_PROBE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,   /* magic + version      */
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,          /* type () -> v128      */
  0x03, 0x02, 0x01, 0x00,                            /* function 0           */
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x00, 0xfd, 0x11, 0x0b,   /* code       */
]);

/**
 * Compile the SIMD probe. Returns false on any failure — an engine without
 * SIMD, a CSP that forbids wasm, or a stub in a test.
 * @param {object} wasm  a WebAssembly-shaped object
 */
export function hasSimd(wasm = WebAssembly) {
  try { return !!new wasm.Module(SIMD_PROBE_BYTES); } catch { return false; }
}

/** §6.1 WebGPU needs an async adapter request; call it after the click. */
export async function probeWebGPU(env = globalThis) {
  try {
    if (!env.navigator?.gpu?.requestAdapter) return false;
    const adapter = await env.navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

/**
 * §6.2 choose the starting tier from a probe.
 * @returns {number} 0..3
 */
export function chooseTier(caps, opts = {}) {
  const t = { ...THRESHOLDS, ...opts };
  if (!caps) return 0;

  /* hard blockers → T0: this device may not run a model at all (§6.2) */
  if (!caps.worker || !caps.wasm) return 0;
  if (caps.wasmSimd === false) return 0;                    /* SIMD is required, not optional */
  if (caps.storageBytes !== null && caps.storageBytes < t.minStorageBytes) return 0;
  if (caps.saveData) return 0;                              /* the visitor asked us not to */

  const slowNetwork = caps.effectiveType === 'slow-2g' || caps.effectiveType === '2g'
    || caps.effectiveType === '3g';
  const thinDevice = caps.coarsePointer || caps.threads === 0 || caps.threads <= 2
    || (caps.memoryReported && caps.memory <= 2);
  const slowBench = caps.benchmarkMs !== null && caps.benchmarkMs > t.benchSlowMs;

  if (slowNetwork || thinDevice || slowBench) return 1;

  const fastDevice = !caps.coarsePointer && caps.threads >= 8
    && caps.memoryReported && caps.memory >= 8
    && caps.benchmarkMs !== null && caps.benchmarkMs <= t.benchFastMs;
  return fastDevice ? 3 : 2;
}

/**
 * §6.3 frame-health monitor. Fed by the EXISTING ticker — the governor never
 * starts a rAF loop of its own (§12). Pure: push deltas in ms.
 */
export function createFrameMonitor(opts = {}) {
  const t = { ...THRESHOLDS, ...opts };
  const win = t.sampleWindow;
  const samples = [];
  let sum = 0;
  let over = 0;       /* consecutive ms of slow frames */
  let under = 0;      /* consecutive ms of healthy frames */

  const percentile = (p) => {
    if (!samples.length) return 0;
    const s = [...samples].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };

  return {
    /** @param {number} dtMs frame delta from the ticker */
    push(dtMs) {
      const dt = Number(dtMs);
      if (!(dt > 0) || dt > 1000) return;          /* ignore a paused/backgrounded tab */
      samples.push(dt);
      sum += dt;
      if (samples.length > win) sum -= samples.shift();

      if (dt > t.slowFrameMs) { over += dt; under = 0; } else { under += dt; over = 0; }
    },
    reset() { samples.length = 0; sum = 0; over = 0; under = 0; },
    get ema() { return samples.length ? sum / samples.length : 0; },
    get fps() { const a = this.ema; return a ? 1000 / a : 0; },
    get p95() { return percentile(0.95); },
    get slowFor() { return over; },
    get healthyFor() { return under; },
    get count() { return samples.length; },
    status() {
      return {
        fps: Math.round(this.fps),
        ema: +this.ema.toFixed(1),
        p95: +this.p95.toFixed(1),
        samples: samples.length,
        slowForMs: Math.round(over),
        healthyForMs: Math.round(under),
      };
    },
  };
}

/**
 * §6.3 degrade ladder. One step at a time, with hysteresis, and it climbs
 * back when the device is healthy again. `onStep(step)`/`onRestore(step)` are
 * how the caller acts — the governor itself never touches the scene.
 *
 *   1 pace generation (needs a model; a no-op until P5)
 *   2 lower max_new_tokens / context
 *   3 ask the scene for temporary low quality / pause  (§12)
 *   4 stop generating answers for the rest of the session, and say so
 *
 * Step 4 was §6.3's "extractive Quick Answers", which meant answering built
 * sentences from `knowledge.json` instead of generating. Those are retired as
 * answers (see `ai/answers/model.mjs`), so the rung does the same job the only
 * honest way left: it stops the generation that the frames cannot afford, and
 * the panel says plainly why. The load reduction is what the rung was for; the
 * wording of the fallback was the part that changed.
 */
export const LADDER = [
  { step: 1, key: 'pace', label: 'Pace generation' },
  { step: 2, key: 'shorten', label: 'Shorten the answer budget' },
  { step: 3, key: 'scene', label: 'Temporarily lower scene quality' },
  { step: 4, key: 'stop', label: 'Stop generating answers' },
];

export function createDegradeLadder(opts = {}) {
  const t = { ...THRESHOLDS, ...opts };
  const monitor = opts.monitor || createFrameMonitor(opts);
  const onStep = opts.onStep || (() => {});
  const onRestore = opts.onRestore || (() => {});
  const minSamples = Math.min(t.minSamples, t.sampleWindow);
  let step = 0;
  let lastMoveAt = -Infinity;
  let now = 0;
  let active = opts.active !== false;

  return {
    monitor,
    get step() { return step; },
    get active() { return active; },
    /**
     * §6.3 — arm the ladder around the assistant's OWN work, not around the
     * panel being open.
     *
     * Every rung exists to make room for work the assistant is doing (pace it,
     * shorten it, lower the scene, fall back to extractive). Idle, there is
     * nothing to make room for, and rung 3 is not free: it changes the render
     * path, which makes three.js recompile every material's program —
     * MEASURED at 21 programs and a 1221 ms main-thread block on the toolchain
     * that produced docs/RESOURCES.json, i.e. the ladder's "help" cost the
     * page more than any frame it saved. So the caller arms it while an answer
     * is being produced — not while a microphone merely listens, because no
     * rung makes recognition faster and every one of them holds the film
     * down (see ai/voice/index.mjs),
     * and going idle gives the scene back.
     */
    setActive(on) {
      const next = !!on;
      if (next === active) return { changed: false, restored: false };
      active = next;
      if (active) return { changed: true, restored: false };
      /* Idle: drop the accumulated signal (idle frames are not evidence about
         work) and hand the scene back if the ladder had taken it. */
      const restored = step > 0;
      step = 0;
      now = 0;
      lastMoveAt = -Infinity;
      monitor.reset();
      if (restored) onRestore(0, LADDER[0]);
      return { changed: true, restored };
    },
    /** drive the clock from the same ticker that feeds the monitor */
    tick(dtMs) {
      if (!active) return step;      /* nothing running, nothing to protect */
      monitor.push(dtMs);
      now += dtMs || 0;
      if (monitor.count < minSamples) return step;           /* not enough signal yet */
      if (now - lastMoveAt < t.dwellMs) return step;        /* let the last move settle */

      const maxStep = opts.maxStep === undefined ? LADDER.length : opts.maxStep;
      if (monitor.slowFor >= t.sustainMs && step < maxStep) {
        step++;
        lastMoveAt = now;
        onStep(step, LADDER[step - 1]);
        return step;
      }
      if (monitor.healthyFor >= t.restoreMs && step > 0) {
        step--;
        lastMoveAt = now;
        onRestore(step, LADDER[step]);
        return step;
      }
      return step;
    },
    /** §6.2: the ladder only ever moves down on its own; this is the explicit
        reset after the AI goes idle */
    reset({ notify = false } = {}) {
      if (!step) return;
      step = 0;
      monitor.reset();
      if (notify) onRestore(0, LADDER[0]);
    },
    status() {
      return { active, step, effect: step ? LADDER[step - 1].key : null, ...monitor.status() };
    },
  };
}
