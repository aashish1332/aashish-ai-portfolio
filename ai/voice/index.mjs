/* ═══════════════════════════════════════════════════════════════
   ai/voice/index.mjs — the §11 voice layer: heard, and heard out loud

   Two halves, and the honest split between them matters:

     · INPUT  uses the browser's own speech recognition
       (`SpeechRecognition` / `webkitSpeechRecognition`). That is not a
       neutrality choice — as browsers ship it, that engine is *server-side*:
       while it listens, audio leaves the device. So nothing here touches the
       microphone until the visitor presses the button, and when they do, the
       panel says so in as many words (`SPEECH_DISCLOSURE`). The typed chat
       still keeps its old promise, because typing never involved an engine
       at all.

       §19 turned up the one way that can be improved without giving up the
       browser's recognizer: an experimental on-device mode. When the platform
       says its language pack is installed, the session asks for it, the
       disclosure becomes `SPEECH_DISCLOSURE_ON_DEVICE`, and if the engine
       still refuses, the server-side engine is the fallback rather than a
       dead microphone. Neither sentence is ever shown on a guess.
     · OUTPUT uses `speechSynthesis`, which is local and free. The voice is
       picked from the answer's own language (`voiceHint`) — a Hindi answer
       must not be read by an English voice.

   Everything is injected (`env`, `chat`), so `node --test` drives the whole
   thing with a fake recognizer and asserts the behaviour that is expensive to
   discover in a browser: that the page moves without being narrated, that a
   miss stays silent, and that nothing listens before the tap.

   §6.2 already declares what each tier may do (`TIERS[].voice`), and this
   module is what finally reads that declaration:

     T0 `none` — typed only. Also the tier a `saveData` visitor lands on, so
                 "voice off" there is the answer they asked for.
     T1 `tap`  — push-to-talk. No always-on listening and no audio played at
                 somebody on a phone.
     T2 `both` — push-to-talk + answers read aloud + **Proactive**, exactly
                 as §6.2 licenses it: "Tap & Speak + Proactive (VAD-gated)".
                 The microphone stays open and `ai/voice/vad.mjs` decides when
                 speech is actually present, so recognition runs on segments
                 instead of continuously (§11.2). This is the mode a recruiter
                 on a laptop wants: ask, hear the answer, ask again.
     T3 `all`  — the same, on a device with headroom to spare.

   In continuous mode a turn is opened by the wake phrase and then has to be
   KEPT open (`VOICE_TIMING.followUpMs`): one question buys the next one
   briefly, and then the wake phrase is required again. That rule predates
   the VAD and survives it — an open microphone is not an assistant that
   answers the room.
   ═══════════════════════════════════════════════════════════════ */
import { tierInfo } from '../governor/index.mjs';
import { voiceHint } from '../language/detect.mjs';
import { isPhantom } from './phantoms.mjs';
import { createMicVad } from './vad.mjs';
/* The pre-tap capability answers live in `caps.mjs` so the chat shell can ask
   "would voice work here?" without loading any of what follows (§2 N6). They
   are imported for this module's own use AND re-exported, so every existing
   importer of `ai/voice/index.mjs` keeps working unchanged. */
import {
  VOICE_POLICY, voicePolicy, NO_ENGINE, speechRecognitionCtor,
  recognizeSupported, voiceSummary,
} from './caps.mjs';

export {
  VOICE_POLICY, voicePolicy, NO_ENGINE, speechRecognitionCtor,
  recognizeSupported, voiceSummary,
} from './caps.mjs';

/* ── timing ──────────────────────────────────────────────────────
   A continuous-mode turn is opened by the wake phrase and then has to be
   KEPT open. Without a window, one "hey Aashish" would leave the assistant
   answering everything for the rest of the call — including the half of the
   conversation that is with somebody else in the room.

   The window is short on purpose: anything said inside it is treated as a
   follow-up, so its length is the pause between two questions to the same
   person ("…and your projects?"), NOT the pause before a different
   conversation. An answer that made no claim closes the turn immediately. */
export const VOICE_TIMING = {
  followUpMs: 12000,
  /* How long a PRESS keeps the microphone open (T1/T2). "Tap" has to mean
     something: without this, one press left the engine restarting itself for
     as long as the panel stayed open, and every utterance in the room was
     treated as a question — a hotter microphone than continuous mode, which
     at least makes you say the name. The window is the press's responsibility
     to be over. */
  tapWindowMs: 20000,
};

/* ── the disclosure ────────────────────────────────────────────── */

/**
 * Said once, when the visitor turns voice on, instead of being buried.
 *
 * This is the text for the engine as browsers ship it — server-side — and it
 * stays the default, because it is the one that claims the LEAST privacy. The
 * panel only says the better version below when the platform has said, on the
 * record, that it can keep recognition on the device (§19).
 */
export const SPEECH_DISCLOSURE =
  'Voice mode uses your browser\'s speech recognition, which sends what you '
  + 'say to your browser\'s speech service — so while it listens, your audio '
  + 'leaves this device. Typed questions never do. Turn voice off any time.';

/** The same sentence, for a session the platform confirmed stays on-device. */
export const SPEECH_DISCLOSURE_ON_DEVICE =
  'Voice mode uses your browser\'s speech recognition, run on this device — '
  + 'what you say is not sent anywhere, and no audio leaves this device. '
  + 'Typed questions never leave it either. Turn voice off any time.';

/* How long the platform is given to say whether it can recognise speech
   on-device before the microphone opens anyway. A few milliseconds is a
   normal answer; this cap is only here so an engine that never answers
   cannot leave the visitor pressing a button that does nothing. */
export const ON_DEVICE_PROBE_MS = 1500;

/* ── the wake phrase ───────────────────────────────────────────── */

/** What opens a turn in continuous mode. The bare name is allowed at the
 *  front, because "Aashish, tell me about your projects" is how a person
 *  actually addresses someone. */
export const WAKE_PHRASES = ['ask aashish', 'hey aashish', 'ok aashish', 'aashish'];

/**
 * Split off the leading wake phrase, keeping the rest of the sentence.
 *
 * Matching is done on a punctuation-stripped, lower-cased copy, and each
 * normalized word remembers which original token produced it — so the
 * question that comes back is the visitor's own words, spelled as they said
 * them, not a re-joined approximation.
 */
export function stripWake(text, phrases = WAKE_PHRASES) {
  const raw = String(text || '').trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const words = [];
  const from = [];                    /* normalized word → original token index */
  tokens.forEach((tok, i) => {
    const parts = tok.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
    for (const p of parts) { words.push(p); from.push(i); }
  });

  const best = [...phrases]
    .map((p) => ({ p, n: p.split(/\s+/).filter(Boolean).length }))
    .filter(({ p, n }) => n > 0 && words.slice(0, n).join(' ') === p.split(/\s+/).join(' '))
    .sort((a, b) => b.n - a.n)[0];

  if (!best) return { wake: false, question: raw };

  const rest = from[best.n] === undefined ? [] : tokens.slice(from[best.n]);
  return {
    wake: true,
    /* Only the separator the wake phrase left behind is removed — a trailing
       "?" is the visitor's punctuation and stays, because this is meant to be
       their sentence, not a cleaned-up version of it. */
    question: rest.join(' ').replace(/^[\s,.;:!?—–-]+/, '').trim(),
  };
}

/* ── input: the recognizer ─────────────────────────────────────── */

/* Errors that mean "do not ask again". Re-starting after one of these would
   demand a permission the visitor just refused, once per session end — the
   shape of bug that ends with a browser permission prompt on a loop. */
const FATAL_ENGINE_ERRORS = new Set([
  'not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported',
]);

/**
 * A restarting wrapper over the browser's recognizer.
 *
 * Chrome's engine ends its session after each utterance, so continuous
 * listening is a re-`start()` loop — and a naive loop can also spin when the
 * engine dies instantly (`onend` before a single result). The thrash guard
 * stops after `THRASH_LIMIT` fast restarts and reports it, rather than
 * hammering the service.
 */
export const THRASH_LIMIT = 6;
const THRASH_WINDOW_MS = 120;

/**
 * Ask the platform whether it can recognise speech without a server (§19).
 *
 * The shipping `SpeechRecognition` is server-side, and the on-device mode is
 * experimental: `available({ processLocally: true, langs })` answers
 * `'available' | 'downloadable' | 'downloading' | 'unavailable'`. Only
 * `'available'` means the language pack is on this device now — asking for
 * on-device recognition whose pack is missing fails the session, which is a
 * worse outcome than a disclosed one.
 *
 * Returns a **promise only when there is an API to ask**, and `false` when
 * there is not, because "cannot be asked" is information a caller must not
 * have to wait for: a browser without this API opens the microphone on the
 * same tick, exactly as it did before this existed. `null` — an engine that
 * errors, or answers with a word we do not know — counts as no.
 */
export function probeOnDevice(env, lang) {
  const Ctor = speechRecognitionCtor(env);
  if (!Ctor || typeof Ctor.available !== 'function') return false;
  try {
    return Promise.resolve(Ctor.available({ processLocally: true, langs: [lang] }))
      .then((answer) => answer === 'available')
      .catch(() => false);
  } catch { return false; }
}

export function createRecognizer(env, opts = {}) {
  const Ctor = speechRecognitionCtor(env);
  const supported = !!Ctor;
  const now = opts.clock || (() => Date.now());
  const lag = (fn, ms) => (env?.setTimeout ? env.setTimeout(fn, ms) : fn());

  let rec = null;                     /* built on start(), never on import */
  let started = 0;                    /* constructions, for the probe/tests */
  let listening = false;
  let wanted = false;
  let thrash = 0;
  let lang = opts.lang || 'en-US';
  let reason = supported ? null : NO_ENGINE;
/* §19: whether the platform can keep recognition ON the device. `null` is
   "not asked", which is deliberately not the same as "no": the panel reads
   this to choose its disclosure, and a claim of privacy has to wait for the
   answer rather than assume it. */
let onDevice = null;
let asked = false;
/* Whether the microphone's mode has been decided — by the platform's answer,
   or by the cap in start() when no answer came. A late answer must not be
   able to re-decide it: the engine is already running the other way, and a
   disclosure that describes the wrong session is worse than a cautious one. */
let settled = false;
/* Whether on-device recognition has already been tried and abandoned, so a
   platform that rejects it cannot be asked for it twice in one session. */
let triedOnDevice = false;

  /** Ask once. Returns a promise when the answer can take time, else null. */
  function ask() {
    asked = true;
    const answer = (opts.probeOnDevice || ((l) => probeOnDevice(env, l)))(lang);
    if (!answer || typeof answer.then !== 'function') { onDevice = answer === true; return null; }
    return Promise.resolve(answer).then(
      (v) => { if (settled) return; settled = true; onDevice = v === true; opts.onState?.(); },
      () => { if (settled) return; settled = true; onDevice = false; opts.onState?.(); },
    );
  }

  function giveUp(why) {
    wanted = false;
    /* abort() is not guaranteed to fire `onend`, so "I am no longer
       listening" has to be said here rather than waited for. */
    listening = false;
    reason = why;
    opts.onError?.(why, null);
    opts.onState?.();
  }

  function restart() {
    const gap = now() - lastEnd;
    thrash = gap < THRASH_WINDOW_MS ? thrash + 1 : 0;
    lastEnd = now();
    if (thrash >= THRASH_LIMIT) {
      giveUp('The microphone kept stopping, so it is off now. Typing works.');
      return;
    }
    lag(() => { if (wanted) start(); }, THRASH_WINDOW_MS);
  }

  let lastEnd = 0;

  function handleResult(ev) {
    const results = ev?.results;
    if (!results) return;
    for (let i = ev.resultIndex || 0; i < results.length; i++) {
      const text = String(results[i]?.[0]?.transcript || '').trim();
      if (!text) continue;
      if (results[i].isFinal) opts.onFinal?.(text);
      else opts.onPartial?.(text);
    }
  }

  function build() {
    const r = new Ctor();
    started++;
    r.lang = lang;
    r.interimResults = opts.interim !== false;
    r.continuous = !!opts.continuous;
    r.maxAlternatives = 1;
    /* Only on a confirmed answer (see probeOnDevice): an engine asked to run
       on-device without the language pack installed ends the session with
       `language-not-supported`, and a microphone that does not work is a
       worse outcome than a disclosed one. */
    if (onDevice === true) r.processLocally = true;
    r.onstart = () => { listening = true; opts.onStart?.(); opts.onState?.(); };
    r.onresult = handleResult;
    r.onerror = (e) => {
      const code = String(e?.error || 'error');
      if (FATAL_ENGINE_ERRORS.has(code)) {
        /* If asking for on-device recognition is what broke this session, the
           server-side engine is the fallback — once, reported, and with the
           disclosure switching back to the honest one. Never silent: the
           caller sees the error code either way. */
        if (onDevice === true && !triedOnDevice) {
          triedOnDevice = true;
          onDevice = false;
          opts.onError?.(code, e);
          try { r.abort?.(); } catch { /* noop */ }
          rec = null;
          opts.onState?.();
          lag(() => { if (wanted) start(); }, THRASH_WINDOW_MS);
          return;
        }
        giveUp('The microphone is not available, so voice mode is off. Typing works.');
        try { r.abort?.(); } catch { /* noop */ }
        return;
      }
      opts.onError?.(code, e);
    };
    r.onend = () => {
      listening = false;
      opts.onEnd?.();
      opts.onState?.();
      if (wanted) restart();
    };
    return r;
  }

  function start() {
    if (!supported) return false;
    wanted = true;
    if (!asked) {
      const answering = ask();
      if (answering) {
        /* The microphone waits for the answer, so that what the panel says
           about where the audio goes and where it goes cannot disagree. If
           the platform never answers, the race is lost on purpose and the
           session starts on the engine's default. `start()` still reports
           true: the microphone is coming up, not open — `listening` says
           which, and it is the field the button reads. */
        Promise.race([answering, new Promise((resolve) => lag(resolve, ON_DEVICE_PROBE_MS))])
          .then(() => {
            /* Silence counts as no. The alternative is a session nobody can
               describe, and the sentence that says where the audio goes is
               not optional — under-claiming privacy is survivable, not
               saying anything is not. */
            if (!settled) { settled = true; if (onDevice === null) { onDevice = false; opts.onState?.(); } }
            if (wanted && !listening) start();
          })
          .catch(() => { /* the probe never rejects; a defensive catch only */ });
        return true;
      }
    }
    if (!rec) rec = build();
    try {
      rec.start();
    } catch (err) {
      /* Already listening is not a failure; anything else is. */
      if (!listening && /already|started/i.test(String(err?.message))) { listening = true; return true; }
      if (!listening) { wanted = false; return false; }
    }
    listening = true;
    opts.onState?.();
    return true;
  }

  return {
    get supported() { return supported; },
    get reason() { return reason; },
    get listening() { return listening; },
    get constructions() { return started; },
    get thrash() { return thrash; },
    /** `true` only while the platform says recognition can stay on the device;
     *  `false` once it has said otherwise; `null` before it has been asked or
     *  while the answer is in flight. The tri-state is the point: a caller
     *  that has to describe the session must be able to tell "no" from "not
     *  known yet", and only the second one should keep it quiet. */
    get onDevice() { return onDevice; },
    start,
    setLang(l) { lang = l; if (rec) rec.lang = l; },
    stop() { wanted = false; try { rec?.stop?.(); } catch { /* noop */ } },
    /* Used by disable(): after this there is no engine object left to be hot. */
    release() {
      wanted = false;
      try { rec?.abort?.(); } catch { /* noop */ }
      rec = null;
      listening = false;
    },
  };
}

/* ── output: the speaker ───────────────────────────────────────── */

/**
 * Pick the closest available voice for a BCP-47 hint. Pure, because this is
 * the kind of thing that silently reads Hindi in an American accent.
 * `hi-IN` → an exact `hi-IN` → any `hi` → none (the browser's default).
 */
export function pickVoice(voices, hint) {
  const list = (voices || []).filter((v) => v && typeof v.lang === 'string');
  if (!list.length) return null;
  const want = String(hint || '').toLowerCase();
  if (!want) return null;
  const primary = want.split('-')[0];
  return list.find((v) => v.lang.toLowerCase() === want)
    || list.find((v) => v.lang.toLowerCase().split('-')[0] === primary)
    || null;
}

export function createSpeaker(env, opts = {}) {
  const synth = env?.speechSynthesis;
  const Utter = env?.SpeechSynthesisUtterance;
  const supported = !!(synth && Utter);

  return {
    supported,
    get speaking() { return !!synth?.speaking; },
    /** @returns {boolean} whether it actually started speaking */
    speak(text, { lang, hint } = {}) {
      if (!supported) return false;
      const t = String(text || '').trim();
      if (!t) return false;
      const u = new Utter(t);
      const want = hint || voiceHint(lang);
      u.lang = want;
      const v = pickVoice(synth.getVoices?.() || [], want);
      if (v) u.voice = v;
      if (opts.rate != null) u.rate = opts.rate;
      if (opts.pitch != null) u.pitch = opts.pitch;
      u.onstart = () => opts.onStart?.();
      u.onend = u.onerror = () => opts.onEnd?.();
      try { synth.speak(u); } catch { return false; }
      return true;
    },
    stop() { if (!supported) return false; try { synth.cancel(); } catch { /* noop */ } return true; },
  };
}

/* ── the controller ────────────────────────────────────────────── */

/**
 * Ties recognition, tier policy and the chat shell together.
 *
 * @param {object} env     `window`-shaped
 * @param {object} opts
 * @param {object} opts.chat  the chat api: `ask`, `setHandsFree`
 * @param {number} [opts.tier]
 * @param {object} [opts.recognizer] inject a recognizer (tests, probes)
 * @param {object} [opts.speaker]    inject a speaker
 * @param {string[]} [opts.wake]
 * @param {number} [opts.followUpMs] how long one turn stays open (see above)
 * @param {Function} [opts.clock]    ms clock, injectable so the window is testable
 */
export function createVoice(env = {}, opts = {}) {
  const chat = opts.chat || {};
  const wake = opts.wake || WAKE_PHRASES;
  const now = opts.clock || (() => Date.now());
  const followUpMs = Number.isFinite(opts.followUpMs) ? opts.followUpMs : VOICE_TIMING.followUpMs;
  const tapWindowMs = Number.isFinite(opts.tapWindowMs) ? opts.tapWindowMs : VOICE_TIMING.tapWindowMs;
  /* The browser's timer, for the one thing that must happen without an
     utterance to trigger it: closing the microphone at the end of a press. */
  const after = (fn, ms) => (env?.setTimeout ? env.setTimeout(fn, ms) : setTimeout(fn, ms));
  const cancel = (id) => {
    if (id === null) return;
    if (env?.clearTimeout) env.clearTimeout(id); else clearTimeout(id);
  };
  let tier = Number.isInteger(opts.tier) ? opts.tier : 0;

  let enabled = false;
  let mode = 'push';
/* When the open window began, or null when there is none. WHETHER it is still
   open is evaluated on read, so there is no timer to leak for that part; what
   needs a timer is only the microphone actually closing (see windowTimer). */
let sessionAt = null;
/* The pending end of a press. A handle, not a flag: a stale timer from a
   finished press must not be able to close the NEXT one — see the test that
   presses, disables, presses again. */
let windowTimer = null;
  let nick = opts.recognizer || null;
  let speaker = opts.speaker || null;
  let priorHandsFree = null;
  let lang = 'en';
/* Why the last session ended BY ITSELF — a refused microphone, or an engine
   that would not stay up. Kept separate from `enabled`, because "the visitor
   turned it off" and "it died" look identical from the button otherwise, and
   one of them deserves telling. */  let failure = null;
/* ── §11.3's VAD (Proactive only) ───────────────────────────────
   `vad` is the microphone-side detector; `vadGated` says whether the
   recognizer is being switched by it. Both stay null/false unless the
   visitor is in continuous mode — Tap & Speak is a press, and a press needs
   no detector. `vadReason` is why it is not running, when it is not. */
let vad = null;
let vadGated = false;
let vadReason = null;
/* §11.1's hard rule: "never speaks/listens while the tab is hidden". A tab
   the visitor is not looking at is not a tab that should be recording, and
   `visibilitychange` is the only signal the browser gives for it. */
let suspended = false;
const tabHidden = () => (typeof env.document?.hidden === 'boolean'
  ? env.document.hidden
  : env.document?.visibilityState === 'hidden');

  const policy = () => voicePolicy(tier);
  /* Whether this browser can host the detector at all. Checked before the
     VAD is constructed, so a unit test (or an unsupported browser) keeps the
     old synchronous path instead of racing an async permission request. */
  const vadCapable = () => !!(env.navigator?.mediaDevices?.getUserMedia
    && (env.AudioContext || env.webkitAudioContext));
  /* One window, two reasons: a continuous turn (`followUpMs`, extended by each
     answer) and a press (`tapWindowMs`, never extended — extending it is how
     a press turns back into an open microphone). */
  const windowMs = () => (mode === 'push' ? tapWindowMs : followUpMs);
  const sessionLive = (at) => sessionAt !== null && (at - sessionAt) < windowMs();
  const openSession = (at) => { sessionAt = at; };
  const closeSession = () => { sessionAt = null; };
  const cancelWindow = () => { cancel(windowTimer); windowTimer = null; };

  function status() {
    const p = policy();
    const support = nick ? { supported: nick.supported, reason: nick.reason } : recognizeSupported(env);
    return {
      level: p.level,
      supported: support.supported,
      enabled,
      mode: enabled ? mode : null,
      /* suspended = the tab is hidden: still enabled, deliberately not
         listening until it comes back (§11.1) */
      suspended,
      listening: !!(enabled && !suspended && nick?.listening),
      speaking: !!(enabled && !suspended && speaker?.speaking),
      session: enabled ? sessionLive(now()) : false,
      followUpMs,
      tapWindowMs,
      /* §11.3's VAD: `gated` means the recognizer is switched by detected
         speech rather than left running, `speaking` is the segment state,
         and `level` is the 0–1 number §11.5's orb is drawn from. */
      vad: {
        available: vad ? vad.available : null,
        gated: !!vad && vadGated,
        speaking: !!vad?.speaking,
        gateOpen: !!vad?.gateOpen,
        level: vad ? vad.level() : 0,
        reason: vadReason,
      },
      /* what the button would say if it counted down: 20 s to close, or 12 */
      sessionEndsInMs: enabled && sessionAt !== null
        ? Math.max(0, windowMs() - (now() - sessionAt)) : null,
      pushToTalk: p.pushToTalk,
      speakAnswers: p.speakAnswers,
      continuous: p.continuous,
      reason: !support.supported ? support.reason
        : (!p.pushToTalk ? p.reason : (enabled ? null : failure)),
      /* Where the audio actually goes, as the engine reports it, and the
         disclosure text that follows from it — so the panel cannot promise
         more privacy than this session has (§19, docs/PRIVACY.md). `null`
         while the platform is being asked: the text below is already the
         cautious one in that state, and this field is how the panel knows
         the question is not settled yet. */
      onDevice: enabled ? (nick?.onDevice ?? null) : null,
      disclosure: enabled
        ? (nick?.onDevice ? SPEECH_DISCLOSURE_ON_DEVICE : SPEECH_DISCLOSURE)
        : null,
    };
  }

  /**
   * @param {object} [o]
   * @param {boolean} [o.continuous] force the mode (policy still wins)
   * @returns {object} the status after the attempt, right or wrong
   */
  function enable({ continuous = null } = {}) {
    const p = policy();
    if (!p.pushToTalk) return status();

    nick = nick || opts.recognizer || createRecognizer(env, {
      lang: voiceHint(lang),
      continuous: p.continuous,
      onPartial: onPartial,
      onFinal: onFinal,
      /* An engine that has decided it cannot work is not a session: the
         scene's ladder is released, the button goes back to off, and the
         reason survives for the panel to say once. */
      onError: () => {
        if (nick?.reason) { failure = nick.reason; disable(); }
        opts.onStatus?.(status());
      },
      onState: () => opts.onStatus?.(status()),
    });
    speaker = speaker || opts.speaker || createSpeaker(env, {
      onStart: () => opts.onStatus?.(status()),
      onEnd: () => opts.onStatus?.(status()),
    });

    if (!nick.supported) return status();

    const wantContinuous = continuous == null ? p.continuous : !!continuous;
    mode = (p.continuous && wantContinuous) ? 'continuous' : 'push';
    nick.setLang?.(voiceHint(lang));

    enabled = true;
    closeSession();
    failure = null;
    cancelWindow();
    env.document?.addEventListener?.('visibilitychange', onVisibility);
    suspended = tabHidden();
    /* §11.3: Proactive is VAD-gated. Started before the recognizer, so the
       gate is live for the first thing said. If it cannot start — no
       microphone permission, no Web Audio, an injection-blocked context —
       the recognizer falls back to its restart loop, which still works, and
       the status says which of the two this is rather than pretending. */
    if (mode === 'continuous' && opts.vad !== false && vadCapable()) {
      vad = createMicVad(env, {
        trackerOpts: opts.vadOpts,
        onGateOpen: () => { if (enabled && mode === 'continuous') nick?.start?.(); },
        onGateClose: () => { if (enabled && mode === 'continuous') nick?.stop?.(); },
        onFrame: (frame) => opts.onVadFrame?.(frame),
        onError: (message) => { vadReason = message; },
      });
      /* Optimistic on purpose: `enable()` is called from a click handler and
         has to return the status synchronously (the panel paints from it).
         The gate is wired before permission is granted, so the first thing
         said is not missed — `vad.ts`'s own settler covers the gap — and a
         refusal falls back to the recognizer's restart loop, reported. */
      vadGated = true;
      Promise.resolve(vad.start()).then((ok) => {
        if (!ok) {
          vadGated = false;
          vadReason = vad?.reason || 'the microphone could not be opened';
          /* the fallback the module already had: listening unconditionally */
          if (enabled && mode === 'continuous') nick?.start?.();
          opts.onStatus?.(status());
        }
      });
    }
    /* Remembered, not assumed: if the visitor (or a host) had already turned
       proactive mode on, turning voice off must not take it away. */
    if (priorHandsFree === null) {
      const current = typeof chat.handsFree === 'function' ? chat.handsFree() : chat.handsFree;
      priorHandsFree = !!current;
    }
    /* The page follows an answer only while the visitor is not holding a
       mouse: that is what "proactive" means here, and it is the mode the
       anchors were built for (§12). */
    chat.setHandsFree?.(true);
    /* Deliberately NOT `chat.setWorking(true)`. Listening is not work: every
       §6.3 rung acts on the model or the scene — pace generation, shorten the
       answer budget, lower the scene quality, stop generating — and not one
       of them makes speech recognition faster. Arming the ladder for a listen
       only holds the film down, and on a device where it fires it pays rung
       3's cost (MEASURED: 21 shader programs relinked, 1221 ms of blocked main
       thread) to protect a generation that is not running. The answer that
       arrives at the end of the listen goes through `ask()`, which arms it
       then, exactly as a typed one does. */
    /* In a gated session the VAD decides when the recognizer runs; starting
       it here as well would run it from the moment voice is switched on,
       which is the cost the gate exists to avoid. */
    if (!vadGated) nick.start();
    /* A press opens a window that CLOSES BY ITSELF. Without this the engine
       restarts itself for as long as the panel is open and every word in the
       room is a question — a hotter microphone than continuous mode, which at
       least asks you to say the name. */
    if (mode === 'push') {
      openSession(now());
      /* The callback verifies it still owns the window before acting: a timer
         that survived a disable (or a re-press) must not be able to close a
         session it has nothing to do with. */
      let id = null;
      id = after(() => {
        if (windowTimer !== id) return;
        windowTimer = null;
        if (enabled && mode === 'push') disable();
      }, tapWindowMs);
      windowTimer = id;
    }
    opts.onStatus?.(status());
    return status();
  }

  /** Hiding the tab suspends listening and cancels any speech; showing it
   *  resumes — but only if the visitor had voice on, and never re-opens a turn
   *  that had already expired. */
  function onVisibility() {
    if (!enabled) return;
    if (tabHidden()) {
      suspended = true;
      speaker?.stop();
      nick?.stop?.();
    } else if (suspended) {
      suspended = false;
      if (!vadGated) nick?.start?.();
    }
    opts.onStatus?.(status());
  }

  function disable() {
    if (!enabled) return status();
    enabled = false;
    cancelWindow();
    closeSession();
    env.document?.removeEventListener?.('visibilitychange', onVisibility);
    suspended = false;
    /* §6.4: the microphone is released with the mode. For the VAD that means
       the MediaStream tracks stop and the AudioContext closes, which is the
       only thing that turns the browser's recording indicator off. */
    vad?.stop?.();
    vad = null;
    vadGated = false;
    vadReason = null;
    nick?.stop();
    nick?.release?.();
    nick = opts.recognizer || null;     /* never keep a hot engine */
    speaker?.stop();
    speaker = opts.speaker || null;
    chat.setHandsFree?.(!!priorHandsFree);
    priorHandsFree = null;
    opts.onStatus?.(status());
    return status();
  }

  /** Barge-in: the visitor talking over the answer takes the turn back. */
  function onPartial(text) {
    if (!enabled || suspended || !String(text || '').trim()) return false;
    if (!speaker?.speaking) return false;
    speaker.stop();
    return true;
  }

  /**
   * A finished utterance. In continuous mode this is where the wake phrase is
   * required — speech that is not addressed to the assistant is dropped in
   * silence, not answered and not announced.
   *
   * @returns {{wake:boolean, question:string}|null} null when nothing was asked
   */
  function onFinal(text) {
    if (!enabled || suspended) return null;
    /* §11.2: a recognizer's silence-phantom ("thank you", "you", "okay")
       must die here, before the wake phrase, the session window or the
       answer path ever see it. Answering one aloud is the failure this
       filter exists to prevent, and it is dropped in silence for the same
       reason an unaddressed sentence is (§12). */
    const phantom = isPhantom(text, opts.phantomOpts);
    if (phantom.phantom) {
      opts.onPhantom?.(phantom);
      return null;
    }
    const at = now();
    const { wake: heard, question } = stripWake(text, wake);

    if (mode === 'continuous') {
      const live = sessionLive(at);
      if (heard) openSession(at);                  /* addressed to the assistant */
      else if (!live) return null;                 /* and nothing else is */
      if (!question) { opts.onStatus?.(status()); return { wake: heard, question: '' }; }
      /* The window is NOT extended here. `ask()` calls back into `onAnswer`
         synchronously — which is where the answer is known — so re-opening
         the turn at this point would undo the close that an abstention had
         just performed. The turn's length belongs to the answer, below. */
      const asked = ask(question);
      return { wake: heard, question: asked ? question : '' };
    }

    /* push-to-talk: the press was the address. A final that arrives after the
       window closed belongs to a microphone that is no longer listening for
       an answer — it is dropped, not answered. */
    if (!question || !sessionLive(at)) return null;
    return { wake: heard, question: ask(question) ? question : '' };
  }

  function ask(question) {
    if (!question) return false;
    if (!chat.ask) return false;
    chat.ask(question);
    return true;
  }

  /**
   * The assistant's own answer, on its way out. Speaking happens HERE rather
   * than inside `ask()` so the text path and the voice path share one answer
   * — the same words, the same facts, the same section of the page.
   */
  function onAnswer(res, { lang: turnLang } = {}) {
    if (!enabled || suspended) return false;
    if (turnLang) lang = turnLang;
    /* The turn's length is decided by what the answer WAS, not by the fact
       that something was heard: one question that landed on the portfolio
       buys the next one for the window, so a follow-up needs no wake phrase —
       and an answer that made no claim ends the turn right there, rather than
       staying open for a conversation the assistant cannot join. Checked
       before the speaking rules, because it is about the turn, not the audio. */
    if (mode === 'continuous') {
      if (res?.abstained || res?.injection) closeSession();
      else openSession(now());
    }
    const p = policy();
    if (!p.speakAnswers) return false;
    const text = res?.text;
    if (!text) return false;
    const started = speaker?.speak(text, { lang }) || false;
    /* §11.5's dot moves faster while an answer is being read, and that state
       has to be reported when it begins, not only when it ends — without
       this the panel would show `speaking` only after the voice stopped. */
    if (started) opts.onStatus?.(status());
    return started;
  }

  function setTier(t) {
    if (!Number.isInteger(t)) return status();
    tier = t;
    const p = policy();
    /* A tier the session is no longer allowed to be in ends the session: a
       device that has dropped to T0 must not keep a microphone open, and one
       that can no longer listen continuously must not still be doing it. The
       visitor presses again, which is cheap and honest. */
    if (enabled && (!p.pushToTalk || (mode === 'continuous' && !p.continuous))) disable();
    nick?.setLang?.(voiceHint(lang));
    return status();
  }

  return {
    enable, disable, status, setTier, onFinal, onPartial, onAnswer,
    onVisibility,
    get suspended() { return suspended; },
    setLang(l) { if (l) lang = l; nick?.setLang?.(voiceHint(lang)); },
    /** The visitor's own words can never wake it — nothing else can either. */
    isEnabled: () => enabled,
    isSessionOpen: () => enabled && sessionLive(now()),
    closeSession,
    get followUpMs() { return followUpMs; },
    get tapWindowMs() { return tapWindowMs; },
    get pendingWindow() { return windowTimer !== null; },
    tierInfo: () => tierInfo(tier),
  };
}

/* `voiceSummary` — the panel's pre-tap description — lives in `./caps.mjs`
   with the policy table it reads, and is re-exported above. */
