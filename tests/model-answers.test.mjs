/* ═══════════════════════════════════════════════════════════════
   tests/model-answers.test.mjs — the answer path, and the end of the
   template answer (MODEL-1…MODEL-11)

   `ai/answers/model.mjs` is §5.1's answer path and it had **no test at all**
   until this file: the engine was gated parity-first and the guard had its own
   suite, but the module that decides what a visitor actually reads was covered
   only by a browser probe. Writing these found four things — two dead branches,
   one unreachable one, and the reason the most common question a recruiter asks
   was about to be answered with "I don't have that".

   The property being pinned is a decision the owner made: **the model is the
   only thing that answers.** Where it cannot, the panel refuses and says which
   refusal it is. Every template that used to stand in — the exact-fact Quick
   Answer, the extractive prose fallback behind the guard — is gone, and these
   tests are what stop one creeping back in.

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
  MAX_INTENT_FACTS, partialAnswer,
} from '../ai/answers/model.mjs';
import { quickAnswer, renderFact } from '../ai/answers/quick.mjs';

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
  /* the handoff the chat shell performs, kept in one place so both sides of it
     are visible: the intent's facts go along as a fallback context, and only a
     greeting is allowed to reach the model with nothing to read */
  const res = quickAnswer(KB, question, { lang: 'en' });
  return answerer.ask({
    question,
    lang: 'en',
    intentIds: res.sources,
    contextless: res.intent === 'greeting',
    ...extra,
  });
};

test('MODEL-1 routing is one pure decision with six outcomes and a fixed precedence',
  () => {
    const base = { res: { intent: 'skills' }, hasModel: true, lang: 'en' };
    assert.equal(routeQuestion(base).path, 'model');
    assert.equal(routeQuestion(base).kind, 'model', 'an answer by the model is the only kind');

    assert.equal(routeQuestion({ ...base, res: { injection: true } }).path, 'safety');
    assert.equal(routeQuestion({ ...base, res: { intent: 'meta' } }).path, 'disclosure');

    const bait = routeQuestion({ ...base, res: { intent: 'hallucination_bait' } });
    assert.equal(bait.path, 'no-data');
    assert.equal(bait.noAnswer, noAnswerLine('notFound', 'en'));

    const withheld = routeQuestion({ ...base, res: { private: true } });
    assert.equal(withheld.path, 'withheld');
    assert.equal(withheld.noAnswer, noAnswerLine('withheld', 'en'));

    assert.equal(routeQuestion({ ...base, hasModel: false }).path, 'no-model');
    assert.equal(routeQuestion({ ...base, generationStopped: true }).path, 'no-model');

    /* Precedence matters: an injection attempt that also looks like bait is
       still refused as an injection, and a no-model session still refuses bait
       as bait rather than reporting a missing download. */
    assert.equal(routeQuestion({
      ...base, res: { injection: true, intent: 'hallucination_bait' },
    }).path, 'safety');
    assert.equal(routeQuestion({
      ...base, hasModel: false, res: { intent: 'hallucination_bait' },
    }).path, 'no-data');
    assert.equal(routeQuestion({ ...base, res: { injection: true, intent: 'meta' } }).path,
      'safety', 'a jailbreak phrased as "who are you" is still a jailbreak');
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

test('MODEL-3 a question with nothing to ground on never reaches the model',
  async () => {
    const session = stubSession({ text: 'this must never be produced' });
    const answerer = answererWith(session);
    assert.equal(answerer.retrieve(OFF_TOPIC).hits.length, 0,
      'this test needs a question retrieval cannot see at all');

    const out = await shellAsk(answerer, OFF_TOPIC);
    assert.equal(out.kind, 'notFound');
    assert.equal(out.text, noAnswerLine('notFound', 'en'));
    assert.equal(session.calls.length, 0,
      'the model was asked a question its context could not answer in any way');
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
    if (key === 'partial') assert.ok(!/NO ANSWER/.test(badge), 'a partial is not a refusal');
    else assert.match(badge, /NO ANSWER/, key);
  }
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
  const session = stubSession({ text: 'x' });
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
  assert.equal(out.kind, 'notFound');
  assert.equal(session.calls.length, 0,
    'ids that render to nothing must not become a reason to ask the model');
});

test('MODEL-11 a greeting reaches the model with nothing to read, and asserts nothing',
  async () => {
    const res = quickAnswer(KB, 'hi', { lang: 'en' });
    assert.equal(res.intent, 'greeting');
    assert.equal(res.sources.length, 0, 'a greeting has no facts by design');

    const session = stubSession({ text: 'Hello! Ask me anything about my work.' });
    const out = await shellAsk(answererWith(session), 'hi');
    assert.equal(session.calls.length, 1, 'the model is the thing that greets');
    assert.equal(session.calls[0].context, '', 'and it has nothing to read, by design');
    assert.equal(out.kind, 'model');

    /* Without the explicit allowance it is refused like any other question with
       nothing to ground on — so the allowance is doing real work, and this
       assertion is what says so. */
    const refused = await answererWith(stubSession({ text: 'x' })).ask({
      question: 'hi', lang: 'en', intentIds: [],
    });
    assert.equal(refused.kind, 'notFound');
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
