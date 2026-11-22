/* ═══════════════════════════════════════════════════════════════
   ai/engine/worker.mjs — the model runs here, never on the page.

   §5's architecture puts the runtime in "AI Worker (dedicated)", and §4
   gives the reason in numbers: "AI work on the main thread: no task >
   50 ms". One decode step of the ~5M-parameter model this laptop trains
   takes tens of milliseconds; on a phone it takes hundreds. Any of those
   on the main thread is a dropped frame, and §18's first constraint is
   that the portfolio never pays for the AI.

   A **module** worker (`type: 'module'`) so the engine modules are shared
   with the tests instead of being copied into a string. Safari 15+,
   Firefox 114+ and Chrome 80+ support it; where they do not, the session
   reports `unsupported` and the chat says so plainly, which is
   §6.2's T0 path — a real tier, not an error.

   The protocol is deliberately tiny and every request carries an `id`, so
   a late reply from an abandoned question can never be mistaken for the
   answer to the current one.
   ═══════════════════════════════════════════════════════════════ */

import { ScratchLlamaEngine } from './index.mjs';
import { loadWithCacheRecovery, modelCacheName } from './cache.mjs';

let engine = null;
let busy = null;      /* the AbortController of the generation in flight */
let prepared = false;
/* The post-load prefix prefill. Handlers are independent async callbacks, so
   a generate message arrives while the prefill is still awaiting: without
   this join the two prefills would interleave forwards in ONE KV cache of
   positions — the answer would be written on top of a prompt half-read. */
let priming = null;

const post = (message) => self.postMessage(message);

self.onmessage = async (event) => {
  const { id, type } = event.data || {};
  try {
    if (type === 'prepare') {
      const { manifestUrl, tokenizerUrl, verify = true } = event.data;
      engine?.dispose();
      /* §9.3: the artifacts live in a version-keyed Cache Storage, so a later
         visit loads with zero bytes of network and the assistant works with
         the network cut. `caches` is absent outside a secure context and can
         still refuse to open; both fall back to the plain fetch path. */
      const { result, stats } = await loadWithCacheRecovery({
        cacheStorage: self.caches || null,
        cacheName: modelCacheName(manifestUrl),
        load: (fetchImpl) => ScratchLlamaEngine.load({
          manifestUrl, tokenizerUrl, verify, fetchImpl,
          onProgress: ({ stage, loaded, total, shard, ms }) =>
            post({ id, type: 'progress', stage, loaded, total, shard, ms }),
        }),
      });
      engine = result;
      prepared = true;
      /* The first question of a session must not pay the specials + rules
         block cold (~46% of a typical prompt; docs/BENCHMARKS.md). The
         worker prefills it now, while the visitor is on the page behind
         this worker, and every later generate() reuses it through
         `LlamaEngine.reusePrefix`. The chat's persona is DEFAULT_PERSONA
         ('third') on every turn, so that is the block to warm. */
      priming = engine.prime().catch(() => {});
      await priming;
      const info = engine.memoryEstimate;
      post({ id, type: 'ready', config: engine.config,
             verified: engine.verified, bytes: engine.bytes, memory: info,
             cache: { name: modelCacheName(manifestUrl), ...stats } });
      return;
    }

    if (type === 'generate') {
      if (!engine) throw new Error('generate before prepare');
      if (priming) await priming;           /* never interleave the two prefills */
      if (busy) busy.abort();
      busy = new AbortController();
      /* `answerGrammar` is the answer layer's decision (a fact question is
         decoded against the trained answer frames, ai/engine/grammar.mjs); it
         travels with the turn like every other part of the request rather than
         being re-derived here, where the intent is not known. Unknown fields
         are dropped on purpose, so this list IS the worker's contract. */
      const { question, context, history, rules, maxNewTokens, paceMs, answerGrammar, answerIds }
        = event.data;
      const iterator = engine.generate({
        question, context, history, rules, maxNewTokens, paceMs, answerGrammar, answerIds,
        signal: busy.signal,
      });
      let index = 0;
      let result = await iterator.next();
      while (!result.done) {
        post({ id, type: 'token', index: index++, text: result.value.text,
               tokenId: result.value.id });
        result = await iterator.next();
      }
      busy = null;
      post({ id, type: 'done', summary: result.value });
      return;
    }

    if (type === 'abort') {
      busy?.abort();
      busy = null;
      post({ id, type: 'aborted' });
      return;
    }

    if (type === 'dispose') {
      // §6.4: terminating the worker is what actually frees the memory; this
      // message only makes the intent explicit and drops the references early.
      busy?.abort();
      engine?.dispose();
      engine = null;
      prepared = false;
      post({ id, type: 'disposed' });
      return;
    }

    throw new Error(`unknown worker message ${JSON.stringify(type)}`);
  } catch (error) {
    busy = null;
    post({ id, type: 'error', message: error?.message || String(error),
           stack: error?.stack });
  }
};

/** Exposed for the tests, which cannot import a worker script directly. */
export const __testing = {
  get prepared() { return prepared; },
  get hasEngine() { return engine !== null; },
};
