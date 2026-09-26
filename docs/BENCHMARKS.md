# BENCHMARKS — Aashish AI

Per §15: every number here carries **device, browser, method and date**. Anything not measured
is labelled ESTIMATED or NOT TESTED — never rounded up into a pass.

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

* **The 10-minute Proactive soak has not been run.** The probe supports it
  (`SOAK_MS=600000 CYCLES=5 node dev-resource-probe.js`) and no soak is claimed
  without it. There is also no microphone in this build, so "Proactive" is a
  mode flag, not a running feature — a soak today would measure an idle panel.
* **No real GPU.** Every number above is software GL, where shader compilation
  is pathologically slow. The 1.2 s relink is *expected* to be far smaller on
  real hardware — **and that is an expectation, not a measurement.**
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
and the probe prints its own total (**26/26**). See PROGRESS §11.

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

**NOT TESTED:** the §4 target "median FPS drop ≤ 10 %, p95 ≤ 1.5× baseline" on a real GPU, the
4×/6× DevTools CPU throttling profiles, and any real phone. `longtask` observation and the
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
| Stage B characters | 24,707,841 | manifest |
| Stage B tokens | 7,262,881 | **ESTIMATED** — characters / 3.4; a real count needs the P4 tokenizer |
| `sft.jsonl` size | 31,186,963 B | build output, git-ignored |
| Counterfactual share | 0.35 | every counterfactual context asserted to differ from the real rendering |
| Mix deviation from §7.4 | 0.0 pp | exact by largest-remainder allocation |
| Build after the guard joined the allow-list | 29 files · **448,578 B** | `npm run build` |
| JS / Python tests | **327 / 244** | `npm run test:all` |

**NOT TESTED:** the guard has never been run against a model's output (no
checkpoint exists), so its false-acceptment rate is unknown; and no model has
been trained on the Stage B data, so the data's *effect* is unmeasured.

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
L=6 heads=8/4 ffn=768 ctx=512 tied`, **4,984,064 params**, step 800, val loss
0.6423 on a short CPU schedule. This is a **pipeline/export** exercise at
4.98M params; it is not config A and it is not a quality result.

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
| AI chat **code** chunk (UI + KB + retrieval + language + guard + intent + engine JS) | ≤ 150 KB gz | **136,409 B** (88.8 %) |
| Rest of the page | regression guard 250 KB | 65,649 B |
| Model payload (weights + tokenizer + manifest) | ≤ 25 MB preferred, ≤ 40 MB hard | **5,144,357 B** raw · 4,742,169 B gz |
| First-use download, T1/T2 | ≤ ~40 MB | **4,926,379 B** gz (**12 %**) |
| Any single AI asset | ≤ ~100 MB | 5,059,584 B raw / 4,732,964 B gz |
| Files | — | 44 |

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

The chat **code** chunk is **88.8 %** of its budget — 17 KB of headroom left —
and this is the number to watch. It grew from 133,891 B (87 %) as §10's Stop and
Retry landed (the two controls, their styles, the `partial` badge and the
`cancelled` refusal in three languages), from 127,836 B (83 %) with the §8.2
window work, from 118,561 B with the model-only answer path, and from 79,555 B
before that as the engine, voice and guard landed. **The next feature that lands
in `ai/` should be paired with a look at what could move out of this chunk.**
The weights are deliberately **not**
in that number —
folding a 5 MB artifact into a 150 KB limit makes both budgets unmeasurable.
**NOT TESTED:** brotli is measured (4,713,956 B) but nothing yet negotiates it,
so the effective transfer is the gzip figure; and no CDN or real network was
involved, so these are file sizes, not load times.

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
