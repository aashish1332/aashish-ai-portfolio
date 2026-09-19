/* ═══════════════════════════════════════════════════════════════
   dev-pacing-probe.js — measures the scroll→film mapping (streaming)
   Each scroll step is a separate evaluate; rows print as measured.
   ═══════════════════════════════════════ curl probe ═══════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:5577/';
const STEPS = 20; // coarse sweep — 21 rows

(async () => {
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); }, 165000);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800', '--no-first-run'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  process.stdout.write('waiting for film boot... ');
  await page.waitForFunction(() => window.Film3D && Film3D.isReady(), { timeout: 120000, polling: 1000 });
  console.log('ready');
  await new Promise(r => setTimeout(r, 5000)); // governor grace

  console.log('scroll% | DOM scene | camZ  camY | reel label');
  console.log('--------+-----------+------------+-----------');

  for (let step = 0; step <= STEPS; step++) {
    const pct = Math.round((step / STEPS) * 100);
    try {
      const row = await page.evaluate(async (pct) => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const y = (max * pct) / 100;
        window.scrollTo(0, y);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise(r => setTimeout(r, 120));
        const sceneEls = [...document.querySelectorAll('section[id^="scene-"]')];
        const mid = window.innerHeight * 0.5;
        let scene = '—';
        for (const el of sceneEls) {
          const r = el.getBoundingClientRect();
          if (r.top <= mid && r.bottom >= mid) { scene = el.id.replace('scene-', ''); break; }
        }
        const st = window.Film3D ? Film3D.govStatus() : {};
        return {
          scene,
          camZ: st.camZ, camY: st.camY,
          prog: st.prog, cur: st.current,
          reel: (document.getElementById('sceneName') || {}).textContent || '',
        };
      }, pct);
      console.log(
        String(pct).padStart(6) + '% | ' +
        String(row.scene).padEnd(9) + ' | ' +
        String(Math.round(row.camZ)).padStart(5) + String(Math.round(row.camY)).padStart(6) + ' | ' +
        'prog ' + (row.prog ?? '?') + ' cur ' + (row.cur ?? '?') + ' | ' +
        row.reel
      );
    } catch (e) {
      console.log(String(pct).padStart(6) + '% | evaluate failed: ' + e.message);
      break;
    }
  }

  clearTimeout(hardStop);
  await browser.close();
  process.exit(0);
})().catch(e => { console.log('PROBE FAIL:', e.message); process.exit(1); });

/* note: append-mode stub — real script ends above; ignore */
