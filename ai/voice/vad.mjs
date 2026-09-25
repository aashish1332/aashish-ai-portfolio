/* ═══════════════════════════════════════════════════════════════
   ai/voice/vad.mjs — detecting that somebody is speaking (§11.3).

   §11.1 Mode 2 asks for a microphone that is *always* open, and §11.2 asks
   that STT run "only on detected speech segments (never continuously)".
   Those two are only compatible with a voice-activity detector, and this is
   it: an energy detector over ~30 ms frames, with an adaptive noise floor.

   Why not Silero (§11.3's suggestion)? Two honest reasons:

   * Silero's browser wrapper pulls in ONNX Runtime Web — a second wasm
     runtime plus ~1 MB of model — and §6.4 caps the resident runtimes at
     two. On this laptop (R1: 2 cores, a busy integrated GPU) that is a real
     cost paid to answer a question the browser's own recognizer already
     answers.
   * An energy VAD is *testable* with no model and no microphone: the whole
     decision is a pure function of a frame's RMS and the clock, which is
     what `tests/vad.test.mjs` pins. Swapping in Silero later means
     replacing `createMicVad`'s `readSamples` and keeping the tracker.

   The noise floor is an exponential moving average that only updates while
   *not* in speech, so a noisy room raises the floor instead of being
   permanently "speech"; `startFactor`/`stopFactor` hysteresis stops a
   signal hovering at the threshold from flapping.

   What this deliberately does NOT do: decide what the words mean. It
   reports speech start and end. Whether an utterance is addressed to the
   assistant is still decided by the wake phrase and the turn window —
   a microphone that answers the room is the failure mode both of those
   exist to prevent.
   ═══════════════════════════════════════════════════════════════ */

export const VAD_DEFAULTS = Object.freeze({
  /* ~30 ms: §11.3's frame, and short enough that onset is detected within a
     syllable while long enough that the timer is negligible (33 ticks/s). */
  frameMs: 30,
  /* A cough is not a question. Sustained energy for this long is. */
  minSpeechMs: 300,
  /* ~600–800 ms of hang-over (§11.1): the pause between words must not end
     the segment. Below the floor, recognition stops and the CPU is idle. */
  hangoverMs: 700,
  /* A segment that never ends (a fan, music, somebody on a call) is cut. */
  maxSegmentMs: 20000,
  /* How long the floor takes to learn the room before a segment may open.
     1.5 s of the *steady* signal, which is why the wrapper bootstraps
     recognition at enable: nothing said inside this window is lost, it is
     simply not the VAD's decision yet. */
  settleMs: 1500,
  /* The noise floor is an asymmetric EMA: it follows a *drop* quickly (a
     pause between words returns it to the room) and a *rise* slowly — a
     600 ms time constant to fall, ~3 s to climb, so a sentence cannot raise
     the floor it is being measured against while a steady room tone still
     becomes the floor within a few seconds. Both are `tests/vad.test.mjs`. */
  floorDownAlpha: 0.3,
  floorUpAlpha: 0.01,
  startFactor: 2.2,
  stopFactor: 1.4,
  /* Absolute floor so a perfectly silent room (floor ≈ 0) still needs real
     sound rather than a rounding error to open a segment. */
  minRms: 0.005,
  floorCeiling: 0.25,
});

/** Root-mean-square of one frame. Accepts a Float32Array of samples in
 *  [-1, 1] or any array-like of numbers. */
export function frameRms(frame) {
  const n = frame?.length || 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / n);
}

/** A 0–1 "how loud is this" number for the voice orb (§11.5). Compresses
 *  the useful range so quiet speech moves the meter. */
export function level(rms) {
  return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, rms)) * 3));
}

/**
 * The decision, as a pure state machine — no DOM, no clock of its own, so
 * every branch is reachable from a test with an array of frames.
 *
 * @param {object} [opts] overrides for `VAD_DEFAULTS`
 */
export function createVadTracker(opts = {}) {
  const cfg = { ...VAD_DEFAULTS, ...opts };
  let floor = cfg.minRms;
  let inSpeech = false;
  let speechSince = null;
  let lastLoud = null;
  let startedAt = null;          /* when the tracker began hearing anything */
  let quietSince = null;         /* used by the post-max-cut cooldown */
  /* The *gate* is a second, faster decision than `speaking`, and it is the
     one the recognizer is switched on by. Waiting for `minSpeechMs` before
     opening the gate would clip the first syllable of every question — the
     recognizer has to be running while the sound is still arriving. So the
     gate opens on the first frame that clears `startAt` and closes a
     hang-over after the last one above `stopAt`. `speaking` stays the
     slower, deliberate signal the orb and the turn logic use. */
  let gateOpen = false;
  let gateQuietSince = null;

  function reset() {
    floor = cfg.minRms;
    inSpeech = false;
    speechSince = null;
    lastLoud = null;
    startedAt = null;
    quietSince = null;
    gateOpen = false;
  }

  /**
   * @param {number} rms     this frame's energy
   * @param {number} atMs    monotonic clock, injected
   * @returns {{speaking:boolean, started:boolean, ended:boolean,
   *            durationMs:number|null, rms:number, floor:number, level:number}}
   */
  function frame(rms, atMs) {
    const value = Number.isFinite(rms) ? Math.max(0, rms) : 0;
    if (startedAt === null) startedAt = atMs;
    const settled = atMs - startedAt >= cfg.settleMs;
    const startAt = Math.max(cfg.minRms * 2.2, floor * cfg.startFactor);
    const stopAt = Math.max(cfg.minRms * 1.2, floor * cfg.stopFactor);
    let started = false;
    let ended = false;
    let durationMs = null;
    let cutForLength = false;

    if (!inSpeech) {
      /* The cooldown after a max-length cut: a continuous sound (music, a fan,
         somebody on a call) must not re-open a segment the instant it is cut,
         or the recognizer restarts every `maxSegmentMs` forever. Quiet for a
         hang-over is what clears it. */
      if (quietSince !== null) {
        if (value <= stopAt) {
          if (atMs - quietSince >= cfg.hangoverMs) quietSince = null;
        } else {
          quietSince = atMs;
        }
      }
      const loudEnough = settled && quietSince === null && value > startAt;
      if (loudEnough) {
        if (speechSince === null) speechSince = atMs;
        if (atMs - speechSince >= cfg.minSpeechMs) {
          inSpeech = true;
          started = true;
          lastLoud = atMs;
        }
      } else {
        /* One quiet frame resets the onset: `minSpeechMs` means *sustained*,
           not "300 ms of a count that keeps running through the pauses". */
        speechSince = null;
      }
    } else {
      if (value > stopAt) lastLoud = atMs;
      const quietFor = atMs - (lastLoud ?? atMs);
      cutForLength = atMs - (speechSince ?? atMs) > cfg.maxSegmentMs;
      if (quietFor >= cfg.hangoverMs || cutForLength) {
        inSpeech = false;
        ended = true;
        durationMs = atMs - (speechSince ?? atMs);
        speechSince = null;
        lastLoud = null;
        if (cutForLength) quietSince = atMs;
      }
    }

    /* The gate, on the same frame, before the floor moves. */
    let gateOpened = false;
    let gateClosed = false;
    if (!gateOpen) {
      if (settled && value > startAt) { gateOpen = true; gateOpened = true; }
    } else if (value > stopAt) {
      gateQuietSince = null;
    } else {
      if (gateQuietSince === null) gateQuietSince = atMs;
      if (atMs - gateQuietSince >= cfg.hangoverMs) {
        gateOpen = false;
        gateClosed = true;
        gateQuietSince = null;
      }
    }

    /* The floor learns from every frame, including speech — that is what the
       asymmetry is for: a slow rise cannot chase a sentence, and the fast
       fall re-learns the room in the first pause. */
    const alpha = value < floor ? cfg.floorDownAlpha : cfg.floorUpAlpha;
    floor = Math.max(cfg.minRms,
      Math.min(cfg.floorCeiling, floor + alpha * (value - floor)));

    return {
      speaking: inSpeech, started, ended, durationMs,
      rms: value, floor, level: level(value), settled, cutForLength,
      gateOpen, gateOpened, gateClosed,
    };
  }

  return {
    frame, reset,
    get speaking() { return inSpeech; },
    get gateOpen() { return gateOpen; },
    get floor() { return floor; },
    get settled() { return startedAt !== null; },
    config: cfg,
  };
}

/**
 * The microphone half: a live level, and speech-start/end events that gate
 * recognition. Everything it touches is injected, so the tests drive it
 * with a fake AudioContext and no permission prompt.
 *
 * @param {object} env
 * @param {{onSpeechStart?:Function, onSpeechEnd?:Function, onFrame?:Function,
 *          onError?:Function, trackerOpts?:object, readSamples?:Function,
 *          constraints?:object}} [opts]
 */
export function createMicVad(env = {}, opts = {}) {
  /* A sentinel for "the loop is live but has not been given a timer id yet".
     `0`/`null` cannot do this job: `setTimeout` may legitimately return 0. */
  const RUNNING = Symbol('vad-running');
  const tracker = createVadTracker(opts.trackerOpts);
  const now = opts.now || (() => (env.performance?.now?.() ?? Date.now()));
  const frameMs = tracker.config.frameMs;
  let stream = null;
  let context = null;
  let analyser = null;
  let buffer = null;
  let timer = null;
  let muted = false;         /* recognition running: do not double-report */
  let lastLevelValue = 0;
  let reason = null;
  let available = null;      /* tri-state: unknown until start() */

  function supported() {
    const md = env.navigator?.mediaDevices;
    const Ctor = env.AudioContext || env.webkitAudioContext;
    if (!md?.getUserMedia) return 'This browser cannot open a microphone.';
    if (!Ctor) return 'This browser has no Web Audio, so speech cannot be detected.';
    return null;
  }

  /** One frame of samples, from the analyser or from a test. */
  function readSamples() {
    if (opts.readSamples) return opts.readSamples();
    if (!analyser || !buffer) return null;
    analyser.getFloatTimeDomainData(buffer);
    return buffer;
  }

  function tick() {
    const samples = readSamples();
    if (!samples) return null;
    const at = now();
    const out = tracker.frame(frameRms(samples), at);
    lastLevelValue = out.level;
    opts.onFrame?.(out);
    if (out.started) opts.onSpeechStart?.(out);
    if (out.ended) opts.onSpeechEnd?.({ ...out, reason: 'silence' });
    /* The gate is what switches the recognizer; `started`/`ended` describe
       the segment itself. Both are reported — they answer different
       questions, and conflating them clipped syllables (see the tracker). */
    if (out.gateOpened) opts.onGateOpen?.(out);
    if (out.gateClosed) opts.onGateClose?.(out);
    return out;
  }

  async function start() {
    if (timer) return true;
    const problem = supported();
    if (problem) { available = false; reason = problem; opts.onError?.(problem); return false; }
    try {
      const constraints = opts.constraints || {
        audio: {
          /* §11.1's barge-in requirements: without these the assistant
             hears itself through the speakers and interrupts its own
             answer. */
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
      };
      stream = await env.navigator.mediaDevices.getUserMedia(constraints);
      const Ctor = env.AudioContext || env.webkitAudioContext;
      context = new Ctor();
      const source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      buffer = new Float32Array(analyser.fftSize);
      available = true;
      reason = null;
      /* `timer` is the loop's own "still wanted" flag, so it has to be set
         BEFORE the first tick — a guard that checks it first would return on
         the very first call and the loop would never run at all (which is
         exactly what the mock-clock test caught). */
      timer = RUNNING;
      const loop = () => {
        if (timer === null) return;
        try { tick(); } catch (error) { opts.onError?.(String(error?.message || error)); }
        if (timer === null) return;
        timer = env.setTimeout?.(loop, frameMs) ?? null;
      };
      loop();
      return true;
    } catch (error) {
      available = false;
      reason = String(error?.message || error);
      opts.onError?.(reason);
      return false;
    }
  }

  function stop() {
    if (timer && timer !== RUNNING) env.clearTimeout?.(timer);
    timer = null;
    /* §6.4: the tracks are stopped and the context closed, because that is
       the only thing that turns the browser's recording indicator off. */
    try { stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* gone */ }
    try { context?.close?.(); } catch { /* already closed */ }
    stream = null;
    context = null;
    analyser = null;
    buffer = null;
    tracker.reset();
    return true;
  }

  return {
    start,
    stop,
    /** The recognizer owns the mic while it is transcribing; the VAD keeps
     *  measuring (the orb still moves) but stops emitting segment events. */
    setMuted(on) { muted = !!on; return muted; },
    get muted() { return muted; },
    get available() { return available; },
    get reason() { return reason; },
    get speaking() { return tracker.speaking; },
    get gateOpen() { return tracker.gateOpen; },
    get lastLevel() { return lastLevelValue; },
    get analyser() { return analyser ? { fftSize: analyser.fftSize } : null; },
    get floor() { return tracker.floor; },
    get running() { return timer !== null; },
    level: () => lastLevelValue,
    floorLevel: () => level(tracker.floor),
    current: () => readSamples(),
    tick,
  };
}
