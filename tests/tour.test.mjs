/* ═══════════════════════════════════════════════════════════════
   tests/tour.test.mjs — §11.1 (c), the guided tour

   The brief's wording: "optional guided tour — walks About → Projects →
   Skills → Contact, scrolling via Lenis to allowlisted anchors (jump
   instead of smooth scroll under reduced-motion), pausing for questions".

   Every one of those clauses is a property that can be wrong in a way no
   browser probe would notice, because the tour "works" in the sense that the
   page moves:

     · the four stops must exist, in that order, and each must be one the PAGE
       declares — a tour built on topics the markup does not carry walks to
       the top of the document four times and calls it a tour;
     · the resolver must pick the SECTION, not the deepest heading that
       repeats the word;
     · it must survive a reorder, like every other anchor in this project;
     · and the shell must stop the walk on a question, on close, and jump
       rather than glide under reduced motion.

   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveTopicAnchor } from '../ai/ui/anchors.mjs';
import { TOUR_STOPS, TOUR_STEP_MS } from '../ai/ui/chat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = readFileSync(join(HERE, '..', 'ai', 'ui', 'chat.mjs'), 'utf8');
const PAGE = readFileSync(join(HERE, '..', 'index.html'), 'utf8');

/* ── a minimal element, enough for collectAnchors ───────────────── */
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

const doc = (kids) => ({ body: el('body', {}, kids) });

/* the shape the real page has: a story section declaring about/skills, a work
   section declaring projects, an end section declaring contact */
function page() {
  const about = el('section', { id: 'scene-story', 'data-ai-topics': 'about education skills' },
    [el('h2', {}, [], 'About')], 'about story');
  const work = el('section', { id: 'scene-work', 'data-ai-topics': 'projects work' },
    [el('h2', {}, [], 'Projects')], 'work projects');
  const end = el('section', { id: 'scene-end', 'data-ai-topics': 'contact reach' },
    [el('h2', {}, [], 'Contact')], 'contact end');
  return { about, work, end, doc: doc([about, work, end]) };
}

/* ── the stops themselves ──────────────────────────────────────── */

test('TOUR-1: four stops, in the order the brief names them', () => {
  assert.deepEqual(TOUR_STOPS.map((s) => s.topic), ['about', 'projects', 'skills', 'contact']);
  for (const stop of TOUR_STOPS) {
    assert.ok(stop.line && stop.line.trim().length > 20, `${stop.topic} has no line to say`);
    assert.doesNotMatch(stop.line, /\bAashish\b.*\bI am Aashish\b/i,
      'the tour must not claim to BE Aashish (§8.4)');
    /* §5: the assistant "speaks about Aashish in the third person and never
       pretends to be him". The narrow check above only catches the explicit
       claim; this one catches the ordinary way it goes wrong — a line about
       HIS education, HIS projects, HIS stack written as "my education", "my
       projects", "the stack I work in". The assistant's `me`/`I` about
       ITSELF is fine ("Ask me anything"), which is why the pattern is keyed to
       the possessive that can only belong to Aashish. */
    assert.doesNotMatch(stop.line,
      /\bmy (name|education|degree|cgpa|marks|college|skills?|projects?|work|experience|stack|certificates?|r[eé]sum[eé]|cv|github)\b/i,
      `${stop.topic}: the tour speaks as Aashish (§5 — third person, always)`);
    assert.doesNotMatch(stop.line, /\bI (am|have|built|work|study|hold|graduated)\b/i,
      `${stop.topic}: the tour speaks as Aashish (§5 — third person, always)`);
  }
  assert.ok(TOUR_STEP_MS >= 3000 && TOUR_STEP_MS <= 15000,
    `${TOUR_STEP_MS} ms is either too fast to read a section or too slow to sit through`);
});

test('TOUR-1: every stop is a topic the page actually declares', () => {
  /* This is the check that stops the tour from being built against a topic
     the markup dropped: with no declaring section the resolver returns null,
     the stop is skipped, and four skips look exactly like a tour that moved
     nothing. */
  const declared = new Set();
  for (const m of PAGE.matchAll(/data-ai-topics="([^"]+)"/g)) {
    for (const t of m[1].split(/[\s,]+/)) if (t) declared.add(t.trim());
  }
  assert.ok(declared.size >= 4, 'index.html declares too few topics to tour');
  for (const stop of TOUR_STOPS) {
    assert.ok(declared.has(stop.topic),
      `the tour walks to "${stop.topic}", which no section of index.html declares`);
  }
});

/* ── the resolver ──────────────────────────────────────────────── */

test('TOUR-1: a topic resolves to the section that declares it', () => {
  const { doc: d, about, work, end } = page();
  assert.equal(resolveTopicAnchor(d, 'about').el, about);
  assert.equal(resolveTopicAnchor(d, 'projects').el, work);
  assert.equal(resolveTopicAnchor(d, 'skills').el, about, 'story declares skills too; the section wins');
  assert.equal(resolveTopicAnchor(d, 'contact').el, end);
});

test('TOUR-1: it picks the SECTION, not the deepest element repeating the word', () => {
  const inner = el('div', { 'data-ai-topics': 'projects' }, [], 'projects');
  const section = el('section', { id: 'scene-work', 'data-ai-topics': 'projects' }, [inner], 'work');
  const found = resolveTopicAnchor(doc([section]), 'projects');
  assert.equal(found.el, section, 'the tour must walk to the section, not to a card inside it');
});

test('TOUR-1: it survives the page being reordered', () => {
  const first = page();
  assert.equal(resolveTopicAnchor(first.doc, 'contact').el.id, 'scene-end');
  const shuffled = page();
  shuffled.doc = doc([shuffled.end, shuffled.about, shuffled.work]);
  assert.equal(resolveTopicAnchor(shuffled.doc, 'contact').el.id, 'scene-end',
    'reordering the page must not move the tour somewhere else');
  assert.equal(resolveTopicAnchor(shuffled.doc, 'about').el.id, 'scene-story');
});

test('TOUR-1: an undeclared topic resolves to nothing, not to the top', () => {
  const { doc: d } = page();
  assert.equal(resolveTopicAnchor(d, 'pricing'), null);
  assert.equal(resolveTopicAnchor(d, ''), null);
  assert.equal(resolveTopicAnchor(d, null), null);
  assert.equal(resolveTopicAnchor(null, 'about'), null);
  /* the panel is ignored like every other anchor source (§12) */
  const panel = el('div', { 'data-ai-ignore': '', 'data-ai-topics': 'about' }, [], 'about');
  assert.equal(resolveTopicAnchor(doc([panel]), 'about'), null);
});

/* ── the shell's wiring ────────────────────────────────────────── */

test('TOUR-1: the shell stops the walk on a question, and on close', () => {
  assert.match(CHAT, /function ask\(text, opts\) \{\n[\s\S]{0,240}?stopTour\(\);/,
    'a question must stop the tour rather than race it');
  assert.match(CHAT, /state = 'closed';\n[\s\S]{0,300}?stopTour\(\);/,
    'a tour must not outlive the panel');
  assert.match(CHAT, /function stopTour\(\{ announce = false \} = \{\}\) \{/,
    'stopTour has no silent mode — a question would announce a stop nobody asked about');
  assert.match(CHAT, /cancelTourTimer\(\)/, 'the tour timer is never cancelled: it would leak a closure');
});

test('TOUR-1: reduced motion jumps instead of gliding', () => {
  assert.match(CHAT, /prefers-reduced-motion: reduce/,
    'the shell never asks whether the visitor asked for less motion');
  assert.match(CHAT, /showAnchor\(anchor, \{ jump: reducedMotion\(\) \}\)/,
    'the tour does not pass the jump flag to the move');
  assert.match(CHAT, /scrollToAnchor: \(scene, anchor, \{ jump \} = \{\}\)/,
    'the default hook ignores the jump flag');
  const director = readFileSync(join(HERE, '..', 'js', 'director.js'), 'utf8');
  assert.match(director, /const scrollTo = \(target, opts = \{\}\) => \{/,
    'Director.scrollTo cannot be asked to move without animating');
  assert.match(director, /duration: immediate \? 0 : 1\.6/,
    'the chapter dots must keep their 1.6 s glide while the tour jumps');
});

test('TOUR-1: the offer is a chip, and only Proactive offers it', () => {
  assert.match(CHAT, /st\.mode === 'continuous'\) \{\n\s+ctl\.greet\(\);\n\s+offerTour\(\);/,
    'the tour and the greeting belong to Proactive, not to a press');
  assert.match(CHAT, /'ai__chip ai__chip--tour'/,
    'the offer is not a chip — a panel that starts scrolling itself is not an offer');
  assert.match(CHAT, /if \(tourIndex >= 0\) stopTour\(\{ announce: true \}\); else startTour\(\);/,
    'the chip must toggle rather than stack a second tour on the first');
});
