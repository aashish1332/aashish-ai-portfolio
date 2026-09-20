# PII REVIEW — ✅ ANSWERED 2026-09-20 (§1)

**Status: approved by the owner.** Decision 1 = **(b)** phone stays out of the assistant's
answers; decision 2 = **(a)** project live URLs may be answered. Recorded in
`knowledge.json` → `meta.pii_decisions` and enforced in code (see the note under the table).

**What this is.** Everything shipped to the browser is public to every visitor: `knowledge.json`,
prompts and (later) model weights. This file is the complete list of personal data that would ship.
Per §1, `public:false` is the default for phone, home address, DOB and ID numbers.

**Print this to Aashish and get an explicit yes/no before Phase 2 ships anything.**

---

## Currently `public: true` in `knowledge.json`

| # | Field | `id` | Value | Already public? | Evidence |
|---|---|---|---|---|---|
| 1 | Name | `person.name` | Aashish Kumar | ✅ yes | `index.html:100` hero |
| 2 | Headline | `person.headline` | Full-Stack Developer | ✅ yes | `index.html:103` |
| 3 | Class year | `person.class_year` | Class of 2028 | ✅ yes | `index.html:103` |
| 4 | **Email** | `contact.email` | `aashishkumarrajut1345@gmail.com` | ✅ yes | `index.html:442`, `js/main.js:26` |
| 5 | **Phone** | `contact.phone` | `+91 6280287425` | ⛔ **no — owner declined** | `index.html:447` |
| 6 | **Location** | `contact.location` | Phagwara, Punjab, India | ✅ **yes — flagged** | `index.html:447` |
| 7 | Availability | `contact.availability` | Open to internships & roles | ✅ yes | `index.html:447` |
| 8 | GitHub | `link.github` | `github.com/aashish1332` | ️ intended, **markup is a placeholder** | CV rels rId7; `index.html:443` ships `github.com/` |
| 9 | LinkedIn | `link.linkedin` | `linkedin.com/in/aashishkumar13/` | ⚠️ intended, **markup is a placeholder** | CV rels rId6; `index.html:444` ships `linkedin.com/` |
| 10 | Project live URLs | `project.*.links[]` | 3 × `*.vercel.app` | ✅ **approved** (CV only — now also linked from the portfolio's `VIEW THE CUT` CTAs) | CV rels rId8/9/10 |
| 11 | Grades | `ach.lpu-cgpa`, `ach.class12`, `ach.minor-ai-cgpa`, `ach.bootcamp-grade` | 8.28 · 87.6 % · 6.93 · Grade A | ✅ yes | `index.html:132,142,149,150` |
| 12 | Education institutions | `edu.*` | LPU, Kendriya Vidyalaya No. 2 RCF Hussainpur | ✅ yes | `index.html:132` |
| 13 | Certificate issuers | `cert.*` | Infosys Springboard, Masai School × IIT Ropar | ✅ yes | `index.html:149,151,152` |
| 14 | Third-party tool names | `project.*.tech[]` | Gemini, Groq, 21st.dev, Spline.design, MongoDB… | ✅ yes | `index.html:281,309,337,390,393` |

## NOT in `knowledge.json` — and must stay out

| Field | Status | Reason |
|---|---|---|
| Home address / street / PIN code | **absent** | Not in the CV or portfolio at all |
| Date of birth | **absent** | Not present anywhere |
| ID / Aadhaar / passport / PAN | **absent** | Not present anywhere |
| Family details | **absent** | Not present anywhere |
| Salary / compensation expectations | **absent** | §8.4 + persona rules: never give opinions on salary unless in the knowledge base |
| Any password / token / API key | **absent** | §17: no secrets anywhere in the repo or bundle |

## Numeric count

- Facts flagged `public:true`: all except one
- Facts flagged `public:false`: **1 — `contact.phone`** (owner's decision, 2026-09-20)
- Rationale for the rest: every shipped fact is sourced from the CV **or** already published by
  the live portfolio, and nothing new is exposed. Verified by `tests/knowledge.test.mjs`.

### How `public:false` is enforced (not just declared)

A flag that only a reviewer respects is not a gate, so the phone decision is enforced in three
places, each with a test:

1. **`ai/knowledge/view.mjs`** — `publicView()` drops the fact before any engine reads the base.
   The answers path builds its fact map *and* its BM25 index from that view, so a private value
   cannot be retrieved, ranked, or rendered.
2. **`ai/answers/quick.mjs`** — the question is answered with an honest decline that names the
   published route (*"That contact detail isn't published — the best way to reach Aashish is by
   email: …"*), in all three languages, instead of silence. This matters because the portfolio
   itself prints the number at `index.html:447`: a bare abstention would read as broken.
3. **`evaluation/portfolio_tests.json` cases d02/d21** — assert the digits never appear, in
   English and in Hindi, including both Devanagari spellings (`फोन` / `फ़ोन`).
   `tests/quick-answers.test.mjs` QA-9 covers the catch-all contact answer, which previously
   read `kb.contact` directly and would have printed a private field.

**Still open:** the shipped `knowledge.json` must also be reduced to `publicView()` at build time
(§9.3/§17 data hygiene) so the value never leaves the repository — that is the P2 dev/prod step.

---

## ✅ The two decisions — answered 2026-09-20

**1. Phone number → (b): `public:false`.** The assistant declines it and points to the email.
The inconsistency with `index.html:447` is accepted deliberately, to slow scraping and
telemarketing. If you later want full consistency, option (c) is to remove the number from the
portfolio too — one line in `index.html`; the assistant needs no change.

**2. Project live URLs → (a): `public:true`.** Recruiters can open the live demos. They are now
also linked from the portfolio itself (the three `VIEW THE CUT ↗` CTAs), so the assistant is no
longer the only route to them.

---

## Compliance checks (automated)

| Check | Test |
|---|---|
| Every fact has an `id` | `tests/knowledge.test.js` |
| Every fact has `source` ∈ {cv, portfolio} | `tests/knowledge.test.js` |
| Every fact has a `public` boolean | `tests/knowledge.test.js` |
| No fact containing an email/phone is `public:false` **and** silently shipped | `tests/knowledge.test.js` |
| No secret-looking strings (token/key/secret/password) anywhere | `tests/knowledge.test.js` |
| CV file / extracted text never present in the shipped tree | `.gitignore` + `tests/knowledge.test.js` |

**This list is my print-out for your approval. Nothing else in Phase 1/2 should be blocked by it —
but §16's P1 gate requires *"PII list approved"*, so Phase 1 is not formally closed until you
answer the two questions above.**