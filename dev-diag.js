/* ═══════════════════════════════════════════════════════════════
   dev-diag.js — layout diagnostic
   Loads the page, scrolls to a film progress, and prints the
   bounding box + computed style of selectors you name. The fast way
   to answer "why is that element not where I think it is".

   Usage:  AT=0.50 node dev-diag.js
           AT=0.50 SEL=".codir__content,.codir__title,.codir__ledgers" node dev-diag.js
           MOBILE=1 node dev-diag.js            (390x844)
           VP=1366x620 node dev-diag.js         (any viewport)
           JS="expr" node dev-diag.js           (eval in the page)
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.URL || 'http://localhost:5577/';
const AT = +(process.env.AT || 0.5);
const MOBILE = !!process.env.MOBILE;
const VP = (process.env.VP || '').split('x').map(Number);
const SEL = (process.env.SEL ||
  '.codir__content,.codir__header,.codir__kicker,.codir__title,.codir__sub,.codir__ledgers,.ledger.is-active,.ledger__head,.ledger__cols,.ledger__foot,.codir__note'
).split(',').map((s) => s.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run'],
  });
  const page = await browser.newPage();
  const vp = VP.length === 2 && VP.every((n) => Number.isFinite(n))
    ? { width: VP[0], height: VP[1] }
    : MOBILE ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 800 };
  await page.setViewport(vp);
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.split('\n')[0]));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.Film3D && Film3D.isReady(), { timeout: 120000, polling: 1000 });
  await sleep(4000);

  const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  await page.evaluate((y) => window.scrollTo(0, y), Math.round(maxScroll * AT));
  await sleep(2500);

  /* JS="expr" — run arbitrary JS in the page and print the result.
     The escape hatch for "is GSAP actually holding this node?" questions. */
  if (process.env.JS) {
    const out = await page.evaluate(process.env.JS);
    console.log('JS →', JSON.stringify(out, null, 2));
    await browser.close();
    process.exit(0);
  }

  const rows = await page.evaluate((sels) => {
    const vt = window.innerHeight;
    return sels.map((sel) => {
      const els = [...document.querySelectorAll(sel)];
      if (!els.length) return { sel, found: false };
      return {
        sel,
        found: true,
        count: els.length,
        boxes: els.slice(0, 2).map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            /* overflowX/Y: >0 means the element's content is clipped */
            ox: el.scrollWidth - el.clientWidth,
            oy: el.scrollHeight - el.clientHeight,
            display: cs.display, position: cs.position,
            flex: cs.flex, overflow: cs.overflow,
            transform: cs.transform === 'none' ? '-' : cs.transform.replace(/matrix\(|\)/g, ''),
            opacity: cs.opacity,
            fontSize: cs.fontSize,
            /* Does this element's top edge sit ON SCREEN but tucked under
               the fixed top HUD chip? Elements scrolled off the top
               (top < 0) are not collisions, and neither are the
               full-height scene frames, whose padding owns that space. */
            hud: (() => {
              const h = document.querySelector('.hud--top');
              if (!h || el.closest('.hud')) return '-';
              if (r.height > vt * 0.9) return 'frame';
              if (r.top < -1 || r.bottom < 0) return 'offscreen';
              const over = h.getBoundingClientRect().bottom - r.top;
              return over > 1 ? 'COLLIDES+' + Math.round(over) : 'clear';
            })(),
            /* The cinematic letterbox bars are fixed and opaque, painted
               above the page — so anything under them is simply gone.
               Report how much of this element each bar eats. */
            clip: (() => {
              const t = document.querySelector('.letterbox--top');
              const b = document.querySelector('.letterbox--bottom');
              /* bars are optional — the film runs full-bleed without them,
                 and a missing bar must not read as "everything is eaten". */
              if (!t && !b) return 'no-bars';
              if (r.height > vt * 0.9) return 'frame';
              if (r.top < -1 || r.bottom < 0) return 'offscreen';
              const tb = t ? t.getBoundingClientRect().bottom : 0;
              const bt = b ? b.getBoundingClientRect().top : vt;
              const top = Math.round(tb - r.top);
              const bot = Math.round(r.bottom - bt);
              const parts = [];
              if (top > 1) parts.push('TOP+' + top);
              if (bot > 1) parts.push('BOT+' + bot);
              return parts.length ? 'EATEN_' + parts.join('_') : 'clear';
            })(),
            text: (el.textContent || '').trim().slice(0, 34),
          };
        }),
        offscreen: els[0].getBoundingClientRect().y < 0 || els[0].getBoundingClientRect().bottom > vt,
      };
    });
  }, SEL);

  console.log(`AT=${AT}  viewport=${await page.evaluate(() => window.innerHeight)}  maxScroll=${maxScroll}\n`);
  for (const r of rows) {
    if (!r.found) { console.log(`${r.sel.padEnd(22)} NOT FOUND`); continue; }
    for (const b of r.boxes) {
      console.log(
        `${r.sel.padEnd(22)} y=${String(b.y).padStart(5)} h=${String(b.h).padStart(4)} ` +
        `w=${String(b.w).padStart(4)} ox=${String(b.ox).padStart(4)} oy=${String(b.oy).padStart(4)} ` +
        `hud=${b.hud.padEnd(13)} bar=${b.clip.padEnd(18)} | ${b.text}`
      );
    }
  }
  await browser.close();
  process.exit(0);
})().catch((e) => { console.log('DIAG FAIL:', e.message); process.exit(1); });
