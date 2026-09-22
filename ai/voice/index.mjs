/* ═══════════════════════════════════════════════════════════════
   ai/voice/index.mjs — the §11 voice layer: heard, and heard out loud

   Two halves, and the honest split between them matters:

     · INPUT  uses the browser's own speech recognition
       (`SpeechRecognition` / `webkitSpeechRecognition`). That is not a
       neutrality choice — that engine is *server-side*: while it listens,
       audio leaves the device. So nothing here touches the microphone until
       the visitor presses the button, and when they do, the panel says so in
       as many words (`SPEECH_DISCLOSURE`). The typed chat still keeps its old
       promise, because typing never involved an engine at all.
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
     T2 `both` — push-to-talk + answers read aloud.
     T3 `all`  — both of those, plus continuous listening behind a wake
                 phrase, because a desktop can afford it.
   ═══════════════════════════════════════════════════════════════ */
import { tierInfo } from '../governor/index.mjs';
import { voiceHint } from '../language/detect.mjs';

/* ── the tier table, read rather than restated ─────────────────── */

/** What each `TIERS[].voice` level grants. Keys are the declared vocabulary. */
export const VOICE_POLICY = {
  none: {
    pushToTalk: false, speakAnswers: false, continuous: false,
    reason: 'This device\'s tier keeps answers typed.',
  },
  tap: { pushToTalk: true, speakAnswers: false, continuous: false, reason: null },
  both: { pushToTalk: true, speakAnswers: true, continuous: false, reason: null },
  all: { pushToTalk: true, speakAnswers: true, continuous: true, reason: null },
};

export function voicePolicy(tierId) {
  const level = tierInfo(tierId)?.voice || 'none';
  const p = VOICE_POLICY[level];
  /* A tier naming a level this table does not know must fail CLOSED: an
     unrecognised capability is not permission. `tests/voice.test.mjs` pins
     the two sets against each other so this cannot be reached by drift. */
  if (!p) return { level, ...VOICE_POLICY.none, reason: `Unknown voice level "${level}".` };
  return { level, ...p };
}

/* ── the disclosure ────────────────────────────────────────────── */

/** Said once, when the visitor turns voice on, instead of being buried. */
export const SPEECH_DISCLOSURE =
  'Voice mode uses your browser\'s speech recognition, which sends what you '
  + 'say to your browser\'s speech service — so while it listens, your audio '
  + 'leaves this device. Typed questions never do. Turn voice off any time.';

export const NO_ENGINE =
  'This browser has no speech recognition, so voice mode stays off. Typing works.';

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

export function speechRecognitionCtor(env) {
  return env?.SpeechRecognition || env?.webkitSpeechRecognition || null;
}

/** Feature detection as a value, never a throw — a browser without the API
 *  must cost nothing and say why. */
export function recognizeSupported(env) {
  return speechRecognitionCtor(env)
    ? { supported: true, reason: null }
    : { supported: false, reason: NO_ENGINE };
}

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
    r.onstart = () => { listening = true; opts.onStart?.(); opts.onState?.(); };
    r.onresult = handleResult;
    r.onerror = (e) => {
      const code = String(e?.error || 'error');
      if (FATAL_ENGINE_ERRORS.has(code)) {
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
 * @param {object} opts.chat  the chat api: `ask`, `setHandsFree`, `setWorking`
 * @param {number} [opts.tier]
 * @param {object} [opts.recognizer] inject a recognizer (tests, probes)
 * @param {object} [opts.speaker]    inject a speaker
 * @param {string[]} [opts.wake]
 */
export function createVoice(env = {}, opts = {}) {
  const chat = opts.chat || {};
  const wake = opts.wake || WAKE_PHRASES;
  let tier = Number.isInteger(opts.tier) ? opts.tier : 0;

  let enabled = false;
  let mode = 'push';
  let session = false;                /* continuous: has the wake phrase been heard? */
  let nick = opts.recognizer || null;
  let speaker = opts.speaker || null;
  let priorHandsFree = null;
  let lang = 'en';
/* Why the last session ended BY ITSELF — a refused microphone, or an engine
   that would not stay up. Kept separate from `enabled`, because "the visitor
   turned it off" and "it died" look identical from the button otherwise, and
   one of them deserves telling. */
let failure = null;

  const policy = () => voicePolicy(tier);

  function status() {
    const p = policy();
    const support = nick ? { supported: nick.supported, reason: nick.reason } : recognizeSupported(env);
    return {
      level: p.level,
      supported: support.supported,
      enabled,
      mode: enabled ? mode : null,
      listening: !!(enabled && nick?.listening),
      speaking: !!(enabled && speaker?.speaking),
      pushToTalk: p.pushToTalk,
      speakAnswers: p.speakAnswers,
      continuous: p.continuous,
      reason: !support.supported ? support.reason
        : (!p.pushToTalk ? p.reason : (enabled ? null : failure)),
      disclosure: enabled ? SPEECH_DISCLOSURE : null,
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
    speaker = speaker || opts.speaker || createSpeaker(env, { onEnd: () => opts.onStatus?.(status()) });

    if (!nick.supported) return status();

    const wantContinuous = continuous == null ? p.continuous : !!continuous;
    mode = (p.continuous && wantContinuous) ? 'continuous' : 'push';
    nick.setLang?.(voiceHint(lang));

    enabled = true;
    session = false;
    failure = null;
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
    /* And the frame ladder is armed for as long as the assistant is working —
       listening is work (§15.3: it is armed around work, never around the
       panel merely being open). */
    chat.setWorking?.(true);
    nick.start();
    opts.onStatus?.(status());
    return status();
  }

  function disable() {
    if (!enabled) return status();
    enabled = false;
    session = false;
    nick?.stop();
    nick?.release?.();
    nick = opts.recognizer || null;     /* never keep a hot engine */
    speaker?.stop();
    speaker = opts.speaker || null;
    chat.setHandsFree?.(!!priorHandsFree);
    chat.setWorking?.(false);
    priorHandsFree = null;
    opts.onStatus?.(status());
    return status();
  }

  /** Barge-in: the visitor talking over the answer takes the turn back. */
  function onPartial(text) {
    if (!enabled || !String(text || '').trim()) return false;
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
    if (!enabled) return null;
    const { wake: heard, question } = stripWake(text, wake);

    if (mode === 'continuous') {
      if (heard) session = true;
      else if (!session) return null;              /* not addressed to me */
      if (!question) { opts.onStatus?.(status()); return { wake: heard, question: '' }; }
      return { wake: heard, question: ask(question) ? question : '' };
    }

    /* push-to-talk: the button is the wake phrase */
    if (!question) return null;
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
    if (!enabled) return false;
    if (turnLang) lang = turnLang;
    const p = policy();
    if (!p.speakAnswers) return false;
    const text = res?.text;
    if (!text) return false;
    return speaker?.speak(text, { lang }) || false;
  }

  function setTier(t) {
    if (!Number.isInteger(t)) return status();
    tier = t;
    const p = policy();
    if (enabled && !p.pushToTalk) disable();
    nick?.setLang?.(voiceHint(lang));
    return status();
  }

  return {
    enable, disable, status, setTier, onFinal, onPartial, onAnswer,
    setLang(l) { if (l) lang = l; nick?.setLang?.(voiceHint(lang)); },
    /** The visitor's own words can never wake it — nothing else can either. */
    isEnabled: () => enabled,
    isSessionOpen: () => session,
    tierInfo: () => tierInfo(tier),
  };
}

/** Everything the panel needs to describe voice mode before it is turned on. */
export function voiceSummary(tierId, env) {
  const p = voicePolicy(tierId);
  const s = recognizeSupported(env);
  return { ...p, supported: s.supported, reason: s.supported ? p.reason : s.reason };
}
