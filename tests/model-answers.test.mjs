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
    async generate(args) {
      calls.push({
        question: args.question,
        context: args.context,
        maxNewTokens: args.maxNewTokens,
        paceMs: args.paceMs,
      });
      const r = typeof reply === 'function' ? reply(args) : reply;
      if (r?.throw) throw new Error(r.throw);
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

test('MODEL-9 every refusal exists in three languages and states no fact', () => {
  assert.deepEqual([...NO_ANSWER_KINDS],
    ['notFound', 'withheld', 'unverified', 'unsupported', 'loading', 'stopped', 'strained']);

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
  for (const [key, badge] of Object.entries(MODEL_BADGES)) {
    if (key === 'model') continue;
    assert.ok(!/AI ANSWER/.test(badge), `${key} is labelled as an AI answer`);
    assert.match(badge, /NO ANSWER/, key);
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
