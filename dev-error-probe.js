/* ═══════════════════════════════════════════════════════════════
   dev-error-probe.js — does the page load clean?
   Loads the film headlessly and reports every console error/warning,
   uncaught page error, and failed network request.

   Reporting is not gating. The exit code is 1 for the four things that
   mean the question was not answered or the answer was "no": the film
   never became ready, an uncaught page error, a failed request, or an
   interaction step that threw. `console err/warn` and `http >= 400` are
   printed for a human and deliberately do not fail the run.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:5577/';
const MOBILE = !!process.env.MOBILE;   // MOBILE=1 → emulate a phone (touch + narrow)

(async () => {
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); }, 300000);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800', '--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport(MOBILE
    ? { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { width: 1280, height: 800 });

  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  const responses = [];

  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
  page.on('requestfailed', (r) => failed.push(`${r.failure() && r.failure().errorText} ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) responses.push(`${r.status()} ${r.url()}`); });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let ready = true;
  try {
    await page.waitForFunction(() => window.Film3D && Film3D.isReady(), { timeout: 90000, polling: 1000 });
  } catch {
    ready = false;
  }
  await new Promise((r) => setTimeout(r, 3000));

  const state = await page.evaluate(() => ({
    gsap: !!window.gsap,
    three: !!(window.Film3D),
    webgl: !document.documentElement.classList.contains('no-webgl'),
    details: window.FilmDetails ? window.FilmDetails.isLive() : null,
    gov: window.Film3D && Film3D.isReady() ? Film3D.govStatus() : null,
    bootDone: document.getElementById('boot').classList.contains('is-done'),
  }));

  /* ── interaction sweep: scroll the whole film + every UI path ── */
  const steps = [];
  const step = async (label, fn) => {
    const before = pageErrors.length + failed.length;
    try { await fn(); } catch (e) { steps.push(`THREW ${label}: ${e.message.split('\n')[0]}`); }
    if (pageErrors.length + failed.length > before) steps.push(`ERROR after ${label}`);
  };

  const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  for (let i = 1; i <= 10; i++) {
    await step(`scroll ${i * 10}%`, async () => {
      await page.evaluate((y) => window.scrollTo(0, y), Math.round((maxScroll * i) / 10));
      await new Promise((r) => setTimeout(r, 900));
    });
  }
  await step('keyboard P / G / G / Esc', async () => {
    for (const k of ['p', 'g', 'Escape', 'p']) {
      await page.keyboard.press(k === 'Escape' ? 'Escape' : k);
      await new Promise((r) => setTimeout(r, 500));
    }
  });
  await step('terminal open + commands', async () => {
    await page.evaluate(() => window.Terminal.show());
    for (const c of ['help', 'whoami', 'skills', 'projects', 'open goal', 'open nope', 'stats', 'quality 3', 'districts', 'lens', 'sudo hire aashish', 'zzz', 'clear']) {
      await page.evaluate((cc) => window.Terminal.run(cc), c);
      await new Promise((r) => setTimeout(r, 120));
    }
    await page.evaluate(() => window.Terminal.hide());
  });
  await step('sound toggle', async () => {
    /* the CSS hides this button on phones, so only click it where it exists */
    const visible = await page.$eval('#soundToggle', (el) => !!el.offsetParent);
    if (visible) await page.click('#soundToggle');
  });
  await step('chapter dots', async () => {
    await page.evaluate(() => document.querySelectorAll('.chapters__dot').forEach((d) => d.click()));
    await new Promise((r) => setTimeout(r, 1500));
  });
  await step('resize', async () => {
    await page.setViewport({ width: 900, height: 700 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.setViewport({ width: 1280, height: 800 });
    await new Promise((r) => setTimeout(r, 1200));
  });
  await step('contact form submit (no backend)', async () => {
    await page.evaluate(() => {
      document.getElementById('cfName').value = 'Probe';
      document.getElementById('cfEmail').value = 'probe@example.com';
      document.getElementById('cfMsg').value = 'hello';
      document.getElementById('contactForm').dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 1200));
  });

  console.log('film ready      :', ready);
  console.log('state           :', JSON.stringify(state));
  console.log('interaction     :', steps.length ? steps : 'clean');
  console.log('\nconsole err/warn:', consoleErrors.length ? consoleErrors : 'none');
  console.log('page errors     :', pageErrors.length ? pageErrors : 'none');
  console.log('failed requests :', failed.length ? failed : 'none');
  console.log('http >= 400     :', responses.length ? responses : 'none');

  /* The verdict answers this probe's own question — "does the page load
     clean?" — so an unready film and a step that THREW both count. A probe
     that asks that question and then exits 0 while printing
     `film ready: false` is the "green means less than it looks" defect: the
     run looked clean because the instrument never checked its own premise. */
  const fatal = [];
  if (!ready) fatal.push('the film never became ready');
  if (pageErrors.length) fatal.push(`${pageErrors.length} page error(s)`);
  if (failed.length) fatal.push(`${failed.length} failed request(s)`);
  if (steps.length) fatal.push(`${steps.length} interaction problem(s)`);
  console.log('verdict         :', fatal.length ? 'FAIL — ' + fatal.join(', ') : 'clean');

  clearTimeout(hardStop);
  await browser.close();
  process.exit(fatal.length ? 1 : 0);
})().catch((e) => { console.log('PROBE FAIL:', e.message); process.exit(1); });
