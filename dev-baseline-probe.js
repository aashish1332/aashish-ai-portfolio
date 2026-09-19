/* dev-baseline-probe.js — Phase 0 baseline metrics (Aashish AI prompt §15.1)
   Loads the portfolio once with no AI code present, then:
     1. counts initial-load requests + transferred bytes (CDP Network)
     2. captures LCP (PerformanceObserver) and a TBT proxy (long-task sum)
     3. runs a scripted 30 s scroll and samples GSAP-ticker frame deltas
   Writes docs/BASELINE.json. Dev-only; never shipped to the browser.

   Usage:  node dev-baseline-probe.js                 (default run)
           THROTTLE=4 node dev-baseline-probe.js       (4x CPU throttle, profile R2)
           SCROLL_S=10 node dev-baseline-probe.js      (shorter smoke run)
   Labels: MEASURED = direct observation · ESTIMATED = derived formula
*/
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URL_ = process.env.URL || 'http://localhost:5577/';
const LABEL = process.env.LABEL || 'baseline';
const SCROLL_S = Number(process.env.SCROLL_S || 30);
const THROTTLE = process.env.THROTTLE ? Number(process.env.THROTTLE) : null;
const OUT = process.env.OUT || path.join(__dirname, 'docs', 'BASELINE.json');
const ORIGIN = URL_.replace(/\/$/, '');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--window-size=1380,900', '--enable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1 });

  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const reqs = new Map();
  cdp.on('Network.responseReceived', (e) => {
    reqs.set(e.requestId, {
      url: e.response.url, type: e.type || 'Other',
      status: e.response.status, bytes: 0,
    });
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.bytes = e.encodedDataLength || 0;
  });
  if (THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000); // fonts + boot + governor grace window

  /* ─ 1. initial-load network ─────────────────────────────────── */
  const list = [...reqs.values()];
  const byType = {};
  let totalBytes = 0;
  for (const r of list) {
    const t = (byType[r.type] = byType[r.type] || { count: 0, bytes: 0 });
    t.count++; t.bytes += r.bytes; totalBytes += r.bytes;
  }
  const jsBytes = (byType.Script || { bytes: 0 }).bytes;
  const load = {
    requestCount: list.length,
    totalBytes,
    jsBytes,
    thirdPartyRequests: list.filter((r) => !r.url.startsWith(ORIGIN)).length,
    byType,
  };

  /* ── 2. paint + long tasks ───────────────────────────────────── */
  const paint = await page.evaluate(() => new Promise((resolve) => {
    let lcp = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; })
        .observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) { /* unsupported */ }
    let longTaskMs = 0, longTaskCount = 0, maxTask = 0;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          longTaskMs += e.duration; longTaskCount++;
          if (e.duration > maxTask) maxTask = e.duration;
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) { /* unsupported */ }
    setTimeout(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      resolve({
        lcpMs: Math.round(lcp),
        tbtProxyMs: Math.round(longTaskMs),
        longTaskCount, maxLongTaskMs: Math.round(maxTask),
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
        loadEventMs: Math.round(nav.loadEventEnd || 0),
      });
    }, 700);
  }));

  const device = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: navigator.deviceMemory || null,
    devicePixelRatio: window.devicePixelRatio,
    hoverNone: window.matchMedia('(hover: none)').matches,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    saveData: (navigator.connection && navigator.connection.saveData) || null,
    effectiveType: (navigator.connection && navigator.connection.effectiveType) || null,
    worker: typeof Worker !== 'undefined',
    webgpu: !!navigator.gpu,
    gpuRenderer: (() => {
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return 'no-webgl';
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'masked';
      } catch (e) { return 'unknown'; }
    })(),
  }));

  /* ── 3. scripted scroll + GSAP-ticker frame deltas ───────────── */
  const scroll = await page.evaluate((secs) => new Promise((resolve) => {
    const deltas = [];
    let longMs = 0, lts = 0;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) { longMs += e.duration; lts++; }
      }).observe({ type: 'longtask', buffered: false });
    } catch (e) { /* unsupported */ }

    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const start = performance.now();
    const duration = secs * 1000;
    let last = start;
    const before = window.Film3D && window.Film3D.govStatus ? window.Film3D.govStatus() : {};

    /* sample the EXISTING GSAP ticker — the app gains no new rAF loop */
    const onTick = () => {
      const now = performance.now();
      const dt = now - last;
      if (dt > 0 && dt < 500) deltas.push(dt);
      last = now;
    };
    const drive = () => {
      const now = performance.now();
      const p = Math.min(1, (now - start) / duration);
      window.scrollTo(0, Math.round(max * p));
      if (p < 1) requestAnimationFrame(drive);
      else {
        window.gsap.ticker.remove(onTick);
        deltas.sort((a, b) => a - b);
        const sum = deltas.reduce((s, d) => s + d, 0);
        const avg = sum / deltas.length;
        const median = deltas[(deltas.length / 2) | 0];
        const p95 = deltas[(deltas.length * 0.95) | 0];
        let dropped = 0;
        for (const d of deltas) if (d > 20) dropped++;
        const after = window.Film3D && window.Film3D.govStatus ? window.Film3D.govStatus() : {};
        resolve({
          frames: deltas.length,
          avgFps: +(1000 / avg).toFixed(1),
          medianMs: +median.toFixed(2),
          medianFps: +(1000 / median).toFixed(1),
          p95Ms: +p95.toFixed(2),
          droppedOver20ms: dropped,
          droppedPct: +((dropped / deltas.length) * 100).toFixed(1),
          longTaskMs: Math.round(longMs),
          longTaskCount: lts,
          mainThreadBusyPct: +((longMs / duration) * 100).toFixed(2),
          filmP: { before: before.current, after: after.current },
          governor: { tier: after.tier, label: after.label, scale: after.scale, mirror: after.mirror },
        });
      }
    };
    window.gsap.ticker.add(onTick);
    requestAnimationFrame(drive);
  }), SCROLL_S);

  const report = {
    label: LABEL,
    measuredAt: new Date().toISOString(),
    url: URL_,
    cpuThrottleRate: THROTTLE,
    device,
    load,
    paint,
    ['scroll' + SCROLL_S + 's']: scroll,
    pageErrors: errors,
    metricProvenance: {
      'load.requestCount': 'MEASURED (CDP Network, encodedDataLength)',
      'load.totalBytes': 'MEASURED (CDP Network, encodedDataLength, all resource types)',
      'paint.lcpMs': 'MEASURED (PerformanceObserver largest-contentful-paint)',
      'paint.tbtProxyMs': 'ESTIMATED (sum of longtask entries >= 50 ms in the load window; NOT Lighthouse TBT)',
      'scroll.medianMs/p95Ms/avgFps': 'MEASURED (GSAP ticker deltas during a scripted ' + SCROLL_S + ' s scroll)',
      'scroll.droppedPct': 'MEASURED (frames with delta > 20 ms / total frames)',
      'scroll.mainThreadBusyPct': 'ESTIMATED (longtask ms / wall ms; excludes sub-50 ms tasks)',
      lighthouseTBT: 'NOT TESTED (requires the lighthouse CLI; see docs/MANUAL_TEST_CHECKLIST.md)',
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const kb = (b) => (b / 1024).toFixed(1) + ' KB';
  console.log('── ' + LABEL.toUpperCase() + ' BASELINE ──');
  console.log('requests ' + load.requestCount + ' · transferred ' + kb(totalBytes) +
              ' · JS ' + kb(jsBytes) + ' · 3rd-party ' + load.thirdPartyRequests);
  console.log('LCP ' + paint.lcpMs + 'ms · TBT-proxy ' + paint.tbtProxyMs + 'ms (longtasks ' +
              paint.longTaskCount + ', max ' + paint.maxLongTaskMs + 'ms)');
  console.log('scroll' + SCROLL_S + 's: ' + scroll.frames + ' frames · median ' + scroll.medianMs +
              'ms (' + scroll.medianFps + ' fps) · avg ' + scroll.avgFps + ' fps · p95 ' + scroll.p95Ms +
              'ms · dropped>20ms ' + scroll.droppedPct + '% · busy ' + scroll.mainThreadBusyPct + '%');
  console.log('film p ' + scroll.filmP.before + ' -> ' + scroll.filmP.after +
              ' · governor tier ' + scroll.governor.tier + '·' + scroll.governor.label +
              ' · res ' + scroll.governor.scale);
  console.log('page errors: ' + (errors.length ? JSON.stringify(errors.slice(0, 5)) : 'none'));
  console.log('-> ' + OUT);

  await browser.close();
})().catch((e) => { console.error('BASELINE PROBE FAILED:', e.message); process.exit(1); });