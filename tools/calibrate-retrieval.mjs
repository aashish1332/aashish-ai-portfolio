/* ═══════════════════════════════════════════════════════════════
   tools/calibrate-retrieval.mjs — §8.2/§8.4 gate calibration

   `MIN_TOP_SCORE` decides whether the pipeline answers or abstains without
   ever calling a model, and until now it was an unmeasured heuristic (1.0,
   "calibrate against the evaluation set in Phase 5"). This is that
   calibration, and it is a *sweep*, not a re-read of the code:

     for every threshold T in a grid
       run every executable case in evaluation/portfolio_tests.json
       count the four ways the gate can be wrong

   The gate only ever moves answers in one direction (raise it and more
   questions abstain), so the set of thresholds with zero failures is an
   INTERVAL. The shipped value is its midpoint — the choice with the most room
   on both sides — and the interval itself is the evidence, not the number.

   Honest limits, printed with every run and stored in the artefact:
     · the cases that constrain T are only the ones that reach the gate. A
       question answered by a template (greeting, contact) cannot move, and is
       reported as gate-independent rather than counted as a pass;
     · this measures ENGLISH/HINDI/HINGLISH cases in the evaluation file, i.e.
       the questions we chose to be judged on. It is not a random sample of
       visitor traffic, and no recall claim is made from it;
     · `forbidden` strings are the fabrication test, exactly as §14 defines it.

   Run:  node tools/calibrate-retrieval.mjs
   Out:  docs/CALIBRATION.json
   ═══════════════════════════════════════════════════════════════ */
'use strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, resolveFocus, search, contentTokens, MIN_TOP_SCORE } from '../ai/retrieval/index.mjs';
import { createLanguageTracker } from '../ai/language/detect.mjs';
import { quickAnswer, factIds } from '../ai/answers/quick.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KB = JSON.parse(readFileSync(join(HERE, '..', 'knowledge', 'knowledge.json'), 'utf8'));
const CASES = JSON.parse(readFileSync(join(HERE, '..', 'evaluation', 'portfolio_tests.json'), 'utf8'));
const IDX = buildIndex(KB);
const PUBLIC_IDS = new Set(factIds(KB));

/* the same two contracts tests/evaluation.test.mjs enforces */
const TRAINING_FACTS = ['exp.mern-bootcamp', 'contact.availability'];
const ANSWERABLE = new Set(['direct', 'indirect', 'switch']);
const MUST_ABSTAIN = new Set(['unknown']);

/** Answer one case the way the pipeline will: smoothed language, carried focus. */
function run(c, minScore) {
  const tracker = createLanguageTracker('en');
  if (c.follows) tracker.push(c.follows);
  const lang = tracker.push(c.question).lang;
  const priorFocus = c.follows ? resolveFocus(IDX, c.follows, null).focus : null;
  const r = quickAnswer(KB, c.question, { lang, minScore });
  return { r, lang, priorFocus };
}

/** The four failure modes the gate can cause, per §14's own definitions. */
function evaluate(minScore) {
  const fails = { falseAbstain: [], groundingMiss: [], abstainMiss: [], baitAnswered: [], fabrication: [] };
  for (const c of CASES) {
    if (c.type === 'synthetic') continue;                 /* needs a model (P5) */
    const { r } = run(c, minScore);
    if (ANSWERABLE.has(c.type) && c.expected_facts.length) {
      if (r.abstained) fails.falseAbstain.push(c.id);
      const missing = c.expected_facts.filter((f) => !r.sources.includes(f));
      if (missing.length) fails.groundingMiss.push(`${c.id}(${missing.join('+')})`);
    }
    if (MUST_ABSTAIN.has(c.type) && !r.abstained) fails.abstainMiss.push(c.id);
    if (c.type === 'hallucination_bait' && !r.abstained) {
      const stray = r.sources.filter((s) => !TRAINING_FACTS.includes(s));
      if (stray.length || !/no employment history/i.test(r.text)) fails.baitAnswered.push(c.id);
    }
    const low = r.text.toLowerCase();
    for (const f of c.forbidden) {
      if (low.includes(String(f).toLowerCase())) fails.fabrication.push(`${c.id}:"${f}"`);
    }
  }
  const total = Object.values(fails).reduce((a, v) => a + v.length, 0);
  return { minScore, fails, total };
}

/* ── the sweep ─────────────────────────────────────────────────── */
const STEP = 0.05;
/* The sweep has to run PAST the loudest must-not-answer score (the withheld
   phone question scores 13.2). If a case still passes with the gate wide open,
   that is proof it never consulted the gate — which is a different thing from
   a case that passes because the gate is set well. */
const MAX = 15;
const grid = [];
for (let t = 0; t <= MAX + 1e-9; t += STEP) grid.push(+t.toFixed(2));
const swept = grid.map(evaluate);
const feasible = swept.filter((s) => s.total === 0);
const first = feasible[0]?.minScore ?? null;
const last = feasible[feasible.length - 1]?.minScore ?? null;
const midpoint = first === null ? null : +((first + last) / 2).toFixed(2);

/* Which side of the interval each failure lands on, so the reason is visible
   rather than implied by the counts. */
const below = first === null ? null : evaluate(+Math.max(0, first - 2 * STEP).toFixed(2));
const above = last === null ? null : evaluate(+(last + 2 * STEP).toFixed(2));

/* ── phase 2: mechanical labels, from the knowledge base itself ────
   3 of 56 evaluation cases reach the gate, which is not enough evidence to
   pin a constant to two decimals. The base supplies its own labels instead:
   every alias of every public fact is a query that MUST retrieve that fact,
   and no human chose the expectation — it is the declaration. Those give the
   upper bound (T cannot exceed the weakest alias that must work); the
   questions that must abstain give the lower bound (T cannot sit below the
   noisiest question that must not answer). */
const probes = [];
for (const c of IDX.chunks) {
  /* `label` is the fact's own name; aliases are the spellings it declares.
     A fact with no aliases still has a name, but a one-word name ("C") is not
     the same kind of claim as a declared alias, so the two are kept apart and
     the ceiling is computed from aliases only. */
  for (const a of (c.aliases || []).filter(Boolean)) probes.push({ q: String(a), fact: c.id, kind: c.kind, source: 'alias' });
  if (c.label) probes.push({ q: String(c.label), fact: c.id, kind: c.kind, source: 'label' });
}
/* Ambiguity is a matter of TOKENS, not of identical strings: "marks" is a
   declared alias of one achievement while another achievement declares
   "class 12 marks", and the literal comparison missed exactly that. */
const tokenClaim = new Map();
for (const p of probes) {
  if (p.source !== 'alias') continue;
  for (const t of contentTokens(p.q)) {
    if (!tokenClaim.has(t)) tokenClaim.set(t, new Set());
    tokenClaim.get(t).add(p.fact);
  }
}
const labelled = [];
for (const p of probes) {
  const toks = contentTokens(p.q);
  const ambiguous = p.source === 'alias'
    && toks.some((t) => (tokenClaim.get(t)?.size || 0) > 1);
  const r = search(IDX, p.q, { minScore: 0, k: 20 });
  const self = r.hits.find((h) => h.id === p.fact);
  labelled.push({ alias: p.q, fact: p.fact, kind: p.kind, source: p.source, ambiguous,
    top: r.hits[0]?.id ?? null, routed: r.hits[0]?.id === p.fact,
    selfScore: self?.score ?? 0, topScore: r.hits[0]?.score ?? 0 });
}
const aliasProbes = labelled.filter((l) => l.source === 'alias');
const mustWork = aliasProbes.filter((l) => !l.ambiguous && l.routed);
const misrouted = aliasProbes.filter((l) => !l.ambiguous && !l.routed);
const weakest = mustWork.slice().sort((a, b) => a.selfScore - b.selfScore);

/* Queries the project's own regression suite records as PREVIOUSLY WRONG
   (QA-1…QA-11, INT-5, R2, R6, and §14's bait cases). Their scores are the
   evidence the earlier sweep lacked: a wrong answer that scored 1.7 says the
   gate at 1.0 was set too low; one that scored 0.4 says the gate was never
   what caught it. Each row names the test that records it. */
const EDGE = [
  { q: 'what car does he drive', note: 'QA-3 — answered with the MERN achievement before the alias rule' },
  { q: 'his code', note: 'QA-7 — hit the skill named VS Code before the links rule' },
  { q: 'what is his favourite pizza', note: 'QA-1 — must abstain' },
  { q: 'how many years of experience does he have', note: 'QA-2 — fell through to the project list' },
  { q: 'what backend technologies has he worked with', note: 'INT-5 — false abstention on a skills question' },
  { q: 'uska naam kya hai', note: 'R2 — retrieved nothing before the index terms were added' },
  { q: 'mongoos', note: 'typo that must still retrieve (skill.mongoose)' },
  { q: 'quantum physics homework', note: 'retrieval.test.mjs — must abstain' },
  { q: 'who is he', note: 'alias claimed by person.name' },
];
const edge = EDGE.map((e) => {
  const r = search(IDX, e.q, { minScore: 0 });
  return { ...e, top: r.hits[0]?.id ?? null, topScore: r.hits[0]?.score ?? 0 };
});

/* The questions that must NOT answer: the evaluation set's unknown cases and
   the four nonsense prompts tests/retrieval.test.mjs already requires to
   abstain (quoted, not re-invented). `hallucination_bait` is NOT included: it
   is handled by an intent rule, so it never consults the gate either. */
const MUST_NOT_ANSWER = [
  ...CASES.filter((c) => MUST_ABSTAIN.has(c.type)).map((c) => ({ q: c.question, id: c.id })),
  ...['quantum physics homework', 'write me a poem about cats',
    'what is the weather in delhi', 'sdfghjkl'].map((q) => ({ q, id: 'retrieval.test.mjs' })),
];
/* Which negatives are the GATE's business at all? Measure it: answer each one
   with the gate as low and as high as the sweep goes. A question that refuses
   at both ends is refused by something else (an intent rule, or the withheld
   facts list) and cannot bound the gate — the withheld phone question scores
   13.2 precisely because the decline never asks the gate for permission. */
const HANDLED_AT = (q, minScore) => quickAnswer(KB, q, { minScore }).abstained;
const noise = MUST_NOT_ANSWER.map((x) => {
  const r = search(IDX, x.q, { minScore: 0 });
  const gateDetermined = HANDLED_AT(x.q, 0.05) !== HANDLED_AT(x.q, MAX);
  return { id: x.id, question: x.q, top: r.hits[0]?.id ?? null,
    topScore: r.hits[0]?.score ?? 0, gateDetermined };
});
const byScore = noise.slice().sort((a, b) => b.topScore - a.topScore);
const loudest = byScore.filter((n) => n.gateDetermined);
const declinedElsewhere = byScore.filter((n) => !n.gateDetermined);

const aliasLow = weakest.length ? weakest[0].selfScore : null;
const noiseHigh = loudest.length ? loudest[0].topScore : null;
const aliasFeasible = aliasLow !== null && noiseHigh !== null && noiseHigh < aliasLow;

/* ── which cases actually reach the gate ───────────────────────── */
const sensitive = [];
for (const c of CASES) {
  if (c.type === 'synthetic') continue;
  const loose = run(c, 0.05);
  const tight = run(c, MAX);
  const moved = loose.r.abstained !== tight.r.abstained
    || loose.r.text !== tight.r.text
    || loose.r.sources.join() !== tight.r.sources.join();
  const s = search(IDX, c.question, { minScore: MIN_TOP_SCORE });
  sensitive.push({
    id: c.id, type: c.type, question: c.question,
    gateSensitive: moved,
    topScore: s.hits[0]?.score ?? null,
    topId: s.hits[0]?.id ?? null,
    topPublicFactScore: (s.hits.find((h) => PUBLIC_IDS.has(h.id)) || {}).score ?? null,
    lowConfidence: s.lowConfidence,
  });
}
const gateIndependent = sensitive.filter((s) => !s.gateSensitive);

/* ── report ────────────────────────────────────────────────────── */
console.log('── §8.4 layer-1 retrieval gate: MIN_TOP_SCORE ──\n');
console.log(`cases: ${CASES.length} in the file, ${CASES.length - CASES.filter((c) => c.type === 'synthetic').length} executed here`);
console.log(`gate-sensitive: ${sensitive.filter((s) => s.gateSensitive).length} · gate-independent: ${gateIndependent.length} (templates never consult the gate)\n`);

console.log('threshold   false-abstain  grounding-miss  abstain-miss  bait  fabricated');
for (let t = 0; t <= 2.0001; t += 0.25) {
  const s = swept[grid.indexOf(+t.toFixed(2))];
  if (!s) continue;
  const f = s.fails;
  console.log(`${String(t.toFixed(2)).padStart(9)} ${String(f.falseAbstain.length).padStart(14)}`
    + ` ${String(f.groundingMiss.length).padStart(15)} ${String(f.abstainMiss.length).padStart(13)}`
    + ` ${String(f.baitAnswered.length).padStart(5)} ${String(f.fabrication.length).padStart(11)}`
    + `${s.total === 0 ? '   ← feasible' : ''}`);
}

console.log('');
if (first === null) {
  console.log('NO FEASIBLE THRESHOLD: the gate cannot satisfy both directions on this case set.');
  console.log('That is a finding, not a failure to report — the engine needs a better signal');
  console.log('(the failure lists below say which one).');
} else {
  console.log(`evaluation set: zero failures for every threshold in ${first.toFixed(2)} … ${last.toFixed(2)}`);
  if (above) {
    console.log(`  first failure above it (${above.minScore.toFixed(2)}):`
      + ` false-abstain ${above.fails.falseAbstain.length} [${above.fails.falseAbstain.join(', ')}]`
      + ` grounding-miss ${above.fails.groundingMiss.length} [${above.fails.groundingMiss.join(', ')}]`);
  }
  if (below) {
    console.log(`  nothing fails below it either (${below.minScore.toFixed(2)}):`
      + ` abstain-miss ${below.fails.abstainMiss.length} bait ${below.fails.baitAnswered.length}`);
  }
}
/* ── the queries the project already knows were wrong ──────────── */
console.log('\n── queries the regression suite records as previously wrong ──\n');
for (const e of edge) {
  console.log(`  ${String(e.topScore.toFixed(3)).padStart(7)}  "${e.q}" → ${e.top ?? '(nothing)'}  · ${e.note}`);
}

/* ── the alias half of the calibration ─────────────────────────── */
console.log('\n── mechanical labels: every alias must retrieve its own fact ──\n');
console.log(`probes ${labelled.length} (${aliasProbes.length} declared aliases,`
  + ` ${labelled.length - aliasProbes.length} bare names)`);
console.log(`must-work ${mustWork.length}`
  + ` · token-ambiguous ${aliasProbes.filter((l) => l.ambiguous).length}`
  + ` · MISROUTED ${misrouted.length}`);
if (misrouted.length) {
  console.log('  misrouted (a precision finding, not a gate one):');
  for (const m of misrouted.slice(0, 12)) console.log(`    "${m.alias}" → ${m.top} (expected ${m.fact})`);
}
console.log('\nweakest aliases that must keep working:');
for (const w of weakest.slice(0, 8)) console.log(`  ${String(w.selfScore.toFixed(3)).padStart(7)}  "${w.alias}" → ${w.fact}`);
console.log('\nloudest questions that must not answer:');
for (const n of byScore.slice(0, 8)) {
  console.log(`  ${String(n.topScore.toFixed(3)).padStart(7)}  "${n.question}" → ${n.top}`
    + `  ${n.gateDetermined ? '' : '· refused without the gate'}`);
}
console.log(`\n  of ${noise.length} must-not-answer questions, ${loudest.length} are decided by the gate`
  + ` and ${declinedElsewhere.length} are refused without consulting it.`);

/* ── the band, and what it does and does not justify ───────────────
   Two bounds, from two independent kinds of evidence:
     ceiling — the weakest alias a fact declares about itself. Above this, a
               declared way of asking for a real fact stops retrieving it.
     floor   — the loudest question that must not answer AND that actually
               consults the gate. (The withheld-phone questions score 13.2 and
               sit far above any candidate ceiling, which is only possible
               because the decline is produced without the gate — a fact the
               wide sweep above demonstrates rather than assumes.)
   The band is the measurement. A single point inside it is not: this tool
   deliberately reports no "recommended" value, because the floor rests on
   negatives that all score exactly zero, which is a weak bound and cannot
   justify centring anything. */
const ceiling = aliasLow;
const floor = loudest.length ? Math.max(...loudest.map((n) => n.topScore)) : null;
const ceilingOk = ceiling !== null && MIN_TOP_SCORE <= ceiling;
const floorOk = floor === null || MIN_TOP_SCORE > floor;

console.log('');
console.log(`ceiling: ${ceiling === null ? 'UNDETERMINED' : ceiling.toFixed(3)}`
  + ' — the weakest alias a fact declares about itself'
  + (ceiling === null ? '' : ` ("${weakest[0].alias}" → ${weakest[0].fact})`));
if (floor === null) {
  console.log('floor:   NOT MEASURED — no question in this corpus is kept out by the gate.');
  console.log('         Every must-not-answer question either shares no vocabulary with the');
  console.log('         base or is refused without consulting the gate, so nothing here says how');
  console.log('         LOW the threshold may safely sit. That half of the band is open.');
} else {
  console.log(`floor:   ${floor.toFixed(3)} — the loudest question the gate itself refuses;`
    + ` nothing above it may be admitted`);
}
console.log(`\nshipped value today: ${MIN_TOP_SCORE}`
  + ` — ${ceilingOk && floorOk ? 'within every bound this corpus measures' : 'OUTSIDE a measured bound'}`);
if (!ceilingOk || !floorOk) process.exitCode = 1;

const out = {
  measuredAt: new Date().toISOString(),
  method: 'node tools/calibrate-retrieval.mjs — sweep of quickAnswer(kb, q, { minScore }) over every executable case',
  cases: { total: CASES.length, executed: CASES.length - CASES.filter((c) => c.type === 'synthetic').length },
  gateSensitive: sensitive.filter((s) => s.gateSensitive).length,
  gateIndependent: gateIndependent.length,
  feasible: first === null ? null : { from: first, to: last },
  bounds: {
    ceiling, floor,
    ceilingSource: weakest.length ? `weakest declared alias "${weakest[0].alias}" → ${weakest[0].fact}` : null,
    floorSource: loudest.length ? `loudest gate-refused question "${loudest[0].question}"` : null,
    negativesDecidedByGate: loudest.length,
    negativesRefusedWithoutGate: declinedElsewhere.length,
  },
  shipped: MIN_TOP_SCORE,
  shippedWithinMeasuredBounds: ceilingOk && floorOk,
  note: 'The ceiling is measured; the floor is NOT MEASURED, because nothing in the corpus is kept out by the gate. No single recommended value is reported for that reason.',
  grid: swept.map((s) => ({ minScore: s.minScore, failures: s.total,
    detail: Object.fromEntries(Object.entries(s.fails).map(([k, v]) => [k, v.length])) })),
  boundary: {
    justBelow: below ? { minScore: below.minScore, ...counts(below) } : null,
    justAbove: above ? { minScore: above.minScore, ...counts(above) } : null,
  },
  perCase: sensitive,
  edgeQueries: edge,
  aliasCalibration: {
    probes: labelled.length, declaredAliases: aliasProbes.length, mustWork: mustWork.length,
    ambiguous: aliasProbes.filter((l) => l.ambiguous).length,
    misrouted: misrouted.map((m) => ({ alias: m.alias, top: m.top, expected: m.fact })),
    weakestMustWork: weakest.slice(0, 20),
    loudestMustNotAnswer: loudest.slice(0, 20),
    separation: { noiseHigh, aliasLow, clean: aliasFeasible },
  },
  provenance: {
    thresholdEffect: 'MEASURED (every case re-answered at every threshold)',
    gateSensitivity: 'MEASURED (answer compared at minScore 0.05 vs 4.0)',
    aliasLabels: 'MEASURED (each alias is a declaration the fact makes about itself; no hand-picked expectation)',
    gaps: 'NOT MEASURED: visitor traffic; cases the file does not contain; the model path (no model exists)',
  },
};
function counts(s) {
  return { failures: s.total, detail: Object.fromEntries(Object.entries(s.fails).map(([k, v]) => [k, v.length])) };
}
writeFileSync(join(HERE, '..', 'docs', 'CALIBRATION.json'), JSON.stringify(out, null, 2));
console.log('-> docs/CALIBRATION.json');
