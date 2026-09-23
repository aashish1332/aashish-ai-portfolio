# TASK — Aashish AI: on-device, backend-free, scratch-trained portfolio assistant

**Prompt v2 · refined Sep 2026 · paste this whole file into the coding session**

> Talk to me in Hinglish (Roman Hindi + English tech terms). Code, comments and docs stay in English.

---

## 0. Mission and working rules

Add a premium **AI assistant ("Aashish AI")** to my **existing** portfolio: text chat plus two voice modes — **Tap & Speak** and **Proactive**. It answers recruiter/visitor questions about me from **verified data only**, runs **entirely in the visitor's browser**, and must never hurt the portfolio's smoothness.

Do **not** rebuild, redesign or restructure the portfolio. Its heavy UI (GSAP, Lenis, Three.js/WebGL, 3D, smooth scroll) is the primary experience. The AI is a *guest on the visitor's device*: small, lazy, self-limiting, easy to unload. The visitor's hardware is a shared resource — the AI must adapt to it, not assume it. Read the code carefully before editing.

**Working rules**

1. **Phase-gated.** Follow §16. Finish a phase, run its gate, append what was done / measured / still open to `docs/PROGRESS.md`, then continue. A failed gate means fix or descope *and document* — never skip silently.
2. **Audit before code (Phase 0).** Detect, never assume: framework, package manager, bundler, routing, design system, where the GSAP ticker / Lenis instance / Three.js render loop live, deployment target, analytics, env vars, existing AI code. Write `docs/AUDIT.md` first.
3. **Git safety.** `git status` first. Work on branch `feature/aashish-ai`, small commits. No `reset --hard`, no force-push, no deleting unrelated files.
4. **Compute reality.** My dev laptop (i5-6300U, 8 GB, Intel HD 520, Windows 10) is for smoke tests only — and it is an excellent *weak-device test rig*. Real training runs on Kaggle T4 (also Colab / Lightning AI); **I** run it using the notebook + scripts you write, with exact step-by-step instructions. Until real checkpoints exist, ship in `MODEL_STATUS=untrained` mode: only the deterministic Quick Answers engine (§5), clearly labelled. Never present smoke-test output as a trained model.
5. **No fake numbers.** Every figure in docs, UI and the final report is tagged **MEASURED** (method + device), **ESTIMATED** (formula shown) or **NOT TESTED**.
6. **Don't ask what you can find.** Ask only when truly blocked.
7. **Verify, then claim.** Re-verify library versions and browser support at implementation time; §19 research is dated Sep 2026.
8. Long-running work (training, big benchmarks): give me exact commands and continue with other phases.

---

## 1. Inputs and sources of truth

- **CV (authoritative):** `Documents/Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx` (Windows: `%USERPROFILE%\Documents\…`; it is probably *outside* the repo). Read it directly (python-docx / mammoth / pandoc). If not at that path, search the workspace and my Documents for `Aashish_Kumar_CV*` before asking. **Never copy the .docx into the repo or commit it.**
- Also read the existing portfolio content (sections, project text, links) and README/docs. Cross-check against the CV. Conflicts go to `knowledge/CONFLICTS.md`; CV wins by default; unresolved conflicting facts are excluded from answers.
- Extract everything into `knowledge/knowledge.json` (schema in §8.1).
- **Privacy — important:** everything shipped to the browser (knowledge.json, prompts, weights) is public to every visitor. Default `public:false` for phone number, home address, date of birth, ID numbers, anything sensitive. Email / social links are `public:true` only if the portfolio already shows them publicly. At the end of Phase 1, print a **PII review list** for my approval. No secrets anywhere in the bundle.
- Never invent personal information.

---

## 2. Non-negotiables

| # | Rule |
|---|------|
| N1 | Existing portfolio stays functionally and visually intact; no regression beyond the budgets in §4. |
| N2 | **No backend**, no server-side inference, no hosted LLM API, no API key, no serverless endpoint, no database server. Deployable as a static site. |
| N3 | Visitor text and voice never leave the device. No analytics containing chat content. Any remote speech-recognition mode is disabled. |
| N4 | The final conversational LLM is trained **from random initialization by us**: own tokenizer, own architecture code, own training loop + checkpoints, own instruction tuning. Public datasets are fine. Pretrained LLM weights/tokenizers as the final model are not. STT / TTS / VAD may use open pretrained models — **disclose this honestly** in README, docs and the UI "About" popover. |
| N5 | Zero-hallucination policy (§8.4). Accuracy beats impressiveness. |
| N6 | **Nothing AI-related** (JS, wasm, weights, workers, mic, GPU) loads or initializes before the visitor clicks "Ask Aashish AI". Voice assets load only when a voice mode is chosen. |
| N7 | If AI cannot run, the portfolio still works and the visitor still gets a graceful path. Never crash, freeze scrolling, show a blank modal or an endless spinner. |
| N8 | No second WebGL/Three.js renderer, no heavy canvas scene, no permanent extra rAF loops for AI visuals. |

**Priority when goals conflict:** factual correctness → existing portfolio smoothness → stability on weak devices → privacy → useful answers → language handling → latency → download/RAM size → voice quality → visual polish → experimental ternary.

---

## 3. What "works on all devices" means here

Not "the same model everywhere", but **graceful tiers** (§6):

- **Every** visitor gets something useful: the **Quick Answers engine** (deterministic, from `knowledge.json`, no model, no download) works even on T0 devices and while the model is still downloading. It is labelled honestly ("Quick answer — no AI model on this device").
- Capable devices additionally get the scratch-trained LLM.
- Voice is opt-in, tiered, and downgrades automatically when the device struggles.

---

## 4. Resource budgets (targets to verify — log actuals in `docs/BENCHMARKS.md`)

| Area | Target | If exceeded |
|---|---|---|
| Initial page load (before click) | **+0** requests for AI assets; launcher ≤ ~2 KB gz; no worker, mic, GPU or wasm init; LCP/TBT within noise of baseline | Move everything behind dynamic `import()` |
| Chat UI chunk (UI + knowledge.json + retrieval + language detect + guard + Quick Answers) | ≤ ~150 KB gz | Split / trim |
| LLM runtime (JS + wasm) | Measured; choose the smallest that meets needs | Lighter runtime |
| LLM weights, text only | ≤ ~25 MB preferred, ≤ ~40 MB hard. ESTIMATE for a ~38M model: fp16 ≈ 76 MB, INT8 ≈ 38 MB, INT4-linear + INT8-embeddings ≈ 23–25 MB | Stronger quantization or "Lite" model (§7.1) |
| **First-use download, text chat (runtime + weights + tokenizer)** | ≤ ~40 MB total on T1/T2; ≤ ~50 MB on T3. One-time, then cached (0 MB on later visits) | Stronger quantization → "Lite" model; never ship a bigger default |
| **Any single AI asset** | Hard cap ~100 MB. Anything > ~40 MB needs an explicit consent tap that shows the size. **A ~300 MB asset is a bug, not an option** | Pick a smaller variant / different component |
| **Voice add-ons (each, opt-in)** | OS voices / on-device browser STT = 0 MB. Small STT and neural TTS: size shown before download, each ≤ ~100 MB, quantized (q8 or lower) only | Fall back to OS voices / typing |
| Extra tab RAM, text chat | ≤ ~150 MB mobile-class, ≤ ~300 MB desktop | Drop a tier |
| Extra RAM with voice | Tier-dependent (§6); on T1 never STT + neural TTS + LLM resident together | Sequence / unload |
| AI work on main thread | No task > 50 ms; per-frame AI work ≤ ~2 ms | Move to worker / batch |
| Portfolio frame health while AI generates | Median FPS drop ≤ 10% vs baseline; p95 frame time ≤ 1.5× baseline (reference profiles, §15) | Governor degrades (§6.3) |
| LLM speed | First token ≤ ~2 s desktop / ≤ ~4 s mobile after ready; ≥ ~8 tok/s minimum, otherwise reduced mode | Reduced mode |
| Voice (Tap & Speak) | End-of-speech → first audio ≤ ~3 s on T2 | Smaller STT / OS TTS |

---

## 5. Architecture

```
STATIC HOST ── existing portfolio (GSAP · Lenis · Three.js)        ← untouched, loads first
                   │  click "Ask Aashish AI"   (the ONLY trigger)
                   ▼
           AI launcher (≤ ~2 KB) → dynamic import()
                   ▼
   Chat UI chunk: knowledge.json · retrieval · language detect · guard
                  └── Quick Answers engine (no model) — instant, works on ANY device
                   ▼
   Resource Governor: capability probe → tier T0–T3 · live frame-health monitor
                   ▼
   AI Worker (dedicated) ── LLM runtime: WASM-SIMD default · WebGPU opt-in (T3 only)
                   │            └─ model shards from Cache Storage / OPFS (versioned, sha256)
   Voice (lazy, opt-in): VAD → STT → same pipeline → TTS
                   └─ own worker(s), unloaded when idle, ≤ 2 wasm runtimes resident in total
```

### 5.1 Answer pipeline — deterministic-first, model-second, guarded

1. **Normalize + detect language** (§8.3).
2. **Intent + entity resolve** (rules): greeting, contact, list-projects, project-detail, skills, education, experience, achievements, meta ("who are you / are you Aashish?"), out-of-scope, injection-suspect.
3. **Retrieve** (§8.2) top-k verified chunks, using the conversation's *focus entity* for pronouns.
4. **Route:**
   - retrieval score below threshold or out-of-scope → localized **abstention** (no LLM call);
   - *verbatim-fact* intents (email, links, plain lists of skills/projects) → **Quick Answers template** filled from `knowledge.json` (no LLM, exact by construction);
   - everything else (explanations, comparisons, follow-ups, "what kind of developer", small talk, Hinglish phrasing) → **LLM** with ≤ ~300 tokens of verified context, greedy / low-temperature decoding.
5. **Faithfulness Guard** on LLM output (§8.4). Fail → one greedy retry with a shorter context → else extractive Quick Answer fallback.
6. **Render as text only** (never `innerHTML`); resolve `<|fact:…|>` placeholders to allowlisted values/links.
7. **Suggested follow-ups** computed deterministically from the knowledge graph (zero extra inference cost).

Quick Answers templates exist in EN / Hindi / Hinglish, written naturally (I will review them).

---

## 6. Device tiers and the Resource Governor

Build one small module (`ai/governor`) used by chat and voice.

### 6.1 Capability probing (only after the visitor clicks)

Feature-detect, never UA-sniff: Worker + `fetch` streaming, WebAssembly + **SIMD** (validate a tiny SIMD module), `crossOriginIsolated`, `navigator.gpu` + `requestAdapter()`, `navigator.hardwareConcurrency`, `navigator.deviceMemory` (Chromium-only, coarse, capped), `navigator.connection.saveData` / `effectiveType` (Chromium-only), `navigator.storage.estimate()`, `matchMedia('(pointer:coarse)')`, `prefers-reduced-motion`, `speechSynthesis.getVoices()`, `SpeechRecognition.available(…)`.
Because iOS Safari and Firefox hide memory/network info, also run a **~200–300 ms micro-benchmark** (matmul loop in the worker) and combine it with the flags. Thresholds come from *measured* results on real hardware, not guesses — start with the table below and tune.

### 6.2 Tiers (starting heuristics — validate and adjust)

| Tier | Typical device | LLM | Context / max new tokens | Voice |
|---|---|---|---|---|
| **T0** unsupported / no consent / no storage | very old browser, no Worker/WASM, quota too low, user declines download | **None** — Quick Answers only | — | None |
| **T1** lite | phones, iOS, ≤ 4 threads, low benchmark | Same model INT4/INT8, WASM, 1 thread (or distilled "Lite" model) | 512 / ≤ ~96 | **Tap & Speak only**; OS TTS; STT via on-device browser API if available, else small model behind explicit consent; **Proactive disabled**; sequential loading |
| **T2** standard | normal laptops, mid phones | WASM, 1–2 threads | 768 / ≤ ~160 | Tap & Speak + **Proactive** (VAD-gated); OS TTS default; neural TTS optional with consent |
| **T3** high | modern desktop, many cores, healthy GPU | WASM by default; WebGPU only if A/B-proven | 1024 / ≤ ~256 | All modes; neural TTS optional |

The tier is a *starting point*: the governor can move a session down at runtime (§6.3), never silently up.

### 6.3 Live frame-health monitor and degrade ladder

- **Reuse the existing GSAP ticker** (or the existing single rAF) to sample frame deltas — **do not add a new rAF loop**. Keep an EMA + p95 over a short window. Add `PerformanceObserver('longtask' / 'long-animation-frame')` as an *extra* signal where available (Chromium only; not in Firefox/Safari).
- While the AI is active and frames stay slow (e.g., > ~24 ms sustained for ~500 ms), degrade **one step at a time**, and restore when idle:
  1. pace generation (yield between token bursts, smaller batches);
  2. lower `max_new_tokens` / context;
  3. ask the existing scene to lower quality *temporarily* (`setQuality('low')`: cap pixel ratio, disable post-processing) or pause it while the panel covers the viewport;
  4. switch to extractive Quick Answers for the rest of the session and tell the visitor.
- Voice Proactive → automatically falls back to Tap & Speak with a notice if step 3–4 is reached.
- Never permanently change the portfolio's visual identity.

### 6.4 Memory and lifecycle

- One `AIRuntime.dispose()` path: terminate workers (the only reliable way to free wasm memory), stop `MediaStream` tracks, close `AudioContext`, revoke object URLs, drop tensors/buffers, remove listeners, clear timers.
- Unload the LLM after the panel is closed and idle (e.g., ~2 min); unload voice models on leaving voice mode or after idle. Model files stay in the cache so reload is fast.
- **Runtime consolidation:** at most **two** wasm runtimes resident (LLM + voice). If ONNX Runtime Web wins the LLM benchmark, share it with VAD / STT / TTS; if using sherpa-onnx for voice, keep VAD + ASR + TTS inside that one runtime.
- iOS caution: a 2024 WebKit bug report says only ~300 MB was reliably available to WebAssembly on some iPhones, and Safari may kill the tab instead of failing the allocation. **Re-measure on a real iPhone**; until then treat iOS as T1–T2 with no simultaneous heavy models.
- Bounded chat history (§10) keeps latency and memory in check.

### 6.5 Network and storage etiquette

- Always show the download size before it starts. Auto-start only if: desktop-class or unknown device **and** not `saveData` **and** `effectiveType` is not 2g/3g **and** size ≤ ~30 MB. Otherwise show a clear "Download ≈NN MB (one-time, cached) / Use quick answers" choice.
- Check `navigator.storage.estimate()` before downloading; handle `QuotaExceededError` and later cache eviction (re-download or fall back to Quick Answers). Don't request persistent storage unless it clearly helps.
- Shards ≤ ~8 MB, parallel download, resumable, SHA-256 verified (SubtleCrypto), progress via streaming `fetch`.
- Downloads start only after the click, run from the worker (never blocking the main thread), use low fetch priority where supported, and never compete with the portfolio's own assets. While they run, Quick Answers already works. On later visits the cached model loads with **0 MB** of network.
- If the measured size ever exceeds the §4 caps, stop and fix the model/quantization choice — do not "just ship it".

---

## 7. Model, tokenizer, training

### 7.1 Architecture (own implementation, Llama-compatible layout)

- Decoder-only, pre-norm **RMSNorm**, **RoPE**, **SwiGLU** FFN, **GQA**, tied embeddings, causal attention.
- **Starting config "A":** vocab 16,384 · d_model 512 · 10 layers · 8 heads / 4 KV heads (head_dim 64) · FFN hidden 1408 · train ctx 1024 (deploy cap per tier). ARITHMETIC ESTIMATE: embeddings ≈ 8.4M + 10 × ≈ 2.95M ≈ **~37.9M params**; KV cache ≈ 10 KB/token in fp16 ≈ ~10 MB at 1024 tokens. Confirm with `count_parameters.py` (target 30–50M, ~40M preferred).
- Write all model/training code yourself (that is what makes it "scratch"), but keep **tensor naming and config compatible with the HF Llama layout** so the trained model exports to GGUF (llama.cpp / wllama) and ONNX (ORT-Web / Transformers.js) without a custom runtime. App-level extras (placeholders, guard) live in the tokenizer/app layer, not in the graph.
- Because the KV cache is tiny at this size, long history hurts *latency* (prefill), not RAM — cap context for speed.
- **Contingency "Lite"** (only if T1 budgets fail): distill our own model into ~15–20M params (e.g., d=384, L=8, GQA, vocab ~12k ≈ 17M by arithmetic). Still scratch — the teacher is ours.

### 7.2 Tokenizer

- Train our own BPE/Unigram (SentencePiece or HF `tokenizers` *trainer* on our corpus — never load a pretrained vocab). 12–16k vocab, byte-fallback, NFC normalization; must handle English, Devanagari Hindi, Roman Hinglish, code/tech terms, URLs, punctuation.
- Small vocab on purpose: embeddings are ~22% of params at 16k×512 but ~40% at 32k — smaller vocab = more capacity per layer and a smaller download. If experiments show 16k hurts Hindi/Hinglish badly, go up (max 32k) and justify with fertility numbers.
- Special tokens: `<|sys|> <|ctx|> <|user|> <|asst|> <|end|> <|abstain|>` and **placeholders** `<|fact:contact.email|>`, `<|fact:project.<id>.repo|>` … The model emits a placeholder; the app substitutes the verified value. URLs, emails, dates and numbers are never generated character by character.
- Report tokens-per-word for EN / HI / Hinglish / tech terms. Version it (`tokenizer_version`).

### 7.3 Stage A — general language from random init (narrow, not "the whole web")

- Small models become fluent when trained on a **narrow, curated distribution** (TinyStories result), while broad web text at ~100M+ params still gives weak coherence. So Stage A = **simple, clean, conversational** English + Hindi (Devanagari) + Roman Hinglish + **copy-from-context** tasks (short passage + question → answer using only the passage). Not a generic web dump.
- Candidate open sources — *verify each license/ToS and record in `DATA_LICENSES.md`*: simple/curated English text and dialogue; AI4Bharat **Sangraha** (Hindi, verified subset); Hindi Wikipedia; **L3Cube-HingCorpus** (real Roman code-mixed, but Twitter-derived → needs PII / toxicity / URL filtering + license check); programmatic Hinglish. Prefer human-written or programmatic data; if any third-party LLM-generated dataset is used, record provenance and disclose it.
- Pipeline: clean → normalize → dedupe → language-ID → filter (PII, toxicity, length) → tokenize → shard (binary memmap) → train/val split with leakage checks.
- Token budget: decide **after measuring tokens/sec in the first ~100 steps** on the actual GPU. The "~20 tokens per parameter" rule (≈0.8B tokens for 40M) is a reference, not a requirement. Log val loss, perplexity (only where meaningful) and sample generations at every eval.

### 7.4 Stage B — portfolio instruction tuning (context-grounded)

- Format: `<|sys|> role + rules <|ctx|> retrieved facts (with ids) <|user|> … <|asst|> answer <|end|>`, multi-turn with bounded history, loss only on assistant tokens.
- Data is generated **programmatically from `knowledge.json`** (templates × paraphrases × EN/HI/Hinglish) plus hand-written seeds. ~30k–150k examples. Starting mix: single-turn factual 35% · multi-turn follow-ups/pronouns 15% · abstention (info absent) 15% · language switching 10% · recruiter-style open questions (summaries, "what kind of developer", strengths — from verified facts only) 10% · greeting/meta/small talk 5% · adversarial/prompt-injection 5% · other 5%.
- **Counterfactual-context training (key anti-hallucination technique):** in ≥ 30% of examples, swap entity names/values inside the context for fictional ones and require the answer to follow the *context*, not memory. Add examples where the context lacks the answer → `<|abstain|>` reply. The model learns "read and rephrase the context", not "recall facts", so knowledge can change without retraining.
- Deliver `evaluation/review_sample.md` with ~100 random Hindi/Hinglish examples so I can check naturalness.
- Decoding defaults: greedy or T ≤ 0.3, top-p 0.9, tiny repetition penalty, per-tier `max_new_tokens`, stop at `<|end|>`. Concise by default (about 2–4 sentences); longer only on request, within tier caps.

### 7.5 Training engineering

- Scripts in `training/scripts/` **and** `training/train_scratch_model.ipynb` (sections: setup, dataset, tokenizer, statistics, model, parameter count, training, validation, checkpointing, instruction tuning, evaluation, export, CPU inference, benchmark). Training must not depend only on the notebook.
- CUDA, **fp16 AMP** (T4 has no bf16), gradient accumulation, PyTorch SDPA attention (do not depend on FlashAttention-2 for T4), optional `torch.compile`.
- Checkpoints: `latest`, `best`, `step_N`. Save model + optimizer + scheduler + GradScaler + step/epoch + config + tokenizer version + RNG states + data-shard cursor; atomic writes; **auto-resume**. Persist outside the ephemeral session (Kaggle Dataset / Drive / HF Hub) and document how. (Session-time limits and weekly GPU quota apply — check current values.)
- Local **smoke test**: 1–3M-param config, ~50 CPU steps — verifies pipeline, resume, export and browser load. It is *not* a quality result.
- Reproducibility → `training/RUN_MANIFEST.json`: seed, model + tokenizer configs, dataset version + hashes, hyperparameters, git commit.

---

## 8. Knowledge, retrieval, language, anti-hallucination

### 8.1 `knowledge.json` (versioned, independently updateable)

`person`, `education[]`, `skills[]` (name, category, evidence ids), `projects[]` (id, name, summary, tech[], role, links[], status), `experience[]`, `achievements[]`, `certifications[]`, `contact{}`, `links[]`, `meta{version, built_from, built_at}`. Every fact: stable `id`, `source` (cv | portfolio), `public` flag, optional `aliases` (including Hindi/Hinglish spellings). Updating knowledge must **not** require retraining.

### 8.2 Local retrieval

BM25 + alias/transliteration map + char-n-gram fuzzy matching (Hinglish spelling variants like kya/kia, project/projects) + an entity index + the conversation's **focus entity** ("uska database kaun sa tha?"). Top-k ≤ 3 chunks, ≤ ~300 tokens in total. Return chunk ids so the UI can show small **"Sources: Project X"** chips (a trust feature). No embedding model unless the eval proves BM25 + aliases insufficient — then consider a tiny quantized embedder, lazy-loaded.

### 8.3 Automatic language detection (no selector, ever)

Deterministic classifier: Devanagari-script ratio + Roman-Hinglish function-word lexicon (hai, kya, ka/ke/ki, ne, mein, kaun, kaise, batao, …) with smoothing across turns unless a strong new signal appears. Detect **per message**; reply in the language of the latest user message (English → English, Hindi → Hindi, Hinglish → Hinglish); mid-conversation switching must work. Ship ≥ 100 deterministic test cases for the classifier. The same result selects the TTS voice in voice mode.

### 8.4 Zero-hallucination policy (defined once, enforced in code)

The AI must never invent: internships, companies, jobs, projects, clients, technologies, languages, certifications, degrees, marks, awards, freelance work, hackathons, repos, links, dates, locations, statistics, user counts, revenue, performance claims, AI capabilities, or personal information — unless present in the verified context.

Enforcement layers:
1. **Retrieval gate** — low score → abstain without calling the model.
2. **Context-grounded training** — counterfactual contexts + abstention examples (§7.4).
3. **Placeholders** — verbatim values come from `knowledge.json`, not the model.
4. **Faithfulness Guard** — after generation, every URL / email / number / date / tech name / project name / company in the output must appear (normalized) in the retrieved context or a small allowlist; language must match; length cap. Violation → retry once (greedy, shorter context) → else extractive fallback.
5. **Text-only rendering** and allowlisted links.

Abstention strings (localized; store in i18n templates):
- EN: "I don't have that information in Aashish's portfolio yet."
- HI: "यह जानकारी अभी Aashish के पोर्टफोलियो में उपलब्ध नहीं है।"
- Hinglish: "Ye information abhi Aashish ke portfolio mein available nahi hai."

**Persona and style:** professional, friendly, natural, recruiter-friendly, concise by default. It is *"Aashish's AI Portfolio Assistant"* — it speaks about Aashish in the third person and never pretends to be him. No repeated "As an AI…". No opinions on salary/availability/personal matters unless in the knowledge base.

**Security / prompt injection:** user text never enters the system/instruction region; the model has **no tools**; UI actions (scroll to a section) come from a deterministic allowlist keyed by intent, never from free-form model output. Assume an attacker can read everything shipped to the browser — so nothing secret is shipped. "Reveal your prompt / files / keys" requests get a safe, honest reply. Injection attempts must never make the AI assert new facts.

---

## 9. Browser runtime, export, quantization, caching

### 9.1 Runtime decision (benchmark-driven, keep it behind an `LLMEngine` interface)

**Default: CPU/WASM-SIMD in a dedicated Worker.** Reasons: at ~40M params WASM is fast enough to be interactive; it leaves the GPU to Three.js; there is no first-run WebGPU shader-compile stall; and it works in every modern browser including Safari/iOS. Published guidance points the same way: WASM is broadly supported and suits smaller models, WebGPU pays off for larger ones. **WebGPU is opt-in (T3)** and only if an A/B test shows a net gain *with the Three.js scene running* and no frame regression. WebGPU now ships in Chrome/Edge, Firefox (Windows; macOS ARM) and Safari 26, but Android/Linux/older-GPU coverage is uneven — always feature-detect and fall back.

Candidates to benchmark (≤ ~1 day of work):
- **a)** `wllama` (llama.cpp → WASM, GGUF, runs in a worker, SIMD, auto single-thread fallback). Check v3 vs the `-compat` build (Memory64 / Safari support).
- **b)** ONNX Runtime Web / Transformers.js (WASM or WebGPU EP). Check the actual binary sizes.
- **c)** Minimal custom WASM/JS runtime — only if a/b miss budgets (feasible at this size but costly).

Matrix per candidate: runtime bytes + model bytes · cold init · prefill and decode tok/s · peak memory · works without COOP/COEP · Chrome / Firefox / Safari desktop, Android Chrome, iOS Safari · frame-health A/B. Record in `BENCHMARKS.md`, pick one, document why.

**Threads:** default 1 (max 2). Multi-threaded wasm needs `SharedArrayBuffer` → cross-origin isolation (COOP + COEP), which static hosts such as GitHub Pages can't set (a service-worker workaround exists) and which can break third-party embeds/fonts. **Do not add COOP/COEP just for AI** unless benchmarks show a large gain *and* full-site regression tests pass. If already isolated, cap at `min(2, hardwareConcurrency − 2)`.

### 9.2 Export and quantization

Pipeline: checkpoint → final fp16 → **Python CPU inference first** (§14) → parity check → export (GGUF and/or ONNX) → quantize → measure.
- Baseline **INT8**; try **INT4 group-wise for linear layers only** (embeddings/LM-head stay INT8). Accept only if portfolio-QA accuracy drops ≤ ~2 points and hallucination rate doesn't rise.
- Parity test: exported model vs Python fp32 on fixed prompts (logit tolerance + top-1 agreement).
- Measure real file sizes (raw and Brotli/gzip). Never quote a size you didn't measure.
- Documentation must clearly separate: (1) scratch training in fp/AMP, (2) post-training quantization for deployment, (3) true ternary training (§13).

### 9.3 Loader, cache, versioning

- `manifest.json`: `modelVersion`, `tokenizerVersion`, `knowledgeVersion`, files `[{name, size, sha256}]`; hashed filenames + immutable caching.
- Store shards in Cache Storage or OPFS (benchmark which is better); key by version; delete old versions on activation. `knowledge.json` is versioned **separately** (small, updateable without a model change).
- Don't register a new service worker just for this unless the site already has one.
- Model version label for UI/docs: e.g., "Aashish AI v1".
- Production ships only: manifest, model shards, tokenizer, knowledge.json, runtime js/wasm, lazy voice assets. Never ship datasets, checkpoints, optimizer states, Python env or the CV file.

---

## 10. Chat UX

- Entry: a semantic `<button>` ("Ask Aashish AI") in the existing nav/hero, styled with the site's own typography, spacing, colours and motion language. Click/tap only. (Optional, measure first: `pointerenter` may prefetch the **UI chunk only** — never model/runtime/wasm.)
- On click: open the panel immediately, show starter chips answered instantly by Quick Answers, and start preparing the model in the background: "Preparing Aashish AI…" → download progress → initializing → ready. Failure → clear message + Retry + "Use quick answers". Never a permanent spinner.
- Messages: user/AI bubbles, generation indicator, **Stop**, **Retry**, **Clear**, Enter to send, Shift+Enter newline, smooth autoscroll (pause autoscroll if the user scrolls up), suggested-follow-up chips, "Sources" chips, small badge "AI answer" vs "Quick answer".
- Trust line: "Runs on your device. What you type or say stays in your browser." (only if true for the shipped configuration — check.)
- **Streaming without jank:** append tokens to a single text node; flush at most every ~50–80 ms via one coalesced write; never re-render the message list per token; `aria-live` announces *completed* messages, not tokens; if a framework is used, keep streaming text outside its reactive state.
- **Bounded context:** last ~3–4 turns + structured state (focus entity, last intent, language) inside ≤ ~40% of the context budget. Older turns are dropped, not "summarized" by the tiny model (unreliable) — structured state carries the meaning.
- Responsive (desktop/laptop/tablet/phone), no viewport overflow; mobile = bottom sheet / full-screen with safe-area padding and a visible close button.
- Accessibility: keyboard navigation, visible focus, ARIA labels, focus moves into the panel and returns to the button, Esc closes, readable contrast, `prefers-reduced-motion`, mic status announced, transcript always visible.
- Design: must look native to this portfolio — not a generic ChatGPT clone; no neon, heavy gradients, clutter or huge modals.

---

## 11. Voice

Voice is **opt-in and lazy**: opening chat must not load STT/TTS/VAD. Only when the visitor chooses a voice mode do the needed assets download (with size shown, §6.5) and permission prompts appear.

### 11.1 Two modes

**Mode 1 — Tap & Speak (default, lightest).**
Tap (or hold) to start → mic opens **only while capturing** → auto-stop on silence (simple WebAudio energy threshold — no VAD model needed) or max ~20 s → STT → answer → optional read-aloud. Works on T1+.

**Mode 2 — Proactive (opt-in, hands-free; T2/T3 only).** "Proactive" means *continuous hands-free conversation* **plus an assistant that takes initiative within strict limits**:
- **Listening:** a small VAD segments speech; **STT runs only on detected speech segments** (never continuously). Hang-over ~600–800 ms for end-of-turn. Min segment ~300–400 ms.
- **Barge-in:** if the visitor speaks while the AI is speaking, cancel TTS and generation immediately and capture the new utterance. Use `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl`; require sustained energy (~300 ms) before accepting a barge-in to avoid self-interruption from speakers; suggest headphones on first use.
- **Initiative (all deterministic, no extra LLM cost):** (a) after the opt-in click, one short spoken greeting + 3 suggested topics; (b) after each answer, offer up to 2 follow-ups derived from the knowledge graph (chips, optionally spoken); (c) optional **guided tour** — walks About → Projects → Skills → Contact, scrolling via Lenis to allowlisted anchors (jump instead of smooth scroll under reduced-motion), pausing for questions; (d) at most one idle nudge after ~20–30 s of silence, then standby; (e) auto-standby after ~60–90 s of no interaction; mic auto-released after a longer idle.
- **Hard rules:** never speaks before a user gesture (autoplay policy); never speaks/listens while the tab is hidden (`visibilitychange`); always-visible mic indicator + **Stop listening**; Esc / tap stops; session length cap; auto-downgrade to Tap & Speak when the governor reaches degrade step 3–4 or the battery/thermal situation looks bad.
- **State machine:** `IDLE → ARMED → CAPTURING → TRANSCRIBING → THINKING → SPEAKING → (barge-in) CAPTURING | ARMED`, plus `ERROR` (permission denied / unsupported / model failed). Each state has a UI label and an `aria-live` status.

### 11.2 STT stack (tiered, benchmark-driven, no cloud)

| Tier | Option | Notes |
|---|---|---|
| S0 | **Browser on-device recognition** (`SpeechRecognition` with `processLocally = true`, gated by `SpeechRecognition.available({langs, processLocally:true})`, optional `install()`) | Zero model download in our bundle; experimental; language-pack based; reportedly not installable on Android in Chromium's implementation — verify. **Never** use the default (server-side) mode: the browser sends audio to a remote service. |
| S1 | Small on-device model in a worker: **Whisper tiny/base** (multilingual), **Moonshine** (~26 MB-class tiny models; English + a few languages; Hindi not listed at research time), or **sherpa-onnx WASM** ASR (+VAD in the same runtime) | Pick by *measured* WER/latency/size on a small EN / HI / Hinglish test set. |

Honesty rule: small Whisper models are weak in many non-English languages (Whisper's own per-language results show only some languages under ~20% WER even at large size; tiny/base are worse). If Hindi/Hinglish WER on our test set is poor (say > ~30–35%), then Hindi voice input uses S0 if available; otherwise the UI says voice works best in English and offers typing — **never pretend**. Create `evaluation/voice/` with a script and ask me to record ~30 short EN/HI/Hinglish clips for the decision. Also filter Whisper-style phantom transcripts on silence/noise (VAD gating + min length + known-phrase blocklist), show the transcript in the UI with tap-to-edit/resend.

### 11.3 VAD

Tap & Speak: energy-threshold only. Proactive: **Silero VAD** (~1 MB, MIT; reported < 1 ms per 30 ms frame on a single CPU thread) via `@ricky0123/vad-web` or inside sherpa-onnx — but watch the hidden cost: vad-web pulls ONNX Runtime Web, so reuse one runtime per §6.4. Capture with an **AudioWorklet** (16 kHz mono, ~30 ms frames); no DSP on the main thread.

### 11.4 TTS stack (tiered)

| Tier | Option | Notes |
|---|---|---|
| V0 | **OS voices** via `speechSynthesis` | Zero download, local, quality varies by OS. Feature-detect `hi-IN` / `en-IN` / `en-US` voices. Chunk by sentence (long utterances can be cut off in some browsers). Default on T1/T2. |
| V1 | **Kokoro-82M** (kokoro-js, **q8 only, WASM by default** — q8 is reported ≈ 86 MB while the original fp32 is ≈ 326 MB, and kokoro-js recommends fp32 for its WebGPU path, which would blow the size budget; so no fp32/fp16 and no WebGPU-fp32 here; sentence-level streaming supported; the model lists Hindi among its languages, but **verify browser-side Hindi phonemization** before promising it) or **Piper** via WASM (sherpa-onnx / piper-tts-web; per-language voices, smaller options) | Optional, T3 or explicit consent, size shown up front. Speak sentence-by-sentence while the LLM is still generating. One neural TTS resident; unload when idle. |

Hinglish (Roman-script Hindi) read by a Hindi voice or an English voice can sound wrong — run a small listening test (en-IN vs hi-IN vs light Roman→Devanagari normalization for TTS) and pick per result. One `AudioContext`; queue per-sentence audio; cancel on barge-in.

### 11.5 Voice visuals

CSS orb / subtle waveform using transforms + opacity, or a small 2D canvas at ≤ 30 fps drawn only during CAPTURING/SPEAKING; stops when hidden or under reduced-motion (static state icon). **No** Three.js/WebGL for AI.

### 11.6 Voice resource policy

T1: strictly sequential (never STT + neural TTS + LLM together), OS TTS. T2: LLM + STT resident, OS TTS by default. T3: all three allowed but unload what's idle. Measure per-component download size, RAM, STT latency and TTS latency — report only measured values.

---

## 12. Integration with GSAP, Lenis and Three.js

- **Ticker:** reuse the existing GSAP ticker for frame sampling; no new rAF loops; no per-token DOM churn.
- **Lenis:** `lenis.stop()` when the panel is open (start on close); mark the chat scroll container so wheel/touch scrolls the chat, not the page (Lenis supports a `data-lenis-prevent` attribute — verify for the installed version). Guided-tour scrolling uses `lenis.scrollTo`.
- **Three.js:** do **not** create another renderer. Add minimal hooks in the *existing* scene module — `setQuality('low'|'normal')` (pixel-ratio cap, post-processing off) and `pause()/resume()` — using whatever the project already uses (rAF, `gsap.ticker`, or R3F `frameloop="demand"` + `invalidate`). Use them only (a) while a full-viewport AI panel covers the scene (mobile, voice), or (b) when the governor detects frame drops during generation. Always restore afterwards.
- **CSS:** avoid `backdrop-filter` over the live WebGL canvas (forces costly per-frame compositing) — use an opaque/semi-opaque fill, or freeze the canvas while the panel is open. Use `contain: layout paint style` on the panel, animate `transform`/`opacity` only, `content-visibility:auto` for old messages, `will-change` only during transitions.
- **Cleanup:** on close, remove listeners, cancel timers, terminate idle workers, stop mic tracks, close audio.

---

## 13. Experimental: ternary (1.58-bit) model — separate from the baseline

Only **after** the baseline passes its gates. Directory `experiments/ternary/`, never touching the shipping path.
- Real ternary **training** (QAT with absmean weight scaling to {−1,0,+1}, straight-through estimator, 8-bit activations, its own LR/warmup), not post-training rounding. Same data and eval as the baseline.
- Expectation: at ~40M params the main benefit is **download size**; speed gains need dedicated ternary kernels (bitnet.cpp is CPU-native; browser/WebGPU ports exist but are early), which stock ORT-Web / wllama don't provide — so evaluate feasibility honestly.
- Compare against baseline INT8/INT4: file size, quality (all §14 metrics), CPU tok/s, browser feasibility. Go/no-go written down. Never call ordinary quantization "1.58-bit training".

---

## 14. Evaluation and tests

**Python CPU inference first** (`inference/`, `benchmark/benchmark_cpu.py`): measure model load time, RAM, prefill and decode tok/s, generation time, file size.

**Deterministic portfolio test suite** (`evaluation/portfolio_tests.json`):
`{ "question": "...", "expected_facts": ["..."], "forbidden": ["..."], "language": "en|hi|hinglish", "type": "direct|indirect|follow_up|unknown|switch|malicious|hallucination_bait" }`
Cover: direct, indirect, follow-ups (pronouns), unknown info, language switching, malicious/prompt-injection, hallucination bait ("Did he intern at Google?"), and **synthetic-portfolio tests** (swap all entities for fictional ones — answers must follow the fake context, proving the model reads context rather than memorizing).

**Metrics:** validation loss, perplexity where meaningful, portfolio QA accuracy, factual accuracy, unsupported-claim rate (pre- and post-guard), abstention precision/recall, language consistency, injection resistance.

**Proposed ship gates** (change only with written justification):
- held-out factual accuracy ≥ 95%
- abstention correctness ≥ 95%, false-abstention ≤ 10%
- unsupported-claim rate post-guard ≤ 1% (report pre-guard too)
- language consistency ≥ 95% EN, ≥ 90% HI/Hinglish
- 0 fabricated facts on the adversarial set

If the model misses a gate for some intents, route those intents to the deterministic engine and say so — never lower the bar silently.

**Automated tests:** unit (retrieval, language detection, guard, placeholder resolution, state machine), Playwright e2e — including a **network assertion that no AI asset (.wasm/.gguf/.onnx/model shard/voice model) is requested before the click**, the T0 unsupported path, offline-after-cache, download failure/retry, mic-denied path, worker-terminate frees memory, bundle-size budget check in CI.

---

## 15. Measurement protocol (baseline first)

1. **Baseline before any change:** JS bytes + request count on load, Lighthouse (LCP, TBT), and a scripted 30 s scroll capturing GSAP-ticker frame deltas (median, p95, dropped > 20 ms), main-thread busy %.
2. **Reference profiles:** (R1) my i5-6300U laptop; (R2) Chrome DevTools 4× and 6× CPU throttling (+ Slow 4G for downloads); (R3) mobile emulation; (R4) real Android / iPhone if available — otherwise mark **NOT TESTED** and add steps to `docs/MANUAL_TEST_CHECKLIST.md` (a ~10-minute routine I can run on my phone and another laptop).
3. **After:** repeat under four states — panel closed, chat idle, generating, voice active (Tap & Speak and Proactive) — plus a 10-minute Proactive soak test and 5 open/close cycles (no memory growth).
4. **Memory honesty:** `performance.memory` (Chromium-only, JS heap only) does not see wasm/GPU memory and `measureUserAgentSpecificMemory()` needs cross-origin isolation — so also capture Chrome Task Manager / Safari Web Inspector numbers manually and label the method.
5. Everything into `docs/BENCHMARKS.md` with device, browser, method, date. Also: AI bundle size, model download size, WebGPU vs WASM behaviour, mobile behaviour, voice model sizes, STT/TTS latency.

---

## 16. Phases and gates

| Phase | Work | Gate |
|---|---|---|
| **P0 Audit + baseline** | Repo audit, CV located + parsed, baseline metrics (§15) | `AUDIT.md` + baseline JSON exist |
| **P1 Knowledge** | `knowledge.json`, PII review, retrieval index, language detector, Quick Answers (EN/HI/Hinglish), deterministic tests | Tests pass; Quick Answers usable standalone; PII list approved |
| **P2 Chat shell + Governor** | Lazy launcher, chat UI, capability probe/tiers, frame monitor, download UI (stub), T0 path — **Quick Answers only, no model yet** | Budgets met with UI alone; network assertion passes; a11y checks; no jank vs baseline |
| **P3 Tokenizer + model code** | Tokenizer, model, `count_parameters.py`, local smoke train + resume test | Loss decreases; resume verified; param count printed |
| **P4 Stage A training** | Kaggle scripts + notebook; I run it | Val curve, samples, checkpoints, resume verified |
| **P5 Stage B + eval** | SFT data generator, tuning, eval suite, review sample | Ship gates measured and reported |
| **P6 CPU inference + export** | Python CPU benchmark, HF-layout export → GGUF/ONNX, quantization, parity test | Parity OK; sizes measured |
| **P7 Browser runtime** | Runtime matrix benchmark, worker engine, loader/cache/versioning, WebGPU A/B | Runs on Chrome + Firefox (+ Safari if available); budgets met; frame-health A/B with Three.js running |
| **P8 Voice** | Tap & Speak first, then Proactive; STT/TTS tiers; benchmarks | State-machine tests; mic-denied/unsupported paths; lazy-load assertion; per-tier memory measured |
| **P9 Perf hardening** | Tune governor, soak tests, dispose tests | ≤ 10% median-FPS regression on reference profiles; no leak over 5 open/close cycles |
| **P10 Ternary experiment** | §13 | Written go/no-go |
| **P11 Final QA + docs** | Everything in §17–18 | Definition of Done met or gaps listed honestly |

---

## 17. Structure, docs, dev/prod, security hygiene

Reuse the existing project structure; only add what is needed, roughly:

```
ai/            model/ tokenizer/ inference/ retrieval/ knowledge/ governor/ engine/ (LLMEngine)
voice/         stt/ tts/ vad/ pipeline/
components/    AIChat/ AIVoice/            (adapt to the project's conventions)
training/      scripts/ notebooks/ datasets/ checkpoints/(git-ignored) RUN_MANIFEST.json
data/          raw/ processed/ portfolio/ general/ instruction/ evaluation/
evaluation/    portfolio_tests.json  voice/  review_sample.md
inference/     benchmark/benchmark_cpu.py   count_parameters.py
experiments/   ternary/
docs/          AUDIT.md PROGRESS.md AI_ARCHITECTURE.md TRAINING.md DEPLOYMENT.md BENCHMARKS.md DATA_LICENSES.md PRIVACY.md MANUAL_TEST_CHECKLIST.md
```

- Docs must explain: model, tokenizer, training, retrieval, browser runtime, quantization, voice, performance, limitations, fallbacks, and which parts use pretrained open models (STT/TTS/VAD).
- **Dev vs prod:** verbose logs, benchmarks and debug overlays are dev-only (build-flag stripped); production has minimal logs, graceful user-facing errors, compact assets.
- **Secrets:** none in the repo or bundle; no LLM API credentials, ever.
- **Analytics:** if the portfolio already has analytics, make sure chat/voice content is never sent; at most anonymous counters, and disclose them.
- **Data hygiene:** training data, checkpoints, optimizer states and the CV file never ship to the browser or the repo.

---

## 18. Definition of Done and final report

**Do not write "implemented" — verify.** Actually run: build, unit + e2e tests, CPU inference, evaluation suite, CPU benchmark, browser benchmarks, chat + language tests, factual tests, performance tests. If something can't be finished: say what works, what doesn't, why, what alternative was used, and what remains.

Checklist
- **Portfolio:** works; visually intact; GSAP, Lenis, Three.js OK; animations smooth; no AI-caused jank; Three.js not duplicated; no new WebGL scene; no permanent extra rAF loops.
- **AI:** scratch tokenizer + model from random init; Stage A + Stage B done; retrieval; guard; EN / Hindi / Hinglish work; automatic language detection; **no language selector**.
- **No backend:** no server, no LLM API, no API key; inference local.
- **Browser:** lazy-loaded; nothing AI on initial load; download + file sizes measured; memory considered; main thread protected; workers used; WebGPU + WASM investigated; unsupported/mobile paths handled; caching + versioning work.
- **Chat:** streaming, Stop, Retry, Clear, bounded context, accessible, responsive.
- **Voice:** Tap & Speak and Proactive exist; STT/TTS local where supported; lazy-loaded; mic-permission paths handled; no language selector; proactive limits enforced.
- **Training:** resumable; checkpoints; evaluation; portfolio test suite; no fake results.
- **Experimental:** ternary separated from the baseline.

**Final report** (only MEASURED / ESTIMATED / NOT TESTED values):
MODEL (architecture, params, vocab, context, stages) · TRAINING (data, GPU, config, checkpoint + resume strategy) · KNOWLEDGE (structure, retrieval, hallucination strategy) · BROWSER (runtime, format, quantization, download size, memory, caching, WebGPU/WASM, fallbacks) · PERFORMANCE (initial-load impact, CPU + browser inference, mobile, GSAP/Lenis/Three.js interaction) · CHAT (architecture, language detection, context) · VOICE (STT, TTS, VAD, latency, resource use per tier) · TERNARY (status, approach, comparison) · KNOWN LIMITATIONS · WHAT I NEED FROM YOU.

The claim we want to be able to make truthfully:
> "A custom conversational AI trained from scratch for my portfolio, answering questions about my work, skills and background, running locally in the visitor's browser — no LLM API, no backend."
(STT/TTS/VAD, if used, are disclosed as open pretrained components.)

**The most important constraint:** never sacrifice the existing portfolio's performance for the AI. It is a lightweight layer on top of the portfolio, not another heavy app competing with it.

**START NOW:** Phase 0 — inspect the repo, GSAP/Lenis/Three.js usage, deployment setup and the CV at the path above. No major changes until `docs/AUDIT.md` and the baseline metrics exist.

---

## 19. Research notes (Sep 2026 — re-verify before relying on them)

- **WebGPU** ships in Chrome/Edge, Firefox (Windows; macOS ARM) and Safari 26 (macOS/iOS), but Android/Linux/older-GPU coverage varies → feature-detect + fallback. https://web.dev/blog/webgpu-supported-major-browsers
- **WASM vs WebGPU:** WASM (SIMD, optional threads) is the universal fallback and suits smaller ML workloads; WebGPU wins for larger models but can add seconds of first-run shader compilation (one article's estimate). https://web.dev/learn/ai/client-side · https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/
- **Tiny models need narrow data:** ~125M-parameter general models rarely stay coherent; sub-10M models on a curated narrow distribution can. https://arxiv.org/abs/2305.07759
- **wllama:** llama.cpp in WASM (GGUF, SIMD, worker, auto single/multi-thread; multi-thread needs COOP/COEP; v3 adds WebGPU; check Memory64/Safari compat). https://github.com/ngxson/wllama
- **Cross-origin isolation** for threaded wasm: COOP + COEP; GitHub Pages can't set headers (service-worker workaround: https://github.com/gzuidhof/coi-serviceworker); also https://github.com/WICG/document-isolation-policy
- **Web Speech on-device mode:** default recognition is usually server-side; `processLocally` + `available()/install()` gives on-device with a language pack (experimental). https://developer.mozilla.org/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API
- **Moonshine:** tiny on-device STT (~26 MB-class), English + a few other languages; also notes Whisper's weak coverage of many languages at small sizes. https://github.com/moonshine-ai/moonshine
- **Silero VAD:** ~1 MB, MIT, < 1 ms per 30 ms chunk on one CPU thread. https://github.com/snakers4/silero-vad · browser wrapper https://github.com/ricky0123/vad
- **Kokoro-82M / kokoro-js:** browser TTS via WASM/WebGPU, q8 ≈ 86 MB reported, streaming API; Hindi supported by the model — verify in-browser phonemization. https://www.npmjs.com/package/kokoro-js
- **sherpa-onnx:** one WASM toolkit for VAD + ASR + TTS (Piper models supported). https://github.com/k2-fsa/sherpa-onnx · Piper web: https://github.com/Mintplex-Labs/piper-tts-web
- **iOS memory:** WebKit bug reports ~300 MB reliably available to wasm on some iPhones (2024) and tab kills on overflow — re-measure. https://bugs.webkit.org/show_bug.cgi?id=269777
- **Frame-health APIs:** Long Tasks / Long Animation Frames are Chromium-only → use ticker-delta sampling as the cross-browser signal. https://developer.chrome.com/docs/web-platform/long-animation-frames
- **Ternary:** bitnet.cpp speedups come from dedicated CPU kernels; a WebGPU/WGSL browser port exists for the 2B model. https://github.com/microsoft/BitNet · https://github.com/qwatts-dev/bitnet.js
- **Data:** Sangraha (AI4Bharat, 22 Indic languages) https://github.com/AI4Bharat/IndicLLMSuite · L3Cube-HingCorpus (Roman Hinglish, Twitter-derived) https://arxiv.org/abs/2204.08398
