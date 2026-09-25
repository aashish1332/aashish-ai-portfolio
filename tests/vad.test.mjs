/* ═══════════════════════════════════════════════════════════════
   tests/vad.test.mjs — VAD-1…VAD-11

   §11.1 Mode 2 needs a microphone that is always open and §11.2 needs STT
   to run "only on detected speech segments". `ai/voice/vad.mjs` is what
   makes those two compatible, so it is tested as a decision procedure —
   frames in, events out, with an injected clock — rather than through a
   real microphone, which no CI machine has.
   ═══════════════════════════════════════════════════════════════ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VAD_DEFAULTS, createMicVad, createVadTracker, frameRms, level }
  from '../ai/voice/vad.mjs';

const SILENCE = 0.0005;
const SPEECH = 0.08;

function runFrames(frames, opts = {}) {
  const tracker = createVadTracker({ ...VAD_DEFAULTS, ...opts });
  const events = [];
  let at = 0;
  for (const rms of frames) {
    const out = tracker.frame(rms, at);
    if (out.started) events.push({ type: 'start', at });
    if (out.ended) events.push({ type: 'end', at, durationMs: out.durationMs });
    at += opts.frameMs ?? VAD_DEFAULTS.frameMs;
  }
  return { events, tracker, at };
}

const repeat = (value, times) => Array.from({ length: times }, () => value);

test('VAD-1 RMS and level are the shape the orb and the thresholds expect', () => {
  assert.equal(frameRms([]), 0);
  assert.equal(frameRms(new Float32Array(0)), 0);
  assert.equal(frameRms(Float32Array.from([0, 0, 0])), 0);
  assert.equal(frameRms(Float32Array.from([1, -1, 1, -1])), 1);
  const half = frameRms(Float32Array.from([0.5, -0.5]));
  assert.ok(Math.abs(half - 0.5) < 1e-9);
  assert.equal(level(0), 0);
  assert.equal(level(10), 1, 'the meter is clamped, never > 1');
  assert.ok(level(0.01) > 0 && level(0.01) < 0.5);
  assert.ok(level(0.04) > level(0.01), 'louder must read louder');
});

/* Every case starts with more than `settleMs` of room tone: the floor has to
   learn the room before a segment may open, and the wrapper bootstraps
   recognition for exactly that window (see `createMicVad`). */
const SETTLE = repeat(SILENCE, Math.ceil(VAD_DEFAULTS.settleMs / VAD_DEFAULTS.frameMs) + 2);

test('VAD-2 a sustained sound opens a segment only after minSpeechMs', () => {
  const { events } = runFrames([...SETTLE, ...repeat(SPEECH, 4)]);
  assert.equal(events.length, 0, '120 ms of sound is not a question');
  const longer = runFrames([...SETTLE, ...repeat(SPEECH, 12)]);
  assert.equal(longer.events.length, 1);
  assert.equal(longer.events[0].type, 'start');
  // ...and a start needs it sustained: 300 ms of sound broken by a pause is not it.
  const broken = runFrames([...SETTLE, SPEECH, SPEECH, SPEECH, SILENCE,
    SPEECH, SPEECH, SPEECH, SILENCE]);
  assert.equal(broken.events.length, 0);
});

test('VAD-3 a click, a cough and a single loud frame are all ignored', () => {
  for (const frames of [
    [...SETTLE, 1.0, SILENCE, SILENCE, SILENCE, SILENCE],          // a click
    [...SETTLE, ...repeat(SPEECH, 3), ...repeat(SILENCE, 20)],     // 90 ms
    [...SETTLE, 0.4, ...repeat(SILENCE, 10)],                      // one spike
  ]) {
    assert.equal(runFrames(frames).events.length, 0);
  }
});

test('VAD-4 hang-over keeps a segment open across the pauses inside a sentence',
  () => {
    const frames = [
      ...SETTLE, ...repeat(SPEECH, 12),
      ...repeat(SILENCE, 10),                     // 300 ms pause: words, not an end
      ...repeat(SPEECH, 12),
      ...repeat(SILENCE, 40),
    ];
    const { events } = runFrames(frames);
    assert.deepEqual(events.map((e) => e.type), ['start', 'end']);
    assert.ok(events[1].at > (SETTLE.length + 34) * VAD_DEFAULTS.frameMs,
      'the pause must not have ended it');
  });

test('VAD-5 silence ends the segment after the hang-over, with a duration', () => {
  const { events } = runFrames([
    ...SETTLE, ...repeat(SPEECH, 20), ...repeat(SILENCE, 60),
  ]);
  assert.equal(events.length, 2);
  const [start, end] = events;
  // From the START EVENT to the end: minSpeechMs before it opened, then the
  // hang-over. Anything longer than that is a later timer having closed it.
  assert.ok(end.at - start.at >= VAD_DEFAULTS.hangoverMs);
  assert.ok(end.at - start.at <= VAD_DEFAULTS.hangoverMs + VAD_DEFAULTS.minSpeechMs
    + 4 * VAD_DEFAULTS.frameMs, 'the hang-over is what closes it — not a later timer');
  assert.ok(end.durationMs > 0);
});

test('VAD-6 the noise floor adapts to a noisy room instead of calling it speech',
  () => {
    const room = 0.02;                       // an air conditioner
    const tracker = createVadTracker();
    let at = 0;
    let starts = 0;
    for (let i = 0; i < 400; i++) {           // 12 s of steady room tone
      if (tracker.frame(room, at).started) starts += 1;
      at += VAD_DEFAULTS.frameMs;
    }
    assert.equal(starts, 0, 'steady noise must not open a segment');
    assert.ok(tracker.floor > 0.015, `the floor should have climbed: ${tracker.floor}`);
    // …and a voice over that noise is still heard, because it clears the
    // floor by a factor and not by an absolute level.
    let heard = false;
    for (let i = 0; i < 40; i++) {
      if (tracker.frame(0.12, at).started) heard = true;
      at += VAD_DEFAULTS.frameMs;
    }
    assert.equal(heard, true);
  });

test('VAD-6b a fast fall and a slow rise: a sentence does not raise its own floor',
  () => {
    const tracker = createVadTracker();
    let at = 0;
    for (let i = 0; i < 60; i++) { tracker.frame(SILENCE, at); at += VAD_DEFAULTS.frameMs; }
    const before = tracker.floor;
    let ends = 0;
    for (let i = 0; i < 200; i++) {                 // 6 s of continuous speech
      if (tracker.frame(0.09, at).ended) ends += 1;
      at += VAD_DEFAULTS.frameMs;
    }
    assert.equal(tracker.speaking || ends === 1, true);
    assert.ok(tracker.floor < 0.09 * VAD_DEFAULTS.startFactor,
      'the floor must rise more slowly than the speech that is being measured');
    assert.ok(before <= VAD_DEFAULTS.minRms + 1e-9);
  });

test('VAD-7 hysteresis: a signal at the threshold does not flap', () => {
  // Between the two thresholds, a segment must stay in whichever state it
  // is already in. Flapping here is what makes a recognizer restart 20×/s.
  const tracker = createVadTracker();
  let at = 0;
  for (const _ of SETTLE) { tracker.frame(SILENCE, at); at += VAD_DEFAULTS.frameMs; }
  for (let i = 0; i < 30; i++) { tracker.frame(SPEECH, at); at += VAD_DEFAULTS.frameMs; }
  assert.equal(tracker.speaking, true, 'a second of speech must open a segment');
  const between = tracker.floor * (VAD_DEFAULTS.stopFactor + VAD_DEFAULTS.startFactor) / 2;
  let ends = 0;
  for (let i = 0; i < 40; i++) {
    if (tracker.frame(between, at).ended) ends += 1;
    at += VAD_DEFAULTS.frameMs;
  }
  assert.equal(ends, 0, 'a signal above stopFactor must not end the segment');
});

test('VAD-8 an endless segment is cut at maxSegmentMs, and does not restart on its own',
  () => {
    const { events } = runFrames([...SETTLE, ...repeat(SPEECH, 400)],
      { maxSegmentMs: 2000 });
    assert.equal(events[0]?.type, 'start');
    assert.equal(events[1]?.type, 'end');
    assert.ok(events[1].at - events[0].at <= 2000 + VAD_DEFAULTS.minSpeechMs
      + 2 * VAD_DEFAULTS.frameMs);
    // A continuous sound must not re-open the segment the instant it is cut:
    // that would restart the recognizer every 2 s for as long as the noise lasts.
    assert.equal(events.length, 2, `expected one segment, got ${events.length / 2}`);
  });

test('VAD-9 the tracker is deterministic and resettable', () => {
  const frames = [...repeat(SILENCE, 10), ...repeat(SPEECH, 15), ...repeat(SILENCE, 40)];
  const a = runFrames(frames);
  const b = runFrames(frames);
  assert.deepEqual(a.events, b.events);
  const tracker = createVadTracker();
  tracker.frame(SPEECH, 0);
  tracker.reset();
  assert.equal(tracker.speaking, false);
  assert.equal(tracker.floor, VAD_DEFAULTS.minRms);
});

test('VAD-10 the mic wrapper reports unavailable rather than throwing', async () => {
  const vad = createMicVad({});
  assert.equal(await vad.start(), false);
  assert.equal(vad.available, false);
  assert.match(vad.reason, /microphone/);

  const noWebAudio = createMicVad({ navigator: { mediaDevices: { getUserMedia() {} } } });
  assert.equal(await noWebAudio.start(), false);
  assert.match(noWebAudio.reason, /Web Audio/);

  const denied = createMicVad({
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('denied'); } } },
    AudioContext: function AudioContext() {},
  });
  assert.equal(await denied.start(), false);
  assert.match(denied.reason, /denied/);
});

test('VAD-11 with a fake stream it emits speech events and releases the mic', async () => {
  const calls = { stopped: 0, closed: 0 };
  const samples = new Float32Array(512);
  let phase = 'silence';
  const env = {
    performance: { now: () => 0 },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => { calls.stopped += 1; } }],
        }),
      },
    },
    AudioContext: class {
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() {
        return { fftSize: 512, smoothingTimeConstant: 0,
                 getFloatTimeDomainData: (buf) => buf.set(samples) };
      }
      close() { calls.closed += 1; }
    },
  };
  const timers = [];
  const events = [];
  // An injected clock: the default `performance.now` in this fake environment
  // never advances, and a VAD whose clock stands still can never end a
  // segment — which is a real failure mode worth not hiding behind a stub.
  let clock = 0;
  const vad = createMicVad(env, {
    now: () => (clock += 10),
    trackerOpts: { minSpeechMs: 0, settleMs: 0 },
    onSpeechStart: () => events.push('start'),
    onSpeechEnd: () => events.push('end'),
  });
  assert.equal(await vad.start(), true);
  assert.equal(vad.available, true);
  assert.equal(vad.running, true);

  // Drive the loop by hand: quiet first, then loud enough to trigger.
  for (let i = 0; i < 3; i++) vad.tick();
  for (let i = 0; i < 40; i++) { samples.fill(0.2); vad.tick(); }
  assert.ok(events.includes('start'), `expected a start event, got ${events.join(',')}`);
  assert.equal(vad.speaking, true);

  samples.fill(0);
  for (let i = 0; i < 80; i++) vad.tick();
  assert.ok(events.includes('end'));
  assert.equal(vad.speaking, false);

  vad.setMuted(true);
  assert.equal(vad.muted, true);
  vad.stop();
  assert.equal(vad.running, false);
  assert.equal(calls.stopped, 1, 'the track must be stopped — that is what turns the mic light off');
  assert.equal(calls.closed, 1);
  assert.equal(vad.speaking, false);
});

test('VAD-12 the gate opens on the first loud frame, before the segment does', () => {
  // The recognizer is switched by the GATE, so it has to be up while the
  // sound is still arriving. If it waited for `minSpeechMs` the first
  // syllable of every question would be clipped — the reason the two
  // decisions are separate in the first place.
  const tracker = createVadTracker();
  const events = [];
  let at = 0;
  const feed = (rms, times) => {
    for (let i = 0; i < times; i++) {
      const out = tracker.frame(rms, at);
      if (out.gateOpened) events.push({ type: 'gate-open', at });
      if (out.gateClosed) events.push({ type: 'gate-close', at });
      if (out.started) events.push({ type: 'start', at });
      if (out.ended) events.push({ type: 'end', at });
      at += VAD_DEFAULTS.frameMs;
    }
  };
  feed(SILENCE, Math.ceil(VAD_DEFAULTS.settleMs / VAD_DEFAULTS.frameMs) + 2);
  feed(SPEECH, 12);
  assert.equal(events[0].type, 'gate-open');
  assert.equal(events[1].type, 'start');
  assert.ok(events[1].at - events[0].at >= VAD_DEFAULTS.minSpeechMs,
    'the gate must lead the segment by minSpeechMs');
  feed(SILENCE, 40);
  assert.deepEqual(events.map((e) => e.type),
    ['gate-open', 'start', 'end', 'gate-close'],
    'the segment ends first, then the gate closes — the recognizer keeps its last frames');
  assert.ok(events[3].at - events[2].at <= 2 * VAD_DEFAULTS.frameMs,
    'and the two hang-overs are the same length, so they fire within a frame');
});

test('VAD-13 the gate does not open during the settling window', () => {
  const tracker = createVadTracker();
  const opened = tracker.frame(SPEECH, 0);
  assert.equal(opened.gateOpened, false, 'a floor that has not learned the room cannot judge it');
  const quiet = createVadTracker();
  assert.equal(quiet.frame(SILENCE, 0).gateOpened, false);
});
