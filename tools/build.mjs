#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   tools/build.mjs — the production bundle (§9.3 / §17 data hygiene)

     npm run build          → dist/
     npm run preview        → serve dist/ on :5580

   Two things make this a real build step rather than a copy:

   1. **`knowledge.json` ships as `publicView()` only.** The engines already
      refuse to reach a `public:false` fact (`ai/knowledge/view.mjs`, enforced
      by tests), but the *repository* still contained the withheld phone
      number, so a deployment published it to every visitor. Here it is
      removed from the file that ships, and the removed facts leave behind
      **metadata only** — id and aliases, never a value — so the assistant can
      still decline specifically instead of going vague.

   2. **The bundle is scanned for every withheld value.** The scan fails the
      build when a private value appears somewhere new. `index.html` and
      `js/terminal.js` are allow-listed because the portfolio itself
      deliberately publishes the number; anything else is a mistake, and the
      build says which file and which value rather than shipping it.

   It also refuses to ship dev tooling: no `dev-*.js`, no probe output, no
   `tests/`, no `data/`, no `docs/`. The allow-list below is the whole
   contract of what a visitor can download.
   ═══════════════════════════════════════════════════════════════ */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync }
  from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicView } from '../ai/knowledge/view.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');

/** What a visitor is allowed to download, in full.
 *
 * Listed file by file rather than by top-level directory, because two of them
 * must never ship: `ai/tokenizer`, `ai/model` and `ai/data` are the Python
 * training side (the tokenizer artifact's metadata even embeds corpus paths),
 * and `knowledge/` holds the PII review and conflict notes. An earlier version
 * of this list shipped all of it — the leak scan is what caught that. */
export const SHIP_PATHS = [
  'index.html',
  'css',
  'js',
  'ai/answers',
  'ai/governor',
  'ai/intent',
  'ai/knowledge',
  'ai/language',
  'ai/retrieval',
  'ai/ui',
  'knowledge/knowledge.json',
];

/** Files the *site itself* publishes a withheld value in, on purpose.
 *  Each entry is a decision, not a default — see knowledge/PII_REVIEW.md. */
export const SITE_PUBLISHED = ['index.html', 'js/terminal.js'];

/** Dev-only references that must never reach a shipped file. */
export const DEV_ONLY_PATTERNS = [
  [/dev-[a-z-]+\.(js|mjs)/, 'references a dev-*.js probe/tool'],
  [/(^|[^.\w])shots\//, 'references the shots/ screenshot directory'],
  [/localhost:5577/, 'hardcodes the dev server port'],
  [/training\/checkpoints/, 'references training checkpoints'],
  [/data\/raw|data\/processed/, 'references the raw corpus directories'],
];

/**
 * Split a source file into "code only" and "comments only" views.
 *
 * A mention inside a comment is documentation, not a shipped dependency — a
 * comment may reasonably say "run dev-visual-probe.js after changing this".
 * Only an executable reference is a build failure. A line-based heuristic is
 * not enough (block comments wrap, and the second line of one looks like
 * code), so this walks the text keeping comment and string state: line and
 * block comments become comment, and quoted strings are skipped so a URL
 * inside a string is never mistaken for a comment.
 */
/* Named so the three quote characters never appear escaped in a regex or a
   string literal — a build script that cannot parse its own quote handling is
   not a build script you can trust with a leak check. */
const QUOTES = {
  double: String.fromCharCode(34),
  single: String.fromCharCode(39),
  backtick: String.fromCharCode(96),
};

export function maskSource(text) {
  let code = '';
  let comments = '';
  let i = 0;
  let state = 'code';

  const push = (ch, isComment) => { (isComment ? (comments += ch) : (code += ch)); };
  const blank = (ch) => { code += ch === '\n' ? '\n' : ' '; comments += ch === '\n' ? '\n' : ' '; };

  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (state === 'code') {
      if (two === '/*') { blank('/'); blank('*'); i += 2; state = 'block'; continue; }
      if (two === '//') { blank('/'); blank('/'); i += 2; state = 'line'; continue; }
      const ch = text[i];
      if (ch === QUOTES.double || ch === QUOTES.single || ch === QUOTES.backtick) {
        push(ch, false); i += 1;
        while (i < text.length && text[i] !== ch) {
          if (text[i] === '\\') { push(text[i], false); i += 1; }
          /* a template literal may span lines: keep the newline on both
             sides so line numbers in a report still line up */
          if (text[i] === '\n') blank('\n'); else push(text[i], false);
          i += 1;
        }
        if (i < text.length) { push(ch, false); i += 1; }
        continue;
      }
      push(ch, false); i += 1;
      continue;
    }
    if (state === 'line') {
      if (text[i] === '\n') { blank('\n'); i += 1; state = 'code'; } else { push(text[i], true); i += 1; }
      continue;
    }
    if (two === '*/') { blank('/'); blank('*'); i += 2; state = 'code'; continue; }
    if (text[i] === '\n') blank('\n'); else push(text[i], true);
    i += 1;
  }
  return { code, comments };
}

/* ── knowledge stripping ────────────────────────────────────────── */

/** Every fact marked `public:false`, with its value. Metadata ids alone
 *  are not enough: the value is what must not ship. */
export function collectPrivateFacts(kb) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string' && node.public === false) {
      const value = node.value ?? node.url ?? node.name ?? node.text;
      if (typeof value === 'string' && value.trim()) {
        found.push({ id: node.id, value: value.trim(), aliases: node.aliases || [] });
      } else {
        found.push({ id: node.id, value: null, aliases: node.aliases || [] });
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(kb);
  return found;
}

/**
 * The knowledge base as it ships: `publicView()` plus a record of what was
 * withheld (ids and aliases — the runtime needs to *name* a refusal, never to
 * answer with a value).
 */
export function stripKnowledge(kb, { builtAt = new Date().toISOString() } = {}) {
  const privateBefore = collectPrivateFacts(kb);
  const stripped = publicView(kb);
  const removed = privateBefore.map(({ id, aliases }) => ({ id, aliases }));

  stripped.meta = {
    ...(stripped.meta || {}),
    shipped: {
      stripped: true,
      built_at: builtAt,
      source_version: kb?.meta?.version ?? null,
      removed_fact_ids: removed.map((f) => f.id),
      rule: 'public:false facts are removed from this file entirely; only their ids '
          + 'and aliases remain so the assistant can decline by name (§1 / §17).',
    },
    withheld_facts: removed,
  };
  return { knowledge: stripped, removed, privateBefore };
}

/* ── leak scanning ─────────────────────────────────────────────── */

const digits = (s) => String(s).replace(/\D/g, '');

/**
 * Is `value` present in `text`? Numeric values are compared digit-wise, so
 * `+91 6280287425` is caught inside `+91 62802 87425` — a format change must
 * not be a way past the check.
 */
export function containsValue(text, value) {
  if (!value) return false;
  if (text.includes(value)) return true;
  const valueDigits = digits(value);
  if (valueDigits.length >= 6 && digits(text).includes(valueDigits)) return true;
  return false;
}

/**
 * Leaks that must stop the build, i.e. every one outside the deliberate
 * allow-list. Split out from the build so the policy can be tested without
 * building a bundle.
 */
export function blockingLeaks(found, allowlist = SITE_PUBLISHED) {
  return found.filter((l) => !allowlist.includes(l.path));
}

/** `[{path, id, value}]` for every file that publishes a withheld value. */
export function scanForPrivateValues(files, privateFacts) {
  const found = [];
  for (const file of files) {
    const text = readFileSync(file.abs, 'utf8');
    for (const fact of privateFacts) {
      if (containsValue(text, fact.value)) {
        found.push({ path: file.rel, id: fact.id, value: fact.value });
      }
    }
  }
  return found;
}

export function scanForDevReferences(files) {
  const failures = [];
  const notes = [];
  const seen = new Set();
  for (const file of files) {
    if (!/\.(js|mjs|html|css|json)$/.test(file.rel)) continue;
    const { code, comments } = maskSource(readFileSync(file.abs, 'utf8'));
    for (const [pattern, why] of DEV_ONLY_PATTERNS) {
      const inCode = code.match(pattern);
      if (inCode) failures.push({ path: file.rel, why, sample: inCode[0] });
      else {
        const inComment = comments.match(pattern);
        const key = `${file.rel}:${why}:${inComment?.[0] ?? ''}`;
        if (inComment && !seen.has(key)) {
          seen.add(key);
          notes.push({ path: file.rel, why, sample: inComment[0] });
        }
      }
    }
  }
  return { failures, notes };
}

/**
 * Every relative import in the shipped ES modules must resolve *inside* the
 * bundle. A missing module is otherwise a 404 that only shows up when a
 * visitor clicks the assistant — the exact failure mode the P2 dev-server MIME
 * bug had, but in production.
 */
export function checkImports(files) {
  const problems = [];
  const present = new Set(files.map((f) => f.rel));
  const IMPORT_RE = /(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g;
  const SCRIPT_RE = /<script[^>]+src=["']([^"']+)["']/g;

  for (const file of files) {
    if (!/\.(js|mjs|html)$/.test(file.rel)) continue;
    const text = readFileSync(file.abs, 'utf8');
    const dir = file.rel.split('/').slice(0, -1);
    const specs = [];
    for (const m of text.matchAll(IMPORT_RE)) specs.push(m[1] || m[2]);
    for (const m of text.matchAll(SCRIPT_RE)) specs.push(m[1]);
    for (const spec of specs) {
      if (!spec || !(spec.startsWith('./') || spec.startsWith('../'))) continue;
      const parts = [...dir];
      for (const segment of spec.split('/')) {
        if (segment === '.' || segment === '') continue;
        if (segment === '..') parts.pop();
        else parts.push(segment);
      }
      const rel = parts.join('/');
      if (!present.has(rel)) problems.push(`${file.rel} imports ${spec} → ${rel} is not in the bundle`);
    }
  }
  return problems;
}

/* ── bundling ──────────────────────────────────────────────────── */

function listFiles(root, absDir, out = []) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) listFiles(root, abs, out);
    else out.push({ abs, rel: relative(root, abs).split(sep).join('/') });
  }
  return out;
}

/**
 * Build `dist/`. Throws (after printing every problem) rather than shipping
 * a bundle with a withheld value or a dev reference in it.
 */
export function buildBundle({ root = ROOT, out = join(ROOT, 'dist'), quiet = false } = {}) {
  const log = (...args) => { if (!quiet) console.log(...args); };
  const knowledgePath = join(root, 'knowledge', 'knowledge.json');
  const kb = JSON.parse(readFileSync(knowledgePath, 'utf8'));

  const { knowledge, removed, privateBefore } = stripKnowledge(kb);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const copied = [];
  for (const entry of SHIP_PATHS) {
    const abs = join(root, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      cpSync(abs, join(out, entry), { recursive: true });
      copied.push(...listFiles(out, join(out, entry)).map((f) => ({
        ...f,
        rel: relative(out, f.abs).split(sep).join('/'),
      })));
    } else {
      const target = join(out, entry);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(abs, target);
      copied.push({ abs: target, rel: entry });
    }
  }

  /* the shipped knowledge base is the stripped one, and nothing else */
  const shippedRel = 'knowledge/knowledge.json';
  const shippedAbs = join(out, shippedRel);
  const serialized = JSON.stringify(knowledge, null, 2) + '\n';
  writeFileSync(shippedAbs, serialized, 'utf8');
  const knowledgeFile = { abs: shippedAbs, rel: shippedRel };
  const other = copied.filter((f) => f.rel !== shippedRel);

  const problems = [];

  /* 1. the shipped file must not contain a single withheld value */
  const selfLeaks = scanForPrivateValues([knowledgeFile], privateBefore);
  if (selfLeaks.length) {
    problems.push(...selfLeaks.map((l) => `shipped knowledge.json still contains ${l.id}: ${l.value}`));
  }

  /* 2. no *other* file may publish a withheld value unless allow-listed */
  const valueLeaks = blockingLeaks(scanForPrivateValues(other, privateBefore));
  if (valueLeaks.length) {
    problems.push(...valueLeaks.map((l) =>
      `${l.path} publishes withheld value ${l.id} (${l.value}) — add it to SITE_PUBLISHED only if that is deliberate`));
  }
  const deliberate = scanForPrivateValues(other, privateBefore)
    .filter((l) => SITE_PUBLISHED.includes(l.path));

  /* 3. no dev tooling references (comment mentions are notes, not failures) */
  const { failures: devRefs, notes: devNotes } = scanForDevReferences(other);
  if (devRefs.length) {
    problems.push(...devRefs.map((d) => `${d.path} ${d.why}: ${d.sample}`));
  }

  /* 4. every shipped module must resolve inside the bundle */
  problems.push(...checkImports([knowledgeFile, ...other]));

  /* 5. the strip must have done something, and left structure behind */
  if (removed.length === 0) {
    problems.push('the knowledge base has no public:false facts — the strip is unverifiable, '
                + 'which usually means the public flags were lost');
  }
  const strippedJson = JSON.stringify(knowledge);
  if (/"public":\s*false/.test(strippedJson)) {
    problems.push('shipped knowledge.json still declares a public:false fact');
  }

  const files = [knowledgeFile, ...other];
  const bytes = files.reduce((sum, f) => sum + statSync(f.abs).size, 0);
  const sha256 = createHash('sha256').update(serialized).digest('hex');

  log(`built ${relative(ROOT, out) || out}`);
  log(`  files            ${files.length}`);
  log(`  bytes            ${bytes.toLocaleString()}`);
  log(`  knowledge.json   ${serialized.length.toLocaleString()} B  sha256 ${sha256.slice(0, 16)}…`);
  log(`  withheld facts   ${removed.map((f) => f.id).join(', ') || 'none'} (ids + aliases kept, values removed)`);
  for (const d of deliberate) {
    log(`  note             ${d.path} publishes ${d.id} deliberately (site content, allow-listed)`);
  }
  for (const n of devNotes) {
    log(`  note             ${n.path} mentions ${n.sample} in a comment (not shipped behaviour)`);
  }
  if (problems.length) {
    console.error(`\nBUILD FAILED — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  · ${p}`);
    throw new Error('build refused: the bundle would ship something it must not');
  }
  log('  verdict          clean — no withheld value, no dev tooling');

  return { out, files: files.map((f) => f.rel), bytes, sha256, removed, deliberate, notes: devNotes };
}

export function main(argv = process.argv.slice(2)) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? resolve(argv[outIndex + 1]) : join(ROOT, 'dist');
  const quiet = argv.includes('--quiet');
  try {
    buildBundle({ out, quiet });
    return 0;
  } catch (error) {
    if (!quiet) console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
