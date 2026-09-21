/* ═══════════════════════════════════════════════════════════════
   dev-anchor-probe.js — "show me where that is", measured in a real page

   The unit tests drive a fake DOM. This drives the actual portfolio: it
   asks real questions, records which element each one resolved to, then
   EDITS THE LIVE PAGE — reordering the scenes and moving a project into a
   different scene — and asks the same questions again.

   That second half is the whole point. A resolver that cached an offset or
   an index would pass the first half and fail the second.

   Run:  node dev-anchor-probe.js     (needs: npm run dev)
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:5577/';

const say = (label, ok, detail) => {
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

(async () => {
  const hardStop = setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); }, 300000);
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
      const r = await page.evaluate((question) => {
        window.PortfolioAI.ask(question);
        return window.PortfolioAI.lastAnchor;
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
  await page.evaluate(() => {
    window.PortfolioAI.setHandsFree(true);
    window.PortfolioAI.ask('what projects have you built');
  });
  await new Promise((r) => setTimeout(r, 2600));
  const y1 = await page.evaluate(() => window.scrollY);
  say('hands-free mode moved the page by itself', y1 > y0 + 50, `scrollY ${y0} → ${Math.round(y1)}`);

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

  /* ── 4. cost ───────────────────────────────────────────────────── */
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
})().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(3); });
