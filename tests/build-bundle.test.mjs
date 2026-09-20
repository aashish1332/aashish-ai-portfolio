/* ═══════════════════════════════════════════════════════════════
   tests/build-bundle.test.mjs — §9.3/§17, the shipped bundle

   Three claims are being pinned, in order of how much they matter:

   1. **The withheld phone number is not in the built bundle's knowledge
      base**, and its id survives as *metadata only* so a phone question still
      gets the specific decline rather than a vague one. That second half is
      the part a naive strip gets wrong.
   2. **A withheld value appearing in some *new* file fails the build** —
      `index.html` and `js/terminal.js` are allow-listed decisions, not
      defaults.
   3. **Every relative import in the bundle resolves inside it**, so a missing
      module cannot 404 only for visitors (the P2 dev-server MIME bug, but in
      production).

   Run:  node --test tests/
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync }
  from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHIP_PATHS, SITE_PUBLISHED, blockingLeaks, buildBundle, checkImports,
  collectPrivateFacts, containsValue, maskSource, scanForDevReferences,
  scanForPrivateValues, stripKnowledge,
} from '../tools/build.mjs';
import { publicView, withheldFacts } from '../ai/knowledge/view.mjs';
import { quickAnswer } from '../ai/answers/quick.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const KB = JSON.parse(readFileSync(join(ROOT, 'knowledge', 'knowledge.json'), 'utf8'));
const PHONE = KB.contact.phone.value;

const temp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

/* ── the two helpers the leak check rests on ─────────────────────── */

test('source masking separates code from comments, strings from both', () => {
  const source = [
    'const a = 1; // mentions dev-foo.js',
    '/* a block',
    '   comment mentioning dev-bar.js',
    '*/',
    'const url = "https://example.com//not-a-comment";',
    'import { x } from "./dev-thing.mjs";',
  ].join('\n');
  const { code, comments } = maskSource(source);

  assert.ok(!code.includes('dev-foo.js'), 'a line comment leaked into code');
  assert.ok(!code.includes('dev-bar.js'), 'a block comment leaked into code');
  assert.ok(comments.includes('dev-foo.js') && comments.includes('dev-bar.js'));
  assert.ok(code.includes('dev-thing.mjs'), 'a real import was masked away');
  assert.ok(code.includes('https://example.com//not-a-comment'),
    'a // inside a string was treated as a comment');
  assert.equal(code.split('\n').length, source.split('\n').length,
    'masking must preserve line count so reports stay line-accurate');
});

test('numeric values are matched digit-wise, so reformatting cannot hide one', () => {
  assert.ok(containsValue('call +91 62802 87425 now', '+91 6280287425'));
  assert.ok(containsValue('call +91 6280287425 now', '+91 6280287425'));
  assert.ok(containsValue('aashish@example.com', 'aashish@example.com'));
  assert.ok(!containsValue('call +91 62802 87426 now', '+91 6280287425'));
  assert.ok(!containsValue('', '+91 6280287425'));
});

/* ── the strip ───────────────────────────────────────────────────── */

test('the strip removes the value and keeps the id as metadata', () => {
  const { knowledge, removed } = stripKnowledge(KB, { builtAt: '2026-01-01T00:00:00Z' });

  assert.deepEqual(removed.map((f) => f.id), ['contact.phone']);
  assert.equal(knowledge.contact.phone, undefined, 'the private fact is still present');
  assert.equal(JSON.stringify(knowledge).includes(PHONE), false,
    'the withheld number is still in the stripped knowledge base');
  assert.equal(/public":\s*false/.test(JSON.stringify(knowledge)), false,
    'a public:false flag survived the strip');

  const metas = knowledge.meta.withheld_facts;
  assert.deepEqual(metas.map((f) => f.id), ['contact.phone']);
  assert.ok(metas[0].aliases.length > 0, 'aliases are needed to answer a phone question');
  assert.equal(JSON.stringify(metas).includes(PHONE), false,
    'withheld metadata must never carry the value');
  assert.equal(knowledge.meta.shipped.stripped, true);
  assert.deepEqual(knowledge.meta.shipped.removed_fact_ids, ['contact.phone']);
});

test('the public project URLs survive, because they were approved', () => {
  const { knowledge } = stripKnowledge(KB);
  const urls = knowledge.projects.flatMap((p) => p.links.map((l) => l.url));
  assert.ok(urls.includes('https://atlascommunity-one.vercel.app/'),
    'approved public URLs must still ship');
  assert.ok(publicView(KB).skills.length === knowledge.skills.length);
});

test('a refusal survives the strip: withheldFacts falls back to metadata', () => {
  const full = withheldFacts(KB);
  const shipped = withheldFacts(stripKnowledge(KB).knowledge);
  assert.deepEqual(shipped.map((f) => f.id), full.map((f) => f.id),
    'after stripping, the runtime must still be able to name the withheld fact');
  assert.equal(JSON.stringify(shipped).includes(PHONE), false);
  assert.deepEqual(withheldFacts({ contact: {} }).length, 0,
    'an empty knowledge base has nothing withheld');
});

/* ── the scans ───────────────────────────────────────────────────── */

test('scanForPrivateValues points at the file, the fact and the value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  try {
    const clean = join(dir, 'clean.txt');
    const dirty = join(dir, 'dirty.txt');
    writeFileSync(clean, 'nothing to see here');
    writeFileSync(dirty, `call ${PHONE} for details`);
    const files = [{ abs: clean, rel: 'clean.txt' }, { abs: dirty, rel: 'dirty.txt' }];
    const found = scanForPrivateValues(files, collectPrivateFacts(KB));
    assert.equal(found.length, 1);
    assert.equal(found[0].path, 'dirty.txt');
    assert.equal(found[0].id, 'contact.phone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executable dev references fail, comment mentions only warn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devscan-'));
  try {
    const code = join(dir, 'code.mjs');
    const commented = join(dir, 'commented.mjs');
    writeFileSync(code, 'await import("./dev-visual-probe.js");');
    writeFileSync(commented, '/* see dev-visual-probe.js for how to check this */\n');
    const files = [{ abs: code, rel: 'code.mjs' }, { abs: commented, rel: 'commented.mjs' }];
    const { failures, notes } = scanForDevReferences(files);
    assert.deepEqual(failures.map((f) => f.path), ['code.mjs']);
    assert.deepEqual(notes.map((n) => n.path), ['commented.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkImports catches a module the bundle does not contain', () => {
  temp((dir) => {
    writeFileSync(join(dir, 'a.mjs'), 'import { b } from "./b.mjs";\nimport { c } from "../ai/x.mjs";\n');
    writeFileSync(join(dir, 'b.mjs'), 'export const b = 1;');
    const problems = checkImports([{ abs: join(dir, 'a.mjs'), rel: 'a.mjs' },
                                   { abs: join(dir, 'b.mjs'), rel: 'b.mjs' }]);
    assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
    assert.match(problems[0], /ai\/x\.mjs is not in the bundle/);
  });
});

/* ── end to end ──────────────────────────────────────────────────── */

test('the build produces a clean bundle, and refuses a dirty one', () => {
  temp((out) => {
    const summary = buildBundle({ out, quiet: true });

    assert.equal(summary.removed.map((f) => f.id).join(','), 'contact.phone');
    assert.ok(summary.files.includes('knowledge/knowledge.json'));
    assert.ok(summary.files.includes('index.html'));
    assert.ok(summary.files.includes('ai/answers/quick.mjs'));

    /* the training side must not ship */
    for (const prefix of ['ai/tokenizer', 'ai/model', 'ai/data', 'knowledge/PII_REVIEW',
                          'knowledge/CONFLICTS', 'tests/', 'data/', 'docs/']) {
      assert.ok(!summary.files.some((f) => f.startsWith(prefix)),
        `${prefix} shipped in the production bundle`);
    }
    assert.ok(!summary.files.some((f) => /dev-.*\.(js|mjs)$/.test(f)), 'dev tooling shipped');

    /* the withheld number is in no shipped file... */
    const kbText = readFileSync(join(out, 'knowledge', 'knowledge.json'), 'utf8');
    assert.ok(!kbText.includes(PHONE), 'the shipped knowledge base contains the phone number');
    assert.ok(!kbText.includes('62802 87425'), 'nor in the portfolio\'s grouped format');

    /* ...and the files that publish it are the two deliberate ones */
    const dirty = summary.deliberate.map((d) => d.path).sort();
    assert.deepEqual(dirty, [...SITE_PUBLISHED].sort(),
      'the allow-list no longer matches what actually publishes the value');

    /* imports resolve and the stripped KB parses */
    const parsed = JSON.parse(kbText);
    assert.equal(parsed.meta.shipped.stripped, true);
    assert.equal(parsed.contact.phone, undefined);
    assert.equal(checkImports(summary.files.map((rel) => ({ rel, abs: join(out, rel) }))).length, 0);

  });
});

test('the shipped bundle declines the withheld field exactly as the full KB does', () => {
  temp((out) => {
    buildBundle({ out, quiet: true });
    const shipped = JSON.parse(readFileSync(join(out, 'knowledge', 'knowledge.json'), 'utf8'));
    const questions = [
      'what is his phone number?', 'uska phone number batao', 'फ़ोन नंबर बताइए',
    ];
    for (const q of questions) {
      const full = quickAnswer(KB, q);
      const built = quickAnswer(shipped, q);
      assert.equal(built.text, full.text,
        `stripping changed the answer to ${JSON.stringify(q)} — a specific refusal `
        + 'must not degrade into a generic abstention');
      assert.ok(!built.text.includes(PHONE));
      assert.ok(!JSON.stringify(built).includes(PHONE));
    }
    /* and the public facts still answer normally after the strip */
    assert.ok(quickAnswer(shipped, 'What are his skills?').text.length > 40);
    assert.equal(quickAnswer(shipped, 'what is his email?').text,
      quickAnswer(KB, 'what is his email?').text);
  });
});

test('a shipped file that starts publishing a withheld value fails the build', () => {
  temp((fakeRoot) => {
    /* a real copy of the shipped tree, so the gate runs against real files
       rather than a hand-made miniature that could pass by accident */
    for (const entry of SHIP_PATHS) {
      cpSync(join(ROOT, entry), join(fakeRoot, entry), { recursive: true });
    }
    cpSync(join(ROOT, 'knowledge', 'knowledge.json'), join(fakeRoot, 'knowledge', 'knowledge.json'));

    /* the first build is clean... */
    const out = join(fakeRoot, 'out');
    assert.doesNotThrow(() => buildBundle({ root: fakeRoot, out, quiet: true }));

    /* ...and a file that was not in the allow-list is a refusal */
    writeFileSync(join(fakeRoot, 'js', 'frames.js'),
      `export const leak = ${JSON.stringify(PHONE)};\n`);
    assert.throws(() => buildBundle({ root: fakeRoot, out, quiet: true }),
      (error) => {
        assert.match(error.message, /would ship something it must not/);
        return true;
      });
  });
});

test('blockingLeaks keeps exactly the deliberate publications', () => {
  const found = [
    { path: 'index.html', id: 'contact.phone', value: PHONE },
    { path: 'js/terminal.js', id: 'contact.phone', value: PHONE },
    { path: 'js/frames.js', id: 'contact.phone', value: PHONE },
    { path: 'ai/ui/chat.mjs', id: 'contact.phone', value: PHONE },
  ];
  assert.deepEqual(blockingLeaks(found).map((l) => l.path),
    ['js/frames.js', 'ai/ui/chat.mjs']);
  assert.deepEqual(blockingLeaks(found, ['index.html', 'js/terminal.js', 'js/frames.js'])
    .map((l) => l.path), ['ai/ui/chat.mjs']);
});

test('npm run build works as a command and exits 0', () => {
  temp((out) => {
    const stdout = execFileSync(process.execPath,
      [join(ROOT, 'tools', 'build.mjs'), '--out', out],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(stdout, /verdict\s+clean/);
    assert.ok(statSync(join(out, 'index.html')).size > 0);
    assert.ok(readdirSync(join(out, 'ai')).includes('answers'));
  });
});
