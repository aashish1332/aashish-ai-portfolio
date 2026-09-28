/* ═══════════════════════════════════════════════════════════════
   tools/eval-decode.mjs — decode the §14 prompts with the SHIPPING engine

     npm run eval:prompts                       # 1. the prompts
     node tools/eval-decode.mjs --export ai/model-export/aashish-ai-1 \
          --prompts docs/EVAL_PROMPTS.json --out docs/EVAL_ANSWERS.json \
          --max-tokens 96                        # 2. answers (this tool)
     npm run eval:report                         # 3. score + gates

   WHY THIS EXISTS NEXT TO `inference/grade_answers.py`. Both write the same
   answers file and both are honest; they measure slightly different things:

   | | `inference/grade_answers.py` | this |
   |---|---|---|
   | reads | a training checkpoint (fp32) | an exported artifact (q8, as shipped) |
   | decoder | the numpy reference, **no KV cache** | the real engine, prefill reuse + cache |
   | cost | 0.62 s/token on R1 (48×16 ≈ 11 min) | the shipping speed |
   | use | "what does this checkpoint say" | "what does the visitor's model say" |

   The reference decoder has no cache on purpose — it is the cache-correctness
   check, and making it fast would delete what it is for. So a gate-grade
   96-token sweep over 48 prompts needs the engine, and the engine is also the
   more faithful instrument: it is the arithmetic that ships, quantisation
   included.

   The prompts come from `tools/model-eval.mjs`, which built them with the
   client's own code. This tool passes the *parts* to `engine.generate()` (which
   composes its own prompt) and then asserts the string it composed is
   byte-identical to the one in the prompts file. That assert is the contract:
   if `fitToBudget`/`frame` ever drift between the emitter and the engine, this
   fails instead of grading a prompt nobody would ever send.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';

import { ScratchLlamaEngine } from '../ai/engine/index.mjs';
import { frame } from '../ai/engine/prompt.mjs';

export function fileFetch(base) {
  const root = pathResolve(base);
  return async (url) => {
    const name = String(url).split('/').pop();
    const body = readFileSync(pathResolve(root, name));
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(body.byteLength) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      json: async () => JSON.parse(body.toString('utf8')),
      text: async () => body.toString('utf8'),
    };
  };
}

export async function decodeWithEngine({ exportDir, prompts, maxNewTokens, onProgress = null }) {
  /* `load()` takes the manifest's URL and derives the tokenizer and shard URLs
     from it, so the shim only has to resolve the basename — the same shim
     shape `tests/token-budget.test.mjs` uses. `verify` stays on: the sha256
     check is what makes "the artifact we graded" and "the artifact we ship"
     the same claim. */
  const manifestUrl = `${pathResolve(exportDir).replace(/\\/g, '/')}/manifest.json`;
  const engine = await ScratchLlamaEngine.load({
    manifestUrl,
    fetchImpl: fileFetch(exportDir),
  });

  const answers = [];
  for (const row of prompts) {
    if (row.route !== 'model' || !row.prompt) {
      answers.push({ id: row.id, answer: row.answer || '', route: row.route, decoded: 0 });
      continue;
    }
    const expected = frame({
      question: row.question, context: row.context,
      history: row.history || [], rules: row.rules || 'third',
    });
    if (expected !== row.prompt) {
      throw new Error(`the engine's frame and the emitter's prompt differ for ${row.id} — `
        + 'regenerate the prompts with `npm run eval:prompts` (fitToBudget/frame drifted)');
    }
    /* `generate` is a generator whose *return* value carries the summary, so
       the chunk stream has to be drained. Nothing is streamed to a UI here:
       this is a measurement, not a session. */
    const run = engine.generate({
      question: row.question,
      context: row.context,
      history: row.history || [],
      rules: row.rules || 'third',
      maxNewTokens,
    });
    let step = await run.next();
    while (!step.done) step = await run.next();
    const summary = step.value;
    answers.push({
      id: row.id,
      answer: summary?.rawText ?? summary?.text ?? '',
      rawText: summary?.rawText ?? null,
      ids: summary?.ids ?? [],
      decoded: summary?.tokens ?? 0,
      stopReason: summary?.stopReason ?? null,
      abstained: summary?.abstained ?? false,
      route: row.route,
    });
    if (onProgress) onProgress(row, summary);
  }
  /* The export manifest records which checkpoint produced it. The report has
     to name what it graded — "a checkpoint at some step" is not a measurement
     anyone can reproduce. */
  return { engine, answers, source: engine.manifest?.source ?? null };
}

export function parseArgs(argv) {
  const args = { exportDir: null, prompts: null, out: null, maxTokens: 96, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export') args.exportDir = argv[++i];
    else if (a === '--prompts') args.prompts = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--max-tokens') args.maxTokens = Number(argv[++i]);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('node tools/eval-decode.mjs --export <dir> --prompts <json> --out <json> [--max-tokens 96]');
      process.exit(0);
    } else throw new Error(`unknown flag ${a}`);
  }
  for (const key of ['exportDir', 'prompts', 'out']) {
    if (!args[key]) throw new Error(`--${key === 'exportDir' ? 'export' : key} is required`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const payload = JSON.parse(readFileSync(args.prompts, 'utf8'));
  /* The budget is part of the prompt: `fitToBudget` left room for this many
     new tokens when it trimmed the context, so decoding with a different
     number would ask the engine for a prompt the file does not describe. */
  if (payload.maxNewTokens !== undefined && payload.maxNewTokens !== args.maxTokens) {
    throw new Error(`--max-tokens ${args.maxTokens} but the prompts were fitted for `
      + `${payload.maxNewTokens}; re-emit with --max-new-tokens ${args.maxTokens} instead`);
  }

  if (!args.quiet) {
    console.log(`engine decode: ${args.exportDir}, ≤${args.maxTokens} tokens, `
      + `${payload.prompts.length} prompts`);
  }
  const started = Date.now();
  const { answers, source } = await decodeWithEngine({
    exportDir: args.exportDir,
    prompts: payload.prompts,
    maxNewTokens: args.maxTokens,
    onProgress: args.quiet ? null : (row, summary) => {
      console.log(`    ${row.id}  ${String(summary?.tokens ?? 0).padStart(3)} tok  `
        + `${summary?.stopReason ?? '?'}  ${String(summary?.rawText ?? '').slice(0, 60)}`);
    },
  });
  const out = {
    createdAt: new Date().toISOString(),
    decoder: 'ai/engine (shipping): prefill reuse + KV cache, q8 weights as exported',
    exportDir: args.exportDir,
    promptsFile: args.prompts,
    maxNewTokens: args.maxTokens,
    decodeSeconds: (Date.now() - started) / 1000,
    checkpoint: source?.run ?? null,
    which: source?.which ?? null,
    step: source?.step ?? null,
    source: source ?? null,
    prompts: payload.prompts,
    answers,
  };
  mkdirSync(dirname(pathResolve(args.out)), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  const decoded = answers.filter((a) => a.route === 'model');
  const tokens = decoded.reduce((n, a) => n + a.decoded, 0);
  console.log(`  ${decoded.length} decoded · ${tokens} tokens · `
    + `${out.decodeSeconds.toFixed(1)}s · `
    + `${(tokens / Math.max(1, out.decodeSeconds)).toFixed(1)} tok/s`);
  console.log(`wrote ${args.out}`);
  console.log(`next: npm run eval:report   (or node tools/model-eval.mjs --grade ${args.out})`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('eval-decode.mjs')) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(1);
  });
}
