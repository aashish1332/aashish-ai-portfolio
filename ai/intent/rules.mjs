/* ═══════════════════════════════════════════════════════════════
   ai/intent/rules.mjs — §5.1 step 2, intent + entity resolution

   Deterministic rules, evaluated in a fixed priority order. This decides,
   *before* a token exists, which topic a question is about and whether it may
   be answered at all — the §8.4 abstention, §14's hallucination bait and §9's
   injection attempts are all reachable with no inference. No rule escalates
   privilege: an intent only ever selects an allow-listed handler, so user text
   never becomes an instruction — it only ever chooses which one runs.
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
  /* "how many years of experience does he have AT X?" presumes an employer
     the CV does not have (C7) even without an employer-shaped verb. A bare
     "how many years of experience" question is NOT bait — it is answered
     with the attributed no-employment-history training answer. */
  /\bexperience\b[^\n]{0,30}\bat\b/i,
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
    /* "kaun se/si/sa" is "which", not "who": "aap kaun se project pe kaam
       karte ho?" is a project question. MEASURED 2026-10-26 — the bare
       pronoun+kaun form matched it and answered an identity question to a
       question about projects. */
    /\b(aap|tum|tu) (kaun|kon)\b(?!\s*(sa|se|si)\b)/i,
    /* …and the same question with the copula between them, which is how people
       actually type it. MEASURED 2026-10-26 (owner report, the shipping UI):
       "tum ho kon?" matched NEITHER the pronoun-first pattern above nor any
       other, so it fell to `out_of_scope`, retrieved nothing and the model
       abstained — a legitimate identity question refused. "tum ho kon",
       "kaun ho tum", "tum kon ho" and "tu kaun hai" are all in the same hole.
       The `(?!\s*(sa|se|si)\b)` guard is what keeps "kaun sa project" (which
       project) a fact question instead of an identity one. */
    /\b(aap|tum|tu)\b(?:\s+[^\s.!?]+){0,2}\s+(kaun|kon)\b(?!\s*(sa|se|si)\b)/i,
    /\b(kaun|kon)\b(?:\s+[^\s.!?]+){0,2}\s+(aap|tum|tu)\b/i,
    /\bwho am i (talking|chatting) (to|with)\b/i,
    /* "who is this?" is the likeliest first message a recruiter types, and it
       abstained until now: this bucket only matched the second person
       ("who ARE YOU"). Third person and the self-introduction phrasings are
       the same question, and an abstention here is the worst possible
       first impression. Found by asking the real pipeline natural phrasings
       rather than the frozen set — see tests/intent.test.mjs 'identity'. */
    /\bwho('s| is| se) (this|that|it)\b/i,
    /\bis (this|that) aashish\b/i,
    /\bwho is aashish\b/i,
    /\b(introduce|tell me about|describe|about) (yourself|ur ?self|your ?self)\b/i,
    /\b(your|ur) (introduction|intro)\b/i,
    /\b(apna|apne|apni) (introduction|intro|baare|bare|barae)\b/i,
    /\b(apne|apna) baare mein\b/i,
    /* Devanagari: every pattern above is Latin-only, so the Hindi identity
       question — आप कौन हैं — fell through to retrieval and abstained.
       NO `\b` HERE: JS `\b` is defined on [A-Za-z0-9_], so a boundary after a
       Devanagari cluster never matches and the whole pattern silently fails.
       (The first attempt at this fix had the `\b` and did exactly that.) */
    /कौन (हैं|हो|है|हूँ)/,
    /अपने? बारे में/,
    /परिचय/,
  ],
  /* ── greetings AND small talk. §11.1 measured the plain forms here ("hi",
     "namaste", "thanks", time-of-day), but a visitor also greets WITH a
     question — "how are you?", "what's up?", "kaise ho?" — and until 2026-10-11
     all of those fell through to the retrieval gate and answered "I don't have
     that in my portfolio yet." A question about the ASSISTANT's wellbeing is
     small talk, exactly like "hi": it is answered with no facts, and
     `contextless` (the same allowance MODEL-11 pins) is the reason it may
     reach the model with an empty context. Sorted longest-first so "good
     morning how are you" matches the fuller shape when several do.

     anchors are stripped below, so "hi" mid-sentence still counts like the
     bare form does ("ok"/"hmm" already behaved that way). */
  greeting: [
    /\bhow (are|r|is) (you|u|everything)\b/i,
    /\bhow('s| is) (it |life |things |your (day|week|day going)|it going)\b/i,
    /\bhow('s| is) (your )?(day|week|morning|evening|night)\b/i,
    /\bwhat('s| is) up\b/i,
    /* `kese`/`kesa`/`kesi` are the spellings people actually type; the
       `kaise`-only patterns sent "kese ho" to retrieval, which answered the
       Hinglish abstention ("andaaza laga kar" — 2026-10-18 owner report). */
    /\b(how|kaise|kaisa|kaisi|kese|kesa|kesi)( ho| hai ho| aap| tum)\b/i,
    /\b(kaise|kaisa|kaisi|kese|kesa|kesi) (ho|hai|hain)\b/i,
    /\b(aap|tum|tu) (kaise|kaisa|kaisi|kese|kesa|kesi) (ho|hai|ho)\b/i,
    /\bwhat about you\b/i,
    /\b(you|u) (good|ok|okay|fine|there|right there)\b/i,
    /\bathe ?(kya |kaisa )?haal\b/i,
    /^(good|gd) (morning|afternoon|evening|night)\b/i,
    /^(hi|hey|hello|yo|hola|sup)\b/i,
    /^(namaste|namaskar|salaam|dhanyavad|thanks|thank you|shukriya)\b/i,
    /^(ok|okay|hmm|cool|nice|great)\b/i,
    /* goodbyes — a farewell is answered, not refused */
    /\bkya ?haal\b/i,
    /^(bye|good ?bye|see (ya|you)|take care|night)\b/i,
    /\b(bye|good ?bye|milte|alvida)\b/i,
    /* Devanagari greetings — the Latin-only patterns above never fired for
       "नमस्ते", so Hindi/Hinglish visitors got an abstention instead of a
       greeting until tests/intent.test.mjs pinned it. */
    /^\s*(नमस्ते|नमस्कार|हैलो|हाय|धन्यवाद|शुक्रिया|सलाम)/,
    /* Devanagari small talk ("आप कैसे हैं?") — the same hole, same fix */
    /(कैसे (हैं|हो)|क्या हाल)/,
    /अलविदा|फिर मिलेंगे/,
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
    /* A QUESTION THAT NAMES A SCHOOL LEVEL is a schooling question even when
       it also says "percentage"/"score" (which `achievements` owns). Without
       this, "what is his 10th percentage?" reached the achievements bucket and
       the class-10 record — the only fact that carries 83 % — was never in the
       context the model read, so it could not be answered from the base at
       all. ``12th``/``senior secondary`` are here for the same reason and now
       reach the Class 12 record instead of the CGPA achievement. Measured
       2026-10-24 against knowledge.json v1.1.0 (edu.kv1). */
    /\b(10th|tenth|class ?(10|ten)|matriculation|high ?school|12th|twelfth|class ?(12|twelve)|senior secondary|intermediate|dasvi|dasvin|barhvi)\b/i,
    /दसवीं|१०वीं|10वीं|बारहवीं|१२वीं|12वीं/,
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
     narrow, verbatim-fact topics are checked before the broad ones.

     A GREETING THAT OPENS A REAL QUESTION IS NOT SMALL TALK — MEASURED
     2026-11-06, the owner's browser session: "hi, keso ho, mujhe uske projects
     or skills ke bare me batao" was answered with the greeting line ("Aap unke
     projects, skills ya padhai ke baare mein pooch sakte hain"), and the
     question the visitor actually asked never reached the model, because
     `greeting` was dispatched before every content bucket. A message that is
     nothing but pleasantries still gets the greeting; when a greeting OPENS a
     content question, the content wins. */
  const CONTENT = ['contact', 'list_projects', 'skills', 'education',
                   'certifications', 'experience', 'achievements', 'workflow',
                   'project_detail'];
  if (firstMatch(PATTERNS.meta, text)) return out('meta');
  const contentIntent = CONTENT.find((intent) => firstMatch(PATTERNS[intent], text));
  const contentPlan = contentIntent
    ? out(contentIntent, {
      project: contentIntent === 'project_detail' ? detectProject(text, kb) : null,
    })
    : null;
  if (firstMatch(PATTERNS.greeting, text)) return contentPlan || out('greeting');
  if (contentPlan) return contentPlan;


  /* 4. a NAMED project is a project question in any script. The patterns above
     are Latin-only, so "किराना" or "सबसे बड़ा प्रोजेक्ट" would otherwise fall
     through to retrieval; this consults the knowledge base's own aliases, so
     the resolver stays the single source of truth. */
  const named = detectProject(text, kb);
  if (named) return out('project_detail', { project: named });

  return out('out_of_scope');
}

/* ── localized safety strings (§8.4) ──────────────────────────── */
/* The off-topic refusal, in the owner's words (2026-10-11): a question about
   something the portfolio does not hold gets one honest sentence — this panel
   only speaks about Aashish's portfolio — and a pointer back at what it CAN
   answer, rather than the bare "don't have that" that taught visitors nothing.
   The follow-up chips under it are the pointer's second half. */
export const ABSTAIN = {
  en: "I can only provide info related to Aashish's portfolio — about his projects, skills, "
    + 'education or contact. What would you like to know about that?',
  hi: 'मैं केवल Aashish के पोर्टफोलियो से जुड़ी जानकारी दे सकता हूँ — उनके प्रोजेक्ट्स, स्किल्स, '
    + 'पढ़ाई या संपर्क के बारे में। आप इसके बारे में क्या जानना चाहेंगे?',
  hinglish: "Main sirf Aashish ke portfolio se judi info provide kar sakta hoon — unke projects, "
    + 'skills, padhai ya contact ke baare mein. Aap iske baare mein kya jaanna chahenge?',
};

/* The same refusal in the first-person voice. An abstention is not a safety
   string — it asserts nothing — so it is free to follow the persona, and a
   caller that has ASKED for the first-person voice must not switch to third
   person exactly when it has nothing to say. The default is the third-person
   `ABSTAIN` above (§5); only the *identity* answers are kept neutral, see
   `BUILD.meta` and `INJECTION_REPLY`. */
export const ABSTAIN_FIRST = {
  en: "I can only provide info related to my portfolio — my projects, skills, education "
    + 'or contact. What would you like to know about that?',
  hi: 'मैं केवल अपने पोर्टफोलियो से जुड़ी जानकारी दे सकता हूँ — मेरे प्रोजेक्ट्स, स्किल्स, '
    + 'पढ़ाई या संपर्क के बारे में। आप इसके बारे में क्या जानना चाहेंगे?',
  hinglish: 'Main sirf mere portfolio se judi info provide kar sakta hoon — mere projects, '
    + 'skills, padhai ya contact ke baare mein. Aap iske baare mein kya jaanna chahenge?',
};

/** The abstention line for a voice — unknown languages fall back to English. */
export function abstainFor(lang, persona = 'third') {
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