/* ═══════════════════════════════════════════════════════════════
   evaluation/answer-text.mjs — a re-export shim (2026-10-08).

   The wording module moved to `ai/answers/wording.mjs` and ships again:
   the owner chose the data-file-first product, so the answerer words a
   plan from `knowledge.json` instead of asking the model. Every import
   in the evaluation suite, the calibration sweep and the tests keeps
   working through this file; the real code lives one directory over.

   `quickAnswer` here is the SAY-wired planner — the same drop-in the
   evaluation set has always run, now defined beside the shipped one.
   ═══════════════════════════════════════════════════════════════ */
export {
  say, quickAnswer,
  tri, MAX_ANSWER_CHARS, factIds, fmtDate, renderFact, contextSizer, resolveFacts,
  followupsFor, disclosure, PERSONAS, DEFAULT_PERSONA, CATEGORY_WORDS,
} from '../ai/answers/wording.mjs';
