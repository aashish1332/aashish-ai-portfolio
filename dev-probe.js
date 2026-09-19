/* dev-probe.js — verification probe (puppeteer-core + installed Chrome) */
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* decode PNG via Chrome itself to avoid deps: we diff using canvas in-page */
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--window-size=1380,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('http://localhost:5577/', { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(6500);

  /* ── computed backdrop-filter audit ── */
  const audit = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'MISSING';
      const cs = getComputedStyle(el);
      return cs.backdropFilter || cs.webkitBackdropFilter || '(none)';
    };
    return {
      btn: q('.take.is-active .btn, .btn'),
      brand: q('.hud__brand'),
      sound: q('.sound'),
      perfchip: q('.perfchip'),
    realBtns: document.querySelectorAll('.btn').length,
    };
  });
  console.log('=== COMPUTED backdrop-filter ===');
  console.log('btn      :', audit.btn, `(${audit.realBtns} .btn elements)`);
  url: 'http://localhost:5577/' && console.log('brand    :', audit.brand);
  console.log('sound    :', audit.sound);
  console.log('perfchip :', audit.perfchip);

  /* ── pixel-difference refraction test on a probe rect ── */
  const diff = await page.evaluate(async () => {
    const mk = () => {
      const d = document.createElement('div');
      d.id = 'probeX';
      d.style.cssText = 'position:fixed;left:520px;top:300px;width:280px;height:160px;z-index:3000;';
      document.body.appendChild(d);
      return d;
    };
    const probe = mk();
    probe.style.backdropFilter = 'url(#glass-filter-1)';

    /* scroll the film behind it and diff frames via in-page canvas */
    const draw = (src) => {
      const c = document.createElement('canvas');
      c.width = 280; c.height = 160;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(src, 0, 0, 280, 160);
      return ctx.getImageData(0, 0, 280, 160).data;
    };
    /* html2canvas-free approach: can't read DOM via drawImage —
       instead diff the PAGE screenshots done outside; here we just
       confirm the filter is live by sampling the probe's computed
       style and the filter's feImage href length */
    const feImage = document.querySelector('#glass-filter-1 feImage, #probeX');
    const filter = document.querySelector('filter[id^="glass-filter-"]');
    return {
      probeFilter: getComputedStyle(probe).backdropFilter,
      filterCount: document.querySelectorAll('filter[id^="glass-filter-"]').length,
      feImageHrefLen: filter ? (filter.querySelector('feImage')?.getAttribute('href') || '').length : 0,
    };
  });
  console.log('\n=== LIVE FILTER STATE ===');
  console.log(JSON.stringify(diff, null, 2));

  await page.screenshot({ path: 'dev-probe-final.png' });
  await browser.close();
  console.log('\nScreenshot: dev-probe-final.png');
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
