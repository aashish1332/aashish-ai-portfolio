# BENCHMARKS — Aashish AI

Per §15: every number here carries **device, browser, method and date**. Anything not measured
is labelled ESTIMATED or NOT TESTED — never rounded up into a pass.

---

## §15 protocol, rolled up (written 2026-09-28)

§15 asks for five things. This table says where each one landed; every claim
points at a lane in this file (or names why it does not exist).

| §15 step | Status | Where |
|---|---|---|
| 1. Baseline before any change — JS bytes + request count, Lighthouse (LCP/TBT), 30 s scroll (median, p95, dropped > 20 ms, main-thread busy %) | **MEASURED**, with two labels carried from `metricProvenance`: main-thread busy % is **ESTIMATED** (long-task ms / wall ms, excludes sub-50 ms tasks) and **Lighthouse TBT is NOT TESTED** (no `lighthouse` CLI run; `tbtProxyMs` is a long-task sum, not Lighthouse's TBT) | `docs/BASELINE.json` · "P0 baseline" below |
| 2. Reference profiles — R1 laptop · R2 DevTools 4×/6× (+ Slow 4G for downloads) · R3 mobile emulation · R4 real Android/iPhone | **R1–R3 MEASURED; R4 NOT TESTED.** The throttles ran at **4× and 6× CPU**; **Slow 4G was not applied** — download behaviour was measured as first-visit size and the offline-after-cache path instead, not under bandwidth throttling | "§4's reference profiles" below · §9.3 cache lane · checklist §D |
| 3. After-states — panel closed · chat idle · generating · voice active, plus a **10-minute Proactive soak** and **5 open/close cycles** | **MEASURED** (the soak ran 2026-09-22, microphone active) | "Resource + lifecycle (§15.3)" and "Lifecycle, and the 10-minute Proactive soak" below |
| 4. Memory honesty — say what the heap figure covers, and carry manual Task Manager / Web Inspector numbers | **MEASURED and labelled** — every heap figure is the Chromium **JS heap only** (wasm and GPU are invisible to it); the manual cross-check is **NOT TESTED** | "What the heap numbers do not cover" below |
| 5. AI bundle size · model download size · WebGPU vs WASM · mobile behaviour · voice model sizes · STT/TTS latency | see the item-by-item table below | — |

### §15.5's list, item by item

| Item | Status | Value / where |
|---|---|---|
| AI bundle size | MEASURED | §4 lanes: chat **code** chunk **75,181 B gz = 48.9 %** of budget (`npm run bundle` → `chatChunkGz`, 2026-09-29 re-run; 72,777 B gz before §0 rule 4's status disclosure); worker-only module **13,382 B gz** |
| Model download size | MEASURED | **5,144,354 B** raw (weights + tokenizer + manifest) · **4,816,231 B gz** on the first visit (`npm run bundle` → `firstUseGz`, **11.5 %** of §4's 40 MB) · **0 B on the second visit** (§9.3 cache) |
| WebGPU vs WASM behaviour | **NOT TESTED as speed**; investigated on paper (§19) | this box runs scalar JS ~10× below its own spec, so the comparison cannot be made here; no WGSL or wasm-SIMD kernel was written. `probeWebGPU()` reports the capability and **accelerates nothing** |
| Mobile behaviour | **MEASURED under emulation only** (390×844, **60/60** on the 2026-09-29 re-run of `MOBILE=1 node dev-ai-probe.js`) | a **real phone is NOT TESTED** |
| Voice model sizes | **N/A — nothing is shipped.** TTS is the browser's `speechSynthesis`, STT is the platform recogniser, VAD is hand-written energy code (`ai/voice/vad.mjs`). There is no model file under `ai/voice/` | — |
| STT/TTS latency | **NOT TESTED** | no microphone and no audio output here; headless Chrome only ever reaches the refusal path |

---

## The retrieval gate, calibrated (§8.2/§8.4) — 2026-09-22

**Method:** `npm run calibrate` → `docs/CALIBRATION.json`. It sweeps
`MIN_TOP_SCORE` from 0 to 15 in 0.05 steps and re-answers **every** executable
case in `evaluation/portfolio_tests.json` at each step, then does the same for
every alias the knowledge base declares about itself (290 probes). No number
below is inferred from reading the code.

### What the sweep found: the evaluation file cannot calibrate this gate

| Finding | Number |
|---|---|
| Executable cases | 56 of 60 (4 synthetic need a model) |
| Cases whose answer CHANGES with the threshold | **7** |
| Cases that reach the gate at all | 7 — the other 49 are answered by templates or intent rules that never consult it |
| Questions that must not be answered but are refused BY the gate | **0 of 11** |

So the gate has a measurable ceiling and **no measurable floor**: every
must-not-answer question either shares no vocabulary with the base (scoring
0.000) or is declined by something else first — an intent rule, or the
withheld-facts list. The two phone questions score **12.9 and 11.2**, far above
any candidate threshold, which is only possible because the decline never asks
the gate for permission. That is measured, not assumed: the sweep runs to 15,
and a case that still passes with the gate wide open is a case the gate never
saw.

| Bound | Value | Source |
|---|---|---|
| **Ceiling (hard)** | **4.647** | the weakest alias a fact declares about itself (`"who is he"` → `person.name`) |
| Floor | **NOT MEASURED** | nothing in the corpus is kept out by the gate |
| Shipped value | **1.0** | inside every measured bound |

Every threshold in `(0, 4.647]` behaves **identically** on this corpus, which
is exactly why an unmeasured `1.0` survived: the gate is load-bearing for 7
answerable cases and for none of the negatives. The value was therefore left
where it was rather than moved to a midpoint that rests on a boundary of "our
negatives all score zero" — and the ceiling is now recomputed **from the data
by `tests/retrieval.test.mjs`**, so a constant edited without re-running the
sweep fails the suite and names the command.

### Two real defects the sweep found, and what they cost

| # | Defect | Measured before | After |
|---|---|---|---|
| **CAL-1** | Retrieval inherited the **language detector's** tokenizer, which drops digits on purpose. `tokenize('8.28')` is `[]`, so every number in the base was invisible — including the CGPA fact's own declared alias `"8.28"` | `"8.28"`, `"87.6"`, `"6.93"` → **no hits at all**; asking "is it 8.28?" was refused | → `ach.lpu-cgpa` (5.53), `ach.class12` (5.36), `ach.minor-ai-cgpa` (5.78) |
| **CAL-2** | A **declared** alias whose every token is a function word ("who is he", "kaun hai" on `person.name`) was deleted by the stop set on one side and matched nothing on the other. In the answer layer the same set made `[].some(...)` silently `false`, so the fact path refused it too | "who is he" → *"I don't have that in my portfolio yet."* | → *"My name is Aashish Kumar."* (`person.name`) |

The index and the query were also being tokenized by two different expressions.
They are now one function (`rawTokens`), because two tokenizers that agree today
are the same class of bug as the shard/tokenizer mismatch P4 already refuses to
train through.

Alias routing, as a precision measure over the base's own declarations:

| | Before | After |
|---|---|---|
| Declared aliases probed | 230 | 230 |
| MISROUTED (unambiguous alias that does not reach its own fact) | **14** | **0** |
| Token-ambiguous (two facts claim the same word — reported, not "fixed") | 55 | 57 |

The residual list is honest by construction: `"cgpa"` is claimed by two facts
and the base deliberately resolves that in **data** (R6), and a glue-only alias
routes through the intent layer rather than retrieval. Both are recorded in the
artefact instead of being tuned away.

### NOT MEASURED

* **Visitor traffic.** This is the corpus we chose to be judged on, not a
  sample of real questions. No recall claim is made from it.
* **The model path.** `lowConfidence` exists so that P5 can abstain *without*
  calling a model; that is where the missing lower bound will come from, because
  crossing it then costs an inference. Until a model exists, this half of the
  band is open and is labelled as open.
* **"who is this"** — still abstains, because the base does not declare it.
  That is a data question, not a threshold one, and it is left visible.

---

## Resource + lifecycle (§15.3) — 2026-09-22

**Device:** R1 (Intel HD 520, 4 threads, 8 GB, Windows) — **software GL**
(SwiftShader), which is the only renderer available here and is not what a
visitor has. **Method:** `node dev-resource-probe.js` (headless Chrome 153 via
`puppeteer-core`, 1360×860, `npm run probe:resources`), 3 s observation window
per state, `HeapProfiler.collectGarbage` before every heap reading; raw output
in `docs/RESOURCES.json`, the panel-closed control in
`docs/RESOURCES-CONTROL.json`.

**What the heap numbers do not cover:** they are the Chromium JS heap only
(CDP `Performance.getMetrics`). wasm and GPU memory are invisible to it, which
is why this is a §15.3 lane and not a total-memory claim.

### The four states, plus close, plus 5 reopen cycles

| State | heap | DOM nodes | listeners | median frame | p95 | long tasks |
|---|---|---|---|---|---|---|
| 1 panel closed | 6.7 MB | 1,493 | 127 | 23.1 ms | 28.5 ms | 58 ms (the film's own) |
| 2 chat idle | 6.8 MB | 1,538 | 140 | 24.2 ms | 27.6 ms | **none** |
| 3 after five answers | 7.3 MB | 1,605 | 138 | 23.7 ms | 26.6 ms | **none** |
| 4 hands-free | 7.3 MB | 1,616 | 138 | 23.5 ms | 29.0 ms | **none** |
| 5 closed again | 7.4 MB | 1,616 | 138 | 20.5 ms | 24.2 ms | **none** |
| 5 × open/close | — | 1,616 → 1,616 | 138 → 138 | — | — | — |

| Claim | Measured |
|---|---|
| Heap growth per reopen | **0 MB/cycle** over 5 cycles |
| DOM nodes leaked per reopen | **0** (1,616 → 1,616 across 5 reopens) |
| Listeners leaked per reopen | **0** (138 → 138) |
| Transcript cost per answer | **13.4 nodes** (bounded, and it is transcript growth, not a leak) |
| Workers outliving a close | **0 → 0** |
| Extra AI heap, desktop budget ≤ 300 MB | **0.8 MB** |
| Median FPS drop with the panel open, ≤ 10 % | **1.7 %** (and −8.5 % … +6.4 % across runs — the sign is not stable on a software renderer) |
| First open | import + build **221–405 ms**, knowledge + capability probe **285–722 ms** |

### The reopen leak, before and after

`close()` reset `state` to `'closed'`, and `open()` used `state === 'ready'` as
its "already open" test — so **every reopen after the first re-ran
`injectStyles()` and `build()` and appended a second panel**, orphaning the
previous one in the DOM.

| Metric | Before | After |
|---|---|---|
| DOM nodes per reopen | **+87** | **0** |
| Listeners per reopen | **+16** | **0** |
| Heap per reopen | +0.05 MB (noisy, never the visible symptom) | 0 MB |

`built` now means "the shell exists" and `loadOutcome` remembers the one-time
load, so a reopen only reveals the shell — and the frame-health monitor is
re-armed idempotently, because `close()` disarms it.

### The long task that was the AI's fault, and the one that was not

The §4 budget is ≤ 50 ms tasks **during AI interaction**. Two different things
were being reported as one number:

| | Source | Evidence |
|---|---|---|
| ~87 ms tasks | **the film itself** | 4 × 3 s windows with the panel **never opened**: worst 87–91 ms. A software-GL film does this on its own |
| **1,221–1,794 ms** | **the AI's degrade ladder** | CPU profile inside the task: **1,105 ms of it in `getProgramInfoLog`** (WebGL shader compile), 0 ms in `ai/*`; GL program links jump **31 → 52** during the session |

The causal chain, each link measured rather than argued:

1. The §6.3 ladder was armed for the panel's whole **lifetime**.
2. Frame health on this device is always "slow" (the film's frames are ~23–33 ms,
   over `slowFrameMs` 24), so with `minSamples` 30 + `dwellMs` 1,500 it reached
   **rung 3 at ≈ 4.5 s** after open — while the visitor was reading the greeting.
3. Rung 3 calls `Film3D.setQuality('low')`, which switches the render path
   (`composer.render()` → `renderer.render()`) → three.js invalidates its
   program cache → **21 programs relink**.
4. Under SwiftShader that relink is **1.2 s of blocked main thread**.

Proven by isolation (`NO_SCENE_DEGRADE=1`, which records `setQuality` calls
instead of applying them): the ladder **did** ask for `low` (and later
`normal`), and with the hook inert the same run links **31 → 31** programs and
the worst AI task is **58 ms**.

| | Before the gate | After the gate |
|---|---|---|
| GL programs linked during an AI session | **31 → 52** | **31 → 31** |
| Worst long task in AI windows | **1,221 ms** | **0 ms** (baseline 87 ms) |
| §4 long-task verdict | FAIL | PASS, against the page's own baseline |

**The fix is a rule, not a delay:** the ladder exists to make room for the
assistant's own work, so it is armed around that work (`whileWorking`) instead
of around the panel being open, and going idle hands the scene back. Rung 3
with nothing running buys nothing and costs a second of frozen page. The
governor's unit tests pin both directions, and the gate was mutation-tested
(removing it fails 7 tests).

### Instrument bugs found while measuring (each one changed a conclusion)

| # | Bug | What it would have reported |
|---|---|---|
| **RSP-1** | `qualityCalls` was read 3.6 s after open, but rung 3 fires at ≈ 4.5 s | "the ladder never fired" — a **false negative** that would have sent me looking for another cause. Caught by contradicting the GL-link count |
| **RSP-2** | CDP profile timestamps were assumed to be on `performance.now()`'s clock | page-clock offsets of −1.79e12 ms. The profile is now bracketed by the page's own clock and mapped proportionally |
| **RSP-3** | Long tasks were only ever summed per state window | "worst 1,794 ms" with no way to name it. Attribution per task (container + the top functions **inside that interval**) is what turned it into `getProgramInfoLog` |

### NOT MEASURED (the honest gaps)

* ~~**The 10-minute Proactive soak has not been run.**~~ **Superseded 2026-09-22:**
  it was then run, with the microphone active — see *"Lifecycle, and the
  10-minute Proactive soak"* below. At the time of this lane the probe's
  `SOAK_MS=600000 CYCLES=5` path existed but had not been exercised, and with no
  microphone in the build a soak would have measured an idle panel.
* **No real GPU.** Every number above is software GL, where shader compilation
  is pathologically slow. The 1.2 s relink is *expected* to be far smaller on
  real hardware — **and that is an expectation, not a measurement.**
  **Superseded 2026-09-27:** the GPU was reachable from `headless: 'new'` all
  along (see *"Frame health, on the real GPU"*); the resource probe had already
  been using it, and the §4 reference profiles were then run.
* **No phone, no screen reader, no other tabs.**
* **A 240 s non-response, once.** On the pre-fix path (ladder armed for the
  panel's lifetime) two runs failed to return a CDP call within the 240 s
  protocol timeout at the first open; the probe could not complete. Not
  reproduced on the fixed path, **not explained**, and noted rather than
  claimed as a symptom.

---

## Voice + section-following (§10/§12) — 2026-09-21

**Method:** `node dev-anchor-probe.js` against the real portfolio on
`localhost:5577` (headless Chrome, desktop 1280×800) and
`python -m unittest tests.py.test_model_torch` on torch 2.14.0+cpu.

### Anchor resolution — content, after the page was edited

The probe asks seven questions, records the section each resolves to, then
**renames a whole scene, moves it to the end, strips its `data-ai-topics`, and
moves one project into a scene of its own** — and asks again.

| Claim | As shipped | After the edit |
|---|---|---|
| Questions resolving to a real section | **7/7** | **7/7** |
| Projects → | `#scene-work` | a section still naming 2 of 3 |
| The moved project → | `#scene-work` | its **new** section, found only there |
| Contact → | `#scene-end` | `#scene-end` |
| CGPA, certificates → | `#scene-story` | `#scene-story` |
| Skills → | `#scene-credits` | `#scene-credits` |

| Metric | Value |
|---|---|
| Resolution cost | **14.6–29 ms** per call (20-call average per run) — inside §4's 50 ms task budget |
| Elements walked | bounded at 800; no layout read, so no forced reflow |
| Hands-free scroll | `scrollY 0 → 5059` with nobody clicking |
| Page errors | 0 |
| Verdict | **34/34 checks** |

### Is the answer on screen, or did the page merely move?

"The page moved" was the only claim measured, and it is the weaker one: the
move goes through `Director.scrollTo` on the **section**, so an element inside
a tall pinned scene can be off-screen while `scrollY` rises. This measures the
anchored element's own rectangle against the viewport, once the scroll has
settled.

| Claim | As shipped | After the edit |
|---|---|---|
| The anchored element is inside the viewport | **7/7** — each resolves to a section measuring `800 px` at `top=0`, i.e. exactly one viewport | **6/7** |
| The one that is not | — | the projects card moved into `#scene-appendix` resolves **correctly** into a section **the film has no layout for**: the card measures `0×0`, so there is nothing on screen to show. Reported as that, not as a pass |

**Two instrument bugs were found by running this, and both would have been
published as findings about the page.** First, waiting a fixed 2.6 s for a
smooth Lenis scroll: a target can be 18,000 px away and headless software GL
runs the film well under 1 fps, so the wait measured "has not arrived yet" and
reported it as "the visitor cannot see it" — two runs of unchanged code gave
**7/7 and 4/7**. It now polls until the position stops changing. Second, and
worse: exposing the anchored element on the shell's `lastAnchor` snapshot put a
DOM node into the object `page.evaluate` returns by value, which makes the
whole snapshot unserializable — puppeteer returns `undefined` instead of
raising, so every anchor read as "nothing found". The snapshot stays pure data
and the element is reached by a call inside the page.

**A third instrument bug, found 2026-09-27, and this one was measuring the
wrong moment entirely.** The page is moved in `finish()` — when the answer
*ends* — but `lastAnchor` is set synchronously *before* generation starts, so
the probe fired `ask()` and then watched the scroll. While answers were
templates that was about a second of work and the check passed; the moment
every answer became a model generation of seconds-to-tens-of-seconds it began
measuring a page nobody had asked anything of, and reported `scrollY 0 → 0` —
identically on the source tree and on the built bundle. The same race sat in
the visibility phase, whose `settle()` returns as soon as the position has
been stable for ~600 ms, i.e. immediately.

Two fixes, and one distinction that matters more than either. The probe now
waits for a **new answer** (object identity on `model.last`) and then for the
scroll it causes, and `settle()` only accepts stability *after the page has
actually moved*. And the assertions now depend on the **kind** of turn, because
the two correct behaviours are opposite: a model answer moves the page to where
it came from, and a refusal moves nothing at all — "the panel made no claim and
must not move the page to where a claim it did not make came from"
(`ai/ui/chat.mjs`). Requiring a move unconditionally scored correct refusals as
anchor failures, and with a checkpoint that answers badly most turns *are*
refusals.

Verified after the fix, against the **built bundle** (`AI_BASE`):
`an anchor was found for every question 7/7`, every landing assertion correct,
`hands-free: the answer moved the page kind=model, scrollY 0 → 14609`, one
visibility measurement at `800/800 px of the element in view, in #scene-story`,
resolution cost `10.60 ms/call` (§4's budget is 50 ms), 0 page errors. The full
7×2 visibility sweep was **not** re-run — it needs ~14 generations and this box
timed out at 420 s — so the `7/7 / 6/7` table above is from the earlier runs
rather than re-measured today. `PROBE_MAX_VIS=n` and
`PROBE_SKIP_VISIBILITY=1` exist so a fix like this can be checked without a
ten-minute probe.

### Training gates, CPU smoke (1.82M params)

| Metric | Value |
|---|---|
| `loss decreases` | **PASS** — 6.6847 → 4.3151 over 50 steps (windowed verdict) |
| Throughput | **1,335 tokens/s** (batch 4 × block 128), 19.2 s for 50 steps |
| `resume verified` | resumed from `latest.pt` at step 50 with 50 loss-history entries and 27,648 tokens consumed; continued to a PASS (6.6847 → 4.1782) |
| Checkpoint pruning | `[30, 40, 50]` → `[40, 50, 60]` |
| Materialised param count | **1,820,352** over 39 state-dict keys, matching the HF key set |

Device note: **CPU, not a T4.** These verify the loop, the objective and the
resume; they say nothing about config A on a GPU, and are not quoted as if
they did.

---

## Production build — dev/prod split (2026-09-20)

**Method:** `npm run build` (node v24.13.0), sizes by byte count on disk.

| Metric | Value |
|---|---|
| Shipped files | **27** |
| Bundle size | **387,696 B** total |
| `knowledge.json` (stripped) | 24,326 B, sha256 `205cd198ab42e6ca…` |
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

> **Superseded 2026-09-28.** The numbers in this dated P2 snapshot describe the 9-file,
> 44,878 B gz build of 2026-09-20; the voice split, §2 N4's card and §11's features have
> since moved the same measurement to **14 files / 45,194 B gz** on the click and
> **75,181 B gz (48.9 %)** for the whole code chunk. The rows are kept as the record of
> what was measured that day; the live figures are the §4 tables above.

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

**Superseded 2026-09-27** — the real GPU was reachable from `headless: 'new'` all along, and
this probe now uses it by default (`SW_GL=1` still forces software GL for the
struggling-device case). See *"Frame health, on the real GPU"* below.

## Voice input (§11) — 2026-09-22

Measured with `node dev-ai-probe.js` on **R1**, headless Chrome, software GL.
The number that matters most is the first one: turning voice on must not cost
the pre-click promise anything.

| Claim | Result |
|---|---|
| AI requests before the first click | **0**, and the list is checked *including* `ai/voice/index.mjs` |
| AI assets on first open | 12 files · no worker · no wasm · no model |
| Tier chosen on this machine | **T2 · STANDARD** → voice level `both` (push-to-talk + spoken answers) |
| Engine object constructed before the tap | **no** — `createRecognizer` builds nothing until `start()` |
| Tap, in a browser **with no microphone** | engine refused → voice off in < 1.5 s, `aria-pressed` back to `false`, `handsFree` back to `false`, the §15.3 ladder released, reason stated |
| Tap, on **the same host in a later run** — engine starts | `enabled=true`, button `aria-pressed=true`, Proactive mode on, and the disclosure bubble shown **once**, badge `VOICE ON` (*"…your audio leaves this device"*). The probe itself took this branch once; `listening=true` was then read in a one-off run of the same page |
| After Escape (panel closed) | `enabled=false` |
| Console errors · page errors · failed requests | **0 · 0 · 0** |

**Which of those two rows you get is not deterministic on R1** — the same
host, same flags, refuses on one run and listens on the next — so the probe
reports the branch it took and counts its checks per branch rather than
assuming one. That was not true before: the disclosure check was written
against a truncated string (the phrase is at character 151 of a 221-character
bubble) and **could never pass**, which went unnoticed because the refusal
branch ran instead for the whole of §11. Both branches now carry three checks
and the probe prints its own total (**26/26** at the time; **46/46** on the
2026-09-27 re-run, which is a larger check set — the tallies are not comparable
across revisions, and each is reported with its date for that reason). See
PROGRESS §11.

**NOT TESTED, and this is the honest limit of the above:** a **live
microphone**. Headless Chrome ships `webkitSpeechRecognition` and has no
microphone, so what was measured is the *refusal* path — which turned out to
be a real bug (a dead engine used to leave the button lit and the frame ladder
armed, see PROGRESS §11 VOC-2). The listening path, and everything about
continuous mode, is verified with doubles only. No claim here rests on a human
having spoken to it.

### Lifecycle, and the 10-minute Proactive soak (`npm run probe:resources`)

The soak that §15.3 lists as never run has now been run — with the microphone
**active**, which is what a Proactive soak was always supposed to mean. A stub
engine stands in for Chrome's (`dev-resource-probe.js`): headless Chrome's real
one can only ever be observed refusing, so this measures the lifecycle *around*
a listening engine, and the transcript is a string the probe made up. Nothing
below is a claim about hearing.

| Claim | Result (R1 · headless Chrome · 600 s soak · GPU · **continuous** mode, level `all`) |
|---|---|
| 10 minutes listening, mic active | **0 MB heap · 0 nodes · 0 listeners** (7.7 → 7.7 MB, 1675 → 1675, 139 → 139) |
| utterances delivered during it | **36** — and **0** bubbles (`22 → 22`): unaddressed speech is not a question |
| the §6.3 ladder over the whole listen | **never armed** (`active=false`, `step=0`) · GL programs **31 → 31** |
| 5 voice on/off cycles | 0 nodes · 0 listeners · 0.2 MB; a fresh engine per enable, released on disable |
| a question asked through the engine | reached the same answer path and the same anchor a typed one does (`14 → 16` bubbles, anchor `scene-story`) |
| **continuous mode's whole turn lifecycle**, in a browser | unaddressed speech asked **0** · wake phrase asked **1** and left the turn open · bare follow-up asked **2** · after **12 s** of silence the turn closed and an unaddressed sentence asked **0** more. Tier moved to T3 by the probe, per §6.2 |
| **tap-to-talk's window**, in a browser | `mode=push`, window **20 s**, button lit: the same unaddressed sentence **was** answered (**1** question — the press is the address). After the window: `enabled=false`, `listening=false`, button dark, and the next sentence asked **0**. Both modes on one sentence, in one run, because the contrast is the point |
| extra AI heap | **0.2 MB** in this run (0.2–1.2 MB across runs — GC timing, not growth) against §4's 300 MB desktop budget |
| verdict | **30/30 checks** |

**A correction this run forced.** The §11 work first armed the ladder *while
listening*, reasoning that answering and listening can overlap. The first soak
reported `active=true` for the full 600 s with `step=0` — which passed only
because this renderer's frames are healthy, and a pass for the wrong reason is
the exact mistake RSRC-2 was. Every rung acts on the **model** or the
**scene** — pace generation, shorten the answer budget, lower scene quality,
stop generating — and none of them on speech, so arming for a listen holds
the film down and, where the ladder fires, pays rung 3's measured price (**21
programs, 1221 ms**) to protect a generation that is not running. Listening now
arms nothing; the answer at the end of the listen goes through `ask()`, which
arms it exactly as a typed question does. Pinned by `tests/voice.test.mjs`
(4 tests fail if the arming comes back) and by a probe check that failed before
the fix.

**What this run cannot see, stated so it is not read as covered:** rung 3's
price, because the ladder never had a reason to move here. Forcing software GL
did not help — frames were *slower than the frame monitor's own 1000 ms sanity
bound*, so it discards every sample and the ladder stays at step 0. That cost
remains the §15.3 measurement above. And the engine is a stub: what continuous
mode's phase verifies is the *behaviour* (wake, follow-up, expiry, silence),
not the recognition — no human voice has reached this build.

**Why tap-to-talk exists at all** (VOC-5): "tap" was first implemented as a
latch, so a single press left the microphone open for as long as the panel did
and answered every word in the room. That is a worse leak than continuous
mode, which requires a wake phrase — and it applied to T1/T2, i.e. phones and
ordinary laptops. It is now a window that closes itself, and the probe proves
the closing with the button's own `aria-pressed`, not with the timer's
existence.

---

**NOT TESTED:** any real phone. (The §4 target on a real GPU, and the 4×/6× CPU-throttling
profiles, were run on 2026-09-27 — see *"Frame health, on the real GPU"* and *"§4's reference
profiles"* above: **0 % / −2.5 % / +0.3 %** drift, **1.00×** p95, **43/43** each. What those
runs do **not** establish is a phone's answer latency — the throttle misses worker threads.) `longtask` observation and the
ladder's *cost* were added afterwards by the §15.3 pass above — see
**Resource + lifecycle (§15.3)** for the measured result, including the 1.2 s
shader-recompile task the ladder used to cause.

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

---

## Faithfulness guard + Stage B data (2026-09-23, R1)

The guard is CPU-only string work (no model), and the generator is Python
string work (no GPU). Both were run on R1.

| Metric | Value | Method |
|---|---|---|
| Guard tests | 32 pass | `node --test tests/guard.test.mjs` |
| Instruction tests | 25 pass | `python -m unittest tests.py.test_instruction` |
| Stage B examples | 40,000 | `python -m training.scripts.make_instruction_data --count 40000` |
| Generation wall clock | ~11 s | `time` on R1 |
| Stage B characters | 24,694,864 | manifest (regenerated 2026-09-27) |
| Stage B tokens | **10,582,527** | **MEASURED** — encoded with the shipping tokenizer (`ai.data.sft.measured_token_counts`) |
| Stage B supervised tokens | **1,155,200** (10.9% of the stream) | **MEASURED** — §7.4 trains on assistant tokens only |
| Stage B tokens, as estimated | 7,263,195 | **ESTIMATED** — characters / 3.4, i.e. **31% low**: the real ratio is ~2.3 chars/token, not 3.4 |
| Longest example | 538 tokens | **MEASURED** |
| `sft.jsonl` size | 31,187,143 B | build output, git-ignored |
| Counterfactual share | 0.35 | every counterfactual context asserted to differ from the real rendering |
| Mix deviation from §7.4 | 0.0 pp | exact by largest-remainder allocation |
| Build after the guard joined the allow-list | 29 files · **448,578 B** | `npm run build` |
| JS / Python tests | **327 / 244** | `npm run test:all` |

**NOT TESTED:** the guard has never been run against a model's output (no
checkpoint exists), so its false-acceptment rate is unknown.

**Superseded 2026-09-27:** the second half of that sentence is no longer true
of *data*, but of *quality*. Stage B now has a trainer
(`training/scripts/train_stage_b.py`) and it has been run locally — see
"Stage B instruction tuning" below.

---

## CPU inference, first (§14) — smoke / lite / A, 2026-09-23, R1

`npm run bench:cpu` → `python inference/benchmark/benchmark_cpu.py --config all
--tokens 16 --prompt-tokens 128 --json docs/CPU_BENCHMARK.json`.

**Weights are random initialisation.** No checkpoint exists, so these are the
*architecture's* speed numbers, not a trained model's. Quality is neither
measured nor implied. Device: R1 (i5-6300U, Windows 10, torch 2.14.0+cpu,
**4 threads** — set by the harness and reported, because a number measured on
four threads is not comparable to one measured on a single thread).

| Config | Params | Load | Prefill 128 tok | Decode tok/s | state_dict fp32 | KV/token |
|---|---|---|---|---|---|---|
| **A** | 37.89M | 1.82 s | 292 ms (440 tok/s) | **28.0** | 144.6 MB | 10.00 KB |
| lite | 17.70M | 0.82 s | 152 ms (840 tok/s) | 42.0 | 67.5 MB | 6.00 KB |
| smoke | 1.82M | 96 ms | 34 ms (3,715 tok/s) | 99.0 | 7.0 MB | 1.50 KB |

Reading: config A clears §4's **≥ 8 tok/s minimum** on a 2016 ultrabook
dual-core with no GPU by 3.5×, and prefill of a 128-token context is under
300 ms. File sizes are **written**, not computed: fp32 144.6 MB is the raw
state_dict; the §4 shipping budget applies after INT8/INT4 quantisation
(P6), which is why the fp16 88.3 MB figure is reported next to it.

**NOT TESTED:** browser wasm speed (P7) — this is Python CPU with torch
kernels, and the browser runtime is a different implementation of the same
arithmetic. The §4 budget (≤ 40 MB total download) is a **quantised** figure
and is not met by any number in this table, which is expected and stated.
RAM RSS delta is readable on this machine (181.8 MB for config A) and is
**process RSS including torch's allocator**, not a model-only figure.

---

## The browser engine, on trained weights (§9) — 2026-09-25, R1

Same device as above (i5-6300U, 8 GB, Intel HD 540, **software GL**). These
are the numbers a visitor's machine produces, not Python's: `ai/engine/*` in
Node, reading the shards the browser reads.

**The weights are trained.** `training/checkpoints/local` — `vocab=1,024 d=256
L=6 heads=8/4 ffn=768 ctx=512 tied`, **4,984,064 params**, val loss 0.6423 on a
short CPU schedule. This is a **pipeline/export** exercise at 4.98M params; it is
not config A and it is not a quality result.

**Updated 2026-09-27 — the run was finished.** The export above came from step
800 of an interrupted run (no `RUN_MANIFEST.json`, which is how that is known).
`--resume auto` carried it 800 → **1,100 steps in 623.7 s**: loss 6.9471 →
**0.6242** (windowed gate PASS, 6.8368 → 0.909), **val loss 0.7030**, throughput
**3,612 tokens/s (256×8)** — against the 1,335 tok/s recorded from the loaded
box, which is the load spread this file keeps warning about. The manifest is now
written (23 KB, 68 shard hashes). Re-exported at step 1100: shard 5,059,584 B,
gzip **4,728,543 B**, brotli 4,691,901 B, q8 row error 0.001356, torch↔numpy PASS
(max |Δ| 9.54e-6); `verify:engine` **PASS** (argmax 100 %, worst |Δlogit| 1.65e-5,
decode 66–79 tok/s across runs).

**And the honest result of those 300 extra steps:** the answers changed and did
not improve — `"work reviewed cor byandeeer why"` (step 800) →
`"Uneomunyatoe thek, reviewed cor byandeainir…"` (step 1100). More CPU steps on a
3 MB generated corpus teach memorisation, not answering. The blocker is data and
scale, which is what P4/P5 on a GPU are for.

### `npm run verify:engine` — the parity gate, on the shipping export

| Metric | Value |
|---|---|
| Shards | 1 × 5,059,584 B q8 (fp32 equivalent 19,936,256 B) · gzip **4,732,964 B** · brotli 4,713,956 B |
| Tokenizer | 66,667 B, vocab 1,024 |
| Worst per-row q8 error | **0.001146** |
| Load | **57–63 ms**, every shard's SHA-256 verified |
| Positions checked | 138 · **argmax 100 %** · **top-16 order 100 %** |
| Worst abs Δ logit | **8.82e-06** against a 0.02 tolerance |
| Prefill | 35 tokens in 491–583 ms (**68–71 tok/s**) |
| Decode | **65–74 tok/s** over 6 runs (245–218 ms / 16 tokens; 73.5 in the reporting run) |
| KV cache | 3,072 KB resident at ctx 512 |
| torch ↔ numpy | **PASS**, max abs Δ **8.58e-06** |

Decode clears §4's **≥ 8 tok/s** floor by **8–9×** on a 2016 ultrabook with no
GPU, with the portfolio's WebGL scene running elsewhere on the same machine. The
range is the spread across runs of the same command on the same idle machine —
worth stating rather than quoting the most flattering one: it is a wall-clock
number on a shared CPU, and the low end is what a visitor would see.

### The gate was wrong before the weights were

The first run of this gate **failed**, and the failure was worth more than the
pass: the reference was built from the **float** checkpoint while the engine
runs the **int8** shards, so the comparison was between two different models.

| Reference reads | argmax | worst abs Δ logit | Verdict |
|---|---|---|---|
| float checkpoint (wrong) | 98.6 % | **1.63e-01** | FAIL |
| exported int8 shards (fixed) | **100 %** | **8.82e-06** | PASS |

The committed random-init fixture, same fix: 138 positions, argmax 100 %,
worst abs Δ logit **3.58e-07**.

### Bundle budgets (§4)

| Budget | §4 | Measured |
|---|---|---|
| AI chat **code** chunk, conservative reading (every shipped `ai/**` module + `knowledge.json`) | ≤ 150 KB gz | **75,181 B** (48.9 %) — was 71,465 B (46.5 %) after §11's first pass, 138,896 B (90.4 %) before shipped `ai/**` stopped carrying comments; the 2026-09-28/29 additions are §11.1 (a)/(c)/(d)/(e) and its downgrade and headphones notice, the engine's Stop fix, §5's persona flip with its copy sweep, and §0 rule 4's status disclosure (**+2,404 B gz** over the 72,777 B of the §2 N4 build): `ai/ui/chat.mjs` to 11,668 B, `ai/voice/index.mjs` to 6,378 B, `ai/ui/anchors.mjs` to 2,709 B, `ai/ui/styles.mjs` to 3,491 B) |
| — of that, §4's chat-UI chunk proper (UI + KB + retrieval + language + guard + intent + anchors + governor) | — | 50,951 B (33.2 %) |
| — of that, voice add-ons (loaded only on the tap that picks voice, §2 N6) | §4 lists separately | 9,475 B |
| — of that, LLM runtime + tokenizer (§4 "LLM runtime" row) | — | 14,755 B |
| AI assets actually fetched by **the click** (static reach of `ai/ui/chat.mjs`) | §4's number to keep small | **45,194 B gz (44.1 KB), 14 files** · the worker-only arithmetic the click does **not** parse is **13,382 B gz** across 9 files (both recomputed 2026-09-29 from `dist/`) |
| Rest of the page | regression guard 250 KB | 65,860 B |
| Model payload (weights + tokenizer + manifest) | ≤ 25 MB preferred, ≤ 40 MB hard | **5,144,354 B** raw · 4,741,050 B gz (step 1100) |
| First-use download, T1/T2 | ≤ ~40 MB | **4,816,231 B** gz (**11.5 %**) |
| Any single AI asset | ≤ ~100 MB | 5,059,584 B raw / 4,728,543 B gz |
| Files | — | 46 |

### With a model that actually answers (§15.3, 2026-09-26)

`npm run probe:resources`. Until the session bug above was fixed, every one of
this probe's questions was a *refusal* — no generation, no anchor, no ladder
pressure — so its resource numbers were the numbers of an idle panel. Re-run
with five real answers (13.9 s, 19.5 s, 24.3 s, 25.3 s, 36.7 s on R1) and one
hands-free answer:

| | |
|---|---|
| worst main-thread long task in the AI windows | **65 ms** |
| the page's own worst long task, panel never opened | **88 ms** |
| median frame time, panel open vs closed | 25.2 ms vs 24.7 ms (**2 %** FPS drop, §4 allows 10 %) |
| GL programs compiled while answering | **0** (31 → 31) |
| §6.3 ladder peak across the five answers | **1** (pace), never rung 3 |
| quality changes the ladder asked the scene for | **0** |
| extra JS heap, 5 answers on top of the panel | **1.3 MB** (§4 allows 300 MB) |
| heap / nodes / listeners over 5 reopens | **0 / 0 / 0** |
| worker after 130 s idle-closed (§6.4) | **released** (1 → 0) |
| probe | **24/26** |

The two failures are the voice section's wake-phrase pair, which flips between
runs on this host (`asked=0`/`asked=1` in one run, `1`/`2` in another, with the
stub engine and no real microphone) — the same instability `docs/PROGRESS.md`
already records for §11. Nothing above is a resource figure.

**The honest uncertainty.** Two *earlier* runs of the same probe showed a
**+21-program** material recompile during answering, and two showed none. The
ladder asked for a quality change in none of them (`qualityCalls: 0` in every
run), so rung 3 — which is what recompiles every material — did not fire; in
the run where the count moved outside the typed questions it landed exactly in
the hands-free window, which is where the §12 anchor scroll runs and the film
switches scene. That is a normal scene-change cost any scroll to that section
incurs, but it has not been isolated and is recorded as an open observation
rather than explained away. **Also unresolved:** the panel's own ready time has
been measured at **390 ms** and at **20–22 s** on this box in the same hour, by
two probes with two different wait conditions; the 50× spread is a machine-load
artifact and neither number should be quoted alone.

The chat **code** chunk is **87.4 %** of its budget — 19 KB of headroom left —
and this is the number to watch. It grew from 133,891 B (87 %) as §10's Stop and
Retry landed (the two controls, their styles, the `partial` badge and the
`cancelled` refusal in three languages), from 127,836 B (83 %) with the §8.2
window work, from 118,561 B with the model-only answer path, and from 79,555 B
before that as the engine, voice and guard landed. It went the other way **once**,
by **+776 B**: `createSessionBudget` moved §6.3's rung wiring out of
`ai/ui/chat.mjs` (−533 B gz) and into `ai/governor/index.mjs` (+1,309 B gz),
where it takes its dependencies as arguments and can therefore be **run** by
tests — the source-text check it replaced passed while two of the four rungs
were dead.

Then it came down by **2,864 B gz (2.1 %)**, and it did not cost a feature: the
retired Quick Answers *wording* left the bundle entirely. §5.1 step 4's
deterministic half is a **planner** now (`ai/answers/quick.mjs`) — intent,
the §8.4 gate, which public facts a question is about, the §2 focus entity and
the follow-up graph — and the sentences it used to build moved to
`evaluation/answer-text.mjs`, which `SHIP_PATHS` never copies. MEASURED:
`ai/answers/quick.mjs` 14,354 → **11,490 B gz**, and nothing in the built
bundle contains a template phrase (asserted by test, both by string and by the
planner coming back empty). The saving is smaller than the 6.9 KB the block
looked like on its own, because the *selection* logic — which project, which
skills, whether the question is answerable at all — has to stay on the visitor's
side of the wire, and it is now the bulk of the file.

Then it **grew twice more, by design, and both times off the click path**:
+1,088 B gz to split the voice layer so only its capability table ships with the
shell (§2 N6), and +3,207 B gz for `ai/engine/cache.mjs`, which is §9.3's real
model cache. Neither is fetched by a visitor who only types: the click's static
reach is **86,096 B gz** (measured by following the import graph in
`tests/build-bundle.test.mjs`), against **102,596 B** before the voice split.

**Then it halved, by shipping nothing a visitor runs.** The largest single line
in the chunk was prose: our own `ai/**` modules are heavily commented — the
design notes in `ai/answers/model.mjs` alone are 13 KB — and gzip cannot
compress English prose away. MEASURED on the shipped tree: **137,272 B gz with
comments, 66,799 B gz without, so 70,473 B gz (51.3 % of §4's 150 KB) was being
spent on comments.** The build now serves a stripped copy of every shipped
`ai/**` script (`stripComments` in `tools/build.mjs`); the repository keeps
every word of it, and `npm run bundle` (`tools/bundle-report.mjs`) is the
reporter that would have caught the figure going stale.

Two things make that safe rather than clever. It reuses `maskSource`, the same
comment/string/template/regex walk the leak scan already depends on — so one bug
would show up in both, and one set of tests is evidence for both. And it is
checked as the claim it actually is: the stripped modules are **imported** from
`dist/` in `tests/build-bundle.test.mjs`, then the built planner and the source
planner are asked the same five questions and their
`intent`/`sources`/`plan`/`text` compared for equality. `js/**` and `css/**` are
asserted byte-identical to source, because §2 N7 says the AI layer does not
touch the film.

The conservative §4 figure is the number that guards the budget, and after the
comment strip it is at **48.9 % — 77 KB of headroom** — with the runtime
(14.8 KB) and the voice add-ons (9.5 KB) inside it, both of which §4 lists on
their own rows. The click's static reach sits at **45,194 B gz** (every figure
in this paragraph is the 2026-09-29 re-run, after §11.1 (a)/(c)/(d)/(e), the
engine's Stop fix, §5's persona flip and §0 rule 4's status disclosure added
2,404 B gz to the chunk — and the worker-only
arithmetic the click still does not parse is 13,382 B gz, which is the part
that matters for a 50 ms main-thread budget).
**The budget is no longer the binding constraint on what `ai/` may grow into; it
is a regression guard now.**

### The shipped bundle, in a browser (2026-09-27)

`dev-ai-probe.js` used to hardcode the dev server, so **every browser number in
this file described the SOURCE tree** — and the thing a visitor receives is
`dist/`, with a stripped `knowledge.json` and the comments removed from
`ai/**`. The probe now takes `AI_BASE`, and the run below was made against the
built bundle served the way production serves it (`ROOT=dist PORT=5582`, the
same MIME table as `npm run preview`).

| | |
|---|---|
| probe | **43/43 checks**, 0 console errors, 0 page errors, 0 failed requests |
| probe, re-run 2026-09-27 after §11's last two features | **46/46 checks**, 0 console errors, 0 page errors, 0 failed requests — three checks are new (the transcript of a HEARD question, its EDIT control, and the words landing back in the box), and one instrument bug was fixed (see below) |
| no AI asset before the click | ✔ — the network watch stayed empty until the button was pressed |
| the answer | `kind=model`, badge `AI ANSWER · ON-DEVICE MODEL`, 12 facts read / 12 sources |
| frame health, closed → open | 33.2 ms (115 frames) → 33.3 ms (105 frames), **0.3 %** drift, **1×** p95, both arms `tier 2 · BALANCED @72% y=0`; the double-sampled control read −0.3 % |
| assets fetched on first open | **31** — the 14 of the click's static reach plus the worker's own `ai/engine/**` |
| the phone viewport (`MOBILE=1`, 390×844) | **60/60** as well on the 2026-09-29 re-run — sheet open pauses the film, closing resumes it, **no horizontal overflow (390 vs 390)**, withheld phone declined in the UI (the run this table was written from was 43/43, against the then-43-check probe) |
| §9.3's cache, on the same bundle (`dev-offline-probe.js`, now also `AI_BASE`) | **7/7** — visit 1 ready **26.3 s**, 3 puts, `hits: 0`; visit 2 with `*model-export*` blocked ready **22.0 s**, `hits: 3`, `misses: 0`, **0 network responses** for the weights, cache `aashish-ai-model:aashish-ai-1` holding 3 files / 5,144,354 B |
| §14's degrade gates on the same bundle (`dev-degrade-probe.js`, `ROOT=dist`) | **20/20** — T0: 0 model assets requested, 0 engine workers, `engine=null`, badge `T0 · NO AI MODEL HERE`, question refused `no-model`; failure: every model asset 404s, `state=error` with the reason spoken, panel usable, film untouched, **and a reload on a healthy network recovers to `ready` with real weights (5,059,584 B) and a real answer** |

R1 on a loaded box, so the absolute milliseconds move 2–3× between runs; what
this establishes is that the **stripped** bundle loads, mounts, spawns its
worker and answers — which the Node import tests could not show.

### §9.3's cache: zero bytes on the second visit (2026-09-27)

`node dev-offline-probe.js`, R1, headless Chrome. Three checks that cannot be
talked around, because the second visit is run with `*model-export*` **blocked
at the CDP level**:

| | measured |
|---|---|
| visit 1 | model ready in **27.9 s**, 3 responses from `model-export/`, `puts: 3`, `hits: 0` |
| the cache it created | `aashish-ai-model:aashish-ai-1` — **3 files, 5,144,357 B** |
| visit 2, `model-export` blocked | model **ready in 23.5 s**, `hits: 3`, `misses: 0`, **0 responses from the network** |
| the page's own shell offline | **not available** — the document came from cache, the `/js` launcher did not (§9.3: no service worker is registered, so the page makes no offline promise; the model files are cached, the HTML is the browser's business) |

So §4's "One-time, then cached (**0 MB** on later visits)" is now a measurement
rather than a hope: with the artifact directory unreachable the assistant still
reaches `ready`, and the only way that can happen is Cache Storage.
**NOT TESTED:** the wall clock does **not** follow — 27.9 s → 23.5 s is decode
work, not download work, on a localhost origin. What the cache removes is
network bytes, which is what §4 promises. The unit half
(`tests/model-cache.test.mjs`, 8 tests) pins the parts a browser cannot show:
zero fetches on a hit, a refused `open()`, a `QuotaExceededError` on write, old
versions deleted and foreign caches left alone, and a **poisoned** entry
(correct length, wrong bytes) dropped and re-downloaded exactly once.
The weights are deliberately **not**
in that number —
folding a 5 MB artifact into a 150 KB limit makes both budgets unmeasurable.
**NOT TESTED:** brotli is measured (4,713,956 B) but nothing yet negotiates it,
so the effective transfer is the gzip figure; and no CDN or real network was
involved, so these are file sizes, not load times.

### The unsupported path and the failure path, driven for real (2026-09-27)

`npm run probe:degrade` (`dev-degrade-probe.js`, new). §14 asks for automated
e2e coverage of "the T0 unsupported path, offline-after-cache, download
failure/retry". The middle one is above; these are the other two, and until
this probe **nothing had ever driven either of them end to end**. **20/20
checks**, R1, headless Chrome:

| Case | Measured |
|---|---|
| T0 (`navigator.connection.saveData = true`) | tier **0**, model assets requested **0**, engine workers **0**, `model.engine === null`, badge `T0 · NO AI MODEL HERE`, page errors **0** |
| T0, asked "What are your skills?" | `kind=no-model`, `NO ANSWER · NO AI MODEL ON THIS DEVICE` + a full sentence — a refusal, not a spinner |
| Failure (all of `/ai/model-export/` 404s) | `model.state === 'error'`, `reason = manifest fetch failed: 404 …`, panel usable (`isOpen: true`), `Film3D` untouched, page errors **0** |
| Failure, then a reload on a healthy network | `error → ready`, **5,059,584 B** of model, and it answers — the retry the panel promises |

**What this cost, in tested trust.** Two of the three findings were in the
testing itself, and both would have produced a green result for a broken path:

1. **The injection was in the wrong layer.** The first version blocked the model
   with CDP `Network.setBlockedURLs` on the page session. The weights are
   fetched **inside a module Worker**, and that block does not reach a dedicated
   worker's requests — the failing case returned `state: ready` and the probe
   printed it as a pass. It is now a dev-server flag (`FAIL_MODEL=1`, on
   `PORT=5581`) and the probe asserts `HTTP 404` **from the page** before it
   believes a word the panel says afterwards. Instrument bug, not a product bug,
   but the conclusion it invalidated was the whole section.
2. **A real product bug it did find.** `prepareModel()` restamped the tier's
   short label over the model line, so T0's badge read `T0 · NO AI MODEL`
   instead of the already-written `T0 · NO AI MODEL HERE` — the shell knew
   something more specific and said less. It only restamps while
   `modelState === 'idle'` now, which also preserves `PREPARING MODEL…` on T1+.
3. **One wrong assertion of mine:** "no worker was created" failed legitimately,
   because §6.1's micro-benchmark runs in a throwaway blob worker on every
   device, T0 included. The rule is about the *engine* worker, and that is what
   it checks now.

| | |
|---|---|
| chat code chunk (§4, conservative) | **71,465 B gz = 46.5 %** after the 2026-09-27 comment strip (before it: 138,896 B = 90.4 %, and 138,779 before the badge fix and its comment). +2,386 B gz of the current figure is the day's §11 work: the on-device probe, the visual, the idle bounds and the transcript (`ai/voice/index.mjs` 5,342 B gz, `ai/ui/chat.mjs` 9,742 B gz, `ai/ui/styles.mjs` 2,970 B gz) — see `docs/RESEARCH_VERIFICATION.md` row 6 |

### Where voice recognition runs (2026-09-27, §19 row 6)

Not a performance measurement — a claim with a test behind it, recorded here
because it decides what the panel is allowed to say. `probeOnDevice()` asks the
platform once per session, and the microphone does not open until it answers or
the 1.5 s cap is lost:

| Case | Behaviour | Instrument |
|---|---|---|
| `available()` answers `'available'` | `processLocally = true`; sentence becomes `SPEECH_DISCLOSURE_ON_DEVICE` | `tests/voice.test.mjs` VOICE-12 (double) |
| `'downloadable'` / `'downloading'` / `'unavailable'` / a word we do not know | server-side engine; cautious sentence; **no** `processLocally` | same |
| no `available()` API (Firefox, Safari, older Chrome) | not waited for at all — the microphone opens on the same tick, as before | same |
| never answers | cap fires, silence counted as **no** (`settled`), engine built server-side, sentence spoken | same |
| engine refuses the on-device session (`language-not-supported`) | fallback to the server-side engine **once**, reported, cautious sentence back; not asked again in the session | same |

**NOT TESTED:** on a real browser or phone — no machine has yet reported
`'available'` to us. `docs/MANUAL_TEST_CHECKLIST.md` §D asks the tester to
compare the sentence against `SpeechRecognition.available()` by hand.

`dev-ai-probe.js` gained the browser-side half: it now checks that the
**sentence matches `st.onDevice`** (a panel promising on-device while
`onDevice` is false is the failure; so is a `null` that never settles), and its
post-tap wait went from 1.5 s to 2.5 s because the recognizer holds the
microphone for up to 1.5 s while it asks. That check is **written and not
re-run** — headless Chrome on this box has the API and no microphone, so this
machine takes the refusal branch and the assertion never executes here.

### Frame health, on the real GPU (§6.3/§14, 2026-09-27)

`node dev-ai-probe.js`, R1, `headless: 'new'` with `--enable-gpu`. **This box's Intel HD 520
is reachable headlessly** — `WEBGL_debug_renderer_info` reports
`ANGLE (Intel, Intel(R) HD Graphics 520 … Direct3D11 vs_5_0 ps_5_0, D3D11)` — and the P0
baseline in `docs/BASELINE.json` was already measured that way, so the software-GL runs were
a choice, not a limitation. `--use-gl=swiftshader` is now behind `SW_GL=1`.

**The first real-GPU run found a confound, not a result.** The A/B reported **−49.2 %** drift —
the panel-open arm was *twice as fast*:

| Arm | median | film state |
|---|---|---|
| closed | 35.8 ms | `tier 1 · HIGH @85%` |
| open | 18.2 ms | `tier 4 · SURVIVAL @50%` |

The film's **own** governor had walked from tier 1 to its last tier during the session, with
the AI requesting no quality change at all (`qualityCalls: 0`, MEASURED in every run). A drift
across two different films is not an AI cost, in either direction, and reporting it as a jank
**failure** is how a real regression gets waved through later. The probe now samples the film's
tier / scale / scroll position / paused state in both arms and refuses to attribute a drift
when they differ.

**Then the tier was pinned (`PIN_TIER`, default 2) and re-pinned before each arm:**

| Arm | frames | median | p95 | film |
|---|---|---|---|---|
| closed | 127 | **18.3 ms** | 36.5 ms | `tier 2 · BALANCED @72% y=0` |
| open (after 5 answers) | 126 | **18.3 ms** | 36.5 ms | `tier 2 · BALANCED @72% y=0` |
| drift | | **0 %** (§14 allows ≤ 10 %) | **1.00×** | same film in both arms |

`node dev-ai-probe.js` → **43/43 checks** on that run (**46/46** on the
2026-09-27 re-run, on a busier box: panel ready **2,132 ms**, first answer
**30,660 ms**, frames 33.2 → 33.3 ms, ladder at step 0). Panel ready **815–880 ms** after the click in these
two runs. **NOT TESTED:** the panel's ready time has been measured at 390 ms and 19.3–27.9 s
within the same day, so 815 ms is the best case on an unloaded box and nothing more; the A/B is
at a pinned tier, which is what makes it attributable, not what a visitor's film will choose;
and the p95 being *identical* to 0.1 ms in both arms is reported as measured rather than
explained.

### §4's reference profiles, which had never been run (§15.3)

The same probe under `Emulation.setCPUThrottlingRate` — the same CDP call and the same
`THROTTLE` knob as `dev-baseline-probe.js`, so the two are comparable. R1 is already a weak
machine; this is the only way to make it weaker without owning a phone.

| Profile | panel ready | first answer | drift (closed → open) | p95 | probe |
|---|---|---|---|---|---|
| R1 as it is | **815 ms** | **25,129 ms** | **0 %** (18.3 → 18.3 ms) | **1.00×** | **43/43** |
| **4× CPU** | **1,091 ms** | **45,380 ms** | **−2.5 %** (35.3 → 34.4 ms) | **1.00×** | **43/43** |
| **6× CPU** | **1,502 ms** | **42,753 ms** | **+0.3 %** (35.4 → 35.5 ms) | **1.00×** | **43/43** |

§4's own target — "median FPS drop ≤ 10 %, p95 ≤ 1.5× baseline" — is met on all three. Every
flow check passes under 6× as well: the answer still streams, Stop still cuts it and keeps the
partial text, Retry still re-asks, the skills question still reads 12 facts, the panel is still
usable.

### The control that changes how the table above must be read

A later run reported **+92.9 %** drift from the same probe, same pin, same tier — and a re-run
reported **0 %**. So the probe now samples the *open* arm **twice**, seconds apart, with the film
untouched between the samples. In the run that produced both numbers:

| Sample | median | film |
|---|---|---|
| closed | 18.3 ms | `tier 2 · BALANCED @72% y=0`, quality normal, ladder `step=0 active=false` |
| open (1st) | 18.3 ms | same |
| open (2nd) | **35.4 ms** | same |

The two open samples disagree with **each other** by **93.4 %** — with the AI doing nothing, the
ladder never having moved (`step=0`, no quality change, `sceneQuality=normal`) and the film's own
tier/scale/position identical. The film on this box is **bimodal between ~18.3 ms (≈55 fps) and
~35.4 ms (≈28 fps)**, and `govStatus()` reports the tier's *target* scale, not the pixel ratio
the renderer ends up with, so the flip is invisible in it.

**Consequence, stated plainly: a single-run frame A/B on R1 is worth ±90 %,** and neither the
0 % nor the 92.9 % figure above should be quoted on its own. The probe prints the control's own
disagreement next to the verdict and refuses to call a drift attributable when the control
contradicts it. What the pinned run *does* establish is narrower and still real: the AI causes no
**long task**, no **GL program**, and no **quality change**, and the film's cost is dominated by a
mode switch that happens without it.

**A related flip, in the tier itself (§6.2).** Every recent run of this probe chose **T1 · LITE**
(`panel opened … tier=1`), while the P2-era record in this file says the same desktop class lands
on T2. Nothing about the device changed — `benchSlowMs` is 14 ms and the §6.1 micro-benchmark is
load-sensitive, so a busy box classifies itself as lite. §6.2 calls the table "starting heuristics
— validate and adjust", and this is the measurement that says **`benchSlowMs` needs tuning against
an idle reference**, because the tier it picks sets the answer budget (96 tokens at T1 vs 160 at
T2). The direction of the error is the conservative one, which is why it is recorded rather than
patched on a hunch.

**Two things this pair of runs honestly says it is not:**

* The CPU throttle does **not** simulate a weak device faithfully for *worker* work. Frame time
  doubles (18.3 → 35.3 ms), so the main thread is throttled as expected, but the first answer
  goes 25.1 s → 45.4 s, which is **1.8×, not 4×**. The generation runs in a Worker and the CDP
  throttle does not hit it proportionally. A real phone's answer latency is therefore **still
  NOT TESTED**, and this profile should not be quoted as if it were.
* Panel ready scales cleanly with CPU (815 → 1,091 → 1,502 ms). That is a useful signal about
  the *other* number: the same probe has reported 19.3–27.9 s for this same step on this same
  box, so that spread is machine load, not a property of the assistant.

---

### Firefox, on the shipped bundle (2026-09-28, R1, §16's P7 gate)

P7's gate says the runtime must work on **"Chrome + Firefox (+ Safari if available)"**. Chrome
had been driven end to end since P2; Firefox had *never* been run, and the report said so.
Firefox **156.0.1 is installed on this box** (MSIX), so the "if available" clause did not
apply — the gap was a missing test, not missing hardware.

**New probe, `dev-firefox-probe.js` (`npm run probe:firefox`), scoped deliberately.** It is
**not** a port of the 46-check Chrome probe: that one leans on CDP
(`Emulation.setCPUThrottlingRate`, `Network.setBlockedURLs`, worker events) and Firefox speaks
WebDriver BiDi, so a port would be a second, drifting copy. This is an **11-check** smoke that
answers one question — does the shipped bundle *run* here — and it says so in its own output.
(It was 9 checks when it was first written; the two §2 N4 checks were added with the disclosure
they check.)

| Check | Result (R1 · Firefox 156.0.1 · `headless: true` · **built bundle** on `:5582` · 2026-09-28) |
|---|---|
| zero AI requests **before the click** | **0** of 56 requests (instrument proven: the listener saw the other 56) |
| launcher → panel | opened, `state=ready`, **1,787–2,028 ms** after the click (three runs: 1,787 / 1,999 / 2,028) |
| tier chosen | **T1 · LITE**, badge `T1 · MODEL READY` — the same tier Chrome picks on this box |
| model phase | `ready` |
| a real answer | **27.1–29.1 s** in-browser (three runs), badge `AI ANSWER · ON-DEVICE MODEL` |
| answer is text, not markup | yes (no `script`/`img`/`iframe` in the bubble) |
| §11 honest degradation | microphone **disabled with the reason in `title`**: *"This browser has no speech recognition, so voice mode stays off…"* — Firefox has no `SpeechRecognition`, and the button says so instead of going quietly dead |
| capabilities read by the tier | `STT=false TTS=true moduleWorker=true storage=true` |
| §2 N4: the ABOUT control opens the disclosure card | yes |
| §2 N4: the card names **both** voice outcomes | yes — Firefox is the engine where that matters, since it has no recogniser at all |
| page errors · console errors/warnings · failed requests | **0 · 0 · 0** |
| wasm SIMD + module worker + Cache Storage | all present and exercised (the answer *is* the evidence: weights are fetched, SHA-256 checked and run in a worker) |

**Two instrument bugs this found, both in the probe rather than the product:**

* The first run failed a check called *"no third-party request"* on Google Fonts and the GSAP
  CDN — dependencies the portfolio has always had. The promise (§2 N6/§14) is about the
  **assistant**, so the check now asserts *every AI asset is same-origin* and merely reports the
  portfolio's own off-site list (**26** requests to `fonts.googleapis.com`, `fonts.gstatic.com`,
  `cdn.jsdelivr.net`). A page-wide same-origin assertion was never true and would have failed
  forever.
* The reason the microphone is off lives in `title`, while `aria-label` carries only the state
  (`"Voice mode is off"`). Reading the label as the reason passed on a string that explains
  nothing; the check now reads `title` and treats the working-microphone label (`"Talk to the
  assistant"`) as the distinguishable failure.

**Firefox's own trap, for whoever runs this next:** the user-facing alias
(`…\WindowsApps\firefox.exe`) is **EACCES** to a non-packaged process, so `executablePath` has to
point into the package VFS (`…WindowsApps\Mozilla.Firefox_156.0.1.0_x64__n80bbvh6b1yt2\VFS\…`).
`FF_BIN` overrides it.

**Still NOT TESTED after this:** Firefox on a *real* device or a phone, Firefox with a live
microphone (Firefox has no recogniser at all, so that path is a permanent no), and **Safari** —
no macOS or iOS host exists here.

---

## The context budget, and the 512-token window it was drowning (§8.2/§9)

`npm run probe:tokens` (alias `node dev-token-budget-probe.js`), shipping
tokenizer, real knowledge base, real §14 corpus. Measured with the exported
`tokenizer.json` — the weights are not loaded.

### Why 4 characters per token was wrong

`estimateTokens` used a generic English rule of thumb. `aashish-ai-1` has a
**1,024-token vocabulary**, so its BPE cannot merge long runs the way a 32k one
does, and real text costs far more tokens per character:

| String class | n | min | median | max |
|---|---|---|---|---|
| frame prefix (specials + rules) | 1 | 2.66 | **2.66** | 2.66 |
| question | 60 | 1.06 | **1.82** | 3.14 |
| retrieval context (the string that is budgeted) | 43 | 1.29 | **1.60** | 2.39 |
| index chunk text (the string that is *not* budgeted) | 60 | 1.08 | 1.56 | 2.83 |
| single fact line | 28 | 1.00 | **1.47** | 2.70 |
| answer prose | 60 | 1.26 | 1.63 | 2.26 |

At 4, a "300-token" context was really ~750, and a prompt one token past
`max_position_embeddings` is not a slow answer: `forward()` throws, and the
visitor is told the model stopped. `CHARS_PER_TOKEN` is now **1.5**. It is not
set to the *worst* measured value on purpose — at 1.25 a single 1,175-character
project chunk prices at over the whole budget, is skipped, and the question
stops retrieving anything, which converts a token budget into a relevance
filter (see below). The hard limit is no longer an estimate at all: `fitToBudget`
enforces it with the real tokenizer.

### What the old budget admitted, and what fits now

| Case | 4 chars/token (old) | measured now |
|---|---|---|
| Retrieval-path prompts over 512 tokens | **14 of 60** | **0 of 60** |
| Prompts over 512 with NO token budget at all | 3 of 60 (worst 525 tok) | 3 of 60 — the question and the frame alone are that long |
| Retrieval-path prompts needing any trimming | — | **0** |
| Intent fallback, "What are his skills?" | 38 facts / **764 tokens** | 18 facts fit; capped at **12** |
| Intent fallback, facts that fit at all | — | min 1 · median 2 · max 18 |

The intent fallback is the one path whose "top-k" is a whole topic instead of a
BM25 ranking, and it had no cap at all. `MAX_INTENT_FACTS = 12` is the measured
18 with headroom for a conversation turn or two.

### Pricing the wrong string

`search()` no longer prices anything by default. The budget is about the string
the *model reads*, which is `contextLines()` — one compact rendered value per
fact. The index's chunk text is a different, much larger string: a project
chunk is 1,175 characters of name, codename, summary, tech, role, status,
dates, highlights, links and attribution, while `renderFact` sends the
300-character summary. Priced by its chunk text at an honest ratio, the best
chunk for "goal tracker" blew the budget on its own and was skipped, so the
question returned **nothing** and `lowConfidence` reported it out of base. A
relevance claim is a calibrated score threshold (`MIN_TOP_SCORE`, see
`docs/CALIBRATION.json`); a token budget belongs to a caller that declares a
cost model, and `search()` now leaves the two decisions apart.

The `docs/CALIBRATION.json` sweep is why this matters beyond the bug: it calls
`search()` without a sizer, exactly as it did when 4-chars-per-token admitted
everything under 1,200 characters. Making the default budget bite would have
silently edited the conditions the gate was calibrated under.

**NOT TESTED:** the ratio on a retrained tokenizer. `tests/token-budget.test.mjs`
re-derives it from the shipping artifact on every run, so a vocabulary change
fails the suite and points at `npm run probe:tokens` rather than silently
invalidating these numbers.

---

## What one question costs a visitor, and what the wait is made of (§4/§10)

`npm run probe:latency`. Same device (R1: i5-6300U, 8 GB, Intel HD 540,
software GL), same trained export as above.

**This machine's load moves wall-clock numbers 2–3× between runs.** Every figure
below is therefore either the **minimum** of an interleaved A/B in one process
(where the two arms see the same load, so the *ratio* survives) or explicitly
labelled as a spread. An absolute number from this laptop, quoted alone, is
worth about a factor of two.

### The wait is prefill, and prefill is prompt length

A prompt is `specials + rules + retrieved facts + question`, and the first two
are **125 tokens on every question** — 46 % of a typical prompt, and identical
every time.

| Prompt shape | Prompt tokens | Prefill | Decode | Total |
|---|---|---|---|---|
| 1 fact, short question | 135 | 2.6 s | 0.2 s | 2.7 s |
| 2 facts, long question | 298 | 5.4 s | 0.5 s | 5.9 s |

Prefill is **90–95 % of the wait** before any text appears; decode is 19–25 ms
per token. So "the model is slow" is really "the prompt is long", and the two
levers are prompt length and tokens-per-second.

### The prefix cache, generalised to the longest shared prefix

The engine remembers the token ids it last prefilled and, on the next question,
rewinds to the longest leading run the new prompt shares with them — the K/V at
a position depends only on the tokens before it, so the skipped positions are
**bit-identical**, not approximately equal (`tests/engine.test.mjs` ENG-15/ENG-17
compare the logits, not the generated ids). Every question shares at least the
125-token rules block; a repeat shares the facts and the question too.

| Case | Time to first token |
|---|---|
| cold — no cache, full prefill | **5,193 ms** |
| **repeat** — the same question again | **17 ms** (100 % of the wait saved) |
| a different question — 120 of 142 ids shared | **407 ms** |

This replaced an earlier version that matched the rules block by exact length.
That could only ever skip 125 tokens; the generalisation strictly dominates it
and is the same mechanism, so it costs nothing and can change no answer. It is
*not* a smaller model, fewer facts or a shorter prompt — those are the levers
that trade quality, and they are still open.

### Three optimisations that were measured and refused

Recorded so they are not retried on a hunch. All three are minimum-of-N,
interleaved, same-process.

| Attempt | Cache-resident | End to end | Kept? |
|---|---|---|---|
| Expand int8 codes to float32 at load | **2.3×** faster (65 → 148 M MAC/s) | **0.99×** (47.6 vs 48.2 ms/token) | **No** — the 20 MB copy stops being L3-resident |
| Batch B prompt positions per weight row (prefill weight reuse) | — | B=1 0.94–1.01×, B=2 0.83–0.94×, B=4 1.09–1.38×, B=8 0.86–1.01× | **No** — no trend, and the kernel is not weight-traffic-bound |
| Cache the weight-map lookups per token | — | 0.013 ms of a 22.75 ms step | Kept, but not as a speed claim |

### Why the kernel is where it is, and what is left

A plain `s += a[i] * b[i]` loop over `Float32Array`s runs at **97 M MAC/s** on
this box and the shipped kernel at **121 M MAC/s** — so the scalar JavaScript
is already at *this machine's* ceiling, and unrolling (128 M) does not move it.
A plain JS float loop should reach 1–2 G MAC/s on an i5-6300U, which means this
box measures JavaScript **~10× below its specification** under its current load.

**The consequence, stated plainly:** the only remaining lever is a different
execution engine (WASM SIMD or WebGPU), and its payoff **cannot be measured
here** — a box that is 10× slow for reasons of its own says nothing trustworthy
about SIMD throughput. Implementing it would mean shipping a numeric change
(SIMD accumulates in 32-bit lanes, not float64) behind an ESTIMATED speed claim
that no gate on this machine can confirm. It is left unimplemented and open,
rather than implemented and unverifiable.

**NOT TESTED:** first-token latency in a real browser tab with the WebGL film
running, on a device that is not this laptop. Every figure above is Node on R1.
The measured numbers also depend on the *retrieved* fact count, so they move
with the knowledge base, not only with the code.

---

## Stage B instruction tuning (§7.4) — 2026-09-27, R1

`training/scripts/train_stage_b.py` is new: Stage B had data and no trainer, so
the shipped checkpoint had been asked to continue a frame (`<|ctx|>`,
`<|asst|>`) its pretraining corpus almost never contained.

| Metric | Value | Method |
|---|---|---|
| Instruction data | 40,000 examples · 24,694,864 characters · 31,187,143 B | `npm run sft` |
| Tokens, measured | **10,582,527** total · **1,155,200 supervised (10.9%)** · longest 538 | shipping tokenizer, `ai.data.sft.measured_token_counts` |
| The manifest's estimate | 7,263,195 (**31% low**) | characters / 3.4, the ratio the first budget assumed |
| The frame in the pretraining corpus | 17,265 docs: `<|sys|>` 415 · **`<|ctx|>` 4** · `<|asst|>` 1,108 | `data/processed/seed/corpus.jsonl` |
| Mask structure | holes **0** · non-whitespace leaks **0** · missing `<|end|>` **0** | `tests/py/test_sft.py`, 2,000 real examples |
| Local run | 60 steps in **66.6 s** (1.11 s/step, batch 4 × block 256, grad-accum 2, CPU) | `--config local`, `--init training/checkpoints/local/latest.pt` |
| Loss | 7.5571 → **6.3133**; windowed gate **PASS** (7.6043 → 6.0065) | 60 steps |
| Val loss (assistant tokens only) | 6.2715 → **5.5403** | fixed held-out windows |
| Tokens seen / supervised | 61,440 / **7,440 (12.1%)** | run manifest |
| Format before / after | Stage A: no turn end, `<|asst|>` emitted mid-answer · Stage B (60 steps): frame **and** `<|end|>` appear | `npm run sample:answers`, same 3 prompts |
| JS / Python tests | **451 / 343** | `npm run test:all` |

**NOT TESTED:** a Stage B run at any real scale. Sixty steps on 3,000 examples
proves the path and the format, not the answers — the words are still wrong,
and the shipped export remains the Stage A artifact until a config-A run
(a GPU, owner-side) produces something worth shipping. The mask's effect on
quality at 40k examples is therefore **unmeasured**.

---

## §14 model-answer evaluation — 2026-09-27, R1

§14's metrics needed a model answer to grade, and until now the only way to get
one was to export the checkpoint, serve the site and drive a browser. It is now
a three-step pipeline, each step in the language that owns the work:

| Step | Command | Does |
|---|---|---|
| 1 | `npm run eval:prompts` | builds the client's own prompt per case — `quickAnswer` routes, `search` retrieves, `contextLines` renders, `fitToBudget` trims, `frame` composes. **41** of 60 cases reach the model; the other 19 are decided before it (§9 refusals, the disclosure, the bait refusal, and 7 questions the portfolio has no retrieved evidence for) |
| 2a | `npm run eval:export` + `npm run eval:decode` | exports the checkpoint and decodes with the **shipping engine** (q8 weights, prefill reuse, KV cache) — fast and faithful |
| 2b | `npm run eval:decode:reference` | decodes from a **checkpoint** with the numpy reference (fp32, no cache) — slower, no export needed |
| 3 | `npm run eval:report` | scores with the **shipped** guard, placeholder resolver and language rule; writes `docs/EVALUATION.json` |

**Decoder A/B, measured:** per token the reference is **0.62 s** (1.6 tok/s) and
the shipping engine **0.17 s** (5.9 tok/s, 681 tokens in 115.9 s). Over the full
96-token sweep that is ~48 min against ~2 min — which is why the gate-grade run
below uses the engine, and why the reference decoder stays as the path that
needs nothing but a checkpoint. It has no KV cache *on purpose*: that is what
makes it the cache-correctness check for the engine.

| Metric | Value | §14 gate |
|---|---|---|
| Checkpoint graded | `training/checkpoints/sft-local`, latest, **step 60** | — |
| Cases · model-routed · decided before it | 60 · **41** · 19 | — |
| Portfolio QA accuracy (34 gradeable) | **0.0%** | — |
| Factual accuracy | **0.0%** | 95% — **FAIL** |
| Unsupported-claim rate, pre-guard | 7.3% | reported |
| Unsupported-claim rate, post-guard | **0.0%** | ≤1% — PASS |
| Abstention recall | **92.3%** | 95% — **FAIL** |
| Abstention precision | 92.3% | reported |
| False abstention | 2.4% | ≤10% — PASS |
| Language consistency | EN **100%** · HI/Hinglish **78.6%** | 95/90% — HI/Hinglish **FAIL** |
| Turn terminated | **100%** | — |
| Answer echoes the prompt | 0.0% | — |
| Follow-up referent reached the prompt | 42.9% (7 cases) | reported |
| Fabricated facts on adversarial | **0** | 0 — PASS |
| Guard failures | 3 of 41 | — |
| Refusals before the model | 13 (7 for want of retrieved evidence) | — |
| Abstentions by the model | 0 | — |

**A revoked number, and the test that caught it.** The first version of this
table reported **factual accuracy 18.9%**. That figure was a grader artefact and
is withdrawn. 27 of the 60 cases carry an empty `expected_facts` on purpose —
they are judged on abstaining (`unknown`, `malicious`, `hallucination_bait`) or
on their referent (the `follow_up`s) — and the first scorer counted an empty
expectation as **fully covered**, i.e. full marks for a model that says nothing.
The seven `follow_up`s among them were the entire numerator: 7 of 37 = 18.9%,
with no correct answer anywhere in it. Re-grading the *same* answers file with
the fixed scorer turns 18.9% into **0.0%**; a regression test
(`tests/model-eval.test.mjs`, "an answerable case with no expected fact is
reported, not scored") now pins the rule the fix introduced.

**The cap question, answered by the other decoder.** The first pass ran the
reference decoder at **16** tokens (48 × 16 took 11 min; that first pass counted
the 7 no-evidence rows as model-routed, hence 48 against today's 41). Factual accuracy came
out at the same 18.9% (same artefact), but turn termination read **6.3%**; at
the full 96-token budget it is **100%**. That is the whole reason
`docs/EVALUATION.json` carries a `caveat` field: at a 16-token cap, "the model
does not end its turns" was an artefact of the cap, and a report that had
printed it as a finding would have been wrong — which is exactly the failure
this repo labels numbers to avoid.

**What the numbers say, honestly.** Nothing true is produced yet: 0 of the 34
cases that state a fact get that fact into an answer (gate 95%), and every
answer is fluent nonsense (`Uneeepowgeoye pu St …`) — the §7.4 frame is in use
(turns end, no prompt echo, no fabrication) but the content is not there. The
parts that ARE working are the surrounding machine, and they now read as such:
the **guard** withheld every unsupported claim it saw (7.3% pre → **0.0%**
post), **abstention recall 92.3%** counts the refusals a visitor actually meets
(policy, bait and no-evidence) instead of only the model's own, and the
remaining failure is quality, not plumbing. That is why a loss curve cannot be
the quality gate, and why this pipeline exists.

### The probe's own instrument bug, found by re-running it (2026-09-27)

The re-run failed once, and the failure was the probe's, not the panel's:
`answer is labelled` read the **last bot bubble**, and §6.3 appends a `NOTICE`
bubble *after* the answer when the governor has shortened the session ("The
scene was struggling, so answers are kept shorter"). On a box whose frames were
in their slow mode (33.2 ms), the ladder fired, the notice landed last, and the
probe reported the answer as unlabelled.

The fix is in the instrument: an answer is the last bot bubble that is **not** a
notice, and the run now prints a note when a NOTICE was seen so the situation
cannot pass silently. Nothing in the panel changed. This is the fourth
instrument bug this probe has produced (see §15.3's list), and the pattern is
consistent: **it reads the screen, so a new bubble can break it.**

Same run, for the record — `ROOT=dist PORT=5582`, `AI_BASE=http://localhost:5582/`,
headless Chrome with the GPU:

| | |
|---|---|
| checks | **46/46**, 0 console errors, 0 page errors, 0 failed requests |
| tier / panel ready | **T1 · MODEL READY**, **2,132 ms** |
| first answer | **30,660 ms** |

**Updated 2026-09-28:** the check set has since grown to **54** (the eight §2 N4 disclosure checks
were added with the feature), and a full run on the built bundle passes **54/54** — 0 console
errors, 0 page errors, 0 failed requests, `T1 · MODEL READY`. One earlier run of the same build
lost a single check; the re-run did not reproduce it, and the failing line is not recorded because
the first run's output was piped through `tail`. That is an instrument gap in how the probe was
invoked, not a result.

**Updated again 2026-09-29:** the check set is at **60** and a full run against the built bundle
served as production serves it (`ROOT=dist PORT=5582`, `AI_BASE` pointed at it) passes **60/60** —
0 console errors, 0 page errors, 0 failed requests, `T1 · MODEL READY`. The additions since 54 were
§0 rule 4's status line and §11.1's downgrade and headphones checks. `MOBILE=1` passes 60/60 too.
| a topic question | `kind=model`, **12 facts**, 12 sources — one real answer |
| frames, panel closed → open | 33.2 → 33.3 ms = **0.3 %** (p95 **1×**), ladder `step=0` |
| control (open, sampled twice) | 33.3 → 33.2 ms = −0.3 % — this box's bimodal baseline |
| §11.2 checks | `badge="HEARD"`, EDIT present, and pressing it puts `"who are you"` back in the box |
