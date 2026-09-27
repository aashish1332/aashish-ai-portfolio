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
   `MAX_CHUNKS = 3`, `MAX_CONTEXT_TOKENS = 300` (4-chars-per-token approximation —
   **superseded**, see "The window" below: the measured ratio is 1.5), and a
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
| Frame-health A/B | **INCONCLUSIVE** — headless software GL runs the film at 0.6–1.8 fps, so the ratio proves nothing. Printed as inconclusive rather than as a pass; needs the §15 reference profile on real hardware. The ladder's **cost** is now measured instead (see *Resource budget + lifecycle (§15.3)*: rung 3 = a full shader recompile). **Superseded 2026-09-27**: the real GPU was reachable in headless Chrome, and with the film's tier pinned the A/B is **0 % median drift / 1.00× p95** |
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
| DOM nodes / listeners leaked per reopen | **0 / 0** (1,618 → 1,618 · 139 → 139) |
| Transcript cost per answer | 13.4 nodes (bounded; it is history, not a leak) |
| Workers outliving a close | 0 → 0 |
| Extra AI heap vs the 300 MB desktop budget | **0.2 MB** |
| GL programs compiled during an AI session | **31 → 31** (was 31 → 52) |
| Worst long task in AI windows | **69 ms** vs a 90 ms page-only baseline (was 1,221 ms) |
| First open | import + build **221–405 ms**, load **285–722 ms** |

### Still open

* ~~**The 10-minute Proactive soak has not been run.**~~ **CLOSED — run
  2026-09-22**, with the microphone ACTIVE rather than the idle panel this note
  predicted: **0 MB heap, 0 nodes, 0 listeners** over 600 s, 36 utterances
  delivered and **0** bubbles produced, and the §6.3 ladder never armed
  (30/30 checks, `docs/RESOURCES.json`). It measures the lifecycle around a
  **stub** engine, because headless Chrome's real one can only be observed
  refusing — see the *Voice* section under BENCHMARKS §11, which also records
  the rule this run corrected (listening must not arm the ladder).
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
  project into a scene of its own — and asks again. **34/34 checks**, including
  `hands-free mode moved the page by itself  scrollY 0 → 5059` and the phase
  below, which asks the stronger question: not "did the page move" but "is the
  visitor *looking at* the thing they asked about".

### Measured

| Claim | Result |
|---|---|
| Every question resolves to a real section, as shipped | 7/7 — `scene-work` for projects, `scene-end` for contact, `scene-story` for CGPA and certificates, `scene-credits` for skills |
| Still true after renaming and moving a scene, and moving a project | 7/7, and the moved project resolved to its **new** section |
| Hands-free scroll actually moves the page | `scrollY 0 → 5059` |
| **The anchored element is inside the viewport after the move, as shipped** | **7/7** — every answer resolves to a section (`top=0px`, `h=800px`, i.e. exactly one viewport) |
| …and after the page was edited | **6/7**. The seventh resolves correctly into `#scene-appendix`, a section **the film has no layout for** (its `<h3>` measures `0×0`): the fact is found, and there is nothing to show. Named as a layout consequence of the fixture, not counted as visible and not hidden either |
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
5. **This probe's own new phase broke the probe, and the failure was silent.**
   Exposing the anchored element on the shell's `lastAnchor` snapshot put a
   **DOM node** into the object that `page.evaluate` returns by value. A node
   makes the *whole* snapshot unserializable, and puppeteer hands back
   `undefined` rather than raising — so all seven anchors read as "NOTHING
   FOUND" and the run looked like a resolver catastrophe rather than a probe
   bug. Fixed by keeping the snapshot pure data and exposing the element as a
   **call** (`anchorElement()`), read inside the page. The probe's own
   resolution check is what caught it, which is the argument for keeping that
   check first in the file.
6. **The build's code/comment masker could be fooled by a regex literal.**
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
* ~~**The anchor is per-page, not per-viewport.**~~ **MEASURED — 2026-09-22,
  and closed for the shipped page.** It was true that the probe only checked
  the resulting `scrollY`, so "the page moved" stood in for "you can see it".
  The probe now measures the **live element's rectangle** against the
  viewport once the page has settled: **7/7 as shipped**, each one exactly one
  viewport tall and at `top=0`. On the deliberately broken fixture it is
  **6/7**, and the miss is honest rather than smoothed: the projects card that
  was moved into a brand-new section resolves correctly, but the film has no
  layout for a section it did not build, so the card measures `0×0` and there
  is nothing on screen to see. Resolution can be right about *where* a fact
  lives and the page can still be unable to *show* it — those are now two
  different, separately reported measurements.
* **The scroll settles slowly on this renderer, and the first instrument did
  not wait for it.** The move is a smooth Lenis scroll driven by rAF, a target
  can be 18,000 px away, and headless software GL runs the film well under
  1 fps — so a fixed 2.6 s wait measured "the scroll has not arrived yet" and
  reported it as "the visitor cannot see it". Two runs of unchanged code gave
  **7/7 and 4/7**. The probe now polls until the scroll position stops
  changing. A measured number that depends on the machine being fast is not a
  measurement.
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
(`node dev-ai-probe.js`, 26/26 — the probe prints its own tally, and both
voice branches carry the same number of checks so the count means something).
The **listening path itself is NOT TESTED**:
headless Chrome has `webkitSpeechRecognition` and no microphone, so what the
probe actually exercises is the refusal — which turned out to be worth
building for on its own.

### Done

* **`ai/voice/index.mjs`** — the whole decision surface: the tier policy, the
  wake phrase, the recognizer wrapper, the speaker, and the controller. All
  injected, so `tests/voice.test.mjs` (37) drives it with doubles and no
  browser.
* **The tier column is finally read.** `TIERS[].voice`
  (`none`/`tap`/`both`/`all`) has been declared since P2 and consumed by
  nothing. It now decides: **T0** typed only (which is also where a
  `saveData` visitor lands — and speech recognition sends audio over the
  network, so "off" there is the answer they asked for), **T1**
  press-to-talk in a window that closes itself, **T2** + answers spoken
  aloud, **T3** + continuous listening
  behind a wake phrase. A test recomputes the policy table *from* `TIERS`, and
  an unrecognised level **fails closed** rather than granting.
* **Nothing is opted in for you.** The engine object is not even constructed
  until the button is pressed, the audio-leaves-the-device disclosure is shown
  once with the click that starts the engine (and in the DOM before any
  transcript can be handled — see the ordering note in AI_ARCHITECTURE §11),
  and a refused permission is never
  asked for again — `not-allowed`/`audio-capture`/`service-not-allowed` stop
  the recognizer and abort it rather than riding the normal restart loop.
* **It is addressed, not eavesdropping.** In continuous mode a sentence with
  no wake phrase in it is dropped **in silence** — not answered, not
  announced, not logged (§12's rule applies to a transcript exactly as it
  applies to a scroll). `aashish`, `ask aashish`, `hey aashish`, `ok aashish`;
  the rest of the sentence is the visitor's own words, punctuation included,
  because it is meant to be their question and not a tidied version of it.
* **A turn has to be KEPT open, and that is the difference between a
  conversation and an open microphone.** The wake phrase opens a turn; a
  question that lands on the portfolio then buys the next one for
  `VOICE_TIMING.followUpMs` (**12 s**), so "…and your projects?" needs no name
  again. Silence past the window closes the turn and the wake phrase is
  required once more — because otherwise one "hey Aashish" would leave the
  assistant answering for the rest of the call, *including the half of the
  conversation that is with somebody else in the room*. An answer that made
  **no claim** (an abstention, or a bait request) ends the turn immediately:
  those words were not about the portfolio, so there is nothing to stay open
  for. The window is deliberately short, and the reason is written at the
  constant.
* **It speaks the answer, and only the answer.** `onAnswer` hands
  `res.text` to `speechSynthesis` — the badge and the source chips are
  furniture, not speech — and the voice is picked from the answer's own
  language (`hi` → `hi-IN`, Hinglish → `en-IN`), because a Hindi answer read
  by an English voice is a different bug with the same root cause as the
  others in this project.
* **Talking over it takes the turn back.** A partial transcript while the
  answer is being read stops the synthesis. No narration of any kind, checked
  over every string literal in the file by the same §12 guard the panel uses.
* **A press opens a window that CLOSES BY ITSELF.** This was the fifth bug and
the worst of them (VOC-5 below): "tap" had been implemented as a latch, so a
single press on VOICE left the engine restarting itself for as long as the
panel stayed open, and every word in the room was treated as a question —
**a hotter microphone than continuous mode**, which at least makes you say the
name. T1/T2 now open a **`tapWindowMs` = 20 s** window: the press IS the
address, so nothing else is needed to ask, and when the window lapses the
engine stops, the button goes dark and Proactive mode is given back. That is
also what makes the button honest — the panel's own CSS comment says a
permanently-lit microphone icon is a claim that something is being recorded,
and it was making that claim with the microphone on. The window is **not**
extended by asking: extending it is precisely how a press turns back into an
open microphone.
* **Five bugs found while building, each of which would have shipped:**

  | # | Bug | Consequence |
  |---|---|---|
  | # | Bug | Consequence | Caught by |
  |---|---|---|---|
  | **VOC-1** | `abort()` is not guaranteed to fire `onend`, but the wrapper cleared `listening` only in `onend` | after a refused microphone the wrapper still believed it was listening — the exact state the button reads | `tests/voice.test.mjs` |
  | **VOC-2** | A dead engine left `enabled` true and `hands-free` on — and, because listening armed the ladder in the first version, the scene degraded with it | the button stayed lit over a microphone that could not work. The failure now calls `disable()`, gives Proactive mode back, and keeps the reason for the panel to say once — a button that silently goes back to off is not self-explanatory. The ladder half is moot now: see the correction below, which the soak forced | `dev-ai-probe.js` |
  | **VOC-3** | `stripWake` also trimmed trailing punctuation, so *"what is your name?"* came back as *"what is your name"* — rewording the visitor while its own contract says it returns their sentence | a small lie in the one place a voice layer has to be verbatim | `tests/voice.test.mjs` (the table) |
  | **VOC-4** | The turn's window was extended *after* `ask()` returned — but `ask()` calls `onAnswer` **synchronously**, which is where an abstention closes the turn, so the extension undid the close every time | an unanswerable question would have left the microphone in a conversation it cannot take part in — the exact failure the window exists to prevent, defeated by statement order | `tests/voice.test.mjs` (the abstention case) |
  | **VOC-5** | "Tap" was a latch: `enable()` started the recognizer with no end, and in push mode every final was a question | **one press left the microphone open indefinitely and answered the room** — on phones and ordinary laptops, i.e. most visitors. Found by reading the mode back against its own name, then fixed and measured: the press now opens a 20 s window that closes itself, and the probe runs both modes on the same sentence to show they differ | reading `push` against its name; pinned by `tests/voice.test.mjs` (5 tests) and `dev-resource-probe.js` |   VOC-2 only exists in a browser: it is a state machine walking off the end
  of a failure the unit tests had no way to produce. The probe's most useful
  run so far is the one where it had **no microphone** — that is the failure a
  visitor with a blocked permission gets, and it is now measured rather than
  assumed.
* **Two defects in the probe itself, found by re-running it** (they cost the
  previous "27/27" its meaning, so they are recorded rather than quietly
  fixed). First, `voice: disclosure shown` **could not pass**: the check
  searched `textContent.slice(0, 120)` for *"leaves this device"*, and in the
  rendered bubble that phrase sits at character **151** of 221 (the badge is
  inside the bubble). Nobody noticed because on this host the *refusal* branch
  ran for the whole of §11, so the check never executed. Second, the two voice
  branches carried **different numbers of checks** (3 refused, 2 enabled), so
  "27/27" was not a stable statement. Both fixed: the whole bubble is searched
  with the snippet printed separately, both branches carry three checks, and
  the probe prints its own tally — **26/26** on either branch. The engine's
  behaviour here is also **not deterministic**: the same host refuses on one
  run and reports `listening` on the next, which is why the branch is reported
  in the output instead of assumed.

* **Wiring, not a rewrite.** `close()` stops the microphone, so it cannot
  outlive the panel; enabling voice is what turns Proactive mode on, and
  disabling it restores whatever hands-free was before (a host that already
  wanted it keeps it). `whileWorking` became a **depth counter**, because
  two overlapping generations would otherwise hand the scene back when the
  first finished. **Listening does not arm it** — see the correction below,
  which the §15.3 probe forced.

### Corrected while measuring (§15.3 soak)

**Listening does not arm the frame ladder.** The first version did — answering
and listening were treated as overlapping reasons to hold the scene down. A
600 s soak then reported the ladder `active` for the whole window with
`step=0`: a pass only because this renderer's frames are healthy. Every §6.3
rung acts on the model or the scene and none on speech, so arming for a listen
only holds the film down — and where the ladder fires it pays rung 3's measured
price (21 programs, 1221 ms) to protect a generation that is not running. That
is RSRC-2 one door along. Removed; the answer at the end of a listen arms it
through `ask()`, like any other. The `whileWorking` counter stays, because two
overlapping *generations* are a real case in P5.

### Measured (R1 · headless Chrome · `node dev-ai-probe.js` and `npm run probe:resources`)

| Claim | Result |
|---|---|
| AI requests before the first click | **0** — including `ai/voice/index.mjs` |
| AI assets on first open | 12 files, no worker, no wasm |
| Tier on this machine | **T2 · STANDARD** → voice level `both` |
| Voice button before the tap | present, `aria-pressed=false`, engine **not constructed** |
| Tap, on a machine with no microphone | engine refused → voice **off**, `aria-pressed` back to `false`, `handsFree=false`, and the reason stated: *"The microphone is not available, so voice mode is off. Typing works."* |
| After Escape (panel closed) | `enabled=false` — the microphone does not outlive the panel |
| Console / page errors | **0** |
| Continuous mode, driven in a browser (`dev-resource-probe.js`) | level `all`, mode `continuous`: unaddressed speech asked **0** questions, the wake phrase asked **1** and opened the turn, a bare follow-up asked **2**, and after 12 s of silence the turn was **closed** and the next unaddressed sentence asked nothing |
| Tap-to-talk, the same probe, the same sentence | mode `push`, a 20 s window, button lit: the press **is** the address, so that sentence **was** answered (**1** question). After the window: `enabled=false`, `listening=false`, button dark, and the next sentence asked **nothing** |
| A question through the engine | reached the same answer path and the same anchor a typed one does (anchor `scene-story`) |
| 10-minute Proactive soak, **continuous** mode | 0 nodes · 0 listeners · heap flat 0 MB, **36** utterances heard, **0** answered |

### Still open

* **The 10-minute soak now exists, with a stub engine.** It is in `§15.3` /
  BENCHMARKS §11: 0 MB / 0 nodes / 0 listeners over 600 s of an active
  microphone. What it cannot cover is Chrome's own recognizer, which refuses in
  this environment — so the lifecycle is measured and the *hearing* is not.
* **No live microphone anywhere in this build's verification.** The
  listening branch (`enabled`, finals flowing into `chat.ask`) is covered by
  unit tests against doubles, not by a real voice. That needs a human at a
  real browser, and it is on the manual checklist rather than claimed here.
* **Continuous mode has now been driven in a browser, but not by a person.**
  It is T3-only, so the probe moves the tier (§6.2: the starting tier is a
  starting point), installs a stub engine and drives the whole turn lifecycle:
  ignored → woken → follow-up → expired. That is the *behaviour* verified; the
  *experience* — a human saying "hey Aashish" into a laptop and being answered —
  has not happened yet, and neither has an accent or a noisy room.
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
`ai/ui/styles.mjs` (`.ai__mic`) · `tests/voice.test.mjs` (37) ·
`tests/quick-answers.test.mjs` (§12 guard, now over both files) ·
`dev-ai-probe.js` (§11 phase) · `npm run test:all`
---

## Faithfulness Guard, and the Stage B data (§8.4 layer 4 / §7.4) — 2026-09-23

**Gate:** the two anti-hallucination layers that are not training are built,
tested and *able to fail*. Everything else in the plan is either voice work
(needs a human at a microphone) or training (needs a GPU), so this is the
unblocked correctness work.

### Done

1. **`ai/guard/index.mjs` — §8.4 layer 4.** One generated answer in, every
   ungrounded claim out: URLs, emails, numbers, years, months, named entities
   from the knowledge base's own vocabulary, language mismatch, unresolved
   placeholders, and the length cap. No embeddings, no fuzzy matching, no
   rewriting — grounding is normalization plus containment, so the failure
   direction is always "reject an ungrounded claim", never "accept a
   near-miss".
2. **`guardedAnswer()` — §5.1 step 5, dependency-injected.** generate →
   guard → **one greedy retry over a shorter context** → the extractive Quick
   Answer fallback → else `guardFailed:true` so the caller abstains rather
   than ships a bad answer. Generation is a parameter, so the whole ladder is
   driven with doubles and no inference.
3. **`ai/data/instruction.py` + `training/scripts/make_instruction_data.py` —
   §7.4 Stage B data.** 40,000 examples from `knowledge.json` in the §7.4
   format, at the exact §7.4 mix, including **counterfactual contexts** for
   35% of examples (floor 30%) and abstention examples that must emit
   `<|abstain|>`.
4. **`tests/guard.test.mjs` (32) + `tests/py/test_instruction.py` (25)** —
   both halves of each component's contract: that it *rejects* the
   ungrounded, and that it *accepts* the grounded near-misses that keep it
   usable.
5. `ai/guard` added to the build allow-list; `data/instruction/sft.jsonl` is a
   git-ignored build output while the manifest and the review sample are
   committed.

### Bugs found by the tests, each of which would have shipped

| # | Bug | Consequence |
|---|---|---|
| **GUARD-1** | the §8.4 allowlist was the caller's only — `defaultAllowlist` was never applied inside `guard()` | every answer that names Aashish was flagged as a fabricated entity unless the caller remembered to pass his name. Found by the allowlist test; `guard()` now merges the default list itself |
| **CF-1** | a "counterfactual" example could be built on a topic with **no fabricated value in it** — a contact-email question with a real email in the context | it would have counted in the 35% while teaching nothing, i.e. the requirement "met" and ignored. Topics for counterfactual examples are now restricted to the ones that carry a swapped value, and a test compares the context against the real rendering |
| **CF-2** | fabricated values were drawn per id with `rng.choice`, so two skills could both become "Django" | the review sample showed *"Rust, Django aur Rust"* — reading like a model bug rather than a swapped context, which defeats the sample's whole purpose. Referenced ids now get distinct replacements |
| **CF-3** | the skills answer joined names with an English "and" inside Hindi and Hinglish sentences | a small wrongness a reviewer hears immediately; the conjunction is localized |
| **CF-4** | the review sample's language column was the example's **first** turn's language | a two-turn example that starts in Hindi and ends in English was labelled `hi` while showing an English answer. The column is now the detected language of the answer shown |
| **CF-5** | `relative_to(REPO_ROOT)` raised when `--out` pointed outside the repo | the CLI crashed after writing every file, so a test (or a scratch run) looked like a failure. The display path now falls back to the absolute one |

### Measured

| Claim | Result |
|---|---|
| JS tests | **327** (was 295; +32 guard) |
| Python tests | **244** (was 219; +25 instruction) |
| Stage B examples, one run | **40,000** in ~11 s, 24,707,841 characters, **7,262,881 tokens ESTIMATED** (chars/3.4) |
| §7.4 mix, as generated | factual 14,000 · multi_turn 6,000 · abstention 6,000 · language_switch 4,000 · recruiter 4,000 · greeting 2,000 · adversarial 2,000 · other 2,000 |
| Counterfactual share | **0.35** (floor 0.30), and every counterfactual context verified to differ from the real one |
| Languages | en 24,757 · hinglish 9,770 · hi 5,473 |
| Personas | first 20,054 · third 19,946 |
| Withheld value in the training text | **0 occurrences** of any `public:false` id |
| Build | 29 files / **448,578 B**, leak scan clean |

### Still open

* **The guard has never seen a model output.** It is tested against fixtures,
  which is the only honest option before a checkpoint exists — but the
  §14 metric it feeds (*unsupported-claim rate post-guard ≤ 1%*) is
  **NOT TESTED**, and the false-acceptment rate on a real 38M model is
  unknown. The module is written so that number is measurable the day P5
  produces an output to measure.
* **Two known blind spots, recorded not papered over:** a number written in
  words ("five years") is not caught (the placeholder rule is what makes that
  rare), and a technology named in a spelling the base does not record is not
  a vocabulary hit.
* **The Stage B data is unvalidated by a model.** Nothing here has trained;
  the mix and the counterfactual share are properties of the *data*, and the
  review sample exists precisely because a human has to judge naturalness —
  it is written and waiting, and the Hindi/Hinglish in it is mine to be told
  is wrong.

### Evidence
`ai/guard/index.mjs` · `tests/guard.test.mjs` (32) · `ai/data/instruction.py` ·
`training/scripts/make_instruction_data.py` · `tests/py/test_instruction.py`
(25) · `data/instruction/manifest.json` · `evaluation/review_sample.md` ·
`tools/build.mjs` · `npm run test:all`

---

## CPU inference first, and the missing §17 docs — 2026-09-23

**Gate:** §14's "Python CPU inference first" exists and has been *run*, on all
three configs, with the numbers written down; and §17's documentation set is
complete.

### Done

1. **`inference/benchmark/benchmark_cpu.py` (§14)** — load time, process RSS,
   prefill tok/s, decode tok/s, generation time, and file sizes **written**
   rather than computed (`state_dict` to a temp file, fp32 and fp16).
   `--json` writes `docs/CPU_BENCHMARK.json`.
2. **`npm run bench:cpu`** and **`npm run sft`** added to `package.json`.
3. **`tests/py/test_benchmark_cpu.py` (8)** — the harness's own contract: the
   rates equal tokens ÷ seconds, a missing baseline is `None` (not a negative
   delta), the weights are labelled random, and fp16 is ~half of fp32.
4. **`docs/PRIVACY.md`** — what leaves the device, stated per path, with the
   one honest exception (speech recognition is the browser's service) quoted
   from the disclosure the panel actually shows.
5. **`docs/DEPLOYMENT.md`** — the static-host requirements, build/preview,
   the dev/prod split, exactly what ships, and the deploy-time checklist.
   The host choice is left as an **open owner decision**, not invented.
6. **`docs/MANUAL_TEST_CHECKLIST.md`** — the ~10-minute routine for a real
   phone, a real microphone and a real screen reader: the three things no
   test in this repo can do.
7. **§14's bundle-size budget check** — `tests/build-bundle.test.mjs` now
   asserts the AI chat chunk is inside §4's 150 KB gz budget and that the
   whole bundle stays under a 250 KB regression guard. It runs on `npm test`,
   which is where a CI pipeline would have put it.

### Measured

| Claim | Result |
|---|---|
| Config A, CPU decode | **28.0 tok/s** (R1, torch 2.14.0+cpu, 4 threads) — 3.5× §4's ≥ 8 tok/s floor |
| Config A, CPU prefill | 128 tokens in 292 ms (440 tok/s) |
| Config A state_dict | fp32 144.6 MB · fp16 88.3 MB, **written not computed** |
| AI chat chunk, gzip | **79,555 B** of a 153,600 B (§4) budget |
| Whole bundle, gzip | 144,259 B of a 256,000 B regression guard |
| Tests | **328 JS + 252 Python** (was 327 + 244; +1 budget check, +8 benchmark) |

### Still open

* **The weights are random.** Every speed number above is the architecture's,
  and the JSON says so in a field — no trained-model speed exists yet.
* **Browser wasm speed is P7** and is a different implementation of the same
  arithmetic; these Python numbers do not transfer, and are not quoted as if
  they do.
* **§14's "worker-terminate frees memory" and "offline-after-cache" tests are
  not written because there is no worker and no model download to test** —
  both arrive with P6/P7. Listed here rather than silently skipped.
* **No CI provider**, so the budget check runs on `npm test`; wiring it into a
  pipeline is a five-minute job once a host exists (`DEPLOYMENT.md` §6).
* **The manual checklist has not been run.** Every item in it is NOT TESTED,
  which is the reason the file exists.

### Evidence
`inference/benchmark/benchmark_cpu.py` · `npm run bench:cpu` ·
`docs/CPU_BENCHMARK.json` · `tests/py/test_benchmark_cpu.py` · `docs/PRIVACY.md` ·
`docs/DEPLOYMENT.md` · `docs/MANUAL_TEST_CHECKLIST.md` ·
`tests/build-bundle.test.mjs` (16) · `package.json` · `npm run test:all`

---

## P6 engine on a real checkpoint, and everything that had to be true first — 2026-09-25

**Gate:** §9.2's parity test passes **on the shipping export** — not on a
fixture — and `npm run build` produces a bundle that clears §4's budgets with
the model in it.

This entry covers the whole stretch from "CPU inference measured" to that
gate, including the pieces that had no entry of their own: the JS tokenizer
port, the worker/session boundary, the model answer path, the proactive VAD,
the voice eval kit, and the export pipeline.

### Done

1. **`local` training run, for real.** `npm run train:local` — the largest
   §7.1-shaped model this laptop trains: `vocab=1,024 d=256 L=6 heads=8/4
   ffn=768 ctx=512 tied`, **4,984,064 params**, 1,100 steps at block 256.
   `training/checkpoints/local/` holds `best/latest/step_600/700/800`.
2. **JS byte-level BPE port** (`ai/engine/bpe.mjs`, moved from
   `ai/tokenizer/bpe.mjs`) — the encoder that runs in the visitor's worker,
   checked id-for-id against the Python one on the committed fixture
   (`tests/tokenizer-parity.test.mjs`, `inference/encode_fixture.py`).
3. **The engine** — `quant.mjs` (per-row int8 kernels), `llama.mjs` (the
   graph, KV cache, explicit positions), `manifest.mjs` (shards + sha256),
   `prompt.mjs` (+ `prompt_contract.json` generated from the Python prompt
   code), `index.mjs` (`ScratchLlamaEngine`, the `LLMEngine` seam).
4. **The worker boundary** — `worker.mjs` + `session.mjs`
   (`prepare|generate|abort|dispose`; `progress|token|ready|done|error`).
   Nothing loads before `prepare()`, so N6 holds by construction; `dispose()`
   is the only path that hands memory back.
5. **The model answer path** — `ai/answers/model.mjs`, in §5.1's order:
   retrieve → abstain below the gate *without* a model call → generate →
   `guardedAnswer` (§8.4 layer 4) with one greedy retry on shortened context
   → extractive fallback → `resolveFacts`/`renderFact` for `<|fact:x|>`.
   `ai/ui/chat.mjs` was wired to it (badges, progress, Stop, Retry).
6. **The export pipeline** — `inference/export_browser.py` (checkpoint →
   quantised shards + manifest + parity fixture; `--random-init` for the
   committed fixture), `inference/reference.py` (the numpy reference),
   `tools/verify-engine.mjs` (`npm run verify:engine`), and
   `inference/export_prompt_contract.py`.
7. **Proactive voice** — `ai/voice/vad.mjs` (energy VAD, adaptive floor,
   hysteresis, max segment, post-cut cooldown) so an always-open microphone
   only wakes the recognizer on speech; visibility handling stops listening
   and speaking when the tab is hidden and resumes into the gate.
8. **The §11.2 voice eval kit** — `evaluation/voice/record.html`,
   `evaluation/voice/score.py` (corpus WER per language, worst clips, and the
   three bands `<20% ship · 20–35% disclose · >35% English-only`) and
   `evaluation/voice/phrases.json` (30 phrases, en/hi/hn).
9. **§14's synthetic-portfolio swap** — `tests/synthetic.test.mjs` (8).
10. **The two failure modes below, each found by the gate that exists to find
    it, each now pinned by a test.**

### Bugs found while measuring (each one would have shipped)

**1. The parity gate was comparing two different models.**
`reference_fixture()` built its numpy reference from the **float** checkpoint
while the engine runs the **int8** shards, so the only thing the gate could
measure was how much quantisation moved the logits — and it failed, loudly,
on the real export:

| | argmax | worst \|Δlogit\| | verdict |
|---|---|---|---|
| before (float reference vs int8 engine) | 98.6 % | **1.63e-01** | FAIL |
| after (both read the same int8 codes) | **100 %** | **8.82e-06** | PASS |

The module's own docstring already claimed the reference ran on the exported
weights; the code did not. `tests/py/test_export_browser.py` EX-20 now
round-trips the shard bytes and refuses a shard whose hash disagrees.

**2. The shipped manifest embedded a dev path, and the build caught it.**
`source.runDir = "training/checkpoints/local"` tripped `DEV_ONLY_PATTERNS`, so
`npm run build` refused — correctly. Provenance in a *public* manifest is now
content, not a location: run name, `which`, step, ISO timestamp, git commit
and the checkpoint's **SHA-256**. A path can be re-pointed at different
weights; a hash cannot. (`tests/py/test_export_browser.py` EX-21 asserts no
provenance value contains a separator, so no value can name a tree.)

**3. The parity fixture was being served to visitors.**
`--reference-out` defaulted into the directory `tools/build.mjs` copies
wholesale, so **257,452 B** of `reference.json` — a test artifact of logits —
shipped in `dist/`. The bundle is now an **allow-list** (`manifest.json`,
`tokenizer.json`, `model-\d{5}.bin`) and reports anything else it skipped;
the fixture is written to `ai/model-export/reference/` instead, beside the
version directory rather than inside it. Bundle: 45 files / 5,960,763 B →
**44 files / 5,703,311 B**.

**4. `npm run params` exited 1 for a config that was correct.**
`target_verdict` had no branch for `local`, so 4,984,064 params were judged
against §7.5's *smoke* band and printed `FAIL at 4.98M` — failing the `--gate`
run over every config. Every config now gets its own band, or `NOT TESTED`
rather than somebody else's band.

**5. A flaky benchmark assertion, not a flaky benchmark.**
`test_benchmark_cpu` required the stored tok/s to match `tokens ÷ seconds`
within ±2, but the rate is computed from the **unrounded** wall time and the
time is stored rounded to 4 dp — at ~1,200 tok/s that rounding is worth
±9 tok/s. It failed on this machine for no reason. The tolerance is now
*derived* from the roundings instead of guessed, so it stays strict about what
it actually tests (a wrong divisor is out by orders) and stable across runs
(5/5 consecutive passes).

### The parameter-count question, settled by measurement

Two numbers were in circulation for the same model, and the difference is a
convention, not a bug:

| Figure | What it counts |
|---|---|
| **4,984,064** | the model's parameters — `plan.counts`/`table_total`, confirmed by building the torch module and comparing (`MATCH`) |
| 5,246,208 | `sum(p.numel() for p in state_dict())` — which visits the **tied** `lm_head.weight` a second time |

`4,984,064 + 262,144 = 5,246,208`, and `lm_head.weight` shares storage with
`model.embed_tokens.weight` (`data_ptr()` equal, `tieGap` 0). The report now
prints that arithmetic where the confusion happens, and
`tests/py/test_model_schema.py` pins it.

### Measured (R1: i5-6300U, 8 GB, Intel HD 540, software GL)

`npm run verify:engine` on `ai/model-export/aashish-ai-1`:

| Claim | Result |
|---|---|
| Weights | **5,059,584 B** q8 (fp32 equivalent 19,936,256 B) · gzip 4,732,964 B · brotli 4,713,956 B |
| Worst per-row quantisation error | **0.001146** |
| Tokenizer | 66,667 B, vocab 1,024 |
| Parity, shipping export | 138 positions · **argmax 100 % · top-16 order 100 %** · worst \|Δlogit\| **8.82e-06** (tolerance 0.02) |
| Parity, committed fixture | 138 positions · argmax 100 % · worst \|Δlogit\| **3.58e-07** |
| torch ↔ numpy | **PASS** — 8.58e-06 on the checkpoint, 2.09e-07 on the fixture |
| Browser load | **57–63 ms** for 5.1 MB of shards, hashes verified |
| Prefill | 35 tokens in 491–583 ms (**68–71 tok/s**) |
| Decode | **65–74 tok/s** over 6 runs — 8–9× §4's ≥ 8 tok/s floor, CPU, on the real trained weights |
| KV cache | 3,072 KB resident at ctx 512 |
| Bundle, gzip | chat code **127,836 B** of 153,600 B (§4) · rest of page 65,649 B of a 256,000 B guard |
| Model payload, gzip | **4,731,918 B** (step-1100 export; 4,742,169 B at step 800) raw 5,144,357 B — 12 % of §4's 40 MB first-use budget |
| Tests | **411 JS + 326 Python**, 0 failures (`npm run test:all`) |

Val loss on the `local` run: 2.1917 @100 → 1.1711 @200 → 0.9229 @300 →
0.6432 @700 → **0.6423 @800 (best)**. This is a pipeline/export exercise at
4.98M params, **not** a quality result — the shipping target is still
config A + Stage A/B data on a GPU.

### Per-question latency: what a visitor actually waits for

§4's floor says the model *can* answer; it says nothing about the wait before
the first word. `npm run probe:latency` measures that, and the answer is
unflattering to the obvious suspects:

* The prompt is `specials + rules + facts + question`, and the first two are
  **125 tokens on every question**. Prefill of that prompt is **2.6–5.4 s** and
  is **90–95 %** of the wait; decode is 19–25 ms/token. So the cost is prompt
  length, not decode, and `maxNewTokens` was never the lever.
* The prefix cache was generalised from an exact-length match on the rules
  block to the **longest shared prefix** of the token ids (`reusePrefix`). It is
  bit-identical — the K/V at a position depends only on what precedes it — and
  `tests/engine.test.mjs` ENG-15/ENG-17 now compare *logits*, because the
  random-init fixture emits no tokens at all and an ids comparison would have
  been `[]` against `[]`. Measured: **5,193 ms cold → 17 ms for a repeat**, and
  407 ms for a different question (120 of 142 ids shared).
* Three optimisations were measured and refused, and are recorded in
  `BENCHMARKS.md` so they are not retried on a hunch: float32 code expansion
  (2.3× cache-resident, **0.99× end to end**), batched prefill
  (`dev-prefill-batch-probe.js`; no trend across B=1…8, worst |Δ| exactly 0), and
  per-token weight-map lookup caching (0.013 ms of a 22.75 ms step).
* **The kernel is at this box's ceiling and the box is the problem.** Plain
  scalar JavaScript measures **97 M MAC/s** here against the kernel's 121 M — and
  an i5-6300U should do **1–2 G** for the same loop. This machine measures JS
  ~10× below its specification, so a WASM SIMD kernel's payoff **cannot be
  established here**, only assumed. That is why it is not implemented: see
  "Still open".

### Still open

* **WASM SIMD (or WebGPU) matvec — the one remaining real lever, deliberately
  not taken yet.** The measurement above says scalar JavaScript has no headroom
  left on this box, so the next step is a different execution engine. It is
  unbuilt because (a) its speedup cannot be verified on a machine that is 10×
  slow for unrelated reasons, and (b) SIMD accumulates in 32-bit lanes instead of
  float64, so it is a *numeric* change that would have to be re-gated rather than
  a drop-in replacement. Doing it blind would trade a verifiable 0× for an
  ESTIMATED 2–4×. Recorded as the open item, not quietly dropped.
* **Prompt length is the remaining lever that does not need new hardware**, and
  every way to shorten it trades quality: fewer retrieved facts means more guard
  rejections, and shrinking the 125-token rules block means **retraining**
  (the rules are baked into the training data via `prompt_contract.json`). Both
  are open and both are the owner's call.
* **The parity gate is now honest, but the weights it gates are a 4.98M CPU
  run.** No Stage A/B model exists; `verify:engine` must be re-run against it
  before any quality claim.
* **Kaggle/GPU training and P4's licence gate** remain the owner's job (9 of 9
  corpus sources await `--verify`), so P5 tuning is still ahead.
* **No live microphone, no real GPU, no iPhone, no screen reader.** Every item
  in `docs/MANUAL_TEST_CHECKLIST.md` §D is still NOT TESTED; headless Chrome
  has no microphone and can only be observed *refusing*.
* ~~**The exported weights are step 800** of an 1,100-step schedule.~~
  **Closed 2026-09-27:** the run was resumed (`--resume auto`) and finished at
  **step 1,100 of 1,100** in 623.7 s — loss 6.9471 → 0.6242, val 0.7030,
  **3,612 tokens/s**, `RUN_MANIFEST.json` written, re-exported and re-gated
  (`verify:engine` PASS, worst |Δlogit| 1.65e-5). It changed the answers without
  improving them, which is the useful part: the blocker is data and scale, not
  step count. See the last section of this log.
* **Deployment host undecided** (`docs/DEPLOYMENT.md` §6) and no CI provider,
  so the budget checks run on `npm test`.
* **PII open questions stand:** C4 (bootcamp provider unknown, excluded from
  answers) and C5 (which of two CV files is current).
**Superseded/closed:** §14's offline-after-cache e2e test was later written
(`dev-offline-probe.js`, with `docs/BENCHMARKS.md` measuring **0 bytes on the
second visit** and `tests/model-cache.test.mjs` pinning the unit half), and the
T0 and download-failure paths are now automated too (`dev-degrade-probe.js`,
**20/20**). What remains open from this entry is only the real-device half.

* **The shipped export's source run never finished, and that is visible in the
  filesystem.** `_finish()` in `training/scripts/train_smoke.py` is the only
  writer of `RUN_MANIFEST.json` and it returns from every run, resume included —
  yet `training/checkpoints/local/` holds `best.pt`, `latest.pt`, `step_600/700/800.pt`
  and **no manifest**. So the run that produced the shipping artifact was
  interrupted after its last save rather than completed, and its own record
  (data hashes, hyperparameters, full loss history) was never written. The
  provenance is not lost — `ai/model-export/aashish-ai-1/manifest.json` carries
  `run/step/sha256/gitCommit/savedAt` — but the run-dir record is absent, and the
  fix is the resume run (`npm run train:local`, which resumes from `latest`).
* **Real GPU, 4×/6× throttling and the frame A/B are no longer NOT TESTED** —
  they were measured on 2026-09-27; the bullets above this entry that call them
  untested are superseded by the last section of this log.
* **§12's test counts in this log are per-entry snapshots.**

### Evidence (this entry)
`ai/engine/` · `ai/answers/model.mjs` · `ai/voice/vad.mjs` ·
`inference/export_browser.py` · `inference/reference.py` · `tools/verify-engine.mjs` ·
`evaluation/voice/` · `ai/model-export/aashish-ai-1/{manifest.json,model-00000.bin,tokenizer.json}` ·
`tests/engine.test.mjs` (18) · `tests/tokenizer-parity.test.mjs` · `tests/vad.test.mjs` ·
`tests/synthetic.test.mjs` · `tests/build-bundle.test.mjs` (19) ·
`tests/py/test_export_browser.py` (21) · `tests/py/test_model_schema.py` (34) ·
`dev-prefill-batch-probe.js` · `dev-answer-latency-probe.js` ·
`npm run export:model` · `npm run verify:engine` · `npm run build` · `npm run probe:latency` · `npm run test:all`

---

## The model is the only answer path — 2026-09-25

**An owner decision that overrides §5.1 step 4.** The deterministic Quick
Answers were an *answer source*: exact-fact templates for an email or a URL,
extractive prose for a project, and — the part that forced the change — the
fallback behind a guard failure. They are retired. Where the model cannot
answer, the panel refuses in one fixed, localized sentence and says which
refusal it is. Nothing in the panel is a canned sentence standing in for a
generated one any more.

### What changed

| Before | Now |
|---|---|
| an email / URL / refusal → an exact template | the model answers it, guard-checked |
| a project or workflow question → extractive prose | the model answers it |
| the guard rejected both attempts → extractive Quick Answer | a refusal: `NO ANSWER · COULD NOT VERIFY IT` |
| retrieval produced nothing → a localized template | a refusal: `NO ANSWER · NOT IN THE PORTFOLIO` |
| no model on this device → Quick Answers | a refusal that says why, three ways |
| §6.3 rung 4 → "quick answers only" | rung 4 stops the generation and says why |

Two fixed replies remain, and both are statements about the *assistant* rather
than about Aashish: the §9 injection reply, and the identity disclosure.
Neither can safely be generated — the guard grounds claims about Aashish, so it
cannot check "yes, I am him".

### Four defects the change surfaced

All four were invisible for as long as a template could answer the same question.

1. **The most common question a recruiter asks was about to be refused.**
   `skills` is in the retrieval stop set on purpose (R3: it lives in every skill
   chunk and used to hijack the score), so "what are his skills?" has no content
   token left and BM25 returns **nothing**. With the template path gone that
   became "I don't have that in my portfolio yet" — not merely unhelpful, but
   false. The fix is to the *context*, not the answer: when retrieval comes back
   empty, the topic's own facts are read instead (the intent's sources, filtered
   through `renderFact`, so a withheld id still cannot get in). MODEL-10.
2. **The model's `<|abstain|>` was unreachable.** It decodes to the empty string
   (`skipSpecial`), which the guard reports as `empty_answer`, so the branch that
   read it *after* the guard had never once run and every abstention was
   reported as "could not verify". Reordered. MODEL-5.
3. **§6.3 rung 2 never shortened anything.** `applyLadderStep` matched a key
   called `budget`; the ladder's key is `shorten`. It was a no-op.
4. **§6.3 rung 1 never paced anything either.** The shell set its own `paceMs`
   while the answerer kept its own copy, and nothing handed one to the other.

3 and 4 are the same shape and both live in the wiring between
`ai/governor/index.mjs` and `ai/ui/chat.mjs`, which **no automated test covers**
— the chat shell needs a DOM. The routing decision was therefore pulled out of
the shell into a pure `routeQuestion()` and is covered now; the ladder's wiring
into the shell still is not.

### The gate, restated

§8.4 layer 1 was `MIN_TOP_SCORE`. It is now "retrieval produced nothing to
read", and that is only safe because the two are **provably the same set** on
the §14 corpus: 13 of the 60 cases sit below the floor and all 13 have zero
hits. `tests/retrieval.test.mjs` measures that rather than asserting it, so
raising the floor past a case that does retrieve now fails the suite and names
the case.

### Measured

* Chat code chunk **127,836 B gz** of the 150 KB §4 budget (**83 %**, up from
  118,561 B / 77 % — the refusals in three languages, the routing decision and
  the retry logic around them). Bundle **44 files / 5,727,871 B**.
* `ai/answers/model.mjs` had **no test coverage at all** before this change. It
  has 12 now (MODEL-1…MODEL-11), plus 1 new retrieval test.
* Tests **411 JS + 326 Python**, 0 failures. `verify:engine` PASS, unchanged.

**NOT TESTED:** a real model answering a real question in a real browser. The
answer path is now unit-tested end to end against a stub session, and the engine
is parity-gated — but no trained-for-quality checkpoint exists, so nothing here
says whether the model gives a *good* answer to "what are his skills?". It says
that it is asked, that the facts it is handed are the right ones, and that
anything it says is checked before a visitor reads it. The chat shell's ladder
wiring (§6.3 rungs 1–4) is likewise still uncovered by automation.

---

## The window: two bugs that hid each other — 2026-09-26

The previous entry ends with the honest note that no real model had ever
answered a real question in a real browser. Chasing that note down found two
defects, and the second one was invisible *because* of the first.

### 1. The browser model path was dead, on every device

`createModelSession`'s `worker.onmessage` kept a list of replies that must not
settle the request that asked for them. `progress` and `token` belong there —
they stream. `ready` does not: **`ready` IS the answer to `prepare`.** It was in
that list, so `prepare()`'s promise never resolved, `state` never left
`'loading'`, and `prepareModel()` never returned. The panel could download all
five megabytes, verify every hash, build the KV cache — and still show
"PREPARING ON-DEVICE MODEL" forever, on any browser, on any device.

Reproduced in headless Chrome: the worker posts `ready`, the session reports
`loading` thirty seconds later. **Every test passed anyway**, because the engine
suite calls `ScratchLlamaEngine.load` directly and nothing drove this protocol
at all. `tests/session.test.mjs` (SESSION-1…8) drives it with a fake Worker; put
the old behaviour back and that suite hangs until it times out.

### 2. The context budget was wrong by ~2.5×, so prompts overflowed the window

With the model finally loading, "What are your skills?" was answered with
*"The on-device model stopped, so I can't answer right now."* It had not
stopped. `estimateTokens` assumed **4 characters per token**, a generic English
rule of thumb, and `aashish-ai-1` has a **1,024-token vocabulary** — its BPE
cannot merge long runs the way a 32k one does. `npm run probe:tokens`:

| String class | n | chars/token min | median | max |
|---|---|---|---|---|
| frame prefix (specials + rules) | 1 | 2.66 | 2.66 | 2.66 |
| question | 60 | 1.06 | 1.82 | 3.14 |
| retrieval context | 43 | 1.29 | 1.60 | 2.39 |
| single fact line | 28 | 1.00 | 1.47 | 2.70 |

At 4, a "300-token" context was really ~750 tokens, and a prompt one token past
`max_position_embeddings` does not degrade — `forward()` **throws**. Measured
before the fix: **14 of the 60** evaluation questions assembled a prompt over
512 tokens, and the intent fallback handed the model **764 tokens** for the most
common question a recruiter asks.

Three changes, each measured:

* **`CHARS_PER_TOKEN = 1.5`**, the measured median of the classes the budget
  prices. Deliberately *not* lower: at 1.25 — below every measured minimum —
  a single long project chunk is priced over the whole budget, gets skipped, and
  the question stops retrieving anything. A budget that refuses the best
  evidence is not safer, it is wrong in the other direction.
* **`search()` prices nothing by default.** Pricing the index's chunk text
  prices the wrong string (a project chunk is 1,175 characters; the model reads
  the 300-character summary), and the error was not neutral — the widest chunk
  blew the budget on its own and was skipped, so "goal tracker" returned
  nothing and `lowConfidence` called it out-of-base. A **relevance** claim
  belongs to the calibrated `MIN_TOP_SCORE`; a **token** budget belongs to a
  caller that declares a cost model, which is what `contextSizer` is. It also
  keeps `docs/CALIBRATION.json` honest: the sweep still runs under the
  conditions it was measured in.
* **The window is enforced where the real tokenizer lives.** `fitToBudget` in
  `ai/engine/prompt.mjs` drops context lines from the tail (weakest evidence
  first, and it leaves the longest shared prefix for the KV reuse), then
  conversation turns oldest-first, and a question too long to fit on its own
  still throws. `generate()` reports the context it **actually read**, so the
  guard and the §12 sources follow the trimmed form.

Also capped: the intent fallback is bounded by `MAX_INTENT_FACTS` (18 of the 38
skill facts fit that prompt; 12 leaves room for history), and `shortenContext`
now returns the shape it was given — a two-line context came back from the
§5.1 step-5 retry comma-joined, because `[a, b].join(' ')` is `"a,b"`. That went
unnoticed while the function always returned a one-element array, which is
another way of saying the retry had never really shortened anything.

### MEASURED: a real model answering a real question in a real browser

`dev-ai-probe.js`, R1, headless Chrome, software GL — the first time this has
ever been true in this project:

| | |
|---|---|
| pre-click AI requests | **0** (only `js/ai/launcher.js`) |
| panel ready after the click | **20.0 s** (5.1 MB download + SHA-256 + dequantise) |
| first answer | **91.6 s** |
| answer | `AI ANSWER · ON-DEVICE MODEL`, 2 sources |
| "What are your skills?" | `kind=model`, **12 facts read**, 12 sources |
| "what is his phone number?" | `NO ANSWER · NOT PUBLISHED` |
| probe | **31/31 checks** |

The probe itself was measuring the wrong thing and is fixed: it clicked a
starter chip 400 ms after opening the panel and called that "an answer, end to
end", which on this machine is the *loading* state. It now waits for
`model.state` to settle, waits for `model.last.text`, prints both timings, asks
the skills question by name, and requires sources for an answer and forbids them
for a refusal.

### Measured

* Chat code chunk **133,891 B gz** of the 150 KB §4 budget (**87 %**, up from
  127,836 B / 83 %). Bundle **44 files / 5,743,270 B**; rest of the page 65,649 B.
* Tests **428 JS + 326 Python**, 0 failures. New: `tests/session.test.mjs` (8),
  `tests/token-budget.test.mjs` (4, BUDGET-1…4), ENG-18, MODEL-13/14,
  GUARD-31b, plus the retrieval contract for a priced vs unpriced search.
* `verify:engine` PASS: argmax 100 %, worst |Δlogit| 8.82e-6, unchanged.

**Still open, unchanged:** no trained-for-quality checkpoint, so the answers are
coherent-ish and wrong (`"work reviewed cor byandeeer why"`) — a 4.98 M CPU
pipeline run, and the Kaggle/P4/P5 gates are the owner's job. WASM SIMD/WebGPU
unimplemented; live microphone, real phone, iPhone and screen reader never
tested; the chat shell's ladder wiring still has no runtime test. **New:** the
chat chunk is at **87 %** of a hard budget — the next feature that lands in
`ai/` should be paired with a look at what could move out of it.

---

## §10's message controls, and a bug that shipped green — 2026-09-26

### Stop and Retry

§10 and §18 both list **Stop, Retry, Clear** among the message controls. Clear
existed; the other two did not — in a shell that already had the plumbing for
both (`session.generate` takes a signal, and `lastQuestion` was written by
every single turn and read by nothing).

**Stop** is an `AbortController` around one generation. The abort *rejects* the
in-flight `generate` (that is what `session.request` does), and the shell must
not turn a click into "the on-device model stopped" — a sentence that blames
the machine for the visitor's own action. So a stop has exactly two outcomes:

| What happened | What the visitor sees |
|---|---|
| nothing painted yet — the common case, because prefill is most of the wait | the new `cancelled` refusal, in three languages |
| something was painted | it is **kept**, badged `PARTIAL ANSWER · STOPPED BY YOU` — never the verified badge, because neither the guard (it runs when generation *ends*) nor the placeholder resolver (it runs at the end of `ask()`) has run |

That second case is the fiddly one, so it is a pure function
(`partialAnswer` in `ai/answers/model.mjs`) rather than a branch in the shell:
it resolves whole placeholders, drops one cut in half — a stream can end inside
`<|fact:cont` — and falls back to the `cancelled` line when there is nothing to
keep. MODEL-17 covers all five inputs in three languages; MODEL-15 pins the
other half of the contract (the signal reaches the session, and an abort
rejects rather than arriving as a `kind: 'model'` answer).

**Retry** re-asks the last question and is offered only when the last turn did
not answer it. A good answer already has Clear and the follow-up chips.

**What Stop really does, stated plainly.** The panel stops waiting and the
answer is final immediately — the visitor's experience is exactly §10's. The
worker, however, finishes the pass it was in: the prefill loop is synchronous
on purpose (that is why prefill is fast), so the `abort` message cannot be
processed until the worker returns to its event loop. Pressing Stop saves the
*visitor* nothing (prefill has already been paid), it saves the question. A
genuinely interruptible prefill would need a macrotask yield per token — the
exact cost the decode loop avoids with `step % 16 === Promise.resolve()`.

### The bug that shipped green

Adding the `PARTIAL` badge put a stray backtick in a CSS comment in
`ai/ui/styles.mjs` — *"revealed by the `` `hidden` `` attribute"* — which closed
the stylesheet's template literal. **432 tests passed. The build passed.
`checkImports` passed.** And the panel simply never appeared: the launcher's
dynamic import rejected, `window.PortfolioAI` stayed undefined, and the e2e
probe said only "panel opened: false".

The gap is structural, not accidental: `ai/ui/styles.mjs` is imported only by
`ai/ui/chat.mjs`, which only a browser ever loads — so **nothing in Node had
ever parsed either file**. `checkImports` walks a regex and cannot see a syntax
error.

`tests/build-bundle.test.mjs` now imports every `ai/**/*.mjs` (which also
resolves every relative import and every named export — `ai/engine/worker.mjs`
is the only exception, it assigns `self.onmessage` at load time, and it is
parsed instead), parses the page's own scripts without running them, and
`--check`s the four `tools/*.mjs` whose top level is a CLI entry point.
Verified by putting the backtick back: the test fails with
`ai/ui/styles.mjs: Unexpected identifier 'hidden'` and passes when it is
removed. It costs 1.0 s.

### MEASURED

`dev-ai-probe.js`, R1, headless Chrome (software GL): **40/40 checks**.

| | |
|---|---|
| Stop offered only while answering | hidden when idle, offered **1 ms** after the ask |
| Stop takes effect | `stop()=true`, bubble badged `PARTIAL ANSWER · STOPPED BY YOU`, no `<\|` leaked |
| Retry | appears after a non-answer; starts a fresh generation (Stop offered, prose streaming) |
| the retried answer | completes: `kind=model`, **12 facts**, 12 sources |
| first answer | 113.9 s (this laptop; the same probe has measured 87.6 s and 138.7 s on other runs) |

Tests **432 JS + 326 Python**, 0 failures. Chat code chunk **136,409 B gz**
(**88.8 %** of the 150 KB §4 budget, up from 133,891 / 87 %) — the §10 controls
cost ~2.5 KB gz, and the headroom is now 17 KB. Bundle 44 files / 5,750,918 B.

---

## Re-measuring §15.3 with a model that actually answers — 2026-09-26

`npm run probe:resources` had a property nobody had noticed: every one of its
questions was a **refusal**. The session bug meant no browser had ever loaded a
model, so the probe's resource numbers were the numbers of an *idle panel* —
including the row everyone would quote, "0 shader programs compiled". Re-run
with five real answers (13.9 s, 19.5 s, 24.3 s, 25.3 s, 36.7 s on R1) plus one
hands-free answer, the answer to the question a visitor's device actually asks
is: **the AI adds nothing measurable to the main thread.**

| | measured |
|---|---|
| worst long task in the AI windows | **65 ms** |
| the page's own worst long task, panel never opened | **88 ms** (software-GL film) |
| median frame time, panel open vs closed | 25.2 ms vs 24.7 ms — **2 %** FPS drop (§4 allows 10 %) |
| GL programs compiled while answering | **0** (31 → 31) |
| §6.3 ladder peak across five answers | **1** (pace) — rung 3 never fired |
| quality changes the ladder asked the scene for | **0** |
| extra JS heap, five answers on top of the panel | **1.3 MB** (§4 allows 300 MB) |
| heap / nodes / listeners over 5 reopens | **0 / 0 / 0** |
| the model after 130 s closed (§6.4) | **released** (worker 1 → 0) |

That is the worker boundary doing exactly what it exists for: the whole
generation — prefill included — happens off the main thread, and the film's
frame time does not move.

### Three probe bugs this exposed, each of which had been hiding a result

1. **"no AI worker outlives a close" was measuring the wrong moment.** §6.4
   *deliberately* keeps the model for ~2 minutes after a close, so a sample
   taken seconds after one cannot tell the window from a leak. It had been
   passing for the wrong reason: the worker had been terminated by an earlier
   close's timer while the probe was still spending minutes on refusals. It now
   waits the window out (`UNLOAD_WAIT`, 130 s) and samples again — **released,
   1 → 0** — with the warm state asserted separately.
2. **"the AI compiles no GL program" compared the wrong two instants** — before
   the click against after the *entire answering section* — so it read as the
   AI rendering something of its own. The idle claim it makes is now measured
   where it is true (31 → 31 on open and idle), and the answering window is
   reported separately with the ladder's own `qualityCalls` counter beside it.
3. **the tap-to-talk section asserted push-to-talk at T2.** At T2 voice is
   `both`, which means Proactive — clicking the button starts continuously, and
   the manual checklist says so. It was reading `mode=continuous` while
   asserting `mode=push`, and failing three checks for it. "Tap & Speak" is the
   T1 mode (§6.2), and the section now sets T1: **all four tap checks pass**,
   and the continuous section still passes at T3.

### Two things left as open measurements, not explained away

* Two *earlier* runs showed a **+21-program** material recompile during
  answering; two showed none. The ladder asked for no quality change in any run
  (`qualityCalls: 0`), so rung 3 did not fire. In the run where the count moved
  outside the typed questions it landed exactly in the hands-free window — the
  one the §12 anchor scroll runs in, where the film switches scene and three.js
  compiles that scene's programs. A scene change is the page's own cost, but
  this has not been isolated.
* The panel's ready time has been measured at **390 ms** and at **20–22 s** on
  this box within the same hour, by two probes with two different wait
  conditions. That 50× spread is machine load, and neither number is
  quotable alone.

The two remaining probe failures are the voice section's wake-phrase pair,
which flips between runs on a host with no real microphone (§11 has always been
NOT TESTED for exactly this reason). Neither is a resource figure.

---

## §6.3's wiring is a value now, and the tests run it — 2026-09-27

GOV-3 was the only check on the hand that turns §6.3's knobs, and it was a
**grep**: it read `ai/ui/chat.mjs`'s source and looked for `key === '…'`
comparisons matching `LADDER`. That check **passed while rungs 1 and 2 were
dead** — step 2 matched `budget` where the ladder's key is `shorten`, and step 1
set a `paceMs` the answerer never received. A grep cannot tell a live branch
from a dead one, and it was never going to find the second half of the bug
(the value was computed and discarded).

The reason given for settling for a grep was true and is now false: the shell
needs a DOM, so nothing could drive it. It does not need a DOM any more,
because the wiring is no longer in the shell. `createSessionBudget` in
`ai/governor/index.mjs` owns §6.2's per-tier answer budget, §6.3 step 1's pace
and step 2's token budget, and pushes both into the answerer — which is the
part that was missing. It takes its dependencies as arguments
(`getAnswerer`, `setSceneQuality`, `onStop`, `onRestore`), so a test can drive
every rung with fakes.

| | |
|---|---|
| `ai/ui/chat.mjs` | **−533 B gz** — the rung switch, the two local knobs and their comments moved out; it now keeps only the copy and the once-per-session notice flag |
| `ai/governor/index.mjs` | **+1,309 B gz** — `createSessionBudget` and `tierMaxNew`, which had no home before |
| chat code chunk | **+776 B gz**, i.e. **137,039 B** = **89.2 %** of the §4 budget of 150 KB, from 136,409 B (88.8 %) |

So this step **costs** budget rather than saving it, and it is worth saying so
plainly: the chunk is the §4 number to watch, and the honest trade here is
+776 B (0.5 pp) for a mechanism that can now fail loudly. A second bug came out
of the same consolidation — the per-tier budget (96/160/256) was computed in
**two** places, and the ladder's restore copy had no T0 case, so it would have
restored 160 tokens onto a device with no model. Both now read `TIERS` through
`tierMaxNew` (GOV-4).

### MEASURED

* `dev-ai-probe.js` is **untouched** by this change — no visitor-facing path,
  string or behaviour moved. What moved is *which module owns the knobs*.
* Tests **434 JS + 326 Python**, 0 failures (was 432 JS; the source-grep GOV-3
  became a run-time GOV-3, plus GOV-3b and GOV-4).
* GOV-3 was **verified to catch the original bug**: renaming step 2's key back
  to `budget` fails GOV-3 and GOV-3b and nothing else — it is a real test of the
  wiring, not of the source text.
* `npm run build` clean, 44 files, 5,755,780 B.
* The §4 chunk, split by the line items §4 actually names: the chat UI chunk
  proper (UI + `knowledge.json` + retrieval + language + guard + intent +
  anchors + governor) is **91,923 B gz = 89.8 KB (59.8 %)**; the voice add-ons
  are **18,464 B gz** and the LLM runtime + tokenizer **26,652 B gz**, each of
  which §4 lists on its own row. The 89.2 % figure above is the conservative
  reading — every shipped `ai/**` module except the model counted as one chunk
  — and `tests/build-bundle.test.mjs` asserts that one, because it can never
  flatter the result.

---

## The retired Quick Answers leave the bundle — 2026-09-27

The owner retired Quick Answers as *answers*, so the shell has been throwing
their text away since P7 — and §4's chunk was paying for it on **every**
visitor's device. Measured on the shipped files, that wording was the largest
block of bytes in the chunk that no visitor could ever read:

| block (`dist`, gz, measured by slicing the file) | |
|---|---|
| `BUILD` — the per-intent templates | **4,596 B** |
| `extractive()` — the workflow and project prose | 1,242 B |
| `factAnswer()` — the single-fact sentences | 1,372 B |
| `FOLLOWUPS` + `FOLLOWUPS_FIRST` (chips are still rendered — stay) | 1,175 B |

§5.1 step 4 is split along the seam that was always there: **decide** vs
**say**.

* `ai/answers/quick.mjs` is a **planner**. It returns the same result object as
  before — intent, `abstained`, `injection`, `private`, `focus`, `sources`,
  `followups` — plus a serializable **`plan`** describing what was selected
  (`{kind:'skills', ids, category}`, `{kind:'project_detail', id}`, …). Its
  `text` is filled only for the two replies that are fixed statements about the
  *assistant*: the §9 injection refusal and the identity disclosure. Those are
  not templates standing in for a model answer, so they still ship.
* `evaluation/answer-text.mjs` owns the wording, one entry per plan kind, and
  exports a drop-in `quickAnswer` that passes `say` in. `SHIP_PATHS` never
  copies `evaluation/`, so not one byte of it reaches a browser — and because
  the build refuses a shipped module that imports something it does not ship,
  no shipped file can start depending on it by accident.

One decision came *out* of a template while the seam was being cut: "is this
question about a `public:false` field?" used to be answered inside the contact
*template*, which meant it happened only because the intent happened to be
`contact`. It is routing, so it is in the planner now.

### MEASURED

| | before | after |
|---|---|---|
| chat code chunk (§4, conservative) | 137,039 B gz · 89.2 % | **134,175 B gz · 87.4 %** |
| §4's chat-UI chunk proper | 91,923 B gz | **89,088 B gz** (58.0 %) |
| `ai/answers/quick.mjs` | 14,354 B gz | **11,490 B gz** |
| tests | 434 JS + 326 Python | **435 JS + 326 Python, 0 failures** |

The saving is **2,864 B gz (−2.1 %)**, not the ~6.9 KB the block looked like on
its own, and the gap is worth stating: everything that *decides* — which
project, which skills, whether a question is answerable at all — has to stay on
the visitor's side of the wire, and after the move that logic is most of the
file. The templates were the prose on top of it.

**Verified, not assumed:** `tests/quick-answers.test.mjs` (28 tests, unchanged
assertions in all three languages) and `tests/evaluation.test.mjs` now run the
non-shipped module, so the wording still has to be right; an added assertion in
`tests/build-bundle.test.mjs` fails if any built text file contains a template
phrase **or** if the shipped planner returns text for a portfolio question; and
the fact-hardcoding check now reads *both* halves, because a baked value in the
wording would fake a pass on the evaluation set. The new guard was verified by
re-injecting a template phrase into the planner, which failed it.

`dev-token-budget-probe.js` and `npm run calibrate` follow the wording to its
new home. Nothing visitor-facing changed: the panel refused those paths before
this commit (`noAnswerLine`) and refuses them now — the bytes are simply no
longer downloaded to produce text that was discarded.

---

## §2 N6 and §9.3, and the two things they needed — 2026-09-27

The two rules were the oldest unmet ones in the brief, and each needed a
mechanism rather than an assertion.

### 1. Voice loads on a TAP, not on the click (§2 N6)

`ai/ui/chat.mjs` statically imported `ai/voice/index.mjs`, which imports the
VAD and the phantoms filter. So "voice assets load only when a voice mode is
chosen" was false for every visitor who never chose one: they parsed the whole
voice layer on the click.

The panel does need to say *something* about voice the moment it opens (is the
button live, and if not, why), so the pre-tap half moved to a new
`ai/voice/caps.mjs`: the §6.2 tier policy and the recognizer feature check, and
nothing that listens or speaks. `ai/voice/index.mjs` re-exports all of it, so
nothing that already imported the voice layer had to change.

Turning voice on is async now, which created two real defects that the browser
probe caught rather than the unit tests:

* **The button could go briefly dead.** A tap fetched a module before anything
  visible happened. It now shows `VOICE…` (disabled, "Loading voice mode…")
  from the tap until the module arrives — §2 N7 is "never a blank modal or an
  endless spinner", and an inert-looking button is the same failure.
* **`dev-ai-probe.js` was measuring the machine.** Its voice section slept a
  fixed 1.5 s after clicking the microphone and then read the state. On the run
  where the model was still finishing, that reported a dead button that was
  only a slow one. The probe now waits for the outcome, and it asserts the new
  thing too: at 80 ms the button already says `VOICE…`.

MEASURED on R1, headless Chrome: what the click statically fetches went from
**102,596 B gz (16 files) to 86,096 B gz (14 files)** — a 16.1 KB reduction —
and the voice engine, VAD and phantoms filter are not among them. The
conservative §4 chunk went **up** 1,088 B gz, because the capability module it
needed is now its own file; `tests/build-bundle.test.mjs` follows the shipped
import graph and fails if the engine becomes reachable from the shell again
(verified by re-adding the import).

### 2. The model is actually cached, so "0 MB on later visits" is true (§9.3)

§4 promises one-time download and §14 asks for the offline-after-cache test,
but "cached" had been the HTTP cache — a hint that can be evicted, cannot be
enumerated, and is not available offline. §9.3 asks for the real thing.

`ai/engine/cache.mjs` puts the manifest, the tokenizer and every shard in a
**version-keyed Cache Storage** entry (`aashish-ai-model:<version>`, taken from
the export directory, so there is no second source of truth), deletes older
versions on activation, leaves other origins' caches alone, and — the rule that
keeps this honest — **verifies every hit** through the existing sha256 check in
`loadWeights`. A cache is a source of bytes, never a source of trust.

Three failure paths were designed rather than discovered: no `caches` (not a
secure context), a refused `open()` (private window) and a `QuotaExceededError`
on write all fall back to the plain fetch — a cache failure is never a load
failure (§2 N7). And if a stored shard fails its own hash, the version's cache
is dropped and the load is retried once: a poisoned or truncated entry costs a
visitor one re-download instead of a permanently broken assistant, and a
genuinely bad artifact still fails the same way twice (CACHE-6b).

### MEASURED — `node dev-offline-probe.js` (new), R1, headless Chrome

| | |
|---|---|
| visit 1 | ready in **27.9 s**, 3 network responses, `puts: 3`, `hits: 0` |
| the cache | `aashish-ai-model:aashish-ai-1` — **3 files, 5,144,357 B** |
| visit 2, **`*model-export*` blocked at the CDP level** | ready in 23.5 s, `hits: 3`, `misses: 0`, **0 network responses** |
| page offline (network cut, reload) | document came from the HTTP cache, the `/js` launcher did not — reported, not asserted: with no service worker (§9.3) the page makes no offline promise. The **model** is the part that is now guaranteed |

**NOT TESTED / not promised:** the wall clock did **not** improve (27.9 → 23.5 s
is decode work on localhost, not download work), and no real network was
involved, so the 0 MB claim is about bytes on the wire, not about time.

`tests/model-cache.test.mjs` (8 tests) pins what a browser cannot show: zero
fetches on a hit, an absent `caches`, a refused open, a refused write, old-version
eviction, a foreign cache left intact, the poisoned-entry recovery, and that a
404 is never stored (caching a failure would make it permanent).

### 3. Re-verified end to end after all of it

`dev-ai-probe.js`, R1, headless Chrome: **41/41 checks**. Panel ready 19.3 s,
first answer 59.0 s, `AI ANSWER · ON-DEVICE MODEL`, the skills question reading
**12 facts / 12 sources** — which is the §5.1 topic-only fallback still working
through the new planner — phone question `NO ANSWER · NOT PUBLISHED`, Stop and
Retry exercised, voice enabled at `level=both mode=continuous`. Frame-health A/B
stayed **INCONCLUSIVE** here (headless software GL has a 0.7 fps baseline) —
superseded 2026-09-27, see the next section: the real GPU was reachable, the A/B
now measures **0 % drift**, and the software-GL run was a confound.

Tests **444 JS + 326 Python**, 0 failures. `npm run build` clean.

**Still open, unchanged:** no for-quality checkpoint (the browser's answers are
still the 4.98M `local` export, which is why they read like
`"work reviewed cor byandeeer why"`), real-device and real-microphone testing,
and §11 Proactive's long soak.

---

## Phase 9–11 — the two missing §14 gates, P10's decision, P11's report — 2026-09-27

**Status:** ✅ **P10 complete (written go/no-go) · P11 complete (final report
written, gaps listed in it) · P9 open on hardware R1 cannot provide.**

### 1. §14's unsupported path and failure path, driven for real (new probe)

§14 asks for automated e2e coverage of "the T0 unsupported path, offline-after-
cache, download failure/retry". The middle one had a probe; the other two had
**nothing**, and they are the two a visitor on a metered phone or a flaky
connection actually meets. `dev-degrade-probe.js` (new, `npm run probe:degrade`)
drives both — **20/20 checks**:

| Case | What it proves |
|---|---|
| **T0** (`navigator.connection.saveData`, the environment §6.1 asks about instead of sniffing) | tier 0, **0 model assets requested**, **0 engine workers**, `model.engine === null`, badge `T0 · NO AI MODEL HERE`, 0 page errors, and a real question refused as `no-model` with `NO ANSWER · NO AI MODEL ON THIS DEVICE` — not a spinner |
| **FAILURE** (every model asset 404ing on a first visit) | `model.state === 'error'` with the reason said out loud (`manifest fetch failed: 404 …`), the panel still usable, the film untouched, the question refused honestly, 0 page errors — and **a reload on a healthy network reaches `ready`** with a real 5,059,584 B model and a real answer, which is the retry the panel promises in words |

### 2. Two bugs the probe found, and one wrong test

* **The fault injection was in the wrong place.** The first version blocked
  `*model-export*` with CDP `Network.setBlockedURLs` on the page session. The
  weights are fetched **inside a module Worker**, and that block does not reach
  a dedicated worker's requests — so the failing case came back `state: ready`
  and read as a green check. It is now a **dev-server** fault-injection flag
  (`FAIL_MODEL=1` 404s `/ai/model-export/`, `PORT=5581`), and the probe asserts
  the fault is live (`HTTP 404` from the page) *before* it believes anything the
  panel says. A failure case that cannot fail is worse than no test.
* **`prepareModel()` restamped the tier's short label over the model line.** On
  T0 the badge block ran after `setModelState('unsupported', …)` and overwrote
  `T0 · NO AI MODEL HERE` with `T0 · NO AI MODEL` — less specific than what the
  shell already knew. It only restamps while `modelState === 'idle'` now, so the
  T1+ case keeps `PREPARING MODEL…` too. Visitor-facing, small, and found by
  asserting the words rather than the state.
* **A wrong assertion of mine**: "no worker was created" failed because §6.1's
  micro-benchmark legitimately runs in a throwaway blob worker on every device.
  The check is now "no **engine** worker", which is what the rule is about.

### MEASURED — after the fix (R1, headless Chrome)

| | |
|---|---|
| `node dev-degrade-probe.js` | **20/20 checks** |
| chat code chunk (§4, conservative) | **138,896 B gz · 90.4 %** (was 138,779 · 90.4 % — the badge fix and its comment, +117 B) |
| tests | **444 JS + 326 Python, 0 failures** · `npm run build` clean |

### 3. P10 (§13) — written go/no-go: **NO-GO**

`experiments/ternary/README.md`. Ternary is **separated from the baseline by not
existing**: no QAT flag, no second quantizer, no ternary kernel. At 4.98M params
its real benefit is size (~3 MB gz off a 4.93 MB first visit — ≈6 % of a budget
we use 12 % of), the speed benefit needs kernels a stock browser runtime does not
provide (§13 says so itself), and the decision belongs *after* the baseline
passes its own gates. Four conditions that would re-open it are written down,
with the order to do them in.

### 4. P11 (§18) — the final report

`docs/FINAL_REPORT.md`: MODEL · TRAINING · KNOWLEDGE · BROWSER · PERFORMANCE ·
CHAT · VOICE · TERNARY · KNOWN LIMITATIONS · WHAT I NEED FROM YOU, every value
tagged MEASURED / ESTIMATED / NOT TESTED, plus §18's checklist item by item.

The one thing it says first, because it is the honest headline: **the pipeline
is real and verified end to end; the model currently in the browser is not
trained for quality.** The claim about architecture, privacy and locality is
true today. The claim about answer quality is not, and it needs the GPU run.

### 5. §14's jank question, finally answered on real hardware

Older logs recorded the frame-health A/B as **INCONCLUSIVE** because the probes
ran under `--use-gl=swiftshader`. That was a choice, not a limit: this laptop's
**Intel HD 520 is reachable from `headless: 'new'`** — `ANGLE (… Direct3D11
vs_5_0 ps_5_0, D3D11)` — and `docs/BASELINE.json` was already measured that way.
So `dev-ai-probe.js` now takes `SW_GL=1` to opt *into* software GL (the same
knob `dev-resource-probe.js` uses) and uses the real GPU by default.

**The first real-GPU run produced a confound, and catching it was the point.**
It reported **−49.2 %** drift — the panel-open arm *twice as fast* — because the film's
**own governor** had walked `tier 1 · HIGH @85 %` →
`tier 4 · SURVIVAL @50 %` during the session, with the AI requesting no quality
change at all (`qualityCalls: 0`, MEASURED in every run). A drift measured across
two different films is not an AI cost in either direction, so the probe now
samples the film's tier / scale / scroll position / paused state in **both** arms
and declines to attribute a drift when they differ — and it pins the tier
(`PIN_TIER`, default 2), re-pinned before each arm, because that is what makes
the comparison mean anything.

### MEASURED — `node dev-ai-probe.js`, R1, real GPU (Intel HD 520, D3D11)

| Arm | frames | median | p95 | film |
|---|---|---|---|---|
| closed | 127 | **18.3 ms** | 36.5 ms | `tier 2 · BALANCED @72% y=0` |
| open, after 5 answers | 126 | **18.3 ms** | 36.5 ms | `tier 2 · BALANCED @72% y=0` |
| **drift** | | **0 %** (§14 allows ≤ 10 %) | **1.00×** (§14's p95 guard) | same film both arms |
| panel ready | | **815–880 ms** after the click, in these two runs | | |
| probe | | **43/43 checks** | | |

**Honest caveats:** 815 ms is the best case on an unloaded box — the same probe
has measured 19.3–27.9 s on the same day, and the 390 ms–20 s spread was already
recorded; the A/B is at a *pinned* tier, which is what makes it attributable but
is not the tier a visitor's film will choose; and p95 identical to 0.1 ms in both
arms is reported as measured, not explained.

### 6. §4's reference profiles — the 4×/6× throttling runs that had never happened

`THROTTLE` was a `dev-baseline-probe.js`-only knob. It is now on the AI probe too
(same CDP call, `Emulation.setCPUThrottlingRate`, applied before navigation), and
the gate was run on all three profiles:

| Profile | panel ready | first answer | frame drift | p95 | probe |
|---|---|---|---|---|---|
| R1 as it is | **815 ms** | **25,129 ms** | **0 %** | **1.00×** | **43/43** |
| **4× CPU** | **1,091 ms** | **45,380 ms** | **−2.5 %** | **1.00×** | **43/43** |
| **6× CPU** | **1,502 ms** | **42,753 ms** | **+0.3 %** | **1.00×** | **43/43** |

§4's target (≤ 10 % median drop, p95 ≤ 1.5×) is met on all three, and every flow
check survives 6× — streaming, Stop keeping the partial, Retry, 12 facts on the
skills question, panel usable.

**What the throttle is not, said because it would be easy to overclaim:** frame
time doubles (18.3 → 35.3 ms), so the main thread is throttled, but the first
answer goes 25.1 → 45.4 s — **1.8×, not 4×** — because the generation runs in a
Worker and this CDP throttle does not hit it proportionally. So the closest this
box can get to a weak device is still not a weak device, and a phone's answer
latency remains **NOT TESTED**.

One incidental answer: panel ready scales cleanly with CPU (815 → 1,091 →
1,502 ms) while the same probe has reported 19.3–27.9 s for that same step on
that same box, which is what finally makes the earlier 390 ms–20 s spread
attributable to machine load rather than to the assistant.

### 7. The local run was finished, and the pipeline's record-keeping proven

The shipped export came from step 800 of a run that had **not** reached
`_finish()` — which is the only writer of `RUN_MANIFEST.json`, and
`training/checkpoints/local/` had none. So the run behind the artifact was
interrupted rather than completed. `--resume auto` carried it **800 → 1,100
steps in 623.7 s**:

| | before (step 800) | after (step 1,100) |
|---|---|---|
| loss | — | **6.9471 → 0.6242**, windowed gate **PASS** (6.8368 → 0.909) |
| val loss | 0.6423 | **0.7030** |
| throughput | 1,335 tok/s (loaded box) | **3,612 tok/s** (256×8, calm box) |
| `RUN_MANIFEST.json` | **absent** | **written**, 23 KB — seed, config, tokenizer version, hyperparameters, **68 shard hashes**, full loss history |
| shard | 5,059,584 B, gz 4,732,964 | 5,059,584 B, **gz 4,731,918** |
| `verify:engine` | PASS, worst \|Δlogit\| 8.82e-6 | **PASS**, 138 positions, argmax **100 %**, worst \|Δlogit\| **1.65e-5**, q8 row error 0.001356 |

**The honest headline is not the gain, because there isn't one.** The answers at
step 1,100 are still wrong, just differently:
`"work reviewed cor byandeeer why"` → `"Uneomunyatoe thek, reviewed cor byandeainir…"`.
Three hundred more CPU steps on 3 MB of generated text teach the model to
memorise its corpus, not to answer questions about a person. What this run bought
is **proof that the pipeline records a completed run** (the manifest, the hashes,
the loss history) and a fresh parity gate on fresh weights — both prerequisites
for the GPU run, not substitutes for it.

### 8. Two instrument findings that change how the frame numbers are read

* **The film on R1 is bimodal, so a single-run frame A/B is worth ±90 %.** The
  probe now samples the *open* arm twice, seconds apart, with the film untouched:
  in one run the two open samples read **18.3 ms and 35.4 ms — 93.4 % apart**,
  with the ladder at `step=0`, no quality change and identical tier/scale/position.
  A separate run reported **+92.9 %** drift, and the run before it **0 %**. The
  probe prints the control's disagreement beside the verdict and refuses to
  attribute a drift the control contradicts. What survives as the AI's own,
  bounded contribution: no long task, no GL program, no quality change.
* **§6.2 picked T1 · LITE on this desktop in every recent run**, where the P2-era
  record says T2 — `benchSlowMs` is 14 ms and the §6.1 micro-benchmark is
  load-sensitive, so a busy box downgrades itself. The direction is conservative
  (a shorter answer budget, 96 vs 160 tokens), which is why it is recorded rather
  than patched without an idle reference to tune against.

The probe's wait condition was also fixed here: it waited on `PortfolioAI.state`,
which means "the panel is up" and can be true while the model is still
downloading (the opening bubble says so in words, which is honest). It now waits
on `model.state`, which is why earlier runs printed
`state=ready tier=1 badge="T1 · PREPARING MODEL…"`.

**Still open, unchanged, and listed in the report:** the GPU training run and
the P4 gate (owner), a real-device / real-microphone / screen-reader pass, the
deployment host, PII sign-off, WASM SIMD and WebGPU, and `benchSlowMs` tuning
against an idle reference.

### 5. §4's code chunk — halved, by not shipping prose (2026-09-27)

The chunk had been sitting at 90.4 % of its 150 KB budget and the report named it
as the thing to watch. The fix was not a feature removal and not a new
abstraction: it was that **half the chunk's gzip was comments in our own
modules.** Measured on the shipped tree — 137,272 B gz with comments, 66,799 B
gz without — **70,473 B gz, 51.3 % of §4's budget, was being spent on design
notes the visitor never runs.** `gzip` does not help here: comment text is
English prose, and prose is what it compresses worst.

So `tools/build.mjs` now writes a stripped copy of every shipped `ai/**` script
(`stripComments`), and the repository keeps every word. Three things make that a
measurement rather than a hope:

* it reuses `maskSource`, the comment/string/template/regex walk the leak scan
already rests on — one walk, so one bug and one set of tests;
* the test that used to check "every shipped module parses" now also **imports
the stripped modules from `dist/`**, which is stronger than parsing and would
fail on a comment cut through a token;
* and "the same program" is checked by asking the built planner and the source
planner the same five questions (skills, a withheld field, an unanswerable one,
the disclosure, an injection) and comparing `intent`/`sources`/`plan`/`text`
for equality — not by arguing that a character-preserving transform must be
safe.

`js/**` and `css/**` are asserted byte-identical to source in the same test,
because §2 N7 says the AI layer does not touch the film.

| | before | after |
|---|---|---|
| chat code chunk (§4, conservative) | 138,896 B gz · **90.4 %** | **69,079 B gz · 45.0 %** |
| — §4's chat-UI chunk proper | 89,522 B | 46,978 B (30.6 %) |
| — voice add-ons (§2 N6) | 19,215 B | 7,432 B |
| — LLM runtime + tokenizer | 30,042 B | 14,669 B |
| what the **click** fetches (static reach) | 86,096 B gz | **41,221 B gz, 14 files** |
| tests | 444 JS + 326 Python, 0 failures | **451 JS + 326 Python, 0 failures** · `npm run build` clean |

Three new tests. Two are the strip's two directions: `stripComments` on
adversarial input (a regex holding a quote, a URL in a string, a CSS comment
inside a template literal, a division), and the built-vs-source behaviour
comparison.

`npm run bundle` (`tools/bundle-report.mjs`) is new too: the §4 figures in the
docs used to come from a throwaway `node -e` snippet, which is exactly how a
figure goes stale. It prints the chunk, §4's three sub-rows, the first-visit
total and the largest files, and `--json` emits it for the docs.

### 6. §2 N2/N3 + §17's secrets — three prose claims turned into a gate

The final report, the README and `knowledge/PII_REVIEW.md` all say "no backend,
no LLM API, no API key". §18 says not to write "implemented" without verifying,
so the claim is now checked against the built bundle — which is what it is
actually about — in `tests/build-bundle.test.mjs`:

* no shipped `ai/**` script contains an absolute `http(s)` URL (**MEASURED:**
there are none, so there is no host for a question, an answer or a microphone
buffer to reach);
* the shipped AI code makes **exactly one** outbound call — `fetch(KB_URL)`, this
site's own `knowledge.json` — and the test asserts the count, the file, the line
and that the URL is site-relative, so a second one cannot be added quietly;
* no `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` or
`navigator.share` exists in shipped AI code;
* no shipped text file matches a secret pattern (PEM block, OpenAI/Google/GitHub/
AWS/Slack key shapes, a `Bearer` token, a key-or-secret assignment), and none
names a hosted LLM service.

Two more §17 clauses ride along in the same test, because they are the same kind
of claim. **Production logging:** the shipped AI code contains no `console.*`
at all, so the assert is "no debug-grade call" (`warn`/`error` stay legal), and
no debug overlay exists. **Analytics:** there is none in the portfolio — the
word only appears in project descriptions in `index.html` — so "chat and voice
content is never sent" is true by there being no destination, and the test fails
if a known tracker name ever appears in the bundle.

The patterns are deliberately narrow: a false positive here would be a
fabricated finding, which is worse than finding nothing. Comments are stripped
from `dist/` before the scan, so a key hidden in a comment cannot mask a real one
the scan should see.

### 7. The model's arithmetic is parsed only in the worker — now pinned

§4's hardest rule is "AI work on the main thread: no task > 50 ms", and the
structural half of it was true but untested: the click parses the shell and the
session client, the session spawns a module Worker by URL, and the tokenizer,
the matmuls, the dequantiser and the manifest verifier are parsed **only inside
that worker**. Nothing about it is visible in a file listing or a byte total —
every one of those files ships — so it is a question about the import graph.

`tests/build-bundle.test.mjs` now follows that graph and requires the engine
modules to be reachable from `ai/engine/worker.mjs` **and not** from
`ai/ui/chat.mjs`, and the worker itself to be absent from the click's reach.
**MEASURED: 13,296 B gz across nine files is deferred this way.** If it ever
regressed, the symptom would be the exact cost §4 forbids: several hundred KB of
script parsed on the main thread before the first token — the same class as the
material recompile behind the 1,221 ms long task this project already had to
remove.

### 8. §2 N6's pre-click promise — now a gate, not just a probe

"Nothing AI is loaded before the visitor clicks" was asserted in exactly one
place, and that place needs Chrome, the dev server and ~40 s: the e2e probe's
network watch. That is the right way to *prove* it and the wrong shape for a
regression guard, because a promise broken by a stray `<link rel="preload">`
or a static import would not be noticed until somebody ran the probe.

`tests/launcher.test.mjs` is the deterministic half, on the two files that can
break it. On `js/ai/launcher.js`: it must stay inside its **2 KB gz** budget
(MEASURED: **945 B**), it must be inert — no `fetch`, `XMLHttpRequest`, `new
Worker`, `WebSocket`, `sendBeacon`, no `.wasm` reference, no knowledge base —
and it must contain exactly **one** dynamic call, `import(CHUNK)`, with `CHUNK`
pinned to `/ai/ui/chat.mjs`. On `index.html`: the launcher is the only `ai/`
script it loads, no `src`/`href` and no import-map value points under `ai/`, and
there is no `preload`/`prefetch`/`modulepreload` for the chunk. The second test
re-checks the same files in `dist/`, where a visitor actually is, and that the
chunk the click imports exists there — a 404 on click would be the panel dying
without a word, which §2 N7 forbids.

Why `import(CHUNK)` and not a literal: the launcher is a classic script that
names its chunk once, in a constant. The test pins the *call shape* and the
*constant's value* separately, so a rewrite that changes either fails rather
than silently passing.

### 9. The SHIPPED bundle, driven in a browser for the first time (2026-09-27)

A gap nobody had noticed: **`dev-ai-probe.js` hardcoded `http://localhost:5577/`**,
the dev server — so every browser verification in this project had run against
the *source tree*, and the thing a visitor actually receives (`dist/`: stripped
`knowledge.json`, comments removed from `ai/**`, no dev tooling) had never been
loaded by a browser at all. The Node tests import the stripped modules, which is
strong evidence, but "the browser parses and runs it end to end" is a different
claim.

The probe now takes `AI_BASE`, and it was pointed at the built bundle served the
way production serves it (`ROOT=dist PORT=5582 node dev-server.mjs`, the same
MIME table as `npm run preview`).

**MEASURED — 43/43 checks on the shipped bundle**, R1, headless Chrome on the
real GPU:

| | |
|---|---|
| no AI asset before the click | ✔ — the network watch stayed empty until the button was pressed |
| panel + model | ready, and a real generation: `kind=model`, badge `AI ANSWER · ON-DEVICE MODEL` |
| the capped-fallback question | `kind=model`, **12 facts read, 12 sources** |
| Stop / Retry | both pressed and both took effect on the stripped chunk |
| frame health, panel open vs closed | closed **33.2 ms** (115 frames) → open **33.3 ms** (105 frames), **0.3 %** drift, **1×** p95, both arms `tier 2 · BALANCED @72% y=0`; the control sampled twice read 33.3 → 33.2 ms (−0.3 %) |
| §6.3 ladder | `step=0`, `active=false`, no scene-quality change |
| voice | tap acknowledged, the unavailable-microphone reason spoken rather than silent, scene handed back, button back to off, mic off when the panel closed |
| Escape, focus | panel closed, focus returned to `#askAI` |
| console errors / page errors / failed requests | **0 / 0 / 0** |
| assets fetched on first open | **31** — the 14 of the click's static reach plus the worker's own `ai/engine/**`, which is exactly the split the import-graph test pins |
| the **phone** build of the same run (`MOBILE=1`, 390×844) | **43/43** as well — the sheet pauses the film (`scene paused (phone) isPaused=true`) and resumes it on close, **no horizontal overflow (390 vs 390)**, and the withheld phone number is still declined in the UI (`NO ANSWER · NOT PUBLISHED`) |

Three more browser gates were then run against the same bundle, because the
probe above is only the chat flow: **§9.3's cache 7/7** (visit 1 ready 26.3 s
with 3 puts; visit 2 with `*model-export*` blocked ready 22.0 s from Cache
Storage — `hits: 3`, `misses: 0`, **0 network responses**), **§14's degrade gates
20/20** on the same bundle (`ROOT=dist`: T0 loads no model at all, the failure
arm 404s every model asset, and a reload on a healthy network recovers to
`ready` with real weights and a real answer),
and **§12's anchor resolution 7/7** with the hands-free move verified
(`scrollY 0 → 14609`) — the last of those only after the three instrument bugs
in section 10 below were fixed.

So the deliverable is verified, not just its source. What remains unverified is
unchanged and listed in `docs/FINAL_REPORT.md`: a real phone, a real microphone,
a screen reader, Firefox and Safari.

### 10. The anchor probe was measuring the wrong moment — third instrument bug

With `AI_BASE` in place the §12 anchor probe was pointed at the shipped bundle,
and it **failed**: `hands-free mode moved the page by itself  scrollY 0 → 0`,
plus six of seven questions OFF SCREEN. The same failure appeared against the
source tree, which is what said it was not a bundle regression — and then a
four-line page-drive said what it was: `scrollY 0 → 14609`, target
`#scene-credits`, the anchored element in the DOM, **no page errors**. The move
was fine; the measurement was not.

**The bug.** The page moves in `finish()` — when the answer *ends* — but the
shell sets `lastAnchor` synchronously *before* it starts generating. So a probe
that fired `ask()` and then watched the scroll was watching a page nobody had
asked anything of yet. That was harmless while answers were templates (about a
second) and became a failure the moment every answer turned into a model
generation of seconds-to-tens-of-seconds — two runs of unchanged code on the
same box, one reporting `0 → 0` and one `0 → 14609`. The visibility phase had
the same race in a worse form: its `settle()` returns as soon as the position
has been stable for ~600 ms, so it returned immediately.

**And a second, subtler mistake in the same check.** It asserted "the page
moved" unconditionally. But the two correct behaviours are opposite: a model
answer moves the page to where it came from, and a **refusal moves nothing** —
"the panel made no claim and must not move the page to where a claim it did not
make came from" (`ai/ui/chat.mjs`). With a checkpoint that answers badly, most
turns are refusals, so the probe was scoring correct behaviour as an anchors
regression, and would have kept doing it.

**Fixed:** wait for a NEW answer (object identity on `model.last`) and then for
the scroll it causes; `settle()` accepts stability only *after* the page has
moved; and both assertions are now chosen by the kind of turn. Two knobs
(`PROBE_MAX_VIS=n`, `PROBE_SKIP_VISIBILITY=1`) exist so a change to these waits
can be checked without a ten-minute probe.

**Re-verified on the built bundle:** `7/7` anchors found and every landing
assertion correct; `hands-free: the answer moved the page  kind=model, scrollY
0 → 14609`; a visibility measurement at `800/800 px of the element in view, in
#scene-story`; resolution cost `10.60 ms/call` (§4 allows 50 ms); **0 page
errors**. The full 7×2 visibility sweep was **not** re-run: it needs ~14
generations and this box timed out at 420 s, so the `7/7 as shipped, 6/7 after
the edit` figures in `docs/BENCHMARKS.md` remain from the earlier runs and are
marked as such rather than re-quoted.

This is the third instrument bug in this one probe, and the pattern is worth
naming: **all three made the page look worse than it is**, and all three were
found only by running the probe against hardware it was not written on. None
was a product defect.

### 11. §2 N8 — "no second renderer, no new loop" was a sentence; now it is measured

N8 is the rule that keeps the film the only thing competing for the frame, and
it is the kind of rule that breaks quietly: a `setInterval` in a retry path or a
`getContext('2d')` for a chart would not move a byte count, a test list or a
screenshot until it was already fighting the film. The browser probe measures
what happened during one session (0 GL programs compiled while answering); the
static half says what the code is *capable* of, which is the part a regression
changes.

MEASURED as shipped, over every `ai/**` script in `dist/`: no `getContext`, no
canvas element, no `WebGLRenderer`/`WebGL2RenderingContext`/`WEBGL_` access, no
`new THREE.`, no `setInterval` — and `requestAnimationFrame` appears **exactly
once**, on the one-shot `is-open` reveal, called as
`env.requestAnimationFrame?.(…)` so a host without one still opens the panel.
The §6.3 frame monitor must also *reuse* the film's GSAP ticker: the test
requires both `.ticker.add(` and `.ticker.remove(` in `ai/ui/chat.mjs`, because
a callback that can be added but not removed would turn `close()` into a leak
the resource probe only catches after five cycles.

---

## Stage B gets a trainer, because the shipped model had never seen the frame (§7.4)

Before this pass, the Stage B *data* existed (40,000 examples, `npm run sft`)
and **no trainer read it**. Every trainer in the repo was a Stage A trainer.
That is a §7 gap, and it has a measurable shape — the runtime frame is
essentially absent from the pretraining corpus:

| The frame in `data/processed/seed/corpus.jsonl` (17,265 documents) | | |
|---|---|---|
| `<|sys|>` | 415 | the rules, once in a while |
| `<|ctx|>` | **4** | the context block, effectively never |
| `<|asst|>` | 1,108 | an assistant turn, mostly in the plain-text QA docs |

The shipped artifact had been trained for 1,100 steps on shards that do not
contain the format it is asked to continue at inference time. Extra steps on
the same shards cannot fix that. So `training/scripts/train_stage_b.py`
continues the Stage A checkpoint on the instruction data with **assistant-only
loss** (§7.4), reusing `train_smoke.py`'s loop, scaler, scheduler, checkpoint
manager and manifest writer so "verified resume" keeps meaning one thing.

### What the mask had to get right (and three things it did not, at first)

1. **The first word of every answer was unsupervised.** The mask first used
   plain containment of `assistant_spans`. Byte-level BPE folds a word's
   leading space into the word's own token (" My" is one token) and
   `assistant_spans` starts *after* that space, so every answer's first word
   failed the containment test — the word that names the value ("My CGPA is
   …"). A token now counts when it overlaps the span and everything it
   contributes outside the span is whitespace. Measured over 2,000 real
   examples: **holes 0, leaks 0**.
2. **The closing `<|end|>` was never supervised.** `assistant_spans` stops one
   character before it, and the runtime stops generation *by emitting it* — so
   the model was never taught to end a turn. The mask now includes the
   terminator and a test requires exactly one per turn (`501/501` on the
   sample; `<|asst|>` never leaks in).
3. **A window with no supervised token would have produced NaN.** Stages are
   cut as fixed windows over a packed stream; a 128-token stretch of context
   and question has no supervised position at all, `cross_entropy` over an
   all-`-100` target returns NaN, and one NaN step poisons every weight in the
   run. Windows with no supervision are now **skipped and counted**, and
   validation windows are drawn from the ones that carry supervision — a val
   loss averaged over answerless windows is not comparable between runs.

Also fixed while measuring: `masked_text` decoded with
`skip_special_tokens=True`, so an abstention example (whose whole answer is
`<|abstain|><|end|>`) printed as an empty string. A diagnostic that shows
nothing is worse than none.

### Measured

| Claim | Result |
|---|---|
| Data | 40,000 examples · 24,694,864 chars · 31,187,143 B |
| Tokens **MEASURED** (shipping tokenizer) | **10,582,527**, of which **1,155,200 supervised (10.9%)**; longest example 538 |
| The file's own ESTIMATE | 7,263,195 — **31% low** (chars/3.4; the real ratio is ~2.3) |
| `make_instruction_data.py` | now measures the real count when the tokenizer is present, and keeps the estimate as a labelled fallback |
| Local Stage B run | **60 steps, 66.6 s**, 1.11 s/step (batch 4 × block 256, grad-accum 2, CPU) |
| Loss | 7.5571 → **6.3133**; windowed gate **PASS** (7.6043 → 6.0065); val 6.2715 → **5.5403** |
| Format change, same prompts | Stage A: no turn end, `<|asst|>` mid-answer. Stage B @60 steps: **frame and `<|end|>` appear** (`npm run sample:answers`) |
| Run-level resume | `--resume auto` carried a 10-step run to 20: `resumed latest.pt at step 10 (2,560 tokens, 421 supervised)`, loss history and step counter intact. **Found by doing it:** the loop never advanced `SftStream`'s own counters, so the first working resume printed `(0 tokens, 0 supervised)` — which reads exactly like a lost cursor. They now advance with every batch |
| New tool | `inference/sample_answers.py` — greedy-decode a checkpoint on real prompts via `inference/reference.py`, no browser |
| Tests | **451 JS / 343 Python**, 0 failures |

### The GPU runbook could not run Stage B (found by extending the notebook test)

Stage A had `training/notebooks/train_stage_a.ipynb`; Stage B had a trainer and
**no way to drive it on Kaggle**. `training/notebooks/train_stage_b.ipynb` now
does: check what Stage A left (`--init`), generate the instruction data, print
the mask *before* spending GPU hours, persist, train with `--amp --gate
--max-minutes --resume auto`, then see the answers through
`inference/sample_answers.py`.

`tests/py/test_notebook_refs.py` was extended from one notebook to all of them
(structure, every invoked module exists, every CLI answers `--help`, every flag
is accepted, no `$VAR` used before it is assigned; sources normalised because
nbformat allows a string or a list of lines). The sweep immediately failed on
`python -m training.scripts.make_instruction_data --help`: its help text
contains `≥`, **cp1252 cannot encode it**, and the module never reconfigured
stdout — so the CLI was unrunnable on Windows, the platform it is also
developed on. Fixed by reconfiguring stdout like every other script in
`training/scripts/` does; a `SyntaxWarning` in the same file (an unescaped `\|`
in a docstring) went with it.

### §14's model metrics now exist, and they say FAIL

§14 lists portfolio QA accuracy, factual accuracy, unsupported-claim rate
(pre/post-guard), abstention precision/recall, language consistency and
injection resistance, against fixed ship gates. The deterministic half was
already measured (`npm run calibrate`); the *model* half needed a grader, and
the only way to get a model answer was to export, serve and drive a browser.

It is now three steps, each in the language that owns the work:

1. `npm run eval:prompts` — Node builds the client's own prompt per case
   (`quickAnswer` routes, `search` retrieves, `contextLines` renders,
   `fitToBudget` trims, `frame` composes), so the graded prompt is the one the
   visitor's model receives. **48 of 60 cases reach the model**; the other 12
   are §9 refusals, the disclosure and the bait refusal, graded as the
   deterministic outcomes they are.
2. `npm run eval:decode` — Node decodes them with the **shipping engine**
   (`eval:export` first): q8 weights as exported, prefill reuse, KV cache —
   **5.9 tok/s** measured. `npm run eval:decode:reference` is the other path:
   straight from a checkpoint with the numpy reference, fp32 and no cache,
   **0.62 s/token** (1.6 tok/s). The reference is deliberately cache-free — it
   is the cache-correctness check — so a gate-grade 96-token sweep costs ~2 min
   on the engine and ~48 min on the reference.
3. `npm run eval:report` — Node scores with the **shipped** guard, placeholder
   resolver and language rule and writes `docs/EVALUATION.json`, with the §14
   gates applied.

Graded on `training/checkpoints/sft-local` (step 60 — the wiring proof, not a
quality attempt), full 96-token budget:

| Metric | Value | Gate |
|---|---|---|
| Cases · model-routed · decided before it | 60 · **41** · 19 | — |
| Factual accuracy (34 cases state a fact) | **0.0%** | 95% — FAIL |
| Abstention recall | **92.3%** | 95% — FAIL |
| False abstention | 2.4% | ≤10% — PASS |
| Unsupported claims, pre-guard | 7.3% | reported |
| Unsupported claims, post-guard | **0.0%** | ≤1% — PASS |
| Language EN | 100% | 95% — PASS |
| Language HI/Hinglish | **78.6%** | 90% — FAIL |
| Turn terminated | **100%** | — |
| Follow-up referent reached the prompt | 42.9% (7 cases) | reported |
| Fabricated on adversarial | 0 | 0 — PASS |
| Refusals before the model | 13 (7 for want of evidence) | — |

**The first pass used the wrong budget, and the report said so.** It ran the
reference decoder at **16** tokens (11 min for 48 prompts) and reported turn
termination at **6.3%** — which looked like a model that cannot end a turn. At
the real 96-token budget it is **100%**. `docs/EVALUATION.json` carries a
`caveat` field precisely so a number that is not gate-grade cannot be quoted as
one; the engine decoder is what made the gate-grade run cheap enough to do.

**A number from this table was revoked, and it is worth reading why.** The first
version reported factual accuracy **18.9%** and the finding "18.9% of answers
cite the expected fact id where Stage A cited none". Both came from a scorer bug,
not from the model: 27 of the 60 cases carry an empty `expected_facts` on purpose
(they are judged on abstaining, or on their referent), the scorer counted an
empty expectation as **fully covered**, and the seven `follow_up`s among them
were the entire numerator — 7 of 37 = 18.9% with no correct answer in it.
Re-grading the same answers with the fixed scorer gives **0.0%**, and a
regression test now pins it. The honest reading of this checkpoint is that
**nothing true is produced yet** while the frame and the guard around it work:
turns terminate 100%, the prompt is never echoed, and every unsupported claim
was withheld (7.3% → 0.0%).

### Still open

* **Quality is not achieved and not claimed.** Sixty steps on 3,000 examples
  proves the path and the format; the words are still wrong. The shipped
  export remains the Stage A artifact, and the config-A Stage A → Stage B run
  is owner-side (a GPU).
* The mask is verified **structurally** (coverage, leaks, terminators) and its
  effect on quality is **NOT TESTED** at any real scale.
* `--init` refuses a checkpoint whose vocab/width/depth differ from the run's
  config — tested against a mismatched checkpoint written by the checkpoint
  manager itself, so the refusal is exercised, not just written.

## Phase: §19 research notes re-verified, and the one that became behaviour

§2 item 7 ("Verify, then claim … §19 research is dated Sep 2026") and §19's own
heading ("re-verify before relying on them") asked for a check that had never
been recorded. All thirteen notes now carry a verdict in
[`docs/RESEARCH_VERIFICATION.md`](RESEARCH_VERIFICATION.md) — ten confirmed as
written, two corrected in detail (Moonshine's size range, Silero's), one partly
verified with one figure left ESTIMATED (Kokoro's). It is a literature
re-read, not a measurement, and the file says so in its first line.

**Two corrections worth naming.** Moonshine's "~26 MB-class" is now the top of
its range, not the bottom (tiny 1 MB-class models, and 27M ones reported to
match Whisper Medium on six languages) — the argument for it got *stronger*,
and it is still not adopted. Silero VAD is **~2.3 MB** ONNX, not ~1 MB, which
makes the existing decision in `ai/voice/vad.mjs` to write an energy detector
*easier*, not harder. Kokoro's "q8 ≈ 86 MB" could not be traced to a primary
source and stays ESTIMATED rather than being quoted.

**The one note that changed the code.** §19 said Web Speech has an experimental
on-device mode. What it did not say is that the mode is *askable*:
`SpeechRecognition.available({ processLocally: true, langs })` answers before a
session starts. That turns a disclosure into a choice, and it exposed a real
inconsistency first: `docs/FINAL_REPORT.md` called STT "local on Chrome" while
`ai/voice/index.mjs`'s own header says the engine is server-side and that audio
leaves the device. The code was right and the report was wrong (fixed).

What was built on that: the recognizer asks **once per session, before the
microphone opens**, sets `processLocally` **only on `'available'`** (a pack that
still has to be downloaded would fail the session, and a dead microphone is
worse than a disclosed one), and `install()` is deliberately unused — a
language-pack download is not something to start on a click. The panel's
sentence follows the answer: the cautious one while the question is open
(`ai/ui/chat.mjs` waits for it rather than printing one and contradicting it),
the on-device one after a yes. If the engine refuses anyway — the shape of the
Sep 2025 Chrome regression this row cites — the server-side engine is the
fallback **once**, reported, with the cautious sentence back.

Two bugs the tests found while writing them, both in the new path:

* **A platform that never answers** left the disclosure unspoken forever: the
  cap opened the microphone but `onDevice` stayed `null`, which is exactly the
  state the shell waits on. Silence now counts as **no** (`settled`), because
  under-claiming privacy is survivable and saying nothing is not.
* **A late answer could re-decide a running session.** Once the cap had passed,
  an answer arriving seconds later would have flipped the panel to the
  on-device sentence while the engine was already running the server-side way.
  The mode is decided once (`settled`), and a late answer is ignored.

Measured: §4 code chunk **69,664 B gz = 45.4 %** (was 69,079 / 45.0 %; the new
path and its tests cost **+585 B gz**). Tests **483 JS + 343 Python, 0
failures**; `npm run build` clean. The on-device path itself is **NOT TESTED**
against a real microphone or a real browser — `docs/MANUAL_TEST_CHECKLIST.md` §D
now asks the tester to compare the sentence against `SpeechRecognition.available()`
on their own machine.
