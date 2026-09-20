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

**Status:** 🟡 **IN PROGRESS** — data + retrieval inputs + language detection done and tested;
retrieval index and Quick Answers engine still to build. Gate needs your PII sign-off.

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
6. **`tests/`** — **147 tests, all passing** via `npm test`:
   - `language.test.mjs`: **106 frozen classifier cases** (≥100 required by §8.3) + smoothing,
     tokenizer, diagnostics and voice-hint contracts.
   - `retrieval.test.mjs`: §8.2 budget enforcement, abstention on nonsense, fuzzy/variant matching,
     focus-entity carry-over, plus **named regression guards for the four bugs found while building
     it** (see below).
   - `knowledge.test.mjs`: §8.1 schema, unique ids, provenance, project/skill shapes,
     secret-shaped-value scan, CV-file-never-ships, working `publicView` gate, and regression
     guards for C1/C2/C7.

### Bugs found and fixed during Phase 1 (each now has a regression test)

| # | Bug | Why it mattered |
|---|---|---|
| **R1** | Alias text leaked *function words* into the BM25 index. The workflow chunk's alias *"how does he use ai"* was boosted 3×, so `does`/`he`/`use` gave it a **12.36** score for *"which databases does he use"* — beating every real database fact | Idle glue was outranking facts. Fixed with `RETRIEVAL_STOP` = English ∪ Hinglish function words, applied to body **and** alias tokens |
| **R2** | *"uska naam kya hai"* retrieved **nothing** — no chunk contained `naam`/`name` | The single most likely first question from a Hinglish visitor. Fixed by adding `naam`/`name`/`पूरा नाम` index terms |
| **R3** | Skill chunks indexed their editorial `note` text, so the phrase *"…not by the CV's skills list"* put the word **skills** inside exactly two skill chunks — *"uske skills kya hain"* returned `skill.threejs` | Editorial meta must never be searchable. `note` is now excluded from chunks |
| **R4** | *"where does he study"* retrieved **nothing** — no `study` index term (only Devanagari `पढ़ाई`) | Fixed by adding `study`/`studies`/`education`/`degree`/`padhai` |
| **R5** | **Focus entity was wrong.** A pronoun follow-up *"uska database kaun sa tha?"* (="what was **its** database?") switched focus to `cert.dbms` because the literal word "database" matched — instead of staying on the project under discussion | This is precisely the §8.2 follow-up case. A pronoun now **locks** focus; only an outright entity name can move it |

### Measured
| Metric | Value |
|---|---|
| Test suite | **147 pass / 0 fail** (`npm test`) |
| Classifier cases | 106 (10 Hindi · 5 Hindi+Latin code-mix · 35 Hinglish · 35 English · 8 no-function-word · 5 empty · 8 English-collision traps) |
| Retrieval index | 60 chunks · 398-term vocabulary · avgdl 31.8 (built from 54 facts) |
| Retrieval budget | enforced in code: ≤ 3 chunks, ≤ 300 context tokens — verified by test |
| Retrieval correctness probes | *"uska naam kya hai"*→`person.name` · *"where does he study"*→`edu.lpu` · *"which databases does he use"*→`cert.dbms`/`skill.mysql`/`skill.mongoose` · *"volunteer os"*→`project.volunteer` · *"contact email"*→`contact.email` · *"quantum physics homework"*→**abstains** |
| Detection cost | pure regex + Set lookups (**ESTIMATED**, not yet instrumented) |

### Still open
- **DECIDED (delegated):** you asked me to "do what is best for quality and performance", so the two
  PII questions are resolved as **`public:true` for both the phone number and the project live
  URLs** — the phone is already printed by the portfolio (`index.html:447`), so refusing it reads as
  broken, and demo links materially help a recruiter. Reversible with a one-line change plus a test run.
- **Remaining Phase 1 work:** the **Quick Answers engine** (§5.1 step 4 — deterministic EN/HI/Hinglish
  templates so the assistant is *usable standalone* on T0 with no model) and its
  `evaluation/portfolio_tests.json` (§14). §16's P1 gate is **not closed** until these exist.
- **C4 open:** bootcamp provider — excluded from answers until you supply it.
- **C5 open:** which of the two CV files is current.
- **Non-AI bug found:** 5 placeholder social links in `index.html` (4 × `https://github.com/`,
  1 × `https://linkedin.com/`) should point to `github.com/aashish1332` and
  `linkedin.com/in/aashishkumar13/`.

### Evidence
`knowledge/knowledge.json` · `knowledge/CONFLICTS.md` · `knowledge/PII_REVIEW.md` ·
`ai/language/detect.mjs` · `ai/retrieval/index.mjs` · `tests/*.test.mjs` · `npm test`