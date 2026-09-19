/* ═══════════════════════════════════════════════════════════════
   dev-geo-probe.js — who is lying about the page height?
   Prints GSAP's scroller cache vs the browser's own numbers, and
   what GSAP computes for a fresh '#film' bottom-bottom trigger.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:5577/';

(async () => {
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); }, 150000);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800', '--no-first-run'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('pageerror:', e.message.split('\n')[0]));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  process.stdout.write('waiting for film boot... ');
  await page.waitForFunction(() => window.Film3D && Film3D.isReady(), { timeout: 120000, polling: 1000 });
  console.log('ready');
  await new Promise(r => setTimeout(r, 4000));

  const out = await page.evaluate(() => {
    const el = document.getElementById('film');
    const r = el.getBoundingClientRect();
    const master = ScrollTrigger.getAll().filter(t => t.trigger && t.trigger.id === 'film')[0];

    // what would GSAP say for a brand-new bottom-bottom trigger right now?
    let fresh = null;
    try {
      const t = ScrollTrigger.create({ trigger: '#film', start: 'top top', end: 'bottom bottom' });
      fresh = { start: Math.round(t.start), end: Math.round(t.end) };
      t.kill();
    } catch (e) { fresh = 'ERR ' + e.message; }

    return {
      win_scrollHeight: document.documentElement.scrollHeight,
      win_clientHeight: document.documentElement.clientHeight,
      win_maxScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      body_scrollHeight: document.body.scrollHeight,
      film_rect: { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) },
      film_offset: { top: el.offsetTop, height: el.offsetHeight },
      container: (() => { const s = getComputedStyle(el); return { position: s.position, overflow: s.overflow, height: s.height }; })(),
      body_style: (() => { const s = getComputedStyle(document.body); return { overflow: s.overflow, overflowY: s.overflowY, height: s.height, position: s.position }; })(),
      html_style: (() => { const s = getComputedStyle(document.documentElement); return { overflow: s.overflow, overflowY: s.overflowY, height: s.height }; })(),
      ST_maxScroll: typeof ScrollTrigger.maxScroll === 'function' ? ScrollTrigger.maxScroll(window) : 'missing',
      ST_maxScroll_doc: typeof ScrollTrigger.maxScroll === 'function' ? ScrollTrigger.maxScroll(document.documentElement) : 'n/a',
      master: master ? { start: Math.round(master.start), end: Math.round(master.end) } : null,
      fresh_bottom_bottom: fresh,
    };
  });
  console.log(JSON.stringify(out, null, 1));

  clearTimeout(hardStop);
  await browser.close();
  process.exit(0);
})().catch(e => { console.log('PROBE FAIL:', e.message); process.exit(1); });
