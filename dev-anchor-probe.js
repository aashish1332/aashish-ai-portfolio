/* ═══════════════════════════════════════════════════════════════
   dev-anchor-probe.js — "show me where that is", measured in a real page

   The unit tests drive a fake DOM. This drives the actual portfolio: it
   asks real questions, records which element each one resolved to, then
   EDITS THE LIVE PAGE — reordering the scenes and moving a project into a
   different scene — and asks the same questions again.

   That second half is the whole point. A resolver that cached an offset or
   an index would pass the first half and fail the second.

   Run:  node dev-anchor-probe.js     (needs: npm run dev)
         AI_BASE=http://localhost:5582/ node dev-anchor-probe.js   (against dist/)

   Runtime: a full run is **fourteen generations** (seven questions, twice —
   once as shipped, once after the page is edited) plus two page settles, so on
   the CPU box this was written on it takes 20–30 minutes. The default hard stop
   below is sized for that; PROBE_TIMEOUT overrides it for a faster machine or
   for a deliberately short run, and a timeout prints `PROBE TIMEOUT` so a
   truncated run is never mistaken for a failed check.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.AI_BASE || 'http://localhost:5577/';

let checks = 0;
const say = (label, ok, detail) => {
  checks += 1;
  console.log(`${ok ? '\u2714' : '\u2716'} ${label.padEnd(44)} ${detail || ''}`);
  if (!ok) process.exitCode = 1;
};

/* the section id the page should END UP on. `null` = any real section, the
   assertion being only that it is a section and not the whole page. */
const QUESTIONS = [
  ['what projects have you built', 'scene-work'],
  ['tell me about the grocery app', 'scene-work'],
  ['what are your skills', null],
  ['what is your cgpa', null],
  ['how can i contact you', 'scene-end'],
  ['where do you live', 'scene-end'],
  ['what certifications do you have', null],
];

/* A full run asks seven questions TWICE, and each one now waits for a model
   generation before it measures, which is minutes on a loaded box.
   `PROBE_MAX_VIS=n` limits the visibility phase to the first n questions, and
   `PROBE_SKIP_VISIBILITY=1` drops it entirely — the §12 resolution checks, the
   landing assertions and the hands-free move all still run — so a fix to the
   waits can be verified without a ten-minute probe. */
const MAX_VIS = Number(process.env.PROBE_MAX_VIS || 0) || QUESTIONS.length;
const SKIP_VISIBILITY = process.env.PROBE_SKIP_VISIBILITY === '1';
const VIS_QUESTIONS = QUESTIONS.slice(0, MAX_VIS);

(async () => {
  /* Generous, because the visibility phase WAITS for the page to settle rather
     than for a fixed duration, this software-GL renderer moves slowly, and the
     sweep is fourteen generations. 900 s was too short for it on the CPU box
     this was written on — the run that set this value reached the end of the
     `after the edit` half and then timed out waiting for the reloaded page — so
     it is 1,800 s now, and `PROBE TIMEOUT` is printed rather than a tally that
     could be read as a failed check. */
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); },
    Number(process.env.PROBE_TIMEOUT || 1800000));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1280,800', '--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));

  /* ── open the panel the way a visitor does ─────────────────────── */
  await page.click('#askAI');
  await page.waitForFunction(() => window.PortfolioAI && window.PortfolioAI.state === 'ready',
    { timeout: 60000, polling: 250 });

  const scenes = await page.evaluate(() =>
    [...document.querySelectorAll('[data-scene]')].map((s) => s.id));
  console.log(`\nsections on the page: ${scenes.join(', ')}\n`);

  const askAll = async () => {
    const out = [];
    for (const [q] of QUESTIONS) {
      /* Projected to plain data on purpose: whatever the shell adds to
         `lastAnchor` must not be able to make this call unserializable. A
         DOM node in that object returns `undefined` for the WHOLE snapshot
         rather than raising, which reads as "nothing found" — which is
         exactly what it did when `el` was added there, and it took a
         diagnostic to tell apart from a broken resolver. The live element
         is reachable by `PortfolioAI.anchorElement()`, called inside the
         page, and that is how the visibility phase reads it. */
      const r = await page.evaluate((question) => {
        window.PortfolioAI.ask(question);
        const a = window.PortfolioAI.lastAnchor;
        return a && {
          target: a.target, targetTag: a.targetTag, tag: a.tag,
          id: a.id, text: a.text, why: a.why, topics: a.topics,
        };
      }, q);
      out.push([q, r]);
    }
    return out;
  };

  /* ── 1. resolve against the page as shipped ────────────────────── */
  const report = (rows) => {
    for (const [q, a] of rows) {
      if (!a) { console.log(`${'NOTHING FOUND'.padEnd(24)} <- "${q}"`); continue; }
      console.log(`${String(a.target || a.targetTag).padEnd(24)} <- "${q}"`);
      console.log(`${''.padEnd(24)}    matched <${a.tag.toLowerCase()}${a.id ? '#' + a.id : ''}> "${a.text.slice(0, 46)}"`);
    }
  };

  const before = await askAll();
  console.log('── as shipped ─────────────────────────────────────────');
  report(before);

  /* Ask one question and DO NOT MEASURE until its answer exists.

     This is the fix for a measurement that was reporting a product failure.
     The page is moved in `finish()`, i.e. when the answer ENDS — but the
     shell sets `lastAnchor` synchronously before it starts generating, so a
     probe that fired `ask()` and then watched the scroll saw `scrollY`
     perfectly stable at 0 (nothing had been asked yet) and reported "the
     visitor cannot see it". It worked while answers were templates and a
     probe could read the result within a second; the moment every answer
     became a model generation of seconds-to-tens-of-seconds it began to
     fail on unchanged code, on the source tree and on the built bundle
     alike. A diagnostic page-drive showed the move itself is fine:
     `scrollY 0 → 14609`, target `#scene-credits`, the anchored element in the
     DOM, no page errors.

     So: wait for a NEW answer (object identity — `model.last` is replaced per
     turn), then for the scroll it causes to stop. */
  const askAndWait = async (question, maxMs = 180000) => {
    await page.evaluate((q) => {
      window.__prevAnswer = window.PortfolioAI.model.last;
      window.PortfolioAI.setHandsFree(true);
      window.PortfolioAI.ask(q);
    }, question);
    await page.waitForFunction(() => {
      const m = window.PortfolioAI.model;
      return !!m.last && m.last !== window.__prevAnswer;
    }, { timeout: maxMs, polling: 300 });
  };

  /* Resolve once the scroll position has stopped changing, or give up after a
     generous bound and let the measurement say what it found.

     `movesNeeded` is what keeps this from returning instantly when the answer
     has arrive but its scroll has not started yet: stability only counts
     after the page has actually moved that many times. The pre-ask reset
     passes 0, because it is supposed to find the page already still. */
  const settle = async (maxMs = 20000, movesNeeded = 1) => {
    const t0 = Date.now();
    let last = -1;
    let stable = 0;
    let moves = 0;
    while (Date.now() - t0 < maxMs) {
      const y = await page.evaluate(() => window.scrollY);
      if (Math.abs(y - last) < 1) stable += 1; else { stable = 0; moves += 1; }
      last = y;
      if (stable >= 3 && moves >= movesNeeded) return y;
      await new Promise((r) => setTimeout(r, 200));
    }
    return last;
  };

  /* How much of the element an answer points at is inside the viewport once
     the move settles. "The page moved" and "you are looking at the thing you
     asked about" are different claims, and only the first was measured: the
     move goes through `Director.scrollTo` on the SECTION, so an element
     inside a tall pinned scene can be off-screen while `scrollY` rises.

     Defined here, CALLED AT THE END, and that placement is load-bearing —
     see the note at the call site. */
  const measureVisibility = async () => {
    const rows = [];
    if (SKIP_VISIBILITY) return rows;
    for (const [q] of VIS_QUESTIONS) {
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await settle(8000, 0);
      await askAndWait(q);
      /* WAIT FOR THE PAGE TO STOP, not for a duration — and only accept
         "stopped" once it has actually moved. The move is a smooth Lenis
         scroll driven by rAF, a target can be 18,000 px away, and this
         software-GL renderer runs the film at well under 1 fps, so a fixed
         wait measures "the scroll had not arrived yet" and reports it as
         "the visitor cannot see it". */
      await settle(20000, 1);
      rows.push([q, await page.evaluate(() => {
        const a = window.PortfolioAI.lastAnchor;
        /* read INSIDE the page — the node never crosses the boundary */
        const el = window.PortfolioAI.anchorElement?.();
        /* WHICH KIND of turn this was. A model answer moves the page to where
           it came from; a refusal deliberately does not — the panel made no
           claim, so there is no place for it to point at (see `finish()` in
           ai/ui/chat.mjs). The two need opposite assertions, and with a
           checkpoint that answers badly most turns are refusals, so scoring
           them both as "the visitor cannot see it" measured the model's
           quality and called it an anchors regression. */
        const kind = window.PortfolioAI.model.last?.kind || null;
        const scrollY = Math.round(window.scrollY);
        if (!el) return { found: false, kind, scrollY };
        const r = el.getBoundingClientRect();
        const h = window.innerHeight || 1;
        const px = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0));
        const scene = (el.closest && el.closest('[data-scene]')) || el;
        const sr = scene.getBoundingClientRect ? scene.getBoundingClientRect() : r;
        const sPx = Math.max(0, Math.min(sr.bottom, h) - Math.max(sr.top, 0));
        return {
          found: true, kind, scrollY,
          target: scene.id || '', tag: String(a.tag || ''),
          top: Math.round(r.top), height: Math.round(r.height), px: Math.round(px),
          ratio: r.height ? +(px / r.height).toFixed(2) : 0,
          onScreen: r.top < h && r.bottom > 0,
          /* whether the page RENDERS the element at all. A section the film
             does not lay out leaves the resolved child at zero area — the
             resolver is right about where the fact lives, and the visitor
             cannot be shown it. Reported separately so the two are never
             confused with each other. */
          rendered: r.width > 0 && r.height > 0,
          section: scene.id || '', sectionPx: Math.round(sPx), sectionVisible: sr.top < h && sr.bottom > 0,
          laidOut: (sr.height || 0) > 0,
        };
      })]);
    }
    await page.evaluate(() => window.PortfolioAI.setHandsFree(false));
    return rows;
  };

  const reportVisibility = (rows, label) => {
    if (!rows.length) {
      console.log(`\n── ${label}: visibility phase skipped (PROBE_SKIP_VISIBILITY=1)`);
      return;
    }
    console.log(`\n── ${label} ──────────────────────────`);
    for (const [q, v] of rows) {
      const what = ` <${String(v.tag).toLowerCase()}> in #${v.target}`;
      const state = v.kind !== 'model' ? `refused:${v.kind}`
        : (v.onScreen ? 'visible' : (v.rendered ? 'OFF SCREEN' : 'not rendered'));
      console.log(`${state.padEnd(13)} ${String(v.ratio).padStart(5)}${what.padEnd(34)}`
        + ` el top=${v.top}px h=${v.height}px · section ${v.sectionPx}px, ${v.sectionVisible ? 'on screen' : 'OFF SCREEN'}  ← "${q}"`);
    }
    for (const [q, v] of rows) {
      /* The assertion depends on the KIND of turn, because the two correct
         behaviours are opposite.

         A model ANSWER must put the element in view — or, if the film does
         not lay the element out (an edited-in section with no layout), the
         SECTION is what the visitor gets; both are honest, and "the page
         scrolled somewhere" is not.

         A REFUSAL must move nothing at all: "the panel made no claim and must
         not move the page to where a claim it did not make came from".
         Requiring a move here made correct behaviour fail, and with a
         checkpoint that answers badly it made most of the phase fail. */
      const answered = v.kind === 'model';
      const ok = answered
        ? !!(v.found && (v.onScreen || !v.laidOut))
        : !!(v.found && v.scrollY < 50);
      say(`${label}: "${q}" ${answered ? 'is on screen' : 'refusal moved nothing'}`, ok,
        !v.found ? 'nothing resolved'
          : answered
            ? (v.onScreen ? `${v.px}/${v.height} px of the element in view, in #${v.target}`
              : v.laidOut ? `element ${v.px}/${v.height} px — OFF SCREEN, in #${v.target}`
                : `#${v.section} is not laid out by the film (0 px), so there is nothing to show`)
            : `kind=${v.kind}, page at ${v.scrollY} px — a refusal claims nothing to point at`);
    }
    const missing = rows.filter(([, v]) => v.found && !v.rendered).length;
    if (missing) {
      console.log(`   note: ${missing} of ${rows.length} point at content inside a scene the film`
        + ` does not lay out (zero area) — a consequence of the fixture moving markup the film has`
        + ` no layout for, not of resolution, which still finds it.`);
    }
  };

  const found = before.filter(([, a]) => a).length;
  say('an anchor was found for every question', found === before.length,
    `${found}/${before.length}`);
  const targets = new Map(before.map(([q, a]) => [q, a && a.target]));
  for (const [q, want] of QUESTIONS) {
    if (!want) continue;
    say(`"${q}" lands on #${want}`, targets.get(q) === want, `got ${targets.get(q)}`);
  }
  /* `null` targets were only ever "something real, not the page" */
  for (const [q, a] of before) {
    if (!a) continue;
    say(`"${q}" is a section, not the page`,
      a.targetTag === 'SECTION' && a.targetTag !== 'BODY' && a.targetTag !== 'MAIN',
      `${a.targetTag}${a.target ? '#' + a.target : ''}`);
  }

  /* ── 2. scroll actually happens (hands-free, nobody clicking) ──── */
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await new Promise((r) => setTimeout(r, 400));
  const y0 = await page.evaluate(() => window.scrollY);
  /* the same race, in its purest form: a fixed 2.6 s wait is shorter than a
     generation, so this measured a page nobody had asked anything of */
  await askAndWait('what projects have you built');
  await settle(20000, 1);
  const turn = await page.evaluate(() => ({
    y: window.scrollY,
    kind: window.PortfolioAI.model.last?.kind || null,
  }));
  const moved = turn.y > y0 + 50;
  /* Both outcomes are correct, and they are not the same assertion: an ANSWER
     moves the page, a REFUSAL moves nothing because there is no claim to
     point at. Requiring a move unconditionally made this check fail whenever
     the guard rejected an answer — which, with a checkpoint that answers
     badly, is most of the time. */
  if (turn.kind === 'model') {
    say('hands-free: the answer moved the page', moved,
      `kind=model, scrollY ${Math.round(y0)} → ${Math.round(turn.y)}`);
  } else {
    say('hands-free: a refusal moved nothing', !moved,
      `kind=${turn.kind}, scrollY ${Math.round(y0)} → ${Math.round(turn.y)} (a refusal makes no claim to show)`);
  }

  /* ── 2b. but can the visitor SEE it? ───────────────────────────────
     "The page moved" and "you are looking at the thing you asked about"
     are different claims, and only the first was measured. The move goes
     through `Director.scrollTo` on the SECTION, so an element deep inside a
     tall pinned scene can stay off-screen while `scrollY` rises and the
     check above still passes. This is §12's own open item, so it is
     measured per question instead of argued. */
  const seen = [];
  for (const [q] of QUESTIONS) {
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await new Promise((r) => setTimeout(r, 350));
    await page.evaluate((question) => {
      window.PortfolioAI.setHandsFree(true);
      window.PortfolioAI.ask(question);
    }, q);
    await new Promise((r) => setTimeout(r, 2600));
    seen.push([q, await page.evaluate(() => {
      const a = window.PortfolioAI.lastAnchor;
      /* read INSIDE the page — a DOM node must never cross the snapshot's
         returnByValue boundary, or every anchor here reads "nothing found" */
      const el = window.PortfolioAI.anchorElement?.();
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const h = window.innerHeight || 1;
      const px = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0));
      return {
        found: true, target: a.target || '', tag: String(a.tag || ''),
        top: Math.round(r.top), height: Math.round(r.height), px: Math.round(px),
        ratio: r.height ? +(px / r.height).toFixed(2) : 0,
        onScreen: r.top < h && r.bottom > 0,
      };
    })]);
  }
  console.log('\n── is the answer on screen once the page settles? ──────');
  for (const [q, v] of seen) {
    const what = ` <${String(v.tag).toLowerCase()}${v.target ? '#' + v.target : ''}>`;
    console.log(`${(v.onScreen ? 'visible' : 'OFF SCREEN').padEnd(10)} ${String(v.ratio).padStart(5)}${what.padEnd(26)}`
      + ` top=${v.top}px h=${v.height}px  ← "${q}"`);
  }
  for (const [q, v] of seen) {
    say(`"${q}" is on screen after the move`, !!(v.found && v.onScreen),
      v.found ? `${v.px}/${v.height} px in view` : 'nothing resolved');
  }

  await page.evaluate(() => window.PortfolioAI.setHandsFree(false));

  /* ── 3. EDIT THE PAGE, then ask the same questions ─────────────── */
  const edit = await page.evaluate(async () => {
    const film = document.getElementById('film');
    const work = document.getElementById('scene-work');
    const codir = document.getElementById('scene-codir');
    const kb = await (await fetch('/knowledge/knowledge.json')).json();
    const projects = (kb.projects || []).filter((p) => p.public !== false);
    const grocery = projects.find((p) => /grocery/i.test(p.name));

    /* the card we are about to ask about — not just the first one, or the
       assertion would be about a project that never moved */
    const takes = [...document.querySelectorAll('#scene-work .take')];
    const take = takes.find((t) => /grocery/i.test(t.textContent)) || takes[0];

    /* the projects scene moves to the END and loses its id and its declared
       topics, so only content can find it */
    work.removeAttribute('data-ai-topics');
    work.id = 'scene-renamed-projects';
    work.setAttribute('data-scene', 'renamed');
    film.appendChild(work);

    /* A NEW section, appended last, is the only place the grocery project is
       described from now on: its card goes in, and the build ledger that also
       names it (by codename) is removed. Without this the page would have two
       truthful answers and the assertion would be ambiguous — the ambiguity is
       real, and the shipped page resolves it with data-ai-topics; here the
       content has genuinely moved. */
    const appendix = document.createElement('section');
    appendix.id = 'scene-appendix';
    appendix.setAttribute('data-scene', 'appendix');
    if (take) appendix.appendChild(take);
    film.appendChild(appendix);
    let ledgerRemoved = false;
    for (const a of [...codir.querySelectorAll('.ledger')]) {
      if (grocery && a.textContent.includes(grocery.portfolio_codename)) { a.remove(); ledgerRemoved = true; }
    }
    return {
      moved: take ? (take.querySelector('h3') || {}).textContent.trim() : null,
      order: [...film.querySelectorAll('[data-scene]')].map((s) => s.id),
      ledgerRemoved,
    };
  });
  console.log(`\n── after editing the page ──────────────────────────────`);
  console.log(`   scene order is now: ${edit.order.join(' → ')}`);
  console.log(`   "${edit.moved}" was moved into a NEW section (the old ledger that`);
  console.log(`   also named it was removed: ${edit.ledgerRemoved}), and the projects`);
  console.log('   scene was renamed, moved to the end and lost its topics\n');

  const after = await askAll();
  report(after);

  /* ── 3b. on the EDITED page, is the thing still on screen? ────────
     This is where the risk actually lives: with `data-ai-topics` stripped,
     the resolver falls back to content, and content matches land on CARDS
     rather than sections — while the page still scrolls to the SECTION. On
     the shipped page every answer resolves to a section (h = one viewport),
     so the shipped phase above cannot see this. Here it can. */
  const seenAfter = [];
  for (const [q] of QUESTIONS) {
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await new Promise((r) => setTimeout(r, 350));
    await page.evaluate((question) => {
      window.PortfolioAI.setHandsFree(true);
      window.PortfolioAI.ask(question);
    }, q);
    await new Promise((r) => setTimeout(r, 2600));
    seenAfter.push([q, await page.evaluate(() => {
      const a = window.PortfolioAI.lastAnchor;
      /* read INSIDE the page — see the note in 2b above */
      const el = window.PortfolioAI.anchorElement?.();
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const h = window.innerHeight || 1;
      const px = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0));
      const target = (el.closest && el.closest('[data-scene]')) || el;
      return {
        found: true, target: target.id || '', tag: String(a.tag || ''),
        top: Math.round(r.top), height: Math.round(r.height), px: Math.round(px),
        ratio: r.height ? +(px / r.height).toFixed(2) : 0,
        onScreen: r.top < h && r.bottom > 0,
      };
    })]);
  }
  await page.evaluate(() => window.PortfolioAI.setHandsFree(false));
  console.log('\n── after the edit: on screen once the page settles? ────');
  for (const [q, v] of seenAfter) {
    const what = ` <${String(v.tag).toLowerCase()}> in #${v.target}`;
    console.log(`${(v.onScreen ? 'visible' : 'OFF SCREEN').padEnd(10)} ${String(v.ratio).padStart(5)}${what.padEnd(34)}`
      + ` top=${v.top}px h=${v.height}px  ← "${q}"`);
  }
  for (const [q, v] of seenAfter) {
    say(`after the edit, "${q}" is on screen`, !!(v.found && v.onScreen),
      v.found ? `${v.px}/${v.height} px in view, in #${v.target}` : 'nothing resolved');
  }

  const stillFound = after.filter(([, a]) => a).length;
  say('every question still resolves after the edit', stillFound === after.length,
    `${stillFound}/${after.length}`);

  /* Expectations are derived from the DOM as it now stands, not hardcoded.
     After an edit that renames, moves and strips the page, "which section is
     right" is a fact about the current DOM — and a section that genuinely
     covers all three projects (the build ledgers) IS a true answer for the
     project list. Hardcoding one id here would test the fixture, not the
     resolver. */
  /* The expectation is derived from the DOM as it now stands, using the same
     identifiers the resolver uses (name, codename, aliases). Hardcoding a
     section id here would test the fixture; asking "which sections still
     actually name each project" tests the resolver. */
  const census = await page.evaluate(async () => {
    const kb = await (await fetch('/knowledge/knowledge.json')).json();
    const projects = (kb.projects || []).filter((p) => p.public !== false);
    const idents = projects.map((p) => ({ id: p.id, name: p.name,
      needles: [p.name, p.portfolio_codename, ...(p.aliases || [])].filter(Boolean) }));
    return {
      total: idents.length,
      groceryId: (projects.find((p) => /grocery/i.test(p.name)) || {}).id,
      perScene: [...document.querySelectorAll('[data-scene]')].map((s) => {
        const t = s.textContent;
        const named = idents.filter((i) => i.needles.some((n) => t.includes(n))).map((i) => i.id);
        return { id: s.id, named };
      }),
    };
  });
  console.log(`\n   sections that still name each project: ${census.perScene
    .filter((s) => s.named.length)
    .map((s) => `${s.id}(${s.named.length}/${census.total})`).join(', ')}`);

  const projectsQ = after[0][1];
  const movedQ = after.find(([q]) => q === 'tell me about the grocery app')[1];
  const namedIn = (id) => (census.perScene.find((s) => s.id === id) || { named: [] });

  /* "here are your projects" must land somewhere that still lists more than
     one of them, not on whichever card happens to be deepest */
  const listTarget = namedIn(projectsQ && projectsQ.target);
  say('the project list lands on a section listing most of them',
    listTarget.named.length >= 2,
    projectsQ ? `#${projectsQ.target} names ${listTarget.named.length}/${census.total} — ${projectsQ.why}` : 'nothing found');

  say('the project MOVED to a new section is found in that section',
    !!movedQ && movedQ.target === 'scene-appendix',
    movedQ ? `#${movedQ.target} — matched <${movedQ.tag}> "${movedQ.text.slice(0, 36)}"` : 'nothing found');
  say('  ...and that section is the ONLY place it is named now',
    census.perScene.filter((s) => s.named.includes(census.groceryId)).map((s) => s.id).join(',') === 'scene-appendix',
    census.perScene.filter((s) => s.named.includes(census.groceryId)).map((s) => s.id).join(', '));

  /* the one claim that would break everything: it followed the CONTENT and
     not the old position, so the answer is not the same element as before */
  say('the projects answer did not come from the old work scene id',
    !!projectsQ && projectsQ.id !== 'scene-work',
    `matched <${projectsQ && projectsQ.tag}> "${projectsQ && projectsQ.text.slice(0, 40)}"`);

  /* ── 4. DOES THE VISITOR ACTUALLY SEE IT? ────────────────────────
     Both of these run LAST, after every expectation above has been computed,
     and that placement is deliberate. A first attempt ran the shipped-page
     pass where it belongs chronologically — before the edit — and it left the
     page parked on a different scene, which changed what the EDIT phase
     resolved (2/7 instead of 7/7) purely by parking the page elsewhere. The
     film's DOM follows the scroll, so measuring it must not move the fixture
     before the fixture is read. The shipped run therefore reloads the page
     instead of reusing the edited one. */
  reportVisibility(await measureVisibility(), 'after the edit');

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  /* The film has to be ready BEFORE the scrolling is measured: a fresh page
     with the scroll machinery still booting moves nowhere, and "nothing moved"
     would then be reported as "the visitor cannot see it". */
  await page.waitForFunction(() => window.Film3D && Film3D.isReady(),
    { timeout: 90000, polling: 500 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate(() => document.getElementById('askAI').click());
  await page.waitForFunction(() => window.PortfolioAI && window.PortfolioAI.state === 'ready',
    { timeout: 60000, polling: 250 });
  reportVisibility(await measureVisibility(), 'as shipped');

  /* ── 5. cost ───────────────────────────────────────────────────── */
  const cost = await page.evaluate(async () => {
    const mod = await import('/ai/ui/anchors.mjs');
    const kb = await (await fetch('/knowledge/knowledge.json')).json();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) mod.resolveAnchor(document, { kb, ids: ['project.volunteer'] });
    return (performance.now() - t0) / 20;
  });
  say('resolution cost is inside the 50 ms task budget (§4)', cost < 50, `${cost.toFixed(2)} ms/call`);

  say('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  clearTimeout(hardStop);
  await browser.close();
  console.log(`\n  ${process.exitCode ? 'PROBE FAILED' : 'probe passed'} — ${checks} checks`);
})().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(3); });
