/* ═══════════════════════════════════════════════════════════════
   scrubber.js — FilmScrubber
   The heart of the film: binds scroll progress to frame index on
   a canvas, with staged boot, direction-aware preloading, and
   subtle frame-blend when scrubbing fast (motion blur).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

class FilmScrubber {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} frames   { total, get(i):Promise<Image|Bitmap|null>, preloadAround? }
   * @param {object} opts     { reel: ScrollTrigger-like }
   */
  constructor(canvas, frames, opts = {}) {
    this.canvas = canvas;
    this.frames = frames;
    this.ctx = canvas.getContext('2d');
    this.total = frames.total;
    this.current = -1;
    this.pendingFrame = -1;
    this.reel = opts.reel || null;       // gets .progress via callback instead
    this.onframe = opts.onframe || null; // (frame, total) => void
    this.blend = 0;                      // motion-blend accumulator
    this.lastBmp = null;
  }

  /** draw frame i immediately if cached; else async then draw */
  show(i) {
    i = Math.max(1, Math.min(this.total, i | 0));
    if (i === this.current && this.lastBmp) return;
    this.current = i;
    const cached = this.frames.get(i); // may be promise
    Promise.resolve(cached).then((bmp) => {
      if (!bmp || this.current !== i) return; // stale
      this.lastBmp = bmp;
      this._paint(bmp);
      if (this.onframe) this.onframe(i, this.total);
      // direction-aware preload
      if (this.frames.preloadAround) {
        const dir = this._dir || 1;
        this.frames.preloadAround(i, dir, isMobile ? 3 : 5);
      }
    });
  }

  setDirection(d) { this._dir = d >= 0 ? 1 : -1; }

  _paint(bmp) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    drawCover(ctx, bmp, W, H);
  }
}
