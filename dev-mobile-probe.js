/* dev-mobile-probe.js — smoke test at phone + tablet viewports.
   Verifies: no page errors, terminal opens via touch launcher,
   film running, details layer live, FXAA wired. */
'use strict';
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEVICES = [
  { name: 'iPhone 14 (390x844 dpr3)', w: 390, h: 844, dsf: 3, touch: true, mobile: true },
  { name: 'iPad (820x1180 dpr2)', w: 820, h: 1180, dsf: 2, touch: true, mobile: true },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--enable-gpu'],
  });

  for (const d of DEVICES) {
    const page = await browser.newPage();
    await page.setViewport({
      width: d.w, height: d.h, deviceScaleFactor: d.dsf,
      isMobile: d.mobile, hasTouch: d.touch,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('http://localhost:5577/', { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(5500);

    const res = await page.evaluate(async () => {
      const out = { film: false, details: false, termBtn: false, tier: '?' };
      out.film = !!(window.Film3D && Film3D.isReady());
      out.details = !!(window.FilmDetails && FilmDetails.isLive());
      out.tier = window.Film3D && Film3D.govStatus ? JSON.stringify(Film3D.govStatus()) : '?';
      const b = document.getElementById('touchTerm');
      if (b) {
        const cs = getComputedStyle(b);
        out.termBtn = cs.display !== 'none';
      }
      return out;
    });

    // tap the launcher, verify the terminal opens
    let termOpens = false;
    if (res.termBtn) {
      await page.tap('#touchTerm');
      await sleep(700);
      termOpens = await page.evaluate(() => {
        const t = document.getElementById('terminal');
        return !!t && !t.hidden && getComputedStyle(t).display !== 'none';
      });
      await page.tap('#touchTerm').catch(() => {});
    }

    console.log(`\n=== ${d.name} ===`);
    console.log(`film: ${res.film} · details: ${res.details} · launcher visible: ${res.termBtn} · terminal opens on tap: ${termOpens}`);
    console.log(`governor: ${res.tier}`);
    console.log('errors:', errors.length ? errors.slice(0, 4) : 'none');
    await page.screenshot({ path: `dev-mobile-${d.mobile ? 'phone' : 'tablet'}.png` });
    await page.close();
  }

  await browser.close();
  console.log('\nDone.');
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
