/* ═══════════════════════════════════════════════════════════════
   ai/voice/phantoms.mjs — transcripts that were never spoken (§11.2)

   Speech recognizers hallucinate on silence and noise. Whisper is the
   famous case (it was trained on subtitled video, so a quiet room can
   produce "Thank you." or "Subtitles by the Amara.org community"), but it
   is not only Whisper: the browser engines emit "you", "okay" and
   "thank you" into an empty microphone too.

   §11.2 requires this filter by name — "VAD gating + min length +
   known-phrase blocklist" — and the consequence of NOT having it is
   specific and embarrassing: a recruiter says nothing, and the portfolio
   assistant answers "thank you", out loud, in Aashish's voice. That is
   also why the filter is *silent*: a phantom is dropped, never announced,
   because announcing it would tell a visitor that something was heard
   when nothing was.

   What it is NOT
   --------------
   It is not a language model and it does not judge meaning. Three cheap
   rules, each with a test, and a deliberate refusal to guess beyond them:

     · **length** — a one-character final is noise. Two characters are
       kept, because "hi" is a real greeting a visitor actually says.
     · **blocklist** — phrases that are never a question about a portfolio,
       matched on a normalized copy so punctuation cannot hide them.
     · **repetition** — the same word three or more times ("no no no",
       "the the the") is a stuck decoder, not a sentence.

   Anything it drops, it drops for a stated reason, and the caller can
   read the reason (`isPhantom().reason`) — a filter that silently discards
   inputs is indistinguishable from a filter that is broken.
   ═══════════════════════════════════════════════════════════════ */

/** Normalize for matching: NFKC, lower case, collapse whitespace, strip
 *  punctuation. The visitor's own text is never rewritten — this copy is
 *  only ever compared, never returned. */
/* The `\p{M}` is not decoration: Devanagari vowel signs and the virama are
   category **Mn**, neither a letter nor a number, so a class of `\p{L}\p{N}`
   replaces them with spaces — `धन्यवाद` becomes `धन यव द` and stops matching
   its own blocklist entry. Phase 1 lost a whole script to exactly this
   character class (PROGRESS R7); it is not lost again here. */
export function normalizeTranscript(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')      /* [Music], [Applause] */
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phrases a recognizer produces from silence. Kept short on purpose: every
 * entry is a phrase that is *never* a portfolio question, because dropping
 * a real question is the one failure mode worse than answering a phantom.
 */
export const KNOWN_PHANTOMS = new Set([
  /* English, the subtitle-corpus classics */
  'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
  'please subscribe', 'subscribe', 'like and subscribe',
  'subtitles by the amara org community', 'subtitles by amara org',
  'amara org', 'transcription by', 'translated by', 'the end',
  'you', 'okay', 'ok', 'hmm', 'uh', 'um', 'bye', 'goodbye', 'music',
  'hello?', 'foreign',
  /* Hindi / Hinglish fillers that are not questions */
  'धन्यवाद', 'शुक्रिया', 'जी', 'हाँ', 'हां', 'ठीक है', 'अच्छा',
  'theek hai', 'ji haan', 'haan', 'hmm theek',
]);

/** Minimum characters for a final to be considered speech (§11.2 min length). */
export const MIN_PHANTOM_CHARS = 2;

/** How many times one word must repeat before it is a stuck decoder. */
export const REPEAT_LIMIT = 3;

/**
 * Is this final a phantom?
 *
 * @param {string} text the recognizer's final transcript
 * @param {object} [opts]
 * @param {number} [opts.audioMs] how long the captured audio was, if the
 *        caller can measure it — a "question" arriving after 80 ms of audio
 *        was not spoken
 * @param {number} [opts.minChars]
 * @param {Set<string>} [opts.blocklist]
 * @returns {{phantom:boolean, reason:string, normalized:string}}
 */
export function isPhantom(text, opts = {}) {
  const raw = String(text ?? '').trim();
  const normalized = normalizeTranscript(raw);
  const minChars = opts.minChars ?? MIN_PHANTOM_CHARS;
  const blocklist = opts.blocklist ?? KNOWN_PHANTOMS;

  if (!normalized) {
    return { phantom: true, reason: 'empty', normalized };
  }
  if (raw.replace(/\s+/g, '').length < minChars) {
    return { phantom: true, reason: 'too-short', normalized };
  }
  if (opts.audioMs != null && opts.audioMs > 0 && opts.audioMs < 300) {
    /* §11.1 already asks for a ≥300 ms minimum segment; this is the same
       bound applied to what came back, in case the caller's segmenter
       could not. An 80 ms capture cannot contain a sentence. */
    return { phantom: true, reason: 'audio-too-short', normalized };
  }
  if (blocklist.has(normalized)) {
    return { phantom: true, reason: 'known-phrase', normalized };
  }
  /* a known phrase with trailing filler ("thank you." → "thank you") is
     already normalized; a known phrase with a leading word is not, and is
     left alone — over-matching is how a real question gets dropped */
  const words = normalized.split(' ');
  if (words.length >= REPEAT_LIMIT) {
    let run = 1;
    for (let i = 1; i < words.length; i++) {
      run = words[i] === words[i - 1] ? run + 1 : 1;
      if (run >= REPEAT_LIMIT) {
        return { phantom: true, reason: 'stuck-repeat', normalized };
      }
    }
  }
  return { phantom: false, reason: '', normalized };
}
