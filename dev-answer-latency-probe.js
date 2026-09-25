#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   dev-answer-latency-probe.js — what one question costs (§4/§10), by phase.

     node dev-answer-latency-probe.js [export-dir]

   §4's floor (>= 8 tok/s decode) says the model *can* answer; it says nothing
   about how long a visitor waits. A visitor feels two moments: the FIRST token
   (they are looking at an empty bubble) and the END (they are reading). So the
   probe reports both, and breaks the first one down, because "the model is
   slow" is not actionable — "prefill of a 300-token prompt is 8 of those 9
   seconds" is.

     encode    prompt string -> token ids   (our JS BPE, on the main thread)
     prefill   prompt ids -> first token    (the wait before any text appears)
     decode    each further token           (what `maxNewTokens` multiplies)

   It reads real questions through the real retrieval, so the prompt length is
   the prompt a visitor would actually send. That matters: `maxNewTokens` is the
   lever with no quality cost for a short answer and a direct linear cost for a
   long one, but the *prefill* is set by how many facts retrieval hands over —
   and that is the part nobody watches when they tune a generation cap.
   ═══════════════════════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ScratchLlamaEngine } from './ai/engine/index.mjs';
import { buildIndex, search } from './ai/retrieval/index.mjs';
import { contextLines } from './ai/answers/model.mjs';
import { frame, defaultStopIds } from './ai/engine/prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, process.argv[2] || 'ai/model-export/aashish-ai-1');

const KB = JSON.parse(readFileSync(resolve(HERE, 'knowledge', 'knowledge.json'), 'utf8'));

/** Questions a recruiter actually types, plus a Hinglish turn (the language
 *  mix changes the prompt length, and prompt length is the cost) and one the
 *  portfolio has nothing to say about. */
const QUESTIONS = [
  'What are your skills?',
  'Tell me about your projects',
  'What is your education?',
  'uske projects batao',
  'What did he do at LTIMindtree?',
  'Do you know his favourite cricketer?',
];

const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;

function fileFetch(base) {
  return async (url) => {
    const name = String(url).split('/').pop();
    try {
      const buffer = readFileSync(resolve(base, name));
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength),
        json: async () => JSON.parse(buffer.toString('utf8')),
      };
    } catch {
      return { ok: false, status: 404 };
    }
  };
}

const engine = await ScratchLlamaEngine.load({
  manifestUrl: `${dir.replace(/\\/g, '/')}/manifest.json`,
  fetchImpl: fileFetch(dir),
});
const model = engine.model;
const index = buildIndex(KB);
const stops = defaultStopIds(engine.tokenizer);

const cap = Number(process.env.MAX_NEW || 96);

console.log(`answer latency · ${dir.replace(`${HERE}\\`, '').replace(/\\/g, '/')}`);
console.log(`  weights   ${(engine.bytes / 1e6).toFixed(2)} MB, verified ${engine.verified}`);
console.log(`  KV cache  ${(model.kvBytes / 1024).toFixed(0)} KB resident`);
console.log(`  cap       ${cap} new tokens\n`);

/* Where the prompt tokens go. Prefill is the whole wait and prefill is linear
   in prompt tokens, so "the model is slow" is really "the prompt is long" - and
   this is the split that says which part of it to cut. */
const rulesTok = engine.tokenizer.encode(
  frame({ question: '', context: '', history: [], rules: 'first' })).length;
console.log(`  frame overhead (specials + rules, constant per question): ${rulesTok} tokens\n`);

console.log('  question                             facts   rules   facts       q   prompt'
  + '    encode    prefill    decode    total   tok/s');
console.log(`  ${'-'.repeat(110)}`);

const rows = [];
for (const question of QUESTIONS) {
  const found = search(index, question);
  const context = contextLines(KB, found.hits);
  const prompt = frame({ question, context, history: [], rules: 'first' });

  let t = process.hrtime.bigint();
  const ids = engine.tokenizer.encode(prompt);
  const encodeMs = ms(t);

  model.reset();
  t = process.hrtime.bigint();
  for (const id of ids) model.forward(id);
  const prefillMs = ms(t);

  /* Greedy decode, the same loop `generate()` runs, with the stop tokens it
     watches — so `tokens` is the answer's real length, not the cap. */
  let previous = ids.at(-1);
  let tokens = 0;
  let stopReason = 'max-tokens';
  t = process.hrtime.bigint();
  for (let step = 0; step < cap; step++) {
    const id = model.argmax(model.forward(previous));
    if (stops.has(id)) { stopReason = 'end-token'; break; }
    tokens += 1;
    previous = id;
  }
  const decodeMs = ms(t);

  const totalMs = encodeMs + prefillMs + decodeMs;
  const row = { question, ids: ids.length, lines: context.split('\n').length,
    encodeMs, prefillMs, decodeMs, totalMs, tokens, stopReason };
  rows.push(row);

  row.questionTok = engine.tokenizer.encode(question).length;
  const name = question.length > 34 ? `${question.slice(0, 33)}…` : question;
  console.log(`  ${name.padEnd(37)}${String(row.lines).padStart(5)}`
    + `${String(rulesTok).padStart(8)}${String(row.ids - rulesTok - row.questionTok).padStart(8)}`
    + `${String(row.questionTok).padStart(8)}${String(row.ids).padStart(9)}`
    + `${encodeMs.toFixed(0).padStart(9)} ms`
    + `${prefillMs.toFixed(0).padStart(9)} ms${decodeMs.toFixed(0).padStart(9)} ms`
    + `${totalMs.toFixed(0).padStart(8)} ms`
    + `${(tokens / (totalMs / 1000)).toFixed(1).padStart(7)}`);
}

const worst = rows.reduce((a, b) => (b.totalMs > a.totalMs ? b : a));
const best = rows.reduce((a, b) => (b.totalMs < a.totalMs ? b : a));
console.log(`\n  slowest  ${worst.totalMs.toFixed(0)} ms  "${worst.question}"  `
  + `(${worst.ids} prompt tokens, ${worst.lines} facts)`);
console.log(`  fastest  ${best.totalMs.toFixed(0)} ms  "${best.question}"  (${best.ids} prompt tokens)`);

/* What the cache is worth, measured on the path the chat actually takes.
   `generate()` remembers the prompt it prefilled and reuses whatever leading
   token ids the next prompt shares with it (`LlamaEngine.reusePrefix`), so the
   cost of a question depends on how much of the previous question it repeats.
   An average over questions would hide exactly that, so this reports a repeat
   and a different question separately.

   Run 1 is also where the visitor pays JIT warm-up, so nothing is compared
   against it as if the whole difference were the cache — the repeat is
   compared against run 1, and the point is that it is far below it. */
async function timeToFirstToken(args) {
  const t = process.hrtime.bigint();
  const iterator = engine.generate(args);
  let step = await iterator.next();
  while (!step.done) {
    if (step.value) break;
    step = await iterator.next();
  }
  return ms(t);
}

/** How many leading ids two arrays agree on — the same rule `reusePrefix` uses,
 *  so a reader can check the claim rather than take it. */
function sharedPrefix(a, b) {
  if (!a) return 0;
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[n] === b[n]) n += 1;
  return n;
}

console.log('\n  time to first token, through generate() (the path the chat takes)');
{
  const cold = { question: worst.question,
    context: contextLines(KB, search(index, worst.question).hits) };
  const other = { question: best.question,
    context: contextLines(KB, search(index, best.question).hits) };
  const otherIds = engine.tokenizer.encode(
    frame({ ...other, history: [], rules: 'first' }));

  engine.model.reset();
  const coldMs = await timeToFirstToken({ ...cold, maxNewTokens: 8 });
  const repeatMs = await timeToFirstToken({ ...cold, maxNewTokens: 8 });
  /* read the cache BEFORE the next generation overwrites it */
  const otherShared = sharedPrefix(engine.model.prefixIds, otherIds);
  const otherMs = await timeToFirstToken({ ...other, maxNewTokens: 8 });

  const savedPct = (100 * (coldMs - repeatMs) / Math.max(coldMs, 1)).toFixed(0);
  console.log(`  cold    (no cache, full prefill)`
    + `${coldMs.toFixed(0).padStart(11)} ms`);
  console.log(`  repeat  (same question again)`
    + `${repeatMs.toFixed(0).padStart(13)} ms   ${savedPct}% of the first wait saved`);
  console.log(`  other   (shares ${String(otherShared).padStart(3)} of ${String(otherIds.length).padStart(3)} prompt ids)`
    + `${otherMs.toFixed(0).padStart(6)} ms`);
  console.log('\n  A repeat costs almost nothing because the whole prompt is reused; a\n'
    + '  different question still skips the constant rules block. That is the same\n'
    + '  bit-identical mechanism (the K/V at a position depends only on the tokens\n'
    + '  before it), so the saving is free and cannot change an answer.');
}

/* The sweep that decides the cap: same question, same prompt, only the number
   of tokens generated changes, so the difference is decode and nothing else. */
console.log(`\n  cap sweep on "${worst.question}" (prefill and encode excluded)`);
console.log('  maxNewTokens   tokens    decode     per token');
for (const n of [48, 96, 160]) {
  const context = contextLines(KB, search(index, worst.question).hits);
  const ids = engine.tokenizer.encode(frame({ question: worst.question, context, history: [], rules: 'first' }));
  model.reset();
  for (const id of ids) model.forward(id);
  let previous = ids.at(-1);
  let count = 0;
  const t = process.hrtime.bigint();
  for (let step = 0; step < n; step++) {
    const id = model.argmax(model.forward(previous));
    if (stops.has(id)) break;
    count += 1;
    previous = id;
  }
  const decodeMs = ms(t);
  console.log(`  ${String(n).padStart(11)}${String(count).padStart(9)}`
    + `${decodeMs.toFixed(0).padStart(9)} ms${(decodeMs / Math.max(count, 1)).toFixed(1).padStart(12)} ms`);
}

engine.dispose();
