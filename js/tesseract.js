/* ═══════════════════════════════════════════════════════════════
   tesseract.js — a real 4D hypercube, live-rendered
   16 vertices in R⁴, double rotation in XW/YZ planes, perspective
   projection 4D→3D, then 3D→2D. Drag = extra angular velocity.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Tesseract = (() => {
  let canvas, ctx, W, H, raf = null;
  let running = false;

  /* --- generate 16 vertices of the 4-cube --- */
  const V4 = [];
  for (let i = 0; i < 16; i++) {
    V4.push([
      (i & 1) ? 1 : -1,
      (i & 2) ? 1 : -1,
      (i & 4) ? 1 : -1,
      (i & 8) ? 1 : -1,
    ]);
  }
  /* --- edges: vertices differing in exactly one coordinate --- */
  const EDGES = [];
  for (let i = 0; i < 16; i++) {
    for (let b = 0; b < 4; b++) {
      const j = i ^ (1 << b);
      if (j > i) EDGES.push([i, j]);
    }
  }

  /* --- state --- */
  let axw = 0.35, ayz = 0.28, axy = 0.12; // angular velocities
  let thxw = 0, thyz = 0, thxy = 0;
  let velBoost = { xw: 0, yz: 0 };

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    size();
    window.addEventListener('resize', size);

    /* drag interaction */
    let dragging = false, lx = 0, ly = 0;
    const down = (x, y) => { dragging = true; lx = x; ly = y; };
    const move = (x, y) => {
      if (!dragging) return;
      velBoost.xw += (y - ly) * 0.00035;
      velBoost.yz += (x - lx) * 0.00035;
      lx = x; ly = y;
    };
    const up = () => { dragging = false; };

    canvas.addEventListener('pointerdown', (e) => { down(e.clientX, e.clientY); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('pointerup', up);
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
  }

  function size() {
    if (!canvas) return;
    const c = fitCanvas(canvas);
    ctx = c;
    W = canvas.width; H = canvas.height;
  }

  function start() {
    if (running) return;
    running = true;
    loop();
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
  }

  function loop() {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    step();
    draw();
  }

  function step() {
    thxw += axw + velBoost.xw;
    thyz += ayz + velBoost.yz;
    thxy += axy;
    // boost decays back toward zero (inertia)
    velBoost.xw *= 0.95;
    velBoost.yz *= 0.95;
  }

  function rotate4(v) {
    // XW plane
    let [x, y, z, w] = v;
    let c = Math.cos(thxw), s = Math.sin(thxw);
    [x, w] = [x * c - w * s, x * s + w * c];
    // YZ plane
    c = Math.cos(thyz); s = Math.sin(thyz);
    [y, z] = [y * c - z * s, y * s + z * c];
    // XY plane (slow)
    c = Math.cos(thxy); s = Math.sin(thxy);
    [x, y] = [x * c - y * s, x * s + y * c];
    return [x, y, z, w];
  }

  function project4(v) {
    const d = 2.6;                        // 4D perspective distance
    const w = 1 / (d - v[3]);
    return [v[0] * w, v[1] * w, v[2] * w, w]; // 4D->3D (perspective)
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    const scale = Math.min(W, H) * 0.22;
    const cx = W / 2, cy = H / 2;

    const pts3 = V4.map((v) => project4(rotate4(v)));

    // depth-sort edges by average w for color
    EDGES.forEach(([i, j]) => {
      const a = pts3[i], b = pts3[j];
      const depth = (a[3] + b[3]) / 2; // closer = larger w
      const t = clamp01((depth - 0.28) / 0.5);
      const col = mixRGB([89, 243, 255], [255, 77, 0], t);
      const alpha = 0.25 + t * 0.75;

      ctx.strokeStyle = rgb(col, alpha);
      ctx.lineWidth = (0.6 + t * 1.8) * dpr();
      ctx.beginPath();
      ctx.moveTo(cx + a[0] * scale, cy + a[1] * scale);
      ctx.lineTo(cx + b[0] * scale, cy + b[1] * scale);
      ctx.stroke();
    });

    // vertices
    pts3.forEach((p) => {
      const t = clamp01((p[3] - 0.28) / 0.5);
      const r = (1.4 + t * 3.2) * dpr();
      ctx.fillStyle = rgb(mixRGB([242, 239, 230], [255, 77, 0], t), 0.9);
      ctx.beginPath();
      ctx.arc(cx + p[0] * scale, cy + p[1] * scale, r, 0, Math.PI * 2);
      ctx.fill();
    });

    // subtle glow center
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 1.6);
    g.addColorStop(0, 'rgba(89,243,255,0.06)');
    g.addColorStop(1, 'rgba(89,243,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  return { init, start, stop };
})();
