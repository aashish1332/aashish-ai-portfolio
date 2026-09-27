/* ═══════════════════════════════════════════════════════════════
   tests/launcher.test.mjs — §2 N6: nothing AI loads before the click

   The promise is the strongest one in the spec and the easiest to break by
   accident: add a tag to `index.html`, a static import to the launcher, or a
   `<link rel="preload">`, and a visitor who never clicks pays for the
   assistant anyway. The e2e probe already asserts it *in a browser*, by
   watching the network — but that needs Chrome, a dev server and ~40 seconds,
   so it runs when someone runs it, and it is the wrong shape for a regression
   guard.

   This is the deterministic half. It checks the two files that can break the
   promise, at the moment they are written:

     · `js/ai/launcher.js` is the only AI code on the initial page load, and it
       is inert — no request, no worker, no network API, exactly one dynamic
       import, and that import is the UI chunk;
     · it stays inside its ~2 KB gzip budget;
     · `index.html` references nothing under `ai/` — no `<script src>`, no
       `<link>`, no import-map entry, no preload/prefetch/modulepreload — and
       the launcher is the only AI script it names at all.

   The browser assertion is still the one that proves it end to end; this is
   the one that stops it being broken in the first place.
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { buildBundle } from '../tools/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LAUNCHER = 'js/ai/launcher.js';
const CHUNK = '/ai/ui/chat.mjs';

const read = (rel, root = ROOT) => readFileSync(join(root, rel), 'utf8');
const gz = (rel, root = ROOT) => gzipSync(read(rel, root)).length;

/** Every `src`/`href` an element in `html` would fetch, attributes included. */
function referencedPaths(html) {
  const out = [];
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

/** The import map's specifier → path entries (it decides what a bare import loads). */
function importMapValues(html) {
  const m = /<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return [];
  try {
    const map = JSON.parse(m[1]);
    return Object.values(map.imports || {}).concat(Object.values(map.scopes || {}).flatMap((s) => Object.values(s)));
  } catch {
    return ['<< the import map is not valid JSON >>'];
  }
}

test('§2 N6: the launcher is inert, and it is the only AI code the page loads', () => {
  const src = read(LAUNCHER);

  /* 1. no network, no worker, no model — it answers "did the visitor click?" */
  for (const [pattern, what] of [
    [/\bfetch\s*\(/, 'a fetch call'],
    [/XMLHttpRequest/, 'an XMLHttpRequest'],
    [/new\s+Worker\b/, 'a Worker'],
    [/WebSocket/, 'a WebSocket'],
    [/sendBeacon/, 'a sendBeacon'],
    [/\.wasm\b/, 'a wasm reference'],
    [/knowledge\.json/, 'the knowledge base'],
  ]) {
    assert.ok(!pattern.test(src), `${LAUNCHER} contains ${what} — that is AI work before the click`);
  }

  /* 2. exactly one way in, and it is the chat shell, imported dynamically */
  const staticImports = [...src.matchAll(/(?:^|[\s;])import\s+(?:[^'"()]*?from\s+)?['"]([^'"]+)['"]/g)]
    .map((m) => m[1]);
  assert.deepEqual(staticImports, [],
    `${LAUNCHER} statically imports ${staticImports.join(', ')} — the click must be the only trigger`);
  /* the one import is `import(CHUNK)`, so what it fetches is the CHUNK
     constant — pinned both as "exactly one call, and it takes CHUNK" and as
     "CHUNK is this path", which is what makes the check mean anything */
  const dynamic = [...src.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(dynamic, ['CHUNK'],
    `${LAUNCHER} loads ${dynamic.join(', ') || 'nothing'} — expected exactly one dynamic import(CHUNK)`);
  const chunkConst = /var\s+CHUNK\s*=\s*['"]([^'"]+)['"]/.exec(src);
  assert.ok(chunkConst, 'CHUNK is not a string literal — this test can no longer see what the click loads');
  assert.equal(chunkConst[1], CHUNK);

  /* 3. the budget the header claims (≤ ~2 KB gz) */
  const bytes = gz(LAUNCHER);
  assert.ok(bytes <= 2048, `${LAUNCHER} is ${bytes} B gz, over its 2 KB budget`);

  /* 4. the page loads it in exactly one place, and names nothing under ai/ */
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/g)].map((m) => m[1]);
  assert.ok(scripts.includes(LAUNCHER), `index.html does not load ${LAUNCHER}`);
  const aiScripts = scripts.filter((s) => s.startsWith('ai/'));
  assert.deepEqual(aiScripts, [],
    `index.html loads ${aiScripts.join(', ')} from ai/ before the click (§2 N6)`);

  /* nothing under ai/ is fetched by a tag or an import map entry either */
  const named = [...referencedPaths(html), ...importMapValues(html)]
    .filter((p) => String(p).includes('ai/') && !String(p).includes('js/ai/'));
  assert.deepEqual(named, [],
    `index.html references ${named.join(', ')} — a preload or an import-map entry for the chunk ` +
    'makes every visitor download it whether they click or not');
  const preloads = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["'](preload|prefetch|modulepreload)["'][^>]*>/gi)]
    .map((m) => m[0]);
  const aiPreloads = preloads.filter((p) => p.includes('ai/'));
  assert.deepEqual(aiPreloads, [], `index.html preloads ${aiPreloads.join(', ')}`);
});

test('§2 N6: the same holds in the built bundle, where a visitor actually is', () => {
  const out = mkdtempSync(join(tmpdir(), 'launcher-'));
  try {
    buildBundle({ out, quiet: true });
    assert.ok(existsSync(join(out, LAUNCHER)), `${LAUNCHER} is not in the bundle`);
    /* `js/**` is never rewritten (§2 N7), so the file the test above read is
       the file a visitor receives — asserted, not assumed */
    assert.equal(read(LAUNCHER, out), read(LAUNCHER),
      `${LAUNCHER} was modified by the build`);
    assert.ok(gz(LAUNCHER, out) <= 2048);

    /* the one dynamic import must resolve inside the bundle, or clicking the
       button ends in "AI UNAVAILABLE" (§2 N7 — the panel must never just die) */
    const target = CHUNK.replace(/^\//, '');
    assert.ok(existsSync(join(out, target)), `${CHUNK} is not in the bundle — the click would 404`);
    assert.equal(read('index.html', out), read('index.html'),
      'index.html was modified by the build');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
