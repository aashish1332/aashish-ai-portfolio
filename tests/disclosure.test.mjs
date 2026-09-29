/* ═══════════════════════════════════════════════════════════════
   tests/disclosure.test.mjs — §2 N4's "disclose this honestly"

   N4 permits STT / TTS / VAD to be open pretrained components, on one
   condition: disclose it "in README, docs and the UI 'About' popover". The
   first two were true from the beginning; the popover was not built until
   2026-09-28, which is why this file exists.

   What is asserted here is the part a test can hold down:

     · the disclosure says BOTH things about voice input — that the platform
       is asked to stay on the device, and that it may not — because a
       disclosure that names only the good outcome is the failure mode the
       brief is guarding against;
     · it makes no claim about Aashish (nothing in it is portfolio content, so
       it never passes through the Faithfulness Guard);
     · the shell wires it as a real control with a real close path, and the
       stylesheet lets `hidden` win — a `display` rule of our own would keep a
       closed card on screen, which §10's controls carry a comment about;
     · answers and this text are rendered as text, never as markup (§5.1.6).

   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ABOUT_TITLE, ABOUT_SECTIONS, MODEL_STATUS, MODEL_STATUS_TEXT, modelStatusText,
} from '../ai/ui/chat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = readFileSync(join(HERE, '..', 'ai', 'ui', 'chat.mjs'), 'utf8');
const STYLES = readFileSync(join(HERE, '..', 'ai', 'ui', 'styles.mjs'), 'utf8');
const EVALUATION = JSON.parse(
  readFileSync(join(HERE, '..', 'docs', 'EVALUATION.json'), 'utf8'));

const detailFor = (term) => {
  const section = ABOUT_SECTIONS.find((s) => s.term.toLowerCase().includes(term));
  assert.ok(section, `no disclosure section mentions "${term}"`);
  return section.detail;
};

test('N4-1: the disclosure exists, is titled, and is not empty', () => {
  assert.equal(typeof ABOUT_TITLE, 'string');
  assert.ok(ABOUT_TITLE.trim().length > 0);
  assert.ok(ABOUT_SECTIONS.length >= 4,
    'a disclosure with fewer than four parts is not describing this assistant');
  for (const { term, detail } of ABOUT_SECTIONS) {
    assert.ok(term && term.trim(), 'a section with no term');
    assert.ok(detail && detail.trim(), `${term} has nothing said about it`);
  }
});

test('N4-1: it names the parts that are the browser\u2019s, and the part that is ours', () => {
  /* the two components N4 names by hand, plus the model claim the whole
     project rests on */
  const voiceIn = detailFor('voice input');
  assert.match(voiceIn, /speech recognition/i, 'voice input is not described');
  assert.match(voiceIn, /browser/i, 'the recogniser is not attributed to the browser');
  assert.match(detailFor('spoken'), /browser/i, 'speech output is not attributed to the browser');
  assert.match(detailFor('model'), /from scratch/i, 'the model claim is missing');
  assert.match(detailFor('model'), /no\s+pretrained/i,
    'the disclosure must say no pretrained language model is used');
});

test('N4-1: the voice disclosure names BOTH outcomes, never only the good one', () => {
  const voiceIn = detailFor('voice input');
  /* both halves of §11.2/§19 row 6: the request, and the fallback */
  assert.match(voiceIn, /on this device/i, 'the on-device attempt is not mentioned');
  assert.match(voiceIn, /when the browser says it cannot/i,
    'the fallback is not mentioned — a disclosure that names only the good outcome is the bug');
  assert.match(voiceIn, /speech service/i,
    'the fallback is not named, so the visitor cannot tell what it means');
});

test('N4-1: the disclosure makes no claim about Aashish', () => {
  /* It is about the assistant, so it must never carry portfolio content: that
     keeps it out of the Faithfulness Guard's scope by construction, and stops
     a privacy notice from becoming an unverified fact. */
  const all = [ABOUT_TITLE, ...ABOUT_SECTIONS.flatMap((s) => [s.term, s.detail])].join(' ');
  assert.doesNotMatch(all, /Aashish/i,
    'the disclosure names the portfolio owner — it is a claim about him now, not about the assistant');
});

test('N4-1: the shell wires it as a control with a real close path', () => {
  assert.match(CHAT, /el\('button', 'ai__about', 'ABOUT'\)/, 'no ABOUT control is built');
  assert.match(CHAT, /aria-expanded/, 'the control does not say whether it is open');
  assert.match(CHAT, /aria-controls', 'aiAbout'/, 'the control is not tied to the card');
  assert.match(CHAT, /card\.hidden = true|card\.hidden = !aboutOpen/,
    'the card does not start closed');
  assert.match(CHAT, /aboutClose\?\.focus\?\.\(\)/, 'opening it does not move focus into it');
  assert.match(CHAT, /if \(aboutOpen\) \{ setAbout\(false\); return; \}/,
    'Escape no longer closes the topmost layer first');
  assert.match(CHAT, /about\(on = true\) \{ return setAbout\(on\); \}/,
    'the probes have no way to open it as a visitor does');
});

test('N4-1: the stylesheet lets `hidden` win, and stays inside the panel', () => {
  assert.match(STYLES, /\.ai__about-card\[hidden\] \{ display: none; \}/,
    'a display rule of our own would keep a closed card on screen');
  assert.match(STYLES, /\.ai__about-card \{\s*position: absolute; inset: 0;/,
    'the card is not a child layer of the panel (§12: nothing over the canvas)');
  /* the property, not the word — the module's header explains WHY it is
     absent, and a naive substring check would fail on that comment */
  assert.doesNotMatch(STYLES, /backdrop-filter\s*:/,
    '§12 forbids a blurred layer over a live WebGL canvas');
});

test('§0 rule 4: the checkpoint shipping today is disclosed as a pipeline test', () => {
  /* The rule is "never present smoke-test output as a trained model". The
     shipped export is step 1100 of a CPU run whose answers are poor, so a
     panel that says only "trained from scratch for this portfolio" is the
     presentation the rule forbids — true about provenance, silent about
     quality. This is the assertion that keeps the two apart. */
  assert.ok(Object.hasOwn(MODEL_STATUS_TEXT, MODEL_STATUS),
    `MODEL_STATUS is "${MODEL_STATUS}" and MODEL_STATUS_TEXT has no sentence for it`);
  const text = modelStatusText();
  assert.ok(text.trim().length > 0, 'the status has nothing to say');
  assert.match(text, /pipeline test/i,
    'the disclosure does not say what the shipped checkpoint actually is');
  assert.match(text, /not a model trained for quality/i,
    'the disclosure must deny the quality claim explicitly, not merely omit it');
});

test('§0 rule 4: the status cannot claim quality while the §14 gates fail', () => {
  /* The coupling, and the reason this is a test rather than a promise: the
     constant lives in shipped code, so "remember to flip it back" is not a
     safeguard. While `docs/EVALUATION.json` says the gates did not pass, the
     status may not say the model was trained for quality. Exporting a better
     checkpoint regenerates that file, and a status left behind then fails here
     rather than shipping a claim nobody measured. */
  if (EVALUATION.passed === false) {
    assert.notEqual(MODEL_STATUS, 'trained',
      `docs/EVALUATION.json reports the gates as FAILED and MODEL_STATUS says `
      + `"trained" — the panel would be presenting smoke-test output as a `
      + `trained model (§0 rule 4). Evaluation is from checkpoint `
      + `"${EVALUATION.checkpoint}" at step ${EVALUATION.step}`);
    assert.match(modelStatusText(), /not a model trained for quality/i,
      'with the gates failing, the text shown must be the cautious one');
  }
  /* and the claim itself has to exist, or the branch above proves nothing */
  assert.match(MODEL_STATUS_TEXT.trained, /cleared.*gates/i,
    'the "trained" sentence does not name what would have to be true');
});

test('§0 rule 4: an unknown status cannot remove the disclosure', () => {
  /* `modelStatusText` is a fallback, not a lookup: a typo in the constant must
     degrade to the cautious sentence, never to silence.

     `undefined` is deliberately NOT in this list, and the reason is a bug this
     test had: passing it takes the DEFAULT parameter, so it returns whatever
     the current status is. It only looked like a fallback case while the
     status was 'untrained', and would have started failing the day a real
     checkpoint landed and the constant legitimately became 'trained' — a test
     that breaks on the change it is meant to allow. Unknown means a value that
     is not a key; an omitted argument means "the current one". */
  for (const bogus of ['', 'TRAINED', 'nonsense', null]) {
    assert.match(modelStatusText(bogus), /pipeline test/i,
      `modelStatusText(${JSON.stringify(bogus)}) does not fall back to the `
      + 'cautious sentence');
  }
});

test('§0 rule 4: the card renders the status, and the stylesheet gives it a place', () => {
  assert.match(CHAT, /el\('p', 'ai__about-note', modelStatusText\(\)\)/,
    'the About card does not render the model status');
  assert.match(CHAT, /card\.append\(title, list, status, aboutClose\)/,
    'the status is built but never attached to the card');
  assert.match(STYLES, /\.ai__about-note \{/,
    'the note has no style, so it lands as an unstyled paragraph');
});

test('N4-1: the disclosure and the answers are rendered as text, never as markup', () => {
  /* §5.1 step 6. `el()` sets textContent, so the check is that nothing in the
     shell reaches for innerHTML instead. */
  assert.doesNotMatch(CHAT, /\.innerHTML\s*=/, 'the shell assigns innerHTML');
  assert.doesNotMatch(CHAT, /insertAdjacentHTML|outerHTML\s*=/, 'the shell injects markup');
  assert.doesNotMatch(STYLES, /url\(\s*['"]?https?:/i, 'the panel stylesheet fetches nothing');
});
