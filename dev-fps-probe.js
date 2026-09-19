/* dev-fps-probe.js — measures real framerate with the details layer live.
   Loads the page headlessly, parks the film at a heavy mid-flight
   position, samples rAF deltas for 6s per probe point, and reports
   fps + governor tier + details-layer status. */
'use strict';
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--window-size=1380,900', '--enable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://localhost:5577/', { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(6000); // boot + governor grace period

  const probeAt = async (label, p) => {
    await page.evaluate((pp) => { window.Film3D && window.Film3D.set(pp); }, p);
    await sleep(1500); // let the scrub settle
    const res = await page.evaluate(() => new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      let n = 0;
      const T = 360; // ~6s of frames
      function frame(now) {
        deltas.push(now - last); last = now;
        if (++n >= T) {
          deltas.sort((a, b) => a - b);
          const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
          const med = deltas[(deltas.length / 2) | 0];
          const p95 = deltas[(deltas.length * 0.95) | 0];
          const st = window.Film3D.govStatus ? window.Film3D.govStatus() : {};
          resolve({
            avgFps: +(1000 / avg).toFixed(1),
            medFps: +(1000 / med).toFixed(1),
            p95ms: +p95.toFixed(1),
            tier: `${st.tier}·${st.label}`,
            scale: st.scale,
            details: window.FilmDetails ? window.FilmDetails.isLive() : false,
            webglFilm: !!(window.Film3D && window.Film3D.isReady && window.Film3D.isReady()),
          });
        } else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }));
    console.log(`[${label}] avg ${res.avgFps} fps · median ${res.medFps} fps · p95 ${res.p95ms}ms · tier ${res.tier} · res ${res.scale}`);
    if (!res.details || !res.webglFilm) console.log('   !! detailsLive=' + res.details, 'webglFilm=' + res.webglFilm);
  };

  await probeAt('dusk approach  p=0.05', 0.05);
  await probeAt('boulevard      p=0.35', 0.35);
  await probeAt('monolith       p=0.60', 0.60);
  await probeAt('night orbit    p=0.90', 0.90);

  console.log('\npage errors:', errors.length ? errors.slice(0, 6) : 'none');
  await page.screenshot({ path: 'dev-fps-last.png' });
  await browser.close();
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
