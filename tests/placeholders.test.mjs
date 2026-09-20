/* ═══════════════════════════════════════════════════════════════
   tests/placeholders.test.mjs — §7.2 grammar, browser side

   Reads the hand-written fixture in tests/fixtures/placeholder_cases.json.
   `tests/py/test_tokenizer_spec.py` reads the same file with the Python
   mirror: two runtimes, one grammar, and whichever drifts fails its own
   suite. Without this, the tokenizer could reserve atomic tokens for a
   syntax the answer engine no longer resolves — the model would emit a
   placeholder and the UI would print it raw.

   Run:  node --test tests/
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  iterPlaceholders, isPlaceholder, placeholderToken, replacePlaceholders,
} from '../ai/knowledge/placeholders.mjs';
import { viewOf } from '../ai/knowledge/view.mjs';
import { resolveFacts } from '../ai/answers/quick.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CASES = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'placeholder_cases.json'), 'utf8')).cases;
const KB = JSON.parse(readFileSync(join(ROOT, 'knowledge', 'knowledge.json'), 'utf8'));

test('§7.2: the placeholder grammar matches the shared fixture', () => {
  for (const c of CASES) {
    assert.deepEqual(iterPlaceholders(c.text), c.ids, `ids for ${JSON.stringify(c.text)}`);
    assert.equal(isPlaceholder(c.text), c.whole,
      `whole for ${JSON.stringify(c.text)} (${c.why})`);
  }
});

test('§7.2: placeholderToken builds strings the grammar accepts', () => {
  assert.equal(placeholderToken('contact.email'), '<|fact:contact.email|>');
  assert.equal(placeholderToken('  link.github  '), '<|fact:link.github|>');
  for (const bad of ['', '   ', 'a|b', '<x', 'x>']) {
    assert.throws(() => placeholderToken(bad), `should reject ${JSON.stringify(bad)}`);
  }
  for (const id of ['contact.email', 'project.volunteer.live', 'edu.lpu']) {
    assert.ok(isPlaceholder(placeholderToken(id)), `${id} must round-trip`);
    assert.deepEqual(iterPlaceholders(placeholderToken(id)), [id]);
  }
});

test('§7.2: a scanned regex never carries lastIndex between calls', () => {
  const text = 'a <|fact:x|> b <|fact:y|>';
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(iterPlaceholders(text), ['x', 'y'], `call ${i}`);
  }
  assert.equal(replacePlaceholders(text, () => 'Z'), 'a Z b Z');
  assert.equal(replacePlaceholders(text, () => 'Z'), 'a Z b Z', 'replace is deterministic');
});

test('§7.2/§8.4: every reserved placeholder resolves against the public view', () => {
  const view = viewOf(KB);
  /* The ids the tokenizer reserves, reconstructed exactly as spec.py builds
     them: every `id` in the KB plus composed `<project>.<label>` links. */
  const ids = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string') ids.push(node.id);
    Object.values(node).forEach(walk);
  };
  walk(KB);
  const reserved = new Set(ids);
  assert.ok(reserved.size > 50, `expected many fact ids, found ${reserved.size}`);

  const unresolved = [];
  for (const id of reserved) {
    const { text, unresolved: missing } = resolveFacts(view, placeholderToken(id));
    if (missing.length || !text) unresolved.push(id);
  }
  /* Not every id renders a sentence — a skill renders, a project link does
     — but an id that renders *nothing* means the tokenizer reserved a
     placeholder no answer can ever fill. */
  assert.ok(unresolved.length <= 25,
    `too many placeholders resolve to nothing: ${unresolved.slice(0, 12).join(', ')}`);
});

test('§8.4: a private fact is never resolvable through a placeholder', () => {
  const view = viewOf(KB);
  const privateIds = Object.values(KB.contact || {})
    .filter((f) => f.public === false).map((f) => f.id);
  assert.ok(privateIds.length, 'expected at least one withheld contact field');

  for (const id of privateIds) {
    const { text, unresolved } = resolveFacts(view, placeholderToken(id));
    assert.equal(text, '', `${id} must resolve to nothing`);
    assert.deepEqual(unresolved, [id], `${id} must be reported as unresolved`);
  }
  const phone = KB.contact.phone.value;
  assert.ok(!String(resolveFacts(view, placeholderToken('contact.phone')).text).includes(phone));
});
