/* ═══════════════════════════════════════════════════════════════
   ai/voice/caps.mjs — what voice mode WOULD be, before it is turned on

   The tier policy (§6.2's `TIERS[].voice`) and the feature check, and nothing
   that listens or speaks. §2 N6 ("voice assets load only when a voice mode is
   chosen") needs the panel to describe the button the moment it opens without
   pulling in the recognizer, the VAD or the speaker, so `ai/ui/chat.mjs`
   imports this and loads `ai/voice/index.mjs` itself on the first tap.
   `ai/voice/index.mjs` re-exports everything here, so no importer has to know.
   ═══════════════════════════════════════════════════════════════ */
import { tierInfo } from '../governor/index.mjs';

/** What each `TIERS[].voice` level grants. Keys are the declared vocabulary. */
export const VOICE_POLICY = {
  none: {
    pushToTalk: false, speakAnswers: false, continuous: false,
    reason: 'This device\'s tier keeps answers typed.',
  },
  tap: { pushToTalk: true, speakAnswers: false, continuous: false, reason: null },
  /* §6.2 grants T2 Proactive "(VAD-gated)" — the gate lives in vad.mjs */
  both: { pushToTalk: true, speakAnswers: true, continuous: true, reason: null },
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

export const NO_ENGINE =
  'This browser has no speech recognition, so voice mode stays off. Typing works.';

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

/** Everything the panel needs to describe voice mode before it is turned on. */
export function voiceSummary(tierId, env) {
  const p = voicePolicy(tierId);
  const s = recognizeSupported(env);
  return { ...p, supported: s.supported, reason: s.supported ? p.reason : s.reason };
}
