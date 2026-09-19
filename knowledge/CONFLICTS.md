# CONFLICTS — CV vs portfolio vs derived facts

Per §1: *"Conflicts go to `knowledge/CONFLICTS.md`; CV wins by default; unresolved conflicting facts
are excluded from answers."*

Status legend: **RESOLVED** (safe to answer) · **EXCLUDED** (never answer) · **OPEN** (needs Aashish)

---

## C1 — "90+ API ENDPOINTS / 40+ TABLES" presented as personal totals — ⚠️ **RESOLVED (reworded)**

| Source | Wording |
|---|---|
| CV | *"Community Volunteer Management … delivering 35 page files across 15 sections, 16 mounted API route groups, and **90+ unique backend endpoints**"* and *"modeled **40+ database tables** with Drizzle ORM"* |
| Portfolio | `index.html:116` marquee — *"90+ API ENDPOINTS ✦ 40+ TABLES MODELED"* (no project attached); `index.html:139-141` stat counters also unattached |
| Portfolio (honest half) | `index.html:144` already adds: *"The three counts above were AI-written to my spec — SHOT 04 has the split."* |

**Resolution:** the numbers are **real but project-scoped**. The AI must always attach them to
Community Volunteer Management. Answering *"I have 90+ endpoints"* as a personal total would
violate §8.4 (invented statistics). The portfolio's own disclaimer already concedes this.

**Required phrasing:** *"In his Community Volunteer Management project: 90+ backend endpoints across
16 route groups, and 40+ database tables modeled with Drizzle ORM."*

## C2 — "THREE.JS · GSAP · WEBAUDIO" in the credits — ⚠️ **RESOLVED (scoped)**

| Source | Wording |
|---|---|
| Portfolio | `index.html:384` credits block, role label *"VISUAL EFFECTS"* |
| CV | skills list does **not** contain Three.js, GSAP or WebAudio |

**Resolution:** this describes **the portfolio you are looking at**, not a CV-listed skill.
`knowledge.json` marks these `source: "portfolio"` with an explicit note. The AI may say Aashish
built this portfolio with Three.js/GSAP; it may **not** present them as CV skills.

## C3 — "AI-ASSISTED · HUMAN-DIRECTED" / attribution strength — ⚠️ **RESOLVED (bounded)**

| Source | Wording |
|---|---|
| CV | Each project bullet: *"…using AI-generated code guided by self-defined UI and feature requirements"* |
| Portfolio | `index.html:133` *"I don't just write code with AI — I architect with it"*; `:251` *"Every project on this reel had AI in the crew"*; `:341` *"NOTHING SHIPPED THAT I HADN'T SPECIFIED, REVIEWED, OR FIXED MYSELF."* |

**Resolution:** consistent across both. The AI must stay inside this framing: spec + architecture +
review authored by him; implementation code AI-generated to that spec. It must never upgrade to
*"he wrote every line"*, and never downgrade to *"the AI did everything"*.

## C4 — Bootcamp provider — 🟡 **OPEN (excluded from answers)**

The CV names the bootcamp *"AI-Driven MERN Stack Bootcamp: Full Stack Development with DevOps &
Real-World Projects"* (11 Jun – 15 Jul 2026, Grade A) but **never names the provider**. The portfolio
(`index.html:150`) also omits it. → The AI must **not** name or guess an institution.
**Excluded until Aashish supplies the provider.**

## C5 — Two different CV files — 🟡 **OPEN**

| File | Size |
|---|---|
| `Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx` (**authoritative** per the brief, in OneDrive Documents) | 30,319 B |
| `Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx` (a copy in Downloads) | 39,510 B |
| `Aashish_kumar_CV_ATS_optimized_final_v3.docx` (lowercase, used to build the original portfolio) | not located on this machine |

The Downloads copy is ~9 KB larger than the OneDrive one — **they may not be the same document.**
Only the OneDrive file was parsed. `knowledge.json` is built **solely** from it plus `index.html`.
**Action:** confirm which CV is current before Phase 4 training data is generated.

## C6 — Resume/portfolio says "Class of 2028" — ✅ **RESOLVED**

Portfolio `index.html:103` says *"CLASS OF 2028"*; CV says B.Tech *Aug 2024 – Present*. A 4-year
B.Tech started Aug 2024 ends 2028. ✅ Consistent.

## C7 — No employment history exists — ✅ **RESOLVED (explicitly empty)**

The CV has a **TRAINING** section and **no** employment section. There are **no** internships,
jobs, clients or freelance engagements anywhere in the CV or the portfolio.
→ `knowledge.json.experience[]` contains **only** the bootcamp (`type: "training"`).
Any question about an internship/employer **must abstain** — this is the single most likely
hallucination-bait area (§14). Covered by tests.

## C8 — Portfolio ships placeholder social links — ⚠️ **RESOLVED (real URLs recovered)**

| Where | Current | Should be |
|---|---|---|
| `index.html:184, 209, 234, 443` | `https://github.com/` | `https://github.com/aashish1332` |
| `index.html:444` | `https://linkedin.com/` | `https://www.linkedin.com/in/aashishkumar13/` |

Real values recovered from the CV's `word/_rels/document.xml.rels`. Answers use the **real** URLs
(which is what he intends to publish). **The portfolio markup still needs fixing** — tracked as a
non-AI bug in `docs/PROGRESS.md`.

## C9 — Phagwara/Punjab vs LPU location — ✅ **RESOLVED**

Both CV and portfolio say Punjab; LPU is in Phagwara. The portfolio publishes *"PHAGWARA, PUNJAB"*
at `index.html:447`. No conflict.

## C10 — Live project URLs are not in the portfolio — ✅ **RESOLVED (kept)**

The three `*.vercel.app` URLs appear **only** in the CV's hyperlink relationships, never in
`index.html`. They are live deployments of his own listed projects → `public: true`.