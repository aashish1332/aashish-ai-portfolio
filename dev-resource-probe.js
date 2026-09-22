/* ═══════════════════════════════════════════════════════════════
   dev-resource-probe.js — §15.3 resource + lifecycle measurement

   The brief's own words: "repeat under four states — panel closed, chat
   idle, generating, voice active — plus a 10-minute Proactive soak test
   and 5 open/close cycles (no memory growth)."

   Why this exists separately from dev-ai-probe.js: that one checks
   network / flow / a11y / jank. Nothing checked *memory*, *worker
   lifecycle* or *main-thread busy time* — and those are what make a
   browser show the tab a "using too much resources" warning. A recruiter
   seeing that warning costs more than a slightly slower answer.

   Honesty about the numbers (§15.4): performance.memory is Chromium-only
   and JS-heap-only. CDP reports the same heap, so the same caveat applies
   and is printed with every result. wasm and GPU memory are invisible to
   both. A GC is forced before each reading so the number is not merely
   uncollected garbage.

   Run:  node dev-resource-probe.js
         CYCLES=5 SOAK_MS=600000 node dev-resource-probe.js   (10-min soak)
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_ = process.env.URL || 'http://localhost:5577/';
const CYCLES = Number(process.env.CYCLES || 5);
const SOAK_MS = Number(process.env.SOAK_MS || 0);
const OUT = process.env.OUT || path.join(__dirname, 'docs', 'RESOURCES.json');
/* A long-task verdict names the container, not the code. PROFILE=1 attaches a
   CPU profile to the idle window so the number has a function name under it. */
const PROFILE = process.env.PROFILE === '1';
const NO_SCENE_DEGRADE = process.env.NO_SCENE_DEGRADE === '1';
const CONTROL = process.env.CONTROL === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (b) => +(b / 1048576).toFixed(1);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    /* A probe whose job is to measure a blocked main thread must survive one:
       the default protocol timeout aborts the whole run instead of reporting
       the number, which is how a 1.2 s freeze turns into "no measurement". */
    protocolTimeout: 240000,
    args: ['--window-size=1380,900', '--enable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1 });

  /* Count GL program LINKs at the driver boundary. three.js recompiles every
     material's program when the render path or the render-target format
     changes, and that compile is what a 1.3 s long task has been hiding in.
     Counting links attributes the cost without reading three.js internals. */
  await page.evaluateOnNewDocument(() => {
    window.__glLinks = 0;
    window.__glStacks = [];
    for (const Ctor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Ctor) continue;
      const orig = Ctor.prototype.linkProgram;
      Ctor.prototype.linkProgram = function (...a) {
        window.__glLinks++;
        /* the first few stacks name what asks for a compile */
        if (window.__glStacks.length < 6) {
          window.__glStacks.push((new Error().stack || '').split('\n')
            .slice(1, 5).map((s) => s.trim().replace(/\s*\(.*\/([^/]+):/, ' ($1:')).join(' | '));
        }
        return orig.apply(this, a);
      };
    }
  });
  const glLinks = () => page.evaluate(() => window.__glLinks ?? null);
  const geometry = () => page.evaluate(() => {
    const c = document.querySelector('canvas');
    return {
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollbarPx: window.innerWidth - document.documentElement.clientWidth,
      canvasW: c ? c.clientWidth : null,
      canvasH: c ? c.clientHeight : null,
      dpr: window.devicePixelRatio,
    };
  });

  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  /* ── measurement helpers ─────────────────────────────────────── */
  const metrics = async () => {
    try { await cdp.send('HeapProfiler.collectGarbage'); } catch { /* older chrome */ }
    const { metrics: m } = await cdp.send('Performance.getMetrics');
    const get = (n) => (m.find((x) => x.name === n) || {}).value || 0;
    return {
      jsHeapMB: MB(get('JSHeapUsedSize')),
      jsHeapTotalMB: MB(get('JSHeapTotalSize')),
      nodes: get('Nodes'),
      documents: get('Documents'),
      listeners: get('JSEventListeners'),
    };
  };

  const workers = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((t) => /worker/i.test(t.type)).length;
  };

  /* Aggregate a CDP CPU profile into self time per function, so "1794 ms"
     becomes a name. timeDeltas[i] is the time spent immediately before
     samples[i], which is the standard self-time attribution. */
  const profiled = async (label, fn) => {
    await cdp.send('Profiler.enable');
    /* CDP profile timestamps are NOT on performance.now()'s clock (measured:
       the two disagree by ~1.79e12 ms), so the profile is bracketed by the
       page's own clock and mapped proportionally instead. A long task is
       seconds long; a handful of milliseconds of bracket error is noise. */
    const tBefore = await page.evaluate(() => performance.now());
    await cdp.send('Profiler.start');
    const row = await fn();
    const { profile: p } = await cdp.send('Profiler.stop');
    const tAfter = await page.evaluate(() => performance.now());
    const spanUs = Math.max(1, p.endTime - p.startTime);
    const pageSpanMs = Math.max(1, tAfter - tBefore);
    const toPageMs = (us) => tBefore + ((us - p.startTime) / spanUs) * pageSpanMs;
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const nameOf = (node) => {
      const f = node.callFrame;
      return `${f.functionName || '(anonymous)'}  ${(f.url || 'native').split('/').pop()}:${f.lineNumber + 1}`;
    };
    /* timeDeltas[i] is the time spent immediately before samples[i]; the
       sample's absolute position is the running total from the profile start. */
    const samples = [];
    let at = p.startTime;
    for (let i = 0; i < p.samples.length; i++) {
      at += (p.timeDeltas[i] || 0);
      const node = byId.get(p.samples[i]);
      if (node) samples.push({ pageMs: toPageMs(at), dt: (p.timeDeltas[i] || 0) / 1000, node });
    }
    const self = new Map();
    for (const s of samples) {
      const k = nameOf(s.node);
      self.set(k, (self.get(k) || 0) + s.dt);
    }
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([f, ms]) => ({ fn: f, selfMs: Math.round(ms) }));
    const totalMs = Math.round(samples.reduce((a, s) => a + s.dt, 0));
    const span = samples.length
      ? `samples ${Math.round(samples[0].pageMs)}..${Math.round(samples[samples.length - 1].pageMs)} ms on the page clock`
      : 'no samples';
    console.log(`\n── CPU self time, ${label} (${totalMs} ms profiled; ${span}) ──`);
    for (const t of top) console.log(`  ${String(t.selfMs).padStart(6)} ms  ${t.fn}`);

    /* The verdict names a duration; the attribution must name the CODE.
       For each long task, aggregate only the samples that fell inside it. */
    const inside = [];
    for (const lt of row.topLongTasks.filter((t) => t.ms >= 50)) {
      const bucketed = new Map();
      for (const s of samples) {
        if (s.pageMs < lt.startMs || s.pageMs > lt.endMs) continue;
        const k = nameOf(s.node);
        bucketed.set(k, (bucketed.get(k) || 0) + s.dt);
      }
      const ranked = [...bucketed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([f, ms]) => ({ fn: f, selfMs: Math.round(ms) }));
      const inTaskMs = Math.round([...bucketed.values()].reduce((a, b) => a + b, 0));
      inside.push({ ms: lt.ms, atMs: lt.atMs, startMs: lt.startMs, endMs: lt.endMs,
        profiledMs: inTaskMs, top: ranked });
      console.log(`\n── inside the ${lt.ms} ms task at +${lt.atMs} ms `
        + `(${inTaskMs} ms of it sampled) ──`);
      for (const t of ranked) console.log(`  ${String(t.selfMs).padStart(6)} ms  ${t.fn}`);
    }
    return { label, totalMs, top, inside, row, pageSpanMs: Math.round(pageSpanMs) };
  };

  /* one observation window: long tasks + frame deltas off the app's own ticker */
  const observe = (ms = 3000) => page.evaluate((windowMs) => new Promise((resolve) => {
    let longMs = 0, longCount = 0, maxTask = 0;
    /* A verdict of "a 1435 ms task" is not actionable without knowing WHICH
       task. Long Task Attribution (Chromium) names the container it started
       in, so the top entries are kept and printed — a number that cannot be
       traced is a number nobody can fix. */
    const top = [];
    const t0 = performance.now();
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          longMs += e.duration; longCount++;
          if (e.duration > maxTask) maxTask = e.duration;
          const a = e.attribution?.[0] || {};
          top.push({
            ms: Math.round(e.duration),
            atMs: Math.round(e.startTime - t0),          /* offset into the window */
            startMs: e.startTime,                        /* page clock, for profile mapping */
            endMs: e.startTime + e.duration,
            name: e.name,
            containerType: a.containerType || null,
            containerName: (a.containerName || '').slice(0, 80) || null,
            containerSrc: a.containerSrc || null,
          });
        }
      }).observe({ type: 'longtask', buffered: false });
    } catch { /* unsupported (Firefox/Safari) */ }

    const deltas = [];
    let last = performance.now();
    const onTick = () => { const n = performance.now(); deltas.push(n - last); last = n; };
    window.gsap.ticker.add(onTick);

    setTimeout(() => {
      window.gsap.ticker.remove(onTick);
      deltas.sort((a, b) => a - b);
      const med = deltas[(deltas.length / 2) | 0] || 0;
      const p95 = deltas[(deltas.length * 0.95) | 0] || 0;
      resolve({
        frames: deltas.length,
        medianMs: +med.toFixed(2),
        p95Ms: +p95.toFixed(2),
        medianFps: med ? +(1000 / med).toFixed(1) : null,
        longTaskMs: Math.round(longMs),
        longTaskCount: longCount,
        maxLongTaskMs: Math.round(maxTask),
        mainThreadBusyPct: +((longMs / windowMs) * 100).toFixed(2),
        topLongTasks: top.sort((a, b) => b.ms - a.ms).slice(0, 3),
      });
    }, windowMs);
  }), ms);

  const state = async (label) => {
    const [met, wk, obs, links] = await Promise.all([metrics(), workers(), observe(3000), glLinks()]);
    const row = { label, ...met, workers: wk, links, ...obs };
    console.log(
      `${label.padEnd(20)} heap ${String(row.jsHeapMB).padStart(6)} MB · nodes ${String(row.nodes).padStart(5)}`
      + ` · listeners ${String(row.listeners).padStart(5)} · workers ${row.workers}`
      + ` · median ${String(row.medianMs).padStart(6)} ms · p95 ${String(row.p95Ms).padStart(7)} ms`
      + ` · busy ${String(row.mainThreadBusyPct).padStart(5)}% · GL links ${row.links}`);
    for (const t of row.topLongTasks) {
      console.log(`    long task ${String(t.ms).padStart(5)} ms at +${String(t.atMs).padStart(5)} ms`
        + ` · container ${t.containerType || '?'}`
        + `${t.containerName ? ` "${t.containerName}"` : ''}`
        + `${t.containerSrc ? ` <${t.containerSrc.split('/').pop()}>` : ''}`);
    }
    return row;
  };

  const openPanel = async () => {
    await page.evaluate(() => document.getElementById('askAI').click());
    await page.waitForFunction(() => window.PortfolioAI && window.PortfolioAI.isOpen, { timeout: 15000 });
    await sleep(600);
  };
  const closePanel = async () => {
    await page.evaluate(() => window.PortfolioAI && window.PortfolioAI.close());
    await sleep(400);
  };
  const ask = async (q) => {
    await page.evaluate((text) => window.PortfolioAI.ask(text), q);
    await sleep(900);
  };

  /* ── run: the four states, then cycles, then soak ────────────── */
  console.log('── §15.3 RESOURCE + LIFECYCLE ──');
  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(5000);                                   /* boot + governor grace */

  /* ── controlled experiment: is the big long task the AI, or the film? ──
     The CPU profile put 1105 ms of a 1369 ms task inside
     `getProgramInfoLog` — WebGL shader compilation, not AI code. The next
     question is what ASKED for it: rung 3 of the §6.3 ladder calls
     setQuality('low'), which switches the render path and invalidates the
     program cache. Disabling exactly that hook, with everything else in the
     AI path untouched, tells the two apart. */
  if (process.env.NO_SCENE_DEGRADE === '1') {
    await page.evaluate(() => {
      window.__qualityCalls = [];
      if (window.Film3D) {
        window.Film3D.setQuality = (mode) => {
          window.__qualityCalls.push({ mode, atMs: Math.round(performance.now()) });
        };
      }
    });
    console.log('['+'experiment] Film3D.setQuality disabled — quality calls recorded, not applied');
  }

  /* ── CONTROL: the same page, the same age, the panel never opened ──
     A verdict of "the AI breaks the frame budget" is only meaningful if the
     page on its own does not. This runs the identical 3 s windows with no AI
     module loaded at all, so an unattributed long task can be told apart from
     an AI-attributable one instead of being blamed on whichever was handy. */
  if (CONTROL) {
    const ctrl = [];
    console.log('\n── CONTROL: 6 x 3 s windows, panel never opened ──');
    for (let i = 1; i <= 6; i++) ctrl.push(await state(`control-${i}`));
    const over = ctrl.flatMap((r) => r.topLongTasks.filter((t) => t.ms >= 50));
    const worst = ctrl.reduce((a, r) => Math.max(a, r.maxLongTaskMs), 0);
    console.log(`\nCONTROL worst long task ${worst} ms · ${over.length} tasks >= 50 ms in 18 s`);
    fs.writeFileSync(path.join(__dirname, 'docs', 'RESOURCES-CONTROL.json'),
      JSON.stringify({ measuredAt: new Date().toISOString(), url: URL_, windows: ctrl,
        worstLongTaskMs: worst, tasksOver50ms: over.length }, null, 2));
    await browser.close();
    return;
  }

  /* ── the page's own baseline, measured in the SAME session ──
     §4 budgets the AI's interaction at <= 50 ms tasks. On this toolchain the
     film alone already produces 57–90 ms tasks (measured), so a bare "over
     50 ms" verdict would blame the AI for the renderer — the exact mistake
     the 1.8 s shader-recompile task was hiding behind. The baseline makes the
     verdict a statement about the AI's CONTRIBUTION. */
  const baseline = [];
  console.log('\n── baseline: 4 x 3 s windows, panel never opened ──');
  for (let i = 1; i <= 4; i++) baseline.push(await state(`baseline-${i}`));
  const baselineWorst = baseline.reduce((a, r) => Math.max(a, r.maxLongTaskMs), 0);

  const rows = [];
  rows.push(await state('1 panel-closed'));

  /* First open, timed in phases. The click is where the dynamic import starts,
     so `buildMs` covers module fetch+parse+compile+DOM build, and `loadMs`
     covers knowledge.json + capability probe + the worker benchmark. */
  const geoBefore = await geometry();
  const linksBefore = await glLinks();
  const firstOpen = await page.evaluate(async () => {
    const t0 = performance.now();
    document.getElementById('askAI').click();
    await new Promise((res) => {
      const i = setInterval(() => { if (window.PortfolioAI?.isOpen) { clearInterval(i); res(); } }, 4);
    });
    const buildMs = +(performance.now() - t0).toFixed(1);
    await new Promise((res) => {
      const i = setInterval(() => { if (window.PortfolioAI?.state !== 'loading') { clearInterval(i); res(); } }, 4);
    });
    return { buildMs, loadMs: +(performance.now() - t0 - buildMs).toFixed(1),
             totalMs: +(performance.now() - t0).toFixed(1) };
  });
  console.log(`first open: import+build ${firstOpen.buildMs} ms · load ${firstOpen.loadMs} ms · total ${firstOpen.totalMs} ms`);
  const geoAfter = await geometry();
  console.log(`viewport before ${geoBefore.clientWidth} px (scrollbar ${geoBefore.scrollbarPx}) -> `
    + `after ${geoAfter.clientWidth} px (scrollbar ${geoAfter.scrollbarPx})`
    + ` · canvas ${geoBefore.canvasW}x${geoBefore.canvasH} -> ${geoAfter.canvasW}x${geoAfter.canvasH}`
    + ` · GL program links this run: ${linksBefore} -> ${await glLinks()}`);
  await sleep(600);
  let profile = null;
  if (PROFILE) profile = await profiled('2 chat-idle', async () => {
    const r = await state('2 chat-idle'); rows.push(r); return r;
  });
  else rows.push(await state('2 chat-idle'));


  /* Per-question attribution: an answer is text, so any GL program compile in
     this loop belongs to something the answer TRIGGERED, and the delta per
     question says which. */
  const perQuestion = [];
  for (const q of ['what is my cgpa', 'list your projects', 'which databases do you use',
                   'where do you study', 'how do you use ai']) {
    const b = await page.evaluate(() => ({ y: window.scrollY, links: window.__glLinks,
      lenis: window.Director?.getLenis?.()?.scroll ?? null }));
    await ask(q);
    const a = await page.evaluate(() => ({ y: window.scrollY, links: window.__glLinks,
      lenis: window.Director?.getLenis?.()?.scroll ?? null }));
    const d = { q, newLinks: a.links - b.links, scrollY: [b.y, a.y], lenis: [b.lenis, a.lenis] };
    perQuestion.push(d);
    console.log(`  ask "${q}" -> +${d.newLinks} GL programs · scrollY ${b.y}->${a.y}`
      + `${d.lenis ? ` · lenis ${Math.round(b.lenis)}->${Math.round(a.lenis)}` : ''}`);
  }
  const glStacks = await page.evaluate(() => window.__glStacks);
  rows.push(await state('3 after-answers'));
  /* transcript growth is a property of keeping history, not a leak: measured
     per answer so it can be bounded without pretending it is zero */
  const nodesPerAnswer = +(((rows[2].nodes - rows[1].nodes) / 5)).toFixed(1);

  await page.evaluate(() => window.PortfolioAI.setHandsFree(true));
  await ask('tell me about the volunteer project');
  rows.push(await state('4 hands-free'));
  await page.evaluate(() => window.PortfolioAI.setHandsFree(false));

  await closePanel();
  rows.push(await state('5 closed-again'));

  /* Read the quality calls AFTER the whole session. Reading them right after
     the first 3 s window was an instrument bug: the ladder's dwellMs is
     1500 ms per rung, so rung 3 (the one that changes scene quality) fires
     around 4.5 s after open — later than that first sample, which made a
     negative result out of a positive one. */
  const qualityCalls = await page.evaluate(() => window.__qualityCalls || []);
  if (NO_SCENE_DEGRADE) {
    console.log(`\nquality calls the ladder asked for: ${JSON.stringify(qualityCalls)}`);
    console.log(`GL programs linked, open to end: ${linksBefore} -> ${await glLinks()}`);
  }

  /* ── open/close cycles: a reopen must cost NOTHING ──────────────
     Deliberately no question here. Asking one adds two messages, which is
     transcript growth (bounded separately) and would hide a reopen leak
     inside it — which is exactly how the rebuild bug stayed invisible. */
  const cycles = [];
  console.log(`\n── ${CYCLES} open/close cycles, no question (reopen leak check) ──`);
  for (let i = 1; i <= CYCLES; i++) {
    await openPanel();
    await closePanel();
    const m = await metrics();
    const w = await workers();
    cycles.push({ cycle: i, jsHeapMB: m.jsHeapMB, nodes: m.nodes, listeners: m.listeners, workers: w });
    console.log(`cycle ${i}: heap ${m.jsHeapMB} MB · nodes ${m.nodes} · listeners ${m.listeners} · workers ${w}`);
  }

  let soak = null;
  if (SOAK_MS > 0) {
    console.log(`\n── soak (${Math.round(SOAK_MS / 1000)} s, hands-free) ──`);
    await openPanel();
    await page.evaluate(() => window.PortfolioAI.setHandsFree(true));
    const before = await metrics();
    const t0 = Date.now();
    while (Date.now() - t0 < SOAK_MS) await sleep(5000);
    const after = await metrics();
    soak = { ms: SOAK_MS, heapBeforeMB: before.jsHeapMB, heapAfterMB: after.jsHeapMB,
             growthMB: +(after.jsHeapMB - before.jsHeapMB).toFixed(1) };
    console.log(`heap ${before.jsHeapMB} MB -> ${after.jsHeapMB} MB over ${Math.round(SOAK_MS / 1000)} s`);
    await page.evaluate(() => window.PortfolioAI.setHandsFree(false));
    await closePanel();
  }

  /* ── verdicts against the §4 budgets ────────────────────────── */
  const base = rows[0];
  const last = rows[rows.length - 1];
  const firstCycle = cycles[0];
  const lastCycle = cycles[cycles.length - 1];
  const growthPerCycle = CYCLES > 1
    ? +(((lastCycle.jsHeapMB - firstCycle.jsHeapMB) / (CYCLES - 1))).toFixed(2) : 0;
  const nodeGrowth = lastCycle.nodes - firstCycle.nodes;
  const listenerGrowth = lastCycle.listeners - firstCycle.listeners;
  const worstMaxTask = Math.max(...rows.map((r) => r.maxLongTaskMs));
  const linksEnd = await glLinks();
  const fpsClosed = base.medianFps;
  const fpsOpen = rows[1].medianFps;
  const fpsDropPct = fpsClosed && fpsOpen
    ? +(((fpsClosed - fpsOpen) / fpsClosed) * 100).toFixed(1) : null;

  const checks = [
    { name: 'no heap growth across open/close cycles', ok: growthPerCycle <= 1.5,
      detail: `${growthPerCycle} MB/cycle over ${CYCLES} cycles` },
    { name: 'a reopen leaks no DOM nodes', ok: nodeGrowth <= 4,
      detail: `${nodeGrowth} nodes over ${CYCLES} reopens (${(nodeGrowth / Math.max(1, CYCLES - 1)).toFixed(1)}/reopen)` },
    { name: 'a reopen leaks no listeners', ok: listenerGrowth <= 2,
      detail: `${listenerGrowth} listeners over ${CYCLES} reopens` },
    { name: 'transcript growth per answer stays bounded', ok: nodesPerAnswer <= 25,
      detail: `${nodesPerAnswer} nodes/answer` },
    { name: 'no AI worker outlives a close', ok: last.workers === base.workers,
      detail: `closed ${base.workers} -> ${last.workers}` },
    { name: 'median FPS drop with the panel open <= 10% (§4)',
      ok: fpsDropPct === null || fpsDropPct <= 10,
      detail: fpsDropPct === null ? 'unavailable' : `${fpsDropPct}%` },
    /* The budget is about the AI's contribution. Where the page on its own
       already exceeds 50 ms — a software-GL film does — the AI is held to the
       page's own baseline instead, and the detail names both numbers. */
    { name: 'no long task attributable to the AI (§4: <= 50 ms above the page baseline)',
      ok: worstMaxTask <= Math.max(50, baselineWorst),
      detail: `AI windows worst ${worstMaxTask} ms · page-only baseline ${baselineWorst} ms` },
    /* §6.3's rung 3 changes the render path, and that is not free: three.js
       recompiles every material's program. MEASURED before the gate: 21
       programs relinked, 1221 ms blocked. A reopen or an idle session must
       compile nothing at all. */
    { name: 'the AI compiles no GL program (rung 3 costs a full recompile)',
      ok: linksEnd === linksBefore,
      detail: `${linksBefore} -> ${linksEnd} programs linked` },
    { name: 'extra AI heap under the desktop budget (§4: <=300 MB)',
      ok: (last.jsHeapMB - base.jsHeapMB) <= 300,
      detail: `${(last.jsHeapMB - base.jsHeapMB).toFixed(1)} MB heap delta` },
  ];
  if (soak) checks.push({
    name: 'no heap growth during the soak', ok: soak.growthMB <= 5,
    detail: `${soak.growthMB} MB over ${Math.round(soak.ms / 1000)} s`,
  });

  console.log('\n── VERDICT ──');
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  console.log('NOTE: heap is Chromium JS-heap only (CDP Performance.getMetrics) —'
    + ' wasm and GPU memory are invisible to it, exactly as §15.4 warns.');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    measuredAt: new Date().toISOString(),
    url: URL_,
    states: rows,
    baseline,
    baselineWorst,
    cycles,
    soak,
    profile,
    qualityCalls,
    perQuestion,
    glStacks,
    viewport: { before: geoBefore, after: geoAfter, glLinksBefore: linksBefore, glLinksAfter: await glLinks() },
    verdict: { checks, passed: checks.length - failed, failed },
    provenance: {
      jsHeap: 'MEASURED (CDP Performance.getMetrics JSHeapUsedSize after HeapProfiler.collectGarbage)',
      nodesListeners: 'MEASURED (CDP Performance.getMetrics Nodes / JSEventListeners)',
      workers: 'MEASURED (CDP Target.getTargets)',
      frameDeltas: 'MEASURED (the app\'s own gsap ticker, 3 s window per state)',
      mainThreadBusy: 'ESTIMATED (longtask ms / wall ms; excludes sub-50 ms tasks)',
      gaps: 'NOT MEASURED: wasm/GPU memory, other tabs, OS pressure (§15.4)',
    },
  }, null, 2));
  console.log(`\n-> ${OUT}`);

  await browser.close();
  if (failed) process.exit(1);
})().catch((e) => { console.error('RESOURCE PROBE FAILED:', e.message); process.exit(1); });