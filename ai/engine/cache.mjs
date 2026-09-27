/* ═══════════════════════════════════════════════════════════════
   ai/engine/cache.mjs — §9.3's loader cache, in the worker

   Before this, "cached" meant the HTTP cache: a hint to the browser that can
   be evicted under pressure, cannot be enumerated to drop a stale version, and
   is not available to an offline page. §9.3 asks for real storage — "key by
   version; delete old versions on activation" — and §14's offline-after-cache
   test only means something once the storage is ours.

   Cache Storage (not OPFS: these artifacts are read once, in order, as whole
   buffers, which is what Cache Storage is), no service worker (§9.3), and
   every hit still sha256-verified by `loadWeights` — the cache is a source of
   bytes, not a source of trust, and a poisoned entry is what triggers the
   recovery below. No `caches`, a refused write or a quota error all fall back
   to the plain fetch path: a cache failure is never a load failure (§2 N7).
   ═══════════════════════════════════════════════════════════════ */

const CACHE_PREFIX = 'aashish-ai-model:';

/**
 * The cache name for a model version, taken from the export directory in the
 * manifest URL: `…/ai/model-export/aashish-ai-1/manifest.json` →
 * `aashish-ai-model:aashish-ai-1`. The version is already in the path (§9.3
 * ships one directory per version), so the name needs no second source of
 * truth — a new export is automatically a new cache.
 */
export function modelCacheName(manifestUrl) {
  const clean = String(manifestUrl || '').split(/[?#]/)[0].replace(/\/+$/, '');
  const dir = clean.slice(0, clean.lastIndexOf('/'));
  const version = dir.slice(dir.lastIndexOf('/') + 1) || 'default';
  return `${CACHE_PREFIX}${version}`;
}

/**
 * §9.3's "delete old versions on activation". Only names this module made are
 * touched — a page may share its storage with other things, and a loader has
 * no business deleting them.
 */
export async function evictOtherModelCaches(cacheStorage, keepName, opts = {}) {
  const prefix = opts.prefix || CACHE_PREFIX;
  if (!cacheStorage?.keys || !cacheStorage?.delete) return [];
  const removed = [];
  let names = [];
  try { names = await cacheStorage.keys(); } catch { return removed; }
  for (const name of names) {
    if (name === keepName || !String(name).startsWith(prefix)) continue;
    try { if (await cacheStorage.delete(name)) removed.push(name); } catch { /* leave it */ }
  }
  return removed;
}

/**
 * A `fetch` that reads from Cache Storage first and writes what it downloads.
 * Same signature as `fetch`, so it drops into every `fetchImpl` seam the
 * loader already has (manifest, tokenizer, shards) without touching them.
 */
export function createCachedFetch(opts = {}) {
  const { cacheStorage = null, cacheName, fetchImpl = fetch, onStats = null } = opts;
  const stats = { hits: 0, misses: 0, puts: 0, cacheBytes: 0, cached: false };
  let opening = null;

  const cache = () => {
    if (!cacheStorage?.open) return Promise.resolve(null);
    /* Opened once, and a failure is remembered as "no cache" rather than
       retried on every shard. */
    opening ||= Promise.resolve()
      .then(() => cacheStorage.open(cacheName))
      .then((c) => { stats.cached = true; onStats?.(stats); return c; })
      .catch(() => null);
    return opening;
  };

  const cachedFetch = async (url) => {
    const c = await cache();
    if (!c) { stats.misses += 1; onStats?.(stats); return fetchImpl(url); }

    let hit = null;
    try { hit = await c.match(url); } catch { hit = null; }
    if (hit) {
      const buf = await hit.arrayBuffer();
      stats.hits += 1;
      stats.cacheBytes += buf.byteLength;
      onStats?.(stats);
      /* A fresh Response, so the caller reads the bytes exactly like a network
         response and nothing downstream needs to know where they came from. */
      return new Response(buf, {
        status: 200,
        headers: { 'content-type': hit.headers?.get?.('content-type') || 'application/octet-stream' },
      });
    }

    const res = await fetchImpl(url);
    if (res?.ok) {
      /* The put is best-effort: a private window refuses it, and a quota that
         is gone would otherwise turn a good download into a failed one. */
      try { await c.put(url, res.clone()); stats.puts += 1; onStats?.(stats); } catch { /* not fatal */ }
    }
    stats.misses += 1;
    onStats?.(stats);
    return res;
  };
  cachedFetch.stats = stats;
  return cachedFetch;
}

/** True for the one failure a cache can cause and a re-download can fix. */
const isIntegrityFailure = (err) => /sha256|is \d+ bytes, manifest says/.test(String(err?.message || ''));

/**
 * Load with the cache, and once without it if the cache turned out to be the
 * problem.
 *
 * §9.3: "handle QuotaExceededError and later cache eviction (re-download or
 * fall back)". A cached shard that fails its own sha256 is a poisoned or
 * truncated entry — the download was fine when it was stored. Retrying the
 * whole load with the version's cache dropped is the honest repair: it costs
 * one re-download, it cannot mask a genuinely bad artifact (that fails the
 * same way again, and is reported), and it means a visitor whose storage got
 * mangled does not get a permanently broken assistant.
 *
 * @param {object|null} [opts.cacheStorage] `caches`-shaped, or null to disable
 * @param {string} [opts.cacheName]  `modelCacheName(manifestUrl)`
 * @param {Function} [opts.load]     `(fetchImpl) => Promise<engine>`
 */
export async function loadWithCacheRecovery(opts) {
  const {
    cacheStorage = null, cacheName, fetchImpl = fetch, load, onStats = null,
  } = opts;

  if (typeof load !== 'function') throw new Error('loadWithCacheRecovery needs a load() function');
  const stats = { hits: 0, misses: 0, puts: 0, cacheBytes: 0, cached: false, evicted: [], recovered: false };
  const watch = (s) => { Object.assign(stats, s); };

  /* Old versions go first, so their quota is free for this one (§9.3). */
  stats.evicted = await evictOtherModelCaches(cacheStorage, cacheName);

  const attempt = (storage) => load(createCachedFetch({
    cacheStorage: storage, cacheName, fetchImpl, onStats: watch,
  }));

  try {
    return { result: await attempt(cacheStorage), stats };
  } catch (err) {
    if (!cacheStorage || !isIntegrityFailure(err)) throw err;
    /* The whole version's cache goes, not just the one shard: the entry that
       failed is evidence about the store, and a second shard may be in the
       same state. Re-storing on the way back through is the repair — a
       visitor who hits this once pays one re-download and is then cached
       again. */
    try { await cacheStorage.delete(cacheName); } catch { /* already gone */ }
    stats.recovered = true;
    Object.assign(stats, { hits: 0, misses: 0, puts: 0, cacheBytes: 0, cached: false });
    return { result: await attempt(cacheStorage), stats };
  }
}
