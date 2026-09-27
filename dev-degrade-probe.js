/* ═══════════════════════════════════════════════════════════════
   dev-degrade-probe.js — §14's unsupported path and failure path

   §14 asks for automated e2e coverage of "the T0 unsupported path, offline-
   after-cache, download failure/retry". The middle one has its own probe now;
   these two are the ones nothing had ever driven end to end, and they are
   exactly the ones a visitor meets on a device that is saving data or on a
   flaky connection.

   Both are §2 N7 ("never crash, never freeze, never an endless spinner") and
   §3's promise that every visitor gets an honest answer about what this device
   can do — so both are checked the same way: what the panel SAYS, what it
   fetched, and whether anything threw.

     · T0  a device that is saving data (the tier gates refuse it) → the panel
       says NO AI MODEL HERE, fetches no model asset, starts no worker, and
       still refuses a question honestly instead of spinning.
     · FAILURE  the model directory unreachable → the panel says it could not
       start, the page keeps working, and a reload with the network back
       reaches ready — which is the retry the panel promises in words.

   Run:  node dev-degrade-probe.js   (needs `node dev-server.mjs` on :5577)
   ═══════════════════════════════════════════════════════════════ */

'use strict';
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:5577/';
/* The failing server runs the SAME server with /ai/model-export/ 404ing. It
   has to be the server and not the browser: the weights are fetched inside a
   module Worker, and Network.setBlockedURLs on the page session does not
   reach a dedicated worker's requests. That mistake is why this probe
   reported a healthy download as a passing failure case until the fault was
   moved here. */
const FAIL_PORT = Number(process.env.FAIL_PORT || 5581);
const FAIL_URL = `http://localhost:${FAIL_PORT}/`;
const MODEL_ASSET = /manifest\.json|model-\d+\.bin|tokenizer\.json/;

let checks = 0;
let failures = 0;
const say = (label, ok, detail) => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✖'} ${label.padEnd(34)} ${detail || ''}`);
  if (!ok) process.exitCode = 1;
};
const note = (label, detail) => console.log(`  ${label.padEnd(34)} ${detail}`);
const shortUrl = (u) => String(u).replace(/^blob:.*\//, 'blob:');

/** The failing server: same code, 404s every model asset. */
function startFailingServer() {
  const child = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: path.resolve(__dirname),
    env: { ...process.env, PORT: String(FAIL_PORT), FAIL_MODEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.PROBE_VERBOSE && process.stdout.write(`  [fail-server] ${d}`));
  return child;
}

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Open the panel the way a visitor does, and wait for the model to settle. */
async function openPanel(page, { timeout = 300000 } = {}) {
  await page.waitForSelector('#askAI', { timeout: 60000 });
  await page.click('#askAI');
  try {
    await page.waitForFunction(
      () => ['ready', 'unsupported', 'error'].includes(window.PortfolioAI?.model?.state),
      { timeout, polling: 500 });
  } catch { /* reported by the caller as the state it actually reached */ }
  return page.evaluate(() => {
    const badge = [...document.querySelectorAll('.ai__tier')].map((b) => b.textContent);
    const bots = [...document.querySelectorAll('.ai__msg.is-bot')];
    const last = bots[bots.length - 1];
    return {
      state: window.PortfolioAI?.model?.state,
      notice: window.PortfolioAI?.model?.notice ?? null,
      engine: window.PortfolioAI?.model?.engine
        ? { status: window.PortfolioAI.model.engine.status,
            reason: window.PortfolioAI.model.engine.reason,
            bytes: window.PortfolioAI.model.engine.bytes }
        : null,
      tier: window.PortfolioAI?.tier,
      panelOpen: window.PortfolioAI?.isOpen,
      badge,
      lastText: (last?.querySelector('span:not(.ai__badge)')?.textContent || '').slice(0, 140),
      lastBadge: last?.querySelector('.ai__badge')?.textContent || '',
    };
  });
}

/** Ask something answerable and read what the visitor is told. */
async function ask(page, question, { timeout = 30000 } = {}) {
  const before = await page.evaluate(() => window.PortfolioAI?.model?.last?.text ?? null);
  await page.evaluate((q) => window.PortfolioAI.ask(q), question);
  await page.waitForFunction((prev) => {
    const l = window.PortfolioAI?.model?.last;
    return !!l && l.text && l.text !== prev;
  }, { timeout, polling: 200 }, before).catch(() => {});
  return page.evaluate(() => {
    const l = window.PortfolioAI?.model?.last;
    return { kind: l?.kind, badge: l?.badge, text: l?.text || '' };
  });
}

(async () => {
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); },
    Number(process.env.PROBE_TIMEOUT || 600000));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1280,800', '--no-first-run'],
  });

  /* ── 1. T0: a device that is saving data ────────────────────────── */
  console.log('\nT0 — saveData set, so §6.2 refuses this device a model');
  {
    const page = await browser.newPage();
    const modelRequests = [];
    const workerUrls = [];
    const pageErrors = [];
    page.on('request', (r) => { if (MODEL_ASSET.test(r.url())) modelRequests.push(r.url()); });
    /* A Worker on this page is not itself a fault: §6.1's micro-benchmark runs
       in a throwaway blob worker on every device, T0 included. What must not
       exist is the ENGINE's worker — which is what fetches the weights. */
    page.on('workercreated', (w) => workerUrls.push(w.url()));
    page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
    /* §6.1 asks the environment rather than sniffing; this IS the environment
       a phone on metered data reports. */
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' } });
    });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3000));
    const t0 = await openPanel(page, { timeout: 60000 });

    note('tier', `${t0.tier} · state ${t0.state}`);
    note('panel copy', t0.lastText.slice(0, 90) || t0.badge.join(' | '));
    say('no model asset was requested', modelRequests.length === 0,
      modelRequests.slice(0, 2).join(' ') || '0 requests');
    const engineWorker = workerUrls.filter((u) => /worker\.mjs/.test(u));
    note('workers on the page', `${workerUrls.length}${workerUrls.length ? ` (${workerUrls.map(shortUrl).join(', ')})` : ''}`);
    say('no engine worker was created', engineWorker.length === 0,
      `${engineWorker.length} engine workers`);
    say('no model session exists', t0.engine === null, `engine=${JSON.stringify(t0.engine)}`);
    say('the panel says which tier this is', t0.state === 'unsupported',
      `model.state=${t0.state}`);
    say('the tier badge is honest', t0.badge.some((b) => /NO AI MODEL HERE/.test(b)),
      t0.badge.join(' | '));
    say('nothing threw', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'clean');

    const answer = await ask(page, 'What are your skills?');
    note('answer to a real question', `kind=${answer.kind} badge="${answer.badge}" "${answer.text.slice(0, 70)}"`);
    say('it refuses instead of spinning', answer.kind === 'no-model' && answer.text.length > 20,
      `kind=${answer.kind}`);
    say('the refusal is labelled as such', /NO AI MODEL|NO MODEL/i.test(answer.badge || ''),
      `badge="${answer.badge}"`);
    await page.close();
  }

  /* ── 2. FAILURE: the model directory is unreachable ─────────────── */
  console.log('\nFAILURE — every model asset 404s on a first visit');
  const failing = startFailingServer();
  await waitForServer(FAIL_URL);
  {
    const page = await browser.newPage();
    const pageErrors = [];
    const failedFetches = [];
    page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
    page.on('response', (r) => { if (MODEL_ASSET.test(r.url())) failedFetches.push(`${r.status()} ${r.url().split('/').pop()}`); });
    await page.goto(FAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    /* Confirm the fault is actually live before believing anything the panel
       then says. Without this, a blocking mistake turns the whole section
       into a vacuous pass — which is exactly what happened with the CDP
       block, and its "state=ready" read as a green check. */
    const injected = await page.evaluate(async () => {
      try {
        const r = await fetch('/ai/model-export/aashish-ai-1/manifest.json');
        return `HTTP ${r.status}`;
      } catch (e) { return `threw: ${e.message}`; }
    });
    say('the fault is live before the click', injected === 'HTTP 404', injected);
    await new Promise((r) => setTimeout(r, 3000));
    const broken = await openPanel(page, { timeout: 120000 });

    note('state after the failure', `${broken.state} — ${String(broken.notice || '').slice(0, 80)}`);
    note('session', `status=${broken.engine?.status} bytes=${broken.engine?.bytes} reason=${String(broken.engine?.reason || '').slice(0, 70)}`);
    note('model responses seen', failedFetches.slice(0, 3).join(' | ') || 'none');
    say('the failure is reported, not spun on', broken.state === 'error',
      `model.state=${broken.state}`);
    say('the reason is said out loud', !!broken.notice, broken.notice ? 'yes' : 'NONE');
    say('it did not claim to be ready', broken.engine?.status !== 'ready',
      `session.status=${broken.engine?.status}`);
    say('the panel is still usable', broken.panelOpen === true && broken.state !== 'loading',
      `isOpen=${broken.panelOpen}`);
    say('nothing threw', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'clean');

    const answer = await ask(page, 'What are your skills?');
    say('a question is refused honestly', answer.kind === 'no-model' && answer.text.length > 20,
      `kind=${answer.kind} "${answer.text.slice(0, 60)}"`);
    const film = await page.evaluate(() => typeof window.Film3D);
    say('the portfolio itself is untouched', film !== 'undefined', `Film3D=${film}`);

    await page.close();

    /* The retry the panel promises in words: "reloading the page starts it
       again". Same visitor, working network, one minute later. */
    console.log('  … reloading on the healthy server (the retry the panel promises)');
    const retry = await browser.newPage();
    const retryErrors = [];
    retry.on('pageerror', (e) => retryErrors.push(e.message.split('\n')[0]));
    await retry.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3000));
    const recovered = await openPanel(retry, { timeout: 300000 });
    say('a reload on a healthy network recovers', recovered.state === 'ready',
      `${broken.state} → ${recovered.state}`);
    say('   and the recovery is a real model', !!(recovered.engine?.bytes > 1e6),
      `bytes=${recovered.engine?.bytes} cache=${recovered.engine?.cache}`);
    say('   and nothing threw on the way back', retryErrors.length === 0,
      retryErrors.slice(0, 2).join(' | ') || 'clean');
    const recoveredAnswer = await ask(retry, 'What are your skills?');
    say('   and it answers after recovering', recoveredAnswer.text.length > 20,
      `kind=${recoveredAnswer.kind} "${String(recoveredAnswer.text).slice(0, 60)}"`);
    await retry.close();
  }
  failing.kill();

  clearTimeout(hardStop);
  console.log(`\n${checks - failures}/${checks} checks`);
  await browser.close();
})().catch((err) => { console.error('PROBE FAILED', err); process.exit(1); });
