# MANUAL TEST CHECKLIST — the ~10 minute routine

This covers the things **no automated test in this repo can do**: a real
phone, a real microphone, a real screen reader, a real GPU. §15.2 (R4) and
§11 both say that when a device is not available the honest label is
**NOT TESTED** and the steps go here instead. Every scenario in this file is
currently **NOT TESTED** unless a date is written next to it.

**Run it on:** (a) a real Android or iPhone, (b) one other laptop with a
different GPU than the dev machine, (c) the dev machine for comparison.

**Take with you:** the deployed URL, and a place to write down a number.

> If something fails, write down **what you were doing** and the **device**.
> "It felt slow" is not actionable; "opened the panel on the phone, scrolled
> while answering, the film stuttered" is.

---

## A. Baseline, before touching the AI (~3 min)

Do this **first** — most of what follows is a comparison against it.

| # | Step | Record |
|---|---|---|
| A1 | Load the page, let the intro finish | time to interactive, roughly |
| A2 | Scroll the whole film top to bottom | does it stutter? where? |
| A3 | Open DevTools → Network, hard-reload | **request count** and **transferred bytes** before any click |
| A4 | Search the Network list for `.wasm`, `.onnx`, `.gguf`, `model` | must find nothing — this is the §4 "+0" claim |

---

## B. Chat, no microphone (~3 min)

| # | Step | Expected |
|---|---|---|
| B1 | Click **Ask Aashish AI** | panel opens immediately, starter chips appear, no spinner |
| B2 | In Network, look at what just loaded | the AI chunk, then the model (manifest + `model-*.bin` + tokenizer) — the **size is stated in the panel before the download** |
| B2b | Watch the banner while it loads | `PREPARING ON-DEVICE MODEL` → `ON-DEVICE MODEL READY`; a failure says so, and a question asked meanwhile gets an honest refusal rather than a template |
| B2c | Reload the page and open the panel again | the model loads from cache — **Network shows no new shard requests** |
| B3 | Tap a starter chip | an answer appears, badged *AI ANSWER · ON-DEVICE MODEL*, and text **streams in** rather than appearing all at once |
| B4 | Type "what is your cgpa" | answers with the CGPA |
| B5 | Type "did you intern at Google?" | **declines** — must not invent an internship |
| B6 | Type "नमस्ते" then a Hindi question | answered in Hindi, no selector anywhere |
| B7 | Type "aapka naam kya hai?" | answered in Hinglish |
| B8 | Ask "what is your phone number?" | declines, and offers email instead |
| B7b | Ask something the portfolio does not cover, e.g. "where did you intern?" | **declines**; it must not invent an employer, and it may not answer from general knowledge |
| B7c | In DevTools, look at the `[id] value` lines the answer used (`window.PortfolioAI.model.last.context`) | every claim in the sentence is traceable to one of those lines |
| B8b | Press **Stop** mid-answer | the panel stops waiting immediately; the partial text stays and the badge reads `PARTIAL ANSWER · STOPPED BY YOU` — never the verified one. **Stop during the prefill (the common case) shows the “stopped before I had written anything” line instead, and the worker still finishes that pass in the background** — that is by design, not a hang |
| B8c | Press **Stop**, then **Retry** | Retry appears only when the last turn did not answer; pressing it asks the same question again as a fresh generation |
| B8d | Press **ABOUT** in the panel footer | a card says which parts are ours (the model, from scratch) and which are the browser's (speech recognition, speech output). It must name **both** voice outcomes, and pressing Esc must close the card and leave the **panel** open |
| B8e | In the same **ABOUT** card, read the line under *The model* | it must **not** claim a trained-for-quality model. While the export shipping today is the 1,100-step pipeline artifact it says so in plain words (*"What runs here is a pipeline test, not a model trained for quality… and its answers are poor…"*); that sentence may only change to the trained wording once the export has actually passed the §14 gates, and `tests/disclosure.test.mjs` is what stops it changing early (§0 rule 4) |
| B9 | Press Esc | panel closes, focus returns to the button |
| B9b | Close the panel and leave it for **~2 minutes**, then reopen | the model is unloaded (no worker in DevTools) and reloads from cache on the next question |
| B10 | Reload the page while the panel is open | page still works; nothing AI loads before a click |

**Watch for:** the panel stealing scroll from the film; the chat container
scrolling the page instead of itself; a stuck spinner.

**Already covered without a person (2026-09-27).** `dev-ai-probe.js` opens the
panel in headless Chrome and asserts the flow mechanically — 0 AI requests
before the click, the panel becoming ready, an answer badged
*AI ANSWER · ON-DEVICE MODEL* with its sources, the withheld phone number
declined, "what are your skills?" answered from the capped intent fallback (12
facts), Escape closing, focus returning — **60/60**, and the same probe covers
B3, B4, B8 and the pre-click promise of B10. The latest run was pointed at the
**built bundle** (`AI_BASE`, with `dist/` served the way production serves it),
so the numbers above describe what a visitor downloads rather than the source
tree, and the console/page-error/failed-request counts on that run were 0/0/0. What it cannot do is judge the
*sentence*: the only checkpoint that exists is a 4.98 M CPU export exercise
whose answers are coherent-ish and wrong ("work reviewed cor byandeeer why"), so
B3–B7 still need a person **as soon as there is a trained-for-quality model**.
B2c (cache hit on reload) and B9b (unload after ~2 min) remain uncovered by
automation; B8b/B8c (Stop and Retry) are covered mechanically by
`dev-ai-probe.js`, which presses both.

---

## C. Phone specifics (~2 min)

| # | Step | Expected |
|---|---|---|
| C1 | Open the panel | full-screen sheet, **no horizontal scroll**, close button visible, safe-area padding respected |
| C2 | While the sheet is open, look at the film behind/around it | **paused** (not rendering at full cost) |
| C3 | Close it | film **resumes** |
| C4 | Rotate the phone | no clipping, no overflow |
| C5 | Turn on the OS reduced-motion setting, reload | no long animations; still usable |

---

## D. Voice (~2 min — the part that has never been done by a person)

**Before you start:** know what will happen. Voice mode uses the browser's
speech recognition, which as browsers ship it **sends your audio to the
browser's speech service**. The panel says this when you turn it on. Typed
questions are never sent anywhere. If you do not want that, skip section D —
it is the honest default.

The one exception is worth watching for, because it is the only claim in this
project that depends on what the *browser* says rather than on us: since
2026-09-27 the panel asks the platform whether it can keep recognition on the
device (`SpeechRecognition.available({ processLocally: true })`), and if the
answer is yes the sentence changes to "run on this device — what you say is not
sent anywhere" and the session runs that way (see `docs/RESEARCH_VERIFICATION.md`
§ row 6). **If you see that second sentence, we want to know** — it means the
path works on your machine, and it has never been seen by a person.

| # | Step | Expected |
|---|---|---|
| D0 | Click the mic button on a laptop/desktop (T2+) | **Proactive** mode: the button reads LISTENING and the microphone stays open — `window.PortfolioAI.voice.vad` should report `gated: true`, `available: true` |
| D1 | Click the mic button | the disclosure appears **before** it listens; browser asks for permission. Read which sentence it is: *"sends what you say to your browser's speech service"* (server-side) or *"run on this device … not sent anywhere"* (on-device). Both are correct — the second one only appears when the platform said so |
| D1b | In DevTools, before clicking: `SpeechRecognition.available({ processLocally: true, langs: ['en-IN'] })` | note the answer (`available` / `downloadable` / `unavailable`), and check that the sentence in D1 matches it — `available` ⟺ the on-device sentence |
| D1c | Turn voice on with the mic muted or the language unsupported | if the engine refuses the on-device session, the panel must fall back **once** to the normal recogniser and say the cautious sentence — not go dead. Worth trying on a build with `processLocally` forced on |
| D2 | **Deny** the permission | button goes dark, panel says why once, typing still works, and it does **not** ask again |
| D3 | Turn voice on again and **allow** | button lights; say "what is your CGPA" | 
| D4 | | the answer is spoken **about Aashish** ("His CGPA is 8.28"), never as him — §5 — and the page **moves to the CGPA section** while it speaks |
| D5 | Say something unrelated: "I'm going to get coffee" | **silence** — no answer, no bubble |
| D6 | Say "hey Aashish" then ask a follow-up without the name | the follow-up is answered (the turn stays open ~12 s) |
| D7 | Stay silent for ~15 s, then say something unaddressed | **ignored** — the turn closed by itself |
| D8 | Speak while the answer is being read | the reading stops (barge-in) |
| D9 | Press Esc / tap Stop | microphone stops immediately |
| D10 | Say a question in Hindi, then one in Hinglish | answered in the same language, read by the matching voice |
| D10b | Watch the dot on the mic button: turn voice on and stay quiet, then speak, then let it read the answer | it is **dim** when voice is on and waiting (`armed`), **brighter and pulsing** while you speak (`listening`), **faster** while an answer is read aloud (`speaking`), and it **disappears** when voice is off (§11.5). `window.PortfolioAI.voice` carries the same state as `onDevice`-less fields — `listening` / `speaking` / `suspended` |
| D10c | Turn on **Reduce motion** in the OS/browser settings, then repeat D10b | the dot still changes brightness per state but **stops pulsing** — motion is the enhancement, never the message |
| D11 | Leave the tab and use another app, then come back | it must not have been listening while hidden (`voice.status().suspended === true` while hidden), the dot goes **dim but stays visible**, and listening resumes on return |
| D12 | Keep the mic on through **a quiet room with a fan/TV** for ~2 minutes | it must not open a segment on the room tone alone, and a normal speaking voice must still open one within ~1.5 s |
| D13 | In **Proactive** mode, say nothing for ~25 s, then keep waiting | **one** line appears — *"Still here — ask about his projects…"* — and it never repeats (§11.1 d) |
| D14 | Keep saying nothing until ~90 s | the dot goes **dim** and the microphone is released (the browser's recording indicator should go out) while voice mode stays **on**; **say something** and it comes back listening (§11.1 e). If the dot stays bright and the microphone never releases, that is a bug worth reporting |
| D15 | Say a question with a word the recognizer will get wrong (a name, an acronym) | the question bubble is badged **HEARD** with an **EDIT** control; press it, fix the word, press Enter |
| D16 | Turn voice on and **say nothing at all** — just wait for the session to open | one **spoken** greeting within a second or two, naming projects, skills and contact (§11.1 a), and it is said **once** — turning voice off and on again in the same visit must not greet you twice |
| D17 | With Proactive on, tap the **Take the tour** chip, then keep quiet | the page walks about → projects → skills → contact, ~7 s apart, each stop says one line and is badged `TOUR · <TOPIC>`, and it ends with *"That is the tour."* (§11.1 c) |
| D18 | Mid-tour, page still walking, **ask a question** | the walk stops immediately and the question is answered normally — the tour must never fight the visitor for the page |
| D19 | Turn on **Reduce motion**, then take the tour again | the page **jumps** to each section instead of gliding (§3), and the tour still says the same four lines |
| D20 | Start the tour, then press **Escape** | the panel closes and the tour stops with it — no line arrives after the panel is gone |
| D21 | Turn Proactive on for the **first time** in a visit | one tip appears — *"Tip: headphones stop the microphone hearing the answer read aloud and interrupting itself…"* — and it does **not** come back when you turn voice off and on again (§11.1). Tap & Speak should never show it |
| D22 | If the film ever struggles while voice is on (the frame ladder reaching step 3 — a weak phone is the likely place) | hands-free listening **ends by itself** with *"This device is under pressure, so hands-free listening is off — tap the microphone to talk instead."*, the recording indicator goes out, and a press still talks. If the button silently stops behaving hands-free with **no** line, that is a bug worth reporting (§11.1) |

**Record:** did D3–D5 work the first time, or did you have to say it twice?
That number is the whole point of the exercise, and it is mine to fix, not
yours to work around.

---

## E. Accessibility (~2 min — never measured)

| # | Step | Expected |
|---|---|---|
| E1 | Navigate the whole panel with **Tab only** | every control reachable, focus always visible |
| E2 | Turn on a **screen reader** (VoiceOver / TalkBack / NVDA) | the panel announces itself, and completed messages are announced — **not** token by token |
| E3 | Ask a question with the screen reader on | the answer is readable and the *Sources* chips make sense aloud |
| E4 | Zoom to 200% | no clipped text, no overlap |

---

## F. After (~1 min)

| # | Step | Record |
|---|---|---|
| F1 | Open/close the panel five times | does the phone get warmer / slower? note it |
| F2 | Note the OS's memory use for the tab before and after | a growth over five cycles is a bug |
| F3 | If you have the dev machine: `npm run probe:resources` | paste the tail into the chat — it prints its own tally |
| F4 | Optional: `npm run probe:degrade` | §14's T0 and download-failure paths are already **20/20 automated** (`docs/BENCHMARKS.md`); run it if you want to see them. Two of those checks can only be cheated by the probe itself, so if it ever prints fewer than 20/20, that is a real finding |
| F5 | Optional, for a slow-network simulation: `PORT=5581 FAIL_MODEL=1 node dev-server.mjs` | 404s every model asset, which is how the failure path is driven without touching shipped code |
| F6 | Optional: `npm run probe:firefox` | Firefox 156 already passes **11/11** on this machine (`docs/BENCHMARKS.md`); if it prints fewer, that is a real finding. On a fresh machine set `FF_BIN` to the Firefox binary — the Windows Store alias is unreadable to Node |

---

## Where the results go

- Device + browser + date next to each section you ran.
- Numbers into `docs/BENCHMARKS.md` with **MEASURED / ESTIMATED /
  NOT TESTED** next to them, and the method (§15 rule 5).
- Anything that failed → tell me; a failure here is worth more than a pass,
  because none of these paths has ever been run by a human.
