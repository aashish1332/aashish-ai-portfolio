/* ═══════════════════════════════════════════════════════════════
   tests/guard.test.mjs — the Faithfulness Guard (§8.4 layer 4)

   The guard is the only anti-hallucination layer that can be built and
   pinned before a checkpoint exists: its inputs are strings. So the two
   questions this file answers are

     1. does it REJECT an ungrounded claim? and
     2. does it ACCEPT a grounded one?

   The second matters as much as the first. A guard that flags ordinary
   prose rejects every answer the model gets right, and the failure is
   invisible in a green suite unless the tests state plainly which
   near-misses must NOT fire — "rest" is not the technology "REST APIs",
   "list" is not the project name "Smart Grocery List Generator".

   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  GUARD_CODES, guard, guardedAnswer, languageMatches, numberKey, numbersIn,
  extractClaims, urlKey, normalizeClaim, containsTerm, contextText,
  buildVocabulary, defaultAllowlist, shortenContext, isoMonthNumbers,
} from '../ai/guard/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_KB = JSON.parse(readFileSync(join(HERE, '..', 'knowledge', 'knowledge.json'), 'utf8'));

/* ── a small knowledge base with known, awkward names ──────────── */
const KB = {
  person: { id: 'person.name', name: 'Aashish Kumar', public: true },
  projects: [{
    id: 'project.grocery',
    name: 'Smart Grocery List Generator',
    tech: ['React 19', 'MongoDB', 'Gemini AI'],
  }],
  skills: [
    { id: 'skill.python', name: 'Python' },
    { id: 'skill.rest', name: 'REST APIs' },
    { id: 'skill.react', name: 'React.js' },
    { id: 'skill.comm', name: 'Communication' },
  ],
  education: [{ id: 'edu.lpu', institution: 'Lovely Professional University', degree: 'B.Tech', field: 'Computer Science' }],
  certifications: [{ id: 'cert.dbms', name: 'Database Management', issuer: 'NPTEL' }],
  experience: [{ id: 'exp.training', title: 'Full Stack Training' }],
};

const CONTEXT = [
  { id: 'project.grocery', text: 'Smart Grocery List Generator uses React 19 and MongoDB. Updated Jan 2024.' },
  { id: 'edu.lpu', text: 'Lovely Professional University — B.Tech, Computer Science. CGPA 8.28 (2021-2025).' },
  { id: 'contact.email', text: 'Email aashish@example.com' },
];

const codes = (r) => r.violations.map((v) => v.code);

/* ── EXTRACTION ───────────────────────────────────────────────── */

test('GUARD-1: extractClaims separates years from numbers, and ignores placeholders', () => {
  const c = extractClaims('In 2024 he handled 90 endpoints and 8.28 CGPA at <|fact:contact.email|>.');
  assert.deepEqual(c.years.sort(), ['2024']);
  assert.ok(c.numbers.includes('90'), '90 was lost');
  assert.ok(c.numbers.includes('828'), '8.28 was not fingerprinted');
  assert.equal(c.emails.length, 0, 'a placeholder must not be read as an email');
});

test('GUARD-2: numbersIn fingerprints grouping separators as one number', () => {
  /* the failure this prevents: "1,200" read as 1 and 200, so a grounded
     value is flagged and an invented one can hide behind half of it */
  assert.deepEqual(numbersIn('1,200 users in 2024'), ['1200', '2024']);
  assert.equal(numberKey('8.28'), '828');
  assert.equal(numberKey('+91 62802'), '9162802');
});

test('GUARD-3: urlKey ignores the differences that are not the claim', () => {
  const k = urlKey('https://www.GitHub.com/aashish1332/');
  assert.equal(k, 'github.com/aashish1332');
  assert.equal(urlKey('http://github.com/aashish1332'), k);
});

test('GUARD-4: containsTerm needs a word boundary, and tolerates a phrase', () => {
  /* AN-style trap, from the anchor resolver: "react" inside "reactive" */
  assert.equal(containsTerm('reactive dashboards', 'react'), false);
  assert.equal(containsTerm('uses react.js and vite', 'react.js'), true);
  assert.equal(containsTerm('the smart grocery list generator', 'smart grocery list generator'), true);
});

test('GUARD-5: isoMonthNumbers reads YYYY-MM-DD and DD/MM/YYYY', () => {
  assert.ok(isoMonthNumbers('2024-01-15').has('01'));
  assert.ok(isoMonthNumbers('15/03/2024').has('03'));
});

/* ── GROUNDING: THE REJECTIONS ───────────────────────────────── */

test('GUARD-6: a fully grounded answer passes — every claim is in the context', () => {
  const r = guard(
    'The Smart Grocery List Generator uses React 19 and MongoDB. '
    + 'His CGPA is 8.28 at Lovely Professional University. Email aashish@example.com.',
    { context: CONTEXT, lang: 'en', kb: KB },
  );
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('GUARD-7: an invented number is caught', () => {
  const r = guard('He has 5 years of experience and a 9.5 CGPA.', { context: CONTEXT, kb: KB });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r).sort(), [GUARD_CODES.NUMBER, GUARD_CODES.NUMBER]);
  assert.deepEqual(r.violations.map((v) => v.token).sort(), ['5', '95']);
});

test('GUARD-8: an invented year is a date claim, not a number', () => {
  const r = guard('He graduated in 2019.', { context: CONTEXT, kb: KB });
  assert.deepEqual(codes(r), [GUARD_CODES.DATE]);
  assert.equal(r.violations[0].token, '2019');
});

test('GUARD-9: an invented month is caught; a grounded one is not', () => {
  assert.equal(guard('The update shipped in March 2024.', { context: CONTEXT, kb: KB }).ok, false);
  assert.equal(guard('The update shipped in Jan 2024.', { context: CONTEXT, kb: KB }).ok, true);
  /* grounded through the ISO form the chunk may carry instead */
  assert.equal(guard('Shipped in January.', { context: [{ text: '2024-01-15 release' }], kb: KB }).ok, true);
});

test('GUARD-10: an invented URL is caught, and a grounded one is accepted in any spelling', () => {
  const ctx = [{ text: 'GitHub https://github.com/aashish1332' }];
  const bad = guard('See https://github.com/someoneelse for details.', { context: ctx, kb: KB });
  assert.deepEqual(codes(bad), [GUARD_CODES.URL]);
  const ok = guard('His code is at http://www.github.com/aashish1332/.', { context: ctx, kb: KB });
  assert.equal(ok.ok, true, JSON.stringify(ok.violations));
});

test('GUARD-11: an invented email is caught', () => {
  const r = guard('Reach him at aashish.kumar@gmail.example.', { context: CONTEXT, kb: KB });
  assert.deepEqual(codes(r), [GUARD_CODES.EMAIL]);
});

test('GUARD-12: a known technology absent from the context is a fabricated entity', () => {
  const r = guard('He is strong in Python and Communication.', { context: CONTEXT, kb: KB });
  const toks = r.violations.map((v) => v.token).sort();
  assert.deepEqual(toks, ['communication', 'python']);
  assert.ok(codes(r).every((c) => c === GUARD_CODES.ENTITY));
});

test('GUARD-13: the SAME technology inside the context is not flagged', () => {
  const r = guard('He works with Python.', { context: [...CONTEXT, { text: 'Skills: Python' }], kb: KB });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

/* ── GROUNDING: THE ACCEPTANCES THAT KEEP IT USABLE ──────────── */

test('GUARD-14: ordinary words inside a name are NOT vocabulary', () => {
  /* "rest" is the word in "the rest of the projects"; "list" is the word in
     "Smart Grocery List Generator". Both must pass. */
  const r = guard('The rest of the list is on the site.', { context: CONTEXT, kb: KB });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('GUARD-15: an allowlisted value is grounded without being in the context', () => {
  const r = guard('Aashish Kumar built this portfolio.', { context: [{ text: 'no names here' }], kb: KB });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  /* and every part of his name, not only the full string */
  assert.equal(guard('Kumar is the surname.', { context: [{ text: 'no names here' }], kb: KB }).ok, true);
});

test('GUARD-16: a fragment of a technology name is not the technology', () => {
  /* "java" must not be matched by "javascript", nor "react" by "reactive" */
  const kb = { skills: [{ name: 'JavaScript' }] };
  const r = guard('Java is different.', { context: [{ text: 'nothing' }], kb });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

/* ── LANGUAGE, LENGTH, PLACEHOLDERS ──────────────────────────── */

test('GUARD-17: language must match the visitor, across all three', () => {
  const hi = 'यह जानकारी उपलब्ध नहीं है।';
  const en = 'This information is not available.';
  const hinglish = 'Ye information available nahi hai.';
  assert.equal(languageMatches(hi, 'hi'), true);
  assert.equal(languageMatches(hi, 'en'), false, 'a Hindi answer passed as English');
  assert.equal(languageMatches(en, 'hi'), false, 'an English answer passed as Hindi');
  assert.equal(languageMatches(hinglish, 'hinglish'), true);
  assert.equal(languageMatches(en, 'hinglish'), true, 'Roman script is Hinglish-compatible by definition');
});

test('GUARD-18: a language violation is reported with the expected language', () => {
  const r = guard('यह जानकारी उपलब्ध नहीं है।', { context: [], lang: 'en' });
  assert.ok(codes(r).includes(GUARD_CODES.LANGUAGE));
  assert.equal(r.violations.find((v) => v.code === GUARD_CODES.LANGUAGE).token, 'en');
});

test('GUARD-19: the length cap fires above the limit and not at it', () => {
  const lim = 40;
  assert.equal(guard('x'.repeat(lim), { maxChars: lim }).ok, true);
  const over = guard('x'.repeat(lim + 1), { maxChars: lim });
  assert.deepEqual(codes(over), [GUARD_CODES.LENGTH]);
});

test('GUARD-20: an unresolved placeholder is a violation, a resolved one is not', () => {
  const bad = guard('Email him at <|fact:contact.email|>.', { context: CONTEXT, kb: KB });
  assert.ok(codes(bad).includes(GUARD_CODES.PLACEHOLDER));
  assert.equal(bad.violations[0].token, 'contact.email');
  /* the resolved form is the value, and it is grounded by the context */
  assert.equal(guard('Email him at aashish@example.com.', { context: CONTEXT, kb: KB }).ok, true);
});

test('GUARD-21: an empty answer is never faithful', () => {
  assert.deepEqual(codes(guard('   ', { context: CONTEXT })), [GUARD_CODES.EMPTY]);
});

/* ── VOCABULARY / CONTEXT ────────────────────────────────────── */

test('GUARD-22: the vocabulary comes from the knowledge base, whole names only', () => {
  const v = buildVocabulary(KB);
  assert.ok(v.has('smart grocery list generator'), 'a project name is missing');
  assert.ok(v.has('lovely professional university'), 'an institution is missing');
  assert.ok(v.has('rest apis') && !v.has('rest'), 'a name was split into ordinary words');
  assert.ok(!v.has('list'), '"list" entered the vocabulary from a project name');
});

test('GUARD-23: on the real base the vocabulary is names, not English words', () => {
  const v = buildVocabulary(REAL_KB);
  assert.ok(v.has('mongodb') && v.has('react.js'), 'a real technology is missing');
  assert.ok(!v.has('list') && !v.has('the'), 'ordinary words leaked in');
  /* every entry is a name the knowledge base actually declares */
  const declared = new Set([REAL_KB.person.name.toLowerCase()]);
  for (const p of REAL_KB.projects) { declared.add(p.name.toLowerCase()); (p.tech || []).forEach((t) => declared.add(t.toLowerCase())); }
  for (const s of REAL_KB.skills) declared.add(s.name.toLowerCase());
  for (const e of REAL_KB.education || []) {
    for (const f of [e.institution, e.degree, e.field]) if (f) declared.add(f.toLowerCase());
  }
  for (const c of REAL_KB.certifications || []) {
    for (const f of [c.name, c.issuer]) if (f) declared.add(f.toLowerCase());
  }
  for (const x of REAL_KB.experience || []) if (x.title) declared.add(x.title.toLowerCase());
  for (const t of v) assert.ok(declared.has(t), `${t} is not a declared name`);
});

test('GUARD-24: defaultAllowlist carries every part of his name', () => {
  const a = defaultAllowlist(KB);
  assert.ok(a.includes('aashish kumar') && a.includes('aashish') && a.includes('kumar'));
});

test('GUARD-25: contextText flattens chunks, strings and a bare string', () => {
  assert.match(contextText([{ title: 'T', text: 'B' }]), /T B/);
  assert.equal(normalizeClaim(contextText(['a', 'b'])), 'a b');
  assert.equal(contextText('solo'), 'solo');
  assert.equal(normalizeClaim('  React   JS  '), 'react js');
});

/* ── THE §5.1 STEP-5 ORCHESTRATION ───────────────────────────── */

const grounded = 'His CGPA is 8.28 at Lovely Professional University.';
const invented = 'His CGPA is 9.5 and he interned at Google.';

test('GUARD-26: a grounded first attempt is returned with no retry and no fallback', async () => {
  const calls = [];
  const out = await guardedAnswer({
    context: CONTEXT, lang: 'en', kb: KB,
    generate: (ctx, o) => { calls.push(o); return grounded; },
  });
  assert.equal(out.attempts, 1);
  assert.equal(out.fallback, false);
  assert.equal(out.guardFailed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].greedy, false);
});

test('GUARD-27: one greedy retry over a SHORTER context, and the retry is told', async () => {
  const seen = [];
  const out = await guardedAnswer({
    context: CONTEXT, lang: 'en', kb: KB,
    generate: (ctx, o) => {
      seen.push({ len: ctx.length, greedy: o.greedy });
      return o.greedy ? grounded : invented;
    },
  });
  assert.equal(out.attempts, 2);
  assert.equal(out.text, grounded);
  assert.equal(out.guardFailed, false);
  assert.deepEqual(seen, [{ len: 3, greedy: false }, { len: 2, greedy: true }]);
});

test('GUARD-28: two bad attempts fall back to the extractive answer', async () => {
  const out = await guardedAnswer({
    context: CONTEXT, lang: 'en', kb: KB,
    generate: () => invented,
    fallback: () => 'I don’t have that information in Aashish’s portfolio yet.',
  });
  assert.equal(out.fallback, true);
  assert.equal(out.guardFailed, false);
  assert.match(out.text, /don’t have that information/);
  assert.ok(out.violations.length > 0, 'the violations must survive for the log');
});

test('GUARD-29: no fallback means the caller is told to abstain, not handed a bad answer', async () => {
  const out = await guardedAnswer({ context: CONTEXT, kb: KB, generate: () => invented });
  assert.equal(out.guardFailed, true);
  assert.equal(out.fallback, false);
  assert.equal(out.text, invented, 'the text is returned for logging only — guardFailed is the contract');
});

test('GUARD-30: guardedAnswer refuses a missing generator rather than inventing one', async () => {
  await assert.rejects(() => guardedAnswer({ context: [] }), TypeError);
});

test('GUARD-31: shortenContext keeps at least one chunk and never grows the source', () => {
  assert.equal(shortenContext([1, 2, 3], 0.6).length, 2);
  assert.equal(shortenContext([1], 0.6).length, 1);
  /* nothing to keep is nothing to keep — not a phantom chunk */
  assert.equal(shortenContext([], 0.6).length, 0);
});

/* ── LOAD-BEARING: the guard must be able to FAIL ────────────── */

test('GUARD-32: an empty vocabulary is a blind spot, and the suite names it', () => {
  /* this is the mutation: if buildVocabulary silently returns nothing, only
     the entity tests catch it — proof they are not passing by accident */
  const blind = guard('He is strong in Python and Communication.', {
    context: CONTEXT, vocabulary: new Set(),
  });
  const sighted = guard('He is strong in Python and Communication.', { context: CONTEXT, kb: KB });
  assert.equal(blind.ok, true, 'without a vocabulary the entity check is inert');
  assert.equal(sighted.ok, false, 'with the real vocabulary it fires');
});
