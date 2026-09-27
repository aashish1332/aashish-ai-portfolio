# Final report (§18)

Written 2026-09-27 on **R1** (i5-6300U, 8 GB, Intel HD 540, Windows 10, Node
v24.13.0, Chrome installed, **no GPU**). Every number carries one of three tags,
and nothing here is called "implemented" without a command that was actually run:

- **MEASURED** — a command in this repository produced it, on the device named.
- **ESTIMATED** — arithmetic or a label, no run behind it. Never a claim.
- **NOT TESTED** — no evidence exists. Listed as such, not as "should work".

The one thing to read first: **the pipeline is real and verified end to end; the
model that is currently in the browser is not trained for quality.** The
infrastructure claim below is true today. The quality claim is not, yet, and
this report says so in the same breath as the good news.

---

## The claim, as it stands

> "A custom conversational AI trained from scratch for my portfolio, answering
> questions about my work, skills and background, running locally in the
> visitor's browser — no LLM API, no backend."

| Clause | State |
|---|---|
| "custom … trained from scratch" | **MEASURED** — our tokenizer, our model code, random init, our trainer, our export, our engine. No pretrained weights anywhere in the shipping path. |
| "running locally in the visitor's browser" | **MEASURED** — `dev-ai-probe.js` **43/43 checks** (real GPU); one real answer with `AI ANSWER · ON-DEVICE MODEL`, 12 facts read, 12 sources; zero requests to any third party. |
| "no LLM API, no backend" | **MEASURED** — `npm run build` ships a static bundle; the model is fetched from the site's own path and cached locally. Checked on the built bytes rather than asserted: `tests/build-bundle.test.mjs` fails if any shipped `ai/**` script contains an absolute URL, if the shipped AI code makes more than the **one** outbound call it makes (`fetch(KB_URL)`, this site's own knowledge file), if it opens an XHR/WebSocket/EventSource/sendBeacon, if any shipped file carries a secret-shaped string, or if any names a hosted LLM service. |
| "training from scratch" (the full spec-sized model) | **NOT TESTED** — Stage A + Stage B at config A have never run; they need a GPU. What has run is the 4.98M CPU pipeline config. |
| "answering questions about my work" | **NOT TESTED in the sense that matters** — the shipped checkpoint answers, but it answers *badly*, because it has had 1,100 steps on a ~3 MB corpus. |

So: the claim is true about **architecture, privacy and locality**, and not yet
true about **answer quality**. See "What I need from you".

---

## MODEL

| Property | Value | Tag |
|---|---|---|
| Architecture | Custom decoder, LLaMA-shaped: RMSNorm, RoPE (θ=10000), grouped-query attention, SiLU-gated MLP, tied embeddings | **MEASURED** (`ai/model/`, `ai/engine/llama.mjs`) |
| Shipping config | 6 layers · d_model 256 · 8 heads / 4 KV heads · head_dim 32 · MLP 768 · context **512** | **MEASURED** (`ai/model-export/aashish-ai-1/manifest.json`) |
| Parameters | **4,984,064** | **MEASURED** (`count_parameters.py --gate`) |
| Vocab | **1,024**, our own BPE, version `portfolio-bpe-1k-45395d2ebc83`, 66,667 B | **MEASURED** |
| Specials | `<|sys|> <|ctx|> <|user|> <|asst|> <|end|> <|abstain|>` | **MEASURED** |
| Real token ratio | **1.44–1.72 chars/token** (≈1.5), not the 4 the first budget assumed | **MEASURED** |
| Stages | Stage A causal pretrain → Stage B instruction SFT, one tokenizer for both | **MEASURED as code** · **NOT TESTED as quality** |
| Shipping quality target | `CONFIG_A`: ~37.9M params, vocab 16,384, 10 layers, context 1024 | **ESTIMATED** (arithmetic; `count_parameters.py` confirms the arithmetic) |
| Contingency | `CONFIG_LITE` ~17M, only if T1 budgets fail | **NOT TESTED** |

## TRAINING

| Property | Value | Tag |
|---|---|---|
| Corpus | 3.2 MB seed: EN / HI / Hinglish conversation, synthetic QA, portfolio references, copy-from-context, tech/code | **MEASURED** (`data/raw/seed/`) |
| Corpus provenance | **100 % own work**, generated deterministically by `training/scripts/make_seed_corpus.py` (seed 20260920). Every external source in `data/sources.json` is **disabled** pending licence verification, and the file's policy says there is no `--force` flag | **MEASURED** |
| Licence exposure | **None for what has been trained on** — we wrote every line. The §7.3 public datasets (Sangraha, Hindi Wikipedia, L3Cube-HingCorpus, simple English) have never been fetched | **MEASURED** |
| Tokenized shards | `data/processed/seed/shards/train-0000{0,1}.bin` + manifest | **MEASURED** |
| Local run that exists | `training/checkpoints/local`, **step 1100 of 1100**, resumed from step 800 and **finished**, `RUN_MANIFEST.json` written, export sha `f1eaf3a74e14…`, `tieGap 0.0` | **MEASURED** |
| Throughput on R1 | **1,335 tokens/s** (batch 4 × block 128, smoke config, loaded box) · **3,612 tokens/s** (256×8, local config, calm box) · ~850 tok/s quoted earlier for the CPU loop | **MEASURED** |
| Loss behaviour | 6.9471 → 0.6242 over 1100 steps, windowed gate **PASS** (6.8368 → 0.909), final val loss 0.7030 · the 50-step smoke gate was 6.6847 → 4.3151 | **MEASURED** |
| Did more steps help the answers? | **No.** 800 → 1100 steps changed the output (`"work reviewed cor byandeeer why"` → `"Uneomunyatoe thek, reviewed cor byandeainir…"`) but not its quality. The corpus is ~3 MB of generated text and the model is 5M params: it is memorising, not learning to answer. **The blocker is data and scale, not step count** | **MEASURED** |
| Checkpoint + resume | Verified, including config/tokenizer-version validation on load | **MEASURED** (`checkpoint.py`, resume test) |
| Run record for the shipped artifact | `RUN_MANIFEST.json` is written by `_finish()`, which every run and resume reaches, so the 800-step artifact's missing manifest proved that run was **interrupted**. Resuming it (`--resume auto`, step 800 → 1100) **finished the run and wrote the manifest** (23 KB: seed, config, tokenizer version, hyperparameters, data-shard hashes for 68 shards, full loss history) — the record-keeping is now proven on a run that completes | **MEASURED** |
| GPU / Kaggle Stage A+B | **Never run.** Scripts and notebook exist; the run is owner-side | **NOT TESTED** |
| P4 verify gate (9/9 sources) | **NOT TESTED** — no trained-for-quality checkpoint to gate | **NOT TESTED** |

## KNOWLEDGE

| Property | Value | Tag |
|---|---|---|
| Structure | 54 fact objects: 1 person, 4 contact fields, 2 links, 2 education, 38 skills, projects, experience, achievements | **MEASURED** |
| Public/private | A public-only view is what reaches the browser; `contact.phone` is not in `knowledge.json` | **MEASURED** |
| Retrieval | 60 chunks, 398-term vocabulary, avgdl 31.8; BM25-style scoring + fuzzy fallback, priced by the real tokenizer | **MEASURED** |
| Gate ($MIN_TOP_SCORE$) | Ceiling **4.647**, shipped **1.0**, floor **NOT MEASURED** (nothing in the corpus is kept out by it) | **MEASURED / NOT TESTED** |
| Alias routing | 230 aliases probed: misrouted **14 → 0**; token-ambiguous 55 → 57 (reported, not "fixed") | **MEASURED** |
| Evaluation set | 60 questions, **56 executable** without a trained model; calibration reproduced byte-for-byte after the planner/text split (only the timestamp changed) | **MEASURED** |
| Hallucination strategy | Layer 1 refuses before the model is asked; the model is given only retrieved public facts inside a delimited context; the guard checks the answer against a vocabulary built from shipped facts only; `<|abstain|>` is checked before the guard; unverifiable answers are withheld and labelled | **MEASURED** |
| Language | EN / HI / Hinglish detection, no selector — by design | **MEASURED** |
| Relevance of what is selected vs. what is asked | **MEASURED for the deterministic half, NOT TESTED for the model's** — grounding (every `expected_facts` cited) 100 %, 0 fabricated facts, alias routing 14 → 0 misroutes, gate ceiling 4.647 recomputed from the data. Whether a *generated sentence* is relevant to its question is **NOT TESTED**, and §14 asks for metrics (QA accuracy, unsupported-claim rate, abstention precision/recall) rather than a relevance judge: reading those needs a trained-for-quality checkpoint, which is owner-side. The checkpoint that exists answers with garbage, so a judge run against it would grade noise | **MEASURED / NOT TESTED** |

## BROWSER

| Property | Value | Tag |
|---|---|---|
| Runtime | Static bundle, ES modules; the model runs in a **module Worker** (`ai/engine/worker.mjs`); the page only parses tokens. The main thread does not even *parse* the arithmetic: `tests/build-bundle.test.mjs` follows the import graph and requires the tokenizer, matmuls, dequantiser and manifest verifier to be reachable from the worker and **not** from `ai/ui/chat.mjs` — **13,296 B gz** of worker-only script the click never loads | **MEASURED** |
| Format / quantization | One shard, **q8-row** weights + f32 norms, worst row error **0.001146** | **MEASURED** |
| Sizes | 5,059,584 B raw · **4,731,918 B gz** · 4,712,394 B brotli · tokenizer 66,667 B · first visit **4,798,585 B gz = 12 %** of §4's 40 MB (step-1100 export) | **MEASURED** |
| Engine parity | `npm run verify:engine` **PASS** on the step-1100 weights: 138 positions checked, argmax **100 %**, top-16 order 100 %, worst \|Δlogit\| **1.65e-5** (tolerance 0.02), torch↔numpy PASS, worst q8 row error **0.001356**, decode 79 tok/s, KV 3,072 KB | **MEASURED** |
| Caching | §9.3 version-keyed Cache Storage; second visit transfers **0 bytes** of model, verified with the model path 404ing | **MEASURED** (`dev-offline-probe.js`) |
| Offline after cache | The cached model answers with the network down | **MEASURED** |
| Memory | Extra heap while answering **1.3 MB** (§4 allows 300 MB); **0 MB** growth per reopen over 5 cycles | **MEASURED** |
| WebGPU | Probed (`probeWebGPU`) and reported in the tier title; **no WGSL kernels are written**, so it accelerates nothing | **NOT TESTED / NOT IMPLEMENTED** |
| WASM SIMD | Feature-detected (`hasSimd`) and reported; the kernels are JavaScript | **NOT TESTED / NOT IMPLEMENTED** |
| Fallbacks | T0 (no model) and download failure both verified end to end: `dev-degrade-probe.js` **20/20**, including recovery on reload | **MEASURED** |
| Firefox / Safari / iPhone | Never run | **NOT TESTED** |

## PERFORMANCE

The constraint that outranks everything else: *the portfolio must not get slower.*

| Metric | Value | Tag |
|---|---|---|
| Anything AI on initial load | The launcher only — **945 B gz**, and it is inert (no fetch, no worker, no network API, one dynamic import). `tests/launcher.test.mjs` gates it deterministically: the 2 KB budget, the single `import(CHUNK)` resolving to the chat shell, and that `index.html` names nothing under `ai/` (no script, link, import-map entry or preload). The browser half is `dev-ai-probe.js`'s network assertion | **MEASURED** (probe + gate) |
| What the click fetches | **41,221 B gz** static reach of `ai/ui/chat.mjs` (86,096 B before the comment strip, 102,596 B before the voice split) | **MEASURED** |
| First open | UI **221–405 ms**, knowledge + capability probe **285–722 ms** | **MEASURED** |
| Worst main-thread long task, AI windows | **65 ms** — against the page's own worst of **88 ms** with the panel never opened | **MEASURED** |
| Frame time, panel open vs closed | 25.2 ms vs 24.7 ms = **2 %** FPS drop (§4 allows 10 %); re-measured with the film's tier pinned: **18.3 vs 18.3 ms = 0 %** | **MEASURED** |
| GL programs compiled during answering | **0** (31 → 31) | **MEASURED** |
| §6.3 ladder during five answers | peak rung **1** (pace); **0** quality changes requested from the scene | **MEASURED** |
| Long task that *was* the AI's fault | Fixed: the ladder drove a material recompile via `getProgramInfoLog` — **1,221 ms → 0 ms** by gating rung 3 | **MEASURED** |
| Time to first token | cold **5,193 ms** · repeat question **17 ms** · different question sharing 120/142 ids **407 ms** (LCP prefix cache) | **MEASURED** |
| Decode | **19–25 ms/token**; prefill is **90–95 %** of the wait | **MEASURED** |
| CPU inference (Python, §14) | smoke **1,335 tok/s**; kernel **121 M MAC/s** vs **97 M** for a plain loop — this box measures JS **~10× below spec** | **MEASURED** |
| Mobile | Never run on a real phone; T1/T2 are heuristics. The closest was R1 under a 4×/6× CDP throttle, and that throttle under-penalises the Worker | **NOT TESTED** |
| Frame health, panel open vs closed (§14's ≤10 %) | **0 % median drift, 1.00× p95** on the real GPU (Intel HD 520, D3D11) with the film's tier pinned; 127 vs 126 frames, same tier/scale/position in both arms — **but see the next row before quoting it** | **MEASURED** |
| …and its control, which says a single run is worth ±90 % | The probe's second open sample, seconds later with the film untouched, measured **35.4 ms vs 18.3 ms = 93.4 % apart**; a separate run reported +92.9 % drift. The film on R1 is **bimodal (~18.3 / ~35.4 ms)** with the AI doing nothing, the ladder at `step=0` and no quality change. So "0 %" and "92.9 %" are both this box; the AI's own contributions are the *bounded* ones: no long task, no GL program, no quality change | **MEASURED** |
| Tier choice stability (§6.2) | Every recent run classified R1 as **T1 · LITE** while the earlier record says T2 — `benchSlowMs` (14 ms) reads a load-sensitive micro-benchmark, so a busy box downgrades itself. Conservative, and the tier sets the answer budget (96 vs 160 tokens), so it needs tuning against an idle reference | **MEASURED** |
| §4's reference profiles (never run before 2026-09-27) | R1 as it is **0 %**, R1 @4× CPU **−2.5 %**, R1 @6× CPU **+0.3 %** — all **1.00×** p95, all **43/43 checks**; panel ready 815 / 1,091 / 1,502 ms; first answer 25.1 / 45.4 / 42.8 s | **MEASURED** |
| A weak device, for real | **NOT TESTED** — the CDP throttle hits the main thread (frame time 18.3 → 35.3 ms) but not the Worker proportionally (first answer 25.1 → 45.4 s is 1.8×, not 4×), so this profile must not be quoted as a phone's latency | **NOT TESTED** |
| …and why it took this long | The A/B ran under software GL until 2026-09-27, where it was inconclusive; the first real-GPU run without a pin reported **−49 %** (the *open* arm faster) because the film's own governor walked tier 1 → tier 4 during the session — a confound the probe now detects and refuses to attribute | **MEASURED** |
| §4 code chunk | **69,079 B gz = 45.0 %** of 150 KB (84 KB headroom), conservative reading: every shipped `ai/**` + `knowledge.json`; was 138,896 B = 90.4 % until the build stopped shipping comments from `ai/**`. Asserted on every `npm test`, and reported by `npm run bundle` | **MEASURED** |

## CHAT


| Property | Value | Tag |
|---|---|---|
| Architecture | Shell (`ai/ui/chat.mjs`) → intent rules → retrieval → guard → model, all on-device; streaming tokens into one bubble | **MEASURED** |
| Context | Bounded by the **real** tokenizer: `maxSeq 512 − maxNew`, tier budget 96/160/256; 14 of 60 eval questions used to overflow the old 4-char estimate and surfaced as "the model stopped" | **MEASURED** |
| Stop / Retry / Clear | All three; Stop keeps the partial text and badges it `PARTIAL ANSWER · STOPPED BY YOU`; stopping during prefill gives an honest `cancelled` line, never "model stopped" | **MEASURED** |
| Language detection | EN / HI / Hinglish, automatic, **no selector** | **MEASURED** |
| When there is no model | The panel says so and answers nothing — its own line per reason (unsupported / failed / stopped) | **MEASURED** (20/20 degrade probe) |
| Anchors | 7/7 questions resolve to the right section; content-based, so moving a section keeps the answer right | **MEASURED** |
| Accessibility | `role`, `aria-modal`, `aria-labelledby`, `aria-live="polite"` on the transcript (announced complete, not per token), labelled Stop/Retry/Clear, `aria-pressed` mic, Escape closes | **MEASURED as code** · screen reader **NOT TESTED** |
| Responsive | Panel covers the scene below 640 px and pauses it | **MEASURED as code** · real device **NOT TESTED** |

## VOICE

| Property | Value | Tag |
|---|---|---|
| Tap & Speak | Exists; recogniser is the platform's (`SpeechRecognition` / `webkitSpeechRecognition`) — an open pretrained component, disclosed | **MEASURED as code** |
| Proactive | Wake phrase + hands-free mode, with a per-session limit and a stop word | **MEASURED as code** |
| STT | Platform speech recognition, local on Chrome | **MEASURED as code** · live microphone **NOT TESTED** |
| TTS | `speechSynthesis` with a voice picker; local, free | **MEASURED as code** · speech itself **NOT TESTED** |
| VAD | Our own energy-based detector (`ai/voice/vad.mjs`) | **MEASURED as code** · thresholds unvalidated on real speech |
| Laziness | §2 N6 enforced: only a capability table (`ai/voice/caps.mjs`) ships with the shell; the ~17 KB voice layer loads when a voice mode is chosen | **MEASURED** |
| Mic denied / unsupported | Unit-tested paths; state machine covered | **MEASURED as tests** · real permission prompt **NOT TESTED** |
| Resource use per tier | Not measured for voice specifically | **NOT TESTED** |
| Wake-phrase stability | Flips between runs on the stub engine (0/1 vs 1/2 wake events) | **INCONCLUSIVE** |

## TERNARY

**NO-GO.** No ternary code exists and none is planned for this iteration; the full
reasoning, the arithmetic and the four conditions that would re-open it are in
[`experiments/ternary/README.md`](../experiments/ternary/README.md). The honest
summary: at 4.98M params ternary's real benefit is **size** (~3 MB gz off a
4.93 MB first visit, ≈6 % of a budget we are using 12 % of), the speed benefit
needs kernels that stock browser runtimes do not provide, and the decision
belongs **after** the baseline passes its own gates — §13 says exactly that.

---

## §18 checklist, item by item

| Item | Verdict |
|---|---|
| Portfolio works, visually intact, GSAP/Lenis/Three.js OK | **MEASURED** — all pre-existing tests green; no renderer added; the film keeps its own rAF |
| No AI-caused jank | **MEASURED** — **0 % median frame drift / 1.00× p95** with the film's tier pinned on the real GPU, and 65 ms worst long task vs the page's own 88 ms |
| Three.js not duplicated, no new WebGL scene, no permanent extra rAF | **MEASURED** — 0 GL programs compiled while answering (browser probe), and a static gate over the shipped code: the whole `ai/` tree has no `getContext`, no canvas, no `THREE` object, no `setInterval`, and exactly one `requestAnimationFrame` (a one-shot class toggle). The frame monitor adds *and removes* a callback on the film's own GSAP ticker |
| Scratch tokenizer + model, random init | **MEASURED** |
| Stage A + Stage B done | **NOT TESTED** — owner-side GPU |
| Retrieval / guard / EN-HI-Hinglish / auto language detection | **MEASURED** |
| No language selector | **MEASURED** — none exists |
| No backend, no API key, local inference | **MEASURED** — the built bundle is scanned: no external URL in any shipped AI script, exactly one outbound call site (the site's own `knowledge.json`), no XHR/WebSocket/EventSource/sendBeacon, no secret-shaped string, no hosted-LLM hostname |
| Lazy-loaded; nothing AI on initial load | **MEASURED** — a failing network assertion in the e2e probe, plus a deterministic gate (`tests/launcher.test.mjs`) on the launcher's size, its single dynamic import and every `ai/` reference in `index.html` |
| Download + file sizes measured, caching + versioning | **MEASURED** — including 0 bytes on the second visit |
| Main thread protected, workers used | **MEASURED** — prefill (90–95 % of the wait) never touches the main thread, the model's arithmetic is only reachable from the worker (import-graph test), and the worst AI long task is 65 ms against the page's own 88 ms |
| WebGPU + WASM investigated | **MEASURED as investigation**; neither implemented, and the report says why |
| Unsupported / mobile paths handled | **MEASURED** for unsupported (20/20); mobile **NOT TESTED** |
| Chat: streaming, Stop, Retry, Clear, bounded context, accessible, responsive | **MEASURED** except screen-reader and real-device behaviour |
| Voice: both modes, local STT/TTS, lazy, permission paths, no selector, limits | **MEASURED as code/tests**; live speech **NOT TESTED** |
| Training resumable, checkpoints, evaluation, no fake results | **MEASURED** (resume verified); quality gates **NOT TESTED** |
| Ternary separated from the baseline | **MEASURED** — separated by not existing; decision recorded |

---

## KNOWN LIMITATIONS (the honest list)

1. **No trained-for-quality checkpoint.** The browser answers, coherently-ish and
   wrongly — real answers from this build read `"work reviewed cor byandeeer
   why"` at step 800 and `"Uneomunyatoe thek, reviewed cor byandeainir…"` at step
   1100. Training it further on this machine does not change that: 300 more steps
   moved the words, not the quality, because the corpus is ~3 MB of generated
   text. The engine, guard, budget and UI around it are verified; the *model* is
   a pipeline artifact.
2. **This laptop cannot produce trustworthy absolute timings.** Its load moves
   wall-clock numbers 2–3× between runs. Only interleaved same-process
   comparisons (minimum-of-N) are quoted as findings.
3. **No real GPU, no real phone, no Safari, no screen reader, no live
   microphone.** Every one of those is a NOT TESTED above.
4. **WASM SIMD and WebGPU are unimplemented**, and the payoff cannot be measured
   here — this box runs scalar JS ~10× below its own specification.
5. **The §4 code chunk is at 45.0 %** with 84 KB of headroom, so the budget is a
   regression guard rather than a constraint on the next feature. It halved on
   2026-09-27 because half its gzip was comments in our own `ai/**` modules and
   the build stopped shipping them (−69,817 B gz, nothing a visitor runs
   changed). The retired Quick Answers wording had already moved out
   (−2,864 B gz, no feature lost).
6. **Three open observations, recorded not explained:** the panel's own ready
   time has been measured at 390 ms, 815 ms and 19.3–27.9 s on this box within
   the same day; two of four resource runs showed +21 GL programs during an AI
   session while the other two showed none and the ladder never requested a
   quality change; and the frame A/B's p95 is identical to 0.1 ms in both arms.
   The film's own governor also walks tier 1 → tier 4 inside a single probe run,
   which is why the A/B now pins the tier and checks the film state in both arms
   before attributing anything.
7. **Ladder ↔ shell wiring** is now runtime-tested in the governor, but the full
   shell integration (scene hook effects end to end) is only covered at the
   module boundary.
8. **PII review**: C4/C5 still open for sign-off; `contact.phone` is deliberately
   not in the public knowledge file.
9. **Deployment host undecided**, so the production Cache-Control policy is
   written but not exercised on a real CDN.
10. **Prompt length is the remaining quality lever** — 125 of a typical prompt's
    tokens are rules that never change. Shortening them or retraining to shrink
    the block trades quality for latency and has not been decided.
11. **Hinglish will be the weakest of the three languages.** The Roman-Hinglish
    source that was meant to fix this (L3Cube-HingCorpus) is disabled, and
    programmatic data cannot reproduce human code-mixing — `data/sources.json`
    records that loss explicitly rather than papering over it with data we may
    not use.

## WHAT I NEED FROM YOU

1. **A GPU run** — the Kaggle notebook and scripts are in `training/notebooks/`
   and `training/scripts/`. Stage A + Stage B at config A is the single thing
   that turns the quality claim from false to true, and it is the only item on
   this list that nothing on this machine can substitute for. Before it, worth
   running `npm run train:local` to completion: it resumes from `latest` and
   writes the `RUN_MANIFEST.json` the interrupted run never wrote, so the
   record-keeping is proven on a run that finishes.
2. **Then a decision on the P4 gate** — whether the 9/9-source verify gate is
   the bar, or the §14 evaluation numbers replace it.
3. **A real-device pass** — one mid-range Android and one iPhone, for the T1/T2
   thresholds, live microphone and screen reader. The checklist for it already
   exists (`docs/MANUAL_TEST_CHECKLIST.md` §D, all NOT TESTED).
4. **A deployment host decision**, so caching and the offline-after-cache path
   are verified against the headers visitors will actually see.
5. **Sign-off on the PII list** (C4/C5).

---

### Where the evidence lives

`AUDIT.md` · `docs/BASELINE.json` · `docs/BENCHMARKS.md` (every measurement, with
its instrument) · `docs/CALIBRATION.json` · `docs/CPU_BENCHMARK.json` ·
`docs/RESOURCES.json` · `docs/AI_ARCHITECTURE.md` · `docs/PROGRESS.md` ·
`docs/PRIVACY.md` · `docs/MANUAL_TEST_CHECKLIST.md` ·
`experiments/ternary/README.md`.

Reproduce in this order: `npm run test:all` · `npm run build` · `npm run bundle`
(the §4 figures) · `npm run verify:engine` · `npm run probe:resources` ·
`npm run probe:latency` · `npm run probe:offline` · `node dev-ai-probe.js` ·
`node dev-degrade-probe.js`.
