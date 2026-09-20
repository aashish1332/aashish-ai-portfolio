/* ═══════════════════════════════════════════════════════════════
   tests/retrieval.test.mjs — §8.2 contract + regression guards

   The four bugs found while building this are frozen here by name:
     R1 alias glue words hijacked scoring ("which databases…" → workflow)
     R2 "uska naam kya hai" retrieved nothing (no name/naam index term)
     R3 editorial `note` text hijacked the skills queries
     R4 "where does he study" retrieved nothing (no study index term)
   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildIndex, search, chunkify, similarity, normalize, canonical, hasPronoun,
  hasEntityPronoun, resolveFocus, contentTokens, estimateTokens, RETRIEVAL_STOP,
  MAX_CHUNKS, MAX_CONTEXT_TOKENS, MIN_TOP_SCORE,
} from '../ai/retrieval/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KB = JSON.parse(readFileSync(join(HERE, '..', 'knowledge', 'knowledge.json'), 'utf8'));
const IDX = buildIndex(KB);
const top = (q) => search(IDX, q).hits[0];

/* run once: the index build is deterministic and cheap to share */

test('index builds one chunk per fact and a real vocabulary', () => {
  assert.ok(IDX.n >= 50, `expected >=50 chunks, got ${IDX.n}`);
  assert.ok(IDX.vocab.size > 100, `vocab too small: ${IDX.vocab.size}`);
  assert.ok(IDX.avgdl > 1);
  assert.equal(chunkify(KB).length, IDX.n);
});

test('every chunk id is unique and matches a knowledge-base id', () => {
  const ids = IDX.chunks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate chunk ids');
  for (const c of IDX.chunks) assert.ok(c.id && c.kind && c.label && c.text);
});

test('§8.2 budget — top-k <= 3 and context <= ~300 tokens', () => {
  assert.equal(MAX_CHUNKS, 3);
  assert.ok(MAX_CONTEXT_TOKENS <= 300);
  for (const q of ['projects', 'volunteer os', 'skills', 'education', 'certifications',
                   'tell me everything about him', 'goal tracker']) {
    const r = search(IDX, q);
    assert.ok(r.hits.length <= MAX_CHUNKS, `${q}: ${r.hits.length} chunks > ${MAX_CHUNKS}`);
    assert.ok(r.tokensUsed <= MAX_CONTEXT_TOKENS,
      `${q}: ${r.tokensUsed} tokens > ${MAX_CONTEXT_TOKENS}`);
  }
});

/* ── R1: alias glue words must never reach the index ───────────── */
test('R1 — function words are excluded from the index', () => {
  for (const w of ['the', 'he', 'his', 'does', 'which', 'use', 'hai', 'kya', 'ka', 'ki']) {
    assert.ok(!IDX.vocab.has(w), `glue word "${w}" leaked into the vocabulary`);
  }
  assert.ok(RETRIEVAL_STOP.has('does'));
  assert.deepEqual(contentTokens('how does he use ai'), ['ai']);
});

test('R1 — "which databases does he use" hits database facts, not the workflow chunk', () => {
  const r = search(IDX, 'which databases does he use');
  assert.ok(!r.lowConfidence);
  assert.notEqual(r.hits[0].id, 'workflow.how-he-builds',
    'alias glue words put the workflow chunk on top again (R1 regression)');
  assert.ok(r.hits.some((h) => /dbms|mysql|mongo|postgres|drizzle/.test(h.id)),
    `expected a database fact on top, got ${r.hits.map((h) => h.id).join(', ')}`);
});

/* ── R2: naming questions must resolve ─────────────────────────── */
test('R2 — "uska naam kya hai" resolves to the person chunk', () => {
  const r = search(IDX, 'uska naam kya hai');
  assert.ok(!r.lowConfidence, 'naming question retrieved nothing (R2 regression)');
  assert.equal(r.hits[0].id, 'person.name');
});

test('R2 — the English and Devanagari equivalents resolve too', () => {
  for (const q of ['what is his name', 'उसका नाम क्या है', 'naam batao', 'who is aashish']) {
    const r = search(IDX, q);
    assert.ok(!r.lowConfidence, `${q}: no hits`);
    assert.equal(r.hits[0].id, 'person.name', `${q} → ${r.hits[0].id}`);
  }
});

/* ── R3: editorial notes are not facts ────────────────────────── */
test('R3 — editorial `note` text is not searchable', () => {
  /* the word "skills" only existed in the two skill notes; it must not
     be an index term attached to those chunks any more */
  for (const c of IDX.chunks) {
    if (c.kind !== 'skill') continue;
    assert.ok(!/Evidenced by/i.test(c.text), `${c.id}: editorial note leaked into chunk text`);
  }
  const r = search(IDX, 'uske skills kya hain');
  assert.notEqual(r.hits[0] && r.hits[0].id, 'skill.threejs',
    'the skills-note hijack is back (R3 regression)');
});

/* ── R4: study queries must resolve ───────────────────────────── */
test('R4 — "where does he study" resolves to education', () => {
  const r = search(IDX, 'where does he study');
  assert.ok(!r.lowConfidence, 'study question retrieved nothing (R4 regression)');
  assert.equal(r.hits[0].id, 'edu.lpu');
});

test('R4 — "uski padhai" and "education" resolve to education', () => {
  for (const q of ['uski padhai kaisi hai', 'education', 'college kahan hai', 'degree kya hai']) {
    const r = search(IDX, q);
    assert.ok(!r.lowConfidence, `${q}: no hits`);
    assert.equal(r.hits[0].kind, 'education', `${q} → ${r.hits[0].id}`);
  }
});

/* ── routing signals the pipeline depends on ──────────────────── */
test('a factual query retrieves; nonsense abstains (§8.4 layer 1)', () => {
  for (const q of ['what is his cgpa', 'contact email', 'volunteer os project',
                   'goal tracker', 'github link']) {
    assert.ok(!search(IDX, q).lowConfidence, `${q}: should retrieve`);
  }
  for (const q of ['quantum physics homework', 'write me a poem about cats',
                   'what is the weather in delhi', 'sdfghjkl']) {
    assert.ok(search(IDX, q).lowConfidence, `${q}: should abstain`);
  }
});

test('MIN_TOP_SCORE is a documented heuristic, not a measured constant', () => {
  assert.equal(typeof MIN_TOP_SCORE, 'number');
  assert.ok(MIN_TOP_SCORE > 0, 'threshold must be positive');
});

test('fuzzy matching survives typos the variant map does not cover', () => {
  /* Two distinct mechanisms, tested separately so neither hides the other:
     1. the variant map handles known Hinglish spellings (list ✓, not fuzzy)
     2. char-n-gram fuzzy handles genuine unseen typos (below)          */
  assert.equal(canonical('kia'), 'kya');
  assert.equal(canonical('linkdin'), 'linkedin');
  assert.equal(canonical('projek'), 'project');
  assert.equal(canonical('unknownword'), 'unknownword', 'unknown tokens stay identity');

  /* `kia`/`kya` are trigram-dissimilar — the map is what saves them */
  assert.ok(similarity('kia', 'kya') < 0.6,
    'kia/kya are handled by the variant map, not by n-grams');

  /* real typos that the map does NOT list must still resolve fuzzily */
  assert.ok(similarity('mongoos', 'mongoose') > 0.6);
  assert.ok(similarity('linkdin', 'linkedin') > 0.6);
  const typo = search(IDX, 'mongoos');
  assert.ok(!typo.lowConfidence, 'unlisted typo should still retrieve');
  assert.equal(typo.hits[0].id, 'skill.mongoose');

  const misspelt = search(IDX, 'kia hai uska cgpa');
  assert.ok(!misspelt.lowConfidence, 'misspelt Hinglish should still retrieve');
  assert.equal(misspelt.hits[0].id, 'ach.lpu-cgpa');
});

test('normalize strips punctuation and folds case', () => {
  assert.equal(normalize('  What  is his CGPA?!  '), 'what is his cgpa');
  assert.equal(normalize('C++ & Node.js'), 'c++ node.js');
});

/* ── R7: Devanagari combining marks must survive normalization ────
   Vowel signs are category Mn — neither a letter nor a number — so the
   original `[^\p{L}\p{N}]` whitelist replaced them with a space. "उसका"
   became "उसक" on one side of the comparison and nothing matched: every
   Hindi alias and every Devanagari pronoun silently missed. */
test('R7 — Devanagari matras survive normalization and still retrieve', () => {
  assert.equal(normalize('पढ़ाई'), 'पढ़ाई', 'a nukta/matra was stripped');
  assert.equal(normalize('उसका'), 'उसका');
  assert.equal(normalize('किराना प्रोजेक्ट'), 'किराना प्रोजेक्ट');

  /* the aliases these queries rely on must actually be reachable */
  assert.equal(top('उनकी पढ़ाई के बारे में बताइए').id, 'edu.lpu');
  assert.equal(top('किराना प्रोजेक्ट').id, 'project.grocery');
  assert.equal(top('उसका naam kya hai').id, 'person.name');
});

test('pronoun detection drives focus-entity carry-over', () => {
  for (const q of ['uska database kaun sa tha', 'what about his skills', 'uski padhai']) {
    assert.ok(hasPronoun(q), `${q} should be pronoun-led`);
  }
  for (const q of ['volunteer os', 'goal tracker', 'mongodb']) {
    assert.ok(!hasPronoun(q), `${q} should not be pronoun-led`);
  }
});

test('focus entity is set by a strong hit and carried by a pronoun follow-up', () => {
  const first = search(IDX, 'tell me about volunteer os');
  assert.equal(first.focus, 'project.volunteer');

  const carried = resolveFocus(IDX, 'uska database kaun sa tha', first.focus);
  assert.equal(carried.focus, 'project.volunteer', 'focus should carry forward');
  assert.equal(carried.changed, false);
});

/* ── R6: the pronoun lock must know which KIND of pronoun it has ──
   Frozen as evaluation cases f05/f06. An entity pronoun points at the thing
   under discussion and must lock; a person pronoun is about Aashish and must
   be free to name a different record — otherwise "and his 12th marks?" stays
   stuck on the B.Tech. */
test('R6 — entity pronouns lock the focus, person pronouns do not', () => {
  for (const q of ['uska database kaun sa tha', 'what database does it use', 'उसका database kaun sa tha']) {
    assert.ok(hasEntityPronoun(q), `${q} should lock the focus`);
  }
  for (const q of ['what about his skills', 'and his 12th marks?', 'tell me about his projects']) {
    assert.ok(hasPronoun(q), `${q} is still a pronoun-led turn`);
    assert.ok(!hasEntityPronoun(q), `${q} must not lock the focus`);
  }

  /* the person pronoun may move the focus to the record the question names */
  const lpu = resolveFocus(IDX, 'Where did he do his B.Tech?', null).focus;
  assert.equal(lpu, 'edu.lpu');
  assert.equal(resolveFocus(IDX, 'and what was the CGPA?', lpu).focus, 'edu.lpu',
    'the B.Tech CGPA is the one "cgpa" means (f05)');
  assert.equal(resolveFocus(IDX, 'and his 12th marks?', lpu).focus, 'edu.kv2',
    'a person pronoun must reach the 12th marks (f06)');

  /* and R5 must still hold: an entity pronoun never lets a topic word hijack */
  assert.equal(resolveFocus(IDX, 'uska database kaun sa tha', 'project.volunteer').focus,
    'project.volunteer');
});

test('focus switches when a different entity is named explicitly', () => {
  const r = search(IDX, 'goal tracker', { focus: 'project.volunteer' });
  assert.equal(r.focus, 'project.goaltracker');
  assert.equal(r.focusChanged, true);
});

test('estimateTokens is the documented 4-chars-per-token approximation', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens(''), 0);
});

test('search is side-effect free and repeatable', () => {
  const a = JSON.stringify(search(IDX, 'what is his cgpa'));
  const b = JSON.stringify(search(IDX, 'what is his cgpa'));
  assert.equal(a, b, 'search must be deterministic');
});

test('search returns the ids the UI needs for "Sources" chips (§8.2)', () => {
  const r = search(IDX, 'tell me about the grocery project');
  assert.ok(r.hits.length, 'expected hits');
  for (const h of r.hits) {
    assert.equal(typeof h.id, 'string');
    assert.equal(typeof h.label, 'string');
    assert.ok(h.label.length, 'a chip needs a human label');
  }
});