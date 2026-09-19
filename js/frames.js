/* ═══════════════════════════════════════════════════════════════
   frames.js — frame sources
   1) SeqFrames: the Apple/Zajno standard — pre-rendered WebP/PNG
      sequence with staged + direction-aware loading.
   2) ProceduralFrames: renders deterministic 3D frames on demand
      with an LRU cache (used when no /frames folder exists).
   Both share one interface: { total, get(i) -> Promise<Image|null> }
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ---------- 1. Pre-rendered sequence (production path) ---------- */
class SeqFrames {
  /**
   * @param {object} o
   * @param {number} o.total       frame count
   * @param {string} o.dir         e.g. "frames/desktop"
   * @param {string} [o.prefix]    "frame_"
   * @param {string} [o.ext]       "webp"
   * @param {function} onProgress  (loaded, total) => void
   */
  constructor(o) {
    this.total = o.total;
    this.dir = o.dir;
    this.prefix = o.prefix || 'frame_';
    this.ext = o.ext || 'webp';
    this.cache = new Map();
    this.onProgress = o.onProgress || (() => {});
    this.loaded = 0;
  }

  src(i) {
    return `${this.dir}/${this.prefix}${pad3(i)}.${this.ext}`;
  }

  /** staged loading: first 10 frames now, rest in background */
  async boot() {
    const first = Math.min(10, this.total);
    await Promise.all(Array.from({ length: first }, (_, k) => this.get(k + 1)));
    this.render(1);
    // background load the rest
    for (let i = first + 1; i <= this.total; i++) this.get(i);
  }

  render(i) {
    const img = this.cache.get(i);
    return img || null;
  }

  get(i) {
    if (this.cache.has(i)) return Promise.resolve(this.cache.get(i));
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        this.cache.set(i, img);
        this.loaded++;
        this.onProgress(this.loaded, this.total);
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = this.src(i);
    });
  }

  /** direction-aware preload: OPTIKKA trick */
  preloadAround(i, dir = 1, amount = 5) {
    for (let k = 1; k <= amount; k++) this.get(i + dir * k);
  }
}

/* ---------- 2. Procedural fallback (this demo's engine) ---------- */
class ProceduralFrames {
  /**
   * @param {function} renderer (ctx, W, H, t, opts) => void
   * @param {number} total
   * @param {HTMLCanvasElement} canvas
   */
  constructor(renderer, total, canvas) {
    this.renderer = renderer;
    this.total = total;
    this.canvas = canvas;
    this.lru = new Map();     // frame -> ImageBitmap
    this.max = isMobile ? 70 : 130;   // cache size
    this.pending = new Map(); // frame -> Promise
    this.onProgress = () => {};
  }

  setProgress(fn) { this.onProgress = fn; }

  key(i) { return i; }

  /**
   * Render frame i offscreen and cache as ImageBitmap.
   * Resolves with the bitmap (or null).
   */
  get(i) {
    i = Math.max(1, Math.min(this.total, i | 0));
    if (this.lru.has(i)) return Promise.resolve(this.lru.get(i));
    if (this.pending.has(i)) return this.pending.get(i);

    const p = this._make(i).then((bmp) => {
      this.pending.delete(i);
      this.lru.set(i, bmp);
      // LRU eviction
      while (this.lru.size > this.max) {
        const first = this.lru.keys().next().value;
        const b = this.lru.get(first);
        if (b && b.close) b.close();
        this.lru.delete(first);
      }
      return bmp;
    }).catch(() => {
      this.pending.delete(i);
      return null;
    });

    this.pending.set(i, p);
    return p;
  }

  async _make(i) {
    const t = (i - 1) / (this.total - 1);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const off = new OffscreenCanvas(W, H);
    const ctx = off.getContext('2d');
    this.renderer(ctx, W, H, t, { frame: i });
    return createImageBitmap(off);
  }

  preloadAround(i, dir = 1, amount = 5) {
    for (let k = 1; k <= amount; k++) {
      this.get(i + dir * k);
    }
  }
}
