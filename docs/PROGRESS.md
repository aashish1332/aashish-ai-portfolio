# PROGRESS — Aashish AI

Phase log per §16. Each phase: what was done · what was **measured** · what is still open.
Never report a phase as done unless its gate passed (or the gap is written down here).

---

## Phase 0 — Audit + baseline

**Status:** ✅ **GATE PASSED** (both gate artefacts exist)
**Date:** 2026-09-19 · **Prompt:** `Aashish_AI_Agent_Prompt_v2.md` (v2, Sep 2026)

### Done
1. Located and parsed the authoritative CV. The brief's path was wrong for this machine:
   it is `C:\Users\HP\OneDrive\Documents\Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx`
   (`%USERPROFILE%\Documents` is OneDrive-redirected). Parsed via `word/document.xml` extraction —
   no Python dependency added. **The .docx was not copied into the repo.**
2. Audited the whole repo → `docs/AUDIT.md`: no framework, no bundler, no build step, no service
   worker, no analytics, no existing AI code, **no git repository**.
3. Mapped every hook §12 depends on, with line numbers (GSAP ticker, module-private Lenis instance,
   `Film3D.forceTier`, the missing `setQuality`/`pause`/`resume`, the two public APIs).
4. Wrote `dev-baseline-probe.js` (`npm run baseline`) → `docs/BASELINE.json`.
5. Wrote this log.

### Measured (R1 = your dev laptop: Intel HD 520, 4 threads, 8 GB, headless Chrome 153)
| Metric | Value |
|---|---|
| Initial load | **51 requests · 606.9 KB transferred · 472.2 KB JS · LCP 972 ms** |
| Boot long tasks | 3 long tasks, **max 1847 ms**, sum 2391 ms (TBT proxy, ESTIMATED) |
| Scripted 30 s scroll | **median 30.4 ms (32.9 fps) · avg 31.0 fps · p95 49.5 ms · 96.8 % frames > 20 ms** |
| Governor beyond the scroll | **tier 4 · SURVIVAL · res 50 % · mirror 192 px** |
| Page/console errors | **none** |

**Honest reading:** the film's "hold 60, never below 30" contract is **not met on R1** — the
portfolio already sits at its last quality tier, so the AI has *no* frame budget to spend.

### Still open
- **BLOCKED:** `git init` + branch `feature/aashish-ai` + baseline commit — needs your git
  `user.name`/`user.email` (none configured on this machine).
- **DECISION:** keep, revert or re-verify the in-flight `js/film3d.js` visual enhancement
  (started before this brief arrived; N1 requires the portfolio stay visually intact).
- **DECISION:** deployment host (no Netlify/Vercel/Pages/CI config exists) — affects §9.3 caching.
- **APPROVAL:** the PII table in `docs/AUDIT.md` §5.3.
- **NOT TESTED:** official Lighthouse TBT/LCP; WebGPU adapter validity on HD 520; any real
  phone/iPhone run; a non-`prefers-reduced-motion` baseline (headless Chrome forces `reduce`).
- Housekeeping: `.cv-raw.txt` (PII) must be deleted before any commit; leftover recovery artefacts
  (`film3d_recovered_0.js`, `film3d_firsthalf_f_001ac2.txt`, `shots/`, `dev-fps-last.png`,
  `probe-*.txt`, `shots-*.txt`, `*.log`) are git-ignored.

### Evidence
- `docs/AUDIT.md` · `docs/BASELINE.json` · `npm run baseline` → `dev-baseline-probe.js`

---

## Phase 1 — Knowledge (§16)

**Status:** 🟢 **P1 CODE COMPLETE — no open gaps.** Knowledge base, BM25 retrieval, language
detection, intent routing and a deterministic Quick Answers engine in all three languages, plus
an *executed* `evaluation/portfolio_tests.json` (60 cases, 56 of them run on every `npm test`).

**✅ P1 GATE PASSED** — tests pass (189), Quick Answers is usable standalone with no model, and
the PII list is **approved by the owner** (2026-09-20): phone `public:false`, project live URLs
`public:true` (`knowledge/PII_REVIEW.md`).

### Done
1. **`knowledge/knowledge.json`** — the §8.1 schema, built **only** from the authoritative CV plus
   `index.html`. 54 fact objects: 1 person, 4 contact fields, 2 links, 2 education, 38 skills,
   3 projects, 1 experience (training only), 3 certifications, 5 achievements, 1 workflow.
   Every fact carries `id` · `source` ∈ {cv, portfolio} · `public` · `aliases` (Devanagari +
   Hinglish spellings for §8.2 retrieval).
2. **`knowledge/CONFLICTS.md`** — all 10 conflicts found, classified:
   C1 90+/40+ figures are project-scoped (reworded, not deleted); C2 Three.js/GSAP are
   portfolio-only, not CV skills; C3 attribution framing bounded; C4 bootcamp provider **excluded**
   (not stated anywhere); C5 two divergent CV files **open**; C7 **no employment history exists**
   → the top hallucination-bait area; C8 placeholder social links (real URLs recovered);
   C10 live project URLs retained.
3. **`knowledge/PII_REVIEW.md`** — the §1 print-out for your approval, plus two decisions.
   Corrected mid-Phase-1: the phone number and Phagwara/Punjab are **already published by the
   portfolio** (`index.html:447`), so my Phase 0 assumption was wrong and the audit is amended.
4. **`ai/retrieval/index.mjs`** — §8.2, no model, no network: BM25 (k1 1.2 / b 0.75) + a
   transliteration/variant map + char-trigram fuzzy matching (Dice ≥ 0.62) + an entity index +
   the conversation's **focus entity** with pronoun lock-on. Enforces the §8.2 budget in code:
   `MAX_CHUNKS = 3`, `MAX_CONTEXT_TOKENS = 300` (4-chars-per-token approximation), and a
   `MIN_TOP_SCORE` retrieval gate that abstains *without* calling a model (§8.4 layer 1).
   Chunks are written so they can be pasted straight into model context in Phase 5+.
5. **`ai/language/detect.mjs`** — §8.3, no selector, no ML: Devanagari ratio + a Roman-Hinglish
   function-word lexicon + an English stop-word negative signal + turn smoothing where a *weak*
   signal defers and a *strong* one always switches. Includes `voiceHint()` for the §11.4 TTS tier.
7. **`ai/intent/rules.mjs`** — §5.1 step 2. Ordered, deterministic rule dispatch over
   14 intents, with injection shapes checked first and the hallucination-bait check sitting
   *above* the topic buckets ("did he intern at Google?" must abstain even though it also
   looks like a skills question). Project names resolve against the knowledge base's own
   aliases, in any script, so the resolver cannot drift from the data. No rule escalates
   privilege — an intent only ever selects an allow-listed handler.
8. **`ai/answers/quick.mjs`** — §5.1 step 4. The Quick Answers engine: **no model, no network,
   no dynamic import** (a test scans the source for `fetch`, `XMLHttpRequest`, `import(` and
   URLs). Every sentence is a fixed template and every value is copied from `knowledge.json`,
   so a Quick Answer is *exact by construction* — it cannot hallucinate because it never
   generates. Also implements §5.1 step 6 (`<|fact:id|>` placeholder resolution against a
   public-only allowlist, reporting unresolved ids for the future faithfulness guard) and
   step 7 (deterministic follow-up chips per intent, per language).
   Prose intents (`workflow`, `project_detail`) return verbatim KB text flagged
   `extractive:true`, which is what makes the assistant usable standalone on T0 with no model.
9. **`evaluation/portfolio_tests.json` + `evaluation/README.md`** — §14. **60 cases:**
   19 direct · 7 indirect · 7 follow-up · 7 unknown · 4 switch · 6 malicious · 6 bait ·
   4 synthetic-portfolio. `tests/evaluation.test.mjs` **executes 56** of them (the 4 synthetic
   ones need a model and are reported as *deferred to P5*, never silently passed) and turns
   §14's gates into `npm test` assertions: grounding, unknown-abstention, bait/no-fabrication,
   injection resistance, language consistency, and zero forbidden strings anywhere.
   Three bugs (R6, R7 and the nukta variant of the withheld phone field) were found *by writing
   this file* — which is the point of writing it first.
10. **`tests/`** — **189 tests, all passing** via `npm test`:
   - `language.test.mjs`: **106 frozen classifier cases** (≥100 required by §8.3) + smoothing,
     tokenizer, diagnostics and voice-hint contracts.
   - `retrieval.test.mjs`: §8.2 budget enforcement, abstention on nonsense, fuzzy/variant matching,
     focus-entity carry-over, plus **named regression guards for the four bugs found while building
     it** (see below).
   - `knowledge.test.mjs`: §8.1 schema, unique ids, provenance, project/skill shapes,
     secret-shaped-value scan, CV-file-never-ships, working `publicView` gate, and regression
     guards for C1/C2/C7.
   - `intent.test.mjs`: intent/entity contract, injection-first ordering, bait vs rescue, plus
     the five named regressions below.
   - `quick-answers.test.mjs`: exact-by-construction (it refuses to let a fact value live in the
     engine's source), no-network/no-model, public-only sources, placeholder allowlist,
     three-language template coverage, follow-up chips, and the seven named regressions below.
   - `evaluation.test.mjs`: the §14 runner described in item 9.

### Bugs found and fixed during Phase 1 (each now has a regression test)

| # | Bug | Why it mattered |
|---|---|---|
| **R1** | Alias text leaked *function words* into the BM25 index. The workflow chunk's alias *"how does he use ai"* was boosted 3×, so `does`/`he`/`use` gave it a **12.36** score for *"which databases does he use"* — beating every real database fact | Idle glue was outranking facts. Fixed with `RETRIEVAL_STOP` = English ∪ Hinglish function words, applied to body **and** alias tokens |
| **R2** | *"uska naam kya hai"* retrieved **nothing** — no chunk contained `naam`/`name` | The single most likely first question from a Hinglish visitor. Fixed by adding `naam`/`name`/`पूरा नाम` index terms |
| **R3** | Skill chunks indexed their editorial `note` text, so the phrase *"…not by the CV's skills list"* put the word **skills** inside exactly two skill chunks — *"uske skills kya hain"* returned `skill.threejs` | Editorial meta must never be searchable. `note` is now excluded from chunks |
| **R4** | *"where does he study"* retrieved **nothing** — no `study` index term (only Devanagari `पढ़ाई`) | Fixed by adding `study`/`studies`/`education`/`degree`/`padhai` |
| **R5** | **Focus entity was wrong.** A pronoun follow-up *"uska database kaun sa tha?"* (="what was **its** database?") switched focus to `cert.dbms` because the literal word "database" matched — instead of staying on the project under discussion | This is precisely the §8.2 follow-up case. A pronoun now **locks** focus; only an outright entity name can move it |
| **R6** | **The lock had no idea which kind of pronoun it held.** `his` was treated exactly like `uska`, so *"and his 12th marks?"* stayed locked on the B.Tech instead of reaching `edu.kv2`, and a bare `cgpa` query resolved to the **Minor's** CGPA because 'cgpa' is in both records and BM25 length-normalisation prefers the shorter chunk | §8.2 now separates **entity** pronouns (it/uska → lock) from **person** pronouns (his/he → a new question about Aashish, free to name another record). Found by `evaluation/portfolio_tests.json` cases f05/f06, which started life as `known_gap` entries and are now real gates. The `cgpa` ambiguity was resolved in **data**, not ranking: `edu.lpu` declares the `cgpa`/`gpa` aliases, because the portfolio's headline CGPA (index.html:142) *is* the B.Tech one |
| **R7** | **Devanagari combining marks were being deleted.** `normalize()` whitelisted `\p{L}` and `\p{N}`, but vowel signs are category **Mn** — a mark, neither — so matras were replaced with a space: `उसका` became `उसक` **on both sides of every comparison** | **Every Hindi alias and every Devanagari pronoun silently missed.** `पढ़ाई` → `edu.lpu` and `किराना` → `project.grocery` did not work at all. One character class (`\p{M}`) fixed the whole script; it is guarded by R7 and by evaluation cases d19/d20 |

### Bugs found and fixed in the intent + answers layer (each now has a regression test)

The first two were left behind by a session that died mid-edit, so `ai/intent/rules.mjs` did not
load at all:

| # | Bug | Why it mattered |
|---|---|---|
| **INT-1** | `PATTERNS.experience` was referenced in the dispatch but never defined → `TypeError: bucket is not iterable` for **any** query reaching the last line | The module was a crash, not a classifier. The bucket now exists (training + availability) and INT-1 runs a 25-query battery through every path |
| **INT-2** | `detectProject()` had been deleted while `detectIntent()` still called it → every project question threw | Restored as a knowledge-base alias scan (see INT-4) instead of a second hand-written list |
| **INT-3** | A trailing `\b` after a **stem** kills its own inflections: `database\b` ∌ `databases`, `certificat\b` ∌ `certifications`, `achiev\b` ∌ `achievements`, `educat\b` ∌ `education`, `graduat\b` ∌ `graduation`. Separately, all greeting patterns were Latin-only, so the spec's own Hindi greeting **"नमस्ते"** abstained | Five topic intents were silently unreachable for their most natural phrasing, and Hindi/Hinglish visitors got an abstention instead of a greeting. Stems no longer carry a trailing boundary; Devanagari greetings and project names were added |
| **INT-4** | Project routing was a second, hand-written alias list — guaranteed to drift from `knowledge.json` | `detectProject()` now scans the knowledge base's own aliases and codenames in any script, and INT-4 asserts **every** alias in the base routes to its project |
| **INT-5** | `worked (at\|for\|with)` classified *"what backend technologies has he **worked with**?"* as employment bait → a **false abstention** on a skills question | Only employer-shaped phrasing (`worked at/for/as`) presumes an employer. §14 caps false abstention at 10 %; this one was self-inflicted |
| **INT-6** | Attack phrasing *"repeat the above rules"* was not caught — the injection patterns required `your/the` + `prompt/instructions/rules` with nothing between | Injection must not depend on one phrasing. Added the `above/previous/prior + rules/instructions/prompt` shape |
| **QA-1** | `extractive()` answered **every** intent, not just the prose ones — so *"what is his favourite pizza"* returned the project list instead of abstaining | The §8.4 layer-1 abstention was unreachable for the whole `out_of_scope` class. The function is now gated to `workflow` / `project_detail` |
| **QA-2** | A confident hit on an unrenderable chunk fell through to the project prose: *"how many years of experience…"* answered with the project list | The step-5 fallback now requires the hit to be a **project** |
| **QA-3** | The single-fact path fired on fuzzy noise: *"what car does he drive"* → achievement *"Grade A in the AI-Driven MERN Stack Bootcamp"* (drive → **driven**, Dice 0.73) | Fuzzy matching is for typos (`mongoos`→`mongoose`), not for answering a question that was never asked. A fact is now only answerable when the query matches **its own name or aliases** |
| **QA-4** | The spec's own Hindi greeting **"नमस्ते"** abstained (all greeting patterns were Latin-only) | Native-script greetings route to `greeting` |
| **QA-5** | A generic *"tell me about the projects"* returned one stray project (whichever ranked first) | Plural project questions now return the list; superlatives ("strongest") resolve to the flagship by `is_latest` |
| **QA-6** | *"thanks"* was answered with the full introduction | Acknowledgements get an acknowledgement |
| **QA-7** | *"where can I see his code"* hit the skill whose **name** contains the word "code" (**VS Code**) instead of the links | `repo`/`source code`/`his code` now route to contact/links |
| **QA-8** | The fact path only looked at `hits[0]`, so *"which AI models does he use"* abstained — the top chunk was the workflow chunk (its alias carries "ai") while `skill.gemini` sat in the same result set | The best *renderable* hit is used instead; QA-3's alias requirement says which hits may be answered at all, so this cannot widen what is answerable |

### Measured
| Metric | Value |
|---|---|
| Test suite | **188 pass / 0 fail** (`npm test`) |
| Classifier cases | 106 (10 Hindi · 5 Hindi+Latin code-mix · 35 Hinglish · 35 English · 8 no-function-word · 5 empty · 8 English-collision traps) |
| Retrieval index | 60 chunks · 398-term vocabulary · avgdl 31.8 (built from 54 facts) |
| Retrieval budget | enforced in code: ≤ 3 chunks, ≤ 300 context tokens — verified by test |
| Retrieval correctness probes | *"uska naam kya hai"*→`person.name` · *"where does he study"*→`edu.lpu` · *"which databases does he use"*→`skill.mysql`… (skills, not the DBMS certificate) · *"volunteer os"*→`project.volunteer` · *"contact email"*→`contact.email` · *"quantum physics homework"*→**abstains** |
| Evaluation set | **59 cases · 55 executed · 4 deferred (synthetic-portfolio → P5)** — §14 runner in `npm test` |
| §14 gates measured *without a model* | grounding 100 % · unknown-abstention 100 % · injection resistance 100 % · fabricated facts **0** · language consistency 100 % |
| Quick Answers coverage | 14 intents · 3 languages · 2 prose intents return verbatim KB text (`extractive:true`) so T0 answers with no model loaded |
| Cost, method = node v24.13.0 on win32 (R1), mean of 2000 calls, index warm vs cold — **Node, not browser** | `quickAnswer` **0.72 ms/call** (includes a full retrieval pass) · `buildIndex` **2.36 ms** cold · `detectLanguage` **0.005 ms** |
| Detection + routing cost | pure regex + Set lookups; no allocation-heavy work on the hot path (measured above, not estimated) |

### Still open
- **PII — ✅ APPROVED (2026-09-20):** the phone number is **`public:false`** and the project live
  URLs are **`public:true`**. The assistant declines the phone with a useful redirect to the email
  (the portfolio still prints the number at `index.html:447`; that inconsistency is the owner's
  deliberate choice to slow scraping). Enforced in `ai/knowledge/view.mjs` — the facts map *and*
  the BM25 index are built from the public view, so a private value cannot be retrieved or
  rendered — plus cases d02/d21 and QA-9. **Updating knowledge must not require touching code:
  flip `public` and re-run `npm test`.**
- **Remaining Phase 1 work:** none. `ai/answers/quick.mjs` and `evaluation/portfolio_tests.json`
  exist, are tested, and the §14 gates that do not need a model are measured on every
  `npm test`. The two gaps the eval found (f05/f06) were **fixed**, not deferred: R6 corrected
  the pronoun lock and the `cgpa` ambiguity was resolved by declaring the alias on `edu.lpu`.
  `tests/evaluation.test.mjs` prints zero open gaps.
- **Retrieval precision (known, bounded):** a short English word that is also a fragment of a
  compound technology name can still be retrieved ("his code" → *VS Code*). The intent layer
  now routes the one shape I found ("where can I see his code" → the links); the general case
  is the retrieval calibration §8.2 already schedules for P5 against this very eval file.
- **`MIN_TOP_SCORE` — ✅ CALIBRATED 2026-09-22** (`npm run calibrate`, artefact
  `docs/CALIBRATION.json`, see the phase section below). It is no longer an unmeasured
  heuristic: it has a hard measured ceiling of **4.647** (the weakest alias a fact declares
  about itself) which `tests/retrieval.test.mjs` recomputes from the data on every run, and a
  floor that is **explicitly NOT MEASURED** — none of the corpus's must-not-answer questions
  is kept out by the gate. The sweep also found two real retrieval defects (numbers invisible;
  glue-only declared aliases dead).
- **Localization boundary (by design, visible to a visitor):** the *templates* are native in
  EN / HI / Hinglish, but the fact **values** are English, because `knowledge.json` is built
  from an English CV. A Hindi question about a project therefore answers with a Hindi lead-in
  followed by the project's English summary. Translating the values is a content task on the
  knowledge base, not a code change — flagged here so it is not mistaken for a bug later.
- **C4 open:** bootcamp provider — excluded from answers until you supply it.
- **C5 open:** which of the two CV files is current.
- **Non-AI bug — ✅ FIXED:** 5 placeholder links in `index.html` + 2 in `js/terminal.js` all
  pointed at bare `https://github.com/` / `https://linkedin.com/` or literal
  `github.com/<your-handle>`. They now point at the CV-verified destinations: the three
  `VIEW THE CUT ↗` CTAs open each project's **live app** (VOLUNTEER OS, GROCERY.AI, GOAL
  TRACKER SaaS — the URLs in `knowledge.json`, sourced from the CV), and GITHUB/LINKEDIN/the
  terminal's `contact` block use `github.com/aashish1332` and
  `linkedin.com/in/aashishkumar13`. Verified by re-running the page probes after the edit.

### Evidence
`knowledge/knowledge.json` · `knowledge/CONFLICTS.md` · `knowledge/PII_REVIEW.md` ·
`ai/language/detect.mjs` · `ai/retrieval/index.mjs` · `ai/intent/rules.mjs` ·
`ai/answers/quick.mjs` · `evaluation/portfolio_tests.json` · `evaluation/README.md` ·
`tests/*.test.mjs` · `npm test`

---

## Phase 2 — Chat shell + Resource Governor (§16)

**Status:** 🟢 **P2 CODE COMPLETE** — the assistant is now a feature a visitor can use.
The gate is measured, not asserted: **+0 AI assets before the click**, the panel works with
**no model loaded**, and the film's own probes still come back clean.

### Done
1. **`js/ai/launcher.js`** — the only AI code on the initial page: **958 B gz**. It answers one
   question ("did the visitor click?") and dynamic-imports the shell. Hover-prefetch warms the
   UI chunk only, on a fine pointer, after 120 ms — never a model, never on touch. A failed
   import says so on the button instead of spinning forever.
2. **`ai/ui/chat.mjs`** — the lazy shell (§10). Panel, message log, starter/follow-up chips,
   **Sources** chips, badge per answer, Enter/Shift+Enter, Clear, autoscroll that stops when the
   visitor scrolls up, Esc to close, focus moved into the panel and returned to the button,
   `role="dialog"` + `role="log"` with `aria-live` on **completed** messages only. Rendering is
   `textContent` throughout — no `innerHTML`, no markup path at all.
3. **`ai/governor/index.mjs`** — §6 in one module: feature-detect-only probing (§6.1), the tier
   table (§6.2), the frame-health monitor (§6.3) and the four-rung degrade ladder, plus the
   worker micro-benchmark and a real SIMD compile check. `env` is injected, so the whole thing
   is unit-tested in Node with no browser.
4. **`ai/ui/styles.mjs`** — the panel's CSS, **injected by the chunk on first open** so the
   pre-click load pays nothing for it. No `backdrop-filter` over the canvas, `contain: layout
   paint style`, transform/opacity transitions only, safe-area padding, phone = full-screen sheet.
5. **§12 integration** — reuses the **existing GSAP ticker** for frame sampling (no new rAF),
   stops/starts **Lenis** on open/close, pauses the **film** when the phone sheet covers it and
   resumes on close, and asks the scene for temporary low quality via the new
   `Film3D.setQuality('low'|'normal')` / `pause()` / `resume()` hooks.
6. **Testing** — `tests/governor.test.mjs` (13 tests) and **`dev-ai-probe.js`**, an end-to-end
   probe that watches every request the page makes and drives the real panel on desktop and
   phone. `npm test` is now **202 tests**.

### Measured
Full detail in `docs/BENCHMARKS.md`. Headlines:

| Metric | Value |
|---|---|
| AI assets requested before the click | **0** (only the 958 B launcher) |
| Launcher | **958 B gz** (budget ~2 KB) |
| Whole chat chunk (8 modules + `knowledge.json`) | **43 KB gz**, 9 requests, all after the click (budget ≤150 KB) |
| Tier chosen, desktop headless (4 threads, SIMD ✓) | **T2 · STANDARD** |
| Tier chosen, phone (390×844, coarse pointer) | **T1 · LITE** |
| Phone behaviour | film **paused** while the sheet covers it, **resumed** on close, no horizontal overflow (390 vs 390) |
| Scroll lock | `lenis.isStopped === true` while open (§12) |
| Frame-health A/B | **INCONCLUSIVE** — headless software GL runs the film at 0.6–1.8 fps, so the ratio proves nothing. Printed as inconclusive rather than as a pass; needs the §15 reference profile on real hardware. The ladder's **cost** is now measured instead (see *Resource budget + lifecycle (§15.3)*: rung 3 = a full shader recompile) |
| Film regression after the change | desktop probe **clean** (no console/page errors, no failed requests); mobile equally clean |

### Bugs found and fixed in P2 (both would have shipped)

| # | Bug | Consequence |
|---|---|---|
| **GOV-1** | `SIMD_PROBE_BYTES` was a malformed wasm module (`v128.const` with five immediates instead of sixteen) | `hasSimd()` returned false on **every** engine, so `chooseTier()` forced **every device to T0** — the model could never have run anywhere, on any hardware. Found by reading the probe's own tier output, fixed, and now guarded by a test that validates the bytes against V8 |
| **UI-1** | `window.Director` was **never assigned** — only a script-scoped `const` | Every `window.Director && Director.getLenis()` guard in the project read `undefined` and silently skipped its scroll lock: the AI panel's, **lens mode's**, and the terminal's. The guard made a dead path look defensive. Exposed like `window.Terminal` already was; the probe now asserts `lenis.isStopped === true` rather than trusting the call |
| **GOV-2** | The ladder's minimum-sample gate was a hardcoded `30`, so a caller who tuned `sampleWindow` downward could never trigger it | The tunables were a lie in the direction that matters most (a device that needs help the soonest). Now `minSamples`, clamped to the window |
| **DEV-1** | The dev server's MIME map had no `.mjs` entry | Every AI module would have been served as `application/octet-stream` and refused by the browser as a module — the whole chunk fails to load locally. (`server.js` via Express was already correct.) |

### Still open
- **Frame-health measurement on real hardware** is the one P2 gate item not closed: the ladder's
  logic is unit-tested, its cost is not measured (§15 reference profiles R1/R2/R3, and a real
  phone under R4 — NOT TESTED).
- **Accessibility is verified only mechanically** (focus moves in and returns, Esc closes, roles
  and labels are present, no overflow). **No screen-reader pass** has been done — that needs a
  human on a real device, and it is on the manual checklist rather than claimed here.
- **No model exists yet**, so the panel is honest about it: every answer is labelled
  *"Quick answer — no AI model on this device"*. The download UI (§6.5) renders only when a
  `modelPlan` is supplied, which is P6/P7 work.
- ~~The shipped `knowledge.json` must still be reduced to `publicView()` at build time~~ —
  **closed** by `tools/build.mjs` (see *Production build* below), which also fails the build if a
  withheld value appears anywhere else in the bundle.

### Evidence
`js/ai/launcher.js` · `ai/ui/chat.mjs` · `ai/ui/styles.mjs` · `ai/governor/index.mjs` ·
`js/film3d.js` (`setQuality`/`pause`/`resume`) · `js/director.js` (`window.Director`) ·
`dev-ai-probe.js` · `docs/BENCHMARKS.md` · `tests/governor.test.mjs` · `npm test`

---

## Phase 3 — Tokenizer + model code (§16)

**Gate:** *tokenizer, model, `count_parameters.py`, local smoke train + resume
test → loss decreases; resume verified; param count printed.*

**Verdict, revised: all three gate items are VERIFIED — on CPU, at smoke
scale (1.82M params), after PyTorch 2.14.0+cpu was installed on this machine.**
The earlier "two of three are UNVERIFIED" line is left in the history rather
than quietly overwritten, because the difference between *not run* and *run*
is the whole point of the section.

| Gate item | Evidence |
|---|---|
| *loss decreases* | `python -m training.scripts.train_smoke --steps 50` → `gate 'loss decreases': PASS (6.6847 → 4.3151)`, 50 steps in 19.2 s, 1,335 tokens/s |
| *resume verified* | second run `--steps 60 --resume auto` → `resumed from latest.pt at step 50 (loss history 50 entries, 27,648 tokens consumed)`, ran to a PASS (6.6847 → 4.1782); pruning left `[40, 50, 60]` |
| *param count printed* | `inference/count_parameters.py --config all --gate` analytic band gate, **and** the materialised check: 1,820,352 params over 39 state-dict keys, matching the HF key set name-for-name |

Those two figures are a **CPU** smoke run, not a T4 Stage A run: they verify
the loop, the objective and the resume semantics, and they do not pretend to
speak for a 37.9M-parameter config A over several sessions.
`docs/TRAINING.md` carries the same verdict at item level.

### Done

* **Tokenizer (§7.2)** — `ai/tokenizer/`: our own byte-level BPE trained from
  scratch (never a pretrained vocab), NFC normalisation, automatic byte
  fallback so no `<unk>` exists, the six spec special tokens, and **one
  atomic token per fact id (63 placeholders)** so the model emits
  `<|fact:contact.email|>` and the app substitutes the verified value.
  Versioned `portfolio-bpe-<size>-<hash>`, where the hash covers the special
  tokens, the placeholder set and the grammar.
* **Placeholder grammar in one place per runtime, pinned by one fixture.**
  The browser resolver moved into `ai/knowledge/placeholders.mjs`; the
  tokenizer mirrors it in Python; both are asserted against
  `tests/fixtures/placeholder_cases.json` (16 hand-written cases).
* **Model (§7.1)** — `ai/model/`: RMSNorm, RoPE, SwiGLU, GQA, tied
  embeddings, causal SDPA (never FlashAttention — a T4 has none), KV cache,
  cached generation. Tensor names are the HF `LlamaForCausalLM` names, and
  `plan.param_table` is the schema both the counter and the module answer to.
* **`inference/count_parameters.py`** — per-component breakdown, §7.1 band
  gate, KV cache, FLOPs estimate, and an exact name/shape comparison against
  the materialised module **when torch is importable** (it prints
  `NOT INSTALLED` rather than pretending).
* **Data pipeline (§7.3)** — `training/scripts/make_seed_corpus.py`,
  `ai/data/`: clean → NFC → PII-to-placeholder → dedupe → language-ID →
  filters → tokenise → `uint16` memmap shards → deterministic split with
  exact **and** near-duplicate leakage checks that fail the run.
* **Checkpoints + resume (§7.5)** — `training/scripts/checkpoint.py`:
  `latest`/`best`/`step_N`, atomic writes, pruning, **required state keys
  enforced on save and load**, python/numpy/torch RNG capture, run manifest.
* **`training/scripts/train_smoke.py`** — 1.82M-param config, ~50 steps,
  fp16 AMP (CUDA), grad accumulation/clipping, cosine+warmup, eval, best-by-val,
  `--gate` (non-zero if loss did not decrease) and `--resume auto`.
  `--pipeline-only` is the torch-free path this machine can actually run.
* **Tests** — **+92 Python tests in a new second runner** (`npm run test:py`,
  the project has two runtimes now) and **+11 JS tests**: tokenizer contract,
  corpus pipeline, checkpoint/resume, model schema/arithmetic, language
  parity, placeholder parity. 5 Python tests skip with a printed reason when
  torch is absent — a green run must not be mistaken for a verified training
  loop.

### Measured

Full detail in `docs/BENCHMARKS.md`.

| Metric | Value |
|---|---|
| Config A parameters | **37,890,560** (37.89M) — §7.1 band 30–50M ✅ |
| Config lite / smoke | 17,701,248 ✅ · 1,820,352 (1–3M) ✅ |
| KV cache, config A, fp16 | **10.00 KB/token** → 10.0 MB at ctx 1024 (§7.1 claim ✅) |
| State-dict keys, config A | 93, matching the HF Llama layout |
| Tokenizer artifact | 1,024 vocab · 66,667 B raw / **10,291 B gz** · 63/63 placeholders atomic · 7/7 exact round-trips |
| Fertility (1,024 vocab) | en 2.46 · hi **4.71** · hinglish 2.69 · tech 4.35 · url_email 15.50 tok/word |
| Seed fixture | 17,402 lines / 3.2 MB → kept 17,265 (137 near-dup) · leakage **clean** · 749,590 train tokens |
| `prepare_data` / tokenizer training | 20.2 s / 3.6 s (this machine) |
| Test suite | **213 JS + 92 Python**, 0 failures (5 Python skips: torch) — 226 + 204 after the production build, P4 prep, the two licence gates and the
pipeline seam |

### What P3 found, and what it changed

| # | Finding | Consequence |
|---|---|---|
| **TOK-1** | The trainer **silently accepted a vocabulary the corpus could not support** — 4,096 requested, 1,935 returned | The embedding layer is sized from the *config*, so every parameter count, export and parity check downstream would inherit the mismatch. Now a hard failure with the reason |
| **TOK-2** | A BPE's vocab ceiling is set by **distinct word forms, not corpus volume** — measured at 802 merges for a 44-line corpus whether repeated ×4 or ×16 | P4's 12–16k must come from lexical diversity. It also makes the seed fixture's role explicit: pipeline verification, never a vocab decision |
| **DAT-1** | Corpus lines were written with embedded newlines, so a `Q:`/`A:` pair arrived as **two unrelated training records** | Frames are now collapsed to one line per example; the shard builder asserts `<|end|>` separates documents exactly |
| **DAT-2** | The near-duplicate threshold was a guess | Measured instead: exact 1.00, appended clause 0.88, one slot changed 0.68, parallel construction 0.17 → threshold set to 0.8 with the numbers recorded in code and tests |
| **CKP-1** | `os.fsync` failed on Windows (`Errno 9`) because the temp file was re-opened read-only | Durability step is `rb+` and non-fatal; the *atomicity* guarantee is `os.replace` and is unaffected |
| **CKP-2** | A checkpoint written by an older trainer could be resumed with a **fresh GradScaler**, silently changing the effective loss scale | `REQUIRED_STATE_KEYS` enforced on save **and** load; a legacy/partial file is refused with the missing keys named |
| **TST-1** | My own test claimed `उसकी` contains a u-matra | It contains the i-matra `ी`. Fixed the test — the matra/nukta coverage is exactly the Devanagari-class bug class that P1 already lost once |

### Still open (P3)

* **A GPU run at Stage A scale is still ahead of us.** The gates pass on CPU
  at smoke scale; nothing here speaks for config A on a T4, and a Kaggle
  account and quota are the owner's to provide.
* **The parameter count is now two derivations, not one.** The analytic count
  remains test-pinned, and the materialised cross-check runs whenever torch is
  present — both read 1,820,352 for the smoke config, over the same 39
  state-dict keys.
* **The seed corpus is synthetic.** Hindi fertility at 1k overstates the
  problem for a real 16k vocab; no quality claim may rest on it.
* **Vocab size is not frozen.** §7.2's 12–16k is decided in P4 from the
  fertility table on the licensed corpus.

### Evidence
`ai/tokenizer/` (`spec.py`, `train.py`, `fertility.py`, `samples.json`,
`artifacts/seed-1k/`) · `ai/model/` (`config.py`, `plan.py`, `model.py`) ·
`ai/data/` (`pipeline.py`, `dataset.py`, `langid.py`, `facts.py`) ·
`ai/language/lexicons.json` · `ai/knowledge/placeholders.mjs` ·
`inference/count_parameters.py` · `training/scripts/` (`make_seed_corpus.py`,
`prepare_data.py`, `checkpoint.py`, `train_smoke.py`) · `tests/py/` (12 test
modules, 219 tests) · `tests/placeholders.test.mjs` · `tests/lexicons.test.mjs` ·
`tests/langid-fixture.test.mjs` · `tests/fixtures/` · `docs/AI_ARCHITECTURE.md` ·
`docs/TRAINING.md` · `docs/DATA_LICENSES.md` · `docs/BENCHMARKS.md` ·
`npm run test:all` · `npm run params` · `npm run smoke`

---

## Production build — dev/prod split + §17 closure

**Gate (from P2's open list):** the withheld phone number must not leave the
repository in anything a visitor downloads.

`npm run build` → `dist/` (26 files, **354,105 B**), `npm run preview` serves
it on `:5580`. Two properties, both tested:

* `knowledge.json` ships as `publicView()` plus `meta.withheld_facts` — **ids
  and aliases only, never a value**. The metadata is what keeps the *specific*
  decline: without it, stripping the fact would have quietly downgraded a
  correct refusal ("that contact detail isn't published — the best way to
  reach Aashish is by email") into a vague abstention. Verified in three
  languages against the full knowledge base: byte-identical answers.
* **The build fails if a withheld value appears anywhere in the bundle**, so a
  new file that starts publishing the number is a refusal, not a discovery.
* The bundle also carries no training-side code. The allow-list is per-path:
  an earlier version shipped all of `ai/` (including the tokenizer artifact,
  whose metadata embeds corpus paths) and all of `knowledge/` (including
  `PII_REVIEW.md`). The leak scan is what caught it.

Measured: bundle 26 files / 354,105 B · `knowledge.json` 24,326 B · the
withheld number appears in **no** shipped file, and the two files that
publish it deliberately (`index.html`, `js/terminal.js`) are allow-listed
entries with a reason, reported as notes on every build.

Re-measured since, with the same verdict and the same 24,326 B
`knowledge.json`: **27 files / 391,619 B** after the §15.3 lifecycle fix
(387,696 B after §10/§12). The figures above are left as the numbers that were
measured for their own phase.

### Bugs found

| # | Bug | Consequence |
|---|---|---|
| **BLD-1** | The allow-list shipped all of `ai/` and all of `knowledge/` | The tokenizer artifact (with corpus paths) and the PII review document would have been downloadable. Caught by the leak scan on the first run |
| **BLD-2** | The dev-reference check used a line heuristic, so the second line of a block comment looked like code | False failures; replaced with a real comment/string masker that preserves line numbers
| **BLD-3** | Stripping the private fact removed the *evidence* the runtime uses to answer a phone question | The refusal would have degraded to a generic abstention in production only — the kind of difference no dev-mode test sees |

### Evidence
`tools/build.mjs` · `tools/preview.mjs` · `ai/knowledge/view.mjs`
(`withheldFacts`) · `dev-server.mjs` (`ROOT`/`PORT`) · `package.json`
(`build`/`preview`) · `tests/build-bundle.test.mjs` (13 tests) · `npm run build`

---

## Phase 4 — preparation (code ready, run blocked on decisions)

P4's gate is *"val curve, samples, checkpoints, resume verified"* — it needs a
GPU and a corpus, so what can be done ahead of it is the part that would
otherwise be written under time pressure on Kaggle. Done here:

* **A licence gate that is code.** `data/sources.json` + `fetch_corpus.py`:
  a source cannot be downloaded until a named person records the SPDX id, the
  URL they read and the date. No `--force`, and `tests/py/test_fetch_corpus.py`
  asserts nothing third-party is enabled. **9 of 9 sources are blocked today,
  which is the honest state of P4's first step.**
* **The English slot is now five named corpora, not one slot.** "Curated simple
  English + dialogue" was unfetchable *and uncheckable* — researching the terms
  of an unnamed corpus is not research. Splitting it immediately produced a
  second NonCommercial loss: **DailyDialog**, the first thing anyone names for
  "simple English dialogue," is `CC-BY-NC-SA-4.0`. TinyStories
  (`CDLA-Sharing-1.0`) and both Wikipedia dumps survive; Topical-Chat is
  promising at medium confidence; PersonaChat is left *inconclusive* rather than
  resolved by picking the more convenient of two contradicting sources.
* **Rule 1 stopped being a sentence.** "No third-party LLM-generated dataset
  without recorded provenance" had nothing to apply to until a synthetic corpus
  was registered, so nothing enforced it. Every source now declares
  `provenance.origin`, `--verify` refuses one that does not, and a `synthetic`
  source is unfetchable without a `disclosure` — because a permissive licence
  does not make a generated corpus self-disclosing.
* **A verified licence can still be unusable.** The gate has four states, not
  three: `licence_class` is separate from `unverified`, because `NC`/
  `NoDerivatives` data cannot enter a model that ships to browsers as part of a
  professional portfolio, and no amount of re-reading the terms changes that.
  The exception is a named field (`allow_noncommercial`), never the deletion of
  a list entry, and matching is token-wise so `NCSA` is not read as `NC`.
  Recording an NC licence with `--verify` **writes the fact down and leaves the
  source disabled** — a fact and a permission are different acts.
* **The first licence check changed an answer.** Sangraha and Hindi Wikipedia
  are permissive (`CC-BY-4.0`, `CC-BY-SA-4.0`), but **L3Cube-HingCorpus is
  NonCommercial** (`CC-BY-NC-SA-4.0` per the repo's licence section; the LREC
  proceedings say `CC-BY-NC-4.0`) and is dropped. Research is recorded as
  `license.observed` with the page it came from and is deliberately *not*
  `verified`. The real cost: programmatic text cannot reproduce human
  code-mixing, so Stage A's Roman Hinglish is now thinner than planned — a
  limitation for the model card, not a reason to re-read the terms until they
  say something nicer. **This is what the check was for, and it found it before
  a Kaggle session rather than after one.**
* **Resumable, hashed downloads.** `.part` + `Range` continuation; a sha256
  mismatch **deletes** the result instead of leaving a corrupt shard that later
  looks real.
* **`train_stage_a.py`** — Stage A's hyperparameters over the *same* loop as the
  smoke test (`config A`, lr 3e-4, 200-step warmup, 16×1024×4 = 65K tokens/step,
  `--max-minutes` for Kaggle's time box). Deliberately not a second training
  loop: a second loop is how a verified resume stops describing the thing that
  actually trained.
* **`ai/data/extract.py`** — the step that did not exist. `fetch_corpus` writes
  `hiwiki-…xml.bz2`; `prepare_data` globs `data/raw/<id>/*.txt`; **nothing joined
  them**, so running the notebook as written would have reached `prepare_data`,
  found no text, and stopped. Both components were tested; the *seam* was never
  a component, so no test could have covered it. Now a streaming MediaWiki dump
  reader (`iterparse`, so 2 GB is not a 20 GB process) and a batch-by-batch
  parquet reader, writing one document per line to a shared `data/extracted/`
  because `prepare_data --raw` reads a single directory. It does **not** filter:
  its manifest records `filters_applied: []` and the pending §7.3 filters.
* **The tokenizer/shard mismatch is refused, not trained through.** The notebook
  sharded with `seed-1k` and then trained with the 12k tokenizer. Ids from a
  smaller vocabulary are all valid indices into a larger embedding, so every
  bounds check passed and the model would have learnt a mapping from one
  tokenizer's ids while inference encodes with another's — hours of GPU for an
  unusable checkpoint, with nothing downstream able to detect it. Shards now
  record `vocab_size` and `tokenizer_version`, and training compares them.
  `test_a_bounds_check_alone_could_not_have_caught_this` proves the guard is
  load-bearing rather than decorative.
* **The notebook is validated rather than hoped for.**
  `tests/py/test_notebook_refs.py` resolves every `python -m` / `python x.py` it
  invokes, requires each CLI to answer `--help`, checks every `--flag` against
  that CLI's parser, and checks that no cell uses `$VAR` before its assignment.
  It reads commented-out commands too, because those are the ones a human
  copy-pastes. This is how a bare `sys.argv` read in `ai.tokenizer.fertility`
  was found treating `--help` as a directory name.
* **`training/notebooks/train_stage_a.ipynb`** — 29 cells
  (licence gate → **extract** → **prepare pass 1** → tokenizer → **prepare pass
  2** → params → smoke → budget → Stage A → persistence → export), with an
  explicit `nvidia-smi`/bf16 check because a T4 has no bf16 (§7.5). Two passes
  over the pipeline are safe because the split is a content hash, not a shuffle.
* **`estimate_budget.py`** — §7.3's token budget as arithmetic on a measurement:
  throughput × usable session, passes over the corpus, tokens/param against the
  ~20 reference, and whether the reference *fits the hours available*. At
  4,200 tokens/s the config A reference needs ~50 GPU hours (~5–6 free-tier
  sessions) — a planning number that only exists because it is computed.
* **Throughput is now measured, not assumed:** every smoke run records
  `tokens_per_second` in its metrics and manifest, which is what
  `--from-run` reads.

### Still blocked (not code)

1. **A signature, not a survey.** Nine sources, each with its terms looked up
   and recorded with evidence. What remains is `--verify` with the owner's name
   on the ones that passed (Sangraha, both Wikipedia dumps, **Topical-Chat** at
   medium confidence) and accepting the two losses. Every command is printed by
   `fetch_corpus.py --check`.
2. **A Kaggle account and quota** to run on — and P3's two unproven gates
   (*loss decreases*, *the loop resumes*) need a GPU before they can move from
   UNVERIFIED to verified.
3. **The 12–16k vocabulary** cannot be frozen until the corpus exists, because
   the ceiling is the corpus's distinct vocabulary, not its size.
4. **Whether this project is a commercial use** — the one fact that decides
   whether the L3Cube drop is permanent. It is asserted in
   `data/sources.json` (`allow_noncommercial: false`) rather than left implicit,
   so overturning it is a reviewable edit.

### Evidence
`data/sources.json` · `training/scripts/fetch_corpus.py` · `estimate_budget.py` ·
`train_stage_a.py` · `train_smoke.py` (`--config`, `build_parser`,
`tokens_per_second`) · `training/notebooks/train_stage_a.ipynb` ·
`tests/py/test_fetch_corpus.py` · `tests/py/test_estimate_budget.py` ·
`tests/py/test_train_scripts.py` · `docs/TRAINING.md` · `docs/DATA_LICENSES.md`

---

## P5 preparation — the retrieval gate, calibrated (§8.2/§8.4)

**Gate:** *"`MIN_TOP_SCORE` is still an unmeasured heuristic … P5 has the data to
calibrate it"* (P1's open list). It is now measured, and the measurement is an
instrument rather than a number.

### Done

* **`tools/calibrate-retrieval.mjs`** (`npm run calibrate`) — sweeps
  `MIN_TOP_SCORE` 0 → 15 in 0.05 steps and re-answers **every** executable case
  in `evaluation/portfolio_tests.json` at each step, plus **290 probes built
  from the knowledge base's own declarations** (every alias of every fact, each
  of which must retrieve that fact). Artefact: `docs/CALIBRATION.json`.
  The threshold is a **parameter** now (`search`, `resolveFocus`, `quickAnswer`
  all take `minScore`) — a threshold that cannot be swept can only be asserted.
* **The evaluation file cannot calibrate this gate, and that is measured:**
  only **7 of 56** executable cases change with the threshold, and **0 of 11**
  must-not-answer questions are refused *by the gate* — they are refused by an
  intent rule or by the withheld-facts list (the phone questions score 12.9 and
  11.2 and are still declined, which is only possible because the decline never
  asks the gate). The rest of the evidence came from the alias probes.
* **What the sweep pinned:** a **hard ceiling of 4.647** — the weakest alias a
  fact declares about itself ("who is he" → `person.name`) — and a floor that
  is **NOT MEASURED**, because nothing in the corpus is kept out by the gate.
  Every value in `(0, 4.647]` behaves identically, so the shipped `1.0` was left
  where it was rather than moved to a midpoint resting on a boundary of "our
  negatives all score zero".
* **The ceiling is enforced by a test, not by a comment.**
  `tests/retrieval.test.mjs` recomputes it from the data (the weakest
  unambiguous alias that routes to its own fact) on every run, so an edit that
  adds a weak alias — or a constant changed without re-running the sweep — fails
  the suite and names `npm run calibrate`. Mutation-tested: setting the constant
  to 5.0 fails 7 tests.

### Bugs found by measuring (each now has a regression test)

| # | Bug | Why it mattered |
|---|---|---|
| **CAL-1** | Retrieval inherited the **language detector's** tokenizer, which ignores digits on purpose. `tokenize('8.28')` is `[]`, so **every number in the knowledge base was invisible** — including the CGPA fact's own declared alias `"8.28"` | A recruiter asking "is it 8.28?" got *"I don't have that in my portfolio yet."* Asking by the fact's own declared spelling failed. Numbers are now content for retrieval (added on **both** sides, so the index and the query cannot diverge again — they were also being tokenized by two different expressions, which is the tokenizer/shard-mismatch class P4 already refuses to train through) |
| **CAL-2** | A **declared** alias made only of function words ("who is he", "kaun hai" on `person.name`) was dropped by the retrieval stop set on one side and matched nothing on the other. The answer layer had the same hole from the other direction: `[].some(...)` is silently `false`, so `factAnswer`'s "is this query about this fact?" test answered *no* for every glue-only alias the base declares | *"who is he"* → *"I don't have that in my portfolio yet."* — the most natural question a recruiter can ask, refused by a fact that declares it. Fixed by indexing an exact alias as **one phrase token** (declaration, not fuzz — so it cannot reproduce QA-3's drive/driven accident) and by treating a declared spelling as "about this fact" in the answer layer |

Alias routing went from **14 misrouted declarations to 0**. The remaining
reported ambiguities are deliberate: `"cgpa"` is claimed by two facts and the
base resolves that in **data** (R6), and glue-only aliases route through the
intent layer.

### Measured

| Claim | Result |
|---|---|
| Executable evaluation cases whose answer changes with the gate | **7 of 56** |
| Must-not-answer questions refused *by the gate* | **0 of 11** (the other mechanism is always first) |
| Hard ceiling, from the base's own declarations | **4.647** |
| Shipped value | **1.0** — inside every measured bound |
| Declared aliases probed / misrouted | 230 / **0** (was 14) |
| Tests | **258 JS + 219 Python**, 0 failures |

### Still open

* **The gate's lower bound is unmeasured on purpose.** It becomes measurable in
  P5, where crossing it means paying for an inference; a decision that costs
  something is a decision that can be calibrated.
* **No visitor traffic** — this is the question set we chose to be judged on,
  not a sample of real questions.
* **`"who is this"` still abstains**, because the base does not declare it.
  That is a knowledge-base question, not a threshold one, and it is left
  visible rather than patched with a guess.

### Evidence
`tools/calibrate-retrieval.mjs` · `npm run calibrate` · `docs/CALIBRATION.json` ·
`ai/retrieval/index.mjs` (`rawTokens`, `phrase`, `minScore`) ·
`ai/answers/quick.mjs` (`minScore`, declared-spelling check) ·
`tests/retrieval.test.mjs` (24) · `docs/BENCHMARKS.md`

---

## Resource budget + lifecycle (§15.3)

**Gate:** the four states measured (panel closed · chat idle · after answers ·
hands-free), 5 open/close cycles with no memory growth, and §4's long-task
budget decided by measurement rather than attribution-by-vibes.

**Verdict: 9/9 checks pass**, on R1 in **software GL** — the only renderer
available here. Raw output `docs/RESOURCES.json`, panel-closed control
`docs/RESOURCES-CONTROL.json`, `npm run probe:resources`.

### Done

* **`dev-resource-probe.js`** — the §15.3 instrument. CDP
  `Performance.getMetrics` for heap/nodes/listeners (after a forced GC),
  `Target.getTargets` for worker lifecycle, the app's **own** GSAP ticker for
  frame deltas, `longtask` observation with per-task attribution, and
  `PROFILE=1` for a CPU profile whose self time is reported **inside each long
  task**, not merely for the window.
* **Two bugs fixed, both invisible to unit tests.**

  | # | Bug | Measured cost |
  |---|---|---|
  | **RSRC-1** | `close()` reset `state` to `'closed'` while `open()` used `state === 'ready'` as its "already open" test, so **every reopen rebuilt the panel and orphaned the previous one in the DOM** | **+87 nodes and +16 listeners per reopen**; now **0 and 0** over 5 cycles |
  | **RSRC-2** | The §6.3 ladder was armed for the panel's **whole lifetime**, so it degraded the scene ~4.5 s after open with the assistant doing nothing — and rung 3 changes the render path, which makes three.js **recompile every material's program** | **21 programs relinked, 1,221 ms of blocked main thread** (profile: 1,105 ms inside `getProgramInfoLog`); after the gate, **0 programs, 0 ms** |

* **The ladder is now armed around the work it exists to protect**
  (`whileWorking`), not around the panel being open, and going idle hands the
  scene back exactly once. `setActive` is pure and host-free, so
  `tests/governor.test.mjs` pins both directions — mutation-tested by deleting
  the guard, which fails 7 tests. The disarm is promise-aware on purpose: when
  P5 makes `answer()` async, a `finally` would disarm the moment the promise
  was *returned* rather than when it settled — i.e. exactly while the model was
  generating.
* **§4's long-task verdict now measures the AI's contribution.** The page on
  its own produces 87–91 ms tasks under software GL (control, panel never
  opened), so a bare "over 50 ms" rule blamed the AI for the renderer —
  which is precisely how a 1.2 s task hid behind an 89 ms one.

### Measured

| Claim | Result |
|---|---|
| Heap growth per reopen | **0 MB/cycle** over 5 cycles |
| DOM nodes / listeners leaked per reopen | **0 / 0** (1,616 → 1,616 · 138 → 138) |
| Transcript cost per answer | 13.4 nodes (bounded; it is history, not a leak) |
| Workers outliving a close | 0 → 0 |
| Extra AI heap vs the 300 MB desktop budget | **0.8 MB** |
| GL programs compiled during an AI session | **31 → 31** (was 31 → 52) |
| Worst long task in AI windows | **0 ms** vs an 87 ms page-only baseline (was 1,221 ms) |
| First open | import + build **221–405 ms**, load **285–722 ms** |

### Still open

* **The 10-minute Proactive soak has not been run.** The probe supports it
  (`SOAK_MS=600000`); no soak number is claimed without it. It would currently
  measure an idle panel, because there is no microphone in this build.
* **No real GPU and no phone.** The 1.2 s relink is expected to be far smaller
  where shader compilation is not software — that is an expectation, and it is
  labelled as one.
* **One unexplained observation:** on the pre-fix path, two runs failed to
  return a CDP call within the 240 s protocol timeout at the first open. Not
  reproduced after the gate, not explained, recorded rather than smoothed over.

### Evidence
`dev-resource-probe.js` · `npm run probe:resources` · `docs/RESOURCES.json` ·
`docs/RESOURCES-CONTROL.json` · `ai/governor/index.mjs` (`setActive`) ·
`ai/ui/chat.mjs` (`whileWorking`, `built`, `loadOutcome`) ·
`tests/governor.test.mjs` (15) · `docs/BENCHMARKS.md`

---

## Voice, and a page that follows the answer (§10/§12)

**Gate:** the assistant speaks as Aashish ("my CGPA", not "his CGPA"); when
an answer comes from somewhere on the page, the page moves to that place —
and keeps working after the page is edited.

### Done

* **The answers are written in Aashish's voice (§10).** `persona: 'first'` is
the default in `quickAnswer`; `'third'` is one option away and the evaluation
set still runs against it. Both phrasings sit next to each other at every
template, in all three languages, via a `pick(persona, third, first)` helper —
not a regex pass over the finished text, which would have produced wrong
grammar the first time a template changed shape and would have been invisible
in review.

  Two deliberate exceptions, both with a test:
  * the **identity question** ("who are you", "are you Aashish?") discloses
    that a portfolio assistant is answering in his voice. Answering "yes, I'm
    Aashish" would be a lie about a person, and `tests/intent.test.mjs` already
    refused that claim for the injection reply;
  * the **injection reply** stays the neutral safety string for the same reason.

  The refusal follows the voice too: an abstention asserts nothing, so a page
  that speaks as Aashish must not switch to third person exactly when it has
  nothing to say. `ABSTAIN_FIRST` / `abstainFor` are the one place that lives.
* **The intent rules learned the second person.** A visitor following the
  voice asks "how do **you** build things", "list **your** projects" —
  phrasings the Latin-only patterns did not cover, so they fell to
  `project_detail` (one project) instead of the list. Six alternatives added,
  and the chips are tested to still route, because a chip that abstains is a
  dead click.
* **`ai/ui/anchors.mjs` — the section an answer came from, resolved by
  content.** It stores no offset, no index and no section id. Every answer
  resolves fresh against the live DOM:

  | Signal | Why it survives an edit |
  |---|---|
  | `data-ai-topics` on a section | the declaration travels with the markup |
  | the fact's own words (name, codename, aliases) found in an element | the section carries its content with it |
  | specificity (deeper beats shallower; `<main>` and `<body>` never qualify) | stops "the whole page contains the word" from winning |

  A miss returns `null`, so the page does not move. Scoring counts **facts
  covered**, not words matched — otherwise one project card outranked the
  section holding two of the three projects the question was about.
* **§12 — the navigation is never spoken about, and the typed chat stays
  plain.** No "moving to the projects section", no "I couldn't find that":
  a miss is silence. The page moves only in hands-free mode; auto-scrolling the
  page out from under somebody who is mid-sentence is hostile, and the voice
  layer is what needs the page to follow. `setHandsFree(true)` is the whole
  switch — voice work will not need to touch the panel again.
* **`dev-anchor-probe.js` — verifies the claim by editing the page first.**
  It opens the real portfolio, records where seven questions resolve, then
  **renames a whole scene, moves it, strips its declarations** and moves a
  project into a scene of its own — and asks again. 20/20 checks, including
  `hands-free mode moved the page by itself  scrollY 0 → 5059`.

### Measured

| Claim | Result |
|---|---|
| Every question resolves to a real section, as shipped | 7/7 — `scene-work` for projects, `scene-end` for contact, `scene-story` for CGPA and certificates, `scene-credits` for skills |
| Still true after renaming and moving a scene, and moving a project | 7/7, and the moved project resolved to its **new** section |
| Hands-free scroll actually moves the page | `scrollY 0 → 5059` |
| Cost per resolution | **14.6–29 ms**, inside §4's 50 ms task budget (a bounded walk of ≤800 elements, no layout read) |
| Tests | **254 JS + 219 Python**, 0 failures |

### Bugs found (each one would have shipped)

1. **A chunked prefill attended to its own future.** `generate()` decodes one
token at a time, so nothing in P3 fired it — but `is_causal` is aligned
top-left by PyTorch, so for t>1 new tokens over a longer cache it masks the
wrong pairs, and query row 0 sees the chunk's own future which every later
layer inherits. No bounds check can see this: every index is legal. Now an
explicit bottom-right mask, with `test_chunked_prefill_matches_a_full_forward`
asserting **every** position (measured divergence with the old code: 1.78e-01
at the logits), across a parametrised split set (4+4, 2+3+3, 1×6).
2. **The assistant found its own panel.** "Show me where the grocery project
is" resolved to the `SHOW ME · Smart Grocery List Generator` button, because
the chat repeats the answer text and the walk saw it. `data-ai-ignore` is now
an explicit opt-out on the panel subtree — measured, not imagined.
3. **One project card outranked the section holding two.** Counting matched
*words* let a single card's repeated hits tie with a section covering more of
the question. Scoring counts facts covered, and a test pins it.
4. **A bare `<span>` beat the card the name belonged to**, because depth was
the only signal. Inline tags with no id now pay a small penalty: a heading or
an article is a place to stand, a fragment is not.
5. **The build's code/comment masker could be fooled by a regex literal.**
A character class containing an apostrophe opened a phantom "string", so
every comment after it was classified as code — the check then *failed a file
that was correct*. Fixed by consuming regex literals as code, which also
closes the dangerous direction (a real dependency mis-read as a comment and
reported as harmless). Two tests: the exact construct, and one asserting that
a dev import after a regex-containing line is still a **failure**.

### Still open

* ~~**Voice input is not built.**~~ **CLOSED — see the §11 voice section at the
  end of this file.** It was true when written: the mode flag was all that
  existed. Section-following still does not depend on it, which is why it
  landed first and why a typed question in hands-free mode moves the page the
  same way a spoken one does.
* **The anchor is per-page, not per-viewport.** It chooses a section and
  flashes the element inside it; where the film's pinned scroll puts that
  scene on screen is still the director's business, so the probe measures the
  resulting `scrollY` instead of assuming a position.
* **Two sections can both be right.** On a page that names the same project in
  its card *and* in its build ledger, both are true answers. The shipped page
  settles it with `data-ai-topics`; the probe removes that declaration
  deliberately, to show what content alone does (it lands on a section that
  still names 2 of 3). Worth knowing before adding a third mention.

### Evidence
`ai/ui/anchors.mjs` · `ai/ui/chat.mjs` (`handsFree`, `showAnchor`, no
narration) · `ai/ui/styles.mjs` · `ai/answers/quick.mjs` (`persona`, `pick`) ·
`ai/intent/rules.mjs` (`ABSTAIN_FIRST`, second-person patterns) ·
`ai/model/model.py` (chunked-prefill mask) · `tests/anchors.test.mjs` (18) ·
`tests/quick-answers.test.mjs` (QA-10, QA-11, the §12 narration guard) ·
`tests/py/test_model_torch.py` (15) · `tests/build-bundle.test.mjs` (masker) ·
`dev-anchor-probe.js` · `index.html` (`data-ai-topics`) · `npm run test:all`

---

## Voice input, and answers out loud (§11) — 2026-09-22

**Gate:** in Proactive mode the assistant hears the visitor, answers as
Aashish, and the page moves to the part the answer came from — and nothing at
all is listened to before the visitor asks for it.

**Verdict: built, adapter-first, and browser-verified on R1**
(`node dev-ai-probe.js`, 27/27). The **listening path itself is NOT TESTED**:
headless Chrome has `webkitSpeechRecognition` and no microphone, so what the
probe actually exercises is the refusal — which turned out to be worth
building for on its own.

### Done

* **`ai/voice/index.mjs`** — the whole decision surface: the tier policy, the
  wake phrase, the recognizer wrapper, the speaker, and the controller. All
  injected, so `tests/voice.test.mjs` (28) drives it with doubles and no
  browser.
* **The tier column is finally read.** `TIERS[].voice`
  (`none`/`tap`/`both`/`all`) has been declared since P2 and consumed by
  nothing. It now decides: **T0** typed only (which is also where a
  `saveData` visitor lands — and speech recognition sends audio over the
  network, so "off" there is the answer they asked for), **T1**
  push-to-talk, **T2** + answers spoken aloud, **T3** + continuous listening
  behind a wake phrase. A test recomputes the policy table *from* `TIERS`, and
  an unrecognised level **fails closed** rather than granting.
* **Nothing is opted in for you.** The engine object is not even constructed
  until the button is pressed, the audio-leaves-the-device disclosure is shown
  once before anything is listened to, and a refused permission is never
  asked for again — `not-allowed`/`audio-capture`/`service-not-allowed` stop
  the recognizer and abort it rather than riding the normal restart loop.
* **It is addressed, not eavesdropping.** In continuous mode a sentence with
  no wake phrase in it is dropped **in silence** — not answered, not
  announced, not logged (§12's rule applies to a transcript exactly as it
  applies to a scroll). `aashish`, `ask aashish`, `hey aashish`, `ok aashish`;
  the rest of the sentence is the visitor's own words, punctuation included,
  because it is meant to be their question and not a tidied version of it.
* **It speaks the answer, and only the answer.** `onAnswer` hands
  `res.text` to `speechSynthesis` — the badge and the source chips are
  furniture, not speech — and the voice is picked from the answer's own
  language (`hi` → `hi-IN`, Hinglish → `en-IN`), because a Hindi answer read
  by an English voice is a different bug with the same root cause as the
  others in this project.
* **Talking over it takes the turn back.** A partial transcript while the
  answer is being read stops the synthesis. No narration of any kind, checked
  over every string literal in the file by the same §12 guard the panel uses.
* **Three bugs found while building, each of which would have shipped:**

  | # | Bug | Consequence |
  |---|---|---|
  | # | Bug | Consequence | Caught by |
  |---|---|---|---|
  | **VOC-1** | `abort()` is not guaranteed to fire `onend`, but the wrapper cleared `listening` only in `onend` | after a refused microphone the wrapper still believed it was listening — the exact state the button reads | `tests/voice.test.mjs` |
  | **VOC-2** | A dead engine left `enabled` true, `hands-free` on and the §15.3 ladder **armed for a session that was over** | the button stayed lit over a microphone that could not work, and the scene stayed degraded. The failure now calls `disable()`, hands the scene back, and keeps the reason for the panel to say once — a button that silently goes back to off is not self-explanatory | `dev-ai-probe.js` |
  | **VOC-3** | `stripWake` also trimmed trailing punctuation, so *"what is your name?"* came back as *"what is your name"* — rewording the visitor while its own contract says it returns their sentence | a small lie in the one place a voice layer has to be verbatim | `tests/voice.test.mjs` (the table) |

  VOC-2 only exists in a browser: it is a state machine walking off the end
  of a failure the unit tests had no way to produce. The probe's most useful
  run so far is the one where it had **no microphone** — that is the failure a
  visitor with a blocked permission gets, and it is now measured rather than
  assumed.

* **Wiring, not a rewrite.** `close()` stops the microphone, so it cannot
  outlive the panel; enabling voice is what turns Proactive mode on, and
  disabling it restores whatever hands-free was before (a host that already
  wanted it keeps it). `whileWorking` became a **depth counter**, because
  listening and answering overlap and either one alone is a reason to hold
  the scene down.

### Measured (R1 · headless Chrome, software GL · `node dev-ai-probe.js`)

| Claim | Result |
|---|---|
| AI requests before the first click | **0** — including `ai/voice/index.mjs` |
| AI assets on first open | 12 files, no worker, no wasm |
| Tier on this machine | **T2 · STANDARD** → voice level `both` |
| Voice button before the tap | present, `aria-pressed=false`, engine **not constructed** |
| Tap, on a machine with no microphone | engine refused → voice **off**, `aria-pressed` back to `false`, `handsFree=false`, ladder released, and the reason stated: *"The microphone is not available, so voice mode is off. Typing works."* |
| After Escape (panel closed) | `enabled=false` — the microphone does not outlive the panel |
| Console / page errors | **0** |

### Still open

* **No live microphone anywhere in this build's verification.** The
  listening branch (`enabled`, finals flowing into `chat.ask`) is covered by
  unit tests against doubles, not by a real voice. That needs a human at a
  real browser, and it is on the manual checklist rather than claimed here.
* **Continuous mode is the least-verified path.** It is T3-only, it is built,
  and nobody has spoken to it. The wake phrase is tested as a function, not
  as an experience.
* **Chrome-only in practice.** The recognition engine ships as
  `webkitSpeechRecognition`; Firefox and Safari get the honest disabled
  button with the reason, which is the behaviour the probe verifies.
* **Hindi/Hinglish recognition is untested by ear.** The language hint is
  wired (`voiceHint`), the answers are native in all three, and the values are
  still English (`§ Phase 1`).
* **No voice cloning.** A cloned voice — his own — is a future feature and is
  not started: today it is the browser's voice, chosen by language.

### Evidence
`ai/voice/index.mjs` (`VOICE_POLICY`, `stripWake`, `createRecognizer`,
`createSpeaker`, `createVoice`, `SPEECH_DISCLOSURE`) ·
`ai/ui/chat.mjs` (`toggleVoice`, `voiceButton`, `setWorking`, `close`) ·
`ai/ui/styles.mjs` (`.ai__mic`) · `tests/voice.test.mjs` (28) ·
`tests/quick-answers.test.mjs` (§12 guard, now over both files) ·
`dev-ai-probe.js` (§11 phase) · `npm run test:all`