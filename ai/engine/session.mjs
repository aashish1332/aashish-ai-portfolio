/* ═══════════════════════════════════════════════════════════════
   ai/engine/session.mjs — the page side of the worker boundary.

   Owns exactly three things the chat layer should not have to think about:
   the worker's life, request/response correlation, and the "this device
   cannot do it" answer.

   Nothing here loads before `prepare()` is called, and `prepare()` is only
   ever called from the visitor's click (§2 N6). `status()` reports what is
   true right now — `idle` | `loading` | `ready` | `unsupported` | `error`
   — and `reason` says why, so the panel can print a real sentence instead
   of a spinner (§10: "Never a permanent spinner").
   ═══════════════════════════════════════════════════════════════ */

const DEFAULT_WORKER = new URL('./worker.mjs', import.meta.url);

export function createModelSession(opts = {}) {
  const {
    manifestUrl, tokenizerUrl, workerUrl = DEFAULT_WORKER, env = globalThis,
    verify = true, onProgress = null,
  } = opts;

  let worker = null;
  let state = 'idle';
  let reason = null;
  let config = null;
  let nextId = 0;
  const pending = new Map();      /* id → {resolve, reject, onToken} */
  let lastLoaded = null;

  function fail(message) {
    state = 'error';
    reason = message;
    for (const [, entry] of pending) entry.reject(new Error(message));
    pending.clear();
  }

  function unsupported(message) {
    state = 'unsupported';
    reason = message;
    return false;
  }

  function ensureWorker() {
    if (worker) return true;
    if (!env.Worker) return unsupported('This browser has no Web Worker support.');
    try {
      worker = new env.Worker(workerUrl, { type: 'module', name: 'aashish-ai' });
    } catch (error) {
      // Firefox before 114 and any browser with a strict CSP land here.
      return unsupported(`The AI worker could not start (${error?.message || error}).`);
    }
    /* Which replies settle the request that asked for them, and which do not.

       `progress` and `token` are streamed and must NOT settle it — a generation
       resolves once, on `done`. `ready` is the opposite: it IS the answer to
       `prepare`. It was in the do-not-settle list, which left that promise
       pending *forever*, so `state` never left 'loading' and the model never
       finished loading in any browser, on any device. Every test passed
       anyway, because the engine tests call `ScratchLlamaEngine.load`
       directly and nothing drove this protocol at all — see
       `tests/session.test.mjs`, which is the test that would have caught it. */
    worker.onmessage = (event) => {
      const { id, type } = event.data || {};
      const entry = pending.get(id);
      if (type === 'progress') {
        onProgress?.({ stage: event.data.stage, loaded: event.data.loaded || 0,
          total: event.data.total || 0, shard: event.data.shard });
        return;
      }
      if (type === 'token') {
        entry?.onToken?.(event.data.text, event.data.index);
        return;
      }
      pending.delete(id);
      if (!entry) return;
      if (type === 'error') entry.reject(new Error(event.data.message));
      else if (type === 'done') entry.resolve(event.data.summary);
      else {
        if (type === 'ready') config = event.data.config;
        entry.resolve(event.data);
      }
    };
    worker.onerror = (event) => fail(`The AI worker failed: ${event?.message || 'unknown error'}`);
    return true;
  }

  function request(message, { onToken, signal } = {}) {
    const id = `r${nextId++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onToken });
      if (signal?.aborted) {
        pending.delete(id);
        reject(new Error('aborted before it started'));
        return;
      }
      signal?.addEventListener('abort', () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        send({ id: `a${nextId++}`, type: 'abort' });
        reject(new Error('aborted'));
      }, { once: true });
      send({ id, ...message });
    });
  }

  function send(message) {
    try { worker?.postMessage(message); } catch (error) { fail(String(error)); }
  }

  return {
    get status() { return state; },
    get reason() { return reason; },
    get config() { return config; },
    get loaded() { return lastLoaded; },

    /** Fetch, verify and decode the model. Idempotent: a second call while
     *  ready resolves immediately, and a call while loading shares it. */
    async prepare() {
      if (state === 'ready') return { config, loaded: lastLoaded };
      if (state === 'loading') return this.ready;
      if (!ensureWorker()) return { unsupported: true, reason };
      state = 'loading';
      this.ready = request({ type: 'prepare', manifestUrl, tokenizerUrl, verify })
        .then((info) => {
          state = 'ready';
          config = info.config;
          lastLoaded = { bytes: info.bytes, memory: info.memory, verified: info.verified };
          return { config, loaded: lastLoaded };
        })
        .catch((error) => {
          if (state === 'loading') fail(error.message);
          throw error;
        });
      return this.ready;
    },

    /**
     * One greedy answer, streamed.
     * @returns {Promise<{text, ids, tokens, stopReason, abstained, promptTokens}>}
     */
    generate(args, { onToken, signal } = {}) {
      if (state !== 'ready') {
        return Promise.reject(new Error(`generate() while ${state}`));
      }
      return request({ type: 'generate', ...args }, { onToken, signal });
    },

    /** §6.4's one dispose path: terminate the worker. That, and only that,
     *  returns the model's memory. */
    dispose() {
      if (!worker) return;
      try { worker.postMessage({ id: 'bye', type: 'dispose' }); } catch { /* gone already */ }
      worker.terminate();
      worker = null;
      pending.clear();
      state = 'idle';
      config = null;
      lastLoaded = null;
    },
  };
}
