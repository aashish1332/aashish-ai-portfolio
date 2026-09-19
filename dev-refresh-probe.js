/* ═══════════════════════════════════════════════════════════════
   dev-refresh-probe.js — is the master film range stale?
   Reports #film geometry + the master trigger's start/end, then
   re-measures after ScrollTrigger.refresh().
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:5577/';

const snap = `(() => {
  const film = document.getElementById('film');
  const master = (window.ScrollTrigger ? ScrollTrigger.getAll() : [])
    .filter(t => t.trigger && t.trigger.id === 'film')[0];
  const docMax = document.documentElement.scrollHeight - window.innerHeight;
  return {
    docH: document.documentElement.scrollHeight,
    filmH: film ? film.offsetHeight : -1,
    docMax: Math.round(docMax),
    scrollY: Math.round(window.scrollY),
    masterStart: master ? Math.round(master.start) : -1,
    masterEnd: master ? Math.round(master.end) : -1,
    masterSpan: master ? Math.round(master.end - master.start) : -1,
    triggers: window.ScrollTrigger ? ScrollTrigger.getAll().length : -1,
    prog: (window.Film3D && Film3D.govStatus().prog),
    cur: (window.Film3D && Film3D.govStatus().current),
  };
})()`;

(async () => {
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); }, 170000);
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

  console.log('\n--- BEFORE REFRESH ---');
  console.log(JSON.stringify(await page.evaluate(snap), null, 1));

  // park the scroll at 50% and see what film progress the engine gets
  await page.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * 0.5));
  await new Promise(r => setTimeout(r, 1500));
  console.log('prog @50% scroll =', JSON.stringify(await page.evaluate(snap)));

  console.log('\n--- CALLING ScrollTrigger.refresh() ---');
  await page.evaluate(() => window.ScrollTrigger && ScrollTrigger.refresh());
  await new Promise(r => setTimeout(r, 2000));

  console.log(JSON.stringify(await page.evaluate(snap), null, 1));
  console.log('prog @50% after refresh =', JSON.stringify(await page.evaluate(snap)));

  clearTimeout(hardStop);
  await browser.close();
  process.exit(0);
})().catch(e => { console.log('PROBE FAIL:', e.message); process.exit(1); });
