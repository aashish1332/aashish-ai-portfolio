/* ═══════════════════════════════════════════════════════════════
   evaluation/answer-text.mjs — the §5.1 step-4 deterministic ANSWERS

   **This module is never shipped.** It lives beside the evaluation set because
   that is who reads it: the corpus in `evaluation/portfolio_tests.json` asserts
   these sentences in three languages, and `npm run calibrate` sweeps the §8.4
   gate over them. `tools/build.mjs` copies an allow-list of directories
   (`SHIP_PATHS`) and this is not one of them, so not one byte of it reaches a
   visitor — and because the build also refuses a shipped module that imports
   something it does not ship, no shipped file can start depending on it by
   accident.

   Why it is not shipped: the owner retired Quick Answers as *answers*. The
   model is the only thing that answers a visitor, so these sentences were built
   on every question and discarded by the chat shell — ~6.9 KB gz of §4's chunk
   paid by every device to produce text nobody reads. The decision half stayed
   in `ai/answers/quick.mjs` (which facts a question is about, whether it should
   be answered at all); the wording moved here.

   `quickAnswer` is a drop-in for the shipped planner: it passes `say` in and so
   gets the same result object, with `text` filled. `tests/quick-answers.test.mjs`
   and `tests/evaluation.test.mjs` run this one, which is why the wording still
   has to be right — and why changing it still fails a test.

   Rule that has not changed: every interpolated value comes from the knowledge
   base's public view. Nothing here may hardcode a fact.
   ═══════════════════════════════════════════════════════════════ */
import {
  quickAnswer as plan, tri, pick, renderFact,
} from '../ai/answers/quick.mjs';
import { abstainFor } from '../ai/intent/rules.mjs';
/* the index's own normalization, so the codename check below is the one the
   retrieval layer uses rather than a second opinion about the same strings */
import { normalize } from '../ai/retrieval/index.mjs';

export {
  tri, MAX_ANSWER_CHARS, factIds, fmtDate, renderFact, contextSizer, resolveFacts,
  followupsFor, disclosure, PERSONAS, DEFAULT_PERSONA, CATEGORY_WORDS,
} from '../ai/answers/quick.mjs';

const firstName = (kb) => String(kb?.person?.name || 'Aashish').split(' ')[0];
const fullName = (kb) => String(kb?.person?.name || 'Aashish Kumar');
const bullet = (lines) => lines.join('\n');
const firstSentence = (s) => String(s || '').split(/(?<=\.)\s/)[0];

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

const byId = (list, ids) => (ids || [])
  .map((id) => (list || []).find((x) => x.id === id))
  .filter(Boolean);

/* ── the contact decline ───────────────────────────────────────── */
/* A `public:false` contact field is declined, not silently revealed, and the
   decline points at the route that IS published. */
function privateReply(kb, lang, persona) {
  const email = (kb.contact?.email && kb.contact.email.public !== false)
    ? kb.contact.email.value : '';
  const who = pick(persona, firstName(kb), 'me');
  return tri(lang,
    `That contact detail isn't published${email ? ` — the best way to reach ${who} is by email: ${email}` : ''}.`,
    `वह संपर्क विवरण सार्वजनिक नहीं है${email ? ` — ${pick(persona, `${firstName(kb)} से`, 'मुझसे')} संपर्क का सबसे अच्छा तरीक़ा ईमेल है: ${email}` : ''}।`,
    `Wo contact detail publish nahi hai${email ? ` — ${pick(persona, `${firstName(kb)} se`, 'mujhse')} contact ka best tarika email hai: ${email}` : ''}.`);
}

/* ── the wording, one entry per plan kind ──────────────────────── */
const SAY = {
  greeting: (kb, lang, ctx) => ({
    text: ctx.plan.thanks
      ? tri(lang,
        pick(ctx.persona, 'Anytime! Ask me anything else about Aashish.', 'Anytime! Ask me anything else.'),
        pick(ctx.persona, 'खुशी हुई! Aashish के बारे में और कुछ भी पूछ सकते हैं।', 'खुशी हुई! और कुछ भी पूछ सकते हैं।'),
        pick(ctx.persona, 'Khushi hui! Aashish ke baare mein aur kuch bhi pooch sakte hain.', 'Khushi hui! Aur kuch bhi pooch sakte hain.'))
      : tri(lang,
        pick(ctx.persona,
          `Hi! I'm ${firstName(kb)}'s AI Portfolio Assistant. Ask me about his projects, skills, education, or how to reach him.`,
          `Hi — I'm ${fullName(kb)}. Ask me about my projects, skills, education, or how to reach me.`),
        pick(ctx.persona,
          `नमस्ते! मैं ${firstName(kb)} का AI पोर्टफोलियो असिस्टेंट हूँ। आप उनके प्रोजेक्ट्स, स्किल्स, पढ़ाई या संपर्क के बारे में पूछ सकते हैं।`,
          `नमस्ते — मैं ${fullName(kb)} हूँ। मेरे प्रोजेक्ट्स, स्किल्स, पढ़ाई या संपर्क के बारे में पूछ सकते हैं।`),
        pick(ctx.persona,
          `Namaste! Main ${firstName(kb)} ka AI Portfolio Assistant hoon. Aap unke projects, skills, padhai ya contact ke baare mein pooch sakte hain.`,
          `Namaste — main ${fullName(kb)} hoon. Mere projects, skills, padhai ya contact ke baare mein pooch sakte hain.`)),
  }),

  /* The disclosure is a fixed statement about the assistant, so it ships in the
     planner (`disclosure()`) and is only passed through here. */
  meta: (_kb, _lang, ctx) => ({ text: ctx.plan.text || '' }),

  contact_withheld: (kb, lang, ctx) => ({ text: privateReply(kb, lang, ctx.persona) }),

  contact_field: (kb, lang, ctx) => {
    const f = Object.values(kb.contact || {}).find((c) => c.id === ctx.plan.id) || {};
    const v = f.value;
    const p = ctx.persona;
    if (ctx.plan.field === 'email') {
      return { text: tri(lang,
        pick(p, `His email is ${v}.`, `My email is ${v}.`),
        pick(p, `उनका ईमेल ${v} है।`, `मेरा ईमेल ${v} है।`),
        pick(p, `Unka email ${v} hai.`, `Mera email ${v} hai.`)) };
    }
    if (ctx.plan.field === 'phone') {
      return { text: tri(lang,
        pick(p, `His phone number is ${v}.`, `My phone number is ${v}.`),
        pick(p, `उनका फ़ोन नंबर ${v} है।`, `मेरा फ़ोन नंबर ${v} है।`),
        pick(p, `Unka phone number ${v} hai.`, `Mera phone number ${v} hai.`)) };
    }
    if (ctx.plan.field === 'location') {
      return { text: tri(lang,
        pick(p, `He's based in ${v}.`, `I'm based in ${v}.`),
        pick(p, `वे ${v} में रहते हैं।`, `मैं ${v} में रहता हूँ।`),
        pick(p, `Wo ${v} mein rehte hain.`, `Main ${v} mein rehta hoon.`)) };
    }
    return { text: tri(lang, `Yes — ${v}.`, `हाँ — ${v}।`, `Haan — ${v}.`) };
  },

  contact_links: (kb, lang, ctx) => {
    const links = (kb.links || []).filter((l) => l.public !== false);
    return { text: tri(lang,
      pick(ctx.persona, `${firstName(kb)}'s profiles:`, 'My profiles:'),
      'प्रोफ़ाइल:', 'Profiles:')
      + '\n' + bullet(links.map((l) => `• ${l.label}: ${l.url}`)) };
  },

  contact_all: (kb, lang, ctx) => {
    const c = Object.fromEntries(Object.entries(kb.contact || {})
      .filter(([, f]) => f && f.public !== false));
    const links = (kb.links || []).filter((l) => l.public !== false);
    const parts = [];
    if (c.email) parts.push(tri(lang, `Email: ${c.email.value}`, `ईमेल: ${c.email.value}`, `Email: ${c.email.value}`));
    if (c.phone) parts.push(tri(lang, `Phone: ${c.phone.value}`, `फ़ोन: ${c.phone.value}`, `Phone: ${c.phone.value}`));
    if (c.location) parts.push(tri(lang, `Location: ${c.location.value}`, `लोकेशन: ${c.location.value}`, `Location: ${c.location.value}`));
    for (const l of links) parts.push(`• ${l.label}: ${l.url}`);
    if (c.availability) parts.push(tri(lang, `Availability: ${c.availability.value}`, `उपलब्धता: ${c.availability.value}`, `Availability: ${c.availability.value}`));
    return { text: tri(lang,
      pick(ctx.persona, `Here's how to reach ${firstName(kb)}:`, "Here's how to reach me:"),
      pick(ctx.persona, `${firstName(kb)} से संपर्क:`, 'मुझसे संपर्क:'),
      pick(ctx.persona, `${firstName(kb)} se contact:`, 'Mujhse contact:'))
      + '\n' + bullet(parts) };
  },

  list_projects: (kb, lang, ctx) => {
    const projects = byId(kb.projects, ctx.plan.ids);
    const lines = projects.map((p) => {
      /* skip the codename when it only repeats the project name
         ("Goal Tracker SaaS (GOAL TRACKER SaaS)") */
      const code = p.portfolio_codename
        && normalize(p.portfolio_codename) !== normalize(p.name)
        ? ` (${p.portfolio_codename})` : '';
      const status = p.status ? ` — ${p.status}` : '';
      return `• ${p.name}${code}${status}\n  ${firstSentence(p.summary)}`;
    });
    return { text: tri(lang,
      pick(ctx.persona, `${firstName(kb)} has ${projects.length} shipped projects:`,
        `I've shipped ${projects.length} projects:`),
      pick(ctx.persona, `${firstName(kb)} के ${projects.length} शिप्ड प्रोजेक्ट्स हैं:`,
        `मैंने ${projects.length} प्रोजेक्ट्स बनाए हैं:`),
      pick(ctx.persona, `${firstName(kb)} ke ${projects.length} shipped projects hain:`,
        `Maine ${projects.length} projects banaye hain:`))
      + '\n' + bullet(lines)
      + '\n' + tri(lang, 'Ask about any one for its stack and live link.',
        'किसी एक के बारे में पूछें — स्टैक और लाइव लिंक बताऊँगा।',
        'Kisi ek ke baare mein poocho — stack aur live link bata dunga.') };
  },

  skills: (kb, lang, ctx) => {
    const list = byId(kb.skills, ctx.plan.ids);

    /* A single category keeps its own heading; the full list is grouped. */
    if (ctx.plan.category && list.length) {
      const label = (CATEGORY_LABEL[ctx.plan.category] || {})[lang] || ctx.plan.category;
      return { text: tri(lang,
        pick(ctx.persona, `${label} he works with: `, `My ${label.toLowerCase()}: `),
        `${label}: `, `${label}: `)
        + list.map((s) => s.name).join(', ') + '.' };
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
        `${extras.map((s) => s.name).join(' and ')} ${extras.length > 1 ? 'are' : 'is'} evidenced by this portfolio, not listed on ${pick(ctx.persona, 'the CV', 'my CV')}.`,
        `${extras.map((s) => s.name).join(' और ')} — ${pick(ctx.persona, 'CV में लिस्टेड नहीं', 'मेरे CV में लिस्टेड नहीं')}, यह पोर्टफोलियो इनका सबूत है।`,
        `${extras.map((s) => s.name).join(' and ')} — ${pick(ctx.persona, 'CV mein listed nahi', 'mere CV mein listed nahi')}, ye portfolio inka proof hai.`)
      : '';

    return { text: tri(lang,
      pick(ctx.persona, `${firstName(kb)}'s skills (${list.length}):`,
        `My skills (${list.length}):`),
      pick(ctx.persona, `${firstName(kb)} के स्किल्स (${list.length}):`,
        `मेरे स्किल्स (${list.length}):`),
      pick(ctx.persona, `${firstName(kb)} ke skills (${list.length}):`,
        `Mere skills (${list.length}):`))
      + '\n' + bullet(lines) + footnote };
  },

  education: (kb, lang, ctx) => {
    const edu = byId(kb.education, ctx.plan.ids);
    const lpu = edu.find((e) => e.expected_graduation);
    const grad = lpu
      ? tri(lang, `Expected graduation: ${lpu.expected_graduation}.`,
        `अनुमानित ग्रेजुएशन: ${lpu.expected_graduation}।`,
        `Expected graduation: ${lpu.expected_graduation}.`)
      : '';
    return { text: tri(lang, 'Education:', 'शिक्षा:', 'Padhai:')
      + '\n' + bullet(edu.map((e) => `• ${renderFact(kb, e.id, lang)}`))
      + (grad ? '\n' + grad : '') };
  },

  certifications: (kb, lang, ctx) => {
    const certs = byId(kb.certifications, ctx.plan.ids);
    return { text: tri(lang, `Certifications and programmes (${certs.length}):`,
      `सर्टिफिकेट और प्रोग्राम (${certs.length}):`,
      `Certifications aur programmes (${certs.length}):`)
      + '\n' + bullet(certs.map((c) => `• ${renderFact(kb, c.id, lang)}`)) };
  },

  achievements: (kb, lang, ctx) => {
    const ach = byId(kb.achievements, ctx.plan.ids);
    return { text: tri(lang, 'Highlights:', 'हाइलाइट्स:',
      pick(ctx.persona, 'Uski highlights:', 'Meri highlights:'))
      + '\n' + bullet(ach.map((a) => `• ${a.text}`)) };
  },

  experience: (kb, lang, ctx) => {
    const exp = byId(kb.experience, ctx.plan.ids);
    const availability = kb.contact?.availability?.value;
    return { text: tri(lang,
      pick(ctx.persona,
        `${firstName(kb)}'s CV shows no employment history — no companies, internships or freelance work. Its only experience entry is training:`,
        'My CV shows no employment history — no companies, internships or freelance work. My only experience entry is training:'),
      pick(ctx.persona,
        `${firstName(kb)} के CV में कोई नौकरी नहीं है — कोई कंपनी, इंटर्नशिप या फ्रीलांस नहीं। केवल एक ट्रेनिंग एंट्री है:`,
        'मेरे CV में कोई नौकरी नहीं है — कोई कंपनी, इंटर्नशिप या फ्रीलांस नहीं। केवल एक ट्रेनिंग एंट्री है:'),
      pick(ctx.persona,
        `${firstName(kb)} ke CV mein koi employment history nahi hai — koi company, internship ya freelance nahi. Sirf ek training entry hai:`,
        'Mere CV mein koi employment history nahi hai — koi company, internship ya freelance nahi. Sirf ek training entry hai:'))
      + '\n' + bullet(exp.map((e) => `• ${renderFact(kb, e.id, lang)}`))
      + (availability ? '\n' + tri(lang, `Availability: ${availability}`, `उपलब्धता: ${availability}`, `Availability: ${availability}`) : '') };
  },

  workflow: (kb, lang, ctx) => ({
    text: tri(lang,
      pick(ctx.persona, 'How he builds: ', 'How I build: '),
      'बनाने का तरीक़ा: ',
      pick(ctx.persona, 'Kaise banate hain: ', 'Kaise banata hoon: '))
      + renderFact(kb, ctx.plan.id, lang),
  }),

  project_detail: (kb, lang, ctx) => {
    const p = (kb.projects || []).find((x) => x.id === ctx.plan.id);
    if (!p) return { text: '' };
    const lines = [p.summary];
    if (p.tech?.length) lines.push(tri(lang, 'Tech: ', 'टेक: ', 'Tech: ') + p.tech.join(', '));
    if (p.links?.length) lines.push(...p.links.map((l) => `${l.label}: ${l.url}`));
    if (p.ai_attribution) {
      lines.push(tri(lang, 'How it was built: ', 'कैसे बना: ', 'Kaise bana: ') + p.ai_attribution);
    }
    return { text: bullet(lines) };
  },

  fact: (kb, lang, ctx) => {
    const { factKind, id, portfolioEvidence } = ctx.plan;
    if (factKind === 'skill') {
      const f = (kb.skills || []).find((s) => s.id === id) || {};
      let text = tri(lang,
        pick(ctx.persona,
          `Yes — ${f.name} (${f.category}) is on his list.`,
          `Yes — ${f.name} (${f.category}) is on my list.`),
        pick(ctx.persona,
          `हाँ — ${f.name} (${f.category}) उनकी लिस्ट में है।`,
          `हाँ — ${f.name} (${f.category}) मेरी लिस्ट में है।`),
        pick(ctx.persona,
          `Haan — ${f.name} (${f.category}) unki list mein hai.`,
          `Haan — ${f.name} (${f.category}) meri list mein hai.`));
      if (portfolioEvidence) {
        text += ' ' + tri(lang, 'Evidence: this portfolio, not the CV.',
          'सबूत: यह पोर्टफोलियो, CV नही।', 'Proof: ye portfolio, CV nahi.');
      }
      return { text };
    }
    if (factKind === 'person') {
      const f = (kb.person && kb.person.id === id) ? kb.person
        : (kb.person || {});
      return { text: tri(lang,
        pick(ctx.persona, `His full name is ${f.name}.`, `My name is ${f.name}.`),
        pick(ctx.persona, `उनका पूरा नाम ${f.name} है।`, `मेरा नाम ${f.name} है।`),
        pick(ctx.persona, `Unka poora naam ${f.name} hai.`, `Mera naam ${f.name} hai.`)) };
    }
    /* achievement, education, certification, link, contact — `renderFact` is
       the same allowlisted renderer the model's context uses */
    return { text: renderFact(kb, id, lang) };
  },

  /* the bait refusal names what IS known (C7/C4): the abstention, then the only
     experience entry the CV actually has */
  hallucination_bait: (kb, lang, ctx) => ({ text: `${abstainFor(lang, ctx.persona)}\n`
    + SAY.experience(kb, lang, {
      ...ctx,
      plan: { kind: 'experience', ids: ctx.plan.ids },
    }).text }),

  abstain: (_kb, lang, ctx) => ({ text: abstainFor(lang, ctx.persona) }),
};

/**
 * Word a plan. Pure: (plan, ctx) → text. A plan kind with no wording is a bug
 * rather than an empty answer, so it says so instead of returning silence.
 */
export function say(plan, ctx) {
  const entry = SAY[plan?.kind];
  if (!entry) return `[no wording for plan kind "${plan?.kind}"]`;
  return entry(ctx.kb, ctx.lang || 'en', { ...ctx, plan }).text;
}

/**
 * `ai/answers/quick.mjs`'s `quickAnswer`, with the deterministic answers
 * actually built. This is the entry the evaluation set and the calibration
 * sweep run; it is a drop-in, so anything that reads `.text` can switch by
 * changing its import.
 */
export function quickAnswer(kb, query, opts = {}) {
  return plan(kb, query, { ...opts, say });
}
