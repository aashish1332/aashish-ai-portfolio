/* ═══════════════════════════════════════════════════════════════
   ai/answers/quick.mjs — §5.1 step 2's deterministic half, and the §8.4
   layer-1 gate. **It is no longer an answer source.**

   The owner retired Quick Answers as answers: a template presented in the same
   bubble as a generated sentence teaches a visitor nothing about which one
   they are reading. So the model is now the only thing that answers, and this
   module is what the *routing* still needs — the things a question can be
   decided by without generating:

     · the intent (§5.1 step 2) and the named project,
     · the §8.4 layer-1 verdict: is this question even in the base?,
     · the §9 injection verdict, and §14's hallucination-bait verdict,
     · the §8.2 focus entity a pronoun follow-up resolves against,
     · the public fact ids the §12 "show me where" resolver anchors, and
     · the §5.1 step-7 follow-up chips.

   `text` is still built for every path, because the intent decides the chips
   and the sources and the two are produced together — but the chat shell
   discards it. If you are looking for what a visitor reads, it is
   `ai/answers/model.mjs`, not here.

   What has NOT changed: every read goes through the §1 public view, a
   `public:false` fact is unreachable from any path, and no value is hardcoded
   — change a fact in `knowledge.json` and every language changes with it.
   `tests/quick-answers.test.mjs` asserts that against the real base in all
   three languages.
   ═══════════════════════════════════════════════════════════════ */
import { detectIntent, abstainFor, INJECTION_REPLY } from '../intent/rules.mjs';
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
   Answers are built compactly enough to stay under this. We deliberately
   do NOT truncate at runtime: cutting a skills list in half would drop
   facts silently, which is worse than a long answer. The contract is
   enforced by test on the real knowledge base instead. */
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

const firstSentence = (s) => String(s || '').split(/(?<=\.)\s/)[0];

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

/* ── localized labels ──────────────────────────────────────────── */
const CATEGORY_LABEL = {
  language: { en: 'Languages', hi: 'भाषाएँ', hinglish: 'Languages' },
  frontend: { en: 'Frontend', hi: 'फ्रंटएंड', hinglish: 'Frontend' },
  backend: { en: 'Backend', hi: 'बैकएंड', hinglish: 'Backend' },
  database: { en: 'Databases', hi: 'डेटाबेस', hinglish: 'Databases' },
  'ai-ml': { en: 'AI / ML', hi: 'AI / ML', hinglish: 'AI / ML' },
  security: { en: 'Security', hi: 'सिक्योरिटी', hinglish: 'Security' },
  tooling: { en: 'Tools', hi: 'टूल्स', hinglish: 'Tools' },
  soft: { en: 'Working style', hi: 'वर्क स्टाइल', hinglish: 'Working style' },
  extras: { en: 'Portfolio extras', hi: 'पोर्टफोलियो एक्स्ट्रा', hinglish: 'Portfolio extras' },
};

/** Category words a visitor actually types, mapped to the schema's keys. */
const CATEGORY_WORDS = [
  [/languages?\b/i, 'language'],
  [/frontend|front.?end|ui\b/i, 'frontend'],
  [/backend|back.?end|server/i, 'backend'],
  [/database|db\b|sql/i, 'database'],
  [/ai\b|ml\b|machine learning/i, 'ai-ml'],
  [/security|auth/i, 'security'],
  [/tools?|tooling|editor/i, 'tooling'],
  [/soft skills?|working style/i, 'soft'],
];

const firstName = (kb) => String(kb?.person?.name || 'Aashish').split(' ')[0];
const fullName = (kb) => String(kb?.person?.name || 'Aashish Kumar');
const bullet = (lines) => lines.join('\n');

/* ── voice (§10) ─────────────────────────────────────────────────
   The visitor is being shown a portfolio. They are reading it to decide
   whether to talk to Aashish, so the answers are written in HIS voice:
   "my CGPA", "my email", not "his CGPA" on a page he wrote himself.

   `pick` keeps both phrasings side by side at the template itself, in all
   three languages, instead of a regex pass over the finished text. A
   rewrite pass would have been shorter and would have quietly produced
   wrong grammar the first time a template changed its shape — this way an
   untranslated string is visible in the diff.

   `third` is kept because the raw phrasing is what the evaluation set and
   the older docs were written against, and because one caller (a
   recruiter-facing "share my portfolio" view, say) may want the neutral
   voice. It is not the default. */
export const PERSONAS = ['first', 'third'];
export const DEFAULT_PERSONA = 'first';
const pick = (persona, third, first) => (persona === 'first' ? first : third);

/* A `public:false` contact field is declined, not silently revealed, and the
   decline points at the route that IS published. Kept here rather than beside
   ABSTAIN/INJECTION_REPLY because it has to name a value from the base, and
   rules.mjs deliberately knows nothing about the knowledge base. */
function privateReply(kb, lang, persona) {
  const email = (kb.contact?.email && kb.contact.email.public !== false)
    ? kb.contact.email.value : '';
  return tri(lang,
    `That contact detail isn't published${email ? ` — the best way to reach ${pick(persona, firstName(kb), 'me')} is by email: ${email}` : ''}.`,
    `वह संपर्क विवरण सार्वजनिक नहीं है${email ? ` — ${pick(persona, `${firstName(kb)} से`, 'मुझसे')} संपर्क का सबसे अच्छा तरीक़ा ईमेल है: ${email}` : ''}।`,
    `Wo contact detail publish nahi hai${email ? ` — ${pick(persona, `${firstName(kb)} se`, 'mujhse')} contact ka best tarika email hai: ${email}` : ''}.`);
}

/* ── answer builders ─────────────────────────────────────────────
   Each builder is pure: (kb, lang, ctx) → { text, sources }.
   Templates are fixed prose; every interpolated value comes from kb. */
const BUILD = {
  greeting: (kb, lang, ctx = {}) => {
    const persona = ctx.persona || DEFAULT_PERSONA;
    return {
      /* "thanks" gets an acknowledgement, not the full introduction */
      text: /\b(thanks|thank you|dhanyavad|dhanyawad|shukriya|शुक्रिया|धन्यवाद)/i.test(String(ctx.question || ''))
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
            `Namaste — main ${fullName(kb)} hoon. Mere projects, skills, padhai ya contact ke baare mein pooch sakte hain.`)),
      sources: [],
    };
  },

  /* The ONE place that must not join the fiction. "Are you Aashish?" is a
     direct question about identity, and answering "yes" would be a lie about
     a person — so the answer discloses what is speaking while staying in the
     conversation's voice. tests/intent.test.mjs already refuses an injection
     reply that claims to be Aashish; this refuses the same claim here. */
  meta: (kb, lang, ctx = {}) => {
    const persona = ctx.persona || DEFAULT_PERSONA;
    return {
      text: tri(lang,
        pick(persona,
          `I'm ${firstName(kb)}'s AI Portfolio Assistant — not ${firstName(kb)} himself. I answer questions about his work, skills and background using only his portfolio data.`,
          `That's me — ${fullName(kb)}. One thing I'll say plainly: this is my portfolio assistant, answering in my voice and using only my portfolio data. Ask me about my work, skills or background.`),
        pick(persona,
          `मैं ${firstName(kb)} का AI पोर्टफोलियो असिस्टेंट हूँ — ${firstName(kb)} खुद नहीं। मैं उनके काम, स्किल्स और पढ़ाई से जुड़े सवालों का जवाब सिर्फ़ उनके पोर्टफोलियो डेटा से देता हूँ।`,
          `यह मैं ही हूँ — ${fullName(kb)}। एक बात साफ़ कह दूँ: यह मेरा पोर्टफोलियो असिस्टेंट है, जो मेरी आवाज़ में और सिर्फ़ मेरे पोर्टफोलियो डेटा से जवाब देता है। मेरे काम, स्किल्स या पढ़ाई के बारे में पूछ सकते हैं।`),
        pick(persona,
          `Main ${firstName(kb)} ka AI Portfolio Assistant hoon — ${firstName(kb)} khud nahi. Main unke kaam, skills aur padhai ke baare mein sirf unke portfolio data se bata sakta hoon.`,
          `Ye main hi hoon — ${fullName(kb)}. Ek baat saaf keh doon: ye mera portfolio assistant hai, meri awaaz mein aur sirf mere portfolio data se jawab deta hai. Mere kaam, skills ya padhai ke baare mein pooch sakte hain.`)),
      sources: [kb?.person?.id || 'person.name'],
    };
  },

  /* Contact is deliberately field-aware: a question about the email gets the
     email, not the entire contact block. */
  contact: (kb, lang, ctx) => {
    const q = String(ctx.question || '');
    const persona = ctx.persona || DEFAULT_PERSONA;
    /* EVERY read goes through this filter. The catch-all answer used to reach
       into `kb.contact` directly, so a `public:false` field would have been
       printed by "how can I contact him?" even though the field is marked
       private — the gate has to hold on the generic path too. */
    const c = Object.fromEntries(Object.entries(kb.contact || {})
      .filter(([, f]) => f && f.public !== false));
    const find = (re) => Object.values(c).find((f) => f.aliases?.some((a) => re.test(a)));
    const links = (kb.links || []).filter((l) => l.public !== false);

    /* a question aimed at a withheld field is declined before anything else.
       The aliases are metadata from the raw base; the value itself is only
       present in the public view, so it cannot be echoed even by accident. */
    const norm = normalize(q);
    const askedWithheld = (ctx.withheld || []).some((f) => f.aliases
      .some((a) => { const t = normalize(a); return t && norm.includes(t); }));
    if (askedWithheld) return { text: privateReply(kb, lang, persona), sources: [], private: true };

    if (/\b(e-?mail|mail|gmail)\b/i.test(q)) {
      const f = find(/email|mail/i);
      if (f) return {
        text: tri(lang,
          pick(persona, `His email is ${f.value}.`, `My email is ${f.value}.`),
          pick(persona, `उनका ईमेल ${f.value} है।`, `मेरा ईमेल ${f.value} है।`),
          pick(persona, `Unka email ${f.value} hai.`, `Mera email ${f.value} hai.`)),
        sources: [f.id],
      };
    }
    if (/\b(phone|mobile|number|call)\b/i.test(q)) {
      const f = find(/phone|mobile/i);
      if (f) return {
        text: tri(lang,
          pick(persona, `His phone number is ${f.value}.`, `My phone number is ${f.value}.`),
          pick(persona, `उनका फ़ोन नंबर ${f.value} है।`, `मेरा फ़ोन नंबर ${f.value} है।`),
          pick(persona, `Unka phone number ${f.value} hai.`, `Mera phone number ${f.value} hai.`)),
        sources: [f.id],
      };
    }
    if (/\blocation|where does he live|where do you live|city\b/i.test(q)) {
      const f = find(/location|city/i);
      if (f) return {
        text: tri(lang,
          pick(persona, `He's based in ${f.value}.`, `I'm based in ${f.value}.`),
          pick(persona, `वे ${f.value} में रहते हैं।`, `मैं ${f.value} में रहता हूँ।`),
          pick(persona, `Wo ${f.value} mein rehte hain.`, `Main ${f.value} mein rehta hoon.`)),
        sources: [f.id],
      };
    }
    if (/\bavailable|availability|hiring|open to\b/i.test(q)) {
      const f = find(/available|hiring/i);
      if (f) return { text: tri(lang, `Yes — ${f.value}.`,
        `हाँ — ${f.value}।`, `Haan — ${f.value}.`), sources: [f.id] };
    }
    if (/\b(github|linkedin|profile|links?|repos?|repository|code)\b/i.test(q) && links.length) {
      const lines = links.map((l) => `• ${l.label}: ${l.url}`);
      return {
        text: tri(lang,
          pick(persona, `${firstName(kb)}'s profiles:`, 'My profiles:'),
          `प्रोफ़ाइल:`, `Profiles:`)
          + '\n' + bullet(lines),
        sources: links.map((l) => l.id),
      };
    }

    const parts = [];
    if (c.email) parts.push(tri(lang, `Email: ${c.email.value}`, `ईमेल: ${c.email.value}`, `Email: ${c.email.value}`));
    if (c.phone) parts.push(tri(lang, `Phone: ${c.phone.value}`, `फ़ोन: ${c.phone.value}`, `Phone: ${c.phone.value}`));
    if (c.location) parts.push(tri(lang, `Location: ${c.location.value}`, `लोकेशन: ${c.location.value}`, `Location: ${c.location.value}`));
    for (const l of links) parts.push(`• ${l.label}: ${l.url}`);
    if (c.availability) parts.push(tri(lang, `Availability: ${c.availability.value}`, `उपलब्धता: ${c.availability.value}`, `Availability: ${c.availability.value}`));
    return {
      text: tri(lang,
        pick(persona, `Here's how to reach ${firstName(kb)}:`, "Here's how to reach me:"),
        pick(persona, `${firstName(kb)} से संपर्क:`, 'मुझसे संपर्क:'),
        pick(persona, `${firstName(kb)} se contact:`, 'Mujhse contact:'))
        + '\n' + bullet(parts),
      sources: [...Object.values(c).map((f) => f.id), ...links.map((l) => l.id)].filter(Boolean),
    };
  },

  list_projects: (kb, lang, ctx = {}) => {
    const persona = ctx.persona || DEFAULT_PERSONA;
    const projects = (kb.projects || []).filter((p) => p.public !== false);
    const lines = projects.map((p) => {
      /* skip the codename when it only repeats the project name
         ("Goal Tracker SaaS (GOAL TRACKER SaaS)") */
      const code = p.portfolio_codename && normalize(p.portfolio_codename) !== normalize(p.name)
        ? ` (${p.portfolio_codename})` : '';
      const status = p.status ? ` — ${p.status}` : '';
      return `• ${p.name}${code}${status}\n  ${firstSentence(p.summary)}`;
    });
    return {
      text: tri(lang,
        pick(persona, `${firstName(kb)} has ${projects.length} shipped projects:`,
          `I've shipped ${projects.length} projects:`),
        pick(persona, `${firstName(kb)} के ${projects.length} शिप्ड प्रोजेक्ट्स हैं:`,
          `मैंने ${projects.length} प्रोजेक्ट्स बनाए हैं:`),
        pick(persona, `${firstName(kb)} ke ${projects.length} shipped projects hain:`,
          `Maine ${projects.length} projects banaye hain:`))
        + '\n' + bullet(lines)
        + '\n' + tri(lang, 'Ask about any one for its stack and live link.',
          'किसी एक के बारे में पूछें — स्टैक और लाइव लिंक बताऊँगा।',
          'Kisi ek ke baare mein poocho — stack aur live link bata dunga.'),
      sources: projects.map((p) => p.id),
    };
  },

  skills: (kb, lang, ctx) => {
    const persona = ctx.persona || DEFAULT_PERSONA;
    const all = (kb.skills || []).filter((s) => s.public !== false);
    const q = String(ctx.question || '');
    const only = (CATEGORY_WORDS.find(([re]) => re.test(q)) || [])[1];
    const list = only ? all.filter((s) => s.category === only) : all;

    /* A single category keeps its own heading; the full list is grouped. */
    if (only && list.length) {
      const label = (CATEGORY_LABEL[only] || {})[lang] || only;
      return {
        text: tri(lang,
          pick(persona, `${label} he works with: `, `My ${label.toLowerCase()}: `),
          `${label}: `, `${label}: `)
          + list.map((s) => s.name).join(', ') + '.',
        sources: list.map((s) => s.id),
      };
    }

    const byCat = new Map();
    for (const s of list) {
      if (!byCat.has(s.category)) byCat.set(s.category, []);
      byCat.get(s.category).push(s);
    }
    const lines = [...byCat.entries()].map(([cat, items]) => {
      const label = (CATEGORY_LABEL[cat] || {})[lang] || cat;
      return `• ${label}: ${items.map((s) => s.name).join(', ')}`;
    });

    const extras = byCat.get('extras') || [];
    const footnote = extras.length
      ? '\n' + tri(lang,
        `${extras.map((s) => s.name).join(' and ')} ${extras.length > 1 ? 'are' : 'is'} evidenced by this portfolio, not listed on ${pick(persona, 'the CV', 'my CV')}.`,
        `${extras.map((s) => s.name).join(' और ')} — ${pick(persona, 'CV में लिस्टेड नहीं', 'मेरे CV में लिस्टेड नहीं')}, यह पोर्टफोलियो इनका सबूत है।`,
        `${extras.map((s) => s.name).join(' and ')} — ${pick(persona, 'CV mein listed nahi', 'mere CV mein listed nahi')}, ye portfolio inka proof hai.`)
      : '';

    return {
      text: tri(lang,
        pick(persona, `${firstName(kb)}'s skills (${list.length}):`,
          `My skills (${list.length}):`),
        pick(persona, `${firstName(kb)} के स्किल्स (${list.length}):`,
          `मेरे स्किल्स (${list.length}):`),
        pick(persona, `${firstName(kb)} ke skills (${list.length}):`,
          `Mere skills (${list.length}):`))
        + '\n' + bullet(lines) + footnote,
      sources: list.map((s) => s.id),
    };
  },

  education: (kb, lang) => {
    const edu = (kb.education || []).filter((e) => e.public !== false);
    const lines = edu.map((e) => `• ${renderFact(kb, e.id, lang)}`);
    const lpu = edu.find((e) => e.expected_graduation);
    const grad = lpu
      ? tri(lang, `Expected graduation: ${lpu.expected_graduation}.`,
        `अनुमानित ग्रेजुएशन: ${lpu.expected_graduation}।`,
        `Expected graduation: ${lpu.expected_graduation}.`)
      : '';
    return {
      text: tri(lang, 'Education:', 'शिक्षा:', 'Padhai:') + '\n' + bullet(lines)
        + (grad ? '\n' + grad : ''),
      sources: edu.map((e) => e.id),
    };
  },

  certifications: (kb, lang) => {
    const certs = (kb.certifications || []).filter((c) => c.public !== false);
    return {
      text: tri(lang, `Certifications and programmes (${certs.length}):`,
        `सर्टिफिकेट और प्रोग्राम (${certs.length}):`,
        `Certifications aur programmes (${certs.length}):`)
        + '\n' + bullet(certs.map((c) => `• ${renderFact(kb, c.id, lang)}`)),
      sources: certs.map((c) => c.id),
    };
  },

  achievements: (kb, lang, ctx = {}) => {
    const persona = ctx.persona || DEFAULT_PERSONA;
    const ach = (kb.achievements || []).filter((a) => a.public !== false);
    return {
      text: tri(lang, 'Highlights:', 'हाइलाइट्स:',
        pick(persona, 'Uski highlights:', 'Meri highlights:'))
        + '\n' + bullet(ach.map((a) => `• ${a.text}`)),
      sources: ach.map((a) => a.id),
    };
  },

  experience: (kb, lang, ctx = {}) => {
    const persona = ctx.persona || DEFAULT_PERSONA;
    const exp = (kb.experience || []).filter((e) => e.public !== false);
    const availability = kb.contact?.availability?.value;
    return {
      text: tri(lang,
        pick(persona,
          `${firstName(kb)}'s CV shows no employment history — no companies, internships or freelance work. Its only experience entry is training:`,
          'My CV shows no employment history — no companies, internships or freelance work. My only experience entry is training:'),
        pick(persona,
          `${firstName(kb)} के CV में कोई नौकरी नहीं है — कोई कंपनी, इंटर्नशिप या फ्रीलांस नहीं। केवल एक ट्रेनिंग एंट्री है:`,
          'मेरे CV में कोई नौकरी नहीं है — कोई कंपनी, इंटर्नशिप या फ्रीलांस नहीं। केवल एक ट्रेनिंग एंट्री है:'),
        pick(persona,
          `${firstName(kb)} ke CV mein koi employment history nahi hai — koi company, internship ya freelance nahi. Sirf ek training entry hai:`,
          'Mere CV mein koi employment history nahi hai — koi company, internship ya freelance nahi. Sirf ek training entry hai:'))
        + '\n' + bullet(exp.map((e) => `• ${renderFact(kb, e.id, lang)}`))
        + (availability ? '\n' + tri(lang, `Availability: ${availability}`, `उपलब्धता: ${availability}`, `Availability: ${availability}`) : ''),
      sources: [...exp.map((e) => e.id), ...(kb.contact?.availability ? [kb.contact.availability.id] : [])],
    };
  },
};

/* ── intents whose answer needs prose, not a lookup (§5.1 step 4) ──
   We still return verbatim KB text as an `extractive` fallback, because
   with no model on the device the assistant must still answer. */
function extractive(kb, lang, intent, ctx) {
  /* ONLY these two intents are prose. Anything else must abstain or be handled
     by a template — an earlier version fell through to the project branch for
     every intent, which made "what is his favourite pizza" answer with the
     project list instead of abstaining (§8.4 layer 1). */
  if (intent !== 'workflow' && intent !== 'project_detail') return null;
  const persona = ctx.persona || DEFAULT_PERSONA;

  if (intent === 'workflow') {
    return {
      text: tri(lang,
        pick(persona, 'How he builds: ', 'How I build: '),
        'बनाने का तरीक़ा: ',
        pick(persona, 'Kaise banate hain: ', 'Kaise banata hoon: '))
        + renderFact(kb, kb.workflow?.id || 'workflow.how-he-builds', lang),
      sources: [kb.workflow?.id || 'workflow.how-he-builds'],
    };
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
  if (!p) return BUILD.list_projects(kb, lang);

  const lines = [p.summary];
  if (p.tech?.length) lines.push(tri(lang, 'Tech: ', 'टेक: ', 'Tech: ') + p.tech.join(', '));
  if (p.links?.length) {
    lines.push(...p.links.map((l) => `${l.label}: ${l.url}`));
  }
  if (p.ai_attribution) {
    lines.push(tri(lang, 'How it was built: ', 'कैसे बना: ', 'Kaise bana: ') + p.ai_attribution);
  }
  return { text: bullet(lines), sources: [p.id] };
}

/* ── single-fact path ────────────────────────────────────────────
   For a question no intent bucket claimed, a confident retrieval hit on a
   verbatim fact kind is still answerable without a model. Explanations
   (projects, workflow, experience) are excluded — those DO want prose. */
const FACT_KINDS = new Set(['skill', 'contact', 'link', 'education',
  'certification', 'achievement', 'person']);

function factAnswer(kb, lang, hit, query, persona = DEFAULT_PERSONA) {
  const entry = indexFacts(kb).get(hit.id);
  if (!entry || !FACT_KINDS.has(entry.kind)) return null;
  const { kind, fact: f } = entry;

  /* The query must actually be ABOUT this fact — matching its own name or one
     of its aliases — not merely fuzzy-adjacent to text in its body. Without
     this, "what car does he drive" answered with a bootcamp achievement
     (drive → driven, Dice 0.73) instead of abstaining.

     Two ways to be about a fact, because the token test alone cannot see one
     of them. A declared spelling ("who is he" on person.name) has NO content
     tokens — the stop set empties it on both sides — so `[].some(...)` was
     silently `false` for every glue-only alias the base declares, and a
     recruiter asking "who is he" was refused by a fact that says it is about
     exactly that. Declaration is not fuzz: QA-3's accident (drive/driven) is a
     token-level coincidence, and an exact phrase cannot reproduce it. */
  const declaredSpellings = [f.name, f.id, ...(f.aliases || [])]
    .filter(Boolean).map((a) => normalize(String(a)));
  const aboutByDeclaration = declaredSpellings.includes(normalize(query));

  const qTokens = contentTokens(query);
  const nameTokens = [f.name, f.id, ...(f.aliases || [])]
    .filter(Boolean).flatMap((a) => contentTokens(a));
  const aboutFact = aboutByDeclaration
    || qTokens.some((t) => nameTokens.some((n) => n === t || similarity(t, n) >= FUZZY_MIN));
  if (!aboutFact) return null;

  if (kind === 'skill') {
    let text = tri(lang,
      pick(persona,
        `Yes — ${f.name} (${f.category}) is on his list.`,
        `Yes — ${f.name} (${f.category}) is on my list.`),
      pick(persona,
        `हाँ — ${f.name} (${f.category}) उनकी लिस्ट में है।`,
        `हाँ — ${f.name} (${f.category}) मेरी लिस्ट में है।`),
      pick(persona,
        `Haan — ${f.name} (${f.category}) unki list mein hai.`,
        `Haan — ${f.name} (${f.category}) meri list mein hai.`));
    if (f.source === 'portfolio') {
      text += ' ' + tri(lang,
        'Evidence: this portfolio, not the CV.',
        'सबूत: यह पोर्टफोलियो, CV नही।',
        'Proof: ye portfolio, CV nahi.');
    }
    return { text, sources: [f.id] };
  }
  if (kind === 'achievement') return { text: f.text, sources: [f.id] };
  if (kind === 'person') {
    return {
      text: tri(lang,
        pick(persona, `His full name is ${f.name}.`, `My name is ${f.name}.`),
        pick(persona, `उनका पूरा नाम ${f.name} है।`, `मेरा नाम ${f.name} है।`),
        pick(persona, `Unka poora naam ${f.name} hai.`, `Mera naam ${f.name} hai.`)),
      sources: [f.id],
    };
  }
  return { text: renderFact(kb, f.id, lang), sources: [f.id] };
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
 * Answer a visitor's message deterministically.
 *
 * @param {object} kb          parsed knowledge.json
 * @param {string} query       raw user text
 * @param {object} [opts]
 * @param {string} [opts.lang] language already smoothed by the caller's
 *                             tracker (§8.3) — otherwise detected per message
 * @param {string|null} [opts.focus] the conversation's carried focus entity (§8.2)
 * @param {'first'|'third'} [opts.persona] whose voice the answer is written in.
 *        Defaults to `'first'`: the answers read as Aashish talking about
 *        himself ("my CGPA"), which is what a visitor browsing his portfolio
 *        is being shown. `'third'` is the neutral phrasing the evaluation set
 *        was written against. The direct identity question (`meta`) and the
 *        injection reply disclose the assistant either way — see BUILD.meta.
 * @returns {{handled:boolean, extractive:boolean, abstained:boolean,
 *            injection:boolean, intent:string, project:string|null,
 *            focus:string|null, lang:string, persona:string, text:string,
 *            sources:string[], followups:string[]}}
 */
export function quickAnswer(kb, query, opts = {}) {
  const question = String(query || '');
  const lang = opts.lang || detectLanguage(question).lang;
  const persona = opts.persona === 'third' ? 'third' : DEFAULT_PERSONA;
  /* the §8.4 layer-1 gate, overridable so it can be SWEPT against the
     evaluation set (`npm run calibrate`) instead of only asserted */
  const minScore = opts.minScore ?? MIN_TOP_SCORE;
  const det = detectIntent(question, kb);

  /* EVERY read below goes through the public view (§1): a `public:false` fact is
     absent from the facts, from the BM25 index, and from every template. The
     withheld field ids/aliases are kept as metadata so a question aimed at one
     can be declined with a useful answer rather than silence. */
  const base0 = kb;
  kb = viewOf(kb);
  const withheld = withheldFacts(base0);
  const base = {
    handled: false, extractive: false, abstained: false, injection: false,
    /* the focus entity carries between turns: a caller passes back what this
       returned, and a pronoun follow-up resolves against it (§8.2) */
    focus: opts.focus || null,
    intent: det.intent, project: det.project, lang, persona,
    text: '', sources: [],
    followups: [],
  };

  /* 1. instruction-change attempts never reach a handler (§9) */
  if (det.intent === 'injection_suspect') {
    return { ...base, handled: true, injection: true, text: INJECTION_REPLY[lang] || INJECTION_REPLY.en };
  }

  /* 2. hallucination bait abstains, then names what IS known (C7/C4) */
  if (det.intent === 'hallucination_bait') {
    const known = BUILD.experience(kb, lang, { persona });
    return {
      ...base, handled: true, abstained: true,
      text: `${abstainFor(lang, persona)}\n${known.text}`,
      sources: known.sources,
      followups: followupsFor('abstain', lang, persona),
    };
  }

  /* 3. verbatim-fact templates. Built, because the intent and the sources and
     the follow-up chips are produced together — but NOT rendered: the model
     answers. See this file's header. */
  const builder = BUILD[det.intent];
  if (builder) {
    const built = builder(kb, lang, { question, project: det.project, withheld, persona });
    /* a declined (private) field asserts nothing about the visitor's question,
       so it reports as an abstention with no sources — but with a useful,
       published next step instead of the generic abstention string */
    /* `private` is carried out, not just collapsed into `abstained`: the chat
       shell refuses a withheld-field question with a sentence about
       publication, which is a different thing to say than "I don't have
       that", and the difference has to survive this return. */
    const shape = built.private
      ? { abstained: true, sources: [], private: true }
      : { sources: built.sources };
    return {
      ...base, handled: true, text: built.text,
      /* naming a project moves the focus; every other template carries it */
      focus: det.project || base.focus,
      ...shape, followups: followupsFor(det.intent, lang, persona),
    };
  }

  /* one retrieval pass, shared by the prose path and the fact path */
  const searchRes = search(indexFor(kb), question, {
    focus: opts.focus || null, minScore, sizeOf: contextSizer(kb, lang),
  });
  const hits = searchRes.hits;
  base.focus = searchRes.focus || base.focus;

  /* 4. prose intents: verbatim text now, model later if one exists */
  const ex = extractive(kb, lang, det.intent, { project: det.project, hits, question, persona });
  if (ex) {
    return {
      ...base, extractive: true, text: ex.text, sources: ex.sources,
      followups: followupsFor(det.intent, lang, persona),
    };
  }

  /* 5. nothing matched: a confident hit on a verbatim fact still answers.
     The best FACT-KIND hit is used, not necessarily hits[0]: "which AI models
     does he use" ranks the workflow chunk first (its alias carries 'ai'), yet
     the answerable fact — skill.gemini — is right there in the same result set.
     factAnswer() still requires the query to be about the fact, so this skips
     past an unrenderable chunk without widening what may be answered. */
  const factHit = hits.find((h) => {
    const e = indexFacts(kb).get(h.id);
    return e && FACT_KINDS.has(e.kind);
  });
  if (factHit && factHit.score >= minScore) {
    const fa = factAnswer(kb, lang, factHit, question, persona);
    if (fa) {
      return { ...base, handled: true, text: fa.text, sources: fa.sources,
        followups: followupsFor('skills', lang, persona) };
    }
  }

  /* only a PROJECT hit may fall through to the project prose — otherwise a
     confident hit on something unrenderable (an experience chunk, say) would
     turn into an unrelated project list instead of an abstention */
  {
    const top = hits[0];
    if (top && top.score >= minScore && top.kind === 'project') {
      const fallback = extractive(kb, lang, 'project_detail', { project: null, hits, question, persona });
      if (fallback) {
        return { ...base, extractive: true, text: fallback.text, sources: fallback.sources,
          followups: followupsFor('project_detail', lang, persona) };
      }
    }
  }

  /* 6. the §8.4 layer-1 abstention — reached without any inference */
  return {
    ...base, handled: true, abstained: true,
    text: abstainFor(lang, persona),
    followups: followupsFor('abstain', lang, persona),
  };
}
