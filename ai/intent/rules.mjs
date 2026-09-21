/* ═══════════════════════════════════════════════════════════════
   ai/intent/rules.mjs — §5.1 step 2, intent + entity resolution

   Deterministic rules, evaluated in a fixed priority order. This is
   what lets the assistant route a question to an exact Quick Answer
   *before* any model exists, and what makes the §8.4 abstention
   reachable without inference.

   No rule escalates privilege: an intent only ever selects an
   allow-listed handler. User text never becomes an instruction.
   ═══════════════════════════════════════════════════════════════ */
import { tokenize } from '../language/detect.mjs';
import { normalize } from '../retrieval/index.mjs';

export const INTENTS = [
  'injection_suspect',  /* attempt to change instructions   — handled first */
  'meta',               /* "who are you / are you Aashish?"                */
  'greeting',
  'hallucination_bait', /* "did he intern at Google?"       — must abstain */
  'contact',
  'list_projects',
  'project_detail',
  'skills',
  'education',
  'certifications',
  'achievements',
  'workflow',           /* "how does he use AI?"                          */
  'experience',
  'out_of_scope',
];

/* ── §8.4 + §9 prompt-injection shapes. The model has no tools and user
   text never enters the instruction region, but we detect these and answer
   safely rather than letting them into the pipeline at all. */
const INJECTION = [
  /\bignore (all )?(previous|above|prior) (instructions|prompts|rules)\b/i,
  /\b(reveal|show|print|repeat|dump) (me )?(your|the) (system )?(prompt|instructions|rules)\b/i,
  /\bwhat (are|were) your (instructions|rules|prompt)\b/i,
  /\b(jailbreak|dan mode|developer mode|sudo mode)\b/i,
  /\b(api[_ -]?key|auth ?token|secret key|credentials?)\b/i,
  /\bdisregard (the )?(above|previous)\b/i,
  /\b(above|previous|prior|earlier) (rules|instructions|prompt|text)\b/i,
  /(system|assistant)\s*:\s*you are/i,
  /<\|(sys|system|asst|end)\|>/i,
];

/* ── questions that MUST abstain (§8.4, §14 adversarial set).
   The CV has a TRAINING section and no employment history at all (C7), so
   any wording presuming an employer or internship is bait. */
const EXPERIENCE_BAIT = [
  /\b(intern|internship|interned|internships)\b/i,    /* "worked WITH Node" is a skills question — only employer-shaped phrasing
       ("worked at/for/as") presumes an employer. INT-5 guards this. */
    /\b(worked|working|work) (at|for|as)\b/i,
  /\b(company|companies|employer|employed|employee|job|jobs)\b/i,
  /\bfreelanc(e|ing)\b/i,
  /\bclients?\b/i,
  /\b(salary|ctc|package|compensation|expected pay)\b/i,
  /\b(referr?al|refer)\b/i,
];
/* ...unless the question is about the one thing we DO know — his MERN
   bootcamp (experience type "training") or his stated availability. */
const TRAINING_OK = /\b(bootcamp|training|mern|course|devops)\b/i;
const AVAILABILITY_OK = /\b(available|availability|open to|hiring|opportunit)/i;

const PATTERNS = {
  meta: [
    /\b(who|what) (are|r) (you|u)\b/i,
    /\bare you aashish\b/i,
    /\b(are|r) (you|u) (a )?(bot|human|robot|real|ai)\b/i,
    /\bwhat (is|are) (this|you)\b/i,
    /\b(aap|tum|tu) (kaun|kon)\b/i,
    /\bwho am i (talking|chatting) (to|with)\b/i,
  ],
  greeting: [
    /^(hi|hey|hello|yo|hola|sup)\b/i,
    /^good (morning|afternoon|evening)\b/i,
    /^(namaste|namaskar|salaam|dhanyavad|thanks|thank you|shukriya)\b/i,
    /^(ok|okay|hmm|cool|nice|great)\b/i,
    /* Devanagari greetings — the Latin-only patterns above never fired for
       "नमस्ते", so Hindi/Hinglish visitors got an abstention instead of a
       greeting until tests/intent.test.mjs pinned it. */
    /^\s*(नमस्ते|नमस्कार|हैलो|हाय|धन्यवाद|शुक्रिया|सलाम)/,
  ],
  contact: [
    /\b(email|mail|gmail|e-mail)\b/i,
    /\b(phone|mobile|number|call|contact)\b/i,
    /* Devanagari/Tiro contact words — without these a Hindi question about a
       WITHHELD field never reached the decline path (it fell to retrieval and
       answered something else entirely). Guarded by QA-9 and case d21. */
    /(ईमेल|फ़ोन|फोन|मोबाइल|नंबर|संपर्क|पता)/,
    /\b(linkedin|github|link|links|profile|resume|cv)\b/i,
    /* "where can I see his code" must reach the links, not the skill whose
       NAME contains the word code ("VS Code"). Guarded by test. */
    /\b(repo|repos|repository|repositories|source code|(his|your) code)\b/i,
    /\b(reach|touch|connect|hire)\b/i,
  ],
  list_projects: [
    /* `your` as well as `his`: the assistant answers in the first person
       (§10), so a visitor following that voice asks "list your projects".
       Without the alternative, that phrasing skipped this bucket and landed
       on `project_detail` — the same facts, but as one project instead of
       the list. */
    /\b(list|all|show|which|what) ?(his |her |your |the )?(projects|work|apps?)\b/i,
    /\bprojects (list|batao|dikhao|dikha|kaun|kya|kitne)\b/i,
    /\b(kaun kaun se|kitne) (projects?|project)\b/i,
    /\bhow many projects\b/i,
    /\bwhat has he built\b/i,
    /\bkya kya (banaya|bana)/i,
    /\b(sab|saare|sare) projects\b/i,
  ],
  skills: [
    /* Stems are written WITHOUT a trailing \b: "database\b" cannot match
       "databases", which silently sent "which databases does he use" to the
       retrieval fallback. tests/intent.test.mjs has a guard per stem. */
    /\b(skills?|tech|stack|technolog|languages?|frameworks?|tools?|databases?)/i,
    /\b(what|which) (can|does) he (do|use|know)\b/i,
    /\b(what|which) (can|do) (you|u) (do|use|know|work with)\b/i,
    /\bskills batao\b/i,
    /\bkya (aata|aati) hai\b/i,
    /\bkaun si language\b/i,
  ],
  education: [
    /\b(educat|study|studies|studying|college|university|degrees?|schools?|graduat|b\.?tech|cgpa|gpa|marks?)/i,
    /\b(padhai|padhaai)\b/i,
    /\bwhere does he (study|go to school)\b/i,
    /\bwhere do (you|u) (study|go to school)\b/i,
  ],
  certifications: [
    /\b(certificat|certified|infosys|masai|iit ?ropar|minor)/i,
    /सर्टिफिकेट/,
  ],
  achievements: [
    /\b(achiev|awards?|grade|score|percentage|strength|accomplish)/i,
  ],
  workflow: [
    /\b(how does he (use|build|work|write|code|learn)|ai ?(assisted|generated|driven))\b/i,
    /\b(how do (you|u) (use|build|work|write|code|learn)|how (you|u) build)\b/i,
    /\b(did he (use|write) (ai|the code)|who wrote the code)\b/i,
    /\b(workflow|approach|method)\b/i,
    /\b(kind of developer|what kind of dev)\b/i,
    /\b(kaise banata|kaise banaya|ai se banaya)\b/i,
  ],
  project_detail: [
    /\b(volunteer|atlas|community|ngo|monorepo)\b/i,
    /\b(grocer(y)?|kiran)\b/i,
    /\b(goal ?tracker|goal ?track|habit|streak|xp)\b/i,
    /\b(project|projects)\b/i,
  ],
  /* The CV's only experience entry is a TRAINING programme, so this bucket
     is really "training + availability" — anything that presumes an employer
     was already diverted to `hallucination_bait` above (C7). */
  experience: [
    /\b(bootcamp|training|mern|course|devops)\b/i,
    /\b(available|availability|open to|hiring|opportunit)/i,
    /\bfresher\b/i,
    /* "how many years of experience does he have at X?" must reach the
       attributed "the CV lists no employment history" answer rather than an
       abstention or — worse — a guess. The employer's name is never repeated. */
    /\bexperience\b/i,
  ],
};

/* ── project resolution (§5.1 step 2, "entity resolve") ──────────
   Resolved against `knowledge.json` aliases rather than a second hand-written
   list, so a new alias can never fail to route. `PATTERNS.project_detail` above
   only decides *whether* a question is about a project; this decides *which*.
   tests/intent.test.mjs walks every alias in the knowledge base to prove it. */
export function detectProject(text, kb) {
  const hay = ` ${normalize(text)} `;
  let best = null;
  for (const pr of (kb && kb.projects) || []) {
    for (const alias of pr.aliases || []) {
      const a = normalize(alias);
      if (a && hay.includes(` ${a} `) && (!best || a.length > best.len)) {
        best = { id: pr.id, len: a.length };
      }
    }
    /* the codename is an entity name too ("VOLUNTEER OS") */
    const code = pr.portfolio_codename ? normalize(pr.portfolio_codename) : '';
    if (code && hay.includes(` ${code} `) && (!best || code.length > best.len)) {
      best = { id: pr.id, len: code.length };
    }
  }
  return best ? best.id : null;
}

/** True when any pattern in a bucket matches. */
function firstMatch(bucket, text) {
  for (const re of bucket) if (re.test(text)) return true;
  return false;
}

/**
 * Classify a user message.
 *
 * @param {string} query  raw user text
 * @param {object} [kb]   knowledge base — used only to name the project when
 *                        the intent is `project_detail`
 * @returns {{intent:string, project:string|null, injection:boolean,
 *            bait:boolean, tokens:string[]}}
 */
export function detectIntent(query, kb = null) {
  const text = String(query || '');
  const norm = normalize(text);
  const tokens = tokenize(norm);
  const out = (intent, extra = {}) => ({
    intent, project: null, injection: false, bait: false, tokens, ...extra,
  });

  /* 1. attempts to change instructions never reach a handler */
  if (INJECTION.some((re) => re.test(text))) {
    return out('injection_suspect', { injection: true });
  }

  /* 2. the abstention check sits ABOVE the topic buckets: "did he intern at
     Google?" must abstain even though it also looks like an experience or
     skills question. It is only rescued by a genuinely known subject. */
  const looksLikeBait = EXPERIENCE_BAIT.some((re) => re.test(text));
  const rescued = TRAINING_OK.test(text) || AVAILABILITY_OK.test(text);
  const bait = looksLikeBait && !rescued;
  if (bait) return out('hallucination_bait', { bait: true });

  /* 3. ordered dispatch over the real topic buckets. Order matters: the
     narrow, verbatim-fact topics are checked before the broad ones. */
  for (const intent of ['meta', 'greeting', 'contact', 'list_projects',
                        'skills', 'education', 'certifications', 'experience',
                        'achievements', 'workflow', 'project_detail']) {
    if (firstMatch(PATTERNS[intent], text)) {
      return out(intent, {
        project: intent === 'project_detail' ? detectProject(text, kb) : null,
      });
    }
  }

  /* 4. a NAMED project is a project question in any script. The patterns above
     are Latin-only, so "किराना" or "सबसे बड़ा प्रोजेक्ट" would otherwise fall
     through to retrieval; this consults the knowledge base's own aliases, so
     the resolver stays the single source of truth. */
  const named = detectProject(text, kb);
  if (named) return out('project_detail', { project: named });

  return out('out_of_scope');
}

/* ── localized safety strings (§8.4) ──────────────────────────── */
export const ABSTAIN = {
  en: "I don't have that information in Aashish's portfolio yet.",
  hi: 'यह जानकारी अभी Aashish के पोर्टफोलियो में उपलब्ध नहीं है।',
  hinglish: 'Ye information abhi Aashish ke portfolio mein available nahi hai.',
};

/* The same refusal in the first-person voice (§10). An abstention is not a
   safety string — it asserts nothing — so it is free to follow the persona,
   and a page that speaks as Aashish must not switch to third person exactly
   when it has nothing to say. Only the *identity* answers are kept neutral;
   see `BUILD.meta` and `INJECTION_REPLY`. */
export const ABSTAIN_FIRST = {
  en: "I don't have that in my portfolio yet.",
  hi: 'यह जानकारी अभी मेरे पोर्टफोलियो में उपलब्ध नहीं है।',
  hinglish: 'Ye information abhi mere portfolio mein available nahi hai.',
};

/** The abstention line for a voice — unknown languages fall back to English. */
export function abstainFor(lang, persona = 'first') {
  const table = persona === 'first' ? ABSTAIN_FIRST : ABSTAIN;
  return table[lang] || table.en;
}

/* §9: a safe, honest reply to prompt-injection attempts. It must never
   assert a fact and never pretend to have hidden instructions. */
export const INJECTION_REPLY = {
  en: "I'm Aashish's AI Portfolio Assistant. I only answer questions about his work, skills and background from his portfolio data — I can't share instructions or change how I work.",
  hi: 'मैं Aashish का AI पोर्टफोलियो असिस्टेंट हूँ। मैं केवल उनके काम, स्किल्स और शिक्षा से जुड़े सवालों का जवाब देता हूँ।',
  hinglish: 'Main Aashish ka AI Portfolio Assistant hoon. Main sirf unke kaam, skills aur padhai ke baare mein bata sakta hoon.',
};