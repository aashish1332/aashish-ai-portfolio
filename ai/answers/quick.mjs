/* ═══════════════════════════════════════════════════════════════
   ai/answers/quick.mjs — §5.1 step 2's deterministic half, and the §8.4
   layer-1 gate. **It does not answer, and it does not word.**

   The owner retired Quick Answers as answers: a template presented in the same
   bubble as a generated sentence teaches a visitor nothing about which one
   they are reading. So the model is the only thing that answers, and this
   module is the half the *routing* still needs — the things a question can be
   decided by without generating and without wording:

     · the intent (§5.1 step 2) and the named project,
     · the §8.4 layer-1 verdict: is this question even in the base?,
     · the §9 injection verdict, and §14's hallucination-bait verdict,
     · the §8.2 focus entity a pronoun follow-up resolves against,
     · which public facts a question is about — the §12 "show me where"
       resolver's anchors, and the ids §8.2 hands the model as context, and
     · the §5.1 step-7 follow-up chips.

   WHAT IT SAYS IS DECIDED HERE; HOW IT WOULD BE SAID IS NOT. Each path
   returns a **plan** — a small, serializable description of what was selected
   — and `text` is only filled for the replies that are not portfolio answers
   at all: the §9 injection refusal, the identity disclosure, and small talk.
   All three are fixed statements about the assistant rather than claims about
   Aashish, so they are not a template standing in for a model answer; they
   ship, and the panel renders them. Small talk joined them on 2026-10-31,
   after the model was measured answering an English "hi" in Hinglish — see
   `greetingReply` below.

   The deterministic *wording* — the greetings, the skill lists, the project
   summaries, the abstention sentences — used to be built on every question and
   thrown away by the chat shell (§4's chunk paid ~6.9 KB gz for it on every
   visitor's device). It now lives in `evaluation/answer-text.mjs`, which the
   build never copies, and which is what the evaluation set and the calibration
   sweep run. A caller that wants the old behaviour passes `opts.say` — see
   that module's `quickAnswer`, which is otherwise a drop-in replacement.

   What has NOT changed: every read goes through the §1 public view, a
   `public:false` fact is unreachable from any path, and no value is hardcoded
   — change a fact in `knowledge.json` and every language changes with it.
   `tests/quick-answers.test.mjs` asserts that against the real base in all
   three languages.
   ═══════════════════════════════════════════════════════════════ */
import { detectIntent, INJECTION_REPLY } from '../intent/rules.mjs';
import { detectLanguage } from '../language/detect.mjs';
import {
  buildIndex, search, normalize, contentTokens, similarity,
  MIN_TOP_SCORE, FUZZY_MIN, estimateTokens,
} from '../retrieval/index.mjs';
import { viewOf, withheldFacts } from '../knowledge/view.mjs';
import { replacePlaceholders } from '../knowledge/placeholders.mjs';

/** Pick the language variant. English is the fallback, never a placeholder. */
export const tri = (lang, en, hi, hinglish) =>
  (lang === 'hi' ? hi : lang === 'hinglish' ? hinglish : en);

/* ── a soft, testable ceiling ────────────────────────────────────
   Measured by test against the real knowledge base. It is not enforced at
   runtime: cutting a skills list in half would drop facts silently, which is
   worse than a long answer. */
export const MAX_ANSWER_CHARS = 1200;

/* ── fact index ──────────────────────────────────────────────────
   id → {kind, fact} for the PUBLIC facts only. `public:false` facts are
   unreachable from any answer path, which is the §8.1 gate enforced in
   the engine rather than trusted to reviewers. */
function indexFacts(kb) {
  const m = new Map();
  const put = (kind, f, fallbackId) => {
    if (!f || f.public === false) return;
    const id = f.id || fallbackId;
    if (id) m.set(id, { kind, fact: f });
  };

  put('person', kb.person);
  for (const [key, c] of Object.entries(kb.contact || {})) put('contact', c, `contact.${key}`);
  for (const l of kb.links || []) put('link', l);
  for (const e of kb.education || []) put('education', e);
  for (const s of kb.skills || []) put('skill', s);
  for (const pr of kb.projects || []) put('project', pr);
  for (const e of kb.experience || []) put('experience', e);
  for (const c of kb.certifications || []) put('certification', c);
  for (const a of kb.achievements || []) put('achievement', a);
  if (kb.workflow) put('workflow', kb.workflow);
  return m;
}

/** Every public fact id — the allowlist §5.1 step 6 resolves against. */
export function factIds(kb) {
  return [...indexFacts(viewOf(kb)).keys()];
}

/* ── date formatting ─────────────────────────────────────────────
   knowledge.json stores ISO dates. Rendering "2026-07-04" to a visitor
   is sloppy, so format deterministically (no locale, no Intl — this has
   to behave identically in tests). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const mon = MONTHS[Number(m[2]) - 1] || m[2];
  return m[3] ? `${m[3]} ${mon} ${m[1]}` : `${mon} ${m[1]}`;
}

/** "CGPA <value>/<scale>" · "<value>%" · "Grade <letter>" — whichever the fact declares. */
function scoreText(score) {
  if (!score) return '';
  const { type, value, scale } = score;
  if (type === 'CGPA') return `CGPA ${value}${scale ? `/${scale}` : ''}`;
  if (type === 'percentage') return `${value}%`;
  if (type === 'grade') return `Grade ${value}`;
  return `${type} ${value}`;
}

/**
 * The RAW public fact object for an id, or null — the whole entry a plan
 * selected, not just its rendered value. The data-file answer path scopes
 * plans against it (a score question keeps only score-bearing facts) and
 * the §14 grader grounds a data-file answer against the FULL entry, because
 * the entry — not one rendered summary line — is what the file vouches for.
 * `public:false` facts are null here, same gate renderFact applies.
 */
export function rawFact(kb, id) {
  return indexFacts(viewOf(kb)).get(id)?.fact ?? null;
}

/**
 * The verbatim value of one public fact (§5.1 step 6).
 * Returns '' for an unknown or non-public id — callers treat that as
 * "unresolved", never as an empty fact.
 */
export function renderFact(kb, id, lang = 'en') {
  const entry = indexFacts(viewOf(kb)).get(id);
  if (!entry) return '';
  const { kind, fact: f } = entry;

  switch (kind) {
    case 'person':
      return f.name || '';
    case 'contact':
      return f.value || '';
    case 'link':
      return f.url || '';
    case 'skill':
      return f.name || '';
    case 'workflow':
      return f.text || '';
    case 'project':
      return f.summary || '';
    case 'achievement':
      return f.text || '';
    case 'education': {
      const bits = [f.institution];
      const course = [f.degree, f.field].filter(Boolean).join(', ');
      if (course) bits.push(`— ${course}`);
      const when = [f.start, f.end].filter(Boolean).join('–');
      if (when) bits.push(`(${when})`);
      const s = scoreText(f.score);
      if (s) bits.push(`· ${s}`);
      return bits.join(' ');
    }
    case 'certification': {
      const bits = [f.name];
      if (f.issuer) bits.push(`— ${f.issuer}`);
      const when = f.date ? fmtDate(f.date)
        : [fmtDate(f.start), fmtDate(f.end)].filter(Boolean).join('–');
      if (when) bits.push(`· ${when}`);
      const s = scoreText(f.score);
      if (s) bits.push(`· ${s}`);
      return bits.join(' ');
    }
    case 'experience': {
      /* `organization` is deliberately NOT rendered: knowledge.json records
         it as "provider not stated in the CV" (CONFLICTS C4), and printing
         that note as an employer name would be a fabrication. */
      const bits = [f.title];
      const when = [f.start ? fmtDate(f.start) : '', f.end ? fmtDate(f.end) : '']
        .filter(Boolean).join('–');
      if (when) bits.push(`(${when})`);
      if (f.grade) bits.push(`· Grade ${f.grade}`);
      return bits.join(' ');
    }
    default:
      return f.text || f.name || f.value || '';
  }
}

/* ── pricing a hit by what the model will read ───────────────────
   §8.2's budget is "≤ ~300 tokens of CONTEXT", and the context is
   `contextLines()`: one compact rendered value per fact. The retrieval index,
   meanwhile, has one fat chunk per fact — a project chunk at its widest here
   is 1175 characters of name, codename, summary, tech, role, status, dates,
   highlights, links and attribution, while `renderFact` sends the 300
   characters of summary. Pricing the chunk against the context budget prices
   the wrong string, and the error is not neutral: at the honest ratio the
   biggest, most relevant chunk blew the budget alone and was skipped, so
   "goal tracker" retrieved nothing.

   So both callers that will hand evidence to a model price hits with this.
   A hit that renders to nothing (a `public:false` field the index still
   carries, or an id the view does not know) costs 0 and is therefore never
   the reason a chunk was admitted — see `retrieve()` in `ai/answers/model.mjs`,
   which drops those rather than treating them as "something to read". */
export function contextSizer(kb, lang = 'en') {
  const seen = new Map();
  return (chunk) => {
    let n = seen.get(chunk.id);
    if (n === undefined) {
      const value = renderFact(kb, chunk.id, lang);
      n = value ? estimateTokens(`[${chunk.id}] ${value}`) : 0;
      seen.set(chunk.id, n);
    }
    return n;
  };
}

/**
 * Resolve `<|fact:id|>` placeholders against the public allowlist
 * (§5.1 step 6). Unknown ids are dropped and reported, never guessed —
 * the caller can then fail the faithfulness guard.
 */
export function resolveFacts(kb, text, lang = 'en') {
  const unresolved = [];
  const out = replacePlaceholders(text, (id) => {
    const v = renderFact(kb, id, lang);
    if (!v) { unresolved.push(id); return ''; }
    return v;
  });
  return { text: out, unresolved };
}

/* ── voice (§10) ─────────────────────────────────────────────────
   §5 is explicit: the assistant "speaks about Aashish in the third person and
   never pretends to be him". This build used to ship the opposite default —
   answers in his own voice, "my CGPA" — on the reasoning that a visitor is
   being introduced to him on a page he wrote. That reasoning is a *product*
   preference and the clause is a *requirement*, and only one of them can
   decide a default: `'third'` is the default, `'first'` is one option away
   (`quickAnswer(kb, q, { persona: 'first' })`), and both remain fully
   implemented because the evaluation set, the SFT corpus and the prompt
   contract are all written against both.

   Everything the assistant says about ITSELF stays in the first person — the
   identity disclosure, the refusals' framing, the §11.1 greeting and tour —
   which is what makes this a persona switch rather than a silence switch. */
export const PERSONAS = ['first', 'third'];
export const DEFAULT_PERSONA = 'third';
export const pick = (persona, third, first) => (persona === 'first' ? first : third);

const firstName = (kb) => String(kb?.person?.name || 'Aashish').split(' ')[0];
const fullName = (kb) => String(kb?.person?.name || 'Aashish Kumar');

/**
 * The ONE place that must not join the fiction. "Are you Aashish?" is a direct
 * question about identity, and answering "yes" would be a lie about a person —
 * so this discloses what is speaking. It is a statement about the assistant,
 * not a portfolio claim, which is why it ships as fixed text rather than being
 * generated (`routeQuestion` gives it its own path for the same reason).
 */
export function disclosure(kb, lang, persona = DEFAULT_PERSONA) {
  /* Under `'third'` — the default — this is the honest sentence: the assistant
     says what it is and denies being him. The `'first'` variant is the one that
     claims to be Aashish, which is exactly what §5 forbids; it stays for the
     evaluation set that measures both voices. */
  return tri(lang,
    pick(persona,
      `I'm ${firstName(kb)}'s AI Portfolio Assistant — not ${firstName(kb)} himself. I answer questions about his work, skills and background using only his portfolio data.`,
      `That's me — ${fullName(kb)}. One thing I'll say plainly: this is my portfolio assistant, answering in my voice and using only my portfolio data. Ask me about my work, skills or background.`),
    pick(persona,
      `मैं ${firstName(kb)} का AI पोर्टफोलियो असिस्टेंट हूँ — ${firstName(kb)} खुद नहीं। मैं उनके काम, स्किल्स और पढ़ाई से जुड़े सवालों का जवाब सिर्फ़ उनके पोर्टफोलियो डेटा से देता हूँ।`,
      `यह मैं ही हूँ — ${fullName(kb)}। एक बात साफ़ कह दूँ: यह मेरा पोर्टफोलियो असिस्टेंट है, जो मेरी आवाज़ में और सिर्फ़ मेरे पोर्टफोलियो डेटा से जवाब देता है। मेरे काम, स्किल्स या पढ़ाई के बारे में पूछ सकते हैं।`),
    pick(persona,
      `Main ${firstName(kb)} ka AI Portfolio Assistant hoon — ${firstName(kb)} khud nahi. Main unke kaam, skills aur padhai ke baare mein sirf unke portfolio data se bata sakta hoon.`,
      `Ye main hi hoon — ${fullName(kb)}. Ek baat saaf keh doon: ye mera portfolio assistant hai, meri awaaz mein aur sirf mere portfolio data se jawab deta hai. Mere kaam, skills ya padhai ke baare mein pooch sakte hain.`));
}

/* ── small talk ──────────────────────────────────────────────────

   A greeting, a goodbye, a thank-you and "how are you" are questions about
   the ASSISTANT, not about Aashish: their correct answer names no fact, so
   there is nothing for the guard to ground and nothing for a 49.6M checkpoint
   to get right. It got them wrong anyway, twice, and both are measured:

   · 2026-10-18, the shipped export: "hi" → ` I study at <|fact:edu.lpu|>. `
     — the education frame, recited at a hello;
   · 2026-10-31, the shipping export, this laptop: "hi" (English, per
     `detectLanguage`) → ` Namaste! Aashish ke projects, skills, padhai ya
     contact ke baare mein pucho. ` — an English visitor greeted in Hinglish.
     The guard passed it: Hinglish is Roman script, and §8.4's language rule
     is script-shaped.

   A wrong first sentence is the most expensive one to get wrong, and the fix
   is not another model: it is the fixed, localized, claim-free reply the
   planner has shipped before (owner decision 2026-10-11), which is why
   `routeQuestion` gives it its own path (`fixed`) instead of the model's.

   The same words live in `ai/answers/wording.mjs` (the evaluation/build twin,
   which reads this plan) and `QA-12` asserts the two are identical for every
   shape, language and voice — so this copy cannot drift from the words the
   tests grade.
 */
export function greetingReply(kb, lang, persona = DEFAULT_PERSONA, plan = {}) {
  return plan.farewell
    ? tri(lang,
      pick(persona,
        'Goodbye! Happy to tell you more about his projects, skills or education anytime.',
        'Goodbye! Come back anytime to talk about my work, skills or projects.'),
      pick(persona,
        'अलविदा! उनके प्रोजेक्ट्स, स्किल्स या पढ़ाई के बारे में कभी भी फिर पूछ सकते हैं।',
        'अलविदा! मेरे काम, स्किल्स या प्रोजेक्ट्स के बारे में कभी भी बात करने आइए।'),
      pick(persona,
        'Alvida! Unke projects, skills ya padhai ke baare mein kabhi bhi phir pooch sakte hain.',
        'Alvida! Mere kaam, skills ya projects ke baare mein kabhi bhi baat karne aaiye.'))
    : plan.wellbeing
    ? tri(lang,
      pick(persona,
        `I'm doing well, thanks for asking! Ask me anything about his projects, skills or education.`,
        `I'm doing well, thanks for asking! Ask me anything about my projects, skills or education.`),
      pick(persona,
        'मैं ठीक हूँ, पूछने के लिए धन्यवाद! उनके प्रोजेक्ट्स, स्किल्स या पढ़ाई के बारे में कुछ भी पूछें।',
        'मैं ठीक हूँ, पूछने के लिए धन्यवाद! मेरे प्रोजेक्ट्स, स्किल्स या पढ़ाई के बारे में कुछ भी पूछें।'),
      pick(persona,
        'Main theek hoon, poochne ke liye shukriya! Unke projects, skills ya padhai ke baare mein kuch bhi poochein.',
        'Main theek hoon, poochne ke liye shukriya! Mere projects, skills ya padhai ke baare mein kuch bhi poochein.'))
    : plan.thanks
    ? tri(lang,
      pick(persona, 'Anytime! Ask me anything else about Aashish.', 'Anytime! Ask me anything else.'),
      pick(persona, 'खुशी हुई! Aashish के बारे में और कुछ भी पूछ सकते हैं।', 'खुशी हुई! और कुछ भी पूछ सकते हैं।'),
      pick(persona, 'Khushi hui! Aashish ke baare mein aur kuch bhi pooch sakte hain.', 'Khushi hui! Aur kuch bhi pooch sakte hain.'))
    : tri(lang,
      pick(persona,
        `Hi! I'm ${firstName(kb)}'s AI Portfolio Assistant. Ask me about his projects, skills, education, or how to reach him.`,
        `Hi — I'm ${fullName(kb)}. Ask me about my projects, skills, education, or how to reach me.`),
      pick(persona,
        `नमस्ते! मैं ${firstName(kb)} का AI पोर्टफोलियो असिस्टेंट हूँ। आप उनके प्रोजेक्ट्स, स्किल्स, पढ़ाई या संपर्क के बारे में पूछ सकते हैं।`,
        `नमस्ते — मैं ${fullName(kb)} हूँ। मेरे प्रोजेक्ट्स, स्किल्स, पढ़ाई या संपर्क के बारे में पूछ सकते हैं।`),
      pick(persona,
        `Namaste! Main ${firstName(kb)} ka AI Portfolio Assistant hoon. Aap unke projects, skills, padhai ya contact ke baare mein pooch sakte hain.`,
        `Namaste — main ${fullName(kb)} hoon. Mere projects, skills, padhai ya contact ke baare mein pooch sakte hain.`));
}

/* ── selection ───────────────────────────────────────────────────
   One entry per intent bucket, and every one of them returns a PLAN — what
   was selected and nothing about how to say it. The wording lives in
   `evaluation/answer-text.mjs`, which reads the same plan.

   `sources` is the part §12 and §8.2 consume: the public fact ids the answer
   is about. It is produced here, so it cannot depend on the wording. */
const publicContact = (kb) => Object.fromEntries(Object.entries(kb.contact || {})
  .filter(([, f]) => f && f.public !== false));
const publicLinks = (kb) => (kb.links || []).filter((l) => l.public !== false);
const projectIds = (kb) => (kb.projects || []).filter((p) => p.public !== false).map((p) => p.id);
const experienceIds = (kb) => [...(kb.experience || []).filter((e) => e.public !== false).map((e) => e.id),
  ...(kb.contact?.availability ? [kb.contact.availability.id] : [])];

/* Category words a visitor actually types, mapped to the schema's keys. */
export const CATEGORY_WORDS = [
  [/\blanguages?\b/i, 'language'],
  [/\b(?:frontend|front[-\s]?end|ui)\b/i, 'frontend'],
  [/\b(?:backend|back[-\s]?end|server)\b/i, 'backend'],
  [/\b(?:databases?|db|sql)\b/i, 'database'],
  [/\b(?:ai|ml|machine learning)\b/i, 'ai-ml'],
  [/\b(?:security|auth)\b/i, 'security'],
  [/\b(?:tools?|tooling|editor)\b/i, 'tooling'],
  [/\b(?:soft skills?|working style)\b/i, 'soft'],
];

/**
 * §8.4's contact question, field-aware. A question about the email is about
 * the email, not the whole contact block — and a question aimed at a withheld
 * field is declined BEFORE any field is matched.
 *
 * This decision used to live inside the contact *template*, which meant "is
 * this about a private field?" was answered only because the intent happened
 * to be `contact`. It is routing, so it is here.
 */
function contactPlan(kb, question, withheld) {
  const q = String(question || '');
  const c = publicContact(kb);
  const find = (re) => Object.values(c).find((f) => f.aliases?.some((a) => re.test(a)));
  const links = publicLinks(kb);

  /* The aliases are metadata from the raw base; the value itself is only
     present in the public view, so it cannot be echoed even by accident. */
  const norm = normalize(q);
  const askedWithheld = (withheld || []).some((f) => f.aliases
    .some((a) => { const t = normalize(a); return t && norm.includes(t); }));
  /* Devanagari never survives `normalize()` into a Latin alias, so "उनका फ़ोन
     नंबर क्या है?" matched no withheld record, fell through to `contact_all`,
     and was answered from whatever retrieval offered — MEASURED 2026-11-04 as
     d21, refused only because the guard caught the wrong language. The field
     is identified by its own id/aliases, so a new scripted spelling is an
     alias or this table, never a branch in the handler. */
  const SCRIPT_FIELD = [
    [/फ़ोन|फोन|मोबाइल|नंबर/, /phone|mobile|फ़ोन|फोन|मोबाइल|नंबर/i],
    [/ईमेल|इमेल|मेल/, /e-?mail|ईमेल|इमेल/i],
  ];
  const askedWithheldInScript = (withheld || []).some((f) => SCRIPT_FIELD.some(
    ([qre, fre]) => qre.test(q)
      && (fre.test(String(f.id || '')) || (f.aliases || []).some((a) => fre.test(a)))));
  if (askedWithheld || askedWithheldInScript) {
    return { plan: { kind: 'contact_withheld' }, sources: [], private: true };
  }

  const field = (re, name, test) => {
    if (!test.test(q)) return null;
    const f = find(re);
    return f ? { plan: { kind: 'contact_field', field: name, id: f.id }, sources: [f.id] } : null;
  };
  const picked = field(/email|mail/i, 'email', /\b(e-?mail|mail|gmail)\b/i)
    || field(/phone|mobile/i, 'phone', /\b(phone|mobile|number|call)\b/i)
    || field(/location|city/i, 'location', /\blocation|where does he live|where do you live|city\b/i)
    || field(/available|hiring/i, 'availability', /\bavailable|availability|hiring|open to\b/i);
  if (picked) return picked;

  if (/\b(github|linkedin|profile|links?|repos?|repository|code)\b/i.test(q) && links.length) {
    return { plan: { kind: 'contact_links' }, sources: links.map((l) => l.id) };
  }
  return {
    plan: { kind: 'contact_all' },
    sources: [...Object.values(c).map((f) => f.id), ...links.map((l) => l.id)].filter(Boolean),
  };
}

/* ── school level ────────────────────────────────────────────────
   A question that NAMES A SCHOOL LEVEL is about one record. "what is his 10th
   percentage?" answered with the education list hands the model three scores
   and one slot, and the checkpoint fills that slot with the entry its training
   saw (`edu.lpu`/`ach.lpu-cgpa`) — right shape, wrong fact. So the marker
   decides *whether* to narrow, and the knowledge base's own aliases decide
   *which* record wins, exactly as `detectProject` does: adding a third school
   record needs an alias, never a code change here. Measured 2026-10-24, the
   day `edu.kv1` (Class 10, 83 %) was added. */
const LEVEL_MARKER = /\b(10th|tenth|class ?(10|ten)|matriculation|high ?school|12th|twelfth|class ?(12|twelve)|senior secondary|intermediate|dasvi|dasvin|barhvi)\b/i;
const LEVEL_SCRIPT = /दसवीं|१०वीं|10वीं|बारहवीं|१२वीं|12वीं/;

/** The education record a level-naming question is about, or `null`. */
export function levelEducation(kb, question) {
  const q = ` ${normalize(String(question || ''))} `;
  if (!LEVEL_MARKER.test(q) && !LEVEL_SCRIPT.test(q)) return null;
  let best = null;
  let bestLen = 0;
  for (const e of kb.education || []) {
    if (e.public === false) continue;
    for (const alias of e.aliases || []) {
      const a = normalize(alias);
      /* Longest alias wins: "10th percentage" must beat the bare "10th" that
         the same record also carries, and an alias shared by two records must
         not decide between them by array order. */
      if (a && q.includes(` ${a} `) && a.length > bestLen) {
        best = e;
        bestLen = a.length;
      }
    }
  }
  return best;
}

/** `null` when the intent is not one this layer selects for. */
function planFor(kb, det, ctx) {
  const q = String(ctx.question || '');
  switch (det.intent) {
    case 'greeting': {
      /* "thanks" gets an acknowledgement, not the full introduction; "how are
         you?" gets wellbeing answered (it is small talk about the ASSISTANT),
         and a goodbye is answered rather than refused. All three shapes are
         worded by the same fixed reply the plan names — see wording.mjs —
         which the guard never sees, because none of them claims a fact. */
      const plan = { kind: 'greeting',
        thanks: /\b(thanks|thank you|dhanyavad|dhanyawad|shukriya|शुक्रिया|धन्यवाद)/i.test(q),
        farewell: /\b(bye|good ?bye|see (ya|you)|take care|alvida|night|milte)/i.test(q),
        wellbeing: /\b(how (are|r|is) (you|u|everything|it going)|how('s| is) (it |life |things |your )?(day|week)|what('s| is) up|kaise|kaisa|kaisi|kese|kesa|kesi|क्या हाल|कैसे)/i.test(q),
      };
      /* Exactly the frame training gave a greeting: every §7.4 greeting
         example pairs the question with the one line `build_context(f,
         ["person.name"])` (ai/data/instruction.py), so that — and only that —
         is what the model sees here.

         The education lines had been added on 2026-10-17 to make the shipped
         checkpoint's answer ground. That was the wrong repair: measured
         2026-10-18 against the shipped export, the checkpoint answers "hi"
         with `I study at <|fact:edu.lpu|>` with the person line ALONE, so the
         extra facts never changed the words the visitor saw — they only made
         a greeting recite education instead of being recognised as the
         out-of-distribution recitation it is. The greeting that ships once
         the checkpoint is instruction-tuned is claim-free, so the trained
         frame needs no education context at all. */
      /* The answer is the fixed line, here, where the plan is made: small
         talk claims nothing, so there is nothing to generate and nothing to
         ground — and `routeQuestion` reads this `text` to decide the turn
         without a model. */
      plan.text = greetingReply(kb, ctx.lang, ctx.persona, plan);
      return { plan,
        sources: kb.person?.id ? [kb.person.id] : [] };
    }
    case 'meta':
      return { plan: { kind: 'meta' }, sources: [kb.person?.id || 'person.name'] };
    case 'contact':
      return contactPlan(kb, q, ctx.withheld);
    case 'list_projects':
      return { plan: { kind: 'list_projects', ids: projectIds(kb) }, sources: projectIds(kb) };
    case 'skills': {
      const all = (kb.skills || []).filter((s) => s.public !== false);
      const only = (CATEGORY_WORDS.find(([re]) => re.test(q)) || [])[1];
      const list = only ? all.filter((s) => s.category === only) : all;
      return {        plan: { kind: 'skills', ids: list.map((s) => s.id), category: only || null },
        sources: list.map((s) => s.id) };
    }
    case 'education': {
      /* A CGPA/marks question is about the score, not the degree: it cites the
         achievement fact that carries the metric. The education regex in
         intent/rules.mjs matches 'cgpa', so without this split every "what is
         his CGPA?" was answered — and graded (§14 d03/d13/s01, which used to
         expect `edu.lpu`) — from the institution entry whose *rendered text*
         happens to contain the score. Right value, wrong fact id, and the
         model answers one slot for it: `<|fact:ach.lpu-cgpa|>`. The ids stay
         in one plan so `say` renders them together (answer-text.mjs looks
         each id up by its own kind and skips what it does not know). */
      const q = String(ctx.question || '');
      const scoreQ = /\b(cgpa|gpa|marks?|percentage|grades?|sgpa|सीजीपीए|अंक)\b/i.test(q);
      const level = levelEducation(kb, q);
      let pool = level ? [level] : (kb.education || []).filter((e) => e.public !== false);
      /* A question that NAMES a metric is about the record that carries it, so
         "what is his CGPA" does not put the school percentages into the same
         one-slot answer. Falls back to the whole list when no record carries
         the metric, rather than selecting nothing. */
      if (!level && /\b(cgpa|gpa|sgpa)\b|सीजीपीए/i.test(q)) {
        const carrying = pool.filter((e) => (e.score?.type || '').toLowerCase() === 'cgpa');
        if (carrying.length) pool = carrying;
      }
      const ids = pool.map((e) => e.id);
      /* EVERY CGPA achievement, not the first one: §14 f05 exists because "and
         what was the CGPA?" must be told apart from the Minor-in-AI CGPA, and a
         plan that quietly drops the second one makes the case pass by removing
         the choice rather than by picking right. */
      const cgpas = (kb.achievements || []).filter((a) => a.public !== false
        && (a.metric?.type || '').toLowerCase() === 'cgpa');
      /* The append exists so "what is his CGPA" cites the achievement that
         carries the metric instead of the institution entry whose rendered text
         happens to contain it. It must NOT fire for a level question: "10th
         percentage" with the CGPA achievements in the plan is two scores and
         one slot again — the model answers with the B.Tech CGPA and the school
         result it was shown goes unread.
         A level record whose own score is a CGPA (the B.Tech entry) still gets
         it, so "his university cgpa" behaves as before. */
      const wantCgpa = scoreQ && cgpas.length && (!level
        || (level.score?.type || '').toLowerCase() === 'cgpa');
      const all = wantCgpa ? [...ids, ...cgpas.map((a) => a.id)] : ids;
      return { plan: { kind: 'education', ids: all }, sources: all };
    }
    case 'certifications': {
      const ids = (kb.certifications || []).filter((c) => c.public !== false).map((c) => c.id);
      return { plan: { kind: 'certifications', ids }, sources: ids };
    }
    case 'achievements': {
      const ids = (kb.achievements || []).filter((a) => a.public !== false).map((a) => a.id);
      return { plan: { kind: 'achievements', ids }, sources: ids };
    }
    case 'experience': {
      const ids = (kb.experience || []).filter((e) => e.public !== false).map((e) => e.id);
      return { plan: { kind: 'experience', ids, availabilityId: kb.contact?.availability?.id || null },
        sources: experienceIds(kb) };
    }
    default:
      return null;
  }
}

/* ── prose intents (§5.1 step 4), decided but not worded ──────────
   ONLY these two intents are prose. Anything else must abstain or be selected
   above — an earlier version fell through to the project branch for every
   intent, which made "what is his favourite pizza" answer with the project
   list instead of abstaining (§8.4 layer 1, QA-1). */
function extractivePlan(kb, intent, ctx) {
  if (intent !== 'workflow' && intent !== 'project_detail') return null;

  if (intent === 'workflow') {
    const id = kb.workflow?.id || 'workflow.how-he-builds';
    return { plan: { kind: 'workflow', id }, sources: [id] };
  }

  /* project_detail, in priority order:
       1. the project the query NAMED (aliases resolved it)
       2. a superlative question ("strongest") → the flagship
       3. a plural question ("tell me about the projects") → the list
       4. otherwise the best project the retrieval gate found
     Picking a stray single project for a plural question would answer
     something the visitor did not ask. */
  const projects = (kb.projects || []).filter((p) => p.public !== false);
  if (!projects.length) return null;
  const q = String(ctx.question || '');
  const plural = /\bprojects\b|\bapps\b|\bportfolio work\b/i.test(q);

  let p = projects.find((x) => x.id === ctx.project);
  if (!p && !plural && /\b(strongest|biggest|best|flagship|latest|largest|main|hardest|newest)\b/i.test(q)) {
    p = projects.find((x) => x.is_latest) || projects[0];
  }
  if (!p && !plural) p = projects.find((x) => (ctx.hits || []).some((h) => h.id === x.id));
  if (!p) return { plan: { kind: 'list_projects', ids: projects.map((x) => x.id) },
    sources: projects.map((x) => x.id) };
  return { plan: { kind: 'project_detail', id: p.id }, sources: [p.id] };
}

/* ── single-fact path ────────────────────────────────────────────
   For a question no intent bucket claimed, a confident retrieval hit on a
   verbatim fact kind is still answerable. Explanations (projects, workflow,
   experience) are excluded — those DO want prose. */
const FACT_KINDS = new Set(['skill', 'contact', 'link', 'education',
  'certification', 'achievement', 'person']);

function factPlan(kb, hit, query) {
  const entry = indexFacts(kb).get(hit.id);
  if (!entry || !FACT_KINDS.has(entry.kind)) return null;
  const { kind, fact: f } = entry;

  /* The query must actually be ABOUT this fact — matching its own name or one
     of its aliases — not merely fuzzy-adjacent to text in its body. Without
     this, "what car does he drive" was answered with a bootcamp achievement
     (drive → driven, Dice 0.73) instead of abstaining (QA-3).

     Two ways to be about a fact, because the token test alone cannot see one
     of them. A declared spelling ("who is he" on person.name) has NO content
     tokens — the stop set empties it on both sides — so `[].some(...)` was
     silently `false` for every glue-only alias the base declares, and a
     recruiter asking "who is he" was refused by a fact that says it is about
     exactly that. Declaration is not fuzz: QA-3's accident is a token-level
     coincidence, and an exact phrase cannot reproduce it (CAL-2). */
  const declaredSpellings = [f.name, f.id, ...(f.aliases || [])]
    .filter(Boolean).map((a) => normalize(String(a)));
  const aboutByDeclaration = declaredSpellings.includes(normalize(query));

  const qTokens = contentTokens(query);
  const nameTokens = [f.name, f.id, ...(f.aliases || [])]
    .filter(Boolean).flatMap((a) => contentTokens(a));
  const aboutFact = aboutByDeclaration
    || qTokens.some((t) => nameTokens.some((n) => n === t || similarity(t, n) >= FUZZY_MIN));
  if (!aboutFact) return null;

  return {
    plan: {
      kind: 'fact', factKind: kind, id: f.id,
      portfolioEvidence: f.source === 'portfolio',
    },
    sources: [f.id],
  };
}

/* ── deterministic follow-ups (§5.1 step 7) ──────────────────────
   Two tables, because a chip is the VISITOR's sentence and its pronouns
   follow the voice. Under the first-person persona the chips address Aashish
   directly ("What are your skills?"), which is what a recruiter clicking
   through a conversation with him would actually say. */
const FOLLOWUPS = {
  greeting: [[`What projects has he built?`, `उन्होंने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Unhone kaun kaun se projects banaye hain?`],
    [`What are his skills?`, `उनके स्किल्स क्या हैं?`, `Unke skills kya hain?`],
    [`How can I contact him?`, `मैं उनसे कैसे संपर्क करूँ?`, `Main unse contact kaise karoon?`]],
  contact: [[`What projects has he built?`, `उन्होंने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Unhone kaun kaun se projects banaye hain?`],
    [`Is he open to internships?`, `क्या वे इंटर्नशिप के लिए उपलब्ध हैं?`, `Kya wo internship ke liye available hain?`]],
  list_projects: [[`How does he work with AI?`, `वे AI के साथ कैसे काम करते हैं?`, `Wo AI ke saath kaise kaam karte hain?`],
    [`What are his skills?`, `उनके स्किल्स क्या हैं?`, `Unke skills kya hain?`]],
  project_detail: [[`What else has he built?`, `उन्होंने और क्या बनाया है?`, `Unhone aur kya banaya hai?`],
    [`How does he work with AI?`, `वे AI के साथ कैसे काम करते हैं?`, `Wo AI ke saath kaise kaam karte hain?`]],
  skills: [[`Which databases does he use?`, `वे कौन से डेटाबेस इस्तेमाल करते हैं?`, `Wo kaun se databases use karte hain?`],
    [`What projects has he built?`, `उन्होंने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Unhone kaun kaun se projects banaye hain?`]],
  education: [[`What certifications does he have?`, `उनके पास कौन से सर्टिफिकेट हैं?`, `Unke paas kaun se certifications hain?`],
    [`What is his CGPA?`, `उनका CGPA कितना है?`, `Unka CGPA kitna hai?`]],
  certifications: [[`What is his CGPA?`, `उनका CGPA कितना है?`, `Unka CGPA kitna hai?`],
    [`What projects has he built?`, `उन्होंने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Unhone kaun kaun se projects banaye hain?`]],
  achievements: [[`What projects has he built?`, `उन्होंने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Unhone kaun kaun se projects banaye hain?`],
    [`What are his skills?`, `उनके स्किल्स क्या हैं?`, `Unke skills kya hain?`]],
  experience: [[`What projects has he built?`, `उन्होंने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Unhone kaun kaun se projects banaye hain?`],
    [`What are his skills?`, `उनके स्किल्स क्या हैं?`, `Unke skills kya hain?`]],
  workflow: [[`What projects has he built?`, `उन्होंने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Unhone kaun kaun se projects banaye hain?`],
    [`What are his skills?`, `उनके स्किल्स क्या हैं?`, `Unke skills kya hain?`]],
  abstain: [[`What projects has he built?`, `उन्होंने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Unhone kaun kaun se projects banaye hain?`],
    [`What are his skills?`, `उनके स्किल्स क्या हैं?`, `Unke skills kya hain?`],
    [`How can I contact him?`, `मैं उनसे कैसे संपर्क करूँ?`, `Main unse contact kaise karoon?`]],
};

/* The same graph, addressed to Aashish himself (see the note above). */
const FOLLOWUPS_FIRST = {
  greeting: [[`What projects have you built?`, `आपने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Aapne kaun kaun se projects banaye hain?`],
    [`What are your skills?`, `आपके स्किल्स क्या हैं?`, `Aapke skills kya hain?`],
    [`How can I contact you?`, `मैं आपसे कैसे संपर्क करूँ?`, `Main aapse contact kaise karoon?`]],
  contact: [[`What projects have you built?`, `आपने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Aapne kaun kaun se projects banaye hain?`],
    [`Are you open to internships?`, `क्या आप इंटर्नशिप के लिए उपलब्ध हैं?`, `Kya aap internship ke liye available hain?`]],
  list_projects: [[`How do you work with AI?`, `आप AI के साथ कैसे काम करते हैं?`, `Aap AI ke saath kaise kaam karte hain?`],
    [`What are your skills?`, `आपके स्किल्स क्या हैं?`, `Aapke skills kya hain?`]],
  project_detail: [[`What else have you built?`, `आपने और क्या बनाया है?`, `Aapne aur kya banaya hai?`],
    [`How do you work with AI?`, `आप AI के साथ कैसे काम करते हैं?`, `Aap AI ke saath kaise kaam karte hain?`]],
  skills: [[`Which databases do you use?`, `आप कौन से डेटाबेस इस्तेमाल करते हैं?`, `Aap kaun se databases use karte hain?`],
    [`What projects have you built?`, `आपने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Aapne kaun kaun se projects banaye hain?`]],
  education: [[`What certifications do you have?`, `आपके पास कौन से सर्टिफिकेट हैं?`, `Aapke paas kaun se certifications hain?`],
    [`What is your CGPA?`, `आपका CGPA कितना है?`, `Aapka CGPA kitna hai?`]],
  certifications: [[`What is your CGPA?`, `आपका CGPA कितना है?`, `Aapka CGPA kitna hai?`],
    [`What projects have you built?`, `आपने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Aapne kaun kaun se projects banaye hain?`]],
  achievements: [[`What projects have you built?`, `आपने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Aapne kaun kaun se projects banaye hain?`],
    [`What are your skills?`, `आपके स्किल्स क्या हैं?`, `Aapke skills kya hain?`]],
  experience: [[`What projects have you built?`, `आपने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Aapne kaun kaun se projects banaye hain?`],
    [`What are your skills?`, `आपके स्किल्स क्या हैं?`, `Aapke skills kya hain?`]],
  workflow: [[`What projects have you built?`, `आपने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Aapne kaun kaun se projects banaye hain?`],
    [`What are your skills?`, `आपके स्किल्स क्या हैं?`, `Aapke skills kya hain?`]],
  abstain: [[`What projects have you built?`, `आपने कौन-कौन से प्रोजेक्ट बनाए हैं?`, `Aapne kaun kaun se projects banaye hain?`],
    [`What are your skills?`, `आपके स्किल्स क्या हैं?`, `Aapke skills kya hain?`],
    [`How can I contact you?`, `मैं आपसे कैसे संपर्क करूँ?`, `Main aapse contact kaise karoon?`]],
};

/** Follow-up chips, computed from the graph — zero inference cost. */
export function followupsFor(intent, lang = 'en', persona = DEFAULT_PERSONA) {
  const tables = persona === 'first' ? FOLLOWUPS_FIRST : FOLLOWUPS;
  const table = tables[intent] || tables.abstain;
  return table.map(([en, hi, hinglish]) => tri(lang, en, hi, hinglish));
}

/* the index is deterministic and cheap, but not free — build it once per base */
const INDEX_CACHE = new WeakMap();
function indexFor(kb) {
  let idx = INDEX_CACHE.get(kb);
  if (!idx) { idx = buildIndex(kb); INDEX_CACHE.set(kb, idx); }
  return idx;
}

/**
 * Decide what a visitor's message is about — deterministically, with no model
 * and no network.
 *
 * @param {object} kb          parsed knowledge.json
 * @param {string} query       raw user text
 * @param {object} [opts]
 * @param {string} [opts.lang] language already smoothed by the caller's
 *                             tracker (§8.3) — otherwise detected per message
 * @param {string|null} [opts.focus] the conversation's carried focus entity (§8.2)
 * @param {'first'|'third'} [opts.persona] whose voice a rendered answer would
 *        be in. Defaults to `DEFAULT_PERSONA` (`'third'`, §5); it is carried on
 *        the result so a caller that words the answer (or a chip) does not
 *        have to be told again.
 * @param {(plan:object, ctx:object) => string} [opts.say] the wording. Omit it
 *        — as the chat shell does — and only the two fixed replies (the §9
 *        injection refusal and the identity disclosure) come back with text.
 * @param {number} [opts.minScore] the §8.4 layer-1 gate, overridable so it can
 *        be SWEPT against the evaluation set (`npm run calibrate`)
 * @returns {{handled:boolean, extractive:boolean, abstained:boolean,
 *            injection:boolean, intent:string, project:string|null,
 *            focus:string|null, lang:string, persona:string, text:string,
 *            plan:object|null, sources:string[], followups:string[]}}
 */
export function quickAnswer(kb, query, opts = {}) {
  const question = String(query || '');
  const lang = opts.lang || detectLanguage(question).lang;
  /* Both voices are accepted; anything else — including nothing — is the
     default. This was `opts.persona === 'third' ? 'third' : DEFAULT_PERSONA`,
     which was correct only while `'first'` WAS the default: the day the default
     became §5's third person, that expression silently started refusing an
     explicit `persona: 'first'` and answering in the third person anyway. The
     QA-10 twin test caught it, not a reader. */
  const persona = PERSONAS.includes(opts.persona) ? opts.persona : DEFAULT_PERSONA;
  const minScore = opts.minScore ?? MIN_TOP_SCORE;
  const det = detectIntent(question, kb);

  /* EVERY read below goes through the public view (§1): a `public:false` fact is
     absent from the facts, from the BM25 index, and from every selection. The
     withheld field ids/aliases are kept as metadata so a question aimed at one
     can be declined with a useful answer rather than silence. */
  const withheld = withheldFacts(kb);
  kb = viewOf(kb);
  const base = {
    handled: false, extractive: false, abstained: false, injection: false,
    /* the focus entity carries between turns: a caller passes back what this
       returned, and a pronoun follow-up resolves against it (§8.2) */
    focus: opts.focus || null,
    intent: det.intent, project: det.project, lang, persona,
    text: '', plan: null, sources: [],
    followups: [],
  };
  const say = opts.say;
  /* what a plan is worded FROM: the public view (never the raw base), the
     visitor's own words, and the turn's voice and language */
  const ctx = { kb, question, lang, persona, withheld, project: det.project, hits: null };

  /* 1. instruction-change attempts never reach a handler (§9) */
  if (det.intent === 'injection_suspect') {
    return { ...base, handled: true, injection: true,
      text: INJECTION_REPLY[lang] || INJECTION_REPLY.en };
  }

  /* 2. hallucination bait abstains, then hands over what IS known (C7/C4) */
  if (det.intent === 'hallucination_bait') {
    /* `abstained` travels ON THE PLAN because the model path reads the plan,
       not this return value (`planAbstains` in ai/answers/model.mjs). Without
       it the decoder was handed the near facts and answered them. */
    const bait = { kind: 'hallucination_bait', abstained: true, ids: (kb.experience || [])
      .filter((e) => e.public !== false).map((e) => e.id) };
    return {
      ...base, handled: true, abstained: true, plan: bait,
      text: say ? say(bait, ctx) : '',
      sources: experienceIds(kb),
      followups: followupsFor('abstain', lang, persona),
    };
  }

  /* 3. verbatim-fact buckets. The SELECTION is this module's; the wording is
     not — see this file's header. */
  const selected = planFor(kb, det, ctx);
  if (selected) {
    /* `private` is carried out, not just collapsed into `abstained`: the chat
       shell refuses a withheld-field question with a sentence about
       publication, which is different to say than "I don't have that", and the
       difference has to survive this return. */
    const shape = selected.private
      ? { abstained: true, sources: [], private: true }
      : { sources: selected.sources };
    const plan = selected.plan.kind === 'meta'
      ? { ...selected.plan, text: disclosure(kb, lang, persona) }
      : (selected.private ? { ...selected.plan, abstained: true } : selected.plan);
    return {
      ...base, handled: true, plan,
      /* `plan.text` is the fixed reply the plan carries (the disclosure, and
         small talk); a caller-supplied `say` still words everything. */
      text: say ? say(plan, ctx) : (plan.text || ''),
      /* naming a project moves the focus; every other bucket carries it */
      focus: det.project || base.focus,
      ...shape, followups: followupsFor(det.intent, lang, persona),
    };
  }

  /* one retrieval pass, shared by the prose path and the fact path */
  const searchRes = search(indexFor(kb), question, {
    focus: opts.focus || null, minScore, sizeOf: contextSizer(kb, lang),
  });
  const hits = searchRes.hits;
  ctx.hits = hits;
  base.focus = searchRes.focus || base.focus;

  /* 4. prose intents: which project, and nothing about how to describe it */
  const ex = extractivePlan(kb, det.intent, ctx);
  if (ex) {
    return {
      ...base, extractive: true, plan: ex.plan, sources: ex.sources,
      text: say ? say(ex.plan, ctx) : '',
      followups: followupsFor(det.intent, lang, persona),
    };
  }

  /* 5. nothing matched: a confident hit on a verbatim fact still routes.
     The best FACT-KIND hit is used, not necessarily hits[0]: "which AI models
     does he use" ranks the workflow chunk first (its alias carries 'ai'), yet
     the answerable fact — skill.gemini — is right there in the same result set.
     factPlan() still requires the query to be about the fact, so this skips
     past an unrenderable chunk without widening what may be answered (QA-8). */
  const factHit = hits.find((h) => {
    const e = indexFacts(kb).get(h.id);
    return e && FACT_KINDS.has(e.kind);
  });
  if (factHit && factHit.score >= minScore) {
    const fp = factPlan(kb, factHit, question);
    if (fp) {
      return { ...base, handled: true, plan: fp.plan, sources: fp.sources,
        text: say ? say(fp.plan, ctx) : '',
        followups: followupsFor('skills', lang, persona) };
    }
  }

  /* only a PROJECT hit may fall through to the project prose — otherwise a
     confident hit on something unrenderable (an experience chunk, say) would
     turn into an unrelated project list instead of an abstention (QA-2) */
  {
    const top = hits[0];
    if (top && top.score >= minScore && top.kind === 'project') {
      const fallback = extractivePlan(kb, 'project_detail', { ...ctx, project: null });
      if (fallback) {
        return { ...base, extractive: true, plan: fallback.plan, sources: fallback.sources,
          text: say ? say(fallback.plan, ctx) : '',
          followups: followupsFor('project_detail', lang, persona) };
      }
    }
  }

  /* 6. the §8.4 layer-1 abstention — reached without any inference */
  return {
    ...base, handled: true, abstained: true, plan: { kind: 'abstain' }, sources: [],
    text: say ? say({ kind: 'abstain' }, ctx) : '',
    followups: followupsFor('abstain', lang, persona),
  };
}
