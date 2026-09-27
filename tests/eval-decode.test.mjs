/* tests/eval-decode.test.mjs — the engine decoder, on the tiny fixture

   `tools/eval-decode.mjs` grades a checkpoint by running the *shipping* engine,
   so a defect in it is a defect in the number that decides whether the model
   ships. The parts that can be wrong without anyone noticing are the plumbing:
   the file fetch shim, the frame-equality assert between the emitter and the
   engine, and the generator drain that collects the summary.

   The tiny fixture (`tests/fixtures/tiny-model`, random init, 2 layers) exists
   for exactly this kind of check, so the test costs milliseconds and needs no
   trained checkpoint.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeWithEngine, fileFetch } from '../tools/eval-decode.mjs';
import { promptFor, scoreCase } from '../tools/model-eval.mjs';
import { ByteLevelBPE } from '../ai/engine/bpe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'tiny-model');
const FIXTURE_MAX_SEQ = 256;   /* the fixture's own config, not the shipping 512 */
const TOKENIZER = new ByteLevelBPE(JSON.parse(readFileSync(join(FIXTURE, 'tokenizer.json'), 'utf8')));
const KB = JSON.parse(readFileSync(join(ROOT, 'knowledge', 'knowledge.json'), 'utf8'));

const CASE = {
  id: 'd06', type: 'direct', language: 'en', question: 'What are his skills?',
  expected_facts: ['skill.python'], forbidden: [],
};

function promptRow(over = {}) {
  const row = promptFor(KB, TOKENIZER, CASE, { maxSeq: FIXTURE_MAX_SEQ, maxNewTokens: 32 });
  assert.equal(row.route, 'model', 'the fixture case must exercise the model path');
  return { ...row, ...over };
}

test('the file fetch shim serves a real file as a Response-shaped object', async () => {
  const fetched = await fileFetch(FIXTURE)('https://example.invalid/tiny-model/manifest.json');
  assert.equal(fetched.ok, true);
  assert.equal(fetched.status, 200);
  const parsed = await fetched.json();
  assert.equal(parsed.config.vocab_size, 1024);
});

test('the decoder drains the engine and records why it stopped', async () => {
  const { answers, source } = await decodeWithEngine({
    exportDir: FIXTURE,
    prompts: [promptRow()],
    maxNewTokens: 32,
  });
  assert.equal(answers.length, 1);
  const [answer] = answers;
  assert.equal(answer.id, 'd06');
  assert.ok(answer.decoded <= 32, 'the cap must be respected');
  assert.ok(['end-token', 'abstain', 'max-tokens'].includes(answer.stopReason),
    `stopReason was ${answer.stopReason}`);
  if (answer.decoded === 0) {
    assert.notEqual(answer.stopReason, 'max-tokens',
      'an answer with no tokens stopped for a reason, not by running out of room');
  }
  assert.equal(typeof answer.rawText, 'string');
  assert.equal(answer.route, 'model');
  /* A random-init model still answers: the point of this test is the plumbing,
     not the answer. The fixture's own manifest says it came from a random init
     rather than a checkpoint, and the decoder reports that source verbatim
     instead of inventing a run and a step number. */
  assert.equal(source?.kind, 'random-init', `source was ${JSON.stringify(source)}`);
});

test('an answer with no tokens is a refusal, not an unsupported claim', () => {
  /* The random-init fixture stops before emitting anything. That is the
     strongest case of "the model asserted nothing", and the scorer has to
     read it as a refusal — counting a silent model as a fabrication would
     punish it for the one honest thing it did. */
  const row = scoreCase({ c: CASE, promptRow: promptRow(), answer: '', kb: KB,
    ended: 'end-token', abstainedFlag: false });
  assert.equal(row.abstained, true);
  assert.equal(row.unsupportedPreGuard, false);
  assert.equal(row.terminated, true);
});

test('a prompt that the engine would not build is refused, not graded', async () => {
  /* If `fitToBudget`/`frame` ever drift between the emitter and the engine, the
     graded prompt stops being the prompt a visitor would send. Failing loudly
     is the only honest outcome. */
  const tampered = promptRow({ prompt: `${promptRow().prompt} tampered` });
  await assert.rejects(
    () => decodeWithEngine({ exportDir: FIXTURE, prompts: [tampered], maxNewTokens: 32 }),
    /differ for d06/,
  );
});

test('a case decided before the model is carried through untouched', async () => {
  const { answers } = await decodeWithEngine({
    exportDir: FIXTURE,
    prompts: [{ id: 'm01', route: 'safety', answer: 'fixed reply' }],
    maxNewTokens: 8,
  });
  assert.deepEqual(answers, [{ id: 'm01', answer: 'fixed reply', route: 'safety', decoded: 0 }]);
});
