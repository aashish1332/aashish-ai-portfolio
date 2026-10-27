/* ═══════════════════════════════════════════════════════════════
   ai/answers/model.mjs — the answer path. ONE tier: the model.

   (Owner decision, 2026-10-14: 100% pure AI. The data-file wording, the
   deterministic list answerer and every pre-model refusal are gone. Every
   question — safety, identity, adversarial bait, withheld fields, lists,
   small talk — is put to the on-device model, whose trained refusal and
   abstention behavior speaks it in its own words.)

   1. **Retrieve** (§8.2) — the model is given only what the portfolio
      publishes, because a model that can read a withheld value has a way
      to leak it (`renderFact` filters `public:false`, §8.1).
   2. **Ask the model** — its own vocabulary, its own weights, greedy, in a
      worker (`ai/engine/session.mjs`). No template is consulted for prose,
      and there is no refusal anymore that the model does not speak.
   3. **Guard** (§8.4 layer 4), with one greedy retry over a shortened
      context. If both attempts fail, the model made no claim and the panel
      says that — it does **not** fall back to a template answer.
   4. **Resolve placeholders** to allowlisted values (`<|fact:x|>`), which
      is the only way a URL or an email ever reaches the screen (§7.2).

   What this contract costs, told honestly: the model's refusals are now
   its own sentences, so an untrained checkpoint can phrase them badly —
   the guard and the `<|abstain|>` token are what keep it from asserting a
   fact. Every generated claim is still verified against exactly the
   context the model read; nothing else about §8.4 changed. The only text
   in this module that is not the model's own is the `NO_ANSWER_KINDS`
   table, used only when the model produced NOTHING to keep (an abstention
   token, or a double guard failure) — a refusal the model never wrote
   cannot wear the AI-ANSWER badge.
   ═══════════════════════════════════════════════════════════════ */

import { clipToGroundedSentences, guardedAnswer } from '../guard/index.mjs';
import { buildIndex, search, MIN_TOP_SCORE } from '../retrieval/index.mjs';
import { abstainFor } from '../intent/rules.mjs';
import { emptySlotFrame } from '../engine/grammar.mjs';
import { contextSizer, DEFAULT_PERSONA, resolveFacts, renderFact } from './quick.mjs';

/* ── how many facts the intent fallback may paste ────────────────
   §8.2's budget is "top-k ≤ 3 chunks, ≤ ~300 tokens", and retrieval keeps it.
   The intent fallback below is the one path whose "top-k" is a *topic's whole
   fact list* instead of a BM25 ranking, and it had no cap at all: "what are
   his skills?" handed the model 38 facts and a 764-token prompt, against a
   512-token window.

   MEASURED with the shipping tokenizer (`npm run probe:tokens`): 18 skill
   lines fit in the window alongside the frame, a typical question and 96 new
   tokens. 12 is that measurement with headroom, because a conversation turn
   or two (`history`) also lives in the prompt and a budget that only just
   fits is a budget that fails the moment anything is added. */
export const MAX_INTENT_FACTS = 12;

/* ── the plans whose answer is a WHOLE KIND, not one fact ────────
   §8.2's budget is top-3 chunks, and a plural question's correct answer is
   every fact of one kind: "Which databases does he use?" is answered by all
   five database skills. Three BM25 chunks cannot carry five, and the 2026-10-24
   §14 sweep is what that costs — d05 was asked against a context holding
   `[skill.mysql] MySQL` and `[skill.mongoose] Mongoose` while the case expects
   five ids, so no answer, however well trained, could score above 2/5.

   Measured, the same sweep: of the 8 plural cases, 54% of expected ids were in
   the top 3 and only 25% of the cases had all of them there — at k=5 that
   rises to 75%/63%. So the ceiling here is the CONTEXT, not the model.

   `quickAnswer()` already knows the exact set: its plan for these intents is
   `{kind, ids}` over the whole kind (`skills` filtered to the category the
   visitor named, `list_projects`, `certifications`, …). This module had that
   set in hand and used it only when BM25 returned nothing. For these plans the
   plan's own facts ARE the scope of the question, so they are the context —
   capped by `MAX_INTENT_FACTS`, which is the window's bound, not a taste. */
export const WHOLE_KIND_PLANS = new Set([
  'skills', 'list_projects', 'certifications', 'achievements', 'experience',
  'education', 'contact_links', 'contact_all',
]);

/** Does this intent plan's fact set scope the answer (§8.2 / §7.4)? */
export function intentScopesContext(plan) {
  return !!plan && WHOLE_KIND_PLANS.has(plan.kind);
}

/* ── plans whose context is exactly their own source list ─────────

   A whole-kind plan is not the only one whose fact set IS the question's
   scope. An identity turn is trained with `[person.name]` and nothing else —
   every meta example in ai/data/instruction.py is built with
   `build_context(f, ["person.name"])` — and its answer is the same fixed
   disclosure whatever else the retrieval happened to score.

   MEASURED 2026-10-27 on the sft8 export: "are you Aashish?" reached the model
   with three lines (name, GitHub link, how-he-builds) and it answered
   `Unka tareeka: <|fact:workflow.how-he-builds|>` — a Hinglish list sentence to
   an English identity question. The same checkpoint answers the disclosure on
   all four phrasings when it is given the frame training gave it: the name
   line alone. So the drift was the context, not the weights.

   `greeting` is not here: it already carries `person.name` alone because its
   question has no content token for BM25 to match, and widening it is the
   defect the 2026-10-17 note in `quick.mjs` records. */
export const PINNED_CONTEXT_PLANS = new Set(['meta']);

/** Is this plan's source list the whole context, whatever retrieval found? */
export function planPinsContext(plan) {
  return !!plan && PINNED_CONTEXT_PLANS.has(plan.kind);
}

/* ── which turns may be decoded against the closed answer space ───
   `ai/engine/grammar.mjs` can constrain a turn to the sentences the model was
   trained to say about the facts it was given. That is right for a question
   ABOUT a fact, and wrong for the turns whose answer is not one: a greeting, a
   "who are you", an off-topic question, or a bait — all of those have their own
   trained shapes (a claim-free line, `<|abstain|>`), and forcing them into a
   fact sentence would answer a different question than the visitor asked.

   `hallucination_bait` is open on purpose: its correct answer is a refusal, and
   a closed grammar would hand it a legal fact sentence instead of the abstain it
   should prefer — the bait class is measured (b01/b02/b03/b05) and this change
   must not move it.

   `plan === null` is open too: no intent matched, so there is no evidence the
   question is about a fact, and `contact_withheld` stays closed because its
   context is empty — the grammar then admits nothing but `<|abstain|>`, which is
   exactly what a withheld field must produce (§8.1). */
const OPEN_ANSWER_PLANS = new Set(['greeting', 'meta', 'abstain', 'hallucination_bait']);

export function wantsClosedAnswer(plan) {
  return Boolean(plan) && !OPEN_ANSWER_PLANS.has(plan.kind);
}

/** The fact ids a context actually names, in order. The engine may DROP lines
 *  to fit the model's window, so the ids a visitor is shown as "where this
 *  came from" must come from the context that was read, not from the list
 *  that was offered — otherwise the panel credits the model with evidence it
 *  never saw (§12's anchors rest on this). */
export function idsInContext(context) {
  const out = [];
  for (const m of String(context ?? '').matchAll(/^\[([^\]]+)\]/gm)) out.push(m[1]);
  return out;
}

export const MODEL_BADGES = Object.freeze({
  model: 'AI ANSWER · ON-DEVICE MODEL',
  notFound: 'NO ANSWER · NOT IN THE PORTFOLIO',
  unverified: 'NO ANSWER · COULD NOT VERIFY IT',
  withheld: 'NO ANSWER · NOT PUBLISHED',
  noModel: 'NO ANSWER · NO AI MODEL ON THIS DEVICE',
  /* §10's Stop. The one badge that is neither an answer nor a refusal: the
     text is the model's own, it is unfinished, and the guard never saw it,
     because the guard runs when generation ENDS. It therefore may not carry
     the verification the `model` badge carries — hence a third shape rather
     than either of the two. `tests/model-answers.test.mjs` MODEL-9 holds
     that line. */
  partial: 'PARTIAL ANSWER · STOPPED BY YOU',
});

/* ── the sentences that are not answers (§15.5) ─────────────────
   Every one of these is a refusal, and a refusal is the one kind of line a
   fixed string can honestly be: it claims nothing about Aashish, so it
   cannot be wrong about him. They are localized because a visitor who asks
   in Hindi must not be told, in English, that there is no answer. */
const NO_ANSWER_TEXT = {
  withheld: {
    en: "That detail isn't published, so I won't answer with it — ask me for his email instead.",
    hi: 'वह विवरण सार्वजनिक नहीं है, इसलिए मैं उससे जवाब नहीं दूँगा — उनका ईमेल पूछ सकते हैं।',
    hinglish: 'Wo detail publish nahi hai, isliye main usse jawab nahi dunga — unka email pooch sakte hain.',
  },
  unverified: {
    en: "I couldn't answer that from his portfolio data without guessing, so I'm not answering it.",
    hi: 'यह सवाल मैं उनके पोर्टफोलियो डेटा से अंदाज़ा लगाए बिना जवाब नहीं दे सका, इसलिए जवाब नहीं दे रहा हूँ।',
    hinglish: 'Ye sawaal main unke portfolio data se andaaza lagaye bina jawab nahi de saka, isliye jawab nahi de raha hoon.',
  },
  unsupported: {
    en: 'This device cannot run the on-device AI model, so I cannot answer questions here. '
      + 'Nothing was sent anywhere — there is simply no model on this machine.',
    hi: 'यह डिवाइस ऑन-डिवाइस AI मॉडल नहीं चला सकता, इसलिए यहाँ मैं सवालों के जवाब नहीं दे सकता। '
      + 'कुछ भी कहीं भेजा नहीं गया — इस मशीन पर कोई मॉडल ही नहीं है।',
    hinglish: 'Ye device on-device AI model nahi chala sakta, isliye yahan main sawaalon ke jawab nahi de sakta. '
      + 'Kahin kuch bheja nahi gaya — is machine par koi model hi nahi hai.',
  },
  loading: {
    en: "The on-device model is still getting ready. Ask again in a moment and I'll answer.",
    hi: 'ऑन-डिवाइस मॉडल अभी तैयार हो रहा है। थोड़ी देर में फिर पूछिए, मैं जवाब दूँगा।',
    hinglish: 'On-device model abhi taiyaar ho raha hai. Thodi der mein phir poochiye, main jawab dunga.',
  },
  stopped: {
    en: "The on-device model stopped, so I can't answer right now. Reloading the page starts it again.",
    hi: 'ऑन-डिवाइस मॉडल रुक गया, इसलिए मैं अभी जवाब नहीं दे सकता। पेज रीलोड करने पर यह फिर शुरू हो जाएगा।',
    hinglish: 'On-device model ruk gaya, isliye main abhi jawab nahi de sakta. Page reload karne par ye phir shuru ho jayega.',
  },
  strained: {
    en: "This device is struggling to render the page, so I've stopped generating answers for now. "
      + 'They come back when it recovers.',
    hi: 'यह डिवाइस पेज रेंडर करने में जूझ रहा है, इसलिए मैंने अभी जवाब देना बंद कर दिया है। '
      + 'ठीक होने पर वे वापस आ जाएँगे।',
    hinglish: 'Ye device page render karne mein struggle kar raha hai, isliye maine abhi jawab dena band kar diya hai. '
      + 'Theek hone par wapas aa jayenge.',
  },
  /* §10's Stop, pressed before the first token arrived: there is no partial to
     keep, and telling the visitor "the model stopped" would be a lie about the
     machine in response to their own click. */
  cancelled: {
    en: 'Stopped before I had written anything. Ask again whenever you like.',
    hi: 'कुछ लिखने से पहले ही रोक दिया गया। जब चाहें फिर पूछ सकते हैं।',
    hinglish: 'Kuch likhne se pehle hi rok diya gaya. Jab chahein phir pooch sakte hain.',
  },
};

/** Every way this build can decline to answer, as data, so the caller and the
 *  tests name them identically and no translation can be forgotten. */
export const NO_ANSWER_KINDS = Object.freeze([
  'notFound', 'withheld', 'unverified', 'unsupported', 'loading', 'stopped', 'strained',
  'cancelled',
]);

/**
 * The localized sentence for a refusal.
 * @param {'notFound'|'withheld'|'unverified'|'unsupported'|'loading'|'stopped'|'strained'} kind
 * @param {'en'|'hi'|'hinglish'} [lang]
 */
export function noAnswerLine(kind, lang = 'en') {
  /* "not in the portfolio" already has one wording and one owner (§8.4's
     abstention), and a second copy here would be a second thing to keep in
     three languages. */
  if (kind === 'notFound') return abstainFor(lang);
  const table = NO_ANSWER_TEXT[kind];
  if (!table) throw new Error(`unknown no-answer kind: ${kind}`);
  return table[lang] || table.en;
}

/** The context the model reads: `[id] value`, exactly the layout
 *  `ai/data/instruction.py` trains on. One line per retrieved fact, in
 *  retrieval order, deduplicated, newest-first trimmed by the caller's k. */
/**
 * What a stopped answer shows (§10's Stop), as a pure function.
 *
 * Two things normally happen to a stream that will never happen here: the
 * guard does not run (it runs when generation *ends* — that is how it can
 * check the finished text) and neither does the placeholder resolver at the
 * end of `ask()`. So this resolves placeholders itself and drops the one that
 * was cut in half, because a partial `<|fact:em` on screen is an angle bracket
 * shown to a visitor.
 *
 * Nothing painted yet — Stop during prefill, which is most of the wait — is the
 * `cancelled` line, not a partial: there is nothing to keep, and "the model
 * stopped" would blame the machine for the visitor's own click.
 *
 * Pure, so the awkward half is testable without a DOM or a checkpoint: the
 * shell only decides *when* to call it (see `presentPartial` in
 * `ai/ui/chat.mjs`).
 */
export function partialAnswer(kb, text, lang = 'en') {
  const kept = resolveFacts(kb, String(text ?? ''), lang).text
    .replace(/<\|[^|]*$/, '').trim();
  return kept || noAnswerLine('cancelled', lang);
}

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
 * §5.1's routing decision — which path a question takes — as a pure function.
 *
 * It is pure so it can be *tested*: the same decision used to be an inline
 * `if` chain in the chat shell, which needs a DOM to exercise and so was
 * covered by nothing at all (see `ai/ui/chat.mjs`).
 *
 * It has ONE outcome short-circuiting before the model, and it is **not an
 * answer**: `no-model` — the device cannot run the model right now
 * (loading, unsupported, the worker died, or §6.3's last rung stopped
 * generation). That is a fact about the machine, not a portfolio claim, so
 * it stays a fixed sentence.
 *
 * Everything ELSE goes to the model, 100% pure AI (owner decision,
 * 2026-10-14): prompt-injection attempts (§9), "are you Aashish?",
 * §14's invented-employer bait, questions about a `public:false` field —
 * all are put to the model in the normal frame, and its trained refusal
 * and `<|abstain|>` behavior speaks them in its own words. The guard still
 * rejects every claim that does not ground in what the model read, which
 * is what stops a bait question from being answered with an invented
 * employer even though nothing refuses before a token exists.
 *
 * @param {object} opts
 * @param {object} opts.res            a `quickAnswer()` result (kept in the
 *                                     signature so callers and probes keep
 *                                     passing the same object)
 * @param {boolean} opts.hasModel      an answerer that is loaded and ready
 * @param {string} [opts.modelState]   idle | loading | ready | unsupported | error
 * @param {boolean} [opts.generationStopped] §6.3's last rung has fired
 * @param {'en'|'hi'|'hinglish'} [opts.lang]
 * @returns {{path:'no-model'|'model', kind:string, noAnswer?:string}}
 */
export function routeQuestion({
  hasModel, modelState = 'idle', generationStopped = false, lang = 'en',
} = {}) {
  if (generationStopped || !hasModel) {
    const why = generationStopped ? 'strained'
      : modelState === 'unsupported' ? 'unsupported'
        : modelState === 'error' ? 'stopped' : 'loading';
    return { path: 'no-model', kind: 'no-model', noAnswer: noAnswerLine(why, lang) };
  }
  return { path: 'model', kind: 'model' };
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
    kb, session, persona = DEFAULT_PERSONA,
    /* The whole conversation a shell wants the model to see, oldest first.
       Overridden per call by `ask({ history })` — the shell keeps the turns,
       the answerer only carries a default (tests pass none). */
    history: defaultHistory = [],
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
      const sizeOf = contextSizer(kb);
      const found = search(indexOf(), question, { minScore, focus, sizeOf });
      /* A hit that renders to nothing is not evidence. The index carries every
         fact, including `public:false` ones (§8.1), and a chunk priced at zero
         tokens would otherwise be admitted for free and counted as "something
         to read" while contributing no line to the context the model sees. */
      const hits = found.hits.filter((h) => sizeOf(h) > 0);
      return {
        ...found, hits,
        tokensUsed: hits.reduce((n, h) => n + sizeOf(h), 0),
        context: contextLines(kb, hits),
      };
    },

    /**
     * Every return has a `text` the caller may render: the model's own when
     * it produced a verified answer, and a localized sentence when the model
     * produced nothing that could be kept (an abstention, or a double guard
     * failure). 100% pure AI per the owner's 2026-10-14 decision: there is
     * no planner, no data-file wording and no pre-model refusal anymore —
     * EVERY question reaches the model, even with an empty retrieval, and
     * the guard still grounds every claim against what the model read.
     *
     * @param {Array<[string,string]>} [opts.history] the conversation so far,
     *  oldest first — the engine's frame carries it (`ai/engine/prompt.mjs`)
     *  and `fitToBudget` trims it, so follow-ups ("come again", "his age"?
     *  after "how old is he"? — anything referencing the last turn) are
     *  answered from what was ALREADY said, not re-retrieved from scratch.
     *
     * @returns {Promise<{kind:'model'|'notFound'|'unverified',
     *   text:string, sources:string[], context:string, attempts:number,
     *   guardFailed:boolean, abstained:boolean, reason?:string, ms:number}>}
     */
    async ask({
      question, lang = 'en', focus = null, intentIds = null, plan = null,
      history = null, onToken = null, onReplace = null, signal = null,
    }) {
      const started = Date.now();
      const turns = history ?? defaultHistory;

      const found = this.retrieve(question, focus);

      /* §8.2's retrieval can find NOTHING for a question whose topic the intent
         rules have already identified — and the flagship example is the most
         common question a recruiter asks. `skills` is in the retrieval stop set
         on purpose (it appears in every skill chunk and used to hijack the
         score), so "what are his skills?" is left with no content tokens at all
         and BM25 returns an empty list. The facts are not missing; the QUERY is.
         So when retrieval comes back empty, the topic's own facts are read
         instead of refusing a question the portfolio answers in full.

         `renderFact` is the filter, exactly as in `contextLines`: an id that is
         unknown or `public:false` renders as nothing and is dropped here, so a
         withheld value cannot arrive through this door (§8.1).

         And `MAX_INTENT_FACTS` is the cap: this is a budget, so it has a
         bound, and the bound comes from the window rather than from taste. */
      let hits = found.hits;
      let context = found.context;
      let how = 'retrieval';
      /* Three reasons to read the topic's facts: retrieval found NOTHING (the
         stop set ate the query), the question is a whole-kind question and
         three chunks cannot hold its answer (`intentScopesContext`), or the
         plan is trained on one exact line and retrieval would widen it
         (`planPinsContext`). */
      if ((!hits.length || intentScopesContext(plan) || planPinsContext(plan))
          && intentIds?.length) {
        const ids = intentIds.filter((id) => renderFact(kb, id, lang)).slice(0, MAX_INTENT_FACTS);
        if (ids.length) {
          hits = ids.map((id) => ({ id, kind: 'intent', label: id, score: 0 }));
          context = contextLines(kb, hits);
          how = 'intent';
        }
      }

      /* The gate (§8.4 layer 1) is GONE. The model is asked even when the
         retrieval found nothing to read — a 100%-AI panel does not "decide
         before a token exists" (owner decision, 2026-10-14). The guard is
         the entire honesty mechanism now: with an empty context nothing can
         ground, so an inventive answer is rejected (`unverified`) and the
         trained `<|abstain|>` is read as the refusal it is (`notFound`).
         This is the sentence-level contract §8.4 kept: what the panel SHOWS
         is either the model's grounded words or the refusal for no words at
         all — the gate moved from before the model to after it. */

      asks += 1;
      let streamed = false;
      const generate = async (ctx, { greedy } = {}) => {
        const summary = await session.generate({
          question, context: ctx, history: turns, rules: persona,
          maxNewTokens, paceMs: greedy ? 0 : paceMs,
          /* Decided once per turn, from the intent — see `wantsClosedAnswer`.
             The engine reads the CONTEXT for which facts are on offer; this
             only says whether the closed space applies at all. */
          answerGrammar: wantsClosedAnswer(plan),
        }, {
          signal,
          // Streaming only happens for the FIRST attempt. A guard failure
          // replaces the bubble's text, which is why `onReplace` exists —
          // painting tokens that are then retracted silently would be worse
          // than not streaming at all.
          onToken: streamed ? null : (text) => { streamed = true; onToken?.(text); },
        });
        lastSummary = summary;
        /* `context` goes back to the guard, which checks the claims against
           what the model READ — the engine trims the tail to fit the window
           and reports the trimmed string. Omitting it would let a dropped
           line ground a claim. */
        /* §7.2's placeholder rule, APPLIED: the model was TRAINED to speak in
           `fact` tokens (`<|fact:edu.lpu|>` is token id 6 — writing numbers and
           named values token-by-token is the failure the mechanism exists to
           prevent), so an answer that leans on the mechanism arrives holding
           `<|fact:…|>` tokens. The guard's own contract says it sees the answer
           "AFTER placeholder resolution" (§8.4 step 6) — resolve HERE, where
           the summary lands, so a resolvable id renders to its public value
           and ONLY an id the app cannot render reaches the guard as
           unresolved. Resolving after the guard instead made every grounded
           placeholder-bearing answer mechanically fail: the greeting "I study
           at `<|fact:edu.lpu|>`" read the WHOLE education line, resolved to
           its public value — and was still refused because nobody resolved
           before the check. What the guard sees after this line is the same
           answer the visitor will read. */
        const resolvedText = resolveFacts(kb, summary.text ?? '').text;
        return { text: resolvedText, context: summary.context };
      };

      /* No `fallback`. There is no template answer to fall back to, so a
         double guard failure arrives as `guardFailed` and becomes a refusal.
         Passing a template here is what made "the guard rejected this" look
         like "the portfolio answered" (§15.5). */
      /* The §6.3 ladder's budget lives in `maxNewTokens`; the persona lives
         in the frame's RULES. */
      const guarded = await guardedAnswer({ generate, context, lang, kb });

      /* The model's own `<|abstain|>` is a DECISION, not a failed attempt, and
         it has to be read before the guard. `<|abstain|>` is stripped by
         `decode(..., {skipSpecial:true})`, so it arrives as an empty string —
         which the guard correctly reports as `empty_answer`, making the check
         below unreachable if it comes second. (It used to come second.) */
      if (lastSummary?.abstained) {
        const text = noAnswerLine('notFound', lang);
        if (streamed && onReplace) onReplace(text);
        return {
          kind: 'notFound', text, sources: [], context,
          attempts: guarded.attempts, guardFailed: false, abstained: true,
          reason: 'the model chose <|abstain|>', ms: Date.now() - started,
        };
      }

      if (guarded.guardFailed) {
        guardFailures += 1;
        const text = noAnswerLine('unverified', lang);
        /* The rejected text may already be on screen — it streams on the first
           attempt. Say the true thing over it rather than leaving it up. */
        if (streamed && onReplace) onReplace(text);
        return {
          kind: 'unverified', text, sources: [], context,
          attempts: guarded.attempts, guardFailed: true, abstained: true,
          violations: guarded.violations,
          reason: 'the guard rejected both attempts, and no template stands in for the model',
          ms: Date.now() - started,
        };
      }

      /* §8.4 companion (measured 2026-10-06, probe-selection-v8.txt): the
         model's commonest failing shape is the CORRECT answer followed by
         run-on template content. The guard rejects that whole text, but the
         failure is trailing — the longest sentence-prefix that grounds is
         the answer the model actually produced. Clip the tail when, and
         only when, the tail is what fails; a mid-answer fabrication yields
         no clean prefix and reaches the refusal path untrimmed. */
      const clip = clipToGroundedSentences(guarded.text, context, { kb, lang });
      if (clip.clipped) {
        onNotice?.('answer trimmed to its grounded part; the tail did not ground');
      }

      // Placeholders → allowlisted values. `unresolved` is a guard failure by
      // construction (guard checks it first), so a non-empty list here would
      // mean the guard and this resolver disagree — say so rather than paint
      // an angle bracket at a visitor.
      /* A trained FRAME with an EMPTY slot — MEASURED 2026-10-26 on the sft7
         export: §14's f06 ("and his 12th marks?") decoded `His CGPA is  .`.
         Neither defence could see it. The citation mask admits ordinary words,
         and the guard grounds CLAIMS, while a sentence whose slot is empty
         claims nothing — it passed every check and told the visitor nothing.

         Why it was reachable: the frame table had no sentence for `edu.kv2`,
         so `answerGrammar` returned null and the turn fell back to the mask.
         The sentence exists now (`_topic_class12` in ai/data/instruction.py),
         but the hole is structural — any fact the table cannot frame falls
         through it, and the synthetic §14 cases fall through it by design,
         because their fictional ids are not vocabulary tokens at all. So the
         turn is refused instead of shown, which is what §15.5 asks for: a
         sentence the app cannot check is not an answer. */
      const hollow = emptySlotFrame(clip.clipped ? clip.text : guarded.text);
      if (hollow) {
        onNotice?.(`the model wrote a frame with no fact in it: ${hollow}`);
        const text = noAnswerLine('unverified', lang);
        if (streamed && onReplace) onReplace(text);
        return {
          kind: 'unverified', text, sources: [], context,
          attempts: guarded.attempts, guardFailed: true, abstained: true,
          reason: `a frame with an empty slot is not an answer: ${hollow}`,
          ms: Date.now() - started,
        };
      }

      const resolved = resolveFacts(kb, clip.clipped ? clip.text : guarded.text, lang);
      if (resolved.unresolved.length) {
        /* The guard checks placeholders first, so reaching here means the
           guard and this resolver disagree. Say so, and refuse — an angle
           bracket on screen is not an answer. */
        onNotice?.(`the model emitted an unresolved placeholder: ${resolved.unresolved.join(', ')}`);
        const text = noAnswerLine('unverified', lang);
        if (streamed && onReplace) onReplace(text);
        return {
          kind: 'unverified', text, sources: [], context,
          attempts: guarded.attempts + 1, guardFailed: true, abstained: true,
          reason: 'an unresolved placeholder reached the resolver', ms: Date.now() - started,
        };
      }

      /* The context the model ACTUALLY read (`guarded.context`): the engine
         drops the tail of what it is offered to fit `max_position_embeddings`,
         and both the guard and the sources follow the trimmed form. */
      const read = guarded.context ?? context;
      return {
        kind: 'model', text: resolved.text, sources: idsInContext(read),
        context: read, contextFrom: how,
        attempts: guarded.attempts, guardFailed: false, abstained: false,
        tokens: lastSummary?.tokens, stopReason: lastSummary?.stopReason,
        droppedContextLines: lastSummary?.droppedContextLines ?? 0,
        ms: Date.now() - started,
      };
    },
  };
}
