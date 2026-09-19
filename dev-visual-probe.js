/* ═══════════════════════════════════════════════════════════════
   dev-visual-probe.js — the LOOK probe
   Freezes the film at fixed scroll positions at a FIXED quality
   tier (tier 0 = mirror + bloom + FXAA + 100% res, i.e. what a real
   GPU shows), screenshots each one, and measures the image so
   before/after visual work can be compared objectively:

     mean   — overall exposure (blow-out detector)
     std    — contrast / local variance (detail + depth detector)
     p01/p99— black & white clipping (banding / crush detector)
     sat    — mean saturation (colour richness)
     edge   — mean gradient magnitude (sharpness / clarity)

   Usage:  TAG=before node dev-visual-probe.js
           TAG=after  node dev-visual-probe.js
           TIER=4 TAG=floor node dev-visual-probe.js
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.URL || 'http://localhost:5577/';
const TAG = process.env.TAG || 'run';
const TIER = process.env.TIER === undefined ? 0 : +process.env.TIER;
const STATS_ONLY = !!process.env.STATS_ONLY;   // analyse existing shots/<TAG>/*.png
const OUT = path.join('shots', TAG);
const POSITIONS = process.env.POS
  ? process.env.POS.split(',').map(Number)          // POS=0.55 → a single frame
  : [0.05, 0.22, 0.38, 0.55, 0.68, 0.85];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run'],
  });
  const page = await browser.newPage();
  /* VP=1920x950 overrides the two presets, so a shot can be taken at the
     exact size the thing is being reported at. */
  const vp = (process.env.VP || '').split('x').map(Number);
  await page.setViewport(vp.length === 2 && vp.every(Number.isFinite)
    ? { width: vp[0], height: vp[1] }
    : process.env.MOBILE
      ? { width: 390, height: 844, isMobile: true, hasTouch: true }
      : { width: 1280, height: 800 });

  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

  let shots = [];
  if (STATS_ONLY) {
    /* no rendering — just measure the PNGs already on disk */
    await page.goto('about:blank');
    shots = fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).sort()
      .map((f) => ({ p: f, file: path.join(OUT, f), gov: null }));
    console.log('analysing', shots.length, 'shots in', OUT);
  } else {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.Film3D && Film3D.isReady(), { timeout: 120000, polling: 1000 });
    await sleep(4000);

    /* MAP=1 — print where each scene sits in the global film progress.
       Needed whenever a scene is added/removed, because the camera path
       and colour grade are both driven by total-scroll progress. */
    if (process.env.MAP) {
      const map = await page.evaluate(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        return {
          max,
          /* GSAP pinning wraps each scene in a .pin-spacer and takes the
             section itself out of flow, so the SPACER is what carries the
             real scroll offset. */
          scenes: [...document.querySelectorAll('.scene')].map((s) => {
            const box = s.parentElement.classList.contains('pin-spacer') ? s.parentElement : s;
            const rect = box.getBoundingClientRect();
            const top = rect.top + window.scrollY;
            return {
              id: s.id,
              height: Math.round(rect.height),
              start: +(top / max).toFixed(4),
              mid: +((top + rect.height / 2) / max).toFixed(4),
              end: +((top + rect.height) / max).toFixed(4),
            };
          }),
        };
      });
      console.log('maxScroll =', map.max, '\n');
      console.log('scene'.padEnd(18) + 'start   mid     end     height');
      map.scenes.forEach((s) => console.log((s.id || '?').padEnd(18) + String(s.start).padEnd(8) + String(s.mid).padEnd(8) + String(s.end).padEnd(8) + s.height));
      await browser.close();
      process.exit(0);
    }

    /* lock the tier so every shot is rendered at identical quality */
    await page.evaluate((t) => Film3D.forceTier(t), TIER);

    const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    for (const p of POSITIONS) {
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(maxScroll * p));
      await sleep(2200);                                 // scrub settles + grade lerps
      const file = path.join(OUT, `p${String(Math.round(p * 100)).padStart(2, '0')}.png`);
      await page.screenshot({ path: file });
      const gov = await page.evaluate(() => Film3D.govStatus());
      shots.push({ p, file, gov });
      console.log(`shot p=${p.toFixed(2)}  tier ${gov.tier}·${gov.label}  res ${gov.scale}  fps ${gov.fps}`);
    }
  }

  /* ── image analysis: decode the PNGs in Chrome, read the pixels ── */
  const stats = await page.evaluate(async (items) => {
    const out = {};
    for (const it of items) {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = it.url; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const n = c.width * c.height;
      let sum = 0, sum2 = 0, sat = 0;
      const lum = new Float32Array(n);
      const hist = new Uint32Array(256);
      for (let i = 0, k = 0; i < d.length; i += 4, k++) {
        const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
        const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        lum[k] = L; sum += L; sum2 += L * L;
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        sat += mx > 0 ? (mx - mn) / mx : 0;
        hist[Math.min(255, (L * 255) | 0)]++;
      }
      const mean = sum / n;
      const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      /* percentiles from the histogram */
      let acc = 0, p01 = 0, p99 = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (!p01 && acc >= n * 0.01) p01 = v / 255; }
      acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.99) { p99 = v / 255; break; } }
      /* edge energy: 4-neighbour gradient, sampled on a stride grid */
      let edgeSum = 0, edgeN = 0;
      const S = 3, W = c.width, H = c.height;
      for (let y = 1; y < H - 1; y += S) {
        for (let x = 1; x < W - 1; x += S) {
          const i = y * W + x;
          const gx = lum[i + 1] - lum[i - 1];
          const gy = lum[i + W] - lum[i - W];
          edgeSum += Math.abs(gx) + Math.abs(gy); edgeN++;
        }
      }
      out[it.key] = {
        mean: +mean.toFixed(4), std: +std.toFixed(4),
        p01: +p01.toFixed(3), p99: +p99.toFixed(3),
        sat: +(sat / n).toFixed(4), edge: +(edgeSum / edgeN).toFixed(5),
      };
    }
    return out;
  }, shots.map((s) => ({ key: path.basename(s.file), url: 'data:image/png;base64,' + fs.readFileSync(s.file).toString('base64') })));

  console.log('\npos    mean    std     p01   p99   sat     edge    file');
  shots.forEach((s, i) => {
    const st = stats[path.basename(s.file)] || {};
    const label = 'p' + String(s.p).replace(/^p|\.png$/g, '');
    console.log(
      label.padEnd(6) +
      String(st.mean).padEnd(8) + String(st.std).padEnd(8) + String(st.p01).padEnd(6) +
      String(st.p99).padEnd(6) + String(st.sat).padEnd(8) + String(st.edge).padEnd(8) + s.file
    );
  });
  console.log('\nerrors:', errs.length ? errs : 'none');
  await browser.close();
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.log('PROBE FAIL:', e.message); process.exit(1); });
