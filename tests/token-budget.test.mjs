/* ═══════════════════════════════════════════════════════════════
   tests/token-budget.test.mjs — the window is 512 tokens, and the
   budget that decides what goes in it was off by ~2.5x (BUDGET-1…BUDGET-4)

   `ai/retrieval/index.mjs` budgeted the context with a 4-chars-per-token
   approximation. That is a *generic English* rule of thumb and it was wrong
   for this model by a factor of ~2.5: `aashish-ai-1` has a 1,024-token
   vocabulary, so its BPE cannot merge long runs the way a 32k vocabulary
   does. At 4, a "300-token" context was really ~750 tokens.

   The consequence was not a slightly long prompt. A prompt one token past
   `max_position_embeddings` makes `LlamaEngine.forward` throw, and a thrown
   prompt reached the visitor as "the on-device model stopped" for questions
   the portfolio answers in full. MEASURED before the fix: 14 of the 60
   evaluation questions assembled a prompt over 512 tokens, and the intent
   fallback handed the model 764 tokens for "What are your skills?".

   These tests run the REAL tokenizer (the shipping 1,024-vocab one, from the
   committed export) against the REAL knowledge base and the REAL evaluation
   corpus, so a tokenizer retrain or a knowledge-base edit that invalidates
   any of these numbers fails here and names the command that re-measures it:

       npm run probe:tokens

   The weights are not loaded — only `tokenizer.json`, which is small.
   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTokenizer } from '../ai/engine/bpe.mjs';
import { fitToBudget } from '../ai/engine/prompt.mjs';
import {
  buildIndex, search, estimateTokens, CHARS_PER_TOKEN, MAX_CONTEXT_TOKENS,
} from '../ai/retrieval/index.mjs';
import { quickAnswer, contextSizer, renderFact } from '../ai/answers/quick.mjs';
import { contextLines, idsInContext, MAX_INTENT_FACTS } from '../ai/answers/model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = resolve(HERE, '..', 'ai/model-export/aashish-ai-1');
const KB = JSON.parse(readFileSync(resolve(HERE, '..', 'knowledge/knowledge.json'), 'utf8'));
const CASES = JSON.parse(
  readFileSync(resolve(HERE, '..', 'evaluation/portfolio_tests.json'), 'utf8'));

/* The window comes from the manifest, never typed here: a probe that cannot
   disagree with the model it is measuring is the only kind worth having. */
const MANIFEST = JSON.parse(readFileSync(resolve(EXPORT_DIR, 'manifest.json'), 'utf8'));
const MAX_SEQ = MANIFEST.config.max_position_embeddings;
const MAX_NEW_TOKENS = 96;   /* ai/answers/model.mjs's default */

function fileFetch(base) {
  return async (url) => {
    const name = String(url).split('/').pop();
    const buffer = readFileSync(resolve(base, name));
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength),
      json: async () => JSON.parse(buffer.toString('utf8')),
    };
  };
}

const TOKENIZER = await loadTokenizer(
  `${EXPORT_DIR.replace(/\\/g, '/')}/tokenizer.json`, { fetchImpl: fileFetch(EXPORT_DIR) });
const tokens = (s) => TOKENIZER.encode(s).length;
const charsPerToken = (s) => { const t = tokens(s); return t ? String(s).length / t : Infinity; };

const INDEX = buildIndex(KB);
const SIZE_OF = contextSizer(KB);

/** What the answer path hands the engine for one question, exactly as
 *  `createModelAnswerer().ask()` assembles it: retrieval-priced hits, and the
 *  intent's own facts only when retrieval comes back empty. */
function promptFor(question) {
  const found = search(INDEX, question, { sizeOf: SIZE_OF });
  const hits = found.hits.filter((h) => SIZE_OF(h) > 0);
  let context = contextLines(KB, hits);
  let how = 'retrieval';
  if (!hits.length) {
    const res = quickAnswer(KB, question, { lang: 'en' });
    const ids = (res.sources || []).filter((id) => renderFact(KB, id, 'en'))
      .slice(0, MAX_INTENT_FACTS);
    if (ids.length) {
      context = contextLines(KB, ids.map((id) => ({ id })));
      how = 'intent';
    }
  }
  const fitted = fitToBudget({
    tokenizer: TOKENIZER, question, context, history: [], rules: 'first',
    maxNewTokens: MAX_NEW_TOKENS, maxSeq: MAX_SEQ,
  });
  return { question, how, context, fitted, hits: hits.length };
}

/* ── BUDGET-1: the ratio is measured, not assumed ──────────────── */
test('BUDGET-1 CHARS_PER_TOKEN matches the tokenizer the model ships with', () => {
  /* The classes the constant actually budgets. Medians, MEASURED by
     `npm run probe:tokens` — and the constant is asserted to sit inside them
     rather than next to the generic 4. */
  const contextRows = [];
  for (const c of CASES) {
    const found = search(INDEX, c.question, { sizeOf: SIZE_OF });
    const lines = contextLines(KB, found.hits.filter((h) => SIZE_OF(h) > 0));
    if (lines) contextRows.push(charsPerToken(lines));
  }
  assert.ok(contextRows.length > 20, `too few priced contexts: ${contextRows.length}`);
  contextRows.sort((a, b) => a - b);
  const median = contextRows[Math.floor(contextRows.length / 2)];
  const worst = contextRows[0];

  /* §8.2's "≤ ~300 tokens" is meant to be approximately true, so the constant
     sits within ±20% of the median of what it prices. */
  assert.ok(CHARS_PER_TOKEN >= median * 0.8 && CHARS_PER_TOKEN <= median * 1.25,
    `CHARS_PER_TOKEN=${CHARS_PER_TOKEN} vs measured median ${median.toFixed(2)}`);
  assert.notEqual(CHARS_PER_TOKEN, 4, 'the generic 4-chars-per-token guess is back');
  /* and it is NOT set below the worst case, because that direction has its own
     failure: a single long project chunk priced over the whole budget is
     skipped, so the best evidence stops being retrieved at all. */
  assert.ok(CHARS_PER_TOKEN < worst * 1.6,
    'the constant is so pessimistic that real chunks stop fitting in the budget');
  assert.ok(estimateTokens('a'.repeat(150)) === Math.ceil(150 / CHARS_PER_TOKEN));
  assert.ok(MAX_CONTEXT_TOKENS <= 300);
});

/* ── BUDGET-2: nothing the answer path builds overflows the window ─ */
test('BUDGET-2 every evaluation prompt fits after fitToBudget, and the retrieval path needs no trimming',
  () => {
    const rows = CASES.map((c) => promptFor(c.question));
    assert.equal(rows.length, 60, 'the evaluation corpus shrank');

    for (const r of rows) {
      assert.ok(r.fitted.promptTokens + MAX_NEW_TOKENS <= MAX_SEQ,
        `${r.question}: ${r.fitted.promptTokens} + ${MAX_NEW_TOKENS} > ${MAX_SEQ}`);
      assert.ok(r.fitted.promptTokens > 0);
    }

    /* The whole point of the honest ratio: the ordinary path is right-sized,
       so nothing has to be trimmed away from it. */
    const retrieval = rows.filter((r) => r.how === 'retrieval');
    assert.ok(retrieval.length > 30, `too few retrieval cases: ${retrieval.length}`);
    const trimmed = retrieval.filter((r) => r.fitted.droppedContextLines > 0);
    assert.deepEqual(trimmed.map((r) => r.question), [],
      'the retrieval budget is admitting more context than the window holds');
    assert.equal(retrieval.filter((r) => r.fitted.droppedHistoryTurns > 0).length, 0);

    /* At 4 chars/token this budget admitted up to `MAX_CHUNKS` chunks priced at
       a quarter of their real cost. Three evaluation questions overflow even
       with NO budget at all; those must still fit now. */
    for (const id of ['d16', 'i05', 's03']) {
      const c = CASES.find((x) => x.id === id);
      assert.ok(c, `evaluation case ${id} is gone`);
      const withEverything = fitToBudget({
        tokenizer: TOKENIZER, question: c.question,
        context: contextLines(KB, search(INDEX, c.question, { sizeOf: () => 0 }).hits),
        history: [], rules: 'first', maxNewTokens: MAX_NEW_TOKENS, maxSeq: MAX_SEQ,
      });
      assert.ok(withEverything.promptTokens + MAX_NEW_TOKENS <= MAX_SEQ);
    }
  });

/* ── BUDGET-3: the intent fallback has a bound, and the bound fits ─ */
test('BUDGET-3 the intent fallback is capped, and the cap fits the window', () => {
  /* `skills` is in the retrieval stop set on purpose, so "what are his
     skills?" has no content token and BM25 returns nothing — the intent
     fallback is what answers it. It had NO cap and handed the model 38 facts
     and a 764-token prompt. This is that case. */
  const question = 'What are his skills?';
  const res = quickAnswer(KB, question, { lang: 'en' });
  const all = (res.sources || []).filter((id) => renderFact(KB, id, 'en'));
  assert.ok(all.length > MAX_INTENT_FACTS,
    `the uncapped case this cap exists for no longer exists (${all.length} facts)`);

  const capped = all.slice(0, MAX_INTENT_FACTS);
  const context = contextLines(KB, capped.map((id) => ({ id })));
  const fitted = fitToBudget({
    tokenizer: TOKENIZER, question, context, history: [], rules: 'first',
    maxNewTokens: MAX_NEW_TOKENS, maxSeq: MAX_SEQ,
  });
  assert.equal(fitted.droppedContextLines, 0,
    `MAX_INTENT_FACTS=${MAX_INTENT_FACTS} does not fit: ${fitted.promptTokens} tokens`);
  assert.ok(fitted.promptTokens + MAX_NEW_TOKENS <= MAX_SEQ);

  /* and the whole list really would not have fitted — the cap is load-bearing,
     not decoration */
  const uncapped = fitToBudget({
    tokenizer: TOKENIZER, question,
    context: contextLines(KB, all.map((id) => ({ id }))),
    history: [], rules: 'first', maxNewTokens: MAX_NEW_TOKENS, maxSeq: MAX_SEQ,
  });
  assert.ok(uncapped.droppedContextLines > 0 || uncapped.droppedHistoryTurns > 0,
    'the uncapped fallback fits after all, so this cap is not doing anything');
});

/* ── BUDGET-4: the sources shown are the ones the model READ ───── */
test('BUDGET-4 sources come from the trimmed context, never from what was offered', () => {
  /* The engine drops context lines to fit, and both the guard and the §12
     "where did this come from" anchors follow the trimmed string. The 38-deep
     skills case is the one that gets trimmed, so it is the one to check. */
  const all = Array.from({ length: 40 }, (_, i) => `[fact.${i}] value ${i}`);
  const fitted = fitToBudget({
    tokenizer: TOKENIZER, question: 'What is his CGPA?', context: all.join('\n'),
    history: [], rules: 'first', maxNewTokens: MAX_NEW_TOKENS, maxSeq: MAX_SEQ,
  });
  const read = idsInContext(fitted.context);
  assert.ok(fitted.droppedContextLines > 0, 'nothing was dropped, so nothing was tested');
  assert.equal(read.length, all.length - fitted.droppedContextLines);
  assert.deepEqual(read, all.slice(0, read.length).map((l) => l.slice(1, l.indexOf(']'))));
  assert.ok(!read.includes('fact.39'), 'a line that was dropped must not be cited');
});
