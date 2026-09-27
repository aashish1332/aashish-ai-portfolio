# §19 research notes — the re-verification

**Run 2026-09-27.** The brief's own §2 item 7 says *"Verify, then claim …
§19 research is dated Sep 2026"*, and §19's heading says *"re-verify before
relying on them"*. This file is that check, claim by claim, with the source it
was checked against and **what this project actually depends on it for**.

Two things to say before the table, because both bear on how much it is worth:

- **This is a literature check, not a run on this machine.** Nothing here is a
  measurement of our code. Where a number was measured on R1, the row says
  which `docs/BENCHMARKS.md` entry it is; the rest is what a source published.
- **Only one note changed the code** (Web Speech on-device, row 6). The rest
  were already the basis of a decision that did not move — which is the useful
  result: the decisions were made on notes that still hold.

| # | Note, as §19 states it | Verdict | What the sources say on 2026-09-27 | What we depend on it for |
|---|---|---|---|---|
| 1 | WebGPU ships in Chrome/Edge, Firefox (Windows; macOS ARM) and Safari 26; Android/Linux/older GPUs vary → feature-detect + fallback | **CONFIRMED, with version detail added** | Chrome and Edge are full-support at 144 (Chrome on **Linux** arrived in 144); Firefox shipped on Windows at 141 and macOS ARM at 145; Safari 26 ships it. Mozilla expects Linux work **during** 2026 and Android work during 2026 — i.e. still not everywhere. ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)) | `probeWebGPU()` in `ai/governor/index.mjs`, which reports the capability in the tier title and **accelerates nothing**. The note's own conclusion — detect, never assume — is why no WGSL kernel was written |
| 2 | WASM is the universal fallback; WebGPU wins on larger models but can add seconds of first-run shader compilation | **CONFIRMED as an estimate, with a range** | Shader compilation is identified as the primary cold-start cost of WebGPU inference; the published ranges are **10–30 s** for a first run (blog-level sources, not a primary measurement). ([SitePoint](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/)) | The decision to keep our own JavaScript kernels and to write no WGSL: at 4.98M parameters the first-run shader cost is paid before the model is fast, and R1 cannot measure the payoff (§13's note, `experiments/ternary/README.md`) |
| 3 | ~125M-parameter general models rarely stay coherent; **sub-10M models on a narrow curated distribution can** | **CONFIRMED** | TinyStories (Eldan & Li, 2023): models **below 10M parameters** produce coherent English when trained on its narrow synthetic distribution of ~1.3M short stories (a few GB of text). ([arXiv 2305.07759](https://arxiv.org/abs/2305.07759), [dataset card](https://huggingface.co/datasets/roneneldan/TinyStories)) | The whole premise of a 4.98M-parameter model. Our own measured result sharpens the note rather than contradicting it: our corpus is **3.2 MB** against that paper's few GB, the model memorised it (loss 0.624) and did not learn to answer — the same conclusion as `docs/FINAL_REPORT.md`'s "blocker is data and scale" |
| 4 | wllama: llama.cpp in WASM (GGUF, SIMD, worker, auto single/multi-thread; multi-thread needs COOP/COEP; v3 adds WebGPU; check Memory64/Safari compat) | **CONFIRMED** | wllama V3 ships WebGPU, multimodal and tool calling. The 2 GB wasm ceiling is real enough that a Memory64 fork exists for larger models; threads still depend on cross-origin isolation. ([ngxson/wllama](https://github.com/ngxson/wllama), [wllama64](https://github.com/actuallymentor/wllama64)) | Nothing at runtime — we wrote our own engine. It is the *reason* the engine has a named seam: `ai/engine/index.mjs` is where wllama or ORT-Web goes if a benchmark ever favours them |
| 5 | Cross-origin isolation for threaded wasm is COOP + COEP; GitHub Pages cannot set headers; a service-worker workaround exists | **CONFIRMED, replacement still a proposal** | `coi-serviceworker` is the standing workaround; the cleaner replacement, `Document-Isolation-Policy`, is still a WICG proposal. ([coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker), [Document-Isolation-Policy](https://wicg.github.io/document-isolation-policy/)) | Why our engine is single-threaded and why the deployment notes do not depend on headers we may not be able to set — the host is still undecided (`docs/DEPLOYMENT.md`) |
| 6 | Web Speech on-device mode: default recognition is usually server-side; `processLocally` + `available()`/`install()` gives on-device with a language pack (experimental) | **CONFIRMED — and it changed the code** | MDN now documents both statics: `SpeechRecognition.available()` and `SpeechRecognition.install()`; §19's "experimental" label still applies, and a Chromium regression against the on-device path was filed in Sep 2025. ([MDN available()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/available_static), [MDN install()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/install_static)) | See below — this is the one note that turned into behaviour |
| 7 | Moonshine: tiny on-device STT, ~26 MB-class, English + a few languages; Whisper's weak coverage at small sizes | **REFINED — the range moved down** | Moonshine now advertises **tiny 1 MB-class** models alongside 27M-parameter Tiny models, and the 27M family is reported to match or beat Whisper Medium across 6 languages. ([moonshine-ai](https://github.com/moonshine-ai/moonshine), [arXiv 2509.02523](https://arxiv.org/html/2509.02523v1)) | Not adopted — we use the platform recogniser. It is the serious alternative if that prerequisite ever fails, and the size argument for it is **stronger** than when the note was written |
| 8 | Silero VAD: ~1 MB, MIT, < 1 ms per 30 ms chunk on one CPU thread | **REFINED — the size is larger** | The ONNX model is **~2.3 MB** (the JIT model is the ~1 MB one), ~1 ms per 30 ms chunk, and ONNX runs 4–5× faster than the JIT model. ([silero-vad](https://github.com/snakers4/silero-vad), [model card](https://huggingface.co/mijuanlo/silero-vad-onnx)) | `ai/voice/vad.mjs` documents why an energy VAD was written instead (a second wasm runtime and a second model, for a question the browser's recogniser already answers). The correction makes that trade *worse* for adopting Silero, not better |
| 9 | Kokoro-82M / kokoro-js: browser TTS via WASM/WebGPU, **q8 ≈ 86 MB** reported, Hindi supported by the model — verify phonemization in-browser | **PARTLY VERIFIED — the size figure stays ESTIMATED** | The model (82M params) and its browser deployment through Transformers.js (WASM with WebGPU support) are confirmed, as is multi-language coverage across language groups. **No primary source for the 86 MB q8 figure was found in this pass**, and in-browser Hindi phonemization is still unverified. ([Xenova announcement](https://huggingface.co/posts/Xenova/503648859052804), [kokoro-js](https://www.npmjs.com/package/kokoro-js)) | Nothing: voice output is `speechSynthesis` (§11.4 V0, local and free). The note stays a *candidate* with an unverified size, and is labelled as such rather than quoted |
| 10 | sherpa-onnx: one WASM toolkit for VAD + ASR + TTS (Piper models supported) | **CONFIRMED** | Still maintained as a single toolkit covering VAD, ASR and TTS, with WASM support, browser demos and an npm package updated Sep 2026. ([k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), [npm](https://www.npmjs.com/package/sherpa-onnx)) | Not adopted. It is the option that would let us drop the platform recogniser entirely; recorded as the alternative, not as a plan |
| 11 | iOS memory: ~300 MB reliably available to wasm on some iPhones; tab kills on overflow — re-measure | **CONFIRMED, revised upward, and still NOT TESTED here** | 2026 analyses put the practical per-page ceiling on iOS at **~300–450 MB**, device-dependent, with no swap and no graceful failure — the tab is killed. ([catchmetrics, Jan 2026](https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit), [lapcatsoftware, Jan 2026](https://lapcatsoftware.com/articles/2026/1/7.html)) | §4's allowance and §6.2's tiers. Our measured exposure is small (4.7 MB first visit, **1.3 MB** extra heap while answering), so the number that matters is the decode working set on a low-end phone — which is exactly the item that is **NOT TESTED** on this laptop |
| 12 | Frame-health APIs: Long Tasks / Long Animation Frames are Chromium-only → use ticker-delta sampling as the cross-browser signal | **CONFIRMED** | LoAF still ships only in Chromium (Chrome 123+) — Safari is not supported — and Chrome 153 (Sep 2026) extended it to worker threads. ([Chrome for Developers](https://developer.chrome.com/docs/web-platform/long-animation-frames), [Chrome Status](https://chromestatus.com/feature/5387465121726464)) | The *product*: `createFrameMonitor` samples the film's own GSAP ticker, so §14's ≤10 % frame-health number exists on every browser. The **instruments** are the Chromium-bound part — `dev-baseline-probe.js` and `dev-resource-probe.js` use `PerformanceObserver('longtask')`, so their TBT-proxy and main-thread-busy figures are Chromium numbers (`docs/BASELINE.json` already says so) |
| 13 | Ternary: bitnet.cpp's speedups come from dedicated CPU kernels; a WebGPU/WGSL browser port exists for the 2B model | **CONFIRMED** (already recorded in P10) | `bitnet.cpp` is a suite of native kernels for 1.58-bit inference (2.37×–6.17× on x86, 1.37×–5.07× on ARM); the browser ports are early and aimed at models orders of magnitude larger than ours. | The P10 **NO-GO** and its four re-open conditions, in `experiments/ternary/README.md` — which is where this row is verified in full |

---

## The one note that became behaviour (row 6)

§19 said the on-device mode exists and is experimental. What it did not say is
that it is *askable*: `SpeechRecognition.available({ processLocally: true,
langs })` answers `available | downloadable | downloading | unavailable`
**before** a session starts. That turns a disclosure into a choice:

- `ai/voice/index.mjs` asks **once per session**, before the microphone opens.
- `processLocally` is set **only on `'available'`** — a pack that still has to
  be downloaded would fail the session, and a microphone that does not work is
  a worse outcome than a disclosed one. `install()` is deliberately **not**
  used: it downloads a language pack, which is not something to start on a
  click.
- The panel's sentence follows the answer: `SPEECH_DISCLOSURE` (audio leaves
  the device) is the default and the one shown while the question is open;
  `SPEECH_DISCLOSURE_ON_DEVICE` is shown only after the platform has said yes.
  The shell waits for the answer rather than printing one and contradicting it
  (`ai/ui/chat.mjs`, `disclosurePending`).
- If the engine refuses the on-device mode anyway — the Sep 2025 Chrome
  regression is exactly this shape — the server-side engine is the fallback,
  **once**, reported, with the cautious sentence coming back. It is not asked
  for twice in a session.

Tests: `tests/voice.test.mjs` VOICE-12 (7 cases) covers the answered, the
refused, the never-answered and the engine-refuses-it cases. The one thing
those tests cannot cover is a real microphone: **the on-device path itself is
NOT TESTED on a real device** (`docs/MANUAL_TEST_CHECKLIST.md` §D).

## What is still NOT TESTED after this pass

- **Every claim above is a reading, not a measurement on this machine.** No
  source here was reproduced locally; that was never the ask.
- **Row 9's 86 MB** — no primary source found, so it remains ESTIMATED and must
  not be quoted as a measured size.
- **Row 11 on the device that matters.** R1 is not a phone, and the CDP
  throttle under-penalises workers (MEASURED, `docs/BENCHMARKS.md`), so no
  number in this repo is a phone's memory or latency.
- **Row 6 in a browser.** The code path is tested against a double; whether
  Chrome's current on-device pack answers `available` for `en-IN` / `hi-IN` on
  a real machine is unverified.
