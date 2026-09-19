/* ═══════════════════════════════════════════════════════════════
   tests/language.test.mjs — §8.3 gate: ≥100 deterministic cases

   Run:  node --test tests/
   Every expectation below is a frozen contract. If a lexicon edit
   breaks one of these, the edit is wrong — not the test.
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLanguage, createLanguageTracker, tokenize, voiceHint, LANG_LABEL,
} from '../ai/language/detect.mjs';

/* ── the 106-case table: [input, expected lang] ──────────────────── */
const CASES = [
  /* ── Devanagari-dominant → Hindi (10) ───────────────────────── */
  ['आशीष कौन है?', 'hi'],
  ['उसकी स्किल्स क्या हैं?', 'hi'],
  ['शिक्षा के बारे में बताइए', 'hi'],
  ['प्रोजेक्ट कौन सा है', 'hi'],
  ['संपर्क जानकारी दीजिए', 'hi'],
  ['उसने कौन से प्रोजेक्ट बनाए हैं?', 'hi'],
  ['क्या वह इंटर्नशिप के लिए उपलब्ध है?', 'hi'],
  ['धन्यवाद', 'hi'],
  ['उसका नाम क्या है', 'hi'],
  ['कौन सी भाषाए आती हैं', 'hi'],

  /* ─ Devanagari + heavy Latin → code-mixed (5) ──────────────── */
  ['उसका React और MongoDB experience क्या है?', 'hinglish'],
  ['उसने TypeScript और GraphQL सीखा है क्या?', 'hinglish'],
  ['उसका project architecture कैसा है?', 'hinglish'],
  ['DBMS certificate उसके पास है?', 'hinglish'],
  ['क्या उसका CGPA 8.28 hai?', 'hinglish'],

  /* ── Roman Hinglish (35) ────────────────────────────────────── */
  ['kya hai uska cgpa', 'hinglish'],
  ['uska naam kya hai', 'hinglish'],
  ['batao uska email', 'hinglish'],
  ['project ke bare me batao', 'hinglish'],
  ['uske skills kya hain', 'hinglish'],
  ['kaun sa project best hai', 'hinglish'],
  ['wo internship ke liye available hai?', 'hinglish'],
  ['uska github link do', 'hinglish'],
  ['thanks bhai', 'hinglish'],
  ['kyun nahi bata rahe', 'hinglish'],
  ['kitna cgpa hai', 'hinglish'],
  ['uski padhai kaisi hai', 'hinglish'],
  ['mera naam kya', 'hinglish'],
  ['ye project kisne banaya', 'hinglish'],
  ['matlab kya hai', 'hinglish'],
  ['achha theek hai', 'hinglish'],
  ['sab kuch batao', 'hinglish'],
  ['koi internship hai kya', 'hinglish'],
  ['jankari chahiye', 'hinglish'],
  ['madad karo', 'hinglish'],
  ['uske bare me bataiye', 'hinglish'],
  ['namaste sir', 'hinglish'],
  ['dhanyavad', 'hinglish'],
  ['uska project dikhao', 'hinglish'],
  ['hum jaise log', 'hinglish'],
  ['uska email bhejo', 'hinglish'],
  ['kya kar sakta hai', 'hinglish'],
  ['kab graduate hoga', 'hinglish'],
  ['kahan rehta hai', 'hinglish'],
  ['sirf skills batao', 'hinglish'],
  ['bohot accha hai', 'hinglish'],
  ['thoda detail do', 'hinglish'],
  ['usko interview ke liye bulao', 'hinglish'],
  ['zyada jankari chahiye', 'hinglish'],
  ['poora project dikhao', 'hinglish'],

  /* ── English (35) ───────────────────────────────────────────── */
  ['What is his CGPA?', 'en'],
  ['Tell me about his projects', 'en'],
  ['Show me his GitHub', 'en'],
  ['Does he have any internships?', 'en'],
  ['How many projects has he built?', 'en'],
  ['Give me his contact details', 'en'],
  ['Is he open to internships?', 'en'],
  ['Hello', 'en'],
  ['Thank you', 'en'],
  ['list his skills', 'en'],
  ['What kind of developer is he?', 'en'],
  ['explain his architecture', 'en'],
  ['who is aashish', 'en'],
  ['where does he study', 'en'],
  ['can you tell me about the bootcamp', 'en'],
  ['what are his strengths', 'en'],
  ['is he available for work', 'en'],
  ['how do I contact him', 'en'],
  ['does he know typescript', 'en'],
  ['show me the projects please', 'en'],
  ['which databases does he use', 'en'],
  ['tell me about goal tracker', 'en'],
  ['who built this portfolio', 'en'],
  ['what is his email address', 'en'],
  ['does he have a resume', 'en'],
  ['what does he do', 'en'],
  ['explain his tech stack', 'en'],
  ['list all his certifications', 'en'],
  ['who is he and what has he built', 'en'],
  ['is this portfolio built by him', 'en'],
  ['can he work in a team', 'en'],
  ['what is his availability', 'en'],
  ['show his linkedin profile', 'en'],
  ['has he deployed anything', 'en'],
  ['thank you for the information', 'en'],

  /* ─ Latin, no function words → weak English (8) ────────────── */
  ['CGPA', 'en'],
  ['mongodb', 'en'],
  ['React 19', 'en'],
  ['PostgreSQL', 'en'],
  ['drizzle orm', 'en'],
  ['github', 'en'],
  ['skills', 'en'],
  ['portfolio', 'en'],

  /* ─ empty / non-language (5) ───────────────────────────────── */
  ['', 'en'],
  ['   ', 'en'],
  ['12345', 'en'],
  ['!!!', 'en'],
  ['---', 'en'],

  /* ─ English words that MUST NOT read as Hinglish (8) ──────── */
  ['main thread', 'en'],
  ['main.js', 'en'],
  ['log file', 'en'],
  ['key value', 'en'],
  ['no', 'en'],
  ['to', 'en'],
  ['the', 'en'],
  ['in', 'en'],
];

test('§8.3 — the case table has at least 100 entries', () => {
  assert.ok(CASES.length >= 100, `expected >=100 cases, got ${CASES.length}`);
});

for (const [input, expected] of CASES) {
  test(`detect(${JSON.stringify(input)}) === ${expected}`, () => {
    const r = detectLanguage(input);
    assert.equal(r.lang, expected,
      `"${input}" -> got ${r.lang} (dev=${r.devRatio} hl=${r.hinglishHits} en=${r.englishHits})`);
  });
}

test('tokenize keeps Latin and Devanagari runs, lower-cased', () => {
  assert.deepEqual(tokenize('Kya HAI uska CGPA?'), ['kya', 'hai', 'uska', 'cgpa']);
  assert.deepEqual(tokenize('आशीष कुमार'), ['आशीष', 'कुमार']);
  assert.deepEqual(tokenize('!!!'), []);
});

test('every verdict carries the four diagnostic fields', () => {
  for (const [input] of CASES) {
    const r = detectLanguage(input);
    assert.equal(typeof r.devRatio, 'number');
    assert.equal(typeof r.hinglishHits, 'number');
    assert.equal(typeof r.englishHits, 'number');
    assert.equal(typeof r.tokens, 'number');
    assert.ok(['strong', 'weak'].includes(r.strength));
  }
});

test('smoothing: strong signals switch language immediately', () => {
  const t = createLanguageTracker('en');
  assert.equal(t.push('What is his CGPA?').lang, 'en');
  assert.equal(t.push('uska naam kya hai').lang, 'hinglish');
  assert.equal(t.push('उसका नाम क्या है').lang, 'hi');
  assert.equal(t.push('batao uska email').lang, 'hinglish');
  assert.equal(t.push('list his skills').lang, 'en');
});

test('smoothing: a weak signal defers to the previous turn', () => {
  const t = createLanguageTracker('en');
  t.push('uska naam kya hai');            /* -> hinglish (strong) */
  assert.equal(t.current, 'hinglish');
  assert.equal(t.push('CGPA').lang, 'hinglish');    /* weak -> stays */
  assert.equal(t.push('mongodb').lang, 'hinglish'); /* weak -> stays */
  assert.equal(t.push('Tell me about him').lang, 'en'); /* strong -> switches */
});

test('smoothing: the switched flag is accurate', () => {
  const t = createLanguageTracker('en');
  assert.equal(t.push('who is aashish').switched, false);
  assert.equal(t.push('uska naam kya hai').switched, true);
  assert.equal(t.push('kya hai uska cgpa').switched, false);
});

test('reset() restores the initial language', () => {
  const t = createLanguageTracker('en');
  t.push('uska naam kya hai');
  assert.equal(t.current, 'hinglish');
  t.reset();
  assert.equal(t.current, 'en');
});

test('voiceHint maps language -> BCP-47 for the TTS tier (§11.4)', () => {
  assert.equal(voiceHint('hi'), 'hi-IN');
  assert.equal(voiceHint('hinglish'), 'en-IN');
  assert.equal(voiceHint('en'), 'en-US');
  assert.deepEqual(Object.keys(LANG_LABEL).sort(), ['en', 'hi', 'hinglish']);
});