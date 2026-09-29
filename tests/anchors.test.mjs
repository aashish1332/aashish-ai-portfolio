/* ═══════════════════════════════════════════════════════════════
   tests/anchors.test.mjs — "show me where that is" (§12)

   The question this file exists to answer is not "does it find the work
   section today" — it is **does it still find it after someone edits the
   page.** Reordering the scenes, moving the projects into a different
   scene, renaming a section: each of those is a case below, and each one
   must resolve to the same *content* it resolved to before.

   So the trees here are built twice, deliberately differently, and the
   assertions compare what was FOUND, not how it was found. A stored offset
   or a section index would pass the first half of every test in this file
   and fail the second — which is exactly the bug being prevented.

   The DOM is a ~30-line double rather than jsdom: this repo has no test
   dependencies, and the resolver only needs `tagName`, `children`,
   `textContent`, `getAttribute` and `parentElement`.

   Frozen regressions:
     AN-1 a container (`<main>`, `<body>`) matched every question, because
          containing a project name is not evidence of BEING the project.
     AN-2 "react" matched inside "reactive" — substring search with no word
          boundary scrolled to an unrelated section.
   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  collectAnchors, resolveAnchor, salientTerms, anchorLabel,
  containsTerm, normText, MIN_ANCHOR_SCORE,
} from '../ai/ui/anchors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KB = JSON.parse(readFileSync(join(HERE, '..', 'knowledge', 'knowledge.json'), 'utf8'));

/* ── a minimal element ──────────────────────────────────────────── */
function el(tag, attrs = {}, kids = [], own = '') {
  const node = {
    tagName: String(tag).toUpperCase(),
    attrs: { ...attrs },
    children: kids,
    _own: own,
    _parent: null,
    get id() { return this.attrs.id || ''; },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = v; },
    get parentElement() { return this._parent; },
    classList: { add() {}, remove() {} },
    querySelector() { return null; },
  };
  for (const k of kids) k._parent = node;
  Object.defineProperty(node, 'textContent', {
    get() {
      return [this._own, ...this.children.map((c) => c.textContent)]
        .filter(Boolean).join(' ');
    },
  });
  return node;
}

/** A document double. `body` is what the resolver walks from. */
const docOf = (body) => ({ body, documentElement: body });

/* ── the page, built two ways ───────────────────────────────────── */

/** Every project title in the base — used so the fixtures track the data
 *  rather than a hardcoded name that a rename would silently invalidate. */
const PROJECTS = (KB.projects || []).filter((p) => p.public !== false);
const P1 = PROJECTS[0];
const P2 = PROJECTS[1] || PROJECTS[0];

/** The projects scene as the site actually ships it: each project is its own
 *  article, and the section declares its topics. */
function projectArticle(p) {
  return el('article', { id: `take-${p.id}`, 'data-take': '1' }, [
    el('h3', {}, [], p.name),
    el('ul', {}, [], (p.tech || []).join(' ')),
    el('div', {}, [], p.portfolio_codename || ''),
  ]);
}

function pageInOrder() {
  return docOf(el('body', {}, [
    el('main', { id: 'film' }, [
      el('section', { id: 'scene-hero', 'data-scene': 'hero', 'data-ai-topics': 'profile intro' },
        [], 'AASHISH KUMAR PORTFOLIO'),
      el('section', { id: 'scene-story', 'data-scene': 'story', 'data-ai-topics': 'story about education skills' },
        [], 'CGPA 8.28 MERN BOOTCAMP INFOSYS'),
      el('section', { id: 'scene-work', 'data-scene': 'work', 'data-ai-topics': 'projects project work' },
        PROJECTS.map(projectArticle)),
      el('section', { id: 'scene-end', 'data-scene': 'end', 'data-ai-topics': 'contact reach links' },
        [], 'EMAIL REACH ME'),
    ]),
  ]));
}

/** The same page after an edit: the projects are LAST, the section id and its
 *  scene name are both different, and an unrelated scene was inserted first.
 *  Nothing about the *content* changed. */
function pageRearranged() {
  return docOf(el('body', {}, [
    el('main', { id: 'film' }, [
      el('section', { id: 'scene-story', 'data-scene': 'story', 'data-ai-topics': 'story about education skills' },
        [], 'CGPA 8.28 MERN BOOTCAMP INFOSYS'),
      el('section', { id: 'scene-links', 'data-scene': 'links', 'data-ai-topics': 'contact reach links' },
        [], 'EMAIL REACH ME'),
      el('section', { id: 'scene-portfolio', 'data-scene': 'portfolio', 'data-ai-topics': 'projects project work' },
        PROJECTS.map(projectArticle)),
    ]),
  ]));
}

const sceneOf = (node) => {
  let n = node;
  while (n) {
    if (n.getAttribute?.('data-scene')) return n.getAttribute('data-scene');
    n = n.parentElement;
  }
  return null;
};

const articleNamed = (doc, name) =>
  collectAnchors(doc).find((a) => a.tag === 'ARTICLE' && a.text.includes(name));

/* ── the resolver finds the content ─────────────────────────────── */

test('a project question resolves to that project, not to the page', () => {
  const doc = pageInOrder();
  const found = resolveAnchor(doc, { kb: KB, ids: [P1.id] });
  assert.ok(found, 'no anchor for a project that is plainly on the page');
  assert.ok(found.el.textContent.includes(P1.name),
    `resolved to the wrong element: ${found.el.tagName} "${found.el.textContent.slice(0, 60)}"`);
  assert.notEqual(found.tag, 'MAIN', 'AN-1: the container matched again');
  assert.notEqual(found.tag, 'BODY', 'AN-1: the whole page matched');
  assert.equal(sceneOf(found.el), 'work');
});

test('reordering the sections changes nothing about what is found', () => {
  const ids = [P1.id];
  const before = resolveAnchor(pageInOrder(), { kb: KB, ids });
  const after = resolveAnchor(pageRearranged(), { kb: KB, ids });
  assert.ok(before && after);
  /* the *content* is the same element in both trees... */
  assert.ok(before.el.textContent.includes(P1.name));
  assert.ok(after.el.textContent.includes(P1.name));
  /* ...and the scene it lives in is allowed to differ, because it moved */
  assert.equal(sceneOf(before.el), 'work');
  assert.equal(sceneOf(after.el), 'portfolio',
    'the projects moved to another scene and the anchor did not follow them');
});

test('a project moved into a DIFFERENT scene is found in its new scene', () => {
  /* project 2 is pulled out of the work scene and parked in the story scene */
  const moved = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 'scene-story', 'data-scene': 'story' }, [
        el('p', {}, [], 'CGPA 8.28'),
        projectArticle(P2),
      ]),
      el('section', { id: 'scene-work', 'data-scene': 'work' }, [
        projectArticle(P1),
      ]),
    ]),
  ]));
  const found = resolveAnchor(moved, { kb: KB, ids: [P2.id] });
  assert.ok(found, 'the moved project was not found at all');
  assert.equal(sceneOf(found.el), 'story',
    'the anchor still points at the old scene — it is following position, not content');
});

test('renaming every section id and scene name changes nothing', () => {
  const renamed = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 'zzz-1', 'data-scene': 'zzz' }, [], 'CGPA 8.28'),
      el('section', { id: 'zzz-2', 'data-scene': 'yyy' }, PROJECTS.map(projectArticle)),
    ]),
  ]));
  const found = resolveAnchor(renamed, { kb: KB, ids: [P1.id] });
  assert.ok(found, 'renaming the sections lost the project');
  assert.equal(sceneOf(found.el), 'yyy');
  /* the renamed page declares no topics, so a content match is the ONLY way
     it could have been found */
  assert.ok(!/data-ai-topics/.test(found.why),
    `resolved via a declaration that no longer exists: ${found.why}`);
  assert.match(found.why, /asked-about facts|identifying string/);
});

test('a miss returns null — the page is not moved somewhere confidently wrong', () => {
  /* no declared topics anywhere, and none of this page's text is about the
     fact that was asked about */
  const doc = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 's1' }, [], 'unrelated prose about cameras and lighting'),
      el('section', { id: 's2' }, [], 'a second section with nothing to do with it'),
    ]),
  ]));
  assert.ok(salientTerms(KB, [P1.id]).terms.length, 'fixture problem: no terms to search for');
  assert.equal(resolveAnchor(doc, { kb: KB, ids: [P1.id] }), null,
    'a fact that is not on the page resolved to something — a guess, not an answer');
  assert.equal(resolveAnchor(doc, { kb: KB, ids: [P1.id, P2.id] }), null);
});

test('the assistant\u2019s own panel is never a target', () => {
  /* measured on the real page: the chat panel repeats the answer, so a
     "show me where the grocery project is" lookup found its own button */
  const doc = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 'work', 'data-scene': 'work' }, [projectArticle(P1)]),
    ]),
    el('div', { class: 'ai', 'data-ai-ignore': '' }, [
      el('button', {}, [], `SHOW ME · ${P1.name}`),
      el('p', {}, [], `I've shipped ${PROJECTS.length} projects:`),
    ]),
  ]));
  const found = resolveAnchor(doc, { kb: KB, ids: PROJECTS.map((p) => p.id) });
  assert.ok(found, 'the panel was excluded and nothing else was found');
  assert.equal(sceneOf(found.el), 'work',
    `the panel was chosen: <${found.tag.toLowerCase()}> "${found.el.textContent.slice(0, 40)}"`);
  assert.ok(!/data-ai-ignore/.test(String(found.el.getAttribute?.('data-ai-ignore')))
    && found.el !== doc.body, 'the excluded subtree was returned anyway');
});

test('a section covering more of the asked-about facts beats one card', () => {
  /* 3 projects asked about: 2 in the section, 1 moved into a card elsewhere.
     The card matches its own project's words many times; the section answers
     more of the question, so it must win. */
  const moved = PROJECTS[PROJECTS.length - 1];
  const rest = PROJECTS.slice(0, -1);
  const doc = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 'somewhere', 'data-scene': 'somewhere' }, [projectArticle(moved)]),
      el('section', { id: 'work', 'data-scene': 'work' }, rest.map(projectArticle)),
    ]),
  ]));
  const found = resolveAnchor(doc, { kb: KB, ids: PROJECTS.map((p) => p.id) });
  assert.ok(found);
  assert.equal(sceneOf(found.el), 'work',
    `one moved project outranked the section holding the other ${rest.length}`);
  assert.match(found.why, /asked-about facts/);
});

test('AN-1: a page-level container is never the target, even when it holds the words', () => {
  /* the name appears ONLY in <main>'s own text — no child of it carries the
     match, so there is no section to point at. Returning `main` would scroll
     to the top of the film and call that "where your projects are". */
  const doc = docOf(el('body', {}, [
    el('main', { id: 'film' }, [], `Everything about ${P1.name} lives in this one blob`),
  ]));
  assert.equal(resolveAnchor(doc, { kb: KB, ids: [P1.id] }), null,
    'AN-1: a page-level container matched again');
});

test('nothing identifying to search for refuses instead of picking the first element', () => {
  const doc = pageInOrder();
  assert.equal(resolveAnchor(doc, { kb: KB, ids: [] }), null);
  assert.equal(resolveAnchor(doc, {}), null);
  assert.equal(resolveAnchor(doc, { kb: KB, ids: ['not.a.real.id'] }), null);
});

test('an empty document is a refusal, not a crash', () => {
  assert.equal(resolveAnchor(docOf(el('body')), { kb: KB, ids: [P1.id] }), null);
  assert.equal(resolveAnchor({}, { kb: KB, ids: [P1.id] }), null);
  assert.deepEqual(collectAnchors({}), []);
});

/* ── the two mechanisms ─────────────────────────────────────────── */

test('a declared topic is honoured even when the content is not in the base', () => {
  /* the markup SAYS what it covers; between renames and rewrites this is the
     signal that keeps working when the text has drifted from knowledge.json */
  const doc = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 's1', 'data-ai-topics': 'contact reach' }, [], 'nothing about Aashish here'),
    ]),
  ]));
  const found = resolveAnchor(doc, {
    kb: KB, ids: [(KB.contact?.email?.id) || 'contact.email'],
  });
  assert.ok(found, 'the declared topic was ignored');
  assert.equal(found.id, 's1');
  assert.match(found.why, /data-ai-topics/);
});

test('a project named in a section is not found inside an unrelated word', () => {
  /* AN-2: substring matching has to respect word boundaries */
  assert.equal(containsTerm(normText('reactive systems'), 'react'), false);
  assert.equal(containsTerm(normText('react 19 and vite'), 'react'), true);
  assert.equal(containsTerm(normText('nodejs'), 'node'), false,
    'a prefix that runs into a letter is not a word match');

  const doc = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 'a', 'data-scene': 'a' }, [], 'reactive systems and mongodbless designs'),
      el('section', { id: 'b', 'data-scene': 'b' }, [projectArticle(P1)]),
    ]),
  ]));
  const found = resolveAnchor(doc, { kb: KB, ids: [P1.id] });
  assert.equal(sceneOf(found.el), 'b');
});

test('a real container beats an inline fragment holding the same words', () => {
  /* measured on the real page: a bare <span> deep inside a section outscored
     the project card the name belonged to, because depth was the only signal */
  const doc = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 'a', 'data-scene': 'a' }, [
        el('p', {}, [el('span', {}, [], P1.name)]),
      ]),
      el('section', { id: 'b', 'data-scene': 'b' }, [projectArticle(P1)]),
    ]),
  ]));
  const found = resolveAnchor(doc, { kb: KB, ids: [P1.id] });
  assert.equal(sceneOf(found.el), 'b',
    `an inline fragment in the wrong section was chosen: <${found.tag.toLowerCase()}>`);
  assert.ok(!['SPAN', 'B', 'I', 'EM', 'STRONG', 'A'].includes(found.tag),
    `an inline fragment was chosen over the card: <${found.tag.toLowerCase()}>`);
});

test('an element with an id is a deliberate hook, inline tag and all', () => {
  const doc = docOf(el('body', {}, [
    el('main', {}, [
      el('section', { id: 'a', 'data-scene': 'a' }, [
        el('span', { id: 'project-label' }, [], P1.name),
      ]),
      el('section', { id: 'b', 'data-scene': 'b' }, [], 'nothing to do with it'),
    ]),
  ]));
  const found = resolveAnchor(doc, { kb: KB, ids: [P1.id] });
  assert.equal(found.id, 'project-label');
  assert.equal(sceneOf(found.el), 'a');
});

test('the closer of two containing elements wins', () => {
  const doc = pageInOrder();
  const found = resolveAnchor(doc, { kb: KB, ids: [P1.id] });
  const section = found.el.parentElement;
  assert.ok(section.textContent.length >= found.el.textContent.length,
    'the resolved element is wider than its own parent — specificity is inverted');
  assert.ok(found.score >= MIN_ANCHOR_SCORE);
});

test('salient terms come from the knowledge base, so a rename tracks the data', () => {
  const { terms, topics, kind } = salientTerms(KB, [P1.id]);
  assert.equal(kind, 'project');
  assert.ok(topics.includes('projects'));
  assert.ok(terms.some((t) => normText(P1.name) === t),
    'the project name is not among the strings used to find it');
  assert.ok(terms.every((t) => t.length >= 4),
    'a term shorter than the floor slipped through — it will match the wrong section');
});

test('every fact family in the base yields something to search for', () => {
  /* Derived from the base rather than listed by hand. The list this replaces
     named six families — education, certifications, skills, achievements,
     experience, links — and skipped `projects`, `contact` and `workflow`
     without saying so, which made this test's name wider than what it looked
     at. All three produce terms today, so nothing was failing; the point is
     that a family added tomorrow would have been invisible to a claim that
     says "every". 57 ids, against the 51 the hand-written list reached. */
  const families = Object.entries(KB).flatMap(([, v]) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      return Object.values(v).filter((f) => f && typeof f === 'object');
    }
    return [];
  });
  const sample = families.filter((f) => f.id && f.public !== false).map((f) => f.id);
  assert.ok(sample.length > 40, `fixture problem: only ${sample.length} facts to check`);
  const empty = sample.filter((id) => {
    const s = salientTerms(KB, [id]);
    return !s.terms.length && !s.topics.length;
  });
  assert.deepEqual(empty, [],
    `these fact ids produce nothing to search for on the page: ${empty.join(', ')}`);
});

test('a label for the control is short and never undefined', () => {
  const found = resolveAnchor(pageInOrder(), { kb: KB, ids: [P1.id] });
  const label = anchorLabel(found);
  assert.ok(label.length > 0 && label.length <= 60, `bad label: ${JSON.stringify(label)}`);
  assert.ok(!/undefined|\[object/i.test(label), `label leaked internals: ${label}`);
  assert.equal(anchorLabel(null), '');
});
