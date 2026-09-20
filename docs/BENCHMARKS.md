# BENCHMARKS — Aashish AI

Per §15: every number here carries **device, browser, method and date**. Anything not measured
is labelled ESTIMATED or NOT TESTED — never rounded up into a pass.

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
