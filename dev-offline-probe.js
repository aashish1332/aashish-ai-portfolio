/* ═══════════════════════════════════════════════════════════════
   dev-offline-probe.js — §9.3's cache and §14's offline-after-cache

   §4 promises the first-use download is "One-time, then cached (0 MB on later
   visits)". This probe measures the second half of that sentence, and the only
   honest way to measure it is to make the network UNAVAILABLE and see whether
   the visitor still gets an answer.

     · VISIT 1  the model is downloaded (misses) and stored (puts)
     · VISIT 2  reload with `*model-export*` BLOCKED at the CDP level. If the
                bytes were being served by the HTTP cache or by a lucky
                re-download, this fails; it can only pass from Cache Storage.
     · OFFLINE  the network cut entirely, then reload — reported as measured,
                including which asset could not be served, because a page with
                no service worker (§9.3 says not to add one) cannot promise its
                own HTML offline even when the model is safely cached.

   Run:  node dev-offline-probe.js      (needs `node dev-server.mjs` on :5577)

   `AI_BASE` points it at something else — in particular at the built bundle,
   which is what a visitor receives and which nothing in this repo had ever
   loaded before (see the same note in `dev-ai-probe.js`):

     npm run build && ROOT=dist PORT=5582 node dev-server.mjs &
     AI_BASE=http://localhost:5582/ node dev-offline-probe.js
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.AI_BASE || 'http://localhost:5577/';
const MODEL_DIR = /model-export/;

let checks = 0;
let failures = 0;
const say = (label, ok, detail) => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✖'} ${label.padEnd(30)} ${detail || ''}`);
  if (!ok) process.exitCode = 1;
};
const note = (label, detail) => console.log(`  ${label.padEnd(30)} ${detail}`);

/**
 * Click the launcher — the way a visitor does, and the only way the AI chunk
 * is ever fetched (§2 N6) — then wait for the worker to report what it did.
 */
async function openAndWaitForModel(page, { timeout }) {
  await page.waitForSelector('#askAI', { timeout: 60000 });
  await page.click('#askAI');
  const started = Date.now();
  await page.waitForFunction(
    () => ['ready', 'unsupported', 'error'].includes(window.PortfolioAI?.model?.state),
    { timeout, polling: 1000 });
  const model = await page.evaluate(() => {
    const m = window.PortfolioAI.model;
    return { state: m.state, notice: m.notice, cache: m.engine?.cache || null,
      bytes: m.engine?.bytes ?? null };
  });
  return { ...model, ms: Date.now() - started };
}

(async () => {
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); },
    Number(process.env.PROBE_TIMEOUT || 900000));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1280,800', '--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  /* Responses, not requests: a BLOCKED request still fires a `request` event,
     so counting requests cannot tell a served byte from a refused one. */
  const served = [];
  page.on('response', (r) => { if (MODEL_DIR.test(r.url())) served.push(r.url()); });
  page.on('pageerror', (e) => console.log(`  page error: ${e.message.split('\n')[0]}`));

  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  await client.send('Network.clearBrowserCache').catch(() => {});

  /* ── VISIT 1: download once ─────────────────────────────────────── */
  console.log('\nVISIT 1 — download and store');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));
  const first = await openAndWaitForModel(page, { timeout: 600000 });
  note('state', `${first.state} in ${(first.ms / 1000).toFixed(1)} s`);
  note('model bytes', first.bytes);
  note('cache report', JSON.stringify(first.cache));
  say('first visit downloads the model', served.length > 0, `${served.length} responses from model-export/`);
  if (first.state !== 'ready') {
    say('the model loaded at all', false, `${first.state}: ${first.notice || ''}`);
    console.log('\nCannot measure the cache without a loaded model. Stopping.');
    await browser.close();
    return;
  }
  say('the first visit stored it (puts > 0)', (first.cache?.puts ?? 0) > 0,
    `puts ${first.cache?.puts ?? 'n/a'}`);
  say('nothing was served from cache yet', (first.cache?.hits ?? -1) === 0,
    `hits ${first.cache?.hits ?? 'n/a'}`);

  const keyed = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('aashish-ai-model:')));
  say('a version-keyed cache exists', keyed.length === 1, keyed.join(', ') || 'none');
  const stored = await page.evaluate(async (name) => {
    const c = await caches.open(name);
    const keys = await c.keys();
    let bytes = 0;
    for (const k of keys) bytes += (await (await c.match(k)).arrayBuffer()).byteLength;
    return { files: keys.length, bytes };
  }, keyed[0] || 'aashish-ai-model:none');
  note('cached artifacts', `${stored.files} files, ${stored.bytes} B`);

  /* ── VISIT 2: reload with the model directory unreachable ───────── */
  console.log('\nVISIT 2 — reload with *model-export* blocked');
  await page.evaluate(() => window.PortfolioAI.close());
  served.length = 0;
  await client.send('Network.setBlockedURLs', { urls: ['*model-export*'] });
  /* A reload, because that is literally the visitor's second visit: the page's
     own cache state is whatever the browser kept, and the ONLY thing that can
     deliver the model now is Cache Storage. */
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));
  const warm = await openAndWaitForModel(page, { timeout: 600000 });
  note('state', `${warm.state} in ${(warm.ms / 1000).toFixed(1)} s`);
  note('cache report', JSON.stringify(warm.cache));
  say('the model loaded with model-export blocked', warm.state === 'ready',
    `${warm.state}${warm.notice ? `: ${warm.notice}` : ''}`);
  say('it came from Cache Storage', (warm.cache?.hits ?? 0) > 0 && (warm.cache?.misses ?? 1) === 0,
    `hits ${warm.cache?.hits ?? 'n/a'}, misses ${warm.cache?.misses ?? 'n/a'}`);
  say('zero bytes from the network (§4)', served.length === 0,
    served.length ? served.slice(0, 3).join(' | ') : '0 responses from model-export/');
  /* NOT asserted: the wall clock. §4 promises 0 MB of network, not a faster
     load, and on localhost the download was never what the 27 s was spent on —
     the shards still have to be held, hashed and decoded either way. The two
     numbers are printed so nobody has to guess which half the cache removed. */
  note('cold vs warm wall clock', `${(first.ms / 1000).toFixed(1)} s → ${(warm.ms / 1000).toFixed(1)} s
     (not a promise either way — the load is decode-bound here)`);

  /* ── OFFLINE: the whole network, cut ────────────────────────────── */
  console.log('\nOFFLINE — network cut, then reload (this is what the page can promise)');
  await client.send('Network.setBlockedURLs', { urls: [] });
  await client.send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  served.length = 0;
  const refused = [];
  const onRefused = (r) => refused.push(r.url().replace(/^https?:\/\/[^/]+/, ''));
  page.on('requestfailed', onRefused);
  let offlineDetail = '';
  try {
    const response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const off = await page.evaluate(() => ({
      title: document.title,
      launcher: !!document.getElementById('askAI'),
      ai: typeof window.PortfolioAI,
    }));
    if (!off.launcher) {
      offlineDetail = `document served (${response?.status?.() ?? 'from cache'}), `
        + `but the /js launcher did not: ${refused.slice(0, 3).join(' ')}`;
    } else {
      const res = await openAndWaitForModel(page, { timeout: 300000 });
      offlineDetail = `${res.state} in ${(res.ms / 1000).toFixed(1)} s, `
        + `hits ${res.cache?.hits ?? 'n/a'}`;
    }
  } catch (err) {
    const what = /Waiting for selector/.test(String(err?.message))
      ? `the page loaded (title "${await page.title().catch(() => '?')}") but the AI chunk never `
        + `arrived; refused: ${refused.slice(0, 4).join(' ')}`
      : String(err?.message || err).split('\n')[0];
    offlineDetail = what;
  }
  page.off('requestfailed', onRefused);
  /* Reported, not asserted: without a service worker — which §9.3 tells us not
     to add — the browser decides whether index.html itself is reusable, and
     that is the page's business, not the model cache's. What IS asserted is
     the line above: with the model directory blocked and the page fine, the
     answer still came. */
  note('offline reload', offlineDetail || offlineState);

  await client.send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  clearTimeout(hardStop);
  console.log(`\n${checks - failures}/${checks} checks`);
  await browser.close();
})().catch((err) => { console.error('PROBE FAILED', err); process.exit(1); });
