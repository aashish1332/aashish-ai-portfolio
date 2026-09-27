/* ═══════════════════════════════════════════════════════════════
   tests/model-cache.test.mjs — §9.3's loader cache, and §14's
   offline-after-cache claim

   §4 says the first-use download is "One-time, then cached (0 MB on later
   visits)". Until this cache existed that sentence rested on the HTTP cache,
   which is a hint rather than a promise: it cannot be enumerated, cannot be
   deleted by version, and is not available to a page with the network cut.

   Everything here runs against a `caches`-shaped fake and a counting fetch,
   because the two things that matter are exactly the ones a real browser
   cannot show you: **was the network touched**, and **which bytes came back**.
   `dev-offline-probe.js` measures the same path in a real browser with the
   network actually cut; that probe is the e2e half, this is the half that can
   fail loudly in CI.

   Run:  node --test tests/
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWithCacheRecovery, modelCacheName, evictOtherModelCaches, createCachedFetch,
} from '../ai/engine/cache.mjs';
import { sha256hex } from '../ai/engine/manifest.mjs';

const MANIFEST = 'ai/model-export/aashish-ai-1/manifest.json';
const SHARD = 'ai/model-export/aashish-ai-1/weights-0.bin';

/** Deliberately not zeros: a wrong-byte entry has to differ from a right one. */
const bytesOf = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 7) & 255);

/** A `caches`-shaped fake that records what was opened, deleted and stored. */
function fakeCaches({ failOpen = false, failPut = false } = {}) {
  const stores = new Map();
  const log = { opened: [], deleted: [], puts: 0 };
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    log,
    seed(name, url, bytes) { store(name).set(url, bytes); },
    has(name, url) { return store(name).has(url); },
    bytes(name, url) { return store(name).get(url); },
    async open(name) {
      log.opened.push(name);
      if (failOpen) throw new Error('SecurityError: storage denied');
      return {
        async match(url) {
          const buf = store(name).get(url);
          return buf ? new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }) : undefined;
        },
        async put(url, res) {
          log.puts += 1;
          if (failPut) throw new Error('QuotaExceededError');
          store(name).set(url, new Uint8Array(await res.arrayBuffer()));
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { log.deleted.push(name); return stores.delete(name); },
  };
}

/** A fetch that counts calls and serves from a plain map of url → bytes. */
function countingFetch(files) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const bytes = files[url];
    if (!bytes) return new Response('not found', { status: 404 });
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
  };
  fn.calls = calls;
  return fn;
}

/** The shape `ScratchLlamaEngine.load` has: fetch a shard, check its hash. */
const shardLoader = (hash) => (fetchImpl) => (async () => {
  const res = await fetchImpl(SHARD);
  if (!res.ok) throw new Error(`shard weights-0.bin failed: ${res.status} ${SHARD}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = await sha256hex(bytes);
  if (actual !== hash) {
    throw new Error(`shard weights-0.bin failed its sha256 check ` +
      `(expected ${hash.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
  return { bytes: bytes.byteLength };
})();

const good = bytesOf(4096, 3);
const goodHash = await sha256hex(good);
const corrupt = bytesOf(4096, 9);

/* ── the name is the version ────────────────────────────────────── */
test('CACHE-1: the cache is keyed by the export version, from the URL alone', () => {
  assert.equal(modelCacheName(MANIFEST), 'aashish-ai-model:aashish-ai-1');
  assert.equal(modelCacheName('https://host/ai/model-export/aashish-ai-1/manifest.json'),
    'aashish-ai-model:aashish-ai-1');
  assert.equal(modelCacheName(MANIFEST + '?v=2'), 'aashish-ai-model:aashish-ai-1');
  /* a NEW export is automatically a new cache — no second source of truth */
  assert.equal(modelCacheName('ai/model-export/aashish-ai-2/manifest.json'),
    'aashish-ai-model:aashish-ai-2');
  assert.notEqual(modelCacheName(MANIFEST), modelCacheName('ai/model-export/aashish-ai-2/manifest.json'));
  /* degenerate input still produces a name rather than throwing */
  assert.ok(modelCacheName('').startsWith('aashish-ai-model:'));
  assert.ok(modelCacheName(null).startsWith('aashish-ai-model:'));
});

/* ── §4: "0 MB on later visits" ─────────────────────────────────── */
test('CACHE-2: the first visit downloads and stores; the second touches no network', async () => {
  const caches = fakeCaches();
  const fetch1 = countingFetch({ [SHARD]: good });
  const first = await loadWithCacheRecovery({
    cacheStorage: caches, cacheName: modelCacheName(MANIFEST), fetchImpl: fetch1,
    load: shardLoader(goodHash),
  });
  assert.equal(first.result.bytes, good.byteLength);
  assert.equal(fetch1.calls.length, 1, 'the shard must be downloaded once');
  assert.equal(first.stats.puts, 1, 'and stored for next time');
  assert.equal(first.stats.cached, true);
  assert.equal(caches.has(modelCacheName(MANIFEST), SHARD), true);

  /* second visit: a fresh fetch that FAILS if it is ever called */
  const fetch2 = countingFetch({});
  const second = await loadWithCacheRecovery({
    cacheStorage: caches, cacheName: modelCacheName(MANIFEST), fetchImpl: fetch2,
    load: shardLoader(goodHash),
  });
  assert.deepEqual(fetch2.calls, [],
    'a later visit hit the network — §4 promises 0 MB once cached');
  assert.equal(second.stats.hits, 1);
  assert.equal(second.stats.cacheBytes, good.byteLength);
  assert.equal(second.stats.puts, 0, 'nothing to store on a hit');
  assert.equal(second.result.bytes, good.byteLength);
});

test('CACHE-3: the same call works with no Cache Storage at all, and never throws', async () => {
  const fetchImpl = countingFetch({ [SHARD]: good });
  const { result, stats } = await loadWithCacheRecovery({
    cacheStorage: null, cacheName: 'unused', fetchImpl, load: shardLoader(goodHash),
  });
  assert.equal(result.bytes, good.byteLength);
  assert.deepEqual(fetchImpl.calls, [SHARD]);
  assert.equal(stats.cached, false);
});

test('CACHE-4: a cache that refuses to open, and one that refuses to write', async () => {
  /* a private window / storage-denied browser: open() rejects */
  const fetchImpl = countingFetch({ [SHARD]: good });
  const denied = await loadWithCacheRecovery({
    cacheStorage: fakeCaches({ failOpen: true }), cacheName: modelCacheName(MANIFEST),
    fetchImpl, load: shardLoader(goodHash),
  });
  assert.equal(denied.result.bytes, good.byteLength);
  assert.equal(denied.stats.cached, false);

  /* quota exhausted: the put fails, the load does not */
  const fetch2 = countingFetch({ [SHARD]: good });
  const quota = await loadWithCacheRecovery({
    cacheStorage: fakeCaches({ failPut: true }), cacheName: modelCacheName(MANIFEST),
    fetchImpl: fetch2, load: shardLoader(goodHash),
  });
  assert.equal(quota.result.bytes, good.byteLength);
  assert.equal(fetch2.calls.length, 1);
});

/* ── §9.3: versioning and eviction ──────────────────────────────── */
test('CACHE-5: old versions are deleted on activation, and nothing else is', async () => {
  const caches = fakeCaches();
  const old = 'aashish-ai-model:aashish-ai-0';
  const current = modelCacheName(MANIFEST);
  caches.seed(old, 'ai/model-export/aashish-ai-0/weights-0.bin', corrupt);
  caches.seed('some-other-app-cache', 'x', corrupt);

  const removed = await evictOtherModelCaches(caches, current);
  assert.deepEqual(removed, [old]);
  assert.deepEqual(caches.log.deleted, [old]);
  assert.equal(caches.has('some-other-app-cache', 'x'), true,
    'the loader deleted a cache it did not create');
  assert.equal(caches.has(current, SHARD), false);
});

test('CACHE-6: a poisoned cache entry is dropped and re-downloaded, once', async () => {
  /* The one failure a cache can cause and a re-download can fix: the stored
     bytes fail the manifest's own sha256. §9.3 asks for exactly this
     ("handle … later cache eviction (re-download or fall back)"). */
  const caches = fakeCaches();
  const name = modelCacheName(MANIFEST);
  caches.seed(name, SHARD, corrupt);          /* a half-written entry */

  const fetchImpl = countingFetch({ [SHARD]: good });
  const { result, stats } = await loadWithCacheRecovery({
    cacheStorage: caches, cacheName: name, fetchImpl, load: shardLoader(goodHash),
  });

  assert.equal(result.bytes, good.byteLength, 'the load must end up with good bytes');
  assert.deepEqual(fetchImpl.calls, [SHARD], 'and must have re-downloaded them exactly once');
  assert.equal(stats.recovered, true);
  assert.deepEqual(caches.log.deleted, [name]);
  /* the repaired bytes are what the next visit reads */
  assert.deepEqual(caches.bytes(name, SHARD), good);
});

test('CACHE-6b: a genuinely bad artifact still fails, and is not retried forever', async () => {
  /* The recovery must not become a mask: if the NETWORK gives the wrong bytes,
     the second attempt fails the same way and that is reported. */
  const caches = fakeCaches();
  const fetchImpl = countingFetch({ [SHARD]: corrupt });
  await assert.rejects(
    () => loadWithCacheRecovery({
      cacheStorage: caches, cacheName: modelCacheName(MANIFEST), fetchImpl,
      load: shardLoader(goodHash),
    }),
    /failed its sha256 check/,
  );
  assert.equal(fetchImpl.calls.length, 2, 'one cached attempt, one without the cache');
});

/* ── the wrapper itself ─────────────────────────────────────────── */
test('CACHE-7: createCachedFetch is fetch-shaped and reports what it did', async () => {
  const caches = fakeCaches();
  const fetchImpl = countingFetch({ [SHARD]: good });
  const cf = createCachedFetch({ cacheStorage: caches, cacheName: modelCacheName(MANIFEST), fetchImpl });

  const miss = await cf(SHARD);
  assert.equal(miss.ok, true);
  assert.equal(new Uint8Array(await miss.arrayBuffer()).byteLength, good.byteLength);
  assert.deepEqual(cf.stats, { hits: 0, misses: 1, puts: 1, cacheBytes: 0, cached: true });

  const hit = await cf(SHARD);
  assert.equal(hit.ok, true, 'a cache hit must look like an OK response to the loader');
  assert.equal(hit.headers.get('content-type'), 'application/octet-stream');
  assert.equal(cf.stats.hits, 1);
  assert.equal(cf.stats.cacheBytes, good.byteLength);
  assert.equal(fetchImpl.calls.length, 1);

  /* a 404 is not stored: caching a failure would make it permanent */
  const missing = await cf('ai/model-export/aashish-ai-1/nope.bin');
  assert.equal(missing.ok, false);
  assert.equal(caches.has(modelCacheName(MANIFEST), 'ai/model-export/aashish-ai-1/nope.bin'), false);
});
