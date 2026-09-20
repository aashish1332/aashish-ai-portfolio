# BENCHMARKS — Aashish AI

Per §15: every number here carries **device, browser, method and date**. Anything not measured
is labelled ESTIMATED or NOT TESTED — never rounded up into a pass.

---

## Production build — dev/prod split (2026-09-20)

**Method:** `npm run build` (node v24.13.0), sizes by byte count on disk.

| Metric | Value |
|---|---|
| Shipped files | **26** |
| Bundle size | **354,105 B** total |
| `knowledge.json` (stripped) | 24,326 B, sha256 `e6efeabf4c9ee4bc…` |
| Withheld values in the bundle | **0** — id kept as metadata, value gone |
| Files publishing the value deliberately | 2 (`index.html`, `js/terminal.js`) — allow-listed, reported per build |
| Dev tooling in the bundle | **0** |
| Relative imports that do not resolve | **0** |

For comparison (§4 budgets): the AI chunk itself is 43 KB gz, so the
production bundle is dominated by the film's JS/CSS, not by the assistant.

---

## P3 — tokenizer + model code (2026-09-20)

**Device:** R1 (Intel HD 520, 4 threads, 8 GB, Windows). **Method:**
`python inference/count_parameters.py --config all`, `python -m ai.tokenizer.train`,
`python -m ai.tokenizer.fertility`, `python -m training.scripts.prepare_data`,
`python -m training.scripts.train_smoke --pipeline-only` — all on the committed
fixture. Timings are wall-clock on this machine, not a benchmark rig.

### Model arithmetic (§7.1) — analytic, and the reason why

| Config | Params | §7.1 band | Verdict |
|---|---|---|---|
| **A** | **37,890,560** | 30–50M (~40M preferred) | ✅ met |
| lite (contingency) | 17,701,248 | ~17M | ✅ met |
| smoke (§7.5) | 1,820,352 | 1–3M | ✅ met |

§7.1's own estimate is "~37.9M"; the exact integer is 37,890,560. The gap is
that the spec's hand arithmetic does not itemise the two RMSNorms per layer
(10 × 2 × 512) plus the final norm. Pinned in `test_model_schema.py`.

**`torch: NOT INSTALLED`** — so the *materialised* cross-check (build the
module, compare `sum(p.numel())` and every state-dict shape) did not run
here. The analytic count stands on its own, but it is one derivation, not
two, on this machine. Recorded as UNVERIFIED rather than reported as a pass.

| Quantity | Measured (analytic) | §7.1 claim | Verdict |
|---|---|---|---|
| KV cache per token, config A, fp16 | **10.00 KB** | ~10 KB/token | ✅ met |
| KV cache at ctx 1024 | 10.0 MB | ~10 MB | ✅ met |
| Prefill FLOPs at ctx 1024 | 39.8 GFLOP | — | estimate, no kernel overhead |
| Decode FLOPs/token at ctx 1024 | 0.08 GFLOP | — | estimate |
| State-dict keys, config A | 93 | HF `LlamaForCausalLM` layout | ✅ key set asserted in tests |

### Tokenizer (§7.2)

| Metric | Value |
|---|---|
| Vocab (dev fixture) | **1,024** (6 special tokens + 63 placeholder tokens + 256 bytes + merges) |
| Max learnable vocab on this fixture | 1,935 — **bounded by distinct word forms, not corpus size** |
| Artifact size | `tokenizer.json` 66,667 B raw / **10,291 B gz** (`meta.json` 1,993 B / 968 B gz) |
| Contract checks | 6 special tokens present · **63/63 placeholders atomic** · 7/7 exact round-trips (EN/HI/Hinglish/SQL/URL/emoji) |

| Fertility (vocab 1,024) | tok/word | chars/tok |
|---|---|---|
| en | 2.46 | 2.52 |
| hi | **4.71** | 1.18 |
| hinglish | 2.69 | 2.24 |
| tech | 4.35 | 1.69 |
| url_email | 15.50 | 1.39 |

All but English are over the 2.5 tok/word budget at this vocab size. That is
expected at 1k and is the input to the P4 decision — it is **not** evidence
against 16k, because the fixture's Hindi share is synthetic and too small to
merge.

### Corpus pipeline (§7.3)

| Metric | Value |
|---|---|
| Fixture | 17,402 lines / 3.2 MB, generated (seed 20260920) |
| Kept after filters | 17,265 (137 dropped: near-duplicate) |
| Language mix | en 8,901 · hi 4,191 · hinglish 4,173 |
| Placeholders applied | 6 public facts; 1 withheld fact excluded from the masking set |
| Leakage | clean — 0 exact, 0 near, across a 2 % val split |
| Shards | train 749,590 tokens / 68 files · val 16,801 tokens / 2 files · `uint16` |
| End-to-end `prepare_data` | 20.2 s (clean → dedupe → tag → tokenise 17k lines → 70 shard files) |
| Tokenizer training (3.2 MB, 1024 vocab) | 3.6 s |

### What P3 changed about the plan

* **Vocab ceiling is lexical, not volumetric.** Measured: the same 80-line
  corpus tops out at 802 merges whether repeated ×4 or ×16; 44 lines with
  348 distinct word forms reach 1,228. Repetition buys nothing, so P4's
  12–16k must come from *distinct vocabulary*, and the trainer now fails
  loudly instead of emitting a smaller vocab than requested.
* **Hindi needs real corpus volume to merge at all** — the seed fixture
  cannot settle the §7.2 vocab question, and now says so.

---

## P2 — chat shell + governor (2026-09-20)

**Device:** the only reference profile available so far is **R1** (Intel HD 520, 4 threads, 8 GB,
Windows). Headless Chrome 153 via `puppeteer-core`, `--use-gl=swiftshader`.
**Method:** `node dev-ai-probe.js` (desktop 1280×800) and `MOBILE=1 node dev-ai-probe.js`
(390×844); sizes by `gzip -c | wc -c` on the shipped files.

### Budgets (§4)

| Budget | Target | Measured | Verdict |
|---|---|---|---|
| AI assets requested before the click | **+0** | **0** — only `js/ai/launcher.js` (1.0 KB gz) | ✅ met |
| Launcher | ≤ ~2 KB gz | **958 B gz** (2,281 B raw) + 1.8 KB raw CSS for the button | ✅ met |
| Chat UI chunk (all modules + `knowledge.json`) | ≤ ~150 KB gz | **43 KB gz** (44,878 B over 9 files, largest `answers/quick.mjs` 10.7 KB) | ✅ met |
| Worker created before the click | none | none | ✅ met |
| `knowledge.json` fetched before the click | no | no | ✅ met |

The whole assistant is **9 requests / 43 KB gz**, all after the click. First open on a phone
therefore costs less than one hero image, and nothing is re-fetched on a second open within a
session (module graph + knowledge base are held).

### The pre-click assertion, in full

The probe records **every** request and every worker the page creates, then fails if anything
matches `/ai/`, `.wasm`, `.gguf`, `.onnx`, `knowledge.json`, `model`, `tokenizer` or `voice`
before the first click. Result on both viewports: the only match is the launcher itself, which
§4 explicitly excludes. `window.PortfolioAI` is `undefined` and no `.ai` node exists in the DOM
until the click, so there is nothing to find even by hand.

### Tiers (§6.2) — as chosen from real probes, not guessed

| Profile | Probe | Tier chosen | Correct? |
|---|---|---|---|
| Desktop, headless, software GL | worker ✓ wasm ✓ **SIMD ✓** 4 threads, storage OK | **T2 · STANDARD** | yes — CPU-only desktop |
| Phone emulation 390×844 | coarse pointer, 4 threads | **T1 · LITE** | yes — §6.2 puts mid phones on T1 |
| Any device **without SIMD** | `wasmSimd:false` | **T0** | yes, and this is the bug that was fixed — see below |

### Frame health (§6.3) — **INCONCLUSIVE, and reported as such**

The A/B (panel closed vs open) is computed, but in headless software GL the film renders at
**0.6–1.8 fps** (566–1,817 ms/frame), so every ratio is ~1.0 for the trivial reason that the
page is GPU-starved. The probe prints `INCONCLUSIVE — needs the §15 reference profile on real
hardware` instead of a fabricated pass.

**NOT TESTED:** the §4 target "median FPS drop ≤ 10 %, p95 ≤ 1.5× baseline" on a real GPU, the
4×/6× DevTools CPU throttling profiles, `longtask`/`long-animation-frame` observation, and any
real phone. The ladder's *logic* is unit-tested (`tests/governor.test.mjs`), its *cost* is not
measured.

---

## Bugs these measurements exposed

Both were invisible in unit tests and in normal operation, and both would have shipped:

| | Bug | Consequence |
|---|---|---|
| **1** | `SIMD_PROBE_BYTES` was a malformed wasm module (`v128.const` with five immediates instead of sixteen) | `hasSimd()` returned **false on every engine**, so `chooseTier()` forced **every device on earth to T0** — the model could never have run anywhere. Caught by reading the probe's tier output ("T0" on an 8-thread desktop), fixed, and now guarded by a test that validates the bytes against V8 itself |
| **2** | `window.Director` was **never assigned** (only a script-scoped `const`) | Every `window.Director && Director.getLenis()` guard in the project read `undefined` and skipped its scroll lock — the AI panel's, lens mode's, and the terminal's. The guard made a dead path look defensive. Now exposed like `window.Terminal`, and the probe verifies `lenis.isStopped === true` while the panel is open instead of trusting the call |

---

## P0 baseline (for comparison, 2026-09-19)

| Metric | Value |
|---|---|
| Initial load | 51 requests · 606.9 KB transferred · 472.2 KB JS · LCP 972 ms |
| Boot long tasks | 3 long tasks, max 1847 ms, sum 2391 ms (TBT proxy, ESTIMATED) |
| Scripted 30 s scroll | median 30.4 ms (32.9 fps) · avg 31.0 fps · p95 49.5 ms · 96.8 % frames > 20 ms |
| Governor beyond the scroll | tier 4 · SURVIVAL · res 50 % · mirror 192 px |

P2 adds **+0 requests** to that baseline before the click, so the initial-load numbers are
unchanged by construction (the launcher's 1.0 KB gz is the only addition).
