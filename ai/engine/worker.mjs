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
      const info = engine.memoryEstimate;
      post({ id, type: 'ready', config: engine.config,
             verified: engine.verified, bytes: engine.bytes, memory: info,
             cache: { name: modelCacheName(manifestUrl), ...stats } });
      return;
    }

    if (type === 'generate') {
      if (!engine) throw new Error('generate before prepare');
      if (busy) busy.abort();
      busy = new AbortController();
      const { question, context, history, rules, maxNewTokens, paceMs } = event.data;
      const iterator = engine.generate({
        question, context, history, rules, maxNewTokens, paceMs,
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
