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
  /* The engine and the tokenizer *encoder* ship (they are what runs in the
     visitor's worker); `ai/tokenizer/artifacts` and `ai/model` do not — the
     artifact is copied in by the export step under `ai/model-export/`, and
     the Python side of `ai/tokenizer` stays out. */
  'ai/engine',
  'ai/guard',
  'ai/governor',
  'ai/intent',
  'ai/knowledge',
  'ai/language',
  'ai/retrieval',
  'ai/ui',
  'ai/voice',
  'knowledge/knowledge.json',
];

/** Where `inference/export_browser.py --out ai/model-export/<version>` leaves
 *  the model. Copied when it exists; a build without it ships Quick Answers
 *  only, which is §6.2's T0 path and not an error — but the build summary
 *  says which of the two it produced. */
export const MODEL_EXPORT_DIR = 'ai/model-export';
export const MODEL_EXPORT_VERSION = 'aashish-ai-1';

/** The only files a model version directory may contribute to the bundle.
 *
 * An allow-list, not a copy of the directory. The export step also drops a
 * *parity fixture* beside the weights by default (`--reference-out`, the
 * numpy logits `tests/engine.test.mjs` compares against), and "whatever is in
 * the folder" shipped that 257 KB test artifact to every visitor. §9.3 ships
 * a runtime, weights and a tokenizer; nothing else belongs in there, and a
 * stray file is reported rather than served. */
export const MODEL_EXPORT_FILES = ['manifest.json', 'tokenizer.json'];
export const MODEL_EXPORT_SHARD = /^model-\d{5}\.bin$/;

/** Files the *site itself* publishes a withheld value in, on purpose.
 *  Each entry is a decision, not a default — see knowledge/PII_REVIEW.md. */
export const SITE_PUBLISHED = ['index.html', 'js/terminal.js'];

/** A refusal, with the reasons attached.
 *
 * The message stays short because it is also what `npm run build` prints; the
 * numbered reasons are on `.problems` so a test can assert *why* the build
 * refused instead of only that it did. */
export class BuildRefused extends Error {
  constructor(problems) {
    super('build refused: the bundle would ship something it must not');
    this.name = 'BuildRefused';
    this.problems = problems;
  }
}

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
 *
 * Regex literals are consumed as code too, and that is load-bearing rather
 * than tidy: a character class such as the one that strips apostrophes
 * contains a quote character, so a masker that only knows about strings
 * opens a "string" at that quote and swallows every comment after it. The
 * symptom was this check failing on a file that was correct, but the same
 * confusion in the other direction would report a real dependency as a
 * comment — which is the direction that ships something it must not.
 */
/* Named so the three quote characters never appear escaped in a regex or a
   string literal — a build script that cannot parse its own quote handling is
   not a build script you can trust with a leak check. */
const QUOTES = {
  double: String.fromCharCode(34),
  single: String.fromCharCode(39),
  backtick: String.fromCharCode(96),
};

/** Characters after which a `/` opens a REGEX rather than a division. */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?',
  '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', '\n']);
const REGEX_KEYWORD = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|do|else|case|await|yield)$/;

/**
 * Can a `/` at this point in the code be a regex literal?
 *
 * The distinction is the whole problem: `a / b` is division after an
 * identifier or a closing bracket, and `/x'/` is a regex after an operator.
 * Getting it wrong in the *permissive* direction is safe here (the regex body
 * is code, so a reference inside it still fails the build); getting it wrong
 * the other way is what the fix above is about.
 */
function canStartRegex(codeSoFar) {
  const trimmed = codeSoFar.replace(/\s+$/, '');
  if (!trimmed) return true;
  const last = trimmed[trimmed.length - 1];
  if (REGEX_AFTER.has(last)) return true;
  return REGEX_KEYWORD.test(trimmed);
}

/**
 * Index just past a regex literal starting at `start`, or -1 when this `/` was
 * a division. A regex cannot contain a raw newline, which is what makes a
 * wrong guess cheap to detect instead of swallowing the rest of the file.
 */
function scanRegex(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') return -1;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i + 1;
    i += 1;
  }
  return -1;
}

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
      if (ch === '/' && canStartRegex(code)) {
        const end = scanRegex(text, i);
        if (end > i) {
          for (let k = i; k < end; k++) push(text[k], false);
          i = end;
          continue;
        }
      }
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

/* ── comment stripping (the §4 budget, half of it) ───────────────
   The AI chunk's documentation is ~half of the bytes a visitor downloads,
   and gzip cannot compress it away: it is English prose, not repetition.
   MEASURED on the shipped tree — 137,272 B gz with comments, 66,799 B gz
   without, i.e. **70,473 B gz (51.3 %) of §4's 150 KB budget was being spent
   on comments** ([tools/bundle-report.mjs](bundle-report.mjs)).

   So a shipped `ai/**` script is served without comments. Nothing else
   changes: the repository keeps every word of it, `knowledge.json` is data
   (no comments to remove), and this is deliberately limited to `ai/**` —
   `js/**` is the portfolio's own film, and §2 N7 says the build must not
   touch it.

   It reuses `maskSource`, which already walks comments, strings, template
   literals and regex literals correctly, because the leak scan needed exactly
   that. The consequence is a real safety property rather than a convenience:
   the *same* walk that decides what a documentation mention is decides what
   ships, so the two can never disagree, and `tests/build-bundle.test.mjs`
   parses the stripped output as the check that it is still the same program. */

/** Is this a shipped file whose comments a visitor should not pay for? */
export function stripsComments(rel) {
  return rel.startsWith('ai/') && /\.(mjs|js)$/.test(rel);
}

/**
 * The same file with every comment replaced by whitespace.
 *
 * `maskSource` keeps the code character-for-character and preserves line
 * breaks (so automatic semicolon insertion is unaffected); the only tidying
 * afterwards is removing the now-blank tails and collapsing the runs of blank
 * lines a stripped block comment leaves behind. Lines are never joined — at
 * least one `\n` always survives — which is the only way this could have
 * changed what a browser runs.
 */
export function stripComments(text) {
  return maskSource(text).code
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** Copy one shipped file, stripping comments from the ones that carry none. */
function writeShipped(from, to, rel) {
  if (!stripsComments(rel)) { cpSync(from, to); return; }
  writeFileSync(to, stripComments(readFileSync(from, 'utf8')), 'utf8');
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
  /* The same files BEFORE stripping, kept so the dev-reference scan still
     sees the comment mentions it is supposed to report: a stripped file has
     no comments left to find, and "this comment names a dev probe" is a note
     about the source, not about the bundle. */
  const sources = [];
  for (const entry of SHIP_PATHS) {
    const abs = join(root, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      mkdirSync(join(out, entry), { recursive: true });
      for (const f of listFiles(root, abs)) {
        const target = join(out, f.rel);
        mkdirSync(dirname(target), { recursive: true });
        writeShipped(f.abs, target, f.rel);
        copied.push({ abs: target, rel: f.rel });
        sources.push(f);
      }
    } else {
      const target = join(out, entry);
      mkdirSync(dirname(target), { recursive: true });
      writeShipped(abs, target, entry);
      copied.push({ abs: target, rel: entry });
      sources.push({ abs, rel: entry });
    }
  }

  /* The exported model (§9.3), when one has been built. It is a build
     *output*, not a source file — `ai/model-export/` is git-ignored and
     produced by `inference/export_browser.py` — so a build without it is
     legitimate (Quick Answers only) and the summary says which one this is,
     instead of a deploy discovering it at runtime. */
  const modelDir = join(root, MODEL_EXPORT_DIR);
  const modelVersionDir = join(modelDir, MODEL_EXPORT_VERSION);
  const modelShipped = existsSync(join(modelVersionDir, 'manifest.json'));
  let modelBytes = 0;
  let modelSkipped = [];
  let modelIncomplete = false;
  if (modelShipped) {
    const dest = join(out, MODEL_EXPORT_DIR, MODEL_EXPORT_VERSION);
    const present = readdirSync(modelVersionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => entry.name);
    const ship = present.filter((name) => MODEL_EXPORT_FILES.includes(name)
      || MODEL_EXPORT_SHARD.test(name));
    modelSkipped = present.filter((name) => !ship.includes(name)).sort();
    modelIncomplete = !ship.some((name) => MODEL_EXPORT_SHARD.test(name));
    mkdirSync(dest, { recursive: true });
    for (const name of ship) {
      const target = join(dest, name);
      cpSync(join(modelVersionDir, name), target);
      copied.push({ abs: target,
                    rel: [MODEL_EXPORT_DIR, MODEL_EXPORT_VERSION, name].join('/') });
    }
    modelBytes = ship.reduce((n, name) => n + statSync(join(dest, name)).size, 0);
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

  /* 3. no dev tooling references (comment mentions are notes, not failures).
        Scanned on the SOURCE, because the shipped `ai/**` files have had
        their comments removed before this point — a note about a comment
        would otherwise be unreportable, and a real code reference still
        fails because the code is character-identical. */
  const { failures: devRefs, notes: devNotes } = scanForDevReferences(sources);
  if (devRefs.length) {
    problems.push(...devRefs.map((d) => `${d.path} ${d.why}: ${d.sample}`));
  }

  /* 4. every shipped module must resolve inside the bundle */
  problems.push(...checkImports([knowledgeFile, ...other]));

  /* 4b. a model manifest with no shard would serve a loader that 404s */
  if (modelIncomplete) {
    problems.push(`${MODEL_EXPORT_DIR}/${MODEL_EXPORT_VERSION} has a manifest but no `
      + 'model shard — the export is incomplete');
  }

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
  log(modelShipped
    ? `  model            ${MODEL_EXPORT_VERSION} · ${modelBytes.toLocaleString()} B `
      + `(${(modelBytes / 1e6).toFixed(2)} MB) — served from ${MODEL_EXPORT_DIR}/`
    : '  model            none exported — this build answers from Quick Answers only (§6.2 T0)');
  if (modelSkipped.length) {
    log(`  not shipped      ${modelSkipped.join(', ')} — in the export dir, but §9.3 ships `
      + 'only a manifest, a tokenizer and shards');
  }
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
    throw new BuildRefused(problems);
  }
  log('  verdict          clean — no withheld value, no dev tooling');

  return {
    out, files: files.map((f) => f.rel), bytes, sha256, removed, deliberate,
    notes: devNotes, modelBytes, modelShipped, modelSkipped,
    /* the two budgets that matter for a first visit: what the page pulls
       before the click (0 AI bytes — asserted by the e2e probe) and what the
       click pulls (§4: ≤ ~40 MB first-use, one-time) */
    modelDownloadBytes: modelShipped ? modelBytes : 0,
  };
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
