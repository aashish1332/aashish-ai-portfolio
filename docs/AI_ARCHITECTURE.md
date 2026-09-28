# AI ARCHITECTURE — Aashish AI Portfolio Assistant

One document for how the assistant is put together, what is verified, and
what is not. It is written per phase and updated as phases land; anything
not yet built says so instead of describing the plan as if it existed.

Status: **P1 · P2 · P3 complete (all three gates verified on CPU at smoke
scale — see [TRAINING.md](TRAINING.md)) · §10 voice, §11 voice input, §12
section-following landed · P6 export + P7 browser runtime built and gated ·
P8 voice built, Proactive VAD-gated.** A model genuinely trained on this
laptop runs in the browser today (config `local`, ~5M params); P4's Stage A
and P5's Stage B at config A still need a GPU. P10's ternary experiment has a
**written no-go** (`experiments/ternary/README.md`) and P11's final report exists
(`docs/FINAL_REPORT.md`); P9's hardening is done as far as this box can measure
it — 2 % frame cost, 65 ms worst long task, 0 leaks over 5 reopens — with the
hardware-side gaps listed in the report rather than claimed. Voice input is browser-verified with a stub engine and
unit-tested against doubles, but it has **never** been run with a live
microphone — see §5.

---

## 1. The shape of the thing

```
visitor types ──▶ language detector (§8.3)  ──▶ intent router  ──▶ retrieval (BM25 + aliases)
                        │                            │                    │
                        ▼                            ▼                    ▼
                  reply language            intent + safety       top ≤3 chunks, ≤300 tokens
                  (EN/HI/Hinglish)          verdicts only                 │
                        └────────────────────────────┬───────────────────┘
                                                     ▼
                                       the on-device model proposes text
                                                     │
                                       guard (§8.4 layer 4) → refused? say so
                                                     ▼
                                       Faithfulness Guard (§8.4 layer 4)
```

There is **no backend, no API key, and no LLM service**. Everything in
P1–P3 runs in the browser or on the training machine. That is checked against
the built bundle rather than trusted to this sentence: the shipped `ai/**` code
contains no absolute URL and exactly **one** outbound call site — `fetch(KB_URL)`,
the site's own knowledge file — with no XHR, WebSocket, EventSource or sendBeacon
anywhere, and no secret-shaped string in any shipped file
(`tests/build-bundle.test.mjs`, §2 N2/N3 + §17).

| Layer | Files | Ships to browser |
|---|---|---|
| Knowledge base | `knowledge/knowledge.json`, `ai/knowledge/view.mjs` | yes (public view) |
| Retrieval | `ai/retrieval/index.mjs` | yes |
| Language detection | `ai/language/detect.mjs`, `ai/language/lexicons.json` | yes |
| Intent routing | `ai/intent/rules.mjs` | yes |
| Answers | `ai/answers/model.mjs` (the only answer path) | yes |
| Routing, the §8.4 gate and the follow-up graph | `ai/answers/quick.mjs` — a **planner**: it decides, it does not word | yes |
| The retired deterministic answers | `evaluation/answer-text.mjs` — the §5.1 step-4 wording the evaluation set reads | **never** (not in `SHIP_PATHS`) |
| Placeholder grammar | `ai/knowledge/placeholders.mjs` | yes |
| Chat shell + governor | `ai/ui/*.mjs`, `ai/governor/index.mjs`, `js/ai/launcher.js` | lazily, on click |
| Tokenizer | `ai/tokenizer/*` | not yet (P7) |
| Model | `ai/model/*`, `inference/count_parameters.py` | not yet (P6/P7) |
| Training | `training/*` | never (§17 data hygiene) |

---

## 2. Tokenizer (§7.2) — built, verified

**Our own byte-level BPE.** Trained from scratch on the corpus in
`data/raw/seed` (`python -m ai.tokenizer.train`), never a pretrained vocab,
nothing downloaded.

| Property | Choice | Why |
|---|---|---|
| Type | byte-level BPE (`tokenizers` trainer) | byte fallback is automatic: every byte of every script is representable, so **no `<unk>` token exists** |
| Normalisation | NFC before tokenisation | `café` written two ways must be one sequence, or Hindi/English fertility doubles for nothing |
| Special tokens | `<\|sys\|> <\|ctx\|> <\|user\|> <\|asst\|> <\|end\|> <\|abstain\|>` | exactly the six §7.2 names — no extras, because extras are a GGUF/ONNX compatibility hazard |
| Placeholders | one atomic token per fact id (`<\|fact:contact.email\|>`, 63 of them) | the model emits a placeholder; the app substitutes the verified value (§8.4 layer 3) |
| Version | `portfolio-bpe-<size>-<hash>` | the hash covers the special tokens + placeholder set + grammar |

### The placeholder contract, in two runtimes

The browser resolves placeholders (`ai/knowledge/placeholders.mjs`) and the
tokenizer reserves them as single tokens (`ai/tokenizer/spec.py`). If those
two disagreed, the model would emit a string the UI cannot fill in — and
the failure would look like "the AI says weird things", not like a bug. So
both are pinned to one hand-written fixture,
`tests/fixtures/placeholder_cases.json`: 16 cases including whitespace
inside the delimiters, an unterminated placeholder, and a broken delimiter
followed by a valid one. `tests/placeholders.test.mjs` and
`tests/py/test_tokenizer_spec.py` each assert their own runtime against it,
so the fixture can only change by changing both.

### Vocab size decision — measured, not assumed

§7.2 asks for 12–16k and asks for fertility numbers to justify it. The
local seed fixture (3.2 MB, 17.4k lines) supports a **1024**-token vocab
before the trainer runs out of merge candidates. That ceiling is set by the
corpus's *distinct word forms*, not its size — measured directly:

| Corpus | Distinct word forms | Maximum learnable vocab |
|---|---|---|
| 44 lines (×4) | 348 | 802 |
| 80 lines (×4) | ~180 | 802 |
| 80 lines (×16) | ~180 | 802 |

Repetition does not raise it. That is why `ai/tokenizer/train.py` **fails**
when it cannot deliver the requested vocab instead of emitting a smaller
one: the embedding layer is sized from the config, so a mystery 866-token
vocab would silently mis-size every downstream number. The real 12–16k
decision is P4's, on the licensed corpus, re-running the same report.

Fertility at 1024 (dev fixture — pessimistic for Hindi by construction):

| Category | tok/word | chars/tok | verdict |
|---|---|---|---|
| en | 2.46 | 2.52 | — |
| hi | 4.71 | 1.18 | over budget |
| hinglish | 2.69 | 2.24 | over budget |
| tech | 4.35 | 1.69 | over budget |
| url_email | 15.50 | 1.39 | over budget |

The Hindi number is the one that matters and it is the one this fixture
cannot settle: Devanagari needs real corpus volume to merge at all.

---

## 3. Model (§7.1) — built, count verified two ways

Decoder-only, pre-norm **RMSNorm**, **RoPE**, **SwiGLU**, **GQA**, **tied
embeddings**, causal attention, written from scratch in PyTorch
(`ai/model/model.py`). Tensor names are the HF `LlamaForCausalLM` names, so
P6's GGUF/ONNX export needs no custom runtime.

| Config | vocab | d | layers | heads / KV | head_dim | ffn | ctx | params |
|---|---|---|---|---|---|---|---|---|
| **A** (§7.1 starting) | 16,384 | 512 | 10 | 8 / 4 | 64 | 1,408 | 1024 | **37,890,560** |
| **lite** (contingency) | 12,288 | 384 | 8 | 6 / 3 | 64 | 1,024 | 768 | **17,701,248** |
| **smoke** (§7.5, local) | 1,024 | 192 | 4 | 6 / 3 | 32 | 512 | 256 | **1,820,352** |

Config A is 37.89M — §7.1's own hand estimate (~37.9M) does not itemise the
two RMSNorms per layer (10 × 2 × 512) plus the final norm, which is the
0.01M difference. `tests/py/test_model_schema.py` pins the exact integer, so
a config edit cannot quietly slide the model inside the band.

KV cache: **10.00 KB/token** fp16 at config A (10 layers × 4 KV heads × 64
head_dim × K and V × 2 bytes) → 10.0 MB at 1024 tokens, exactly the §7.1
claim. Compute estimate at ctx 1024: prefill 39.8 GFLOP, decode 0.08
GFLOP/token (analytic, no kernel overhead — a budget figure, not a
benchmark).

### Two derivations, one number

`inference/count_parameters.py` prints the count twice: analytically from
the config (`ai/model/plan.py`, which runs anywhere) and, when torch is
installed, from the materialised module's `state_dict` — checked
name-by-name and shape-by-shape against the same schema. A mismatch exits
non-zero. On this machine torch is absent, so the tool prints
`torch: NOT INSTALLED → the materialised check did not run` and the docs
record that P3's "param count printed" is *analytic only* here.

---

## 4. Retrieval, language, answers (§8) — P1, plus the §10 voice

BM25 + alias/transliteration map + char-n-gram fuzzy matching + a focus
entity, top-k ≤ 3 chunks. Deterministic language detection from script
ratio + a function-word lexicon (no ML, no selector), with turn smoothing.

**The context budget is priced against what the model reads, and the window is
enforced by the real tokenizer.** `estimateTokens` used a generic
4-chars-per-token rule of thumb, which is wrong for a 1,024-token vocabulary by
~2.5×: a "300-token" context was really ~750, and 14 of the 60 evaluation
questions built a prompt past `max_position_embeddings` — where `forward()`
throws, so the visitor was told the model had stopped. `CHARS_PER_TOKEN` is the
measured **1.5**, `search()` prices nothing unless the caller declares a cost
model (`contextSizer` — the budget is about the rendered fact, not the index
chunk), and `fitToBudget` in `ai/engine/prompt.mjs` drops the weakest evidence
from the tail with the real tokenizer rather than hoping an estimate was
conservative. `generate()` reports the context it actually read, and the guard
and the sources follow that. Numbers: `docs/BENCHMARKS.md`.

**There is one answer path: the on-device model.** The deterministic Quick
Answers were retired as *answers* — a template in the same bubble as a
generated sentence teaches a reader nothing about which one they are reading.
The intent router and the retrieval gate survive because decisions have to be
made before a token exists: which topic this is, whether it is bait that must
abstain (§14), whether it is an instruction-change attempt (§9), and whether
retrieval produced anything to read at all. Where the model cannot answer, the
panel refuses and says which refusal it is; it never substitutes a sentence.
See `ai/answers/model.mjs` and `docs/PROGRESS.md`.

**Voice (§10).** The answers are written as Aashish talking about himself —
"my CGPA", not "his CGPA" on a page he wrote. `persona: 'first'` is the
default; `'third'` is one option away. Both phrasings live side by side at
each template in all three languages (`pick(persona, third, first)`) rather
than as a rewrite pass over the finished text, so an untranslated string shows
up in the diff instead of quietly producing wrong grammar. The refusal
(`ABSTAIN_FIRST`) follows the voice, because an abstention asserts nothing.
The identity question and the injection reply do **not**: answering "yes, I'm
Aashish" would be a lie about a person, so those two disclose what is
speaking.

Two details worth knowing because they are load-bearing:

* **`public` is a gate, not a filter.** `ai/knowledge/view.mjs` removes
  `public:false` facts from the structure the engines read, so a withheld
  value cannot be retrieved, chunked, or resolved — `contact.phone` has a
  placeholder token that resolves to nothing.
* **The Python data side mirrors that gate** (`ai/data/facts.py`): a
  private value must never reach the corpus, because a model that learns a
  value cannot be made to un-learn it by a runtime filter.

**The layer-1 gate is calibrated, and its bounds are known.** `MIN_TOP_SCORE`
was an unmeasured heuristic until `npm run calibrate` swept it over the
evaluation set and over every alias the knowledge base declares about itself.
The sweep's ceiling is hard and is recomputed by a test from the data: **4.647**,
the weakest alias a fact declares about itself, above which a real fact stops
being reachable by its own name. The floor is **not measured** — nothing in the
corpus is kept out by the gate, because every must-not-answer question is
declined by an intent rule or by the withheld-facts list first. The value ships
at 1.0, inside the measured band, rather than at a midpoint the evidence cannot
support; the missing half is P5's to supply, where crossing the gate costs an
inference. Two real defects fell out of the sweep: numbers were invisible to
retrieval (it inherited the language detector's tokenizer, which drops digits on
purpose), and a declared alias made only of function words ("who is he") was
deleted by the stop set on both sides of the comparison.

---

## 5. Voice and page navigation (§10/§12)

Two behaviours, both about the assistant pointing at things rather than
claiming them.

**The page follows the answer.** When an answer comes from a real part of the
page, that part is where the page goes. The target is *resolved from the
answer's facts against the live DOM every time*, in `ai/ui/anchors.mjs`:

1. `data-ai-topics` on a section — a declaration, and it travels with the
   markup, so reordering the page cannot invalidate it;
2. the fact's own words (project name, codename, aliases) found in an
   element's text — the section carries its content with it, so this survives
   renames, moves and reordering;
3. specificity — of the elements that match, the deepest wins, `main` and
   `body` never qualify, and inline fragments with no id pay a penalty,
   because "contains the word" is not "is the place".

Scoring counts **facts covered**, not words matched: a card naming one project
in full must not outrank the section holding two of the three projects the
question was about. A miss returns `null` and the page does not move —
scrolling somebody to a confidently wrong section is worse than not moving.

**It never says so.** No "moving to the projects section", no "I couldn't
find that". The move is silent, and it happens **only in hands-free mode**
(`setHandsFree(true)`): auto-scrolling the page out from under someone who is
mid-sentence is hostile, and it is the voice layer that needs the page to
follow. The typed chat stays plain.

Measured, not asserted: `dev-anchor-probe.js` records where seven questions
resolve, then renames a whole scene, moves it, strips its declarations and
moves a project into a scene of its own — and asks again. **34/34**, including
`scrollY 0 → 5059` from hands-free mode alone, and the stronger question that
prompted all of this: after the move settles, is the **live element** the
answer pointed at inside the viewport? **7/7 as shipped** (each resolves to a
section exactly one viewport tall at `top=0`); 6/7 on the edited fixture,
where the one miss is a section the film built no layout for and is reported as
that rather than counted as shown. Resolution costs 14.6–29 ms (a bounded walk
of ≤800 elements, no layout read) against §4's 50 ms budget.

### Heard, and heard out loud (§11)

`ai/voice/index.mjs` is the whole thing: **adapter-first**, so the engine can
be replaced without the panel noticing. It is split from `ai/voice/caps.mjs`
so the panel can describe voice — which tier grants what, and whether this
browser has a recognizer — **without fetching the recognizer, the VAD or the
speaker**. Those arrive on the tap that chooses a voice mode (§2 N6); the button
says `VOICE…` while they load, because a tap that produces nothing reads as a
dead button (§2 N7).

**Nothing is listened to until the visitor asks.** The recognition object is
not constructed until the button is pressed, and the first thing that happens
afterwards is the disclosure — *"Voice mode uses your browser's speech
recognition, which sends what you say to your browser's speech service, so
while it listens, your audio leaves this device. Typed questions never do."*
The panel's older promise ("what you type stays in your browser") is still
true, and it is deliberately not stretched to cover speech.

**The one visual is CSS, and there is no frame loop** (§11.5). The voice button
carries a 7px dot whose state is one `data-voice` attribute — `off`, `armed`,
`listening`, `speaking`, `suspended` — decided by the pure function
`voiceVisualState(info)` and drawn entirely by `ai/ui/styles.mjs`. No canvas, no
WebGL, no `requestAnimationFrame`, nothing that runs per frame: the animation is
`transform` + `opacity` only, and it sits behind
`@media (prefers-reduced-motion: no-preference)`, so a visitor who asked for less
motion gets a still dot that is still brighter when the microphone is live. The
order in that function is the part that can be wrong — a session can be
listening *and* speaking *and* hidden at once, and being hidden outranks them
both — so it is pinned by test (`tests/voice.test.mjs` VOICE-13). The button's
`aria-label` says the same state in words, which is §11.1's "each state has a UI
label and an aria-live status": the label is real, and the announcements
(refusals, the disclosure) go through the transcript, which is `aria-live`.

**That sentence is now a question, not an assumption** (added 2026-09-27,
after re-verifying §19 — see [RESEARCH_VERIFICATION.md](RESEARCH_VERIFICATION.md)
row 6). Before the microphone opens, the recognizer asks the platform
`SpeechRecognition.available({ processLocally: true, langs })`, and sets
`processLocally` **only on `'available'`** — a pack that still has to be
downloaded would fail the session, and a dead microphone is a worse outcome
than a disclosed one. `install()` is deliberately not used: it starts a
download, which is not something to do on a click. The panel then says the
sentence that matches: the cautious one while the question is open, the
on-device one once the platform has answered yes (`SPEECH_DISCLOSURE_ON_DEVICE`).
If the engine refuses anyway — the shape of a known Chrome regression — the
server-side engine is the fallback, **once**, reported, with the cautious
sentence coming back. **NOT TESTED against a real microphone.**

**The order, stated exactly** (the first draft of this doc said "before
anything is listened to", which the code did not quite do). `enable()` calls
the engine's `start()` and the disclosure bubble is appended in the **same
task**, so no transcript can be *handled* before the disclosure is in the DOM:
results arrive as events, and events queue behind the task that started the
engine. The bubble is also only shown when the engine actually started — a
refused microphone gets the reason instead, because telling somebody their
audio leaves the device when nothing opened would be a false claim about
their machine.

**§6.2's `voice` column is now read rather than declared.** It has been in the
tier table since P2 with nothing consuming it:

| Tier | `voice` | What that means |
|---|---|---|
| T0 | `none` | typed only. Also where a `saveData` visitor lands, and recognition is a network service — so "off" is the answer they asked for |
| T1 | `tap` | press-to-talk, in a window that closes by itself (20 s); nothing played aloud at somebody on a phone |
| T2 | `both` | the same window **and** answers read aloud |
| T3 | `all` | both, plus continuous listening behind a wake phrase — and a turn that has to be *kept* open (below) |

A test recomputes the policy table **from** `TIERS` in both directions (every
declared level is implemented; no implemented level is unreachable), and an
unrecognised level fails **closed** — an unknown capability is not permission.

**It is addressed, not eavesdropping.** Continuous mode requires a wake phrase
(`aashish`, `ask aashish`, `hey aashish`, `ok aashish`); anything else is
dropped in silence. The rest of the sentence is returned as the visitor's own
words — punctuation included — because the wake splitter must not tidy up the
question it is about to be judged on.

**A press is a whole question, and it ends by itself.** "Tap" would otherwise
be a latch: one press on VOICE left the recognizer restarting for as long as
the panel stayed open, and in push mode every utterance is a question — a
**hotter** microphone than continuous mode, which at least asks you to say the
name. So a press opens a `VOICE_TIMING.tapWindowMs` (**20 s**) window: the
press *is* the address, so nothing else is needed to ask; when the window
lapses the engine stops, the button goes dark and Proactive mode is given
back. The window is deliberately **not** extended by answering — extending it
is exactly how a press turns back into an open microphone — and the expiry
callback checks it still owns the window, so a surviving timer cannot close a
session it has nothing to do with.

**And a turn has to be kept open.** Being woken is not the same as being on
forever: one "hey Aashish" must not leave the assistant answering for the rest
of the call, including the half of the conversation that is with somebody else
in the room. So a question that lands on the portfolio buys the next one for
`VOICE_TIMING.followUpMs` (**12 s**, and short on purpose — that is the pause
between two questions to the same person, not the pause before a different
conversation), silence past the window closes the turn and the wake phrase is
required again, and an answer that claimed nothing (**an abstention**, or a
bait request) ends the turn immediately, because those words were not about
the portfolio. Expiry is evaluated on read rather than by a timer: a timer is
one more thing to leak, and the only moment the answer matters is the next
utterance. The decision lives in `onAnswer`, not after `ask()` returns —
`ask()` calls back synchronously, so extending the window there would undo
the close an abstention had just performed (VOC-4 in PROGRESS).

The answer is then spoken as itself (`res.text` only — badges and source chips
are furniture, not speech), in a voice chosen by the answer's own language,
and a partial transcript during playback stops it: **talking over the answer
takes the turn back.** Which section of the page that answer came from is
resolved by §12 as usual, because the recognized question goes through exactly
the same `ask()` a typed one does.

**A failure is undone, not just logged.** A refused permission
(`not-allowed`, `audio-capture`, `service-not-allowed`) stops the recognizer
rather than riding the restart loop that continuous listening needs, and the
session turns *itself* off: Proactive mode goes back to what it was, the button
goes dark, and the panel says why once. It also has to be *undone*, not merely
logged — a dead engine that leaves the session nominally on is a button lit
over a microphone that cannot work, which is what the browser probe caught. Measured in a browser with no
microphone — the button goes dark and the reason is stated, which is the
failure a visitor with a blocked permission actually gets.

### The frame ladder is armed around work, not around the panel (§6.3)

`ai/governor/index.mjs` exposes `setActive(on)`, and `ai/ui/chat.mjs` arms the
ladder only while an answer is being produced — not while the panel is open,
and **not while a microphone is listening**. The second half of that was learned
the hard way: the §11 work first armed it for a listen too, and a 600 s soak
that reported `active=true, step=0` looked like a pass when it was a pass for
the wrong reason. Every rung acts on the model or the scene, so a listen has
nothing to protect — and where the ladder fires, rung 3 recompiles every shader
(21 programs, 1,221 ms) to protect a generation that is not running. This is a **measured** rule, not
a preference: every rung exists to make room for the assistant's own work, and
left running while the visitor merely reads, the ladder reached rung 3 on a
device the film already struggles on — where rung 3 switches the render path
and makes three.js recompile every material's program. **21 programs, 1,221 ms
of blocked main thread, with nothing running** (§15.3 in `BENCHMARKS.md`).
Going idle clears the monitor and hands the scene back. The disarm is
promise-aware, because P5 turns answering asynchronous.

### Hallucination control, before there is a model (§8.4 / §7.4)

Two of §8.4's five enforcement layers are not training and not data — they
are code that operates on strings, which means they can be written, tested
and pinned while there is still no checkpoint. Writing them last is how a
"guard" becomes a rubber stamp applied to whatever the model produced.

**`ai/guard/index.mjs` — layer 4, the runtime check.** It reads one generated
answer against the retrieved context and returns every claim it cannot ground:
URLs, emails, numbers, dates, named entities from the knowledge base's own
vocabulary, language mismatch, length. It never generates, rewrites or fuzzy-
matches; grounding is normalization plus containment, so a failure is always
an ungrounded claim rather than a near-miss accepted.

The design decisions that matter, each with a test:

| Decision | Why |
|---|---|
| the vocabulary is **whole names**, never their words | "REST APIs" is a technology; "rest" is an English word, and "Smart Grocery List Generator" must not put *list* into the vocabulary. A guard that fires on ordinary prose rejects every correct answer |
| his own name is **allowlisted** | the assistant naming its subject is not a claim about the world |
| a badge is not a claim | placeholders that never resolved are a violation by definition, and the four-digit year check is separate from the number check |
| §5.1 step 5 is the module's own function | `guardedAnswer()` runs generate → guard → **one greedy retry over a shorter context** → and then reports the failure. The extractive fallback is gone (it was a template standing in for the model); the caller turns `guardFailed` into a refusal. Generation is injected, so the whole ladder is tested with doubles and no inference |

**`ai/data/instruction.py` — §7.4, the data half.** 40,000 examples from
`knowledge.json` in the §7.4 format (`<|sys|> <|ctx|> <|user|> <|asst|> <|end|>`),
the exact §7.4 mix, and the technique that makes a small model read rather
than recall: **counterfactual contexts**. For ≥30% of examples the entity
names and some values *inside the context* are replaced with fictional ones,
and the answer must follow the passage. A counterfactual example built on a
topic with no fabricated value in it is not counterfactual at all — it is a
factual example counted in the 35% — so the topic is chosen from the ones that
carry a swapped value, and a test asserts the context really differs from the
real one.

Two honest limits, stated rather than hidden: a fictional value has no
placeholder token, so a counterfactual answer necessarily contains that
fabricated string as text (which is the point — the model learns to copy — and
it is why the share is capped); and the character-based token count is
**ESTIMATED**, because a real count needs the P4 tokenizer.

The generator writes `data/instruction/sft.jsonl` (build output, ~31 MB at
40k examples, git-ignored), its exact `manifest.json`, and
`evaluation/review_sample.md` — ~100 Hindi/Hinglish examples, because a
generator can produce 25,000 fluent-looking rows and still produce unnatural
Hindi, and only a speaker can tell you that.

---

## 6. Browser runtime, export, quantisation (§9) — P6/P7, built

The runtime exists and is gated by parity tests. The pipeline, in the order a
visitor's click walks through it:

```
click → ai/ui/chat.mjs (chunk)  → knowledge.json, retrieval, guard, intent/routing
             │  startModel()                     §6.5: the size is shown first
             ▼
   ai/engine/session.mjs ── postMessage ──► ai/engine/worker.mjs   (module Worker)
             │                                  ai/engine/index.mjs   ScratchLlamaEngine
             │                                  ai/engine/manifest.mjs  shards + sha256
             │                                  ai/engine/llama.mjs     the graph
             │                                  ai/engine/quant.mjs     int8 kernels
             ▼                                  ai/engine/bpe.mjs       our tokenizer
   ai/answers/model.mjs   retrieval context → guardedAnswer → placeholders
```

| Piece | Decision | Why |
|---|---|---|
| Runtime | **our own JavaScript**, in a module worker | §9.1 asks for the smallest runtime that meets the needs; at ~5M params a wasm runtime would be a second binary to download and a second thing to trust. The `LLMEngine` seam (`ai/engine/index.mjs`) is where wllama/ORT-Web would go if a benchmark ever favours them |
| Weights | **per-row int8** (`q8-row`), norms float32 | 4× smaller than fp32 and no activation quantization: an activation scale chosen per token is invisible when wrong (see `quant.mjs`) |
| RAM | int8 codes **stay** int8; the matvec multiplies them by float32 activations | expanding to fp32 at load would cost 152 MB on config A for nothing (§4) |
| Sharding | ≤ 8 MB per shard, SHA-256 each, immutable names | §6.5 |
| Tokenizer | our artifact, ported to JS, **no wasm** | 66 KB of JSON; the port is checked id-for-id against the Python encoder on 21 fixture cases / 394 ids (`tests/tokenizer-parity.test.mjs`) |
| Prompt | generated from `ai/data/instruction.py` into `ai/engine/prompt_contract.json` | two copies of a prompt format is how a model "breaks" after a deploy that changed nothing |
| Streaming | one writer, flushed every 64 ms (§10) | re-rendering per token is the jank §10 forbids |
| Guard failure | the bubble's text is **replaced**, not silently retracted | a visitor sees the final text and a badge that says where it came from |

### The three-way parity gate (§9.2)

One implementation checked against itself proves nothing, so the same §7.1
graph exists three times and each edge is measured:

| Edge | Command | Result |
|---|---|---|
| PyTorch ↔ numpy | run during `npm run export:model` | **PASS** — max abs Δ **8.58e-06** on the checkpoint, 2.09e-07 on the fixture |
| numpy ↔ JavaScript, committed fixture | `npm test` (`tests/engine.test.mjs`) | **138 positions**, argmax **100%**, worst abs Δ logit **3.58e-07** against a 0.02 tolerance |
| numpy ↔ JavaScript, **the shipping export** | `npm run verify:engine` | **138 positions**, argmax **100%**, top-16 order **100%**, worst abs Δ logit **8.82e-06**; exit code 1 on any disagreement |

`inference/export_browser.py` writes the parity fixture **from the exported,
quantized weights** — it dequantises the shard bytes it just wrote, hash-checked
on the way in — so the numbers are the quantization's own and not a float32
ideal.

That distinction is not academic: the gate's first run on real weights
**failed** at worst abs Δ logit 1.63e-01 with argmax agreement 98.6 %, because
the reference was reading the float checkpoint while the engine reads the int8
shards. Both sides now read the same codes and the disagreement drops to
8.82e-06 — float32 accumulation order and nothing else. A gate that compares
two different models can only measure its own bug.

### What the export reports, every time

`manifest.json` carries the measured sizes (q8, fp32 and fp16 equivalents,
gzip and brotli when available), the tokenizer hash and version, the worst
per-row quantization error, and the source checkpoint. `tools/build.mjs`
copies the export into `dist/` when it exists and prints which of the two
builds it produced. A build **without** a model is a legitimate bundle but not a
working assistant: since the answer path *is* the model, the panel says so
plainly instead of pretending, and the build prints which of the two it produced
rather than letting a deploy discover it at runtime.

---

## 7. Dev vs prod — the build (§9.3/§17)

`npm run build` → `dist/` (**44 files, 5,727,871 B** with the exported model;
**41 files, 558,954 B** without one — the model is git-ignored build output, so
a clean checkout measures the second number). Earlier: 28 files / 429,808 B
before the engine, voice, guard and model answer path landed.
`npm run preview` serves it on `:5580` through the same dev server with
`ROOT=dist`.

| Rule | How |
|---|---|
| `knowledge.json` ships as `publicView()` only | `tools/build.mjs` strips every `public:false` fact and keeps **ids + aliases only** in `meta.withheld_facts`, so a phone question still gets the specific decline |
| A withheld value must not appear anywhere in the bundle | the build scans every shipped file, comparing numbers digit-wise (`+91 62802875` in any format); a hit fails the build unless the file is an allow-listed *decision* |
| No dev tooling ships | executable references to `dev-*.js`, `shots/`, `training/checkpoints`, `data/raw|processed`, `localhost:5577` fail the build; a mention inside a comment is reported as a note instead. The code/comment split consumes **regex literals** as code, because a character class containing an apostrophe otherwise opened a phantom string and mis-classified every comment after it |
| Every module in the bundle resolves | relative imports and `<script src>` targets are checked against the file list |
| Nothing training-side ships | the allow-list is per-path: no `ai/tokenizer`, `ai/model/`, `ai/data/`, no `knowledge/*.md`, no `tests/`, `data/`, `docs/`. The trailing slash matters — `ai/model-export/` is the browser artifact and *must* ship |
| A model version directory ships **only** §9.3 files | `manifest.json`, `tokenizer.json`, `model-\d{5}.bin`; anything else in there is reported and left out. `--reference-out` used to default into this directory, which shipped a 257 KB parity fixture to every visitor |
| A model manifest without a shard is a refusal | a manifest that ships alone would serve a loader that 404s |

Known, deliberate, and reported on every build: `index.html` and
`js/terminal.js` publish the phone number because the *portfolio* publishes it
(§1 decided the assistant must not state it, not that the site must hide it).
That is an allow-list entry with a reason, not a default.

## 8. What is deliberately not claimed

**Which parts are pretrained, stated once (§17/§18).** §18's claim ends "(STT/TTS/VAD, if used, are disclosed as open pretrained components)". Here that clause resolves to **not used**: every weight that runs in the browser — tokenizer, model, retrieval ranks, guard — is ours, trained from random init (§7), and the voice stack ships **no model file at all**. STT is the browser's own `SpeechRecognition`, TTS is the browser's own `speechSynthesis`, and the VAD is hand-written energy code in `ai/voice/vad.mjs`. The §19 candidates (Moonshine, Silero, Kokoro, sherpa-onnx, wlama) were researched and **none is shipped** — see [RESEARCH_VERIFICATION.md](RESEARCH_VERIFICATION.md). Nothing third-party is downloaded, so there is nothing pretrained to disclose; the honest qualifier is that STT and TTS are then the *browser vendor's* components, which is why the disclosure bubble names them rather than claiming they are ours.

| Claim | Status |
|---|---|
| Tokenizer trains, is spec-conformant, round-trips EN/HI/Hinglish/SQL/URL/emoji | **verified** (tests + artifact) |
| Placeholder grammar shared by browser and tokenizer | **verified** (one fixture, two runtimes) |
| Parameter count for A/lite/smoke | **verified two ways** — analytically, and materialised (1,820,352 over 39 keys for smoke, torch 2.14.0+cpu) |
| Loss decreases over ~50 steps | **verified** on CPU at smoke scale: 6.6847 → 4.3151, `gate: PASS` |
| Training loop resumes from a checkpoint | **verified** on CPU: resumed at step 50 from `latest.pt` with the loss history and token count intact, then ran to a PASS. (A GPU Stage A run is still ahead.) |
| The page follows an answer to the part it came from, after the page is edited | **verified** by `dev-anchor-probe.js`, which renames the sections and moves a project into another scene before asking again — **34/34** on the run recorded in `docs/BENCHMARKS.md`. The probe's own waits have since been fixed (see that file's three instrument bugs) and its resolution half re-verified on the built bundle; the 34/34 figure itself was not re-made today |
| The visitor can actually SEE what they asked about, not just a moved page | **measured, and the instrument was wrong twice before it was right**: the anchored element's rectangle against the viewport once the scroll settles — **7/7 as shipped**, 6/7 on the edited fixture, where the miss is a section the film has no layout for and is reported as that. A third race was found on 2026-09-27 (it watched for a scroll before the answer that causes one existed, and demanded a move even from a refusal, which must not move — the two are opposite assertions); after the fix the resolution half is re-verified on the **built bundle** (7/7, hands-free `scrollY 0 → 14609`), while the full visibility sweep was **not re-run** |
| Answers speak as Aashish, refusals included | **verified** — every template, three languages, in `tests/quick-answers.test.mjs` |
| Opening and closing the panel leaks nothing | **verified** on R1/software GL — 0 nodes, 0 listeners, 0 MB per reopen over 5 cycles, and 0 shader programs compiled; the 10-minute Proactive soak and any real-GPU figure are **NOT TESTED** (`docs/RESOURCES.json`) |
| Hindi/Hinglish answer quality | **not measurable yet** — no model, and the seed fixture is synthetic |
| The §8.4 retrieval gate is calibrated rather than assumed | **bounded, one half measured** — ceiling 4.647 recomputed from the data by test; the floor is **NOT MEASURED** (`docs/CALIBRATION.json`) |
| Numbers and declared aliases are retrievable | **verified** — "8.28" → `ach.lpu-cgpa`, "who is he" → `person.name`, both regression-tested |
| Browser inference and quantisation | **built, and run on trained weights** — a module worker runs the graph on int8 weights, shards are SHA-256 verified on load, and three implementations of the same architecture are cross-checked (torch ↔ numpy ↔ JavaScript). Measured on the `local` checkpoint's export: 138 positions, argmax **100 %**, top-16 order **100 %**, worst abs Δ logit **8.82e-06**, load 57–63 ms, prefill 68–71 tok/s, decode **65–74 tok/s** (8–9× §4's floor) on R1's CPU |
| §4's budgets, with the model in the bundle | **measured** — chat code chunk **70,544 B gz (45.9 %, 81 KB of headroom)** of a 150 KB budget, of which §4's chat-UI chunk proper is 47,900 B (31.2 %) and the voice add-ons (7,975 B) and the LLM runtime + tokenizer (14,669 B) are §4 rows of their own; what the **click** actually fetches is 42,143 B gz (the static reach of `ai/ui/chat.mjs`, 14 files) and the arithmetic it does **not** parse is 13,296 B gz (9 files, worker-only); model payload 4,741,050 B gz, first visit 4,811,594 B gz = **11.5 %** of §4's 40 MB (step-1100 export). It was 138,896 B (90.4 %) until shipped `ai/**` stopped carrying comments — half the chunk's gzip — which the build now strips at copy time while the repository keeps them (`stripComments`, and a dist-vs-source answer comparison in `tests/build-bundle.test.mjs`). Asserted on every `npm test`; the weight budgets are NOT TESTED (loudly skipped) without an export |
| §2 N8: the AI draws nothing and starts no loop | **verified statically over the shipped code** — the whole `ai/` tree contains no `getContext`, no canvas element, no `WebGLRenderer`/`WEBGL_` access, no `new THREE.` and no `setInterval`, and `requestAnimationFrame` appears **exactly once** (`env.requestAnimationFrame?.(() => …classList.add('is-open'))`, a one-shot reveal, not a loop). §6.3's frame monitor rides the film's GSAP ticker and the test requires both `.ticker.add` and `.ticker.remove`, because a ticker callback that cannot be removed turns `close()` into a leak |
| The model's arithmetic is parsed only inside the worker | **verified by import graph** — `tests/build-bundle.test.mjs` requires `ai/engine/index.mjs`, `llama.mjs`, `bpe.mjs`, `quant.mjs` and `cache.mjs` to be reachable from `ai/engine/worker.mjs` and **not** from `ai/ui/chat.mjs`, which holds the worker by URL (`session.mjs`) instead of importing it. **13,296 B gz across nine files** is deferred this way, and it is the structural reason §4's 50 ms main-thread rule survives at all |
| §2 N6: nothing AI exists before the click | **verified twice** — the browser half is `dev-ai-probe.js`'s network assertion (0 AI requests pre-click); the deterministic half is `tests/launcher.test.mjs`, which holds `js/ai/launcher.js` to its **2 KB gz** budget (**MEASURED: 945 B**), requires it to be inert (no fetch, XHR, Worker, WebSocket, sendBeacon, wasm, knowledge base), pins its single `import(CHUNK)` to the chat shell, and requires `index.html` to name nothing under `ai/` — no script, link, import-map entry or preload — in the source *and* in `dist/` |
| §2 N6: voice assets arrive on a tap, not on the click | **verified in a browser** — `dev-ai-probe.js` fetches `ai/voice/caps.mjs` with the shell and the engine modules only after the microphone button is pressed; `tests/build-bundle.test.mjs` follows the shipped import graph and fails if `ai/voice/index.mjs`, `vad.mjs` or `phantoms.mjs` become statically reachable from `ai/ui/chat.mjs` again |
| §9.3's cache: a later visit costs no network | **measured** — `dev-offline-probe.js` reloads with `*model-export*` blocked at the CDP level and the model still reaches ready from `aashish-ai-model:aashish-ai-1` (`hits: 3`, `misses: 0`, 0 network responses). What is NOT TESTED is the page's own HTML offline: no service worker is registered (§9.3), so the document is the browser's business |
| No answer template ships to a visitor | **verified** — §5.1 step 4's wording is in `evaluation/answer-text.mjs`, which the build does not copy, and `tests/build-bundle.test.mjs` asserts it twice: no built text file contains a template phrase, and the shipped planner returns `text: ''` for every portfolio question (only the §9 refusal and the identity disclosure, which are fixed statements about the *assistant*, still ship) |
| §6.3's rungs actually reach the session | **verified in Node** — the wiring is `createSessionBudget` in `ai/governor/index.mjs`, dependencies injected, so every rung is *run* against a fake answerer and a fake scene (GOV-3/GOV-3b/GOV-4). It replaces a source-text grep that passed while rungs 1 and 2 were dead — see `docs/PROGRESS.md` |
| §10's message controls: Stop, Retry, Clear | **verified in a browser** — `dev-ai-probe.js` presses them: Stop is offered only while answering (1 ms after the ask), takes effect, and leaves the bubble badged `PARTIAL ANSWER · STOPPED BY YOU` with no placeholder in it; Retry starts a fresh generation. The stop's text rules are unit-tested on the real knowledge base (`partialAnswer`, MODEL-17). What Stop does NOT do is interrupt the worker's current pass — see `docs/PROGRESS.md` |
| The export carries no dev path and no test fixture | **verified** — provenance is step/commit/SHA-256, not a directory (the build refused the path); a model version directory ships only its manifest, tokenizer and shards, so the 257 KB parity fixture no longer reaches `dist/` |
| The same model is not two different sizes | **verified** — 4,984,064 params, and the 5,246,208 a naive `state_dict` sum reads is the **tied** `lm_head.weight` counted twice (`data_ptr()` equal, `tieGap` 0), pinned by test |
| The model answering from **its own generation**, not a template | **built, and answered in a real browser** — `ai/answers/model.mjs` retrieves context, asks the worker, guards the result and resolves placeholders. MEASURED on R1 headless Chrome: `dev-ai-probe.js` 31/31, panel ready 20.0 s, first answer 91.6 s, `AI ANSWER · ON-DEVICE MODEL` with 2 sources, "what is his phone number?" → `NO ANSWER · NOT PUBLISHED`, and the intent-fallback question ("what are your skills?") reading **12 capped facts**. What its answers *SAY* is still **NOT TESTED as quality** — the 4.98M `local` checkpoint is an export exercise, and it answers with garbage |
| An always-open microphone that still only transcribes speech | **built, unit-tested** — `ai/voice/vad.mjs` (energy VAD, adaptive floor, hysteresis, max segment, post-cut cooldown) opens a gate the recognizer is switched by. Whether it survives a real room is **NOT TESTED** |
| **Voice**: microphone, wake phrase, speech output | **built, adapter-first, and browser-verified** — 0 AI requests before the tap, the audio disclosure in the DOM before any result can be handled, a wake phrase in continuous mode, the answer spoken in its own language, and a dead microphone turned off with a stated reason and the scene handed back (`dev-ai-probe.js`: 26/26 when this row was written, **46/46** on the 2026-09-27 re-run of a larger check set — the probe prints its own tally, and the tallies are not comparable across revisions) |
| §11.1 (d)/(e): one idle nudge, then a standby that releases the recognizer | **built, unit-tested** — `armIdle()` arms a single clock from the last real interaction (a question, an answer, the gate opening); at ~25 s it emits **one** deterministic nudge (`IDLE_NUDGE`, shown rather than spoken) and at ~90 s it enters standby: `nick.stop()` while `enabled` stays true. **Only with a VAD gate**, because the gate is the only signal that can bring it back (a released recognizer nobody can wake is worse than an open one) — so push-to-talk and ungated sessions never enter it. A nudge due while an answer is being read is deferred, and an answer resets the clock |
| §11.2: the transcript of a heard question, with tap-to-edit | **built, and verified in a browser** — the voice layer calls `chat.ask(question, { source: 'voice' })`, the shell badges that bubble `HEARD` and attaches one `EDIT` control that puts the words back in the box. `dev-ai-probe.js` drives that same call, finds the badge and the control, presses it and reads the input back |
| §11.5's voice visual: a state the visitor can see | **built, unit-tested** — a CSS dot driven by one `data-voice` attribute (`voiceVisualState`, pure and tested for its priority order), animation only under `prefers-reduced-motion: no-preference`, `transform`/`opacity` only, no canvas/WebGL/frame loop (asserted over the stylesheet), `off` hidden and `suspended` dimmed rather than hidden. What it looks like on a real screen is **NOT TESTED** — no browser has been shown it |
| Where voice recognition runs: on the device when the platform says it can | **built and unit-tested, NOT TESTED on a machine** — `probeOnDevice()` asks once per session; `processLocally` is set only on `'available'`; the microphone does not open until the question is answered or the 1.5 s cap is lost (silence counts as no, so the sentence is never left unspoken); a refusal of the on-device mode falls back to the server-side engine once and switches the disclosure back. `tests/voice.test.mjs` VOICE-12 (7 cases) with a double that answers `available` / `unavailable` / never / throws / refuses the session. **No real browser has reported `available` to us yet** |
| **Voice with a live microphone** | **NOT TESTED.** Headless Chrome ships the API and has no microphone, so the *listening* path is covered by unit tests against doubles (34 before VOICE-12, 47 in the file now) and by a browser running a **stub** engine (`dev-resource-probe.js`), never by a real voice. A human saying "hey Aashish" into a laptop, in a noisy room, with an accent, has not happened — and neither has the on-device path, which depends on a language pack being installed on the visitor's machine. Chrome-only in practice; **Firefox and Safari get the disabled button and the reason** — verified on Firefox 156.0.1 on 2026-09-28 (`npm run probe:firefox`: the button is disabled with `title="This browser has no speech recognition, so voice mode stays off…"`), while **Safari is unverified** |
| Continuous mode's turn lifecycle: wake → follow-up → expiry | **verified in a browser with a stub engine** — unaddressed speech asked 0 questions, the wake phrase asked 1 and opened the turn, a bare follow-up asked 2, and after 12 s of silence the turn closed and the next unaddressed sentence asked nothing |
| A cloned voice (his own) | **not started** — this is the browser's voice, chosen by language |

Every "verified" row above corresponds to a command in
[TRAINING.md](TRAINING.md#verification) or a test name in `tests/`.
