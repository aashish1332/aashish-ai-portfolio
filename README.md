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

Click the chip bottom-right to open it. Today every answer is produced by a
deterministic engine over a verified knowledge base, and the panel says so
per answer: *"Quick answer — no AI model on this device"*. A scratch model
(37.9M params, config A) has its tokenizer, architecture, parameter schema
and training pipeline built and tested; the browser runtime arrives in
P6–P7, and Stage A training runs on Kaggle in P4.

The answers are written **as Aashish** — "my CGPA", not "his CGPA" — because
the visitor is being introduced to him, and once voice mode drives the panel
the page moves by itself to the part an answer came from. That part is found
by looking at the page's own content every time, not at a stored position, so
it still works after the sections are reordered or renamed; a question with no
place on the page simply does not move it. The move is never narrated, and it
is off in the typed chat — `setHandsFree(true)` is the whole switch.

Nothing AI-related loads until you click: the launcher is **958 B gz** and
the page makes **zero** AI requests before that.

| Doc | What it covers |
|---|---|
| [docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md) | how the pieces fit, and what is verified vs not |
| [docs/TRAINING.md](docs/TRAINING.md) | corpus pipeline, tokenizer, model, checkpoints, resume, Kaggle plan |
| [docs/DATA_LICENSES.md](docs/DATA_LICENSES.md) | what is in the corpus and what may enter it |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | every measured number, with device and method |
| [docs/PROGRESS.md](docs/PROGRESS.md) | phase-by-phase log, including what is unfinished |

```bash
npm run test:all     # 254 JS + 219 Python tests
npm run params       # parameter count + §7.1 band gate
npm run smoke        # tokenizer contract, shards, data cursor, checkpoints
npm run build        # production bundle → dist/ (stripped knowledge base, no dev tooling)
npm run preview      # build + serve dist/ on :5580 to see exactly what ships
```

**Deploy `dist/`, not the repository root.** `npm run build` reduces
`knowledge.json` to its public view (the withheld phone number is removed from
the file that ships, and the build *fails* if it appears anywhere else in the
bundle) and leaves the dev tooling behind.
