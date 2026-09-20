/* ═══════════════════════════════════════════════════════════════
   tests/langid-fixture.test.mjs — the JSON half of §8.3 parity

   tests/language.test.mjs already pins the detector with its own 106-case
   table. This file asserts the *shared* fixture instead — the same file
   `tests/py/test_langid_parity.py` reads with the Python port used by the
   corpus pipeline.

   Both directions matter:
     · this test fails if the detector stops matching the fixture, and
     · the Python test fails if the port stops matching it.

   So the fixture can only be changed by changing both runtimes.

   Run:  node --test tests/
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { detectLanguage, createLanguageTracker } from '../ai/language/detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'langid_cases.json'), 'utf8')).cases;

test('§8.3 parity fixture: every case matches the detector', () => {
  assert.ok(CASES.length >= 40, `fixture shrank to ${CASES.length} cases`);
  for (const c of CASES) {
    const d = detectLanguage(c.text);
    assert.equal(d.lang, c.lang,
      `lang for ${JSON.stringify(c.text)} (${c.why || 'no note'})`);
    assert.equal(d.strength, c.strength, `strength for ${JSON.stringify(c.text)}`);
  }
});

test('§8.3 parity fixture: it actually covers all three languages and both strengths', () => {
  const langs = new Set(CASES.map((c) => c.lang));
  const strengths = new Set(CASES.map((c) => c.strength));
  assert.deepEqual([...langs].sort(), ['en', 'hi', 'hinglish']);
  assert.deepEqual([...strengths].sort(), ['strong', 'weak']);
});

test('§8.3: smoothing keeps a weak signal on the previous turn', () => {
  const tracker = createLanguageTracker('en');
  const first = tracker.push('उसका नाम क्या है');
  assert.equal(first.lang, 'hi');
  assert.equal(first.switched, true);
  const weak = tracker.push('mongodb');           // weak English under a Hindi turn
  assert.equal(weak.strength, 'weak');
  assert.equal(weak.lang, 'hi', 'a weak signal must not switch language');
  const strong = tracker.push('Tell me about his projects please.');
  assert.equal(strong.lang, 'en');
  assert.equal(strong.switched, true, 'a strong signal always wins');
});
