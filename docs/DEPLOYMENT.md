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
| **Ability to serve ~5 MB in shards ≤ 8 MB** | §4 download budget | **measured** — the current export is **5,059,584 B in one shard**; `npm run build` prints the real figure on every run, and the budget is asserted by `npm test` |

**No host-specific configuration has been written**, because no host has been
chosen and writing a config for a host that is then not used is cruft. The
list above is what to check against whichever one is picked.

---

## 2. Build and preview

```bash
npm run export:model   # optional but required for text chat: checkpoint → ai/model-export/
npm run build          # tools/build.mjs → dist/
npm run preview        # build, then serve dist/ on :5580 — exactly what ships
```

`npm run build` is not a copy step. It:

1. writes `knowledge.json` as `publicView()` plus `meta.withheld_facts`
   (ids and aliases only — never a value);
2. copies only allow-listed paths, file by file;
3. **fails** if a withheld value appears in any shipped file, in any format,
   or if a dev-only reference reaches a shipped file;
4. reports the deliberate exceptions as **notes** (this is where
   `index.html` and `js/terminal.js` publishing the phone number is recorded
   as a decision rather than discovered later);
5. copies the model export when one exists, **file by file from an
   allow-list** (`manifest.json`, `tokenizer.json`, `model-\d{5}.bin`) and
   reports anything else it found in there. Copying the directory instead is
   how a 257 KB parity fixture reached `dist/` and every visitor.

Today's measured bundle: **44 files / 5,727,097 B** with the model export,
**41 files / 558,954 B** without one (the export is git-ignored build output,
so a clean checkout builds the second). Leak scan clean in both cases. A build
with no model is legitimate and ships fine, but it is not a working assistant:
the answer path *is* the model (§6.2's T0 path says so plainly rather than
substituting a template), and the summary says which of the two it produced.

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
   §9.3 caching and the model shard URLs, so it should be made before the
   first deploy.
2. **CI.** §14 asks for a bundle-size budget check in CI. There is no CI
   provider configured; the budget is currently enforced by two tests on
   `npm test` rather than a pipeline. Wiring that to whatever host is chosen
   is a small job once the host exists.
3. **The model has landed; the host work has not.** The export now satisfies
   most of §9.3 on its own:
   - shards ≤ 8 MB — **one 5,059,584 B shard**, `model-00000.bin`, immutable
     name;
   - a per-file `sha256` in `manifest.json`, and the browser **verifies every
     hash on load** (`engine.verified`);
   - `modelVersion` and the tokenizer's version + hash in the manifest;
   - what remains is *host* configuration, not code: long-lived immutable
     caching on the shard and tokenizer, and a **revalidated** `manifest.json`
     so a new version is actually seen.
4. **`knowledgeVersion` is deliberately not in the model manifest.** §9.3
   lists it, and the requirement it serves — `knowledge.json` changes without
   forcing a model re-download — is met the other way round: the knowledge
   base carries its own `meta.version` (`1.0.0`), the model manifest does not
   reference it at all, and `knowledge.json` is 24 KB so it revalidates
   cheaply. Putting a knowledge version inside the model manifest would
   *couple* the two: every knowledge edit would stale a 5 MB artifact's
   manifest. Flagged here so it is a recorded decision rather than a missing
   field someone finds later. If the owner wants the field anyway, it is one
   line in `write_export` and one in the loader's compatibility check.
