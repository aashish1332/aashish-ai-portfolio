# AI ARCHITECTURE — Aashish AI Portfolio Assistant

One document for how the assistant is put together, what is verified, and
what is not. It is written per phase and updated as phases land; anything
not yet built says so instead of describing the plan as if it existed.

Status: **P1 complete · P2 complete · P3 complete (all three gates verified,
on CPU at smoke scale — see [TRAINING.md](TRAINING.md)) · §10 voice and §12
section-following landed.** P4–P11 not started; voice input does not exist.

---

## 1. The shape of the thing

```
visitor types ──▶ language detector (§8.3)  ──▶ intent router  ──▶ retrieval (BM25 + aliases)
                        │                            │                    │
                        ▼                            ▼                    ▼
                  reply language            Quick Answers        top ≤3 chunks, ≤300 tokens
                  (EN/HI/Hinglish)          (deterministic)              │
                        └────────────────────────────┬───────────────────┘
                                                     ▼
                                       placeholder resolution (§7.2/§8.4)
                                                     │
                                       [ P4+ : scratch model proposes text ]
                                                     ▼
                                       Faithfulness Guard (§8.4 layer 4)
```

There is **no backend, no API key, and no LLM service**. Everything in
P1–P3 runs in the browser or on the training machine.

| Layer | Files | Ships to browser |
|---|---|---|
| Knowledge base | `knowledge/knowledge.json`, `ai/knowledge/view.mjs` | yes (public view) |
| Retrieval | `ai/retrieval/index.mjs` | yes |
| Language detection | `ai/language/detect.mjs`, `ai/language/lexicons.json` | yes |
| Intent routing | `ai/intent/rules.mjs` | yes |
| Answers | `ai/answers/quick.mjs` | yes |
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
Quick Answers are template-built from `knowledge.json`, so every sentence
is exact by construction and works with **no model present** — which is
what makes the shipped panel honest today.

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
moves a project into a scene of its own — and asks again. **20/20**, including
`scrollY 0 → 5059` from hands-free mode alone. Resolution costs 14.6–29 ms
(a bounded walk of ≤800 elements, no layout read) against §4's 50 ms budget.

---

## 6. Browser runtime, export, quantisation (§9) — P6/P7, not started

Nothing here is built yet. What P3 fixes in advance:

* the config exports as an HF-shaped `config.json` (`ModelConfig.to_hf_config()`),
* the parameter list is asserted against the HF Llama key set, and
* the tokenizer artifact is a plain `tokenizer.json` with its own version
  hash, which is what llama.cpp's converter expects.

Intended pipeline (per §9.2, unchanged): checkpoint → fp16 → **Python CPU
inference first** → parity check → GGUF and/or ONNX → quantise → measure.
Sizes will be measured, never estimated in prose.

---

## 7. Dev vs prod — the build (§9.3/§17)

`npm run build` → `dist/` (27 files, **387,696 B**); `npm run preview` serves
it on `:5580` through the same dev server with `ROOT=dist`.

| Rule | How |
|---|---|
| `knowledge.json` ships as `publicView()` only | `tools/build.mjs` strips every `public:false` fact and keeps **ids + aliases only** in `meta.withheld_facts`, so a phone question still gets the specific decline |
| A withheld value must not appear anywhere in the bundle | the build scans every shipped file, comparing numbers digit-wise (`+91 62802875` in any format); a hit fails the build unless the file is an allow-listed *decision* |
| No dev tooling ships | executable references to `dev-*.js`, `shots/`, `training/checkpoints`, `data/raw|processed`, `localhost:5577` fail the build; a mention inside a comment is reported as a note instead. The code/comment split consumes **regex literals** as code, because a character class containing an apostrophe otherwise opened a phantom string and mis-classified every comment after it |
| Every module in the bundle resolves | relative imports and `<script src>` targets are checked against the file list |
| Nothing training-side ships | the allow-list is per-path: no `ai/tokenizer`, `ai/model`, `ai/data`, no `knowledge/*.md`, no `tests/`, `data/`, `docs/` |

Known, deliberate, and reported on every build: `index.html` and
`js/terminal.js` publish the phone number because the *portfolio* publishes it
(§1 decided the assistant must not state it, not that the site must hide it).
That is an allow-list entry with a reason, not a default.

## 8. What is deliberately not claimed

| Claim | Status |
|---|---|
| Tokenizer trains, is spec-conformant, round-trips EN/HI/Hinglish/SQL/URL/emoji | **verified** (tests + artifact) |
| Placeholder grammar shared by browser and tokenizer | **verified** (one fixture, two runtimes) |
| Parameter count for A/lite/smoke | **verified two ways** — analytically, and materialised (1,820,352 over 39 keys for smoke, torch 2.14.0+cpu) |
| Loss decreases over ~50 steps | **verified** on CPU at smoke scale: 6.6847 → 4.3151, `gate: PASS` |
| Training loop resumes from a checkpoint | **verified** on CPU: resumed at step 50 from `latest.pt` with the loss history and token count intact, then ran to a PASS. (A GPU Stage A run is still ahead.) |
| The page follows an answer to the part it came from, after the page is edited | **verified** by `dev-anchor-probe.js` (20/20, renames and moves the page first) |
| Answers speak as Aashish, refusals included | **verified** — every template, three languages, in `tests/quick-answers.test.mjs` |
| Hindi/Hinglish answer quality | **not measurable yet** — no model, and the seed fixture is synthetic |
| Browser inference and quantisation | not started |
| **Voice**: microphone, wake word, speech synthesis | **does not exist.** Only the mode flag that makes the page follow an answer, and the honest statement that no audio input or output is implemented anywhere in this build |

Every "verified" row above corresponds to a command in
[TRAINING.md](TRAINING.md#verification) or a test name in `tests/`.
