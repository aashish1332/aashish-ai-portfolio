/* ═══════════════════════════════════════════════════════════════
   ai/answers/model.mjs — the answer path. There is only one.

   1. **Retrieve** (§8.2). Below the calibrated gate there is nothing to
      ground on, so the model is never asked and the panel says so. That is
      the §8.4 layer-1 decision — the honest answer is "I don't have that" —
      made *before* a token is generated, because a model asked a question
      its context cannot answer only has making something up left to do.
   2. **Ask the model** — its own vocabulary, its own weights, greedy, in a
      worker (`ai/engine/session.mjs`). No template is consulted for prose.
   3. **Guard** (§8.4 layer 4), with one greedy retry over a shortened
      context. If both attempts fail, the model made no claim and the panel
      says that — it does **not** fall back to a template answer.
   4. **Resolve placeholders** to allowlisted values (`<|fact:x|>`), which
      is the only way a URL or an email ever reaches the screen (§7.2).

   ### Why there is no extractive fallback any more

   §5.1 step 5 used to end at a Quick Answer: a template built from
   `knowledge.json`, grounded by construction. The owner retired it. A
   canned sentence presented in the same bubble as a generated one teaches a
   visitor nothing about which they are reading, and the whole point of the
   panel is that the answer is the model's own. So every string this module
   returns is one of exactly three things:

     * the model's text, guard-checked (`kind: 'model'`),
     * the localized sentence that says the model could not verify its own
       answer (`kind: 'unverified'`),
     * the localized sentence that says the portfolio has nothing to answer
       with (`kind: 'notFound'`).

   The second and third assert nothing about Aashish, which is what makes
   them safe to fix as constants. `NO_ANSWER_KINDS` below is the whole list.
   ═══════════════════════════════════════════════════════════════ */

import { guardedAnswer } from '../guard/index.mjs';
import { buildIndex, search, MIN_TOP_SCORE } from '../retrieval/index.mjs';
import { abstainFor } from '../intent/rules.mjs';
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
    en: "That detail isn't published, so I won't answer with it — ask me for my email instead.",
    hi: 'वह विवरण सार्वजनिक नहीं है, इसलिए मैं उससे जवाब नहीं दूँगा — मेरा ईमेल पूछ सकते हैं।',
    hinglish: 'Wo detail publish nahi hai, isliye main usse jawab nahi dunga — mera email pooch sakte hain.',
  },
  unverified: {
    en: "I couldn't answer that from my portfolio data without guessing, so I'm not answering it.",
    hi: 'यह सवाल मैं अपने पोर्टफोलियो डेटा से अंदाज़ा लगाए बिना जवाब नहीं दे सका, इसलिए जवाब नहीं दे रहा हूँ।',
    hinglish: 'Ye sawaal main apne portfolio data se andaaza lagaye bina jawab nahi de saka, isliye jawab nahi de raha hoon.',
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
 * covered by nothing at all. That is how two of §6.3's rungs ended up matching
 * a key that did not exist and silently doing nothing (see
 * `ai/ui/chat.mjs`). A decision with six outcomes and three safety rules
 * deserves to be a value, not a paragraph.
 *
 * Three outcomes short-circuit before the model, and **none of them is an
 * answer**:
 *
 *  · `safety` — an attempt to change the instructions (§9). Never reaches the
 *    generator, and its text is a fixed reply, not a portfolio claim.
 *  · `no-data` — a question that presumes something the CV does not have
 *    (§14's adversarial set). This one *must* be decided here: the invented
 *    thing is an employer, and the guard checks named entities against the
 *    knowledge base's own vocabulary — which never contains one, so §8.4
 *    could not catch it. Nothing after this point can.
 *  · `withheld` — a field the base marks `public:false`. Declined, not
 *    answered around.
 *
 * `disclosure` is the fourth fixed reply and the only other one, for the same
 * reason as `safety`: "are you Aashish?" asks about the *assistant*, and the
 * answer is a statement about what this thing is. A generated sentence could
 * answer it falsely — claim to be a person — and no check in §8.4 could tell,
 * because the guard grounds claims about Aashish, not claims about the thing
 * making them. It is a disclosure, not a portfolio answer, so it is fixed.
 *
 * @param {object} opts
 * @param {object} opts.res            a `quickAnswer()` result
 * @param {boolean} opts.hasModel      an answerer that is loaded and ready
 * @param {string} [opts.modelState]   idle | loading | ready | unsupported | error
 * @param {boolean} [opts.generationStopped] §6.3's last rung has fired
 * @param {'en'|'hi'|'hinglish'} [opts.lang]
 * @returns {{path:'safety'|'disclosure'|'no-data'|'withheld'|'no-model'|'model',
 *            kind:string, noAnswer?:string}}
 */
export function routeQuestion({
  res, hasModel, modelState = 'idle', generationStopped = false, lang = 'en',
} = {}) {
  if (res?.injection) return { path: 'safety', kind: 'safety' };
  if (res?.intent === 'meta') return { path: 'disclosure', kind: 'disclosure' };
  if (res?.intent === 'hallucination_bait') {
    return { path: 'no-data', kind: 'no-answer', noAnswer: noAnswerLine('notFound', lang) };
  }
  if (res?.private) {
    return { path: 'withheld', kind: 'no-answer', noAnswer: noAnswerLine('withheld', lang) };
  }
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
    kb, session, persona = DEFAULT_PERSONA, history = [],
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
     * Every return has a `text` the caller may render: the model's own when it
     * produced a verified answer, and a localized refusal when it could not.
     * There is no third case where a template stands in for the model.
     *
     * @returns {Promise<{kind:'model'|'notFound'|'unverified', text:string,
     *   sources:string[], context:string, attempts:number, guardFailed:boolean,
     *   abstained:boolean, reason?:string, ms:number}>}
     */
    async ask({
      question, lang = 'en', focus = null, intentIds = null, contextless = false,
      onToken = null, onReplace = null, signal = null,
    }) {
      const started = Date.now();
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
      if (!hits.length && intentIds?.length) {
        const ids = intentIds.filter((id) => renderFact(kb, id, lang)).slice(0, MAX_INTENT_FACTS);
        if (ids.length) {
          hits = ids.map((id) => ({ id, kind: 'intent', label: id, score: 0 }));
          context = contextLines(kb, hits);
          how = 'intent';
        }
      }

      /* §8.4 layer 1 — the gate. It is "retrieval produced something to read",
         not the calibrated score floor, and on the evaluation corpus the two
         are provably the same SET: 13 of 60 cases sit below the floor and all
         13 have zero hits, so nothing is loosened by stating it this way (worth
         pinning — see `tests/retrieval.test.mjs`). What IS gained is the case
         above: facts that retrieval could not reach because the question had no
         query left in it.

         `contextless` is for the one topic the frame's own RULES answer with no
         facts at all — a greeting. Asking the model is the point; the guard
         still runs against an empty context, so nothing can be asserted. */
      if (!hits.length && !contextless) {
        return {
          kind: 'notFound', text: noAnswerLine('notFound', lang), sources: [], context: '',
          attempts: 0, guardFailed: false, abstained: true,
          reason: `retrieval found nothing to read (top score ${found.hits[0]?.score ?? 0}, floor ${minScore})`,
          hits: found.hits, ms: Date.now() - started,
        };
      }

      asks += 1;
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
        /* `context` goes back to the guard, which checks the claims against
           what the model READ — the engine trims the tail to fit the window
           and reports the trimmed string. Omitting it would let a dropped
           line ground a claim. */
        return { text: summary.text, context: summary.context };
      };

      /* No `fallback`. There is no template answer to fall back to, so a
         double guard failure arrives as `guardFailed` and becomes a refusal.
         Passing a template here is what made "the guard rejected this" look
         like "the portfolio answered" (§15.5). */
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

      // Placeholders → allowlisted values. `unresolved` is a guard failure by
      // construction (guard checks it first), so a non-empty list here would
      // mean the guard and this resolver disagree — say so rather than paint
      // an angle bracket at a visitor.
      const resolved = resolveFacts(kb, guarded.text, lang);
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
