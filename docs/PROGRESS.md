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
4. **`ai/language/detect.mjs`** — §8.3, no selector, no ML: Devanagari ratio + a Roman-Hinglish
   function-word lexicon + an English stop-word negative signal + turn smoothing where a *weak*
   signal defers and a *strong* one always switches. Includes `voiceHint()` for the §11.4 TTS tier.
5. **`tests/`** — **127 tests, all passing** via `npm test`:
   - `language.test.mjs`: **106 frozen classifier cases** (≥100 required by §8.3) + smoothing,
     tokenizer, diagnostics and voice-hint contracts.
   - `knowledge.test.mjs`: §8.1 schema, unique ids, provenance, project/skill shapes,
     secret-shaped-value scan, CV-file-never-ships, working `publicView` gate, and regression
     guards for C1/C2/C7.

### Measured
| Metric | Value |
|---|---|
| Test suite | **127 pass / 0 fail** in ~0.4 s (`npm test`) |
| Classifier cases | 106 (10 Hindi · 5 Hindi+Latin code-mix · 35 Hinglish · 35 English · 8 no-function-word · 5 empty · 8 English-collision traps) |
| Facts in the knowledge base | 54 |
| Detection cost | pure regex + Set lookups, no allocations per turn beyond the token array — well inside the §4 "≤ 2 ms per-frame AI work" and "no task > 50 ms" budgets (**ESTIMATED** from code shape; not yet instrumented) |

### Still open
- **BLOCKED (2 PII decisions):** phone `public:true` vs `false`; project live URLs `public:true`
  vs `false`. See `knowledge/PII_REVIEW.md`. §16's P1 gate requires *"PII list approved"*.
- **Remaining Phase 1 work:** §8.2 retrieval index (BM25 + alias map + char-n-gram fuzzy + entity
  index + focus entity, top-k ≤ 3, ≤ ~300 tokens) and the Quick Answers engine with EN/HI/Hinglish
  templates, plus its `evaluation/portfolio_tests.json`.
- **C4 open:** bootcamp provider — excluded from answers until you supply it.
- **C5 open:** which of the two CV files is current.
- **Non-AI bug found:** 5 placeholder social links in `index.html` (4 × `https://github.com/`,
  1 × `https://linkedin.com/`) should point to `github.com/aashish1332` and
  `linkedin.com/in/aashishkumar13/`.

### Evidence
`knowledge/knowledge.json` · `knowledge/CONFLICTS.md` · `knowledge/PII_REVIEW.md` ·
`ai/language/detect.mjs` · `tests/*.test.mjs` · `npm test`