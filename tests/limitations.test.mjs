/* ═══════════════════════════════════════════════════════════════
   tests/limitations.test.mjs — the honest list stays a list

   `docs/FINAL_REPORT.md`'s KNOWN LIMITATIONS section is referenced *by
   number* from three other files and from a comment in `ai/ui/chat.mjs`
   ("limitation 1"), so its numbering is load-bearing. It had drifted: 11
   was followed by `12b` and then 14, so **item 12 did not exist** while
   `docs/PROGRESS.md` pointed a reader straight at it. Nothing caught that,
   because the docs validator (`tests/py/test_docs_commands.py`) checks
   commands and deliberately does not read prose.

   Three checks, deliberately split so each one names the thing it catches:

     1. **the plain numbers run 1..N with no gap** — a lettered item is
        excluded here on purpose, because the patch is what creates the gap:
        `11, 12b, 14` leaves the reader with numbers 1..11, 13..17;
     2. **no item carries a letter suffix** — catches the patch itself;
     3. **every `limitation N` names a plain-numbered item** — checked by
        membership, not by `N <= count`, which is the difference that matters
        when the list has a hole rather than a short tail.

   Each of the three fires on the original defect; checked by putting it back.

   `item N` is deliberately NOT checked: the phrase is ambiguous ("§18
   checklist, item by item"), so a regex for it would eventually fail on
   prose that is not a reference. The two `item N` references that exist
   both point at this list and are correct as written.
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'docs', 'FINAL_REPORT.md');

function limitationsSection() {
  const text = readFileSync(REPORT, 'utf8');
  const start = text.indexOf('## KNOWN LIMITATIONS');
  assert.ok(start >= 0,
    'the KNOWN LIMITATIONS heading is gone, so every check below would pass by finding nothing');
  const after = text.slice(start);
  const end = after.indexOf('\n## ', 1);
  return end < 0 ? after : after.slice(0, end);
}

/** @returns {{n: number, suffix: string}[]} in document order */
function markers() {
  const found = [];
  for (const line of limitationsSection().split('\n')) {
    const m = /^(\d+)([a-z]?)\.\s/.exec(line);
    if (m) found.push({ n: Number(m[1]), suffix: m[2] });
  }
  return found;
}

test('the section is found and long enough for finding it to mean something', () => {
  const count = markers().length;
  assert.ok(count >= 10,
    `parsed only ${count} items — the section or its list formatting changed`);
});

/** The numbers a reader can cite: lettered patches are excluded, because it is
 *  the patch that eats the number it was avoiding. */
function plainNumbers() {
  return markers().filter((m) => !m.suffix).map((m) => m.n);
}

test('item numbers run 1..N with no gaps', () => {
  const numbers = plainNumbers();
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1),
    `the list reads ${numbers.join(', ')} — a gap means a number someone can cite and not find`);
});

test('no item carries a letter suffix', () => {
  const lettered = markers().filter((m) => m.suffix).map((m) => `${m.n}${m.suffix}`);
  assert.deepEqual(lettered, [],
    `a lettered item (${lettered.join(', ')}) reads as a patch to a list nobody renumbered, `
    + 'and leaves the plain number it patches missing');
});

test('every "limitation N" reference names an item that exists', () => {
  const have = new Set(plainNumbers());
  const files = [join(ROOT, 'README.md'),
    ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))
      .map((f) => join(ROOT, 'docs', f))];
  let references = 0;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/limitations? (\d+)/g)) {
        references += 1;
        const n = Number(m[1]);
        assert.ok(have.has(n),
          `${file.slice(ROOT.length + 1)}:${i + 1} cites limitation ${n}; `
          + `the list has ${[...have].join(', ')}`);
      }
    });
  }
  assert.ok(references >= 4,
    `matched only ${references} references — the pattern stopped finding them, so this check went quiet`);
});
