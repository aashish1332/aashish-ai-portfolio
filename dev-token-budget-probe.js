#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   dev-token-budget-probe.js — the prompt does not fit, and here is by how
   much.

   `ai/retrieval/index.mjs` budgets context with a 4-chars-per-token
   approximation. That number is a *generic English* rule of thumb and it is
   wrong for this model: `aashish-ai-1` has a 1,024-token vocabulary, so its
   BPE cannot merge long runs the way a 32k-vocab tokenizer does, and real
   text costs far more tokens per character. Every `MAX_CONTEXT_TOKENS`
   decision, and the retrieval budget table in `docs/BENCHMARKS.md`, rest on
   the approximation — so the approximation is the thing to measure.

   This probe answers three questions, with the real tokenizer, on the real
   knowledge base and the real evaluation corpus:

     1. what IS the chars/token ratio, per string class (frame, context,
        question, answer prose)?
     2. for each of the 60 evaluation questions, does the assembled prompt
        plus the default `maxNewTokens` fit `max_position_embeddings`?
     3. for the intent-context fallback (`intentIds`), what is the largest
        number of facts that fits — i.e. what should the cap be?

   It prints a table and a JSON blob; nothing is written and nothing is
   asserted. The numbers are recorded in docs/BENCHMARKS.md, and the
   *conservativeness* of whatever constant we pin is asserted by
   `tests/model-answers.test.mjs` against this same tokenizer, so a
   tokenizer change cannot silently invalidate it.

   Run:  node dev-token-budget-probe.js
   ═══════════════════════════════════════════════════════════════ */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTokenizer } from './ai/engine/bpe.mjs';
import { frame, framePrefix } from './ai/engine/prompt.mjs';
import { buildIndex, search, estimateTokens, MAX_CHUNKS } from './ai/retrieval/index.mjs';
import { contextLines } from './ai/answers/model.mjs';
import { quickAnswer, renderFact } from './ai/answers/quick.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = resolve(HERE, 'ai/model-export/aashish-ai-1');
const KB = JSON.parse(readFileSync(resolve(HERE, 'knowledge/knowledge.json'), 'utf8'));
const CASES = JSON.parse(readFileSync(resolve(HERE, 'evaluation/portfolio_tests.json'), 'utf8'));

/* The limits, read from the manifest rather than typed here: the probe must
   not be able to disagree with the model it is measuring. */
const MANIFEST = JSON.parse(readFileSync(resolve(EXPORT_DIR, 'manifest.json'), 'utf8'));
const MAX_SEQ = MANIFEST.config.max_position_embeddings;
const DEFAULT_MAX_NEW = 96;   /* ai/answers/model.mjs's default */

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

const tokenizer = await loadTokenizer(
  `${EXPORT_DIR.replace(/\\/g, '/')}/tokenizer.json`, { fetchImpl: fileFetch(EXPORT_DIR) });

const tokens = (s) => tokenizer.encode(s).length;
const ratio = (s) => { const t = tokens(s); return t ? s.length / t : Infinity; };

/* ── 1. chars/token, per string class ─────────────────────────── */
const classes = new Map();
const note = (cls, s) => {
  if (!s || !s.length) return;
  if (!classes.has(cls)) classes.set(cls, []);
  classes.get(cls).push({ chars: s.length, tokens: tokens(s) });
};

note('frame prefix (specials + rules)', framePrefix({ rules: 'first' }));
for (const q of CASES) note('question', q.question);

const index = buildIndex(KB);
/* The context the model is actually handed is `contextLines()` — one compact
   rendered value per fact, NOT the index's chunk text. Pricing the chunk text
   here was this probe's own first bug: it made the context look ~3x bigger
   than it is, because a project chunk carries every field and every highlight
   while `renderFact` sends the summary. */
for (const q of CASES) {
  const found = search(index, q.question);
  if (!found.hits.length) continue;
  const lines = contextLines(KB, found.hits);
  if (lines) note('retrieval context', lines);
}
for (const c of index.chunks) note('index chunk text', c.text);
/* every fact's rendered line, which is what the intent fallback pastes in */
for (const id of new Set(CASES.flatMap((c) => c.expected_facts))) {
  note('fact line', `[${id}] ${renderFact(KB, id, 'en')}`);
}
/* answer prose: the retired Quick Answers are the closest thing to a length
   sample of what the model is asked to produce, and they are in-repo */
for (const q of CASES) note('answer prose', quickAnswer(KB, q.question, { lang: 'en' }).text);

console.log('chars/token, measured with the shipping tokenizer\n');
console.log('  class                             n    min    med    max   chars/token(med)');
const summary = {};
for (const [cls, rows] of classes) {
  const rs = rows.map((r) => r.chars / r.tokens).sort((a, b) => a - b);
  const med = rs[Math.floor(rs.length / 2)];
  summary[cls] = {
    n: rows.length, min: +rs[0].toFixed(3), median: +med.toFixed(3), max: +rs.at(-1).toFixed(3),
  };
  console.log(`  ${cls.padEnd(34)}${String(rows.length).padStart(3)}` +
    `${rs[0].toFixed(2).padStart(7)}${med.toFixed(2).padStart(7)}` +
    `${rs.at(-1).toFixed(2).padStart(7)}${med.toFixed(2).padStart(14)}`);
}
const all = [...classes.values()].flat().map((r) => r.chars / r.tokens);
const worst = Math.min(...all);
console.log(`\n  worst overall ${worst.toFixed(3)} chars/token — the conservative end`);
console.log(`  estimateTokens() assumes 4.00 — it under-counts by ` +
  `${(4 / worst).toFixed(2)}x at worst`);

/* ── 2. does each evaluation question's prompt fit? ───────────── */
console.log(`\nmaxSeq ${MAX_SEQ}, maxNewTokens ${DEFAULT_MAX_NEW}\n`);
const overflow = [];
const rows = CASES.map((c) => {
  const found = search(index, c.question);
  const context = contextLines(KB, found.hits);
  const promptTokens = tokens(frame({ question: c.question, context, rules: 'first' }));
  const roomForContext = MAX_SEQ - DEFAULT_MAX_NEW - promptTokens +
    tokens(context); /* how many context tokens would fit */
  const over = promptTokens + DEFAULT_MAX_NEW > MAX_SEQ;
  if (over) overflow.push({ id: c.id, question: c.question, promptTokens, hits: found.hits.length });
  return { id: c.id, hits: found.hits.length, contextTokens: tokens(context), promptTokens,
    estimated: estimateTokens(context), over, roomForContext };
});
console.log(`  retrieval path: ${rows.filter((r) => r.over).length}/${rows.length} questions overflow`);
const realVsEst = rows.filter((r) => r.contextTokens)
  .map((r) => r.contextTokens / Math.max(1, r.estimated));
console.log(`  retrieval context real/estimated tokens: median ` +
  `${realVsEst.sort((a, b) => a - b)[Math.floor(realVsEst.length / 2)].toFixed(2)}x`);
for (const r of rows.slice(0, 8)) {
  console.log(`    ${r.id} hits=${r.hits} ctx=${r.contextTokens} (est ${r.estimated}) ` +
    `prompt=${r.promptTokens}${r.over ? '  OVERFLOW' : ''}`);
}
if (overflow.length) {
  console.log('  overflowing cases:');
  for (const o of overflow) console.log(`    ${o.id} ${o.promptTokens} tok — ${o.question}`);
}

/* ── 3. the intent fallback: how many facts fit? ──────────────── */
/* ── 2b. what the OLD budget admitted ────────────────────────────
   At 4 chars/token, `MAX_CONTEXT_TOKENS = 300` was 1200 CHARACTERS of chunk
   text, and the largest chunk in the base is 1175 — so the budget admitted
   the top 3 chunks for essentially every question, and the only real limit
   was `MAX_CHUNKS`. This is that case, priced with the real tokenizer, and
   it is the honest measure of what the old constant let through. */
const loose = CASES.map((c) => {
  const found = search(index, c.question, { maxTokens: Infinity });
  const context = contextLines(KB, found.hits);
  return { id: c.id, question: c.question,
    tokens: tokens(frame({ question: c.question, context, rules: 'first' })) + DEFAULT_MAX_NEW };
});
const looseOver = loose.filter((r) => r.tokens > MAX_SEQ);
console.log(`\n  with no token budget at all (what 4 chars/token effectively was): ` +
  `${looseOver.length}/${loose.length} prompts exceed ${MAX_SEQ}`);
for (const r of looseOver) console.log(`    ${r.id} ${r.tokens} tok — ${r.question}`);
console.log(`  worst ${Math.max(...loose.map((r) => r.tokens))} tokens`);

console.log('\n  intent fallback (`intentIds`), the case that actually broke:');
const probeAsks = [...new Set(CASES.map((c) => c.question))].slice(0, 60);
const intentRows = [];
for (const question of probeAsks) {
  const res = quickAnswer(KB, question, { lang: 'en' });
  const ids = (res.sources || []).filter((id) => renderFact(KB, id, 'en'));
  if (!ids.length) continue;
  const lines = contextLines(KB, ids.map((id) => ({ id }))).split('\n');
  /* largest prefix of facts that still fits, greedy, exactly how a cap must
     behave if it is going to be a cap */
  let fit = 0;
  for (let n = lines.length; n >= 0; n--) {
    const ctx = lines.slice(0, n).join('\n');
    const p = tokens(frame({ question, context: ctx, rules: 'first' }));
    if (p + DEFAULT_MAX_NEW <= MAX_SEQ) { fit = n; break; }
  }
  const full = tokens(frame({ question, context: lines.join('\n'), rules: 'first' }));
  intentRows.push({ question, facts: ids.length, fullPromptTokens: full, factsThatFit: fit });
}
intentRows.sort((a, b) => b.fullPromptTokens - a.fullPromptTokens);
console.log('    question                                    facts  promptTok  fitFacts');
for (const r of intentRows.slice(0, 12)) {
  console.log(`    ${r.question.slice(0, 40).padEnd(42)}${String(r.facts).padStart(5)}` +
    `${String(r.fullPromptTokens).padStart(11)}${String(r.factsThatFit).padStart(10)}`);
}
const fits = intentRows.map((r) => r.factsThatFit).filter((n) => n > 0);
console.log(`\n    facts that fit: min ${Math.min(...fits)} · median ` +
  `${fits.sort((a, b) => a - b)[Math.floor(fits.length / 2)]} · max ${Math.max(...fits)}`);
console.log(`    facts refused outright (even one line too long): ` +
  `${intentRows.filter((r) => r.factsThatFit === 0).length}`);

console.log('\nJSON ' + JSON.stringify({
  maxSeq: MAX_SEQ, maxNewTokens: DEFAULT_MAX_NEW,
  charsPerToken: summary,
  worstCharsPerToken: +worst.toFixed(4),
  retrievalOverflow: rows.filter((r) => r.over).length,
  retrievalCases: rows.length,
  unbudgetedPrompts: { over: looseOver.length, of: loose.length,
    ids: looseOver.map((r) => r.id), worst: Math.max(...loose.map((r) => r.tokens)) },
  intent: {
    asked: intentRows.length,
    answersOverflowingToday: intentRows.filter((r) => r.fullPromptTokens + DEFAULT_MAX_NEW > MAX_SEQ).length,
    fitFactsMin: Math.min(...fits), fitFactsMedian: fits[Math.floor(fits.length / 2)],
    fitFactsMax: Math.max(...fits),
  },
  maxChunks: MAX_CHUNKS,
}));
