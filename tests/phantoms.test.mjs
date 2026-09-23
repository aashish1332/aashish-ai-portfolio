/* ═══════════════════════════════════════════════════════════════
   tests/phantoms.test.mjs — §11.2, transcripts nobody spoke

   The failure this prevents is specific: a recruiter says nothing, the
   recognizer invents "Thank you.", and the portfolio assistant answers it
   **out loud in Aashish's voice**. So the tests here are weighted towards
   the dangerous half — that the filter does NOT drop a real question — as
   much as towards the half that catches a phantom.

   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPhantom, normalizeTranscript, KNOWN_PHANTOMS } from '../ai/voice/phantoms.mjs';
import { createVoice } from '../ai/voice/index.mjs';

/* ── the filter itself ─────────────────────────────────────────── */

test('PH-1: the recognizer\'s silence-phantoms are caught, each with a reason', () => {
  const phantoms = [
    'Thank you.', 'THANK YOU!', 'thanks', 'you', 'Okay', 'ok', 'hmm', 'bye',
    'Please subscribe', 'Subtitles by the Amara.org community', 'The end',
    'धन्यवाद', 'शुक्रिया', 'theek hai',
  ];
  for (const p of phantoms) {
    const r = isPhantom(p);
    assert.equal(r.phantom, true, `${JSON.stringify(p)} was treated as speech`);
    assert.ok(r.reason, 'a phantom dropped without a reason is a filter you cannot debug');
  }
});

test('PH-2: real questions survive — the more dangerous direction', () => {
  const real = [
    'what is your CGPA', 'hi', 'Hello', 'namaste', 'aapka naam kya hai?',
    'आपके पास कौन से सर्टिफिकेट हैं?', 'tell me about the projects',
    'thank you for the details, now show me the skills',
    'okay so what databases does he use',
  ];
  for (const q of real) {
    assert.equal(isPhantom(q).phantom, false, `${JSON.stringify(q)} would have been dropped`);
  }
});

test('PH-3: a phrase inside a real sentence is not the phrase', () => {
  /* over-matching is how a filter starts eating questions, so the blocklist
     matches the WHOLE normalized final, never a substring */
  assert.equal(isPhantom('thanks for watching the demo, what is his stack?').phantom, false);
  assert.equal(isPhantom('the end of the project list is on the site').phantom, false);
});

test('PH-4: normalization does not let punctuation or case hide a phantom', () => {
  const variants = ['Thank   you.', '“thank you”', 'THANK\tYOU', 'thank-you', 'Thank\u00a0you'];
  for (const v of variants) {
    assert.equal(isPhantom(v).phantom, true, `${JSON.stringify(v)} slipped through`);
  }
  assert.equal(normalizeTranscript('[Music]'), '');
  assert.equal(normalizeTranscript('Thank you!'), 'thank you');
});

test('PH-5: a one-character final is noise; "hi" is not', () => {
  assert.equal(isPhantom('a').phantom, true);
  assert.equal(isPhantom('hi').phantom, false);
  assert.equal(isPhantom('').reason, 'empty');
  assert.equal(isPhantom('   ').reason, 'empty');
});

test('PH-6: an utterance arriving after 80 ms of audio cannot be a sentence', () => {
  assert.equal(isPhantom('what are your skills', { audioMs: 80 }).reason, 'audio-too-short');
  assert.equal(isPhantom('what are your skills', { audioMs: 900 }).phantom, false);
  /* a caller that cannot measure audio must not lose the answer */
  assert.equal(isPhantom('what are your skills').phantom, false);
});

test('PH-7: a stuck decoder is caught, a person repeating a word is not', () => {
  assert.equal(isPhantom('no no no').reason, 'stuck-repeat');
  assert.equal(isPhantom('the the the the').phantom, true);
  assert.equal(isPhantom('no no').phantom, false, 'two is a person');
});

test('PH-8: [Music] and friends normalize to nothing', () => {
  assert.equal(isPhantom('[Music]').phantom, true);
  assert.equal(isPhantom('[Applause]').phantom, true);
  assert.equal(isPhantom('[BLANK_AUDIO]').phantom, true);
});

test('PH-9: the blocklist is inspectable data, not a private regex', () => {
  assert.ok(KNOWN_PHANTOMS instanceof Set);
  assert.ok(KNOWN_PHANTOMS.has('thank you'));
  assert.ok(!KNOWN_PHANTOMS.has('projects'), 'a real topic must never be in the blocklist');
});

/* ── the integration: the voice layer actually drops them ───────── */

function fakeRecognizer() {
  return {
    supported: true, reason: null, listening: false, lang: null,
    started: 0, stopped: 0,
    start() { this.started++; this.listening = true; return true; },
    stop() { this.stopped++; this.listening = false; },
    release() { this.listening = false; },
    setLang(l) { this.lang = l; },
  };
}

function fakeSpeaker() {
  return {
    supported: true, speaking: false, spoken: [],
    speak(t) { this.spoken.push(t); this.speaking = true; return true; },
    stop() { this.speaking = false; return true; },
  };
}

function fakeChat() {
  return {
    asked: [], working: 0, handsFree: false,
    ask(q) { this.asked.push(q); return { text: 'answer' }; },
  };
}

function build(tier) {
  const chat = fakeChat();
  const recognizer = fakeRecognizer();
  const speaker = fakeSpeaker();
  const phantoms = [];
  const env = { timers: new Map(), nextTimerId: 0,
    setTimeout(fn) { const id = ++env.nextTimerId; env.timers.set(id, fn); return id; },
    clearTimeout(id) { env.timers.delete(id); } };
  const voice = createVoice(env, {
    tier, chat, recognizer, speaker, clock: () => 0,
    onPhantom: (p) => phantoms.push(p),
  });
  return { voice, chat, speaker, phantoms };
}

test('PH-10: a phantom final asks nothing, and is never spoken', () => {
  const { voice, chat, speaker, phantoms } = build(2);
  voice.enable();
  assert.equal(voice.onFinal('Thank you.'), null);
  assert.deepEqual(chat.asked, [], 'a silence-phantom was answered');
  assert.deepEqual(speaker.spoken, [], 'a silence-phantom was spoken aloud');
  assert.equal(phantoms.length, 1, 'the reason was not reported to the caller');
  assert.equal(phantoms[0].reason, 'known-phrase');
});

test('PH-11: a phantom is dropped before the wake phrase, in every mode', () => {
  for (const tier of [2, 3]) {
    const { voice, chat } = build(tier);
    voice.enable();
    assert.equal(voice.onFinal('you'), null);
    assert.deepEqual(chat.asked, [], `tier ${tier} answered a phantom`);
    /* and the very next real question still works — the filter must not
       leave the session in a state where nothing is answered */
    const r = voice.onFinal(tier === 3 ? 'hey aashish, what are your projects' : 'what are your projects');
    assert.equal(r?.question, 'what are your projects');
    assert.deepEqual(chat.asked, ['what are your projects']);
  }
});

test('PH-12: the filter runs without the reporting hook', () => {
  /* `onPhantom` is an observability hook, not the switch. A caller that does
     not pass it (the shell does not have to) still gets a phantom dropped —
     otherwise "we forgot the callback" would mean "the room gets answered". */
  const chat = fakeChat();
  const env = { timers: new Map(), nextTimerId: 0,
    setTimeout(fn) { const id = ++env.nextTimerId; env.timers.set(id, fn); return id; },
    clearTimeout(id) { env.timers.delete(id); } };
  const voice = createVoice(env, {
    tier: 2, chat, recognizer: fakeRecognizer(), speaker: fakeSpeaker(), clock: () => 0,
  });
  voice.enable();
  assert.equal(voice.onFinal('okay'), null);
  assert.deepEqual(chat.asked, []);
  voice.onFinal('what is your name');
  assert.deepEqual(chat.asked, ['what is your name']);
});
