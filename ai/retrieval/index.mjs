/* ═══════════════════════════════════════════════════════════════
   ai/retrieval/index.mjs — §8.2 local retrieval, no model, no network

   Deliberately boring: BM25 + an alias/transliteration map + char
   n-gram fuzzy matching + an entity index + the conversation's focus
   entity. §8.2 sets the budget — top-k ≤ 3 chunks, ≤ ~300 tokens of
   context — so this is tuned for precision on a 54-fact base, not for
   web-scale recall. No embedding model, exactly as instructed.

   Runs as browser ESM and under `node --test` unchanged.
   ═══════════════════════════════════════════════════════════════ */
import { tokenize, ENGLISH_WORDS, HINGLISH_WORDS } from '../language/detect.mjs';

/* ── retrieval stop set ──────────────────────────────────────────
   Function words are worthless as index terms and actively harmful
   when they arrive via aliases: the workflow alias "how does he use ai"
   is boosted 3x, which made the workflow chunk outrank the database
   skills for "which databases does he use". So body AND alias tokens
   are filtered through this set. Content words survive; glue does not.
   Documented trade-off: soft-skill-ish content words that double as
   Hinglish glue ("kaam") are dropped too — see tests/retrieval.test.mjs */
export const RETRIEVAL_STOP = new Set([...ENGLISH_WORDS, ...HINGLISH_WORDS]);

/** Tokenize for indexing: normalize → tokenize → canonical → drop glue. */
export function contentTokens(text) {
  return tokenize(normalize(text)).map(canonical).filter((t) => !RETRIEVAL_STOP.has(t));
}

/* ─ BM25 knobs ───────────────────────────────────────────────────
   k1 = 1.2 / b = 0.75 are the standard defaults. On a base this small,
   the alias boost matters far more than the BM25 constants. */
const K1 = 1.2;
const B = 0.75;
const ALIAS_BOOST = 3;   /* an alias hit counts as N occurrences */

/* n-gram fuzzy: minimum Dice coefficient for two tokens to be a match */
export const FUZZY_MIN = 0.62;
const NGRAM = 3;

/** Normalize a query: lower-case, strip punctuation, collapse space. */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    /* \p{M} keeps COMBINING MARKS. Devanagari vowel signs are marks
       (U+093E is Mn), not letters — without this, "उसका" normalized to
       "उसक" and every Hindi alias and Devanagari pronoun silently missed. */
    .replace(/[^\p{L}\p{N}\p{M}\s+#.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Character n-grams of a token, padded so short words still compare. */
function ngrams(tok, n = NGRAM) {
  const s = `#${tok}#`;
  const out = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

/** Sørensen–Dice similarity of two tokens by character trigrams. */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < NGRAM || b.length < NGRAM) return a === b ? 1 : 0;
  const A = ngrams(a), B = ngrams(b);
  const setB = new Set(B);
  let overlap = 0;
  const counted = new Set();
  for (const g of A) {
    if (setB.has(g) && !counted.has(g)) { overlap++; counted.add(g); }
  }
  return (2 * overlap) / (A.length + B.length);
}

/* ── pronoun handling for the focus entity (§8.2) ────────────────
   These are what make follow-ups like "uska database kaun sa tha?"
   resolve without a model. */
const PRONOUNS = new Set([
  'uska', 'uski', 'uske', 'unka', 'unki', 'unke', 'woh', 'wo', 'voh', 'yeh', 'ye',
  'unhone', 'usne', 'inka', 'iski', 'iske', 'isko', 'usko', 'unko',
  /* Devanagari twins of the forms above — they were missing, so a native-script
     follow-up could not carry a focus at all */
  'उसका', 'उसकी', 'उसके', 'उनका', 'उनकी', 'उनके', 'उन्होंने', 'उसने', 'इसका', 'इसकी', 'इसके',
  'इसको', 'उसको', 'उनको', 'यह', 'वह', 'ये', 'वो',
  'his', 'her', 'their', 'its', 'he', 'she', 'they', 'him', 'them',
  'it', 'this', 'that', 'these', 'those',
]);

/* ── two kinds of pronoun (§8.2) ─────────────────────────────────
   An ENTITY pronoun points at a thing under discussion — "uska database
   kaun sa tha?" means "what was IT'S database?". A PERSON pronoun is
   possessive of Aashish — "and his 12th marks?" is a new topic about him,
   not a pointer at the previous entity.

   Only the entity kind may lock the focus. Treating "his" as a lock kept
   the conversation on the wrong record, and that bug is frozen in
   evaluation/portfolio_tests.json as case f06. */
const PERSON_PRONOUNS = new Set([
  'his', 'her', 'he', 'she', 'him', 'they', 'them', 'their',
]);

/** Every pronoun — used to detect a pronoun-led turn at all. */
export function hasPronoun(query) {
  return tokenize(normalize(query)).some((t) => PRONOUNS.has(t));
}

/** Only the pronouns that point at an entity, and so may lock the focus. */
export function hasEntityPronoun(query) {
  return tokenize(normalize(query)).some((t) => PRONOUNS.has(t) && !PERSON_PRONOUNS.has(t));
}

/* ── the transliteration / variant map ───────────────────────────
   Hinglish is spelled many ways. This is consulted only when exact
   matching fails, so it can never widen a confident result. */
const VARIANTS = {
  kia: 'kya', kyaa: 'kya', qya: 'kya',
  kaun: 'kaun', kon: 'kaun', koun: 'kaun',
  batao: 'batao', bata: 'batao', btao: 'batao', bataao: 'batao',
  project: 'project', proj: 'project', projects: 'project',
  projek: 'project', projcet: 'project',
  skills: 'skill', skill: 'skill', skils: 'skill',
  cgpa: 'cgpa', gpa: 'cgpa', cgpaa: 'cgpa',
  email: 'email', mail: 'email', emial: 'email', gmail: 'email',
  github: 'github', git: 'git', githubb: 'github',
  linkdin: 'linkedin', linkedin: 'linkedin', linked: 'linkedin',
  collage: 'college', college: 'college', collegee: 'college',
  education: 'education', padhai: 'education', study: 'education',
  name: 'name', naam: 'name', nam: 'name',
  internship: 'internship', intership: 'internship', intern: 'internship',
  certificate: 'certificate', certificates: 'certificate', certification: 'certificate',
  certification: 'certificate', ceritificate: 'certificate',
  mongodb: 'mongodb', mongo: 'mongodb', mongoo: 'mongodb',
  react: 'react', raect: 'react',
  node: 'node', nodejs: 'node', nodjs: 'node',
  contact: 'contact', cantact: 'contact', phone: 'phone', fone: 'phone',
  mobile: 'mobile', number: 'number', numbr: 'number',
};

/** Apply the variant map to a token (identity when unknown). */
export function canonical(tok) {
  return VARIANTS[tok] || tok;
}

/* ── building the chunks from knowledge.json ─────────────────────
   One chunk per fact, written as a compact sentence so that (a) BM25
   has real content to match and (b) the chunk can be pasted straight
   into the LLM context when Phase 5+ arrives. */
export function chunkify(kb) {
  const chunks = [];
  const add = (id, kind, label, parts, aliases = []) => {
    const text = parts.filter(Boolean).join(' · ');
    if (text) chunks.push({ id, kind, label, text, aliases: aliases.map(normalize) });
  };

  const p = kb.person || {};
  add(p.id || 'person.name', 'person', 'Profile',
    [p.name, p.headline, p.class_year], p.aliases);

  for (const [key, c] of Object.entries(kb.contact || {})) {
    add(c.id || `contact.${key}`, 'contact', c.id || key, [c.value], c.aliases);
  }
  for (const l of kb.links || []) {
    add(l.id, 'link', l.label, [`${l.label} profile`, l.url], l.aliases);
  }
  for (const e of kb.education || []) {
    const score = e.score ? `${e.score.type} ${e.score.value}` : '';
    add(e.id, 'education', e.institution,
      [e.degree, e.field, e.institution, e.location, e.start, e.end, score], e.aliases);
  }
  for (const s of kb.skills || []) {
    /* `note` is editorial meta ("evidenced by this portfolio, not the CV"),
       not a fact about Aashish — indexing it made the word "skills" live
       inside two skill chunks and hijack the skills queries. */
    add(s.id, 'skill', s.name, [s.name, s.category], s.aliases);
  }
  for (const pr of kb.projects || []) {
    add(pr.id, 'project', pr.name, [
      pr.name, pr.portfolio_codename, pr.summary,
      `tech: ${(pr.tech || []).join(', ')}`,
      `role: ${pr.role}`,
      `status: ${pr.status}`, `date: ${pr.date}`,
      ...(pr.highlights || []),
      `live at ${(pr.links || []).map((l) => l.url).join(', ')}`,
      `attribution: ${pr.ai_attribution}`,
    ], pr.aliases);
  }
  for (const e of kb.experience || []) {
    add(e.id, 'experience', e.title,
      [e.title, e.organization, e.start, e.end, `grade ${e.grade}`], e.aliases);
  }
  for (const c of kb.certifications || []) {
    const score = c.score ? `${c.score.type} ${c.score.value}` : '';
    add(c.id, 'certification', c.name, [c.name, c.issuer, c.date, c.start, c.end, score], c.aliases);
  }
  for (const a of kb.achievements || []) {
    add(a.id, 'achievement', a.id.replace('ach.', ''), [a.text], a.aliases);
  }
  if (kb.workflow) {
    add(kb.workflow.id, 'workflow', 'How he builds', [kb.workflow.text], kb.workflow.aliases);
  }
  return chunks;
}

/** Build the BM25 index. Cheap enough to run on the main thread (< 5 ms). */
export function buildIndex(kb) {
  const chunks = chunkify(kb);
  const df = new Map();          /* term -> document frequency */
  const vocab = new Set();
  let totalLen = 0;

  for (const c of chunks) {
    const body = contentTokens(c.text);
    /* aliases are folded into the chunk, repeated so they outweigh prose */
    const aliasToks = [];
    for (const a of c.aliases) {
      for (const t of contentTokens(a)) {
        for (let i = 0; i < ALIAS_BOOST; i++) aliasToks.push(t);
      }
    }
    c.tokens = body.concat(aliasToks);
    c.len = c.tokens.length;
    totalLen += c.len;

    const seen = new Set(c.tokens);
    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
      vocab.add(t);
    }
    /* term frequencies for scoring */
    c.tf = new Map();
    for (const t of c.tokens) c.tf.set(t, (c.tf.get(t) || 0) + 1);
  }

  return { chunks, df, vocab, avgdl: chunks.length ? totalLen / chunks.length : 1, n: chunks.length };
}

/** Expand a query token to vocabulary terms via char n-grams (kya/kia). */
function expand(index, qtok) {
  if (index.vocab.has(qtok)) return [qtok];
  let best = null, bestScore = 0;
  for (const v of index.vocab) {
    if (Math.abs(v.length - qtok.length) > 3) continue;
    const s = similarity(qtok, v);
    if (s > bestScore) { bestScore = s; best = v; }
  }
  return best && bestScore >= FUZZY_MIN ? [best] : [];
}

/** IDF with the standard +0.5 smoothing, floored so nothing goes negative. */
function idf(index, term) {
  const n = index.df.get(term) || 0;
  return Math.max(0.05, Math.log(1 + (index.n - n + 0.5) / (n + 0.5)));
}

/** Score every chunk for a query. Exported for tests. */
export function scoreAll(index, queryTokens) {
  const scored = [];
  for (const c of index.chunks) {
    let s = 0;
    for (const q of queryTokens) {
      const f = c.tf.get(q);
      if (!f) continue;
      s += idf(index, q) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (c.len / index.avgdl))));
    }
    if (s > 0) scored.push({ chunk: c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ── entity resolution ───────────────────────────────────────────
   Entities are the named things a pronoun can point back to:
   projects, education, certifications, and the named skill groups. */
const ENTITY_KINDS = new Set(['project', 'education', 'certification', 'experience']);

/* ── the retrieval gate (§8.4 layer 1) ───────────────────────────
   Starting heuristic, NOT a measured constant: it must be calibrated
   against `evaluation/portfolio_tests.json` in Phase 5. Below this the
   pipeline abstains without ever calling a model. */
export const MIN_TOP_SCORE = 1.0;

/* Context budget (§8.2): top-k ≤ 3 chunks AND ≤ ~300 tokens together.
   Token count is approximated at 4 chars/token — good enough for a cap
   and far cheaper than a real tokenizer on the main thread. */
export const MAX_CHUNKS = 3;
export const MAX_CONTEXT_TOKENS = 300;
export const estimateTokens = (s) => Math.ceil(String(s).length / 4);

/**
 * Resolve the conversation's focus entity from a query (§8.2).
 * Returns the previous focus when the query only uses pronouns.
 */
export function resolveFocus(index, query, previous = null) {
  /* An ENTITY pronoun LOCKS the focus to whatever is already under discussion.
     "uska database kaun sa tha?" means "what was ITS database?" — so we must
     not let the literal word "database" hijack the topic onto cert.dbms.
     A PERSON pronoun ("and his 12th marks?") does not lock: that is a new
     question about Aashish, and it must be free to name a different record. */
  if (previous && hasEntityPronoun(query)) {
    return { focus: previous, label: null, changed: false };
  }

  const toks = contentTokens(query);
  const scored = scoreAll(index, toks).filter((s) => ENTITY_KINDS.has(s.chunk.kind));
  const best = scored[0];
  /* a content-token-free pronoun query keeps the previous focus */
  if (!best || best.score < MIN_TOP_SCORE) {
    return { focus: previous, label: null, changed: false };
  }
  return { focus: best.chunk.id, label: best.chunk.label, changed: best.chunk.id !== previous };
}

/**
 * The §8.2 search entry point.
 * @returns {{query, tokens, hits, focus, tokensUsed, lowConfidence, expanded}}
 */
export function search(index, query, opts = {}) {
  const { focus = null, k = MAX_CHUNKS, maxTokens = MAX_CONTEXT_TOKENS } = opts;

  const raw = tokenize(normalize(query));
  const expanded = [];
  const qtokens = [];
  for (const t of raw) {
    const c = canonical(t);
    const e = expand(index, c);
    if (e.length) {
      if (e[0] !== c) expanded.push({ from: t, to: e[0] });
      qtokens.push(...e);
    } else {
      qtokens.push(c);          /* keeps the term for scoring; it just won't match */
    }
  }

  const focusRes = resolveFocus(index, query, focus);

  let scored = scoreAll(index, qtokens);
  /* pronoun follow-up: if the focus is carried but nothing scored strongly,
     pull the focus chunk in so "uska database kaun sa tha?" still resolves */
  if (hasPronoun(query) && focusRes.focus &&
      (!scored.length || scored[0].score < MIN_TOP_SCORE)) {
    const fc = index.chunks.find((c) => c.id === focusRes.focus);
    if (fc) {
      let s = 0;
      for (const q of qtokens) {
        const f = fc.tf.get(q);
        if (f) s += idf(index, q) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (fc.len / index.avgdl))));
      }
      scored = [{ chunk: fc, score: Math.max(s, MIN_TOP_SCORE) }, ...scored];
    }
  }

  const hits = [];
  let tokensUsed = 0;
  for (const s of scored) {
    if (hits.length >= k) break;
    const t = estimateTokens(s.chunk.text);
    if (tokensUsed + t > maxTokens) continue;
    tokensUsed += t;
    hits.push({
      id: s.chunk.id, kind: s.chunk.kind, label: s.chunk.label,
      score: +s.score.toFixed(3), text: s.chunk.text, tokens: t,
    });
  }

  return {
    query,
    tokens: raw,
    expanded,
    hits,
    focus: focusRes.focus,
    focusChanged: focusRes.changed,
    tokensUsed,
    lowConfidence: !hits.length || hits[0].score < MIN_TOP_SCORE,
  };
}