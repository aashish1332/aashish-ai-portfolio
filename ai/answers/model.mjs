/* ═══════════════════════════════════════════════════════════════
   ai/answers/model.mjs — the model's answer path, in §5.1's order.

   1. **Retrieve** (§8.2). Below the calibrated gate there is nothing to
      ground on, so the assistant abstains and the model is never asked.
      That is not a template answering instead — it is the §8.4 layer-1
      decision that the honest answer is "I don't have that", made *before*
      a token is generated, because a model asked a question its context
      cannot answer only has making something up left to do.
   2. **Ask the model** — its own vocabulary, its own weights, greedy, in a
      worker (`ai/engine/session.mjs`). No template is consulted for prose.
   3. **Guard** (§8.4 layer 4) and, on failure, one greedy retry over a
      shortened context, then the extractive Quick Answer.
   4. **Resolve placeholders** to allowlisted values (`<|fact:x|>`), which
      is the only way a URL or an email ever reaches the screen (§7.2).

   What this module refuses to do: invent a sentence the model did not
   produce. Every string it returns is either the model's text, the
   portfolio's own text, or the localized "I don't have that".
   ═══════════════════════════════════════════════════════════════ */

import { guardedAnswer } from '../guard/index.mjs';
import { buildIndex, search, MIN_TOP_SCORE } from '../retrieval/index.mjs';
import { resolveFacts, renderFact } from './quick.mjs';

export const MODEL_BADGES = Object.freeze({
  model: 'AI ANSWER · ON-DEVICE MODEL',
  fallback: 'QUICK ANSWER · THE MODEL DID NOT PASS THE CHECK',
  abstain: 'NO CLAIM MADE · NOT IN THE PORTFOLIO',
});

/** The context the model reads: `[id] value`, exactly the layout
 *  `ai/data/instruction.py` trains on. One line per retrieved fact, in
 *  retrieval order, deduplicated, newest-first trimmed by the caller's k. */
export function contextLines(kb, hits, lang = 'en') {
  const seen = new Set();
  const lines = [];
  for (const hit of hits) {
    for (const id of [hit.id, ...(hit.alsoIds || [])]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const value = renderFact(kb, id, lang);
      if (value) lines.push(`[${id}] ${value}`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {object} opts
 * @param {object} opts.kb          the knowledge base (read through view.mjs)
 * @param {object} opts.session     `createModelSession(...)`
 * @param {string} [opts.persona]   'first' | 'third' (§7.4 RULES)
 * @param {number} [opts.maxNewTokens]  §6.2's per-tier cap
 * @param {number} [opts.minScore]  the calibrated layer-1 gate
 */
export function createModelAnswerer(opts = {}) {
  const {
    kb, session, persona = 'first', history = [],
    minScore = MIN_TOP_SCORE, onNotice = null,
  } = opts;
  /* Mutable because §6.3's degrade ladder lowers the budget mid-session and
     restores it when the frames recover — the same answerer, a smaller
     answer, never a new pipeline. */
  let maxNewTokens = opts.maxNewTokens ?? 96;
  let paceMs = opts.paceMs ?? 0;

  let index = null;
  let lastSummary = null;
  let asks = 0;
  let guardFailures = 0;

  const indexOf = () => (index ||= buildIndex(kb));

  return {
    get status() { return session.status; },
    get code() { return session.status === 'ready' ? 'ready' : session.status; },
    get reason() { return session.reason; },
    get stats() { return { asks, guardFailures, maxNewTokens, paceMs }; },

    /** §6.3 steps 1–2, applied by the governor through the chat shell. */
    setMaxNewTokens(n) { maxNewTokens = Math.max(1, Math.floor(n)); return maxNewTokens; },
    setPaceMs(ms) { paceMs = Math.max(0, ms | 0); return paceMs; },

    /** Retrieval only — what the model will be allowed to read. Exposed so
     *  the tests (and the probes) can check the grounding without a model. */
    retrieve(question, focus = null) {
      const found = search(indexOf(), question, { minScore, focus });
      return { ...found, context: contextLines(kb, found.hits) };
    },

    /**
     * @returns {Promise<{kind:'model'|'fallback'|'abstain', text:string,
     *   sources:string[], context:string, attempts:number, guardFailed:boolean,
     *   abstained:boolean, reason?:string, ms:number}>}
     */
    async ask({
      question, lang = 'en', focus = null, quick = null,
      onToken = null, onReplace = null, signal = null,
    }) {
      const started = Date.now();
      const found = this.retrieve(question, focus);

      if (found.lowConfidence) {
        // §5.1 step 4: below the gate, no model call. The caller already has
        // a localized abstention from Quick Answers; returning `quick.text`
        // here would be presenting a template as an AI answer.
        return {
          kind: 'abstain', text: null, sources: [], context: '',
          attempts: 0, guardFailed: false, abstained: true,
          reason: `retrieval below the gate (top score ${found.hits[0]?.score ?? 0} < ${minScore})`,
          hits: found.hits, ms: Date.now() - started,
        };
      }

      asks += 1;
      const context = found.context;
      let streamed = false;
      const generate = async (ctx, { greedy } = {}) => {
        const summary = await session.generate({
          question, context: ctx, history, rules: persona,
          maxNewTokens, paceMs: greedy ? 0 : paceMs,
        }, {
          signal,
          // Streaming only happens for the FIRST attempt. A guard failure
          // replaces the bubble's text, which is why `onReplace` exists —
          // painting tokens that are then retracted silently would be worse
          // than not streaming at all.
          onToken: streamed ? null : (text) => { streamed = true; onToken?.(text); },
        });
        lastSummary = summary;
        return { text: summary.text };
      };

      const guarded = await guardedAnswer({
        generate,
        fallback: () => (quick?.text ?? ''),
        context, lang, kb,
      });

      if (guarded.fallback || guarded.guardFailed) {
        guardFailures += guarded.guardFailed ? 1 : 0;
        const text = quick?.text ?? '';
        if (streamed && onReplace) onReplace(text);
        return {
          kind: guarded.guardFailed ? 'abstain' : 'fallback',
          text, sources: quick?.sources || [], context,
          attempts: guarded.attempts, guardFailed: guarded.guardFailed,
          abstained: guarded.guardFailed,
          violations: guarded.violations,
          reason: guarded.guardFailed
            ? 'the guard rejected both attempts and the knowledge base has no exact answer'
            : 'the guard rejected the model’s text; showing the portfolio’s own words',
          ms: Date.now() - started,
        };
      }

      if (lastSummary?.abstained && !guarded.text.trim()) {
        return {
          kind: 'abstain', text: null, sources: [], context,
          attempts: guarded.attempts, guardFailed: false, abstained: true,
          reason: 'the model chose <|abstain|>', ms: Date.now() - started,
        };
      }

      // Placeholders → allowlisted values. `unresolved` is a guard failure by
      // construction (guard checks it first), so a non-empty list here would
      // mean the guard and this resolver disagree — say so rather than paint
      // an angle bracket at a visitor.
      const resolved = resolveFacts(kb, guarded.text, lang);
      if (resolved.unresolved.length) {
        onNotice?.(`the model emitted an unresolved placeholder: ${resolved.unresolved.join(', ')}`);
        const text = quick?.text ?? '';
        if (streamed && onReplace) onReplace(text);
        return {
          kind: 'fallback', text, sources: quick?.sources || [], context,
          attempts: guarded.attempts + 1, guardFailed: true, abstained: false,
          reason: 'an unresolved placeholder reached the resolver', ms: Date.now() - started,
        };
      }

      return {
        kind: 'model', text: resolved.text, sources: found.hits.map((h) => h.id),
        context, attempts: guarded.attempts, guardFailed: false, abstained: false,
        tokens: lastSummary?.tokens, stopReason: lastSummary?.stopReason,
        ms: Date.now() - started,
      };
    },
  };
}
