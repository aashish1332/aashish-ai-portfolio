/* ═══════════════════════════════════════════════════════════════
   ai/language/detect.mjs — deterministic language detection (§8.3)

   No selector, ever. No ML. Pure rules, so it is testable and cheap
   enough to run on the main thread before any model exists.

     · Devanagari-script ratio  → catches Hindi (and Devanagari code-mix)
     · Roman-Hinglish function-word lexicon → catches "kya hai", "batao"
     · English stop-word lexicon → the negative signal that keeps plain
       English from being misread as Hinglish
     · smoothing across turns: a weak signal defers to the previous turn,
       a strong signal always wins (§8.3)

   Runs in the browser as ESM and under `node --test` unchanged.
   ═══════════════════════════════════════════════════════════════ */

/* Devanagari block U+0900–U+097F, plus the extended block U+A8E0–U+A8FF */
const DEV_RE = /[\u0900-\u097F\uA8E0-\uA8FF]/;
const LATIN_RE = /[A-Za-z]/;

/* ─ Roman-Hinglish function words ────────────────────────────────
   Deliberately EXCLUDES every token that is also a common English word,
   because a false Hinglish hit is worse than a miss:
     to  do  is  in  a  an  the  and  no  so  me  main  hi  log  par  key  na
   "main" is excluded on purpose — in a developer portfolio it is
   overwhelmingly the English word ("main thread", "main.js").
   ──────────────────────────────────────────────────────────────── */
export const HINGLISH_WORDS = new Set([
  /* pronouns / people */
  'mai', 'mein', 'hum', 'tum', 'aap', 'yeh', 'ye', 'wo', 'voh', 'uska', 'uski', 'uske',
  'unka', 'unki', 'mera', 'meri', 'mere', 'tumhara', 'aapka', 'apna', 'apni', 'khud',
  /* question words */
  'kya', 'kyaa', 'kaun', 'kaunsa', 'kaunsi', 'kaise', 'kaisa', 'kaisi', 'kyun', 'kyon',
  'kab', 'kahan', 'kahaan', 'kitna', 'kitni', 'kitne',
  /* postpositions / particles */
  'ka', 'ke', 'ki', 'ko', 'se', 'ne', 'bhi', 'aur', 'toh', 'phir', 'abhi', 'sirf', 'bas',
  /* verbs / auxiliaries */
  'hai', 'hain', 'ho', 'hun', 'tha', 'thi', 'hoga', 'hogi', 'honge',
  'raha', 'rahi', 'rahe', 'karo', 'kar', 'karta', 'karti', 'karte', 'karna', 'kiya',
  'sakta', 'sakte', 'sakti', 'chahiye', 'lagta', 'lagti', 'milega', 'mila',
  /* requests / imperatives — the most common chat verbs */
  'batao', 'bata', 'bataiye', 'batana', 'dikhao', 'dikha', 'sunao', 'likho', 'kholo',
  /* quantifiers / adjectives */
  'bahut', 'bohot', 'thoda', 'zyada', 'accha', 'acha', 'achha', 'theek', 'tik', 'sab',
  'kuch', 'koi', 'jaisa', 'jaise', 'matlab', 'wala', 'wali', 'wale', 'saare', 'poora',
  /* unambiguous romanised nouns */
  'kaam', 'padhai', 'zindagi', 'dost', 'bhai', 'yaar', 'baat', 'jankari', 'jaankari',
  'sawal', 'jawab', 'madad', 'kripya', 'dhanyavad', 'namaste', 'shukriya',
]);

/* ── English stop words ───────────────────────────────────────────
   The negative signal. Function words only — no content words, so a
   sentence like "batao mongo" is not rescued by "mongo".
   ────────────────────────────────────────────────────────────── */
export const ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'will', 'would', 'shall',
  'should', 'can', 'could', 'may', 'might', 'must', 'to', 'of', 'in', 'on',
  'at', 'by', 'for', 'with', 'from', 'about', 'into', 'over', 'after',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'because', 'as',
  'what', 'who', 'whom', 'whose', 'which', 'when', 'where', 'why', 'how',
  'he', 'she', 'it', 'they', 'him', 'her', 'them', 'his', 'their', 'its',
  'i', 'you', 'your', 'we', 'our', 'my', 'me', 'us',
  'this', 'that', 'these', 'those', 'there', 'here',
  'tell', 'show', 'list', 'give', 'explain', 'describe', 'summarize', 'share',
  'know', 'want', 'need', 'like', 'get', 'got', 'make', 'made', 'use', 'used',
  'yes', 'no', 'not', 'please', 'thanks', 'thank', 'hello', 'hey',
]);

const TOKEN_RE = /[A-Za-z\u0900-\u097F\uA8E0-\uA8FF]+/g;

/** Split into lower-cased tokens (Latin + Devanagari runs). */
export function tokenize(text) {
  return String(text || '').toLowerCase().match(TOKEN_RE) || [];
}

/**
 * Detect the language of a single message.
 * @returns {{lang:'en'|'hi'|'hinglish', strength:'strong'|'weak',
 *            devRatio:number, hinglishHits:number, englishHits:number,
 *            tokens:number}}
 */
export function detectLanguage(text) {
  const raw = String(text || '');
  const tokens = tokenize(raw);

  /* script ratios over the letters actually present */
  let dev = 0, latin = 0;
  for (const ch of raw) {
    if (DEV_RE.test(ch)) dev++;
    else if (LATIN_RE.test(ch)) latin++;
  }
  const letters = dev + latin;
  const devRatio = letters ? dev / letters : 0;

  let hinglishHits = 0, englishHits = 0;
  for (const t of tokens) {
    if (HINGLISH_WORDS.has(t)) hinglishHits++;
    else if (ENGLISH_WORDS.has(t)) englishHits++;
  }

  const base = { devRatio: +devRatio.toFixed(3), hinglishHits, englishHits, tokens: tokens.length };

  if (!tokens.length) return { lang: 'en', strength: 'weak', ...base };

  /* 1. Devanagari-dominant → Hindi */
  if (devRatio >= 0.55) return { lang: 'hi', strength: 'strong', ...base };

  /* 2. Devanagari present but Latin-heavy → code-mixed */
  if (devRatio > 0.10) return { lang: 'hinglish', strength: 'strong', ...base };

  /* 3. Pure Latin: weigh the Hinglish lexicon against English stop words */
  if (hinglishHits >= 2 && hinglishHits >= englishHits) {
    return { lang: 'hinglish', strength: 'strong', ...base };
  }
  if (hinglishHits === 1 && englishHits === 0) {
    return { lang: 'hinglish', strength: 'strong', ...base };
  }
  if (hinglishHits >= 1 && hinglishHits === englishHits) {
    /* genuinely ambiguous ("project ki details") — weakest signal we emit */
    return { lang: 'hinglish', strength: 'weak', ...base };
  }
  if (englishHits >= 2) return { lang: 'en', strength: 'strong', ...base };
  if (englishHits === 1 && hinglishHits === 0) return { lang: 'en', strength: 'strong', ...base };

  /* 4. Latin with no function words at all ("mongodb", "CGPA") → weak English */
  return { lang: 'en', strength: 'weak', ...base };
}

/**
 * Turn-aware detector (§8.3 smoothing). A weak result keeps the previous
 * turn's language; a strong result switches immediately.
 */
export function createLanguageTracker(initial = 'en') {
  let last = initial;
  return {
    /** @returns {{lang, strength, switched:boolean, detection:object}} */
    push(text) {
      const d = detectLanguage(text);
      const lang = d.strength === 'strong' ? d.lang : last;
      const switched = lang !== last;
      last = lang;
      return { lang, strength: d.strength, switched, detection: d };
    },
    get current() { return last; },
    reset(to = initial) { last = to; },
  };
}

/** Language names for UI labels and the TTS voice picker (§11.4). */
export const LANG_LABEL = { en: 'English', hi: 'हिन्दी', hinglish: 'Hinglish' };

/** BCP-47 hint used to pick a speechSynthesis voice per tier V0. */
export function voiceHint(lang) {
  if (lang === 'hi') return 'hi-IN';
  if (lang === 'hinglish') return 'en-IN';
  return 'en-US';
}