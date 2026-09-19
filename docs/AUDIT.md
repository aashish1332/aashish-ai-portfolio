# AUDIT — Aashish AI (Phase 0)

**Audit date:** 2026-09-19 · **Repo:** `D:\code\newportfolio` · **Auditor:** Cline (AI agent session)
**Scope:** detect, never assume (§0.2). Nothing in this document is guessed; every claim is
traceable to a file, a command output or a measurement. Provenance tags: **MEASURED**,
**ESTIMATED**, **NOT TESTED**.

> Phase 0 gate (§16): *`docs/AUDIT.md` + baseline JSON exist.* This file + `docs/BASELINE.json`
> satisfy that gate. **No AI feature code has been written yet.**

---

## 1. Repo facts

| Fact | Finding | Evidence |
|---|---|---|
| Git repository | **No.** `fatal: not a git repository` — Phase-0 rule 3 (`git status` first, branch `feature/aashish-ai`) cannot be satisfied as-is | `git rev-parse --is-inside-work-tree` |
| Git identity | Global `user.name` / `user.email` **not configured** | `git config --global user.name` → empty, exit 1 |
| Framework | **None.** Plain static HTML + ES modules. No React/Vue/Svelte/Next/Vite/Astro | `index.html` (26.8 KB) |
| Package manager | **npm** (a `package.json` was added in the previous session; `package-lock.json` 52.6 KB, `node_modules/` present) | `package.json`, `package-lock.json` |
| Bundler | **None.** No build step, no `dist/`, no minified output. Three.js + GSAP + Lenis load from CDN via `<script>` and an import map | `index.html:6-11`, `index.html:473-476` |
| Routing | Single page (`/` → `index.html`); no client router. Anchor navigation via `lenis.scrollTo` | `dev-server.mjs`, `js/director.js:42` |
| Design system | Hand-written CSS only: `css/style.css` (35.0 KB). No Tailwind/UI library | `css/style.css` |
| TypeScript / linting | **None.** Plain `.js` / `.mjs`, no tsconfig/eslint/prettier config | repo scan |
| Tests | **No test runner.** Only ad-hoc puppeteer probes (`dev-*.js`) | repo scan |
| Deployment target | **Unknown / NOT TESTED.** No `netlify.toml`, `vercel.json`, `CNAME`, `wrangler.toml`, `.github/workflows`, `_config.yml`, `robots.txt` or `sitemap.xml` anywhere in the repo | recursive config scan (only `node_modules` hits) |
| Service worker | **None** | same scan |
| Analytics | **None.** No gtag/GA/Plausible/Umami/PostHog/Clarity/Fathom in `index.html` | `index.html` grep |
| Existing AI code | **None.** Zero hits for wasm/onnx/gguf/tensorflow/transformers/webgpu/`Worker(`/`SpeechRecognition`/`speechSynthesis`/`knowledge` across `js/` | `js/*.js` grep |

### 1.1 Third-party runtime dependencies (all CDN, runtime, unpinned by integrity hash)

| Library | Version | Delivered via | Loaded at |
|---|---|---|---|
| three | **0.170.0** | import map → `cdn.jsdelivr.net` | `index.html:9-10` |
| troika-three-text | 0.52.0 | import map | `index.html:11` |
| gsap | **3.12.5** | classic `<script>` | `index.html:473` |
| gsap/ScrollTrigger | 3.12.5 | classic `<script>` | `index.html:474` |
| gsap/Observer | 3.12.5 | classic `<script>` | `index.html:475` |
| lenis | **1.1.14** | classic `<script>` (global `Lenis`) | `index.html:476` |
| Google Fonts | Bebas Neue, Space Grotesk, JetBrains Mono | `<link rel=stylesheet>` | `index.html:22-24` |

**Consequence for the AI layer (§9.3):** there is no bundler, so every AI asset must be a plain
file fetched by `fetch()`/`import()` from the site origin — and nothing AI may appear in
`index.html`. Also: no provenance hashes exist for the CDN libs, so a supply-chain change in
`three`/`gsap` silently changes the baseline. Flagged as a risk in §7.

---

## 2. Load order and control flow (MEASURED from `index.html` + `js/`)

```
index.html
 |- <script type="importmap">            three 0.170.0 . three/addons . troika-three-text
 |- Google Fonts (preconnect + css2)
 |- css/style.css                        (35.0 KB, hand-written)
 |- DOM: boot overlay, film canvas #filmgl, chapters, scenes, credits, contact form
\- scripts, in this exact order:
     473  gsap.min.js            -.
     474  ScrollTrigger.min.js    | classic scripts, globals on window
     475  Observer.min.js         |
     476  lenis.min.js           -'
     478  js/util.js             (lerp/timecode helpers)
     479  js/film-details.js     <- ES MODULE, loads FIRST of the modules
     480  js/sound.js
     481  js/glass.js
     482  js/terminal.js
     483  js/tesseract.js
     484  js/director.js
     487  js/film3d.js           <- WebGL film (imports three via import map)
     488  js/fluidlens.js        <- FluidGlass lens
     489  js/main.js            <- Boot orchestration (DOMContentLoaded)
```

**Two parallel systems share one page:**

| Layer | File(s) | Role |
|---|---|---|
| Film / 3D | `js/film3d.js` (52.3 KB) | Three.js city, adaptive quality governor, colour grade |
| Details overlay | `js/film-details.js` (21.1 KB) | Small-details pass, drawn inside the film's rAF |
| Choreography | `js/director.js` (12.5 KB) | GSAP + ScrollTrigger scenes, owns the Lenis instance |
| Canvas interlude | `js/tesseract.js` (4.7 KB) | 2D canvas, `ScrollTrigger.onToggle` start/stop |
| Lens | `js/fluidlens.js` (11.3 KB) | FluidGlass cursor lens, own rAF loop |
| Shell | `js/main.js` (9.3 KB) | Boot order, cursor, HUD, contact form |
| Card glass | `js/glass.js` (12.0 KB) | GlassSurface |
| Terminal | `js/terminal.js` (8.8 KB) | Ctrl+K terminal |
| Sound | `js/sound.js` (2.1 KB) | WebAudio blips |
| Scrubber | `js/scrubber.js` (2.2 KB) | present, but **not referenced** from `index.html` |

## 3. The four hooks §12 depends on — exact locations

| Need (§12) | Current reality | Location |
|---|---|---|
| **GSAP ticker** (the single frame clock the governor must reuse) | **Exists, shared.** Cursor lerp, perf HUD and Lenis all ride `gsap.ticker.add` | `js/main.js:42`, `js/main.js:127`, `js/director.js:37` |
| **Lenis instance** | **Exists, but module-private** — `S.lenis` inside a closure in `director.js`; only `Director.goTo()` is public | `js/director.js:35-42` |
| **`lenis.stop()` when the AI panel opens** | **Not possible today** — no accessor exposed. Needs a tiny `Director` hook in Phase 2 | `js/director.js` |
| **Three.js `setQuality` / `pause` / `resume`** | **Partially exists.** `Film3D.forceTier(i)` + internal `GOV` ladder exist; **no `setQuality('low')`, no `pause()/resume()`** | `js/film3d.js:80-104`, `:1190-1194` |
| **Render loop** | Own rAF (`raf = requestAnimationFrame(tick)`) inside `film3d.js` — **not** the GSAP ticker | `js/film3d.js:1091`, `:1095` |
| **`Film3D` public API** | `init`, `set`, `isReady`, `govStatus`, `detailsLive`, `forceTier` | `js/film3d.js:1185-1195` |
| **Governor tiers** | Resolution-only ladder; bloom and mirror *never* switch off (they only soften) | `js/film3d.js:69-75` |
| **Details layer** | `window.FilmDetails = { init, perFrame, isLive }`, drawn from the film's rAF — *"zero extra loops"* | `js/film-details.js:524`, `js/film3d.js:1179-1180` |

**Governor behaviour that matters for the §4 budgets (MEASURED):**
`GOV.tier` starts at 0 on desktop / 2 on mobile; `LOWEND` (≤4 threads or ≤4 GB) starts at 1.
It samples frame deltas in its own rAF, down-shifts when `avg > 22 ms` **or** ≥6 of the last 30
frames exceed 42 ms, and up-shifts only when `avg < 18.0 ms` with ≤2 spikes (`js/film3d.js:106-146`).

> **This is the single most important interaction in the project:** the portfolio *already*
> self-degrades to protect 60 fps. Any AI frame cost pushes the film further down the ladder — and
> the baseline below shows it is **already pinned at tier 4 · SURVIVAL · 50 %** on this machine.
> The AI therefore has **no headroom to spend**. §6.3's degrade ladder must be driven from these
> same numbers, and the AI must stay useful at tier 4, not merely at tier 0.

---

## 4. Baseline metrics — MEASURED (Phase 0 gate artefact)

**Artefact:** `docs/BASELINE.json` · **Command:** `npm run baseline` (`node dev-baseline-probe.js`)
**Probe:** `dev-baseline-probe.js` — CDP `Network` for bytes/requests, `PerformanceObserver` for
LCP + long tasks, and **the app's own `gsap.ticker`** for frame deltas during a scripted 30 s scroll
(the probe adds no rAF loop to the app).

### 4.1 Environment (reference profile **R1** — your dev laptop)

| Field | Value | Note |
|---|---|---|
| GPU | `ANGLE (Intel, Intel(R) HD Graphics 520 (0x00001916) Direct3D11 vs_5_0 ps_5_0, D3D11)` | **MEASURED** — matches the brief's i5-6300U / HD 520 rig |
| Hardware threads | 4 | MEASURED |
| `deviceMemory` | 8 | MEASURED (Chromium coarse hint) |
| Browser | HeadlessChrome 153 (new headless) | MEASURED |
| `devicePixelRatio` | 1 | MEASURED |
| `navigator.gpu` (WebGPU) | present | MEASURED — adapter **NOT validated**; HD 520 likely reports a software/null adapter (**NOT TESTED**) |
| `prefers-reduced-motion` | **reduce** | ⚠️ Headless Chrome defaults to `reduce`, so the film's `REDUCED` branch (`js/film3d.js:33`) and the flash skip (`js/main.js:174`) were **active in this run**. A non-reduced run is still required — §7 R5 |
| `effectiveType` / `saveData` | `4g` / `null` | MEASURED |

### 4.2 Initial load (no AI code present — this *is* the "+0 requests" reference)

| Metric | Value | Provenance |
|---|---|---|
| Requests | **51** (39 third-party) | MEASURED (CDP `encodedDataLength`) |
| Total transferred | **606.9 KB** (621,445 B) | MEASURED |
| JS | **472.2 KB** (483,484 B) across 28 files | MEASURED |
| CSS | 35.7 KB (2 files) | MEASURED |
| Document | 26.4 KB | MEASURED |
| Fonts | 72.7 KB (4 files) | MEASURED |
| Images | 16 requests, 0 B | MEASURED (lazy / CSS-drawn) |
| **LCP** | **972 ms** | MEASURED (`largest-contentful-paint`) |
| DOMContentLoaded / load | 1274 ms / 1279 ms | MEASURED |
| TBT proxy | **2391 ms** (3 long tasks; max **1847 ms**) | **ESTIMATED** — sum of ≥50 ms long tasks, *not* Lighthouse TBT |
| Lighthouse TBT / LCP (official) | **NOT TESTED** | needs the `lighthouse` CLI |

> The single 1847 ms long task is the boot block (city build + Three.js fetch/compile). Relevant to
> §4's "+0 requests; LCP/TBT within noise of baseline" rule: the AI launcher must not add a second
> long task on top of an already-poor 2391 ms.

### 4.3 Scripted 30 s scroll — the number the AI must not damage

| Metric | Value | Provenance |
|---|---|---|
| Frames sampled | 930 | MEASURED |
| Median frame time | **30.4 ms** (≈ **32.9 fps**) | MEASURED |
| Mean | 31.0 fps | MEASURED |
| p95 frame time | **49.5 ms** | MEASURED |
| Frames > 20 ms | **900 / 930 = 96.8 %** | MEASURED |
| Main-thread busy | 1.67 % | ESTIMATED (long-task ms / wall ms; excludes sub-50 ms tasks) |
| Governor after scroll | **tier 4 · SURVIVAL · res 50 % · mirror 192 px** | MEASURED |
| Film progress | p 0.000 → **0.985** (the scripted scroll did cover the whole reel) | MEASURED |
| Page / console errors | **none** | MEASURED |

**Interpretation (honest, not flattering).** On R1 the portfolio baseline is **~31 fps median, not
60**, and the governor rests at its final tier. The *"hold 60, never below 30"* contract written in
`js/film3d.js:40-49` is **not met on this hardware**. Consequences for the §4 AI budgets:

- *median FPS drop ≤ 10 % vs baseline* ⇒ AI must keep the median **≥ ~29.6 fps** on R1.
- *p95 frame time ≤ 1.5× baseline* ⇒ AI must keep p95 **≤ ~74 ms** on R1.
- Because the film is already at tier 4, §6.3's degrade **step 3** ("lower scene quality") has
  **no room left** on R1 — the AI's only real levers here are steps 1, 2 and 4.

---

## 5. Knowledge sources (§1) and PII

### 5.1 CV — located and parsed ✅

| | |
|---|---|
| Path in the brief | `Documents/Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx` |
| **Actual path** | **`C:\Users\HP\OneDrive\Documents\Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx`** (30,319 B — `%USERPROFILE%\Documents` is OneDrive-redirected) |
| Parsed? | **Yes** — `word/document.xml` extracted + tag-stripped; no python-docx dependency needed |
| Copied into the repo? | **No.** Extracted text sits at `D:.cv-raw.txt` (repo root, leading dot) and contains PII — delete before any commit; it is git-ignored |

**Facts harvested (raw list for `knowledge.json`; not yet schema-mapped):** name; email
`aashishkumarrajut1345@gmail.com`; phone `+91 6280287425`; LinkedIn; GitHub; skills
(languages Python / C / C++ / Java / JavaScript / HTML5 / CSS3 · frontend React / Next.js /
Tailwind / Vite · backend Node / Express / REST · DB MongoDB / MySQL / PostgreSQL / Mongoose ·
AI-ML Gemini AI, Groq Llama 3.3 70B · security JWT / bcrypt / CORS / rate limiting · tools Git /
GitHub / VS Code / npm / Postman / Vercel · soft skills); 3 projects (Community Volunteer
Management Jul-2026 · Smart Grocery List Generator May-2026 · Goal Tracker SaaS Mar-2026), each with
tech stack + bullet evidence; training (AI-Driven MERN Bootcamp, 11 Jun – 15 Jul 2026, Grade A);
certificates (Infosys Springboard DBMS 4 Jul 2026 · Programming Using C++ 26 Jul 2025 · Minor in AI,
Masai School × IIT Ropar, CGPA 6.93, Jan–Nov 2025); education (LPU B.Tech CSE Full Stack,
Aug 2024–present, CGPA 8.28 · Kendriya Vidyalaya No. 2 RCF Hussainpur, Senior Secondary CBSE
2023–24, 87.6 %).

### 5.2 Portfolio copy vs CV — conflicts for `knowledge/CONFLICTS.md` (Phase 1)

| Portfolio claim (source) | CV status |
|---|---|
| `index.html:116` marquee — *"90+ API ENDPOINTS", "40+ TABLES MODELED"* | Those figures belong to the Community Volunteer Management project only; the marquee generalizes them into personal totals |
| `index.html:296` — *"Cart, order history, CSV export, replenishment alerts"* | ✅ matches Smart Grocery List Generator |
| `index.html:384` credits — *"THREE.JS · GSAP · WEBAUDIO"* | Describes **this portfolio**, not Aashish's skill set — must not become a skill fact |
| `index.html:116` — *"AI-ASSISTED · HUMAN-DIRECTED"* | CV says work was *"AI-generated code guided by self-defined requirements"*. Consistent, but §8.4 forbids capability inflation: the AI must phrase it exactly as the CV does, never as "built it alone" |
| Project dates Jul-2026 / May-2026 / Mar-2026 | ✅ match |
| CGPA 8.28 | ✅ match |

**Note:** the portfolio was originally built from `Aashish_kumar_CV_ats_optimized_final_v3.docx`
(lowercase `kumar`) — a *different file* from the authoritative one named in the brief. Both exist
(`Downloads` also holds a 39,510 B `..._FINAL_v3.docx`). Phase 1 must use the brief's path and diff
it against the copy the portfolio's copy was written from.

### 5.3 PII review preview (§1 — your approval needed in Phase 1)

| Field | Proposed `public` | Reason |
|---|---|---|
| email | **true** | already public at `js/main.js:26` (mailto) |
| GitHub / LinkedIn | **true** *if* the portfolio already renders them | verify in Phase 1 |
| phone `+91 6280287425` | **false** | CV-only today; §1 default |
| home address / DOB / ID numbers | **false** | absent from the parsed CV entirely |
| CGPA / percentages | **true** | present in both CV and portfolio; confirm you want them answerable |
| Bootcamp grade "A" | **true** | low sensitivity |
| Third-party names (Gemini, Groq, Infosys, Masai × IIT Ropar, LPU, Kendriya Vidyalaya) | **true** | education/employer-style facts already in the CV |

---

## 6. Constraints, conflicts and things the brief did not know

### 6.1 Brief vs reality — corrections

| Brief says | Reality | Action |
|---|---|---|
| *"`git status` first, branch `feature/aashish-ai`"* | No git repo; no git identity configured | see §7 R1 |
| *CV at `Documents/…`* | OneDrive-redirected path | use the resolved path (§5.1) |
| *"no new rAF loops"* | True of the AI — but the app **already** runs 3 rAF loops (`film3d.js:1091`, `fluidlens.js:213`, `tesseract.js:79`) plus the shared GSAP ticker | AI adds **zero** loops; frame monitoring rides `gsap.ticker` |
| *§12 "add `setQuality`/`pause`/`resume` to the existing scene module"* | `forceTier()` exists; no pause/resume, no `setQuality` | small additive hook in Phase 2 |
| *§6.3 "reuse the existing GSAP ticker"* | Correct — `gsap.ticker` is shared by Lenis + cursor + HUD (`main.js:42/127`, `director.js:37`) | available ✅ |
| *§4 launcher ≤ ~2 KB gz; +0 AI requests on load* | Baseline floor is **51 requests / 606.9 KB / LCP 972 ms** | the number to beat |

### 6.2 Rule conflicts I am flagging instead of silently resolving

1. **N1 / N8 vs the visual work in flight.** Immediately before this brief arrived, the session was
   mid-pass on a *visual enhancement* of `js/film3d.js` (window-cell size, texture brightness,
   bloom). N1 requires the portfolio to stay visually intact. **Decision needed:** keep, revert, or
   re-verify those edits before AI work continues?
2. **"No added frame cost" is stricter here than the brief assumes.** Because the governor already
   rests at tier 4 on R1, *any* AI cost is a direct regression with no ladder headroom left. That
   makes §9.1's default (CPU/WASM-SIMD in a dedicated worker, 1 thread) a **hard requirement** on
   T1–T2 here rather than a preference.
3. **`MODEL_STATUS=untrained`.** Per rule 4, nothing beyond the deterministic Quick Answers engine
   may be presented as "AI" until real checkpoints exist; Kaggle T4 training is **run by you** from
   scripts/notebooks I write.

---

## 7. Risks register

| # | Risk | Severity | Mitigation / owner |
|---|---|---|---|
| **R1** | No git history ⇒ no safe revert; rule 3 (small commits on a branch) impossible | **High** | `git init` + `.gitignore` + baseline commit — **blocked on your git identity** |
| **R2** | AI main-thread cost while the film sits at tier 4 ⇒ visible regression on R1 | **High** | worker-only AI; frame-health EMA off `gsap.ticker`; early fall to Quick Answers (step 4) |
| **R3** | PII leaking into the public bundle (email/phone in `knowledge.json`) | **High** | `public:false` defaults + Phase 1 PII review; never ship `.cv-raw.txt` |
| **R4** | CDN libs fetched at runtime with no `integrity` hash (`three`, `gsap`, `lenis`) ⇒ an upstream change silently shifts the baseline and can break the AI hooks | Medium | versions pinned in this audit; consider `integrity=`/vendoring later (out of Phase 0) |
| **R5** | Baseline measured under headless `prefers-reduced-motion: reduce` ⇒ may under-represent a real visitor's frame cost (reduced motion is cheaper, so the true baseline is likely **worse**) | Medium | re-run `npm run baseline` in headed Chrome; add a manual phone/laptop pass to `docs/MANUAL_TEST_CHECKLIST.md` |
| **R6** | No deployment target found ⇒ §9.3 caching, COOP/COEP and the "static site" claim are unverifiable | Medium | **you to confirm** the host (GitHub Pages / Netlify / Vercel / other) |
| **R7** | Leftovers from the corrupt-session recovery pollute the repo (`film3d_recovered_0.js`, `film3d_firsthalf_f_001ac2.txt`, `dev-*.txt`/`*.log`, `shots/`, 701 KB `dev-fps-last.png`) | Low | `.gitignore` them; delete on your word |
| **R8** | `js/scrubber.js` is not referenced from `index.html` — dead or future code? | Low | confirm in Phase 1; don't touch |
| **R9** | Stale comment: `js/film3d.js:41-49` claims tiers switch mirror/bloom **off**, but `GOV.tiers` (`:69-75`) is resolution-only | Low | comment correction only; no behaviour change |

---

## 8. Phase 0 gate result

| Gate requirement (§16) | Status |
|---|---|
| Repo audited | ✅ this file |
| CV located + parsed | ✅ `C:\Users\HP\OneDrive\Documents\Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx` |
| Baseline metrics (§15) captured | ✅ `docs/BASELINE.json`, reproducible via `npm run baseline` |
| `docs/AUDIT.md` exists | ✅ |
| Baseline JSON exists | ✅ |

**Blocked / awaiting your input**
1. **Git identity** — needed before branch `feature/aashish-ai` + baseline commit (R1).
2. **Keep, revert or re-verify the in-flight `film3d.js` visual enhancement** (§6.2 item 1).
3. **Deployment host** (R6) — affects §9.3 caching and the static-site claim.
4. **PII approval** — the §5.3 table.

**Next — Phase 1 (Knowledge, §16):** `knowledge.json` per §8.1, PII review, BM25 + alias retrieval
index, the §8.3 deterministic language detector (≥100 test cases), and Quick Answers templates in
EN / HI / Hinglish. Phase 1 needs **no model, no GPU and no download**.