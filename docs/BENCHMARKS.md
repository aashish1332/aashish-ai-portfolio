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
quick answers only — and none of them on speech, so arming for a listen holds
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
