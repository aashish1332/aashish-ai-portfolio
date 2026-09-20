/* ═══════════════════════════════════════════════════════════════
   ai/knowledge/view.mjs — the §1 public gate on knowledge.json

   Everything shipped to a browser is public to every visitor, so a fact
   marked `public:false` must not merely be "filtered at render time" — the
   engines should not be able to reach it at all.

   Before this existed, a private contact field was dropped by the fact
   index but was still *chunked* into the BM25 index, so its value sat in
   the same in-memory structure the answers are built from. One refactor
   away from being printed. Now the answers path builds both the facts and
   the index from this view, and `tests/quick-answers.test.mjs` (QA-9)
   proves a private value cannot appear in any answer, in any language.

   Build-time note: the *shipped* knowledge.json must also be reduced to
   this view (§9.3/§17 data hygiene, the P2 dev/prod step) so the private
   value never leaves the repository either.
   ═══════════════════════════════════════════════════════════════ */

const keep = (f) => !!f && f.public !== false;

/**
 * A copy of the knowledge base with every `public:false` fact removed.
 * Structure-preserving: collections stay arrays, `contact` stays keyed.
 */
export function publicView(kb) {
  if (!kb) return kb;
  const of = (list) => (list || []).filter(keep).map((f) => ({ ...f }));

  return {
    ...kb,
    person: keep(kb.person) ? { ...kb.person } : null,
    contact: Object.fromEntries(
      Object.entries(kb.contact || {}).filter(([, f]) => keep(f)).map(([k, f]) => [k, { ...f }]),
    ),
    links: of(kb.links),
    education: of(kb.education),
    skills: of(kb.skills),
    /* nested links carry their own flag (§8.1) */
    projects: of(kb.projects).map((p) => ({ ...p, links: of(p.links) })),
    experience: of(kb.experience),
    certifications: of(kb.certifications),
    achievements: of(kb.achievements),
    workflow: keep(kb.workflow) ? { ...kb.workflow } : null,
  };
}

/** The ids and alias spellings of facts this view has removed — metadata only,
 *  never a value. Used to answer a question aimed at a private field with an
 *  honest decline instead of silence. */
export function withheldContactFields(kb) {
  return Object.values(kb?.contact || {})
    .filter((f) => f && f.public === false)
    .map((f) => ({ id: f.id, aliases: f.aliases || [] }));
}

/* one view per knowledge base — the object identity keeps the costly index
   cache in ai/answers/quick.mjs valid across calls */
const CACHE = new WeakMap();

/** Cached `publicView` for a given base. */
export function viewOf(kb) {
  if (!kb) return kb;
  let v = CACHE.get(kb);
  if (!v) { v = publicView(kb); CACHE.set(kb, v); }
  return v;
}
