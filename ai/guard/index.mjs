/* ═══════════════════════════════════════════════════════════════
   ai/guard/index.mjs — the Faithfulness Guard (§8.4 layer 4)

   The last line of defence between a generated answer and the visitor.
   §8.4 names exactly what must be checked:

     "every URL / email / number / date / tech name / project name /
      company in the output must appear (normalized) in the retrieved
      context or a small allowlist; language must match; length cap."

   This module is that check, and nothing more: it never generates, never
   rewrites and never guesses. It answers one question per claim — *is this
   thing in front of the model?* — and returns every claim it could not
   ground. The caller decides what to do (§5.1 step 5: one greedy retry with
   a shorter context, and then a refusal — see `fallback` below).

   Why it exists before the model does
   -----------------------------------
   The rest of the anti-hallucination policy is either data (placeholders,
   retrieval) or training (§7.4 counterfactual contexts). The *runtime*
   check is the only one that can be written, tested and pinned while there
   is still no checkpoint — and writing it last is how it becomes a
   post-hoc rubber stamp instead of a gate. Its inputs are strings, so
   `tests/guard.test.mjs` drives it with fixtures and no inference.

   What it deliberately does NOT do
   --------------------------------
   · No embeddings, no fuzzy matching, no "close enough". A guard that
     accepts a near-miss is a guard that accepts the hallucination.
     Grounding is substring/equality on a normalized form, so the failure
     is always in the safe direction (an ungrounded claim is rejected).
   · No claim extraction from the *context* — only from the output. The
     context is trusted; the output is not.
   · It cannot see wasm-compressed or re-spelled values. A number written
     in words ("five years") is not caught here; §7.2's placeholder rule
     (numbers are never generated character by character) is what makes
     that case vanishingly rare, and this is recorded as a limit rather
     than papered over with a word-to-number table that would need its own
     tests to be trustworthy.

   Degrade order (§5.1 step 5), implemented in `guardedAnswer`:
     1. generate over the retrieved context  → guard → ok? done
     2. one greedy retry over a SHORTER context → guard → ok? done
     3. `fallback()`, if the caller gave one — or `guardFailed: true`

   Step 3 is the caller's. It used to be the extractive Quick Answer, and the
   only caller passed exactly that; the answer path now passes *nothing* and
   turns `guardFailed` into a refusal, because a template standing in for a
   rejected generation reads as an answer that passed a check it did not pass.
   ═══════════════════════════════════════════════════════════════ */

import { detectLanguage } from '../language/detect.mjs';
import { PLACEHOLDER_PATTERN } from '../knowledge/placeholders.mjs';

/** The violation codes, as data so tests and callers name them identically. */
export const GUARD_CODES = Object.freeze({
  PLACEHOLDER: 'unresolved_placeholder',
  URL: 'url_not_grounded',
  EMAIL: 'email_not_grounded',
  NUMBER: 'number_not_grounded',
  DATE: 'date_not_grounded',
  ENTITY: 'entity_not_grounded',
  LANGUAGE: 'language_mismatch',
  LENGTH: 'too_long',
  EMPTY: 'empty_answer',
});

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()[\]"']+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/* a maximal digit run that may carry internal grouping separators, so
   "8.28", "1,200" and "90+" each fingerprint to one number instead of
   splitting at the punctuation. Letters terminate a run, so "2021 to 2023"
   is two numbers and "3 projects" is one. */
const NUMBER_RUN_RE = /\d+(?:[\s,.\u2013-]*\d+)*/g;

/* ── normalization ─────────────────────────────────────────────── */

/**
 * One canonical form for every textual comparison. NFKC folds the many
 * Unicode spellings a model may emit (full-width digits, curly quotes) onto
 * the same characters; lower-casing makes matching case-insensitive; the
 * whitespace collapse makes "React  JS" and "react js" the same claim.
 */
export function normalizeClaim(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B]/g, "'")   /* curly → straight apostrophe */
    .replace(/\s+/g, ' ')
    .trim();
}

/** Digits-only fingerprint of a number-shaped string ("8.28" → "828"). */
export function numberKey(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** Every number run in `text`, fingerprinted. Order-preserving, deduped. */
export function numbersIn(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(NUMBER_RUN_RE)) {
    const key = numberKey(m[0]);
    if (key && !seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}

/** Strip the parts of a URL that are not the claim: scheme, `www.`, a
 *  trailing slash or query-less punctuation. */
export function urlKey(value) {
  return normalizeClaim(value)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[.,;:)\]}"']+$/, '')
    .replace(/\/+$/, '');
}

/** Two-digit month fields found in ISO-style dates, so a month named in the
 *  output is grounded by `2023-01` as well as by `Jan 2023`. */
export function isoMonthNumbers(text) {
  const out = new Set();
  const src = String(text ?? '');
  for (const m of src.matchAll(/\b\d{4}-(\d{2})-(\d{2})\b/g)) out.add(m[1]);
  for (const m of src.matchAll(/\b\d{1,2}[-/](\d{1,2})[-/]\d{2,4}\b/g)) {
    out.add(String(m[1]).padStart(2, '0'));
  }
  return out;
}

/** A word-boundary-aware containment test that tolerates the spaces inside
 *  a multi-word term ("Smart Grocery List Generator"). */
export function containsTerm(haystackNorm, termNorm) {
  if (!termNorm) return false;
  let from = 0;
  for (;;) {
    const at = haystackNorm.indexOf(termNorm, from);
    if (at === -1) return false;
    const before = at === 0 ? ' ' : haystackNorm[at - 1];
    const after = haystackNorm[at + termNorm.length] ?? ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

/**
 * Everything in `text` that makes a factual claim, per §8.4's own list.
 * @returns {{urls:string[], emails:string[], numbers:string[],
 *            months:string[], years:string[]}}
 */
export function extractClaims(text) {
  const raw = String(text ?? '');
  const evidence = raw.replace(new RegExp(PLACEHOLDER_PATTERN, 'g'), '');
  const uniq = (arr) => [...new Set(arr)];

  const years = [];
  const numbers = [];
  for (const m of evidence.matchAll(NUMBER_RUN_RE)) {
    const key = numberKey(m[0]);
    if (!key) continue;
    if (/^(?:19|20)\d{2}$/.test(key)) years.push(key);
    else numbers.push(key);
  }

  return {
    urls: uniq([...evidence.matchAll(URL_RE)].map((m) => m[0])),
    emails: uniq([...evidence.matchAll(EMAIL_RE)].map((m) => m[0])),
    numbers: uniq(numbers),
    months: uniq([...evidence.matchAll(MONTH_RE)].map((m) => m[1].toLowerCase())),
    years: uniq(years),
  };
}

/* ── the knowledge vocabulary ─────────────────────────────────── */

/**
 * The named things a model could invent: tech names, project names,
 * institutions, certifications, the person's name. Built from the knowledge
 * base so it travels with the data — a new project is guarded the moment it
 * is added, with no second hand-written list to drift.
 *
 * Kept deliberately to *proper* names. Editorial prose (a summary, a note)
 * is not vocabulary: its individual words are ordinary English and flagging
 * them would reject correct answers.
 */
export function buildVocabulary(kb) {
  const terms = new Set();
  const add = (v) => {
    const n = normalizeClaim(v);
    if (n && n.length >= 2) terms.add(n);
  };
  const addList = (list) => (list || []).forEach((v) => add(v));

  add(kb?.person?.name);
  for (const p of kb?.projects || []) { add(p.name); addList(p.tech); }
  for (const s of kb?.skills || []) add(s.name);
  for (const e of kb?.education || []) { add(e.institution); add(e.degree); add(e.field); }
  for (const c of kb?.certifications || []) { add(c.name); add(c.issuer); }
  for (const x of kb?.experience || []) add(x.title);
  /* Whole names only — never their individual words. "REST APIs" is a
     technology; "rest" is an ordinary English word, and "Smart Grocery List
     Generator" must not put "list" into the vocabulary. Splitting names
     would make this guard reject correct prose, and a guard that fires on
     ordinary words is worse than one with a known blind spot (a tech named
     in a spelling the base does not record). Terms shorter than three
     characters are dropped because "C" and "Go" are not claims. */
  const out = new Set();
  for (const t of terms) if (t.length >= 3) out.add(t);
  return out;
}

/**
 * The small allowlist §8.4 permits. It is intentionally tiny: the person's
 * own name (a portfolio assistant naming its subject is not a claim about
 * the world) and nothing else. Every other value must be earned by the
 * retrieved context.
 */
export function defaultAllowlist(kb) {
  const out = [];
  const name = normalizeClaim(kb?.person?.name);
  if (!name) return out;
  out.push(name);
  /* every part of his own name, so "Kumar" or "Aashish" alone is never a
     fabricated entity — the assistant naming its subject is not a claim */
  for (const word of name.split(/\s+/)) if (word.length >= 3) out.push(word);
  return out;
}

/* ── the check ────────────────────────────────────────────────── */

/** Flatten whatever the retrieval layer produced into one searchable form.
 *  Accepts an array of chunk objects (`{text}` / `{title}` / `{body}`), an
 *  array of strings, or a single string. */
export function contextText(context) {
  if (context == null) return '';
  const parts = Array.isArray(context) ? context : [context];
  return parts.map((c) => {
    if (typeof c === 'string') return c;
    if (!c) return '';
    return [c.title, c.heading, c.text, c.body, c.summary]
      .filter(Boolean).join(' ');
  }).join('\n');
}

/**
 * Language consistency (§8.3 / §14). The rule is script-shaped because that
 * is the failure that actually happens: a Hindi question answered in English,
 * or an English question answered in Hindi.
 *
 *   hi        → must carry Devanagari (a Hindi answer without it is not Hindi)
 *   en        → must not be Devanagari-dominant
 *   hinglish  → Roman script, so also must not be Devanagari-dominant
 *
 * Hinglish is *Roman* Hindi mixed with English; punishing it for containing
 * English function words would reject the only correct answer it can give.
 */
export function languageMatches(text, expected) {
  const d = detectLanguage(text);
  if (expected === 'hi') return d.devRatio >= 0.10;
  return d.devRatio < 0.55;
}

/**
 * Run every §8.4 layer-4 check over one generated answer.
 *
 * @param {string} text   the answer, AFTER placeholder resolution
 * @param {object} opts
 * @param {Array|string} opts.context  retrieved context (grounding evidence)
 * @param {'en'|'hi'|'hinglish'} [opts.lang] expected language of the answer
 * @param {object} [opts.kb]           knowledge base, for the vocabulary
 * @param {Set<string>} [opts.vocabulary] override (defaults from `kb`)
 * @param {string[]} [opts.allow]      extra allowlisted groundings
 * @param {number} [opts.maxChars=1200] §8.4 length cap
 * @returns {{ok:boolean, violations:Array<{code:string, token:string, detail:string}>}}
 */
export function guard(text, opts = {}) {
  const answer = String(text ?? '');
  const maxChars = opts.maxChars ?? 1200;
  const violations = [];
  const add = (code, token, detail) => violations.push({ code, token: String(token), detail });

  if (!answer.trim()) {
    add(GUARD_CODES.EMPTY, '', 'the answer is empty');
    return { ok: false, violations };
  }

  /* 1. a placeholder that never resolved is an unverified value by
        definition — it means the model named a fact the app cannot render */
  const leftover = [...answer.matchAll(new RegExp(PLACEHOLDER_PATTERN, 'g'))]
    .map((m) => m[1].trim());
  for (const id of new Set(leftover)) {
    add(GUARD_CODES.PLACEHOLDER, id, 'the model emitted a placeholder the app could not resolve');
  }

  /* 2. length cap (§8.4) — a small model that runs on becomes an essay */
  if (answer.length > maxChars) {
    add(GUARD_CODES.LENGTH, String(answer.length), `answer exceeds the ${maxChars}-character cap`);
  }

  /* 3. language must match the visitor's latest message (§8.3/§14) */
  if (opts.lang && !languageMatches(answer, opts.lang)) {
    add(GUARD_CODES.LANGUAGE, opts.lang, `the answer is not in the requested language (${opts.lang})`);
  }

  /* 4. grounding. Evidence = retrieved context ∪ allowlist. The §8.4
        allowlist is the caller's plus the default one — his own name is
        always speakable, and forgetting to pass it must not turn every
        answer into a violation. */
  const allowNorm = [
    ...(opts.kb ? defaultAllowlist(opts.kb) : []),
    ...(opts.allow || []),
  ].map(normalizeClaim);
  const ctxNorm = normalizeClaim(contextText(opts.context));
  const hayNorm = `${ctxNorm} ${allowNorm.join(' ')}`.trim();
  const hayNumbers = new Set(numbersIn(hayNorm));

  const claims = extractClaims(answer);
  for (const url of claims.urls) {
    const key = urlKey(url);
    if (!key || !hayNorm.includes(key)) {
      add(GUARD_CODES.URL, url, 'the URL does not appear in the retrieved context');
    }
  }
  for (const email of claims.emails) {
    if (!hayNorm.includes(normalizeClaim(email))) {
      add(GUARD_CODES.EMAIL, email, 'the email does not appear in the retrieved context');
    }
  }
  for (const n of claims.numbers) {
    if (!hayNumbers.has(n)) {
      add(GUARD_CODES.NUMBER, n, 'the number does not appear in the retrieved context');
    }
  }
  for (const y of claims.years) {
    if (!hayNumbers.has(y)) {
      add(GUARD_CODES.DATE, y, 'the year does not appear in the retrieved context');
    }
  }
  /* a month is grounded by its name in the context or by the month field of
     a date the context spells numerically (a chunk may pair the pretty form
     with the ISO form, and a model answering "Jan 2023" from "2023-01" is
     doing the right thing) */
  const ctxMonths = new Set([...ctxNorm.matchAll(MONTH_RE)].map((m) => m[1].toLowerCase()));
  const ctxMonthNums = isoMonthNumbers(ctxNorm);
  for (const mo of claims.months) {
    const num = String(MONTHS.indexOf(mo) + 1).padStart(2, '0');
    if (!ctxMonths.has(mo) && !ctxMonthNums.has(num)) {
      add(GUARD_CODES.DATE, mo, 'the month does not appear in the retrieved context');
    }
  }

  /* 5. named entities. A vocabulary hit in the output that is not in the
        context and not allowlisted is a fabricated technology, project,
        institution or certification. */
  const vocab = opts.vocabulary || (opts.kb ? buildVocabulary(opts.kb) : new Set());
  const ansNorm = normalizeClaim(answer);
  for (const term of vocab) {
    if (!containsTerm(ansNorm, term)) continue;
    if (containsTerm(hayNorm, term)) continue;
    add(GUARD_CODES.ENTITY, term, 'the named entity does not appear in the retrieved context');
  }

  return { ok: violations.length === 0, violations };
}

/* ── the §5.1 step-5 orchestration ────────────────────────────── */

/** Drop the weakest tails of a context so a retry sees less to over-fit.
 *
 * Two shapes arrive here. A caller that passes an *array* of chunks gets the
 * leading `keep` fraction of them. The shipped answer path passes ONE string
 * of `[id] value` lines, and treating that as a one-element array returned it
 * unchanged — so §5.1 step 5's "one greedy retry over a SHORTER context" was a
 * retry over the same context, and the whole degrade step did nothing. A
 * string is therefore split into its lines and the leading fraction kept.
 *
 * A single line has nothing weaker to drop, and is returned as-is; shortening
 * it would cut a fact in half, and half a fact is a wrong fact.
 *
 * The SHAPE is preserved: an array in gives an array out, a string in gives a
 * string out. It has to be, because the caller hands the result straight back
 * to `generate()`, and a `frame()` built from an array does not join on
 * newlines — `[a, b].join(' ')` is `"a,b"`, so a two-line context came back as
 * one comma-mangled line. That survived unnoticed while the function always
 * returned a single-element array (`[x].toString()` is `x`), which is another
 * way of saying the retry never really shortened anything before. */
export function shortenContext(context, keep = 0.6) {
  const wasArray = Array.isArray(context);
  const parts = (wasArray ? context : String(context ?? '').split('\n')).filter(Boolean);
  const n = parts.length < 2 ? parts.length : Math.max(1, Math.round(parts.length * keep));
  const kept = parts.slice(0, n);
  return wasArray ? kept : kept.join('\n');
}

/**
 * §5.1 steps 4–5 as one function, with generation injected.
 *
 * ```js
 * const out = await guardedAnswer({
 *   question, context, lang, kb,
 *   generate: (ctx, { greedy }) => engine.generate(prompt(ctx), { greedy }),
 *   fallback: () => quickAnswer(kb, question, { lang }),
 * });
 * ```
 *
 * The contract: 0 violations → that answer. Otherwise ONE greedy retry over
 * a shorter context. Still bad → `fallback()` when the caller supplied one,
 * and otherwise the last attempt is returned with `guardFailed: true` so the
 * caller refuses rather than shipping it. The shipped answer path supplies no
 * fallback: it refuses, which is what the flag is for.
 *
 * `generate` may return a string or `{text}`; the retry is always told it is
 * a retry, so a caller can set greedy decoding without this module knowing
 * what a decoder is.
 *
 * `context` in the result is what the *generator* read on the accepted
 * attempt — the engine narrows it to fit the model's window, and this is the
 * value the guard was run against, so a caller can report it honestly.
 *
 * @returns {Promise<{text:string, context:Array|string, attempts:number,
 *            guardFailed:boolean, fallback:boolean, violations:object[],
 *            guard:object}>}
 */
export async function guardedAnswer(opts = {}) {
  const { generate, fallback, lang, kb, allow, maxChars, context } = opts;
  if (typeof generate !== 'function') throw new TypeError('guardedAnswer needs a generate() function');
  const vocabulary = opts.vocabulary || (kb ? buildVocabulary(kb) : new Set());

  const once = async (ctx, greedy) => {
    const produced = await generate(ctx, { greedy });
    const text = typeof produced === 'string' ? produced : String(produced?.text ?? '');
    /* A generator may read LESS than it was offered: the engine drops the tail
       of the context to fit the model's window, and reports what it kept in
       `context`. The guard has to check against THAT, not against what was
       offered — a claim resting on a line the model never saw is exactly the
       hallucination §8.4 exists to catch, and checking the offered context
       would wave it through. */
    const read = (produced && typeof produced === 'object' && produced.context !== undefined)
      ? produced.context : ctx;
    return {
      text, context: read,
      result: guard(text, { context: read, lang, kb, allow, maxChars, vocabulary }),
    };
  };

  const first = await once(context, false);
  if (first.result.ok) {
    return { text: first.text, context: first.context, attempts: 1, guardFailed: false,
      fallback: false, violations: [], guard: first.result };
  }

  const retry = await once(shortenContext(context), true);
  if (retry.result.ok) {
    return { text: retry.text, context: retry.context, attempts: 2, guardFailed: false,
      fallback: false, violations: [], guard: retry.result };
  }

  if (typeof fallback === 'function') {
    const fb = await fallback();
    const text = typeof fb === 'string' ? fb : String(fb?.text ?? '');
    return {
      text, context: retry.context, attempts: 2, guardFailed: false, fallback: true,
      violations: retry.result.violations.concat(first.result.violations),
      guard: retry.result,
    };
  }

  return {
    text: retry.text, context: retry.context, attempts: 2, guardFailed: true, fallback: false,
    violations: retry.result.violations.concat(first.result.violations),
    guard: retry.result,
  };
}
