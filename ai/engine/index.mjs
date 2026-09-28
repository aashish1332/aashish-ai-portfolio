/* ═══════════════════════════════════════════════════════════════
   ai/engine/index.mjs — the `LLMEngine` seam (§9.1, §17).

   §9.1: "Runtime decision (benchmark-driven, keep it behind an
   `LLMEngine` interface)." The interface exists so that swapping the
   runtime (wllama / ONNX Runtime Web / this file) is a one-file change and
   the chat layer never learns which one it got.

   The contract, in full:

       await LLMEngine.load({ manifestUrl, ... })     → engine
       engine.generate({ question, context, history }) → async iterator of
                                                         { id, text } chunks
       engine.dispose()                                → frees everything

   `generate` is greedy (argmax) on purpose: §5.1 asks for
   "greedy / low-temperature decoding", and determinism is a *feature* of
   an assistant that answers from a fixed knowledge base — the same
   question must not give a visitor a different set of facts. It also
   makes the whole path testable, which sampling would not.

   Two things this file deliberately does not do:

   * **No streaming into the DOM.** It yields chunks; `ai/ui/chat.mjs`
     decides how to paint them (§10: one coalesced write per ~50–80 ms).
   * **No guard, no templates, no fallback text.** A model that produces
     nothing useful is the caller's problem to report honestly; an engine
     that quietly invents a sentence is exactly what §2 N5 forbids.
   ═══════════════════════════════════════════════════════════════ */

import { ByteLevelBPE, loadTokenizer } from './bpe.mjs';
import { LlamaEngine } from './llama.mjs';
import { manifestIssues, loadWeights, parseManifest } from './manifest.mjs';
import { abstainId, defaultStopIds, fitToBudget, frame } from './prompt.mjs';

/* How often the generator hands the event loop back, in forwards.

   It has to be a MACROTASK (`setTimeout`), not `await Promise.resolve()`.
   §10's Stop reaches this engine as a `postMessage` from the main thread, and
   a message is a task: it cannot be delivered while an await-chain of
   already-resolved promises owns the loop. MEASURED (2026-09-28): a 50-step
   loop that awaits `Promise.resolve()` every 16 steps left a `setTimeout(…, 0)`
   scheduled before it un-run; the same loop with one `setTimeout` in the middle
   ran the timer during the loop.

   That mattered: the decode loop's `signal?.aborted` check could never fire in
   the worker — the abort message was still in the queue — so Stop stopped the
   *answer* while the worker ground on. A Retry then queued behind the whole of
   the abandoned generation, which is exactly what the P2 probe saw on
   2026-09-28: `retry()=true`, the answer eventually arrived, and it took more
   than the probe's 180 s to start streaming. */
const COOP_EVERY = 16;
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The interface. Subclasses implement `generate`; `load` is a static. */
export class LLMEngine {
  get config() { throw new Error('LLMEngine.config is not implemented'); }
  // eslint-disable-next-line require-yield
  async *generate() { throw new Error('LLMEngine.generate is not implemented'); }
  dispose() {}
}

/** llama.cpp-style greedy decode over our own weights. */
export class ScratchLlamaEngine extends LLMEngine {
  constructor({ model, tokenizer, manifest, weights, bytes, verified, baseUrl }) {
    super();
    this.model = model;
    this.tokenizer = tokenizer;
    this.manifest = manifest;
    this.weights = weights;
    this.bytes = bytes;
    this.verified = verified;
    this.baseUrl = baseUrl;
    this.stopped = false;
  }

  /**
   * @param {object} opts
   * @param {string} opts.manifestUrl  e.g. 'ai/model/aashish-ai-1/manifest.json'
   * @param {string} [opts.tokenizerUrl]  defaults to the manifest's link
   * @param {Function} [opts.fetchImpl]  injectable for tests and for the worker
   * @param {Function} [opts.onProgress]  `{loaded, total, stage}`
   * @param {boolean} [opts.verify]  sha256 every shard (default true)
   */
  static async load({
    manifestUrl, tokenizerUrl, fetchImpl = fetch, onProgress = null, verify = true,
  }) {
    const started = Date.now();
    const report = (stage, extra = {}) => onProgress?.({ stage, ...extra });

    report('manifest');
    const response = await fetchImpl(manifestUrl);
    if (!response.ok) {
      throw new Error(`manifest fetch failed: ${response.status} ${manifestUrl}`);
    }
    const manifest = parseManifest(await response.json());
    const issues = manifestIssues(manifest);
    if (issues.length) {
      throw new Error(`manifest is unusable: ${issues.join('; ')}`);
    }

    const baseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    const tokUrl = tokenizerUrl ?? `${baseUrl}${manifest.tokenizer.file}`;
    report('tokenizer');
    const tokenizer = await loadTokenizer(tokUrl, { fetchImpl });
    if (manifest.tokenizer.vocabSize !== undefined
        && tokenizer.vocabSize !== manifest.tokenizer.vocabSize) {
      throw new Error(`tokenizer has ${tokenizer.vocabSize} tokens, the manifest says ` +
        `${manifest.tokenizer.vocabSize} — refusing to pair mismatched versions (§9.3)`);
    }

    report('weights', { loaded: 0, total: manifest.shards.reduce((n, s) => n + s.bytes, 0) });
    const { weights, bytes, verified } = await loadWeights(manifest, {
      baseUrl, fetchImpl, verify,
      onProgress: ({ loaded, total, shard }) => report('weights', { loaded, total, shard }),
    });

    const model = new LlamaEngine(manifest.config, weights);
    report('ready', { loaded: bytes, total: bytes, ms: Date.now() - started });
    return new ScratchLlamaEngine({
      model, tokenizer, manifest, weights, bytes, verified, baseUrl,
    });
  }

  get config() { return this.manifest.config; }

  /** Rough resident extra: weights as shipped + the KV cache, in bytes.
   *  §15.4: this is a *calculation* from the format, not a measurement —
   *  the measured numbers live in docs/BENCHMARKS.md. */
  get memoryEstimate() {
    return {
      weightsBytes: this.bytes,
      kvCacheBytes: this.model.kvBytes,
      logitsBytes: this.model.logits.byteLength,
      note: 'calculated from the manifest; not a measurement of the tab',
    };
  }

  setStopActive(active) { this.stopped = active; }

  /**
   * Greedy generation over the §7.4 frame.
   *
   * @returns {AsyncGenerator<{id:number,text:string}>} yields one chunk per
   *   token; `return` value carries the assembled text and why it stopped.
   */
  async *generate({
    question, context = '', history = [], rules = 'third', maxNewTokens = 96,
    stopIds = null, paceMs = 0, signal = null, onToken = null,
  } = {}) {
    const stops = stopIds ?? defaultStopIds(this.tokenizer);
    const abstain = abstainId(this.tokenizer);
    /* The window is enforced here, against the real tokenizer, by dropping the
       weakest evidence rather than by failing: see `fitToBudget`. Before it,
       an over-long prompt threw from inside `forward()` and reached the
       visitor as "the model stopped" (measured: 14 of 60 evaluation questions).
       `summary.context` is what the model ACTUALLY read, and the guard checks
       against it — a trimmed line must not be able to ground a claim. */
    const fitted = fitToBudget({
      tokenizer: this.tokenizer, question, context, history, rules,
      maxNewTokens, maxSeq: this.model.maxSeq,
    });
    const prompt = frame({ question, context: fitted.context, history: fitted.history, rules });
    const promptTokens = this.tokenizer.encode(prompt);
    if (promptTokens.length !== fitted.promptTokens) {
      /* `fitToBudget` and this encode must be the same string. They are built
         by the same `frame()`, so a mismatch means one of them changed — say
         so rather than generating from a prompt nobody budgeted. */
      throw new Error(`the fitted budget (${fitted.promptTokens}) and the prompt ` +
        `(${promptTokens.length}) disagree — the frame layout drifted`);
    }

    /* Prefill. The specials and the rules are identical tokens on every
       question (125 of a typical 135–300 token prompt), so no question ever
       pays for them; and a repeat or a same-topic follow-up shares its
       retrieved facts too, which is most of what the first pass cost. The
       cache keeps the K/V for the prefix it was last given and this feeds
       only what actually differs — measured at 35% of the wait for the rules
       alone, and close to all of it for a question asked twice
       (`npm run probe:latency`).

       The match is element-wise on the token ids (`LlamaEngine.reusePrefix`),
       so a tokenizer that merges across a seam can only shorten the skip. */
    const reused = this.model.reusePrefix(promptTokens);
    if (reused === 0) this.model.reset();
    let prefilled = true;
    for (let index = reused; index < promptTokens.length; index++) {
      /* Checked here as well as in the decode loop: the prompt is 135–512
         forwards — most of the wait — so a Stop that is only noticed at the
         first generated token still costs the visitor the whole prefill. */
      if (signal?.aborted || this.stopped) { prefilled = false; break; }
      this.model.forward(promptTokens[index]);
      if ((index - reused) % COOP_EVERY === COOP_EVERY - 1) await breathe();
    }
    // Greedy decode. The prefill above consumed the prompt, so each step
    // feeds back the token it just chose — one `forward` per generated token,
    // never a re-run of the prompt (§4's latency budget depends on that).
    const produced = [];
    let previous = promptTokens.at(-1);
    let stopReason = 'max-tokens';
    if (prefilled) this.model.rememberPrefix(promptTokens);
    else {
      /* Stopped mid-prefill. The K/V cache now holds HALF a prompt, so it must
         not be remembered: `reusePrefix` skips forwards by comparing tokens
         element-wise, and it would happily skip a prefix the model never
         actually read. Drop the cache instead — the next question pays for its
         own prefill, which is the honest cost of having asked for a Stop. */
      this.model.reset();
      stopReason = 'stopped';
    }
    for (let step = 0; prefilled && step < maxNewTokens; step++) {
      if (signal?.aborted || this.stopped) { stopReason = 'stopped'; break; }
      const id = this.model.argmax(this.model.forward(previous));
      if (id === abstain) { stopReason = 'abstain'; produced.push(id); break; }
      if (stops.has(id)) { stopReason = 'end-token'; break; }
      produced.push(id);
      previous = id;
      const text = this.tokenizer.tokenText(id);
      if (onToken) onToken({ id, text });
      yield { id, text };
      // §6.3's first degrade step is "pace generation": yielding between
      // tokens gives the GSAP ticker its frame back without changing what is
      // computed. `paceMs` is set by the governor, not by this module.
      if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs));
      else if (step % COOP_EVERY === COOP_EVERY - 1) await breathe();
    }

    return {
      promptTokens: promptTokens.length,
      tokens: produced.length,
      ids: produced,
      text: this.tokenizer.decode(produced, { skipSpecial: true }),
      rawText: this.tokenizer.decode(produced),
      stopReason,
      abstained: stopReason === 'abstain',
      /* What the model read, and what had to go to make it fit. The answer
         layer reports the first (its `sources`) and the second is a
         measurement of how tight the 512-token window really is. */
      context: fitted.context,
      contextTokens: fitted.contextTokens,
      droppedContextLines: fitted.droppedContextLines,
      droppedHistoryTurns: fitted.droppedHistoryTurns,
    };
  }

  /** §6.4: one dispose path. The weights are plain arrays (no wasm), so
   *  dropping the references is the whole job — but it has to be *stated*
   *  so the caller can rely on it. */
  dispose() {
    this.stopped = true;
    this.weights.clear();
    this.model.reset();
    this.disposed = true;
  }
}

/** The seam: one place that decides which runtime is used. */
export function createEngine(kind = 'scratch-llama') {
  switch (kind) {
    case 'scratch-llama':
      return ScratchLlamaEngine;
    default:
      throw new Error(`unknown engine kind ${kind} (§9.1 keeps this decision in one place)`);
  }
}

export { ByteLevelBPE, LlamaEngine };
