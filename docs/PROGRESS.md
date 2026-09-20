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
- **`MIN_TOP_SCORE` is still an unmeasured heuristic** (documented as such in
  `ai/retrieval/index.mjs` and asserted by test). It is now exercised by 55 executable cases,
  so P5 has the data to calibrate it; nothing depends on it silently.
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