# PRIVACY — what leaves the visitor's device, and what never does

**Status:** describes the **shipped configuration** as it stands on
2026-09-27. Every claim here is checked against code, and anything not yet
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
| Typed questions | **No.** There is no backend, no LLM API, no analytics on chat content | `ai/answers/model.mjs` (the answer path) and `ai/answers/quick.mjs` (the routing and the §8.4 gate) are each asserted by test to contain no `fetch`, no `XMLHttpRequest` and no URL; `evaluation/answer-text.mjs` (the retired §5.1 step-4 wording, which is **not shipped** at all) is asserted the same way |
| Answers | **No.** Composed on the device from `knowledge.json` | same |
| Voice input (SpeechRecognition) | **The default is yes — the browser's own speech service — and since 2026-09-27 we ask whether it can be avoided.** The session first calls `SpeechRecognition.available({ processLocally: true, langs })`; only on `'available'` does it set `processLocally` and recognise on-device. The sentence follows the answer: *"…sends what you say to your browser's speech service — so while it listens, your audio leaves this device. Typed questions never do."* on the server-side path, and *"…run on this device — what you say is not sent anywhere, and no audio leaves this device."* when the platform said yes. The cautious sentence is the one shown while the question is still open (`ai/ui/chat.mjs`, `disclosurePending`), because a privacy claim may be under-made while waiting and never over-made | `ai/voice/index.mjs` (`SPEECH_DISCLOSURE`, `SPEECH_DISCLOSURE_ON_DEVICE`, `probeOnDevice`), shown on the click that enables voice; `tests/voice.test.mjs` VOICE-12 |
| Voice output (speechSynthesis) | **No.** OS voices are local | §11.4 V0 |
| Model download (P6/P7) | Only the model files themselves are fetched from the static host — **no question, no transcript, no telemetry** | The shipped export (`ai/model-export/aashish-ai-1/`, 4.8 MB gz first visit) is fetched from this site's own path and cached by version (§9.3); `dev-ai-probe.js` asserts no third-party request, and `tests/build-bundle.test.mjs` fails on any absolute URL in a shipped AI script |
| Page load | The portfolio's own assets only. **+0 AI requests before the click** | `dev-ai-probe.js`, `npm run build` |
| Analytics | **None exists.** No analytics library is loaded and no chat content is sent anywhere | repo-wide grep; AUDIT §"analytics" |

**Consequence to state plainly:** the "runs on your device" promise is true
for the typed experience today, and is true for voice in two parts — *the model
is local* always, and *the recogniser is local* when the browser says it can be
(§11.2 S0, `processLocally`, verified against the platform and implemented
2026-09-27; the platform's default remains a network service, and the panel says
which one you are in rather than implying the better one).

**And a limit on that:** the on-device path is exercised by tests against a
double, never against a real microphone on a real machine. Treat the sentence
as the platform's claim, relayed — see `docs/RESEARCH_VERIFICATION.md` row 6
and `docs/MANUAL_TEST_CHECKLIST.md` §D, which asks the tester to check that the
sentence matches `SpeechRecognition.available()` on their own browser.

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
anything the visitor says. **What is stored is now real, and it is only the
model:** `ai/engine/cache.mjs` puts the manifest, the tokenizer and the shards
in a Cache Storage entry named `aashish-ai-model:<version>` (§9.3), so a later
visit loads with zero bytes of network. Those are the same public artifacts any
visitor could download, keyed by version and never by conversation — the
questions asked, the answers given and the microphone audio are not written
anywhere, and opening the panel offline reads nothing but those three files.
An older version's cache is deleted when a new one activates, and no other
origin's caches are touched. Nothing needs a consent banner because nothing is
tracked; the voice disclosure covers the one path where audio leaves the device.

Voice is also stricter than it was: the recognizer, the VAD and the speaker are
fetched **on the tap that chooses a voice mode** (§2 N6), so a visitor who only
types never loads them at all — `tests/build-bundle.test.mjs` follows the import
graph and fails if they become statically reachable from the chat shell again.

---

## 7. What this document does not yet cover

- **No model download path exists**, so the download/caching privacy
  behaviour is unbuilt and untested (P6/P7).
- **No analytics at all** means there is also no way to know if anyone uses
  the assistant. That is a deliberate trade, recorded here so it is a
  decision rather than an oversight.
- **No privacy review by anyone else.** This is the author's own analysis
  against the brief's rules, and it says so.

## The microphone, in Proactive mode

Proactive mode opens the microphone **and keeps it open**, which is a bigger
statement than Tap & Speak's press and has to be said plainly.

* **Nothing is transcribed until speech is detected.** An energy VAD
  (`ai/voice/vad.mjs`) measures ~30 ms frames on the audio thread's own
  `AnalyserNode` and switches the recognizer on at a speech onset and off a
  hang-over after it ends. The room is being *measured*, not transcribed, in
  between — and the measurement never leaves the page (it is a number).
* **The microphone is released** when the visitor turns voice off, closes the
  panel, switches tabs (a hidden tab is never listened to), or when the session
  goes idle. `disable()` stops the `MediaStream` tracks and closes the
  `AudioContext`, which is what turns the browser's recording indicator off.
* **The recognizer is still the browser's.** When a segment *is* transcribed,
  the audio goes to whatever the browser's speech service is — the panel says
  so in the disclosure before voice is switched on, and it is the one thing in
  this project that leaves the device. Everything else (the model, the
  retrieval, the guard, the answers) is local, and the model's weights were
  downloaded from the same site the page came from.
* **The VAD is a detector, not an ear**: it reports speech start/end and a
  loudness level. It has no model, no vocabulary and no network.
