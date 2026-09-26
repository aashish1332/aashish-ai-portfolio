/* ═══════════════════════════════════════════════════════════════
   dev-ai-probe.js — the P2 gate (§16), measured instead of asserted

     · NETWORK: before the first click, not ONE AI asset may be requested —
       no ai/** module, no knowledge.json, no wasm/gguf/onnx, no worker.
       This is the single most important promise in the whole brief, so it
       is checked by watching every request the page makes.
     · FLOW: click → panel opens → the on-device model answers a starter
       chip, or the panel says plainly why it cannot.
     · A11Y: focus moves into the panel, Escape closes and returns focus.
     · SCENE (§12): opening on a phone pauses the film; closing resumes it.
     · JANK: frame deltas with the panel open vs closed, and horizontal
       overflow on a phone.

   Run:  node dev-ai-probe.js            (desktop, 1280×800)
         MOBILE=1 node dev-ai-probe.js   (phone, 390×844)
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:5577/';
const MOBILE = !!process.env.MOBILE;

/* anything that must not exist before the click */
const AI_ASSET = /\/ai\/|\.wasm(\?|$)|\.gguf|\.onnx|knowledge\.json|model|tokenizer|voice/i;
/* the launcher itself is the documented exception to that rule (§4) */
const LAUNCHER = /js\/ai\/launcher\.js/;

let checks = 0;
let failures = 0;
const say = (label, ok, detail) => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✖'} ${label.padEnd(26)} ${detail || ''}`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  /* The budget covers: the film's first frames, the panel opening, a 5 MB
     model download plus SHA-256 and dequantise, and TWO generations. On the
     R1 dev laptop that is minutes, and the load varies 2–3x between runs, so
     a tight stop would fail the probe rather than fail the thing it probes. */
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); },
    Number(process.env.PROBE_TIMEOUT || 900000));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      `--window-size=${MOBILE ? 390 : 1280},${MOBILE ? 844 : 800}`, '--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport(MOBILE
    ? { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { width: 1280, height: 800 });

  const requests = [];
  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  /* Assets a real model download consists of: the manifest, the shards and
     the tokenizer. Recorded separately because the P7 checks below assert
     that a "MODEL READY" badge had something on the wire behind it — a badge
     is not evidence. */
  const modelRequests = [];
  const MODEL_ASSET = /manifest\.json|model-\d+\.bin|tokenizer\.json/;

  page.on('request', (r) => {
    requests.push(r.url());
    if (MODEL_ASSET.test(r.url())) modelRequests.push(r.url());
  });
  page.on('workercreated', (w) => requests.push(`WORKER:${w.url() || 'blob'}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
  page.on('requestfailed', (r) => failed.push(`${r.failure() && r.failure().errorText} ${r.url()}`));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForFunction(() => window.Film3D && Film3D.isReady(), { timeout: 90000, polling: 500 });
  } catch { /* the film may not be ready in a headless GPU-less run; the AI checks still hold */ }
  await new Promise((r) => setTimeout(r, 4000));   /* let the boot settle, like a real visit */

  /* ── 1. the pre-click network assertion ─────────────────────────── */
  const preClick = requests.slice();
  const leaked = preClick.filter((u) => AI_ASSET.test(u) && !LAUNCHER.test(u));
  const launcherLoaded = preClick.some((u) => LAUNCHER.test(u));
  say('pre-click AI requests', leaked.length === 0, leaked.length ? leaked.join('\n    ') : '0 (only js/ai/launcher.js)');
  say('launcher present', launcherLoaded, launcherLoaded ? 'js/ai/launcher.js' : 'MISSING');

  const before = await page.evaluate(() => ({
    portfolioAI: typeof window.PortfolioAI,
    panel: !!document.querySelector('.ai'),
    kbInMemory: typeof window.__kb,
  }));
  say('nothing AI in the page', before.portfolioAI === 'undefined' && !before.panel,
    `window.PortfolioAI=${before.portfolioAI}, panel mounted=${before.panel}`);

  /* ── 2. jank baseline, panel closed ─────────────────────────────── */
  const sampleFrames = () => page.evaluate(() => new Promise((resolve) => {
    const d = []; let last = performance.now(); const t0 = last;
    const step = (now) => {
      d.push(now - last); last = now;
      if (now - t0 < 3000) requestAnimationFrame(step);
      else {
        const s = d.slice(2).sort((a, b) => a - b);
        resolve({ median: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), n: s.length });
      }
    };
    requestAnimationFrame(step);
  }));
  const closed = await sampleFrames();

  /* ── 3. click → panel ────────────────────────────────────────────── */
  const btn = await page.$('#askAI');
  say('launcher button exists', !!btn, btn ? '#askAI' : 'NO BUTTON');
  if (btn) await btn.click();
  /* `state` leaves 'loading' only when `prepareModel()` has resolved, which on
     this laptop means the whole 5 MB download. Waiting 30 s for it was enough
     when the machine was idle and not enough when it was not, and the cost of
     being early is not a warning: the panel snapshot below then reports 0
     starter chips, which is a FAILED check for a panel that was merely still
     loading. Wait for what is actually being asserted. */
  const openedAt = Date.now();
  await page.waitForFunction(() => window.PortfolioAI && window.PortfolioAI.state === 'ready',
    { timeout: Number(process.env.WAIT_READY || 180000), polling: 250 })
    .then(() => console.log(`  panel ready                  ${Date.now() - openedAt} ms after the click`))
    .catch(() => console.log('  panel ready                  NOT REACHED before the timeout'));

  const opened = await page.evaluate(() => ({
    state: window.PortfolioAI?.state,
    tier: window.PortfolioAI?.tier,
    isOpen: window.PortfolioAI?.isOpen,
    tierBadge: document.querySelector('.ai__tier')?.textContent,
    focusInPanel: !!document.activeElement?.closest?.('.ai__panel'),
    /* Lenis exposes isStopped; report null when the API differs rather than
       pretending the scroll lock was verified */
    lenisStopped: (() => {
      const l = window.Director?.getLenis?.();
      return l && typeof l.isStopped === 'boolean' ? l.isStopped : null;
    })(),
    scenePaused: window.Film3D?.isPaused?.() ?? null,
    bubbleCount: document.querySelectorAll('.ai__msg').length,
    chipCount: document.querySelectorAll('.ai__chip').length,
  }));
  say('panel opened', opened.isOpen === true, `state=${opened.state} tier=${opened.tier} badge="${opened.tierBadge}"`);
  say('focus in panel', opened.focusInPanel === true, '');
  if (opened.lenisStopped === null) console.log('⚠ page scroll lock            Lenis API not introspectable here — NOT verified');
  else say('page scroll locked', opened.lenisStopped === true, `lenis.isStopped=${opened.lenisStopped}`);
  /* The starter chips are rendered by `open()` AFTER the model settles, so
     this is only meaningful once `state` is not 'loading' — see the wait
     above. It is re-read rather than reusing the earlier snapshot so the
     check can never be measuring a half-open panel. */
  const chips = await page.evaluate(() => document.querySelectorAll('.ai__chip').length);
  say('starter chips rendered', chips >= 3, `${chips} chips`);
  /* P7: a model exists now, so the badge may legitimately say PREPARING — what
     it may never do is claim a model that was not fetched. `modelRequests` is
     filled by the response listener above, so a "MODEL READY" badge with no
     shard on the wire is caught here rather than believed. */
  const badge = opened.tierBadge || '';
  const claimsModel = /MODEL READY|AI ANSWER/i.test(badge);
  say('model state is honest', !claimsModel || modelRequests.length > 0,
    `badge="${badge}" model requests=${modelRequests.length}`);
  say('a percent only appears with real progress',
    !/%/.test(badge) || modelRequests.length > 0, `badge="${badge}"`);

  /* ── 4. an answer, end to end ──────────────────────────────────────
     WAIT for the model before asking. The panel is usable while it downloads —
     that is what the honest refusal is for — but a probe that clicks the first
     chip immediately measures the LOADING state and reports it as "an answer,
     end to end". MEASURED on R1: a 5 MB download plus SHA-256 and dequantise
     takes far longer than the 400 ms this used to wait, so that is exactly what
     it did, and the model path went unmeasured in a browser while looking
     checked.

     `model.last` is set once, in `finish()`, which makes it a real completion
     signal rather than a guess about how long a generation takes. */
  const modelPhase = await page.waitForFunction(
    () => {
      const st = window.PortfolioAI?.model?.state;
      return st === 'ready' || st === 'unsupported' || st === 'error';
    },
    { timeout: Number(process.env.WAIT_MODEL || 180000), polling: 500 },
  ).then(() => page.evaluate(() => window.PortfolioAI?.model?.state))
    .catch(() => 'timed-out');
  console.log(`  model phase                  ${modelPhase}`);

  const askedAt = Date.now();
  await page.evaluate(() => document.querySelector('.ai__chip')?.click());
  const answeredAt = await page.waitForFunction(
    () => {
      const last = window.PortfolioAI?.model?.last;
      return !!last && typeof last.text === 'string' && last.text.length > 0;
    },
    { timeout: Number(process.env.WAIT_ANSWER || 180000), polling: 250 },
  ).then(() => Date.now()).catch(() => null);
  if (answeredAt) console.log(`  first answer                 ${answeredAt - askedAt} ms in-browser`);
  else console.log('  first answer                 NOT REACHED — nothing appeared before the timeout');
  const answered = await page.evaluate(() => {
    const bots = [...document.querySelectorAll('.ai__msg.is-bot')];
    const last = bots[bots.length - 1];
    return {
      text: last?.textContent?.slice(0, 160),
      badge: last?.querySelector('.ai__badge')?.textContent,
      sources: last?.querySelectorAll('.ai__source').length,
      hasMarkup: !!last?.querySelector('script,img,iframe'),
    };
  });
  say('answered a question', !!answered.text && !/could not start/i.test(answered.text), `"${(answered.text || '').slice(0, 70)}…"`);
  /* There is one answer path now, so a badge either names the model or says
     which refusal this was. What must never happen is a sentence with no
     label at all — the visitor has to be able to tell them apart. */
  say('answer is labelled', /AI ANSWER|NO ANSWER|SAFE REPLY/.test(answered.badge || ''),
    `badge="${answered.badge}"`);
  if (/AI ANSWER/.test(answered.badge || '')) {
    const modelState = await page.evaluate(() => window.PortfolioAI?.model || null);
    say('an AI answer came from the real model',
      modelState?.state === 'ready' && modelState?.last?.kind === 'model',
      `state=${modelState?.state} kind=${modelState?.last?.kind}`);
    say('the model answer is grounded in retrieved facts',
      !!modelState?.last?.context || (modelState?.last?.sources || []).length > 0,
      `${(modelState?.last?.sources || []).length} sources`);
  }
  /* A model answer must name the facts it read; a refusal must name none,
     because it made no claim. Asserting BOTH directions stops "0 chips" from
     passing whichever way the answer went. */
  const isAiAnswer = /AI ANSWER/.test(answered.badge || '');
  say('sources cited only when a claim was made',
    isAiAnswer ? answered.sources > 0 : answered.sources === 0,
    `${answered.sources} chips (badge="${answered.badge}")`);
  say('no markup in answers', answered.hasMarkup === false, '');

  /* the PII decision must hold in the shipping UI, not only in tests */
  const pii = await page.evaluate(async () => {
    window.PortfolioAI.ask('what is his phone number?');
    await new Promise((r) => setTimeout(r, 200));
    const bots = [...document.querySelectorAll('.ai__msg.is-bot')];
    return bots[bots.length - 1].textContent;
  });
  say('phone withheld in UI', !/6280/.test(pii), pii.slice(0, 60));

  /* ── 4b. the question that broke the window ────────────────────────
     "What are your skills?" has NO retrieval hits at all — `skills` is in the
     retrieval stop set on purpose (it lives in every skill chunk and used to
     hijack the score) — so it is answered from the intent's own fact list.
     That is the one path whose "top-k" is a whole topic rather than a BM25
     ranking, and uncapped it handed the model 38 facts and a 764-token prompt
     against a 512-token window: `forward()` threw and the visitor was told the
     model had stopped. It is the most common question a recruiter asks, so it
     is asked here by name instead of being left to the unit tests. */
  const skills = await page.evaluate(async () => {
    try { await window.PortfolioAI.ask('What are your skills?'); }
    catch (e) { return { error: String(e && e.message || e) }; }
    const s = window.PortfolioAI.model;
    return {
      state: s.state,
      kind: s.last?.kind,
      badge: s.last?.badge,
      sources: (s.last?.sources || []).length,
      facts: (s.last?.context || '').split('\n').filter(Boolean).length,
      text: (s.last?.text || '').slice(0, 90),
    };
  });
  if (skills.error) {
    say('a topic-only question does not throw', false, skills.error);
  } else if (skills.state === 'ready') {
    console.log(`  skills answer                kind=${skills.kind} ${skills.facts} facts ` +
      `${skills.sources} sources "${(skills.text || '').trim()}…"`);
    /* The failure that is being pinned is the REFUSAL, not a bad sentence: a
       random-init checkpoint answers poorly, and that is a training problem
       (P5), not a routing one. What must not happen is "no AI model on this
       device" while the model is sitting there loaded. */
    say('a topic-only question is not refused as "no model"',
      skills.kind !== 'no-model', `kind=${skills.kind} badge="${skills.badge}"`);
    say('its context is capped to the window, not the whole topic',
      skills.facts > 0 && skills.facts <= 12, `${skills.facts} facts read`);
  } else {
    console.log(`  (skills question skipped — model state ${skills.state})`);
  }

  /* ── 5. jank with the panel open ───────────────────────────────────
     §15 wants this measured on a real GPU under DevTools throttling. In
     headless swiftshader the film renders at well under 10 fps, so an A/B
     ratio computed here would be a meaningless number reported as a pass.
     It is computed and then explicitly declared inconclusive. */
  const openSample = await sampleFrames();
  const drift = closed.median ? +(((openSample.median - closed.median) / closed.median) * 100).toFixed(1) : 0;
  const ratio = closed.p95 ? +(openSample.p95 / closed.p95).toFixed(2) : 1;
  if (closed.median > 50) {
    console.log(`⚠ frame-health A/B            INCONCLUSIVE — baseline is ${(1000 / closed.median).toFixed(1)} fps ` +
      `in headless software GL (${closed.median} ms/frame). Needs the §15 reference profile on real hardware.`);
  } else {
    say('median frame drift', Math.abs(drift) <= 10, `${drift}%  (closed ${closed.median} ms → open ${openSample.median} ms)`);
    say('p95 frame time', ratio <= 1.5, `${ratio}× (closed ${closed.p95} ms → open ${openSample.p95} ms)`);
  }

  /* ── 6. scene hooks + layout ─────────────────────────────────────── */
  if (MOBILE) {
    say('scene paused (phone)', opened.scenePaused === true, `isPaused=${opened.scenePaused}`);
  }
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  say('no horizontal overflow', overflow.scrollW <= overflow.innerW + 1,
    `${overflow.scrollW} vs ${overflow.innerW}`);

  /* ── 6b. voice (§11) — the adapter, in a browser with no microphone ──
     A headless browser cannot recognise speech, and this probe does not
     pretend it can. What it CAN check is the part that only exists in a
     browser: that the button is there and labelled, that pressing it either
     turns voice on or says why, and that a failure is undone — a dead
     microphone left switched on, holding the scene's ladder down, is the
     failure mode worth catching here. */
  const micBefore = await page.evaluate(() => {
    const b = document.querySelector('.ai__mic');
    return b ? { text: b.textContent, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled, title: b.title } : null;
  });
  say('voice button present', !!micBefore, micBefore
    ? `"${micBefore.text}" pressed=${micBefore.pressed} — ${micBefore.title}` : 'MISSING');

  const voiceRun = micBefore ? await page.evaluate(async () => {
    document.querySelector('.ai__mic').click();
    await new Promise((r) => setTimeout(r, 1500));
    const bots = [...document.querySelectorAll('.ai__msg.is-bot')];
    const last = bots[bots.length - 1];
    return {
      st: window.PortfolioAI.voice,
      handsFree: window.PortfolioAI.handsFree,
      badge: last?.querySelector('.ai__badge')?.textContent,
      /* The WHOLE bubble is searched, and a separate snippet is printed.
         Truncating before the match was a bug in this probe: the disclosure
         is 221 chars and "leaves this device" sits at 151, so slicing to 120
         made a shown disclosure look absent — the check could not pass, and
         nobody noticed because on this machine the refusal branch ran
         instead for the whole of §11. */
      text: last?.textContent,
      snippet: last?.textContent?.slice(0, 90),
      pressed: document.querySelector('.ai__mic')?.getAttribute('aria-pressed'),
    };
  }) : null;

  if (voiceRun) {
    const st = voiceRun.st || {};
    console.log(`  voice state                   level=${st.level} supported=${st.supported} enabled=${st.enabled} mode=${st.mode}`);
    if (st.enabled) {
      say('voice: disclosure shown', /VOICE ON/.test(voiceRun.badge || '')
        && /leaves this device/i.test(voiceRun.text || ''), `badge="${voiceRun.badge}" "${(voiceRun.snippet || '').trim()}…"`);
      say('voice: proactive mode on', voiceRun.handsFree === true, `handsFree=${voiceRun.handsFree} mode=${st.mode}`);
      /* The other branch cannot check this, and it is the browser-only half:
         the button has to SAY it is live, because a microphone nobody can see
         is the thing §11 is careful about. */
      say('voice: the button reflects the live microphone', voiceRun.pressed === 'true',
        `aria-pressed=${voiceRun.pressed}`);
    } else {
      say('voice: failure is not silent', !!st.reason, `reason="${st.reason || 'NONE — the button just went dead'}"`);
      say('voice: scene handed back', voiceRun.handsFree === false, `handsFree=${voiceRun.handsFree}`);
      say('voice: button went back off', voiceRun.pressed === 'false', `aria-pressed=${voiceRun.pressed}`);
    }
  }

  /* ── 7. Escape closes and returns focus ─────────────────────────── */
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 350));
  const closedState = await page.evaluate(() => ({
    isOpen: window.PortfolioAI?.isOpen,
    focusOnLauncher: document.activeElement?.id === 'askAI',
    ariaExpanded: document.getElementById('askAI')?.getAttribute('aria-expanded'),
    scenePaused: window.Film3D?.isPaused?.() ?? null,
  }));
  say('Escape closes', closedState.isOpen === false, `aria-expanded=${closedState.ariaExpanded}`);
  const voiceAfter = await page.evaluate(() => window.PortfolioAI?.voice);
  say('voice off when closed', !voiceAfter || voiceAfter.enabled === false,
    `enabled=${voiceAfter?.enabled} — a microphone must not outlive the panel`);
  say('focus returned', closedState.focusOnLauncher === true, `activeElement=${closedState.focusOnLauncher ? '#askAI' : 'other'}`);
  if (MOBILE) say('scene resumed (phone)', closedState.scenePaused === false, `isPaused=${closedState.scenePaused}`);

  /* ── 8. hygiene ─────────────────────────────────────────────────── */
  const afterClick = requests.slice(preClick.length).filter((u) => AI_ASSET.test(u));
  console.log(`\n  AI assets fetched on first open: ${afterClick.length}`);
  for (const u of new Set(afterClick)) console.log(`    ${u}`);
  say('no worker before click', !preClick.some((u) => u.startsWith('WORKER:')), '');
  say('console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  say('page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
  say('failed requests', failed.length === 0, failed.slice(0, 5).join(' | '));

  clearTimeout(hardStop);
  await browser.close();
  /* The voice phase takes one of two branches depending on whether this
     machine's engine starts (it is not stable here: the same host refuses on
     one run and listens on the next). Both branches carry the SAME number of
     checks so the tally means something either way. */
  console.log(`\n  ${process.exitCode ? 'PROBE FAILED' : 'probe passed'} — ${checks - failures}/${checks} checks`);
})().catch((e) => { console.log('PROBE CRASH', e.message); process.exit(2); });
