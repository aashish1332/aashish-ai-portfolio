/* ═══════════════════════════════════════════════════════════════
   dev-firefox-probe.js — the P7 gate's Firefox half (§16), scoped honestly

   §16's P7 gate says the runtime must work on "Chrome + Firefox (+ Safari if
   available)". Chrome has been driven end to end since P2. Firefox is a
   DIFFERENT engine, and the two things most likely to break there are not the
   model — it is wasm SIMD + a module worker, both of which Firefox has had for
   years — but the things assumed rather than checked:

     · the §2 N6 promise (nothing AI before the click) under Firefox's own
       network stack, not Chromium's;
     · §11's honest degradation: Firefox has no `SpeechRecognition`, so the
       microphone button must be DISABLED WITH A REASON, not silently dead
       (AI_ARCHITECTURE §5 asserts exactly this in words).

   What this probe is NOT: the 46-check Chrome probe. That one uses CDP
   (`Emulation.setCPUThrottlingRate`, `Network.setBlockedURLs`, worker events),
   none of which exists on Firefox's WebDriver BiDi transport, and porting it
   would make this file a second, drifting copy of that one. This is a smoke
   test that answers one question — does the shipped bundle RUN here — and it
   says so in its own output.

   Firefox is installed as an MSIX package on this box; its user-facing alias
   (`…\\WindowsApps\\firefox.exe`) is EACCES to a non-packaged process, so the
   real path inside the package VFS is used, overridable with `FF_BIN`.

   Run:  node dev-firefox-probe.js                    (dev server on :5577)
         npm run build
         ROOT=dist PORT=5582 node dev-server.mjs &
         AI_BASE=http://localhost:5582/ node dev-firefox-probe.js
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const FF = process.env.FF_BIN
  || 'C:/Program Files/WindowsApps/Mozilla.Firefox_156.0.1.0_x64__n80bbvh6b1yt2/VFS/ProgramFiles/Firefox Package Root/firefox.exe';
/* NOT named `URL`: that shadows the global URL constructor in module scope,
   and the first version of this file crashed on `new URL(...)` because of it */
const TARGET = process.env.AI_BASE || 'http://localhost:5577/';

/* anything that must not exist before the click — same expression as the
   Chrome probe, kept in sync by being quoted from it rather than re-derived */
const AI_ASSET = /\/ai\/|\.wasm(\?|$)|\.gguf|\.onnx|knowledge\.json|model|tokenizer|voice/i;
const LAUNCHER = /js\/ai\/launcher\.js/;

let checks = 0;
let failures = 0;
const say = (label, ok, detail) => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✖'} ${label.padEnd(30)} ${detail || ''}`);
  if (!ok) process.exitCode = 1;
};
const note = (label, detail) => console.log(`  ${label.padEnd(30)} ${detail}`);
/* A check that cannot fail is worse than no check. When an assertion depends on
   an instrument (the network listener), the instrument is proven to work first
   and the assertion is skipped — loudly — if it did not. */
const skip = (label, why) => console.log(`⚠ ${label.padEnd(30)} NOT VERIFIED — ${why}`);

(async () => {
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); },
    Number(process.env.PROBE_TIMEOUT || 600000));

  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FF,
    headless: true,
    args: ['--no-first-run'],
  });
  const ffVersion = await browser.version();
  note('browser', ffVersion);
  const ORIGIN = new URL(TARGET).origin;

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const requests = [];
  const pageErrors = [];
  const consoleErrors = [];
  const failed = [];
  let netEvents = false;
  page.on('request', (r) => { netEvents = true; requests.push(r.url()); });
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('requestfailed', (r) => failed.push(`${r.failure() && r.failure().errorText} ${r.url()}`));

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  /* the film is best-effort here: headless Firefox has no GPU and the film is
     NOT what this probe is about — but its failure must not be blamed on the
     assistant, so it is reported separately and never counted as an AI fault */
  const filmReady = await page.waitForFunction(() => window.Film3D && Film3D.isReady(),
    { timeout: 60000, polling: 500 }).then(() => true).catch(() => false);
  note('film ready', filmReady ? 'yes' : 'no (headless WebGL — not an AI result)');
  await new Promise((r) => setTimeout(r, 4000));

  /* ── 1. the pre-click network assertion, on Firefox ───────────────── */
  const preClickAi = requests.filter((u) => AI_ASSET.test(u) && !LAUNCHER.test(u));
  if (!netEvents) {
    skip('zero AI requests pre-click', 'the network listener never fired — no evidence either way');
  } else {
    say('zero AI requests pre-click', preClickAi.length === 0,
      `${requests.length} requests seen, ${preClickAi.length} AI ${preClickAi.slice(0, 2).join(' ')}`);
  }

  /* ── 2. click → panel ─────────────────────────────────────────────── */
  const btn = await page.$('#askAI');
  say('launcher button exists', !!btn, btn ? '#askAI' : 'NO BUTTON');
  if (btn) await btn.click();
  const openedAt = Date.now();
  await page.waitForFunction(() => ['ready', 'unsupported', 'error']
    .includes(window.PortfolioAI?.model?.state),
  { timeout: Number(process.env.WAIT_READY || 240000), polling: 250 })
    .then(() => note('panel ready', `${Date.now() - openedAt} ms after the click`))
    .catch(() => note('panel ready', 'NOT REACHED before the timeout'));

  const opened = await page.evaluate(() => ({
    state: window.PortfolioAI?.state,
    tier: window.PortfolioAI?.tier,
    isOpen: window.PortfolioAI?.isOpen,
    tierBadge: document.querySelector('.ai__tier')?.textContent,
    bubbleCount: document.querySelectorAll('.ai__msg').length,
  }));
  say('panel opened', opened.isOpen === true,
    `state=${opened.state} tier=${opened.tier} badge="${opened.tierBadge}"`);
  say('no error page', !/error|unsupported/i.test(opened.state || ''),
    `state=${opened.state}`);

  /* ── 3. what Firefox's own capabilities decide ────────────────────── */
  const caps = await page.evaluate(() => ({
    /* the tier's feature set, read the way the governor reads it */
    speechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    speechSynthesis: !!window.speechSynthesis,
    /* created and terminated in the same expression: a probe that leaves a
       worker running is the leak this project keeps testing for */
    moduleWorker: (() => {
      let w = null;
      try { w = new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' })), { type: 'module' }); return true; }
      catch { return false; }
      finally { try { w?.terminate(); } catch { /* nothing to terminate */ } }
    })(),
    storage: !!navigator.storage && !!navigator.storage.estimate,
    modelState: window.PortfolioAI?.model?.state,
  }));
  note('capabilities', `STT=${caps.speechRecognition} TTS=${caps.speechSynthesis} moduleWorker=${caps.moduleWorker} storage=${caps.storage}`);

  /* Firefox without Web Speech: the microphone must be OFF AND EXPLAINED.
     This is §11's stated behaviour for Firefox ("the disabled button and the
     reason") — asserted here rather than only in a document. */
  const mic = await page.evaluate(() => {
    const b = document.querySelector('.ai__mic');
    if (!b) return null;
    const switchedOff = b.disabled === true || b.getAttribute('aria-disabled') === 'true';
    return {
      exists: true,
      disabled: switchedOff,
      /* the REASON lives in `title` (ai/ui/chat.mjs:840–841); the aria-label is
         just the state in words, so reading the label and calling it a reason
         would pass on "Voice mode is off" — which explains nothing */
      reason: b.getAttribute('title') || '',
      label: b.getAttribute('aria-label') || '',
      voiceState: b.dataset.voice || null,
    };
  });
  if (!caps.speechRecognition) {
    if (!mic) skip('microphone disabled, with a reason', 'no .ai__mic in the DOM');
    else {
      /* `Talk to the assistant` is the title of a WORKING microphone, so the
         absence of an explanation has to be a distinguishable failure */
      const explained = mic.reason.length > 0 && !/^Talk to the assistant$/i.test(mic.reason);
      say('microphone disabled, with a reason', mic.disabled === true && explained,
        `title="${mic.reason.slice(0, 72)}" aria-label="${mic.label}" state=${mic.voiceState}`);
    }
  } else {
    note('microphone', 'Firefox reported a recogniser — path differs from the documented case');
  }

  /* ── 4. an answer, or an honest refusal ───────────────────────────── */
  const modelPhase = await page.evaluate(() => window.PortfolioAI?.model?.state);
  note('model phase', modelPhase);
  if (modelPhase === 'ready') {
    const askedAt = Date.now();
    await page.evaluate(() => document.querySelector('.ai__chip')?.click());
    const answeredAt = await page.waitForFunction(() => {
      const last = window.PortfolioAI?.model?.last;
      return !!last && typeof last.text === 'string' && last.text.length > 0;
    }, { timeout: Number(process.env.WAIT_ANSWER || 240000), polling: 250 })
      .then(() => Date.now()).catch(() => null);
    note('first answer', answeredAt ? `${answeredAt - askedAt} ms in-browser` : 'NOT REACHED');
    const answered = await page.evaluate(() => {
      const bots = [...document.querySelectorAll('.ai__msg.is-bot')];
      /* a NOTICE is not an answer — read the last bubble that is not one */
      const real = bots.filter((el) => el.querySelector('.ai__badge')?.textContent !== 'NOTICE');
      const last = real[real.length - 1];
      return {
        badge: last?.querySelector('.ai__badge')?.textContent || '',
        sources: last?.querySelectorAll('.ai__source').length ?? 0,
        hasMarkup: !!last?.querySelector('script,img,iframe'),
      };
    });
    say('answer is labelled', /AI ANSWER|NO ANSWER|SAFE REPLY|T0/i.test(answered.badge || ''),
      `badge="${answered.badge}"`);
    say('answer rendered as text, not markup', answered.hasMarkup === false, '');
  } else {
    /* T0 / no-model is a legitimate Firefox outcome on a device the governor
       does not trust — what is NOT allowed is a spinner or a lie */
    const refusal = await page.evaluate(() => document.querySelector('.ai__tier')?.textContent || '');
    say('non-model path is stated, not silent', refusal.length > 0, `badge="${refusal}"`);
  }

  /* ── 5. hygiene ───────────────────────────────────────────────────── */
  /* The promise is about the ASSISTANT (§2 N6/§14): no AI asset may come from
     anywhere but this site. The portfolio itself has always pulled Google Fonts
     and GSAP from a CDN — asserting same-origin over EVERY request fails on a
     page that was never same-origin, which is a check about the wrong thing. */
  const offSite = requests.filter((u) => !u.startsWith(ORIGIN)
    && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('WORKER:'));
  const offSiteAi = offSite.filter((u) => AI_ASSET.test(u));
  say('no off-site AI request', offSiteAi.length === 0,
    offSiteAi.length ? offSiteAi.slice(0, 2).join(' ') : 'every AI asset is same-origin');
  note('off-site requests (portfolio)', `${offSite.length} — ${[...new Set(offSite.map((u) => { try { return new URL(u).origin; } catch { return u; } }))].join(', ') || 'none'}`);
  say('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  note('console errors/warnings', String(consoleErrors.length));
  note('failed requests', String(failed.length));

  await browser.close();
  clearTimeout(hardStop);
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks (${ffVersion})`);
})().catch((e) => { console.error('PROBE CRASHED:', e && e.message); process.exit(1); });
