# DEPLOYMENT — shipping the portfolio, and later the model

**Status:** the static site ships today; the model does not exist yet, so
every model-related line below is a **requirement on the future deploy**, not
a description of one. The host itself is an **open owner decision** — see §6.

---

## 1. What has to be true of any host

| Requirement | Why | Check |
|---|---|---|
| **Static file hosting** — no Node process, no server-side rendering | N2: no backend, no server-side inference, no API key | `dist/` is plain files; `npm run preview` serves it with a plain static server |
| **`Content-Type` correct for `.mjs`** | the AI chunk is ES modules; a wrong MIME type is refused by the browser | `dev-server.mjs` had exactly this bug (DEV-1) and now maps it |
| **HTTPS** | required for microphone permission and for `SubtleCrypto` (SHA-256 shard verification) | any mainstream static host |
| **No `COOP`/`COEP` needed** | threaded wasm needs `SharedArrayBuffer`, which needs cross-origin isolation — the brief says **do not** add those headers just for AI (§9.1) | the app is single-threaded by design; nothing requests isolation |
| **No service worker required** | one is only registered if the site already had one — it does not | AUDIT |
| **Immutable caching for hashed assets** | the model manifest keys files by content hash (§9.3) | served with long-lived cache headers; the hashed name carries the versioning |
| **Ability to serve ~25–40 MB in shards ≤ 8 MB** | §4 download budget | only matters once P6/P7 produce the files |

**No host-specific configuration has been written**, because no host has been
chosen and writing a config for a host that is then not used is cruft. The
list above is what to check against whichever one is picked.

---

## 2. Build and preview

```bash
npm run build      # tools/build.mjs → dist/  (29 files, ~449 KB today)
npm run preview    # build, then serve dist/ on :5580 — exactly what ships
```

`npm run build` is not a copy step. It:

1. writes `knowledge.json` as `publicView()` plus `meta.withheld_facts`
   (ids and aliases only — never a value);
2. copies only allow-listed paths, file by file;
3. **fails** if a withheld value appears in any shipped file, in any format,
   or if a dev-only reference reaches a shipped file;
4. reports the deliberate exceptions as **notes** (this is where
   `index.html` and `js/terminal.js` publishing the phone number is recorded
   as a decision rather than discovered later).

Today's measured bundle: **29 files / 448,578 B**, leak scan clean.

---

## 3. The dev/prod split (§17)

| | Dev | Prod |
|---|---|---|
| Logging | verbose, probe-facing | minimal user-facing errors |
| Probes / debug overlays | present | excluded by the allow-list and the reference scan |
| `knowledge.json` | full base | public view only |
| Source | unminified | unminified today; a minifier is a §4-budget decision, not a default |

---

## 4. What ships, exactly

`index.html` · `css/` · `js/` (the existing portfolio, untouched) ·
`ai/answers` · `ai/guard` · `ai/governor` · `ai/intent` · `ai/knowledge` ·
`ai/language` · `ai/retrieval` · `ai/ui` · `ai/voice` ·
`knowledge/knowledge.json`.

That list lives in `tools/build.mjs` (`SHIP_PATHS`) and is the single source
of truth. Adding a directory there is a deliberate act; an earlier version
shipped all of `ai/` and all of `knowledge/`, and the leak scan is what
caught it (BLD-1).

---

## 5. Deployment-time verification (run these **on the deployed URL**)

Nothing here is verified until it is verified against the live site:

- [ ] `npm run build` is clean and the bundle size matches the released figure
- [ ] open the deployed URL, and confirm in DevTools → Network that **no AI
      asset is requested before the click** (the launcher is the only AI
      bytes, ~1 KB)
- [ ] open the panel, ask a question in each of EN / HI / Hinglish
- [ ] refuse the microphone once → the button goes dark and the reason is
      stated; the panel still types
- [ ] open on a phone → the sheet does not overflow, the film pauses behind
      it and resumes on close
- [ ] scroll with the panel closed → smooth, unchanged from before the AI work
- [ ] `docs/MANUAL_TEST_CHECKLIST.md` end-to-end on a real phone

---

## 6. Open decisions (owner)

1. **Host.** No Netlify/Vercel/Pages/CI config exists. The choice affects
   §9.3 caching and the model shard URLs, so it should be made before P6.
2. **CI.** §14 asks for a bundle-size budget check in CI. There is no CI
   provider configured; the budget is currently enforced by a test rather
   than a pipeline. Wiring that to whatever host is chosen is a small job
   once the host exists.
3. **When the model lands (P6/P7):**
   - shards ≤ 8 MB, hashed filenames, `manifest.json` with
     `modelVersion`/`tokenizerVersion`/`knowledgeVersion` and per-file
     `sha256`;
   - long-lived immutable caching on the hashed files; the manifest itself
     must be revalidated so a new version is seen;
   - `knowledge.json` is versioned **separately** and may change without
     re-downloading the model (§9.3) — the whole reason it is not bundled
     into the weights.
