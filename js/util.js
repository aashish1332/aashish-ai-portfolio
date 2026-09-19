/* ═══════════════════════════════════════════════════════════════
   util.js — tiny helpers
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

const isMobile = window.matchMedia('(max-width: 768px)').matches;

/** device-pixel-ratio capping for perf */
function dpr() {
  return Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);
}

/** Size a canvas to its CSS box * dpr, with cover-fit helper. Returns ctx. */
function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(2, Math.round(rect.width * dpr()));
  const h = Math.max(2, Math.round(rect.height * dpr()));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext('2d');
}

/** draw an image with object-fit:cover math into full canvas */
function drawCover(ctx, img, W, H) {
  const ir = img.width / img.height;
  const cr = W / H;
  let dw, dh;
  if (cr > ir) { dw = W; dh = W / ir; } else { dh = H; dw = H * ir; }
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/** [r,g,b] + alpha -> css rgba() string */
function rgb(c, a = 1) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

/** lerp between two [r,g,b] colours -> new [r,g,b] */
function mixRGB(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** pad frame numbers: 1 -> "001" */
const pad3 = (n) => String(n).padStart(3, '0');

/** split element into line-masked spans for scroll reveals */
function splitLines(el) {
  const text = el.innerHTML;
  el.innerHTML = '';
  const lines = text.split(/<br\s*\/?>/i);
  const out = [];
  lines.forEach((line) => {
    const mask = document.createElement('span');
    mask.className = 'split-line';
    const inner = document.createElement('span');
    inner.innerHTML = line;
    mask.appendChild(inner);
    el.appendChild(mask);
    out.push(inner);
  });
  return out;
}

/** format seconds -> SMPTE-ish timecode 00:MM:SS:FF */
function timecode(seconds, fps = 24) {
  const mm = Math.floor(seconds / 60) % 60;
  const ss = Math.floor(seconds) % 60;
  const ff = Math.floor((seconds % 1) * fps);
  const hh = Math.floor(seconds / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}
