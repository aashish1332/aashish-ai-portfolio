# 🎬 AASHISH KUMAR — THE FILM
### *Scroll is the timeline. The visitor is the projectionist.*

A cinematic portfolio where scrolling flies a **real WebGL camera** (Three.js + bloom) through a neon city that *is the architecture*: an API gateway of glowing rings, service towers with lit windows, particle data-streams flowing between them, a DB monolith, and container stacks being deployed. Fused with live engineering: a 4D tesseract, an interactive terminal (Ctrl+K), and a contact API.

The metaphor is the pitch: **the city is a system diagram.** Towers = services. Streams = API calls. Monolith = the database. Recruiters don't just read "full-stack" — they fly through it.

---

## ▶ Run the demo

```bash
npm run dev             # recommended — dev server on :5577 (static + /api/contact, zero deps)
npm start               # optional full-stack — Express + Mongo contact API on :3000
# or just open it (no contact API → the form falls back to mailto)
start index.html        # windows
```

Then: **scroll** to scrub the film · **drag the tesseract** in the interlude · **P** for render telemetry · **Ctrl+K** for the terminal · try `sudo hire aashish`, `stats`, `quality 0`.

## 🔍 Sharpness & devices
- **FXAA anti-aliasing** at the top quality tiers (the post pipeline disables the context's own MSAA — FXAA is what keeps neon edges crisp), auto-stepped off with the governor
- **Responsive governor**: phones/tablets start at a sensible tier, cap DPR at 1.5, and scale from there — never fighting the device
- **Full touch support**: scroll = timeline scrub (Lenis native touch), floating **❯_** launcher opens the terminal (no Ctrl+K on phones), 18px chapter dots, safe-area padding for notches, keyboard-aware viewport on Android, lens mode auto-skipped on touch

## ⚡ The performance contract (30–60 fps, guaranteed)

The film runs an **adaptive quality governor** (`js/film3d.js`) that measures real frame times every frame and holds the framerate by sacrificing cheap things first:

| Tier | Label | Render scale | Bloom | Mirror street |
|---|---|---|---|---|
| 0 | CINEMATIC | 100% | on | on (scene rendered twice) |
| 1 | BALANCED | 92% | on | off |
| 2 | SMOOTH | 78% | on | off |
| 3 | SAFE | 62% | on | off |
| 4 | EMERGENCY | 50% | off | off |

- Down-shifts when the 30-frame average exceeds ~22 ms **or** ≥13% of recent frames spike past 42 ms (catches stutter, not just averages).
- Up-shifts only when the average is comfortably under 13.5 ms with zero spikes.
- Mobile starts at tier 2; desktop at tier 0. Hysteresis + warm-up frames prevent oscillation.
- **Zero allocations in the render loop** — camera path pre-baked into 1024-entry LUTs (no arc-length searches per frame), all vectors reused.

Watch it live: press **P** (or the bottom-left chip), or in the terminal: `stats`, `quality <0-4>` for a manual override.

## 🎨 Cinematography
- **Time-of-day grade** — as you scroll, the whole world re-grades: dusk (warm orange key) → blue hour → deep night (cyan DB glow) → cold pre-dawn. Fog, sky-dome gradient, key light and exposure all lerp along the journey.
- **Speed feel** — scrub fast and the camera FOV kicks up like a film camera surging; settle and it relaxes.
- **Wet street** — a mirror plane under the city reflects the entire skyline; the camera banks into turns.

## 🧱 Stack
- **Three.js WebGL film** — one fixed full-page canvas; scroll drives a Catmull-Rom camera path through the microservices city (`js/film3d.js`)
- **Post-processing** — UnrealBloom for the neon kick, ACES filmic tone mapping, fog + sunset key light
- **GSAP ScrollTrigger + Lenis** — master page trigger → camera; per-scene pins choreograph the DOM layer
- **4D tesseract** — 16 vertices, double rotation, drag-inertia, zero libraries (`js/tesseract.js`)
- **WebAudio** — projector hum, UI blips, mute toggle (`js/sound.js`)
- **Optional backend** — Express + Mongo contact API with rate limiting (`server.js`)
- **Graceful degradation** — WebGL failure → CSS neon gradient fallback (`html.no-webgl`)

## 🏙 The city = the architecture
| In the film | Means |
|---|---|
| Three glowing gateway rings | API Gateway / entry point |
| Boulevards of window-lit towers | Running services |
| Orange particle streams tower→tower | API calls / event flow |
| Pulsing cyan monolith | The database |
| Grids of glowing pods | Container deploys |
| Elevated cyan rail line (the metro) | Express middleware — requests ride the stack |
| Billboard tickers on towers | Live logs: `GET 200 · npm run build ✓ · SQL · retries` |
| Cranes + scaffold towers | Always shipping — construction never stops |
| Camera flight through it all | One request's journey |

*All of it explorable in-page: terminal (`Ctrl+K`) → `districts` prints the legend; press `P` for live FPS + quality tier.*

## 🎥 The production pipeline (real film frames)

The demo's procedural world proves the interaction model. To get the full "insane" visual quality:

1. **Make the film** — build the world in **Blender** (or Spline), lay a camera path through your neon city, render an MP4 (aim 15–30s per reel).
2. **Extract frames** — the OPTIKKA/Zajno pipeline:
   ```bash
   ffmpeg -i film.mp4 -vf fps=30 png/frame_%03d.png
   ffmpeg -i png/frame_%03d.png -c:v libwebp -quality 80 webp/frame_%03d.webp
   ```
3. **Two device sets** — `frames/desktop/` (~1100 frames) and `frames/mobile/` (~700, lower res).
4. **Switch the source** in `js/main.js`:
   ```js
   const heroFrames = new SeqFrames({
     total: 1100, dir: 'frames/desktop',
     onProgress: (loaded, total) => boot.update(loaded / total),
   });
   ```
   `SeqFrames` already implements staged loading (first 10 frames → instant paint, rest in background) and direction-aware preloading (5 ahead/behind).
5. **Performance budget** — < 8 MB initial, `devicePixelRatio` capped, render paused off-screen (already wired via ScrollTrigger toggles).

## 🗂 Scenes
| # | Scene | What happens |
|---|-------|--------------|
| 00 | Countdown leader | 3…2…1 film-leader preloader with load % |
| 01 | Opening shot | Camera flies through a procedural neon city; title card |
| 02 | The story | Pinned: word-mask reveals, stat counters, polaroids |
| 03 | The work | 3 projects as film takes with animated clapperboard slates |
| 04 | Intermission | Pre-rendered film cuts to LIVE: drag the 4D tesseract |
| 05 | Credits | Skills as movie end-credits, rolled by scroll |
| 06 | Post-credits | Contact console + hidden terminal (`Ctrl+K`, `sudo hire aashish`) |

## 🚀 Deploy
Static (no backend): **Vercel / Netlify** — drag & drop, done.
Full-stack: `MONGODB_URI=... node server.js` (Railway/Render) or convert `server.js` to Vercel serverless functions.

## ✍️ Before you publish
- Replace `github.com/` and `linkedin.com/` placeholder links in `index.html` with your real profiles.
- Terminal `contact` command has your real email already.

---

## 🤖 The AI assistant (`ASK AASHISH AI`)

A scratch-built assistant that answers questions about this portfolio in
**English, Hindi or Roman Hinglish** — automatically, with no language
selector, **no backend, no LLM API and no API key**.

Click the chip bottom-right to open it. Every answer is the **on-device model
trained from scratch for this portfolio**, reading only the verified facts it
was given — and where it cannot answer, the panel *refuses* and says which
refusal it is, rather than substituting a canned sentence. Every answer carries
a badge saying which of those two happened. There is no backend to call and no
API key anywhere in the repository.

The model runs **in your browser**, in a web worker, from a quantized copy
downloaded once and cached: **5.14 MB** raw / **4.74 MB** gzip for the model
that ships today (5,059,584 B of int8 weights, a 66 KB tokenizer, a 18 KB
manifest) — 11.5 % of the 40 MB §4 allows for a first visit. The weights are
int8 (~4× smaller than fp32), the quantization's cost is measured rather than
assumed (worst per-row error 0.001146), and the JavaScript engine that runs
them is checked against an independent numpy implementation of the same
architecture, which is itself checked against the trained PyTorch graph. All
three agree on the shipping weights: 138 positions, **identical argmax and
identical top-16 ordering**, worst absolute logit difference **8.8e-06**.
`npm run verify:engine` re-runs that gate on whatever is currently exported and
exits non-zero on any disagreement. A second parity gate runs on every
`npm test`, against a committed tiny fixture, so a change that breaks the
forward pass fails the build instead of a visitor's question.

Today's shipped weights are from a **local CPU run** — 4,984,064 params,
config `local`, 1,100 steps on this laptop — that exists so the whole path
(train → export → download → worker → stream → guard) is real end to end. It
runs at **65–74 tok/s decode** on a 2016 ultrabook with no GPU, 8–9× the ≥ 8 tok/s
floor §4 asks for. The §7.1 shipping target is still config A (37.9M) trained
on a GPU in P4/P5; nothing about the runtime changes when it lands, only the
weights. Until then the quality is visibly a small model's, and the panel never
pretends otherwise — it says so itself: the **ABOUT** card carries the
checkpoint's status in words ("a pipeline test, not a model trained for
quality"), and the constant behind it cannot claim otherwise while the project's
own evaluation reports the quality gates as failed.

The answers are written **about Aashish, in the third person** — "his CGPA",
not "my CGPA" — which is what the brief asks for ("never pretends to be him").
The assistant's own lines are the same shape: first person about *itself* ("I'm
Aashish's AI portfolio assistant"), third person about him. The first-person
voice still exists in full — `persona: 'first'` — because the evaluation set
measures both, but nothing ships with it on. In **Proactive
mode** the page
moves by itself to the part an answer came from. That part is found by looking
at the page's own content every time, not at a stored position, so it still
works after the sections are reordered or renamed; a question with no place on
the page simply does not move it. The move is never narrated, and it is off in
the typed chat — the typed chat is a text box that answers, nothing else.

Press **VOICE** and you can ask out loud: the answer is spoken, and the page
follows it. Nothing is listened to until you press it, the panel tells you
beforehand that your browser's speech service receives the audio (typing never
leaves the device), and a press opens a **20-second** listening window that
closes by itself — so a press asks a question, and then the microphone really
is off (the button says so), rather than staying hot because you clicked once.
Where a device can afford continuous listening, saying *"Aashish…"* is what it
answers to, and anything else it hears is ignored in silence; being woken is
not being on forever, since one question buys a **12-second** window for the
next one (so *"…and your projects?"* needs no name again) and after that it
stops answering until it is addressed again. If the microphone is blocked it
turns itself off and says why, rather than leaving a dead one switched on. A
hands-free session opens with **one spoken greeting** that names the three
things worth asking (projects, skills, contact) and offers a **guided tour** —
four stops that walk the page and say one line at each, stopping the moment you
ask anything. The
voice available here is your browser's, chosen by the answer's language; a
clone of Aashish's own voice is a future feature, not this one.

**What is ours, and what is the browser's — said plainly, because the brief
asks for it.** The **language model, the tokenizer, the training loop and the
instruction tuning are all scratch-built** for this portfolio, from random
initialisation; **no pretrained LLM is used anywhere in it**. **Voice is the
browser's**: speech recognition is the platform's own `SpeechRecognition` and
speech output is its `speechSynthesis`, asked to run on this device when the
platform says they can and disclosed in the panel either way — the distinction
matters, so the panel names which of the two you are in rather than implying
the better one. The voice-activity gate (deciding where speech starts and
stops) is ours, and it ships **no model file at all**. The panel's **ABOUT**
control states the same thing in the product itself.

Nothing AI-related loads until you click: the launcher is **958 B gz** and
the page makes **zero** AI requests before that. Opening and closing the panel
is measured, not assumed: **0 DOM nodes, 0 listeners and 0 MB per reopen**, and
an AI session now compiles **no** shader programs — the frame ladder is armed
around answering rather than around the panel being open, because degrading an
idle page cost a measured 1.2 s of blocked main thread (`docs/BENCHMARKS.md` §15.3).

| Doc | What it covers |
|---|---|
| [docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md) | how the pieces fit, and what is verified vs not |
| [docs/TRAINING.md](docs/TRAINING.md) | corpus pipeline, tokenizer, model, checkpoints, resume, Kaggle plan |
| [docs/DATA_LICENSES.md](docs/DATA_LICENSES.md) | what is in the corpus and what may enter it |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | every measured number, with device and method |
| [docs/PRIVACY.md](docs/PRIVACY.md) | what leaves the visitor's device, and what never does |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | hosting requirements, build/preview, what ships |
| [docs/MANUAL_TEST_CHECKLIST.md](docs/MANUAL_TEST_CHECKLIST.md) | the ~10-minute routine for a real phone and microphone |
| [docs/PROGRESS.md](docs/PROGRESS.md) | phase-by-phase log, including what is unfinished |
| [docs/RESEARCH_VERIFICATION.md](docs/RESEARCH_VERIFICATION.md) | §19's research notes, re-verified claim by claim, with what each one is relied on for |
| [docs/FINAL_REPORT.md](docs/FINAL_REPORT.md) | §18's final report: every value tagged MEASURED / ESTIMATED / NOT TESTED |
| [experiments/ternary/README.md](experiments/ternary/README.md) | §13's written go/no-go on the ternary experiment (no-go, and why) |

```bash
npm run test:all     # 533 JS + 356 Python tests
node dev-ai-probe.js     # the click → answer gate in a real browser (60 checks, real GPU; SW_GL=1 software GL, THROTTLE=4 weak-device profile)
npm run probe:firefox # the same gate as a Firefox smoke test (11 checks; WebDriver BiDi, FF_BIN overrides the binary)
node dev-offline-probe.js # §9.3 cache: a second visit with model-export blocked
node dev-degrade-probe.js # §14: the T0 path and the download-failure path, end to end
npm run probe:resources  # §15.3: heap, nodes, listeners, long tasks → docs/RESOURCES.json
npm run calibrate    # sweep the §8.4 retrieval gate against the evaluation set → docs/CALIBRATION.json
npm run params       # parameter count + its band gate
npm run bench:cpu    # §14 CPU inference: load, RAM, prefill/decode tok/s, file size
npm run sft          # §7.4 Stage B instruction data (40k examples + review sample, real token count when the tokenizer exists)
npm run sft:check    # the Stage B data path with no torch: the assistant-only mask, printed
npm run smoke        # tokenizer contract, shards, data cursor, checkpoints
npm run train:local  # the largest model this laptop trains for real → training/checkpoints/local
npm run train:sft    # Stage B: continue that checkpoint on the §7.4 data → training/checkpoints/sft-local
npm run sample:answers -- --checkpoint stage-A=training/checkpoints/local --checkpoint stage-B=training/checkpoints/sft-local  # what a checkpoint answers, no browser
npm run eval:prompts  # §14: the client's own prompt per evaluation case (no model needed)
npm run eval:export   # export the checkpoint the evaluation should grade (scratch dir)
npm run eval:decode   # decode with the SHIPPING engine, q8 as exported, KV cache (5.9 tok/s here)
npm run eval:decode:reference # the same from a checkpoint with the numpy reference (0.62 s/token)
npm run eval:report   # score with the shipped guard + apply the §14 ship gates → docs/EVALUATION.json
npm run export:model # checkpoint → the browser artifact: q8 shards + manifest + parity fixture
npm run verify:engine # §9.2: does the JavaScript engine match the numpy reference, on the SHIPPING weights?
npm run build        # production bundle → dist/ (stripped knowledge base, no dev tooling)
npm run preview      # build + serve dist/ on :5580 to see exactly what ships
```

`npm run verify:engine` is the one to run after touching the model, the export or
`ai/engine/`: it fails (exit 1) if the engine's logits disagree with the
reference, and it prints decode speed on this machine.

**Deploy `dist/`, not the repository root.** `npm run build` reduces
`knowledge.json` to its public view (the withheld phone number is removed from
the file that ships, and the build *fails* if it appears anywhere else in the
bundle) and leaves the dev tooling behind.
