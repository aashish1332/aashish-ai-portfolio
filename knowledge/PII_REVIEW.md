# PII REVIEW — for your approval (§1)

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
| 5 | **Phone** | `contact.phone` | `+91 6280287425` | ✅ **yes — flagged** | `index.html:447` |
| 6 | **Location** | `contact.location` | Phagwara, Punjab, India | ✅ **yes — flagged** | `index.html:447` |
| 7 | Availability | `contact.availability` | Open to internships & roles | ✅ yes | `index.html:447` |
| 8 | GitHub | `link.github` | `github.com/aashish1332` | ️ intended, **markup is a placeholder** | CV rels rId7; `index.html:443` ships `github.com/` |
| 9 | LinkedIn | `link.linkedin` | `linkedin.com/in/aashishkumar13/` | ⚠️ intended, **markup is a placeholder** | CV rels rId6; `index.html:444` ships `linkedin.com/` |
| 10 | Project live URLs | `project.*.links[]` | 3 × `*.vercel.app` |  not in the portfolio (CV only) | CV rels rId8/9/10 |
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

- Facts flagged `public: true`: **all of them** (0 entries are `public:false`)
- Rationale: every shipped fact is sourced from the CV **or** already published by the live
  portfolio. Nothing new is being exposed. Verified with an automated test (`tests/knowledge.test.js`).

---

## ⚠️ The two decisions I need from you

**1. Phone number.** §1 says *"Default `public:false` for phone number"* — but your portfolio
already prints it at `index.html:447`. Marking it `public:false` would make the AI *refuse* to state
a number that is visible elsewhere on the same page, which looks broken. I set it `public:true`
and flagged it.
- **(a)** Keep `public:true` (AI can state it) — *current setting*
- **(b)** Set `public:false` (AI deflects: *"his email is the better route"*) — pick this if you
  want the AI to slow down scraping/telemarketing, accepting the inconsistency
- **(c)** Set `public:false` **and** remove it from `index.html:447` — the only fully consistent option

**2. Project live URLs.** These are in your CV but **not** on the portfolio, i.e. the AI would
surface them on the web for the first time.
- **(a)** Keep `public:true` (recruiters can click live demos) — *current setting*
- **(b)** Set `public:false` until you add them to the portfolio yourself

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