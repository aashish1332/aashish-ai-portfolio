/* ═══════════════════════════════════════════════════════════════
   tests/lexicons.test.mjs — one lexicon, two runtimes

   `ai/language/lexicons.json` is what the Python data pipeline reads when
   it tags the corpus (ai/data/langid.py). The browser detector keeps its
   sets in code. If they drift, a sentence can be labelled English at
   data-prep time and answered as Hinglish at runtime — a bug nobody would
   find by reading either file.

   This test is the tether: the JSON must be exactly the JS sets.

   Run:  node --test tests/
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { HINGLISH_WORDS, ENGLISH_WORDS, detectLanguage } from '../ai/language/detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEX = JSON.parse(
  readFileSync(join(HERE, '..', 'ai', 'language', 'lexicons.json'), 'utf8'));

test('the JSON lexicons are exactly the detector\'s sets', () => {
  assert.deepEqual(new Set(LEX.hinglish), new Set(HINGLISH_WORDS),
    'hinglish lexicon drift between lexicons.json and detect.mjs');
  assert.deepEqual(new Set(LEX.english), new Set(ENGLISH_WORDS),
    'english lexicon drift between lexicons.json and detect.mjs');
});

test('both lexicons are lower-case, unique and non-trivial', () => {
  for (const [name, words] of Object.entries({ hinglish: LEX.hinglish, english: LEX.english })) {
    assert.ok(words.length > 50, `${name} lexicon has only ${words.length} words`);
    assert.equal(new Set(words).size, words.length, `${name} has duplicates`);
    for (const w of words) {
      assert.equal(w, w.toLowerCase(), `${name}: ${w} is not lower-case`);
      assert.equal(w.trim(), w, `${name}: ${JSON.stringify(w)} has whitespace`);
    }
  }
});

test('a word in both lexicons would be resolved by the hinglish branch, so none may be', () => {
  /* detectLanguage checks hinglish first (`else if`), so an overlapping word
     is silently Hinglish. Overlap is therefore a real behavioural change,
     not a style question. */
  const overlap = [...new Set(LEX.hinglish)].filter((w) => LEX.english.includes(w));
  assert.deepEqual(overlap, [], `overlapping words: ${overlap.join(', ')}`);
  /* ...and the detector really does resolve the overlap first, so the test
     above is protecting something: 'batao' alone is Hinglish weak/strong. */
  assert.equal(detectLanguage('batao').lang, 'hinglish');
});
