# PRIVACY — what leaves the visitor's device, and what never does

**Status:** describes the **shipped configuration** as it stands on
2026-09-23. Every claim here is checked against code, and anything not yet
true is marked **NOT YET TRUE** rather than written in the present tense.
Rules come from §1, §2 (N2/N3), §17 and §8.4 of the brief.

---

## 1. The one-line summary

**Nothing the visitor types is sent anywhere, and nothing AI-related runs
until they click "Ask Aashish AI".** The single exception is voice input,
which is opt-in, discloses itself in the panel at the moment it turns on, and
can be declined by simply not using it.

---

## 2. What is sent to a server

| Path | Leaves the device? | Evidence |
|---|---|---|
| Typed questions | **No.** There is no backend, no LLM API, no analytics on chat content | `ai/answers/quick.mjs` is asserted by test to contain no `fetch`, no `XMLHttpRequest`, no dynamic `import()`, no URL |
| Answers | **No.** Composed on the device from `knowledge.json` | same |
| Voice input (SpeechRecognition) | **Yes — the browser's own speech service.** Disclosed once in the panel, in these words: *"Voice mode uses your browser's speech recognition, which sends what you say to your browser's speech service — so while it listens, your audio leaves this device. Typed questions never do."* | `ai/voice/index.mjs` (`SPEECH_DISCLOSURE`), shown on the click that enables voice |
| Voice output (speechSynthesis) | **No.** OS voices are local | §11.4 V0 |
| Model download (P6/P7) | Only the model files themselves are fetched from the static host — **no question, no transcript, no telemetry** | NOT YET TRUE: no model exists yet |
| Page load | The portfolio's own assets only. **+0 AI requests before the click** | `dev-ai-probe.js`, `npm run build` |
| Analytics | **None exists.** No analytics library is loaded and no chat content is sent anywhere | repo-wide grep; AUDIT §"analytics" |

**Consequence to state plainly:** the "runs on your device" promise is true
for the typed experience today, and is true for voice only in the sense that
*the model is local* — the browser's speech recognizer is a network service
in its default mode. The panel says so rather than hiding it. §11.2 S0
(`processLocally`) is the on-device alternative and is not implemented yet.

---

## 3. What is published to every visitor

Everything the browser downloads is public to every visitor, forever. §1
treats that as the definition of the privacy boundary, so the knowledge base
is gated by a `public` flag rather than by "not shown in the UI":

- `ai/knowledge/view.mjs` builds the facts **and** the BM25 index from the
  public view, so a `public:false` fact cannot be retrieved or rendered —
  not merely filtered out at the last step.
- `tools/build.mjs` strips private facts from the shipped
  `knowledge.json` and **fails the build** if a withheld value appears in any
  shipped file in any format.
- The withheld value's *id and aliases* survive the strip (never a value), so
  a question aimed at it still gets the specific decline instead of silence.

**Owner decisions (approved 2026-09-20, `knowledge/PII_REVIEW.md`):**

| Field | Decision |
|---|---|
| Phone number | **withheld** (`public:false`). The assistant declines and redirects to email. `index.html` still prints it as site content — an allow-listed, deliberate exception, reported as a build note |
| Email, GitHub, LinkedIn | public — the portfolio already publishes them |
| Project live URLs | public — the owner approved shipping them so a recruiter can open a demo |
| Home address, DOB, ID numbers | not in the knowledge base at all |

---

## 4. What is never shipped, ever

`tools/build.mjs` allow-lists file by file. The following cannot reach a
visitor:

- the CV file (`.docx`) — it is git-ignored and outside the repo;
- `knowledge/PII_REVIEW.md`, `knowledge/CONFLICTS.md` (they discuss the
  withheld facts and the CV internals);
- the whole Python training side (`ai/tokenizer`, `ai/model`, `ai/data`) —
  the tokenizer artifact's metadata embeds corpus paths;
- datasets, checkpoints, optimizer state, `data/`;
- dev probes and their outputs.

A build that finds a withheld value anywhere, or a dev-only reference inside
a shipped file, is a **failure**, not a warning.

---

## 5. Voice, in detail

- Voice assets load **only** when the visitor picks a voice mode (§11, N6).
- The disclosure is rendered **in the DOM before any transcript can be
  handled** — the ordering is documented in `AI_ARCHITECTURE.md` §11.
- A refused microphone is **never asked for again**: `not-allowed`,
  `audio-capture` and `service-not-allowed` stop the recognizer instead of
  riding the restart loop.
- The microphone cannot outlive the panel: `close()` stops it.
- Continuous listening (T3 only) requires a wake phrase; a sentence without
  it is **dropped in silence** — not answered, not announced, not logged.
- T0 — which is where `saveData` visitors land, because recognition is a
  network service — gets **no voice at all**.

---

## 6. Children, consent, retention

There is no account, no login, no cookie set by the AI, and no storage of
anything the visitor says. The model cache (P6/P7) will hold model files
keyed by version, not conversation. Nothing needs a consent banner because
nothing is tracked; the voice disclosure covers the one path where audio
leaves the device.

---

## 7. What this document does not yet cover

- **No model download path exists**, so the download/caching privacy
  behaviour is unbuilt and untested (P6/P7).
- **No analytics at all** means there is also no way to know if anyone uses
  the assistant. That is a deliberate trade, recorded here so it is a
  decision rather than an oversight.
- **No privacy review by anyone else.** This is the author's own analysis
  against the brief's rules, and it says so.
