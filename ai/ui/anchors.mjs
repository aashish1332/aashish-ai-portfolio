/* ═══════════════════════════════════════════════════════════════
   ai/ui/anchors.mjs — "show me where that is", resolved by CONTENT

   The answer already knows which facts it spoke from (`sources`). This
   module turns those fact ids into a *live DOM element* so the page can
   move to it while the answer is spoken.

   The requirement that shapes the whole design: **it must keep working
   after the page is edited.** If the work section is reordered, the
   projects moved into a different scene, or the whole section renamed,
   the anchor for "my projects" must still point at the projects — not at
   whatever now sits at the old offset.

   So nothing here stores a scroll position, an element index, or a
   hardcoded section id. Resolution is recomputed from the live DOM every
   time the question is asked, and it matches on *the fact's own words*:

     1. `data-ai-topics` — a section may *declare* which topics it covers.
        Matching this is the strongest signal, and the declaration moves
        with the markup when the section moves.
     2. **Content match** — the element whose own text contains a salient
        string from the fact (a project name, a codename, an institution,
        a certificate). This is what survives a reorder, because the
        section carries its content with it.
     3. Specificity — of the elements that match, prefer the *smallest*
        (deepest) one. `body` contains every project name, so it would
        otherwise score perfectly on every question.

   A miss returns `null`. That is deliberate: scrolling a recruiter to a
   confidently wrong section is worse than not moving at all, so there is
   a threshold and no "closest guess" fallback.

   Pure and DOM-injected — it takes a document, so `node --test` drives a
   fake one and the browser drives the real one, unchanged.
   ═══════════════════════════════════════════════════════════════ */

/* Tags whose text is not page content. `canvas` matters here: the film's
   canvas is aria-hidden and huge, but `<script>` text would be the real
   pollution — every project name appears inside the inline bundle. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CANVAS', 'SVG', 'HEAD']);

/* Containers that always "match" everything and must never be a target. */
const ROOT_TAGS = new Set(['BODY', 'HTML', 'MAIN']);

/** Shortest salient string we will match on. Below this the term is noise
 *  ("AI", "C++", "SQL") and matches the wrong place — sometimes everywhere. */
export const MIN_TERM_LENGTH = 4;

/** Below this a match is a coincidence, so we return null instead. */
export const MIN_ANCHOR_SCORE = 1.0;

/** Bound the walk so a pathological page can't turn a question into a stall. */
const MAX_ANCHORS = 800;

/* ── text helpers ──────────────────────────────────────────────── */

/** Lower-case, collapse whitespace, drop the punctuation that varies between
 *  the knowledge base and the markup ("Node.js" vs "Node js"). */
export function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}+#.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `haystack` contains `needle` at a word boundary-ish edge.
 *  Plain `includes` matched "react" inside "reactive"; requiring a boundary
 *  keeps a term from being found in the middle of an unrelated word. */
export function containsTerm(haystack, needle) {
  if (!needle) return false;
  const i = haystack.indexOf(needle);
  if (i === -1) return false;
  const before = i === 0 ? ' ' : haystack[i - 1];
  const after = i + needle.length >= haystack.length ? ' ' : haystack[i + needle.length];
  const isWord = (c) => /[\p{L}\p{N}]/u.test(c);
  return !isWord(before) && !isWord(after);
}

/* ── collecting candidates ─────────────────────────────────────── */

/**
 * Walk a document and describe every element that could be a target.
 * Depth is recorded because it is the only specificity signal available
 * without measuring layout, which we must not do (that forces a reflow
 * inside an answer).
 *
 * @param {object} doc  a Document (or a test double with the same shape)
 * @returns {Array<{el:object, tag:string, id:string, topics:string[], text:string,
 *                  norm:string, depth:number}>}
 */
export function collectAnchors(doc) {
  const out = [];
  const root = doc?.body || doc?.documentElement;
  if (!root) return out;

  const visit = (el, depth) => {
    if (!el || out.length >= MAX_ANCHORS) return;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag && SKIP_TAGS.has(tag)) return;
    /* An explicit opt-out, and the reason it exists: the assistant's own panel
       contains the answer text, so it repeats the very words being searched
       for. Without this the chat found its own "SHOW ME · Smart Grocery List
       Generator" button and called that the grocery project. Measured on the
       real page (dev-anchor-probe.js), not imagined. */
    if (el.getAttribute?.('data-ai-ignore') !== null
        && el.getAttribute?.('data-ai-ignore') !== undefined) return;

    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && tag && !ROOT_TAGS.has(tag)) {
      const topics = String(el.getAttribute?.('data-ai-topics') || '')
        .split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
      out.push({
        el, tag, depth,
        id: el.id || el.getAttribute?.('id') || '',
        scene: el.getAttribute?.('data-scene') || '',
        topics,
        text,
        norm: normText(text),
      });
    }

    const kids = el.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) visit(kids[i], depth + 1);
  };

  visit(root, 0);
  return out;
}

/* ── what identifies a fact's *place* on the page ──────────────── */

/** Topic keywords a section can declare about itself, per fact kind. Used
 *  only against `data-ai-topics` — never against a section id, so renaming
 *  `#scene-work` to anything else does not break it. */
const KIND_TOPICS = {
  project: ['projects', 'project', 'work'],
  education: ['education', 'story', 'profile'],
  certification: ['certifications', 'credentials', 'education', 'story'],
  achievement: ['achievements', 'highlights', 'story', 'credits'],
  skill: ['skills', 'skillset', 'story'],
  experience: ['experience', 'story'],
  workflow: ['workflow', 'ai', 'codir', 'story'],
  contact: ['contact', 'reach'],
  link: ['contact', 'links', 'reach'],
  person: ['profile', 'story'],
};

/** Which collections in knowledge.json a fact id came from. */
function kindOf(id) {
  const s = String(id || '');
  if (s.startsWith('project.')) return 'project';
  if (s.startsWith('edu.')) return 'education';
  if (s.startsWith('cert.')) return 'certification';
  if (s.startsWith('ach.')) return 'achievement';
  if (s.startsWith('skill.')) return 'skill';
  if (s.startsWith('exp.')) return 'experience';
  if (s.startsWith('link.')) return 'link';
  if (s.startsWith('contact.')) return 'contact';
  if (s.startsWith('workflow.')) return 'workflow';
  if (s.startsWith('person.')) return 'person';
  return null;
}

/**
 * The strings that identify where a set of facts lives, taken from the
 * knowledge base so they track the data rather than the markup.
 *
 * `groups` is one entry per asked-about FACT. Scoring needs that split: a
 * section holding two of three projects must beat a card holding one, and a
 * flat term bag cannot express it — the card's four hits on its own project
 * would tie with the section's hits across two.
 *
 * @returns {{terms:string[], groups:{id:string,kind:string,terms:string[]}[],
 *            topics:string[], kind:string|null}}
 */
export function salientTerms(kb, ids = []) {
  const terms = new Set();
  const topics = new Set();
  const groups = [];
  let kind = null;

  const addWords = (...vals) => {
    for (const v of vals) {
      for (const part of String(v || '').split(/[·—–,/|()]/)) {
        const t = normText(part);
        if (t.length >= MIN_TERM_LENGTH) terms.add(t);
      }
    }
  };
  const addWhole = (...vals) => {
    for (const v of vals) {
      const t = normText(v);
      if (t.length >= MIN_TERM_LENGTH) terms.add(t);
    }
  };

  const projects = [...(kb?.projects || [])];
  const education = [...(kb?.education || [])];
  const certs = [...(kb?.certifications || [])];
  const skills = [...(kb?.skills || [])];
  const experience = [...(kb?.experience || [])];
  const achievements = [...(kb?.achievements || [])];

  for (const id of ids) {
    const k = kindOf(id);
    if (!k) continue;
    kind = kind || k;
    for (const t of KIND_TOPICS[k] || []) topics.add(t);

    const before = new Set(terms);
    if (k === 'project') {
      const p = projects.find((x) => x.id === id);
      if (p) addWhole(p.name, p.portfolio_codename, ...(p.aliases || []));
    } else if (k === 'education') {
      const e = education.find((x) => x.id === id);
      if (e) { addWhole(e.institution, ...(e.aliases || [])); addWords(e.degree); }
    } else if (k === 'certification') {
      const c = certs.find((x) => x.id === id);
      if (c) { addWhole(c.name, ...(c.aliases || [])); addWords(c.issuer); }
    } else if (k === 'skill') {
      const s = skills.find((x) => x.id === id);
      if (s) { addWhole(s.name, ...(s.aliases || [])); }
    } else if (k === 'experience') {
      const e = experience.find((x) => x.id === id);
      if (e) { addWhole(e.title, ...(e.aliases || [])); }
    } else if (k === 'achievement') {
      const a = achievements.find((x) => x.id === id);
      if (a) { addWhole(...(a.aliases || [])); addWords(a.text); }
    }
    const own = [...terms].filter((t) => !before.has(t));
    if (own.length) groups.push({ id, kind: k, terms: own });
  }

  return { terms: [...terms], groups, topics: [...topics], kind };
}

/* ── scoring ───────────────────────────────────────────────────── */

/** Inline tags are fragments of a sentence, not a place to stand. A `<span>`
 *  holding a project name is deep, so on depth alone it beat the card the
 *  name belongs to — measured on the real page, not imagined. The penalty
 *  only applies to inline tags with no id: `<span id="...">` is somebody's
 *  deliberate hook and is treated as a place. */
const INLINE_TAGS = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'A', 'CODE', 'TIME']);
const INLINE_PENALTY = 0.5;

/** Specificity: deeper is better, and a very long `text` is penalised
 *  because it is the signature of a container that merely wraps the
 *  answer. Without this, `<main>` beat `<article id="take-2">` for a
 *  project question — it contains the name too. */
function specificity(anchor) {
  const depth = Math.min(anchor.depth, 12) * 0.25;
  const lengthPenalty = Math.max(0, anchor.text.length - 400) / 4000;
  const inline = (INLINE_TAGS.has(anchor.tag) && !anchor.id) ? INLINE_PENALTY : 0;
  return depth - lengthPenalty - inline;
}

/** A declared topic is an *assertion by the markup*, so it can win on its
 *  own; a content hit is evidence and needs to be a bit stronger. */
const DECLARED_TOPIC_SCORE = 2.0;

/**
 * Find the element the answer should move the page to.
 *
 * @param {object} doc
 * @param {{kb?:object, ids?:string[], text?:string}} req  `ids` are the
 *        answer's `sources` — the facts it actually spoke from
 * @returns {{el:object, score:number, why:string, tag:string, id:string,
 *            topics:string[]} | null}
 */
export function resolveAnchor(doc, req = {}) {
  const anchors = collectAnchors(doc);
  if (!anchors.length) return null;

  const { terms, groups, topics, kind } = salientTerms(req.kb, req.ids || []);
  /* nothing identifying to look for: refuse rather than pick the first
     element, which would be an arbitrary scroll dressed up as an answer */
  if (!terms.length && !topics.length) return null;

  let best = null;
  for (const a of anchors) {
    let score = 0;
    const reasons = [];

    if (a.topics.length && topics.some((t) => a.topics.includes(t))) {
      score += DECLARED_TOPIC_SCORE;
      reasons.push(`declares data-ai-topics=${a.topics.join('/')}`);
    }

    /* Count FACTS covered, not words matched: a card holding one project in
       full must not outrank the section holding two of the three projects the
       question was actually about. */
    let groupsMatched = 0;
    for (const g of groups) {
      if (g.terms.some((t) => containsTerm(a.norm, t))) groupsMatched++;
    }
    let hits = 0;
    for (const term of terms) {
      if (containsTerm(a.norm, term)) hits++;
    }
    if (groupsMatched || hits) {
      score += Math.min(groupsMatched, 6) * 0.9 + Math.min(hits, 6) * 0.15;
      reasons.push(groups.length
        ? `${groupsMatched}/${groups.length} of the asked-about facts, ${hits} string(s)`
        : `${hits} of ${terms.length} identifying string(s)`);
    }

    if (!score) continue;
    score += specificity(a);
    if (!best || score > best.score) {
      best = { anchor: a, score, why: reasons.join('; ') };
    }
  }

  if (!best || best.score < MIN_ANCHOR_SCORE) return null;
  const a = best.anchor;
  return {
    el: a.el, score: +best.score.toFixed(3), why: best.why,
    tag: a.tag, id: a.id, topics: a.topics,
    /* `kind` is reported so a caller can log which family resolved; it is
       never used to *choose* the element, which is the whole point. */
    kind,
  };
}

/** A short human label for an anchor, for the "SHOW ME" control and logs. */
export function anchorLabel(anchor) {
  if (!anchor) return '';
  const scene = String(anchor.el?.getAttribute?.('data-scene') || '').trim();
  const heading = anchor.el?.querySelector?.('h1,h2,h3,h4,.scene__title,.take__title');
  const text = heading ? heading.textContent : anchor.el?.textContent;
  const first = String(text || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  return scene ? `SCENE ${scene.toUpperCase()}` : (first || anchor.tag);
}
