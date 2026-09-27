#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   tools/bundle-report.mjs — the §4 budget, measured per file

     npm run bundle           → the breakdown, largest first
     npm run bundle -- --json → machine-readable (docs/RESOURCES.json)

   The numbers in `docs/AI_ARCHITECTURE.md` and `docs/BENCHMARKS.md` used to
   be produced by a throwaway `node -e` snippet, which is how a figure goes
   stale: nothing re-runs it. This is the same measurement as
   `tests/build-bundle.test.mjs`, in a form a person reads.

   Two budgets, and they must stay separate (§4): the **AI chat chunk** is the
   script + knowledge a click pulls (hundreds of KB), and the **first use** is
   that chunk plus the weights and tokenizer (tens of MB, one-time). Folding
   them together would hide a regression in either.
   ═══════════════════════════════════════════════════════════════ */
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

import { ROOT, buildBundle } from './build.mjs';

const MODEL_PREFIX = 'ai/model-export/';
const CHAT_CHUNK_GZ_BUDGET = 150 * 1024;
const FIRST_USE_GZ_BUDGET = 40 * 1024 * 1024;

/** Every file in `dir`, as `{rel, abs}` with `/` separators on Windows too. */
function listFiles(root, dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, abs, out);
    else out.push({ abs, rel: relative(root, abs).split('\\').join('/') });
  }
  return out;
}

const gz = (f) => gzipSync(readFileSync(f.abs)).length;
const sum = (list) => list.reduce((n, f) => n + gz(f), 0);
const kb = (n) => (n / 1024).toFixed(1);

export function report({ out = join(ROOT, '.bundle-report'), json = false, keep = false } = {}) {
  const summary = buildBundle({ out, quiet: true });
  try {
    const files = listFiles(out, out);
    /* §4's chunk, read conservatively: everything shipped under `ai/` plus the
       knowledge base, voice included even though it loads on a tap. The
       weights are excluded and reported on their own. */
    const chat = files.filter((f) => !f.rel.startsWith(MODEL_PREFIX)
      && (f.rel.startsWith('ai/') || f.rel === 'knowledge/knowledge.json'));
    const weights = files.filter((f) => f.rel.startsWith(MODEL_PREFIX));
    const site = files.filter((f) => !chat.includes(f) && !weights.includes(f));

    const chatGz = sum(chat);
    const siteGz = sum(site);
    const weightsGz = sum(weights);
    const firstUseGz = chatGz + weightsGz;

    /* §4 splits its 150 KB "runtime" row into three, and the docs quote the
       split, so it is measured here rather than by hand: the chat UI proper
       (UI + knowledge + retrieval + language + guard + intent + anchors +
       governor), the voice add-ons (which load on a tap, §2 N6 — `caps.mjs`
       stays with the shell because the button has to describe voice before it
       can offer it), and the LLM runtime + tokenizer (all of `ai/engine/`). */
    const isVoiceAddOn = (rel) => /^ai\/voice\/(index|vad|phantoms)\.mjs$/.test(rel);
    const isRuntime = (rel) => rel.startsWith('ai/engine/');
    const voiceAddOns = chat.filter((f) => isVoiceAddOn(f.rel));
    const runtime = chat.filter((f) => isRuntime(f.rel));
    const chatUi = chat.filter((f) => !isVoiceAddOn(f.rel) && !isRuntime(f.rel));

    const data = {
      chatChunkGz: chatGz,
      chatChunkBudgetGz: CHAT_CHUNK_GZ_BUDGET,
      chatChunkPct: +(100 * chatGz / CHAT_CHUNK_GZ_BUDGET).toFixed(1),
      chatUiGz: sum(chatUi),
      voiceAddOnsGz: sum(voiceAddOns),
      runtimeGz: sum(runtime),
      siteGz,
      weightsGz,
      firstUseGz,
      firstUseBudgetGz: FIRST_USE_GZ_BUDGET,
      modelShipped: summary.modelShipped,
      files: [...files]
        .map((f) => ({ rel: f.rel, gz: gz(f), raw: readFileSync(f.abs).length }))
        .sort((a, b) => b.gz - a.gz),
    };

    if (json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return data;
    }

    console.log(`bundle report — ${relative(ROOT, out) || out}${summary.modelShipped ? '' : ' (no model export)'}`);
    console.log('');
    console.log(`  AI chat chunk   ${kb(chatGz)} KB gz  of ${kb(CHAT_CHUNK_GZ_BUDGET)} KB  (${data.chatChunkPct}% used)`);
    console.log(`    · chat UI       ${kb(data.chatUiGz)} KB gz   (UI + knowledge + retrieval + language + guard + intent + anchors + governor)`);
    console.log(`    · voice add-ons ${kb(data.voiceAddOnsGz)} KB gz   (load on a tap, §2 N6)`);
    console.log(`    · runtime       ${kb(data.runtimeGz)} KB gz   (ai/engine/ — LLM runtime + tokenizer)`);
    console.log(`  rest of page    ${kb(siteGz)} KB gz`);
    console.log(`  weights+json    ${kb(weightsGz)} KB gz  (${summary.modelShipped ? 'export present' : 'absent'})`);
    console.log(`  first visit     ${kb(firstUseGz)} KB gz  of ${kb(FIRST_USE_GZ_BUDGET)} KB  (${(100 * firstUseGz / FIRST_USE_GZ_BUDGET).toFixed(1)}% used)`);
    console.log('');
    console.log('  largest files in the chat chunk:');
    for (const f of data.files.filter((x) => chat.some((c) => c.rel === x.rel)).slice(0, 12)) {
      console.log(`    ${String(f.gz).padStart(7)} gz  ${String(f.raw).padStart(7)} raw  ${f.rel}`);
    }
    const over = chatGz > CHAT_CHUNK_GZ_BUDGET;
    console.log('');
    console.log(over
      ? `  verdict  OVER BUDGET by ${kb(chatGz - CHAT_CHUNK_GZ_BUDGET)} KB — §4 is a hard requirement`
      : `  verdict  inside §4's chunk budget by ${kb(CHAT_CHUNK_GZ_BUDGET - chatGz)} KB`);
    return data;
  } finally {
    if (!keep) rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('bundle-report.mjs')) {
  const argv = process.argv.slice(2);
  report({ json: argv.includes('--json'), keep: argv.includes('--keep'),
    out: argv.includes('--keep') ? join(ROOT, 'dist-bench') : undefined });
  process.exit(0);
}
