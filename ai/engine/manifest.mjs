/* ═══════════════════════════════════════════════════════════════
   ai/engine/manifest.mjs — §9.3's loader: shards, hashes, versions.

   The manifest is the contract between `inference/export_browser.py` and
   this engine. Three properties matter enough to be enforced here rather
   than assumed:

   1. **Hashes.** Every shard carries a sha256, and a shard that does not
      match is rejected — a truncated download must fail loudly, not
      produce a model that answers slightly wrong.
   2. **Alignment.** A float32 view at an odd byte offset throws in
      JavaScript. The exporter pads each tensor to 4 bytes; this module
      *checks* it, so an exporter bug is a clear error instead of a
      `RangeError` from inside the model.
   3. **Versions.** `modelVersion` + `tokenizerVersion` are recorded, so a
      cached tokenizer from an older deploy cannot be paired with a newer
      weight file (the ids would still be integers, and every answer would
      be subtly wrong).
   ═══════════════════════════════════════════════════════════════ */

import { tensorFromBlock } from './quant.mjs';

export const ENGINE_FORMAT = 'aashish-llm/v1';

const REQUIRED_CONFIG = ['vocab_size', 'hidden_size', 'num_hidden_layers',
  'num_attention_heads', 'num_key_value_heads', 'intermediate_size'];

/** Validate a parsed manifest. Throws with a specific reason — a loader
 *  that fails vaguely makes a deploy failure indistinguishable from a
 *  corrupt cache entry. */
export function parseManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('manifest is not an object');
  if (raw.format !== ENGINE_FORMAT) {
    throw new Error(`manifest format ${JSON.stringify(raw.format)} is not ${ENGINE_FORMAT}`);
  }
  const config = raw.config;
  if (!config || typeof config !== 'object') throw new Error('manifest has no config');
  for (const key of REQUIRED_CONFIG) {
    const value = config[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`config.${key} is missing or not a positive integer`);
    }
  }
  if (!Array.isArray(raw.tensors) || raw.tensors.length === 0) {
    throw new Error('manifest has no tensors');
  }
  if (!Array.isArray(raw.shards) || raw.shards.length === 0) {
    throw new Error('manifest has no shards');
  }
  const tensors = new Map();
  for (const tensor of raw.tensors) {
    if (!tensor.name || !tensor.dtype || !Array.isArray(tensor.shape)) {
      throw new Error(`malformed tensor entry ${JSON.stringify(tensor).slice(0, 80)}`);
    }
    if (!Number.isInteger(tensor.shard) || tensor.shard < 0 || tensor.shard >= raw.shards.length) {
      throw new Error(`${tensor.name} points at shard ${tensor.shard}, which is not in the manifest`);
    }
    if ((tensor.offset ?? 0) % 4 !== 0) {
      throw new Error(`${tensor.name} starts at byte ${tensor.offset}, which is not 4-byte aligned`);
    }
    if (tensor.dtype === 'q8' && (tensor.offset + tensor.rows * tensor.cols) % 4 !== 0) {
      throw new Error(`${tensor.name}: its float32 scale half is misaligned`);
    }
    tensors.set(tensor.name, tensor);
  }
  for (const shard of raw.shards) {
    if (!shard.name || !Number.isInteger(shard.bytes) || typeof shard.sha256 !== 'string') {
      throw new Error(`malformed shard entry ${JSON.stringify(shard).slice(0, 80)}`);
    }
  }
  const total = raw.tensors.reduce((n, t) => n + t.bytes, 0);
  return {
    format: raw.format,
    modelVersion: raw.modelVersion,
    createdAt: raw.createdAt,
    config,
    tensors,
    shards: raw.shards,
    quantization: raw.quantization ?? {},
    tokenizer: raw.tokenizer,
    sizes: raw.sizes ?? {},
    source: raw.source ?? {},
    tensorBytes: total,
  };
}

/** sha256 → lowercase hex. Uses WebCrypto, which is present in every
 *  browser this ships to and in Node ≥ 18 (so the same code path is what
 *  the tests exercise — a Node-only hasher would leave the browser path
 *  untested, which is the path that matters). */
export async function sha256hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is unavailable, so shard hashes cannot be verified');
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch every shard and decode its tensors.
 *
 * @param {object} manifest  output of parseManifest
 * @param {{baseUrl?: string, fetchImpl?: Function, verify?: boolean,
 *          onProgress?: Function}} [opts]
 * @returns {Promise<{weights: Map<string, object>, bytes: number, verified: boolean}>}
 */
export async function loadWeights(manifest, opts = {}) {
  const {
    baseUrl = '', fetchImpl = fetch, verify = true, onProgress,
  } = opts;
  const weights = new Map();
  let loaded = 0;
  const totalBytes = manifest.shards.reduce((n, s) => n + s.bytes, 0);
  let verified = verify;

  for (const shard of manifest.shards) {
    const url = `${baseUrl}${shard.name}`;
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`shard ${shard.name} failed: ${response.status ?? 'no status'} ${url}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== shard.bytes) {
      throw new Error(`shard ${shard.name} is ${bytes.byteLength} bytes, manifest says ${shard.bytes}`);
    }
    if (verify) {
      const actual = await sha256hex(bytes);
      if (actual !== shard.sha256) {
        throw new Error(`shard ${shard.name} failed its sha256 check ` +
          `(expected ${shard.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — ` +
          `the download or the cache entry is corrupt`);
      }
    } else {
      verified = false;
    }
    loaded += bytes.byteLength;
    if (onProgress) onProgress({ loaded, total: totalBytes, shard: shard.name });

    for (const [name, meta] of manifest.tensors) {
      if (meta.shard !== manifest.shards.indexOf(shard)) continue;
      if (weights.has(name)) throw new Error(`duplicate tensor ${name}`);
      weights.set(name, tensorFromBlock(bytes, meta.offset, meta));
    }
  }

  for (const name of manifest.tensors.keys()) {
    if (!weights.has(name)) throw new Error(`tensor ${name} is in the manifest but was not decoded`);
  }
  return { weights, bytes: loaded, verified };
}

/** Every sha256 in the manifest must be lowercase hex of the right length —
 *  a manifest that says `sha256: ""` would make `verify` meaningless. */
export function manifestIssues(manifest) {
  const issues = [];
  for (const shard of manifest.shards) {
    if (!/^[0-9a-f]{64}$/.test(shard.sha256)) {
      issues.push(`shard ${shard.name} has an unusable sha256`);
    }
  }
  if (!manifest.tokenizer?.sha256 || !/^[0-9a-f]{64}$/.test(manifest.tokenizer.sha256)) {
    issues.push('tokenizer hash is missing or unusable');
  }
  if (!manifest.tokenizer?.version) issues.push('tokenizerVersion is missing (§9.3)');
  if (!manifest.modelVersion) issues.push('modelVersion is missing (§9.3)');
  return issues;
}
