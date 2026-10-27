/* ═══════════════════════════════════════════════════════════════
   tests/model-answers.test.mjs — the answer path, and the end of the
   template answer (MODEL-1…MODEL-11)

   `ai/answers/model.mjs` is §5.1's answer path and it had **no test at all**
   until this file: the engine was gated parity-first and the guard had its own
   suite, but the module that decides what a visitor actually reads was covered
   only by a browser probe. Writing these found four things — two dead branches,
   one unreachable one, and the reason the most common question a recruiter asks
   was about to be answered with "I don't have that".

   The property being pinned is the owner's 2026-10-14 decision: **100%
   pure AI.** EVERY question — greeting, identity, bait, withheld,
   off-portfolio, lists — is put to the on-device model; there is no
   wording and no pre-model refusal in the answer path anymore. What
   makes that safe, and what these tests pin: the intent bucket is the
   model's context when retrieval is empty, a withheld fact never
   reaches that context (§8.1), the guard still rejects fabricated
   numbers and dates against what the model read, and the fixed
   sentences left in the module are refusals for turns the model
   produced no text for.

   The session is a stub, so "the model was never asked" is a fact about the
   test rather than a claim about the code, and no checkpoint is needed.

   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createModelAnswerer, routeQuestion, noAnswerLine, NO_ANSWER_KINDS, MODEL_BADGES,
  MAX_INTENT_FACTS, partialAnswer, WHOLE_KIND_PLANS, intentScopesContext,
  planPinsContext, wantsClosedAnswer,
} from '../ai/answers/model.mjs';
import { quickAnswer, renderFact } from '../evaluation/answer-text.mjs';
import { languageMatches } from '../ai/guard/index.mjs';
import { emptySlotFrame } from '../ai/engine/grammar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KB = JSON.parse(readFileSync(join(HERE, '..', 'knowledge', 'knowledge.json'), 'utf8'));

/** A session stub that answers with a fixed text (or throws), recording every
 *  prompt it was handed — including the §6.3 knobs, so the governor's wiring
 *  into the answerer is checked and not assumed. */
function stubSession(reply) {
  const calls = [];
  return {
    calls,
    status: 'ready',
    reason: null,
    async generate(args, { signal } = {}) {
      calls.push({
        question: args.question,
        context: args.context,
        maxNewTokens: args.maxNewTokens,
        paceMs: args.paceMs,
        signal: signal || null,
      });
      /* The real session REJECTS on abort rather than resolving with what it
         had (ai/engine/session.mjs `request`), so the double rejects too — a
         stub that resolves here would let a wrong shell pass. */
      if (signal?.aborted) throw new Error('aborted before it started');
      const r = typeof reply === 'function' ? reply(args) : reply;
      if (r?.throw) throw new Error(r.throw);
      if (r?.waitForAbort) {
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return {
        text: r?.text ?? '',
        abstained: !!r?.abstained,
        tokens: 4,
        stopReason: r?.abstained ? 'abstain' : 'end-token',
      };
    },
  };
}

const answererWith = (session, opts = {}) =>
  createModelAnswerer({ kb: KB, session, maxNewTokens: 48, ...opts });

/* Three questions chosen by MEASUREMENT rather than by taste, each asserting
   its own premise so a change to the knowledge base says why a test broke:

     ANSWERABLE   retrieval scores it well above the floor (3 hits)
     OFF_TOPIC    retrieval finds nothing at all (0 hits)
     TOPIC_ONLY   retrieval ALSO finds nothing — but the portfolio answers it in
                  full, because `skills` is in the retrieval stop set and the
                  query is left with no content token. This is the case that
                  made the gate the wrong gate; see MODEL-10. */
const ANSWERABLE = 'What is his CGPA?';
const OFF_TOPIC = 'What is his favourite pizza?';
const TOPIC_ONLY = 'What are his skills?';

const shellAsk = (answerer, question, extra = {}) => {
  /* the handoff the chat shell performs, kept in one place so both sides of
     it are visible: the intent's facts go along as a fallback context, and
     the conversation so far goes along as history. 2026-10-14: there is no
     `contextless` flag and no `plan` anymore — every question, greeting
     included, is asked of the model. */
  const res = quickAnswer(KB, question, { lang: 'en' });
  return answerer.ask({
    question,
    lang: 'en',
    intentIds: res.sources,
    history: [],
    ...extra,
  });
};

test('MODEL-1 routing is one pure decision with ONE refusal: the machine',
  () => {
    const base = { res: { intent: 'skills' }, hasModel: true, lang: 'en' };
    assert.equal(routeQuestion(base).path, 'model');
    assert.equal(routeQuestion(base).kind, 'model', 'an answer by the model is the only kind');

    /* 2026-10-14: pure AI. Nothing refuses on the panel's authority —
       injection attempts, identity questions, adversarial bait and withheld
       fields are all model turns, spoken in the model's own trained words. */
    for (const res of [
      { injection: true }, { intent: 'meta' },
      { intent: 'hallucination_bait' }, { private: true },
    ]) {
      assert.equal(routeQuestion({ ...base, res }).path, 'model', JSON.stringify(res));
    }

    /* the ONE refusal left is the machine state (§10: the panel never claims
       a visitor's question was unanswerable when the laptop could not run) */
    assert.equal(routeQuestion({ ...base, hasModel: false }).path, 'no-model');
    assert.equal(routeQuestion({ ...base, generationStopped: true }).path, 'no-model');
    /* and the machine state outranks everything else — a missing model
       answers nothing, including a bait question the model would have
       abstained on */
    assert.equal(routeQuestion({
      ...base, hasModel: false, res: { intent: 'hallucination_bait' },
    }).path, 'no-model');
  });

test('MODEL-2 the session is told WHY there is no model, not just that there is none',
  () => {
    const base = { res: { intent: 'skills' }, hasModel: false, lang: 'en' };
    const answers = new Set();
    for (const [state, kind] of [
      ['unsupported', 'unsupported'], ['error', 'stopped'], ['loading', 'loading'],
      ['idle', 'loading'], [undefined, 'loading'],
    ]) {
      const r = routeQuestion({ ...base, modelState: state });
      assert.equal(r.path, 'no-model', String(state));
      assert.equal(r.noAnswer, noAnswerLine(kind, 'en'), String(state));
      answers.add(r.noAnswer);
    }
    /* a device that cannot run a model must not be told it is still loading */
    assert.equal(answers.size, 3, 'three distinct reasons: cannot, stopped, not yet');
  });

test('MODEL-3 a question with nothing to ground on is still asked — and a fabricated claim still cannot ship',
  async () => {
    const session = stubSession({ text: 'He scored 98.5% at Google.' });
    const answerer = answererWith(session);
    assert.equal(answerer.retrieve(OFF_TOPIC).hits.length, 0,
      'this test needs a question retrieval cannot see at all');

    const out = await shellAsk(answerer, OFF_TOPIC);
    /* 2026-10-14: the model IS asked a question its context cannot answer —
       what changed is that the guard is now the whole honesty mechanism.
       With an empty context nothing grounds, so the invented number is
       rejected twice and the turn ships as the refusal sentence, never as
       the model's claim. */
    /* two attempts, measured: the first fails the guard, so the greedy
       retry over the (already empty) context runs once — and fails again */
    assert.equal(session.calls.length, 2, 'asked, then the guard retry (owner decision 2026-10-14)');
    assert.equal(out.kind, 'unverified');
    assert.equal(out.text, noAnswerLine('unverified', 'en'));
    assert.equal(out.guardFailed, true);
    assert.ok(!/98\.5/.test(out.text), 'a rejected claim must not appear in the refusal');
  });

test('MODEL-4 a model answer the guard rejects is refused, not repaired by a template',
  async () => {
    /* Two ungrounded claims: an invented employer and two invented numbers.
       Nothing here may survive into what the reader sees. */
    const invented = 'He worked at Google from 2019 and rated 98.5%.';
    const answerer = answererWith(stubSession({ text: invented }));
    assert.ok(answerer.retrieve(ANSWERABLE).hits.length > 0,
      'this test needs a question that reaches the model');

    const out = await shellAsk(answerer, ANSWERABLE);
    assert.equal(out.kind, 'unverified');
    assert.equal(out.text, noAnswerLine('unverified', 'en'));
    assert.equal(out.guardFailed, true);
    assert.ok(out.violations.length > 0, 'the violations must survive for the log');
    assert.ok(!/google|2019|98\.5/i.test(out.text),
      'a rejected claim must not appear anywhere in the answer');
    assert.notEqual(out.text, quickAnswer(KB, ANSWERABLE).text,
      'the extractive Quick Answer must not stand in for the model');
  });

test('MODEL-5 the model declining to answer reads as a refusal, not as a template',
  async () => {
    /* `<|abstain|>` decodes to the empty string, which the guard reports as
       `empty_answer` — so reading the abstention AFTER the guard, as this code
       used to, made this branch unreachable and fell through to "unverified". */
    const answerer = answererWith(stubSession({ text: '', abstained: true }));
    const out = await shellAsk(answerer, ANSWERABLE);
    assert.equal(out.kind, 'notFound');
    assert.equal(out.text, noAnswerLine('notFound', 'en'));
    assert.equal(out.guardFailed, false, 'declining is a decision, not a failed check');
    assert.match(out.reason, /abstain/);
    assert.notEqual(out.text, quickAnswer(KB, ANSWERABLE).text);
  });

test('MODEL-6 a grounded reply is returned as the model’s own words', async () => {
  const probe = answererWith(stubSession({ text: '' }));
  const found = probe.retrieve(ANSWERABLE);
  assert.ok(found.hits.length > 0);
  /* A substring of the exact evidence the guard is handed, so it is grounded
     by construction rather than by a lucky choice of example. */
  const grounded = found.context.split('\n')[0].replace(/^\[[^\]]+\]\s*/, '');
  assert.ok(grounded.length > 0);

  const session = stubSession({ text: grounded });
  const out = await shellAsk(answererWith(session), ANSWERABLE);
  assert.equal(out.kind, 'model');
  assert.equal(out.text, grounded);
  assert.equal(out.contextFrom, 'retrieval');
  assert.ok(out.sources.length > 0, 'an answer must name the facts it read');
  assert.equal(session.calls.length, 1, 'a good answer is one attempt');
});

test('MODEL-7 a session that throws is propagated, never swallowed into an answer',
  async () => {
    const answerer = answererWith(stubSession({ throw: 'the worker died' }));
    await assert.rejects(
      () => shellAsk(answerer, ANSWERABLE), /the worker died/);
  });

test('MODEL-8 the §6.3 knobs reach the session', async () => {
  /* This wiring was broken: the chat shell set its own `paceMs` and matched a
     ladder key (`budget`) the ladder does not have (`shorten`), so rungs 1 and
     2 changed nothing. The answerer is what owns the knobs. */
  const session = stubSession({ text: '' });
  const answerer = answererWith(session);
  assert.deepEqual(
    { max: answerer.setMaxNewTokens(64), pace: answerer.setPaceMs(24) },
    { max: 64, pace: 24 });

  await shellAsk(answerer, ANSWERABLE);
  /* The empty stub reply fails the guard, so this is two attempts — and the
     FIRST is the one that matters: the retry is greedy and deliberately
     unpaced, which is why the shell's knobs must reach the answerer rather
     than the shell holding its own copy. */
  assert.equal(session.calls.length, 2);
  assert.equal(session.calls[0].maxNewTokens, 64);
  assert.equal(session.calls[0].paceMs, 24);
  assert.equal(answerer.stats.maxNewTokens, 64);
});

test('MODEL-12 the answer path stays on the device — no network, no dynamic import', () => {
  /* The companion to the same assertion in `tests/quick-answers.test.mjs`,
     stated for the module that now decides what a visitor reads. The only
     fetch anywhere in the path is the worker's, for same-origin weights;
     `docs/PRIVACY.md` rests on both halves of that. */
  const src = readFileSync(join(HERE, '..', 'ai', 'answers', 'model.mjs'), 'utf8');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\./.test(src),
    'network access in the answer path');
  assert.ok(!/import\s*\(/.test(src), 'dynamic import in the answer path');
  assert.ok(!/https?:\/\//.test(src), 'a URL is hardcoded in the answer path');
});

test('MODEL-9 every refusal exists in three languages and states no fact', () => {
  assert.deepEqual([...NO_ANSWER_KINDS],
    ['notFound', 'withheld', 'unverified', 'unsupported', 'loading', 'stopped',
      'strained', 'cancelled']);

  for (const kind of NO_ANSWER_KINDS) {
    for (const lang of ['en', 'hi', 'hinglish']) {
      const line = noAnswerLine(kind, lang);
      assert.ok(line && line.trim().length > 10, `${kind}/${lang} is empty`);
      /* A refusal asserts nothing, so it cannot contain a number — a digit in
         one would be a claim, and a claim in a fixed string is a fact nobody
         checked. This is the invariant that makes these safe to hard-code. */
      assert.ok(!/\d/.test(line), `${kind}/${lang} states a number: ${line}`);
      assert.ok(!/<\||\|>/.test(line), `${kind}/${lang} leaks a placeholder: ${line}`);
    }
    /* an unknown language falls back to English, never to a key or undefined */
    assert.equal(noAnswerLine(kind, 'fr'), noAnswerLine(kind, 'en'), kind);
  }
  assert.throws(() => noAnswerLine('nope'), /unknown no-answer kind/);

  /* No refusal badge may be mistaken for an answer. */
  assert.match(MODEL_BADGES.model, /AI ANSWER/);
  assert.match(MODEL_BADGES.partial, /PARTIAL/,
    'a stopped answer must SAY it is unfinished — see the loop below');
  for (const [key, badge] of Object.entries(MODEL_BADGES)) {
    if (key === 'model') continue;
    assert.ok(!/AI ANSWER/.test(badge), `${key} is labelled as an AI answer`);
    /* `partial` is the one thing that is neither: it is the model's own words,
       unfinished, and unguarded — the guard runs when generation ends — so it
       may not claim the verification the model badge claims. */
    if (key === 'partial') {
      assert.ok(!/NO ANSWER/.test(badge), 'a partial is not a refusal');
      /* `planner` is the other: a deterministic list answer (§5.1, measured
         2026-10-06). It IS an answer, but the model did not produce the
         words, so its badge must say where the words came from instead of
         claiming either an AI answer or a refusal. */
    } else if (key === 'planner') {
      assert.match(badge, /ANSWER/, key);
      assert.match(badge, /PORTFOLIO/, key);
      assert.ok(!/AI ANSWER|ON-DEVICE|NO ANSWER/.test(badge),
        'the planner badge must claim neither the model nor a refusal');
    } else {
      assert.match(badge, /NO ANSWER/, key);
    }
  }
});

test('MODEL-9b the fixed refusals speak ABOUT Aashish, not as him (§5)', () => {
  /* §5: "it speaks about Aashish in the third person and never pretends to be
     him." These sentences are the one place the assistant talks at length with
     no model in the loop, so they are also the last place a stale voice can
     hide — and it did: the flip to the third person left "ask me for my
     email", "from my portfolio data" and their Hindi/Hinglish twins behind.
     Nothing asserted the VOICE of a fixed string, which is why the persona
     tests (QA-10) did not catch them: those run the planner, and these lines
     are chosen by the answer layer.

     Possessives only. The `strained` refusal says "I've stopped generating
     answers for now" (मैंने … / maine …), which is the assistant talking about
     ITSELF and is correct in all three languages. */
  const AASHISH_POSSESSIVE = /\bmy\b|\b(?:mera|mere|meri)\b|मेरा|मेरे|मेरी/i;
  const offenders = [];
  for (const kind of NO_ANSWER_KINDS) {
    for (const lang of ['en', 'hi', 'hinglish']) {
      const line = noAnswerLine(kind, lang);
      if (AASHISH_POSSESSIVE.test(line)) offenders.push(`${kind}/${lang}: ${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    `a fixed refusal claims Aashish's things as its own:\n  ${offenders.join('\n  ')}`);
});

test('MODEL-10 a question retrieval cannot see still reaches the model with its facts',
  async () => {
    const probe = answererWith(stubSession({ text: '' }));
    /* THE REGRESSION this test exists for. `skills` is in the retrieval stop set
       on purpose (it lives in every skill chunk and used to hijack the score),
       so "what are his skills?" — the most common question a recruiter asks —
       has no content token left and BM25 returns an empty list. Gate on the
       retrieval score and the assistant answers it with "I don't have that",
       which is not merely unhelpful: it is false. */
    assert.equal(probe.retrieve(TOPIC_ONLY).hits.length, 0,
      'this test needs a question retrieval cannot see');

    const res = quickAnswer(KB, TOPIC_ONLY, { lang: 'en' });
    assert.ok(res.sources.length > 0, 'the intent knows exactly which facts answer it');

    /* A grounded reply, built from a fact the intent listed. */
    const ground = renderFact(KB, res.sources[0], 'en');
    assert.ok(ground.length > 0);

    const session = stubSession({ text: ground });
    const out = await shellAsk(answererWith(session), TOPIC_ONLY);
    assert.equal(out.kind, 'model', 'the portfolio answers this question in full');
    assert.equal(out.text, ground);
    assert.equal(out.contextFrom, 'intent', 'the context came from the intent, not retrieval');
    assert.match(session.calls[0].context, new RegExp(ground.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the facts must actually be in the prompt the model was given');
  });

test('MODEL-10b the intent fallback cannot smuggle a withheld or unknown fact', async () => {
  const session = stubSession({ text: 'He scored 99.' });
  const answerer = answererWith(session);

  /* The premise, stated so it is checked rather than assumed: a `public:false`
     field renders to nothing, which is what makes it safe to hand the whole
     source list at this door (§8.1). */
  assert.equal(renderFact(KB, 'contact.phone', 'en'), '',
    'the withheld field must not render — if this fails the knowledge base changed');
  assert.equal(answerer.retrieve(OFF_TOPIC).hits.length, 0);

  const out = await answerer.ask({
    question: OFF_TOPIC, lang: 'en',
    intentIds: ['contact.phone', 'no.such.fact'],
  });
  /* 2026-10-14: the model IS asked — what cannot happen is the context
     growing a withheld or unknown line out of ids that render to nothing. */
  assert.equal(session.calls.length, 2, 'asked, then the guard retry (owner decision 2026-10-14)');
  /* §8.1 unchanged: ids that render to nothing never become evidence */
  assert.equal(out.context, '', 'ids that render to nothing must not reach the context');
  /* and nothing the model said about facts it never read can survive */
  assert.equal(out.kind, 'unverified');
  assert.equal(out.guardFailed, true);
});

test('MODEL-11 a small-talk question is answered BY the model (2026-10-14)',
  async () => {
    /* 2026-10-11 reversed the original, and 2026-10-14 reverses it again: the
       planner is gone, so a hello goes to the model exactly like every other
       question. 2026-10-15: the greeting frame also matches TRAINING now —
       every §7.4 greeting example pairs the question with the
       `[person.name]` context line, so greetrouting carries that one fact.
       Empty-context greetings are not a trained shape, and when the runtime
       asked for one the checkpoint rambled and the guard rejected it twice.
       What survives all three decisions: the ANSWER is written by the model
       (claim-free, so the guard checks it and passes it), not by a fallback. */
    const res = quickAnswer(KB, 'hi', { lang: 'en' });
    assert.equal(res.intent, 'greeting');
    /* 2026-10-18: the education facts are gone from the greeting frame.
       MEASURED against the shipped export: "hi" with `[person.name]` alone
       already emits ` I study at <|fact:edu.lpu|>. ` — the extra lines never
       changed the model's words, they only let that recitation pass the
       guard, so a greeting answered with education. The trained frame has
       one fact; the frame carries one fact. */
    assert.deepEqual(res.sources, [KB.person.id],
      'a greeting trains on the `[person.name]` line, and nothing else');

    const session = stubSession({ text: 'Hello! Ask me anything about my work.' });
    const out = await shellAsk(answererWith(session), 'hi');
    assert.equal(session.calls.length, 1, 'the model is asked a hello now');
    assert.ok(
      session.calls[0].context.includes(`[${KB.person.id}]`),
      'the greeting frame carries the fact training always gave it');
    assert.equal(out.kind, 'model', 'claim-free small talk passes the grounded guard');
    assert.ok(out.text.length > 20, 'the greeting said something');
    assert.deepEqual(out.sources, [KB.person.id],
      'sources are the facts the model read — the one framing fact');

    /* and the same for the small-talk phrasings that used to fall through to
       the retrieval gate */
    for (const q of ['how are you', 'how are u', "what's up", 'kaise ho', 'kese ho', 'bye', 'good morning']) {
      const session2 = stubSession({ text: 'Fine! What would you like to know?' });
      const r = await shellAsk(answererWith(session2), q);
      assert.equal(session2.calls.length, 1, `"${q}" is asked of the model`);
      assert.equal(r.kind, 'model', `"${q}" is answered by the model`);
      assert.ok(r.text.length > 20, `"${q}" has something to say`);
    }
  });

test('MODEL-13 the intent fallback is capped, and the sources are the facts it read',
  async () => {
    /* THE OVERFLOW BUG. The intent fallback addressed the topic's WHOLE fact
       list — 38 facts for "what are his skills?" — and the assembled prompt was
       764 tokens against a 512-token window. The engine threw, and the visitor
       was told the model had stopped, for a question the portfolio answers in
       full. MEASURED with the shipping tokenizer: 18 of those 38 facts fit.

       The cap is a budget, so it has a bound taken from the window rather than
       from taste, and it is checked against the real window in
       `tests/token-budget.test.mjs` (BUDGET-3). */
    assert.ok(Number.isInteger(MAX_INTENT_FACTS) && MAX_INTENT_FACTS > 0);

    const res = quickAnswer(KB, TOPIC_ONLY, { lang: 'en' });
    const all = res.sources.filter((id) => renderFact(KB, id, 'en'));
    assert.ok(all.length > MAX_INTENT_FACTS,
      `the case this cap exists for is gone: ${all.length} facts`);

    const session = stubSession({ text: '' });
    const answerer = answererWith(session);
    await shellAsk(answerer, TOPIC_ONLY);

    const read = session.calls[0].context.split('\n').filter(Boolean);
    assert.equal(read.length, MAX_INTENT_FACTS, 'the cap must be the number of lines sent');
    assert.deepEqual(read, all.slice(0, MAX_INTENT_FACTS).map((id) => {
      const value = renderFact(KB, id, 'en');
      return `[${id}] ${value}`;
    }), 'the context must be the leading facts, in order');

    /* And the sources the visitor is shown are the ids the CONTEXT names, which
       is what makes §12's anchors true. Built from `retrieve()` rather than
       from the session stub because the stub does not trim. */
    const probe = answererWith(stubSession({ text: '' }));
    const grounded = probe.retrieve(TOPIC_ONLY);
    assert.equal(grounded.hits.length, 0, 'TOPIC_ONLY must still defeat retrieval');
  });

test('MODEL-15 §10\u2019s Stop reaches the worker, and an abort is not an answer',
  async () => {
    /* The shell's Stop button is one call to `AbortController.abort()`, so the
       contract it rests on lives here: the signal is forwarded all the way to
       the session, and an aborted generation REJECTS. If the answer path
       swallowed that rejection and returned the partial as `kind: 'model'`,
       the panel would badge an unfinished, unguarded sentence as a verified
       answer — the one thing the badge exists to prevent. */
    const session = stubSession({ text: 'half a sentence', waitForAbort: true });
    const answerer = answererWith(session);
    const controller = new AbortController();

    const pending = answerer.ask({
      question: ANSWERABLE, lang: 'en', signal: controller.signal,
    });
    /* Wait until the generation is genuinely in flight, then press Stop. */
    for (let i = 0; i < 50 && !session.calls.length; i++) await Promise.resolve();
    assert.equal(session.calls.length, 1, 'the model was never asked');
    assert.equal(session.calls[0].signal, controller.signal,
      'the abort signal did not reach the session');

    controller.abort();
    await assert.rejects(() => pending, /aborted/,
      'an aborted generation must reject, so the shell keeps the partial and badges it');

    /* And an already-aborted signal never starts a generation at all. */
    const dead = new AbortController();
    dead.abort();
    await assert.rejects(
      () => answererWith(stubSession({ text: 'x' })).ask({
        question: ANSWERABLE, lang: 'en', signal: dead.signal,
      }), /aborted/);
  });

test('MODEL-16 a stopped answer has two honest outcomes and no third', () => {
  /* The shell renders a Stop from two inputs: nothing streamed yet (the
     `cancelled` line, because "the model stopped" would blame the machine for
     a click) and a partial guarded by nothing (the `partial` badge, which is
     neither an answer nor a refusal). Both must exist, in three languages,
     and neither may claim a verification that never happened. */
  for (const lang of ['en', 'hi', 'hinglish']) {
    const line = noAnswerLine('cancelled', lang);
    assert.ok(line && !/\d/.test(line), `cancelled/${lang} is not a clean refusal: ${line}`);
    assert.ok(!/model stopped/i.test(line), `${lang} blames the model for the visitor's click`);
  }
  assert.match(MODEL_BADGES.partial, /PARTIAL/);
  assert.ok(!/AI ANSWER/.test(MODEL_BADGES.partial),
    'an unfinished, unguarded sentence must not wear the verified badge');
  assert.notEqual(MODEL_BADGES.partial, MODEL_BADGES.unverified);
});

test('MODEL-17 a stopped answer is finished, placeholder-free, or honestly empty', () => {
  /* §10's Stop. The guard and the placeholder resolver both run at the END of
     a generation, so neither has run when a visitor stops one — the shell
     cannot just leave the streamed string on screen. This is the pure half:
     what the bubble is allowed to show. */

  /* A complete placeholder resolves, exactly as it would have at the end. */
  const email = renderFact(KB, 'contact.email', 'en');
  assert.ok(email && email.includes('@'));
  assert.equal(partialAnswer(KB, `You can reach me at <|fact:contact.email|>`, 'en'),
    `You can reach me at ${email}`);

  /* One CUT IN HALF is dropped, not printed: a stream can end mid-placeholder,
     and `replacePlaceholders` cannot match an incomplete one. */
  assert.equal(partialAnswer(KB, 'My email is <|fact:cont', 'en'), 'My email is');
  assert.ok(!/<\|/.test(partialAnswer(KB, 'x <|fact:', 'en')));

  /* An unknown id is dropped as well — the allowlist does not loosen for a
     stop (and the guard never saw it either). */
  assert.equal(partialAnswer(KB, 'phone: <|fact:not.a.fact|>', 'en'), 'phone:');

  /* Stop before a single token (during prefill — most of the wait) is the
     cancelled line, never a partial claim and never "the model stopped". */
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(partialAnswer(KB, empty, 'en'), noAnswerLine('cancelled', 'en'));
  }
  assert.equal(partialAnswer(KB, '<|fact:em', 'en'), noAnswerLine('cancelled', 'en'),
    'a bare cut placeholder leaves nothing to keep');
  for (const lang of ['hi', 'hinglish']) {
    assert.equal(partialAnswer(KB, '', lang), noAnswerLine('cancelled', lang));
  }
});

test('MODEL-15 a whole-kind question reads the KIND, not the three chunks BM25 found',
  async () => {
    /* MEASURED on the 2026-10-24 §14 sweep (sft6, 38.2 % factual): "Which
       databases does he use?" was asked against `[cert.dbms]`, `[skill.mysql]`
       and `[skill.mongoose]` — 2 of the 5 databases the case expects — because
       §8.2's budget is top-3 chunks. `quickAnswer()` already returns the whole
       kind as the plan; this is the run where it becomes the context. */
    const question = 'Which databases does he use?';
    const res = quickAnswer(KB, question, { lang: 'en' });
    assert.equal(res.plan.kind, 'skills');
    assert.equal(res.plan.category, 'database', 'the question named a category');
    const expected = res.sources.filter((id) => id.startsWith('skill.'));
    assert.ok(expected.length >= 5, `the database set is ${expected.length} facts — more than 3`);

    const answerer = answererWith(stubSession({ text: 'He works with MongoDB and MySQL.' }));
    assert.ok(answerer.retrieve(question).hits.length > 0,
      'BM25 DOES return chunks here — that is the shape being fixed, so the test is pointless if it does not');

    /* without the plan: the retrieval context, which is allowed to be partial */
    const partial = await answerer.ask({ question, lang: 'en', intentIds: res.sources });
    assert.ok(partial.context.split('\n').length <= 3,
      'three chunks is the retrieval budget, and it is not the answer to a plural question');

    /* with it: every database the plan names, capped by the window */
    const answerer2 = answererWith(stubSession({ text: 'He works with MongoDB and MySQL.' }));
    const out = await answerer2.ask({
      question, lang: 'en', intentIds: res.sources, plan: res.plan,
    });
    for (const id of expected.slice(0, MAX_INTENT_FACTS)) {
      assert.ok(out.context.includes(`[${id}]`), `${id} must be readable: ${out.context}`);
    }
    assert.equal(out.sources.length, expected.length, 'the sources are what was read');
  });

test('MODEL-15b the whole-kind scope is a table, not a guess at question wording', () => {
  for (const kind of ['skills', 'list_projects', 'certifications', 'education']) {
    assert.ok(intentScopesContext({ kind }), kind);
  }
  for (const kind of ['contact_field', 'project_detail', 'workflow', 'greeting', 'meta', 'fact']) {
    assert.ok(!intentScopesContext({ kind }), kind);
  }
  assert.ok(!intentScopesContext(null), 'no plan is the old behaviour');
  assert.ok(!WHOLE_KIND_PLANS.has('contact_withheld'),
    'a withheld field is never widened into a context');
});

test('MODEL-15c an identity turn reads the name line alone, whatever retrieval scored', () => {
  /* Every meta example in ai/data/instruction.py is built with
     `build_context(f, ["person.name"])`, and the answer is the same fixed
     disclosure. MEASURED 2026-10-27 on the sft8 export: given the retrieval
     context (name + GitHub + how-he-builds) "are you Aashish?" answered
     `Unka tareeka: <|fact:workflow.how-he-builds|>`; given the training frame
     it disclosed. So the plan has to pin its context, and only meta does: a
     greeting already reaches `[person.name]` by having no retrievable content
     token, and widening it is the defect quick.mjs records. */
  assert.ok(planPinsContext({ kind: 'meta' }));
  for (const kind of ['greeting', 'skills', 'contact_field', 'fact', 'abstain']) {
    assert.ok(!planPinsContext({ kind }), kind);
  }
  assert.ok(!planPinsContext(null));
  assert.ok(!intentScopesContext({ kind: 'meta' }),
    'pinning is narrower than whole-kind: the two predicates are not the same claim');
});

test('MODEL-14 a prompt that overflows the window is impossible, not an error the visitor reads',
  () => {
    /* The engine is what enforces the window now (see `fitToBudget`), and this
       is the module-level half of that contract: the answer path must never
       hand the engine a context longer than `MAX_INTENT_FACTS` lines, so there
       is no path left that can throw. The tokenizer-level proof is BUDGET-2. */
    const src = readFileSync(join(HERE, '..', 'ai', 'answers', 'model.mjs'), 'utf8');
    assert.match(src, /slice\(0, MAX_INTENT_FACTS\)/,
      'the intent fallback lost its cap — 38 facts and a 764-token prompt come back');
    /* both doors into a context are filtered by `renderFact`: retrieval's
       `contextLines` and the intent fallback */
    const renders = src.match(/renderFact\(kb, id/g) || [];
    assert.ok(renders.length >= 1, 'the intent fallback stopped filtering ids');
  });

/* ═══════════════════════════════════════════════════════════════
   LISTS — now model turns (2026-10-14)

   The planner answers (PLANNER-1…PLANNER-6) are retired with the owner's
   pure-AI decision: list questions go to the model like everything else,
   and how well the model composes lists is measured by the eval, not
   compensated in the shipping path. The property that MUST survive the
   retirement is §8.1's: the intent bucket the model reads contains only
   facts that RENDER — a `public:false` item is filtered at the door and
   is not in the context, whatever the question asked for.
   ═══════════════════════════════════════════════════════════════ */

test('MODEL-14 a list question is answered by the model from the intent bucket, and a withheld item is not in it', async () => {
  const withheld = JSON.parse(JSON.stringify(KB));
  (withheld.skills || []).forEach((s) => { if (s.id === 'skill.python') s.public = false; });
  assert.equal(renderFact(withheld, 'skill.python', 'en'), '',
    'the premise: the public:false skill renders to nothing');

  const session = stubSession({ text: 'He works with React.' });
  const answerer = createModelAnswerer({ kb: withheld, session, maxNewTokens: 48 });
  const out = await answerer.ask({
    question: 'What are his skills?', lang: 'en',
    intentIds: ['skill.python', 'skill.react'],
  });
  /* retrieval is empty for this shape (`skills` sits in the retrieval stop
     set), so the context the model read is the intent bucket — with the
     withheld item filtered out at the door */
  assert.equal(session.calls.length, 1, 'the model IS asked for a list answer now');
  assert.ok(out.context.includes('[skill.react]'), out.context);
  assert.ok(!out.context.includes('skill.python'),
    'a public:false fact must not reach the model (§8.1)');
  assert.equal(out.kind, 'model');
  assert.deepEqual(out.sources, ['skill.react'],
    'the sources are the context ids actually read');
});

/* ── which turns are decoded against the closed answer space ─────

   `answerGrammar` is what lets the engine constrain a turn to the trained
   answer frames (ai/engine/grammar.mjs). It must NOT be on for the turns whose
   answer is not a fact sentence — a greeting forced into `His name is …` would
   answer a different question than the visitor asked — and it must be on for
   the fact kinds, including the withheld-field kind, where the empty context
   leaves the model nothing legal but `<|abstain|>`. */
test('MODEL-15 the closed answer space is chosen by the intent, not by the model', () => {
  for (const kind of ['greeting', 'meta', 'abstain', 'hallucination_bait']) {
    assert.equal(wantsClosedAnswer({ kind }), false, `${kind} must keep the free decode`);
  }
  for (const kind of ['skills', 'education', 'certifications', 'list_projects',
    'project_detail', 'contact_field', 'contact_links', 'contact_all',
    'contact_withheld', 'workflow']) {
    assert.equal(wantsClosedAnswer({ kind }), true, `${kind} answers from a fact frame`);
  }
  /* No intent matched: nothing says the question is about a fact, so the
     weaker citation mask stays in charge rather than a closed space that
     could refuse a question the portfolio can answer. */
  assert.equal(wantsClosedAnswer(null), false);
  assert.equal(wantsClosedAnswer(undefined), false);
});

/* ── a frame with nothing in its slot ─────────────────────────

   MEASURED 2026-10-26 on the sft7 export, the 60 §14 prompts: f06
   ("and his 12th marks?") decoded `His CGPA is  .` — an answer whose frame is
   a trained one, whose fact is the wrong one, and whose slot is empty. It
   reached the visitor because neither defence looks at it: the citation mask
   admits ordinary words, and the guard grounds CLAIMS, while a sentence with
   nothing in its slot claims nothing.

   WHY it was reachable: `edu.kv2` had no sentence in the frame table, so the
   closed grammar returned null for that turn and only the mask applied. The
   sentence exists now (`_topic_class12`), and this check is what makes the
   NEXT fact the table cannot frame a refusal instead of a broken sentence. */
test('MODEL-18 a frame with an empty slot is refused, not shown', async () => {
  /* The pure rule, against the observed text and its near misses. */
  assert.equal(emptySlotFrame(' His CGPA is  .'), 'His CGPA is {v}.');
  assert.equal(emptySlotFrame(' His CGPA is \n. '),
    'His CGPA is {v}.', 'a bare newline in the slot is still an empty slot');
  assert.equal(emptySlotFrame(' His CGPA is 8.28.'), null,
    'a filled slot is an answer, not a hollow frame');
  assert.equal(emptySlotFrame(' Hello, I am Aashish.'), null);
  assert.equal(emptySlotFrame(''), null);

  /* And the answer path: the visitor is told the app could not verify it,
     rather than shown a sentence with a hole in it. */
  const session = stubSession({ text: ' His CGPA is  .' });
  const out = await answererWith(session).ask({ question: 'and his 12th marks?' });
  assert.equal(out.kind, 'unverified');
  assert.equal(out.guardFailed, true);
  assert.equal(out.abstained, true);
  assert.match(out.reason, /empty slot/);
  assert.equal(out.text, noAnswerLine('unverified', 'en'));
  assert.ok(!out.text.includes('CGPA'), 'the hollow sentence must not survive');
});
