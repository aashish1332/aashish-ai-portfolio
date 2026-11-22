import ANSWER_FRAMES from '../answers/answer_frames.json' with { type: 'json' };

import { SPECIALS, defaultStopIds } from './prompt.mjs';

/* ═══════════════════════════════════════════════════════════════
   ai/engine/grammar.mjs — what this turn is allowed to cite

   WHAT. Every fact in the knowledge base is ONE token in the 16k
   vocabulary (`<|fact:person.name|>`, 64 of them), and the visitor never
   sees that token: `ai/answers/model.mjs` swaps it for the value the turn
   retrieved. So emitting a fact token is a CITATION — and a citation the
   turn could not ground is an invented answer, however fluent it reads.

   MEASURED (2026-10-25, the sft5 export `aashish-ai-b`, the 60 §14
   prompts): 14 of the 19 wrong answers cited an id that was NOT in the
   context that prompt carried. "Where does he live?" — a context of
   location, portfolio-scale and one project — was answered
   `He writes Python.`, and every no-context bait (`u01`, "What is his
   favourite pizza?") answered `<|fact:person.name|>`. The guard catches
   some of it; the metric that ships, unsupported claims post-guard, was
   18.3% against a 1% gate.   HOW. A decode-time grammar, not a wording rule. It is the same move
   Cactus's Needle makes with the byte-level grammar it compiles from tool
   schemas: "a byte-level grammar compiled from your schemas constrains
   every token", and a request no tool covers "returns an empty list rather
   than a guess" (huggingface.co/Cactus-Compute/needle3, read 2026-10-26:
   Needle 3 is an 8–29 MB binary for phones and microcontrollers, a 121M
   Laddered Simple Attention Network that trades general chat width for
   schema-bound output). Here the schema is the turn's own retrieved
   context: a token whose fact is not on offer is removed from the argmax,
   and nothing else about the model's choice changes. Greedy decode stays
   deterministic (§5.1), and the runtime still writes no sentence — §2 N5
   is intact.

   The bound is stated where it is measured (docs/BENCHMARKS.md): this
   stops a citation that was never offered. It does not stop the model
   picking the wrong one of two facts that *were* offered; that is a
   question for the data, and the grader keeps reporting it.
   ═══════════════════════════════════════════════════════════════ */

/** `<|fact:ach.lpu-cgpa|>` → `ach.lpu-cgpa`. */
const FACT_TOKEN = /^<\|fact:([^|]+)\|>$/;

/** A context line as `ai/data/instruction.py` writes it: `[id] value`. */
const CONTEXT_LINE = /^\s*\[([^\]]+)\]/;

/* Frame tokens that can never be part of an answer: they are how the prompt is
   laid out, so a model that emits one has fallen out of the answer and into the
   next turn's frame. MEASURED 2026-10-25 (constrained decode of the sft7
   export, `syn01`): with its preferred fact blocked, the model's runner-up was
   the literal `<|user|>`, and the visitor's answer read `His CGPA is <|user|>.`.
   `<|end|>` and `<|asst|>` are stop ids (the loop stops on them, so they can
   never be content) and `<|abstain|>` is a legitimate result, so neither is
   listed here. */
const FRAME_TOKENS = ['<|sys|>', '<|ctx|>', '<|user|>'];

const EMPTY = new Set();

/**
 * The fact ids this turn actually put in front of the model.
 *
 * Read from the FITTED context — the string the model genuinely read, after
 * `fitToBudget` dropped the lines that did not fit — not from the retrieval
 * list it came from. A line that was trimmed must not be citable; that is the
 * same rule the guard already applies to claims (`guardedAnswer` is given
 * `summary.context`, not the retrieval result).
 *
 * History is deliberately NOT scanned: a fact quoted in an earlier turn is
 * not evidence for this one, and the conversation's own answers are where a
 * stale value would come back from.
 */
export function offeredFactIds(context) {
  const offered = new Set();
  for (const line of String(context ?? '').split('\n')) {
    const match = CONTEXT_LINE.exec(line);
    if (match) offered.add(match[1].trim());
  }
  return offered;
}

/** `{ byId, ids }` for the vocabulary's fact tokens, cached per tokenizer.
 *
 *  The scan is 16k string matches, once per loaded engine; `generate()` runs
 *  it on every turn otherwise, and it would dominate the grammar's cost. */
const VOCAB_CACHE = new WeakMap();

export function factTokens(tokenizer) {
  const vocab = tokenizer?.vocab;
  if (!vocab) throw new Error('factTokens needs a loaded tokenizer');
  const cached = VOCAB_CACHE.get(tokenizer);
  if (cached) return cached;
  const byId = new Map();
  for (const [token, id] of Object.entries(vocab)) {
    const match = FACT_TOKEN.exec(token);
    if (match) byId.set(match[1], id);
  }
  const record = { byId, ids: new Set(byId.values()) };
  VOCAB_CACHE.set(tokenizer, record);
  return record;
}

/**
 * The token ids this turn may not produce: every fact token whose fact is not
 * in `context`.
 *
 * With no context at all (`u01`'s "favourite pizza") that is every fact token
 * in the vocabulary, which is the honest reading — nothing was offered, so no
 * citation is legal, and the model's only remaining polite options are to say
 * it does not know or to `<|abstain|>`.
 *
 * The frame tokens are always excluded (see `FRAME_TOKENS`); that part does
 * not depend on the context, because no context can make `<|user|>` an answer.
 */
export function blockedCitations(tokenizer, context) {
  const { byId } = factTokens(tokenizer);
  const vocab = tokenizer?.vocab || {};
  const blocked = new Set();
  for (const token of FRAME_TOKENS) {
    if (vocab[token] !== undefined) blocked.add(vocab[token]);
  }
  if (!byId.size) return blocked;
  const offered = offeredFactIds(context);
  for (const [fact, id] of byId) {
    if (!offered.has(fact)) blocked.add(id);
  }
  return blocked;
}

/* ── the closed answer space ─────────────────────────────────────

   The citation mask above removes a fact the turn was never given. It does
   NOT stop the sentence frame disagreeing with the fact inside it — and
   that is what the first measurement produced (2026-10-25, sft7, 60 §14
   prompts): "What is his email?" answered `His GitHub is <email>.` The
   frame was a habit, the fact was a legal one, and the visitor reads a
   sentence about the wrong thing.

   So when the answer layer knows the turn is a FACT question
   (`wantsClosedAnswer` in ai/answers/model.mjs) the decode is constrained to
   the set of sentences the model was TRAINED to say:

     answer := <|abstain|>
             | every frame in `ai/answers/answer_frames.json` whose slot holds
               a fact this turn was given, one fact or a `_conj`-joined list

   The frame carries the kind of fact it can hold — "His GitHub is {v}."
   only ever takes `link.github`, "His tech stack: {v}." only ever takes
   facts of the skill kind — so a frame/fact mismatch is unreachable, not
   merely penalised. That is the guarantee Cactus's Needle gets by compiling
   a grammar from tool schemas; here the schema is the training data's own
   sentence table, exported by `tools/export_answer_frames.py` so there is
   still exactly one copy of it.

   The model still chooses: which frame, which fact(s), in which language,
   and whether to abstain at all. What it cannot do is say something it was
   never taught to say about something it was never given. */

const UNIT = '\u0000';

/** `skill.mongodb` → `skill`: the id prefix is the kind a fact joins a list by. */
export function kindOf(factId) {
  const dot = factId.indexOf('.');
  return dot === -1 ? factId : factId.slice(0, dot);
}

/** Every trained sentence that can answer `factId`, most specific first.
 *
 *  `scope: 'self'` — the sentence names one fact (`_FRAMES`); its slot holds
 *  exactly that id.
 *  `scope: 'kind'` — the sentence names a kind (`_COVERAGE_FRAMES`,
 *  `_LIST_FRAMES`), so any fact of that kind the turn was given may fill it.
 *  A fact with no frame of its own is answerable only through its kind's,
 *  which is exactly how the training data answers it. */
export function templatesFor(factId, persona = 'third', { listsOnly = false } = {}) {
  const out = [];
  const add = (pair, scope) => {
    if (!pair) return;
    /* ONLY the turn's persona. The first-person frames used to be in the set as
       well, and MEASURED on the sft7 export (5-case closed-decode probe,
       2026-10-25) the model then answered a third-person turn as "I built …" —
       §5 forbids that voice, and the grammar was offering it. */
    const text = pair[persona] ?? pair.third;
    if (typeof text === 'string' && text.includes('{v}')) out.push({ text, scope });
  };
  const kind = kindOf(factId);
  /* `listsOnly` is for a question whose plan has already said the answer is a
     LIST of the kind (`{kind, ids}` with more than one id — `closedAnswerScope`
     distinguishes the two shapes). "Which projects has he built?" / "uske
     projects kaun kaun se hain?" cannot be answered by the one-fact sentence
     `He built {v}.`: that sentence answers a different question, and the model
     MEASURED on the 2026-11-06 sweep chose it anyway — one project out of the
     three in the context, and one backend skill out of three.

     The list sentence is the shape the training data already teaches for these
     questions (`_LIST_FRAMES`), so restricting the turn to it is a decode
     constraint of exactly the kind this module already applies, not a wording
     rule: the model still chooses the language, the items, and their order. */
  if (!listsOnly) {
    const own = ANSWER_FRAMES.frames[factId];
    if (own) for (const lang of ANSWER_FRAMES.languages) add(own[lang], 'self');
    const kindFrame = ANSWER_FRAMES.kindFrames[kind];
    if (kindFrame) for (const lang of ANSWER_FRAMES.languages) add(kindFrame[lang], 'kind');
  }
  const listFrame = ANSWER_FRAMES.listFrames[kind];
  if (listFrame) for (const lang of ANSWER_FRAMES.languages) add(listFrame[lang], 'kind');
  return out;
}

/* ── a frame with nothing in its slot ─────────────────────────

   MEASURED 2026-10-26, the sft7 export, the 60 §14 prompts: f06 ("and his
   12th marks?", context `[edu.kv2] … 87.6%`) decoded as

       His CGPA is  .

   a trained FRAME with an EMPTY slot — the CGPA sentence, about a fact the
   turn never named. Neither defence in front of it could see this: the
   citation mask admits ordinary words, and the guard grounds CLAIMS while a
   sentence with nothing in its slot claims nothing.

   HOW IT WAS REACHABLE. `edu.kv2` had no sentence in the frame table (it is
   in `_FRAMES` from 2026-10-26), so `answerGrammar` returned `null` and the
   turn fell back to the weaker mask. That is the general shape of the hole:
   ANY fact the table cannot frame — the synthetic §14 cases, whose fictional
   ids are not in the vocabulary at all, are the other family — turns the
   closed space off for that turn, and a frame can then be emitted with its
   slot empty.

   So the sheet of trained sentences is also the check: if what the model
   wrote IS one of them with nothing where the fact goes, it is not an answer.
   Compared with all whitespace removed, because the observed failure carried
   a bare newline in the slot and the frame's own text carries a space.

   BOUND, stated where it is measured: this matches a WHOLE answer that is one
   frame. A hollow frame inside a longer answer is not caught here; the guard
   still sees the words around it, and `emptySlotFrame` is the narrowest rule
   that closes the failure measured. */
function compact(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/** The trained frame `text` is, with its slot empty — or `null`.
 *
 *  `emptySlotFrame(' His CGPA is  .')` → `'His CGPA is {v}.'`;
 *  `emptySlotFrame('His CGPA is 8.28.')` → `null`, because the slot holds
 *  something and the sentence is an answer the guard can check. */
export function emptySlotFrame(text) {
  const bare = compact(text);
  if (!bare) return null;
  const families = [ANSWER_FRAMES.frames, ANSWER_FRAMES.kindFrames, ANSWER_FRAMES.listFrames];
  for (const family of families) {
    for (const langs of Object.values(family ?? {})) {
      for (const lang of ANSWER_FRAMES.languages) {
        const pair = langs?.[lang];
        for (const persona of ['first', 'third']) {
          const template = pair?.[persona];
          if (typeof template !== 'string') continue;
          const at = template.indexOf('{v}');
          if (at === -1) continue;
          if (bare === compact(template.slice(0, at)) + compact(template.slice(at + 3))) {
            return template;
          }
        }
      }
    }
  }
  return null;
}

/* ── a frame holding a fact of the WRONG KIND ─────────────────────

   MEASURED 2026-10-31, the owner's own report: "hi" was answered
   `I study at Aashish Kumar.` The trained education sentence (`I study at
   {v}.`) was emitted with the PERSON fact in its slot, and it reached the
   screen. Every defence in front of it was blind:

   · the citation mask admits `person.name` — it was the greeting's context;
   · the guard grounds CLAIMS, and "Aashish Kumar" is his own name, which the
     §8.4 allowlist always permits. The value was in the context and on the
     allowlist, so the check that exists to catch an invented value had
     nothing to catch.

   What was wrong was not the VALUE but the SENTENCE: `I study at …` is the
   education frame, and its slot is defined to hold an education fact. The
   frame table (`answer_frames.json`, exported from the training data) knows
   that; nothing was asking it.

   So the table is also the check, exactly as `emptySlotFrame` uses it for the
   empty-slot failure. A trained frame whose slot holds a `<|fact:id|>` the
   frame does not admit is not an answer — the model wrote a sentence about
   one thing with another thing inside it.

   BOUND, stated where it is measured: this matches a single placeholder in a
   single frame (`His CGPA is <|fact:x|>.`). A joined list (`His tech stack:
   <a>, <b>.`) is not matched — the slot pattern ends where the frame does —
   so a wrong KIND inside a list frame is NOT caught here. That is the safe
   direction (no false positive on a legitimate list), and a list's membership
   is enforced by `answerGrammar` wherever the closed space is on. */
let FRAME_SLOT_PATTERNS = null;

/** The template's literal text, with each whitespace run matching any run of
 *  whitespace: the model spaces its own output, so the words are the evidence
 *  and the spacing is not. */
function slotRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
}

function frameSlotPatterns() {
  if (FRAME_SLOT_PATTERNS) return FRAME_SLOT_PATTERNS;
  const out = [];
  const add = (template, admits) => {
    const at = template.indexOf('{v}');
    if (at === -1) return;
    const re = new RegExp(`${slotRegex(template.slice(0, at))}` +
      `(<\\|fact:[^|>]+\\|>)${slotRegex(template.slice(at + 3))}`, 'g');
    out.push({ template, admits, re });
  };
  for (const [id, langs] of Object.entries(ANSWER_FRAMES.frames ?? {})) {
    for (const lang of ANSWER_FRAMES.languages) for (const persona of ['first', 'third']) {
      const template = langs?.[lang]?.[persona];
      if (typeof template === 'string') add(template, (factId) => factId === id);
    }
  }
  for (const family of [ANSWER_FRAMES.kindFrames, ANSWER_FRAMES.listFrames]) {
    for (const [kind, langs] of Object.entries(family ?? {})) {
      for (const lang of ANSWER_FRAMES.languages) for (const persona of ['first', 'third']) {
        const template = langs?.[lang]?.[persona];
        if (typeof template === 'string') add(template, (factId) => kindOf(factId) === kind);
      }
    }
  }
  FRAME_SLOT_PATTERNS = out;
  return out;
}

/**
 * The first trained frame in `text` whose slot holds a fact the frame does not
 * admit — or `null`.
 *
 * `text` is the model's RAW output, before `<|fact:…|>` placeholders are
 * resolved: the ids are what this checks, and after resolution there is
 * nothing left to compare. `frameFactMismatch(' I study at <|fact:person.name|>.')`
 * → `{ frame: 'I study at {v}.', factId: 'person.name' }`.
 */
export function frameFactMismatch(text) {
  const raw = String(text ?? '');
  if (!raw.includes('<|fact:')) return null;
  for (const { template, admits, re } of frameSlotPatterns()) {
    for (const match of raw.matchAll(re)) {
      const factId = match[1].slice('<|fact:'.length, -'|>'.length).trim();
      if (!admits(factId)) return { frame: template, factId };
    }
  }
  return null;
}

/** The `_conj` joiners, tokenized and de-duplicated. */
function separators(tokenizer) {
  const out = [];
  const seen = new Set();
  for (const lang of ANSWER_FRAMES.languages) {
    for (const text of ANSWER_FRAMES.separators[lang] || []) {
      const ids = tokenizer.encode(text);
      const key = ids.join(',');
      if (!ids.length || seen.has(key)) continue;
      seen.add(key);
      out.push({ text, ids });
    }
  }
  return out;
}

/** Tokens that only ever start a frame, so a template cannot be empty. */
function nonEmpty(ids) {
  return ids.length > 0;
}

/**
 * The closed answer space for one turn, as a token automaton.
 *
 * `only` narrows the space to the ids the TURN has already scoped itself to —
 * the deterministic single-fact decision the planner made from the question
 * (`closedAnswerScope` in `ai/answers/model.mjs`). Ids that are not in the
 * context are dropped here, so a plan that names something the turn never read
 * cannot make the grammar empty; the context stays the outer bound.
 *
 * WHY this exists, MEASURED (the 2026-10-30 §14 run, `d01`): "What is his
 * email?" was given `[contact.email]` and one retrieved project, and the model
 * answered `His main project is <|fact:project.volunteer|>.` Both frames were
 * legal, both facts were offered, and the sentence was about the wrong one of
 * two. The planner had already decided the turn is about `contact.email`
 * (`contact_field`, field `email`) — it just was not telling the decoder. On
 * this box a 49.6M checkpoint choosing between an email and an unrelated
 * project is a coin flip with a habit; the scope removes the coin, and the
 * model still writes the sentence, in the language it chose, from the frames
 * it was trained on. §2 N5 is untouched: no template is written here.
 *
 * `null` when the turn offers no fact this table has a sentence for: the
 * caller then keeps the citation mask, which is weaker but never invents a
 * refusal. Returning an abstain-only grammar there would turn "the table does
 * not know this fact" into "the portfolio cannot answer", and those are
 * different statements.
 */
export function answerGrammar(tokenizer, context, { persona = 'third', only = null, listsOnly = false } = {}) {
  const { byId } = factTokens(tokenizer);
  const offeredAll = [...offeredFactIds(context)].filter((id) => byId.has(id));
  /* The scope is an INTERSECTION, never a widening: a plan id the turn did not
     read is not evidence, and an empty intersection falls back to the context
     rather than to an answer that cannot be produced. */
  const scoped = Array.isArray(only)
    ? offeredAll.filter((id) => only.includes(id)) : [];
  const offered = scoped.length ? scoped : offeredAll;
  if (!offered.length) return null;

  const kindFacts = new Map();
  for (const id of offered) {
    const kind = kindOf(id);
    if (!kindFacts.has(kind)) kindFacts.set(kind, []);
    kindFacts.get(kind).push(id);
  }

  /* A sentence is built from its frame text plus the ids its slot admits, so
     the same kind frame reached from twelve skills is one template, not
     twelve. The ids are in the key because two facts of the same kind share
     the text but not the slot's contents. */
  const templates = [];
  const seen = new Set();
  const joiners = separators(tokenizer);
  for (const id of offered) {
    for (const { text, scope } of templatesFor(id, persona, { listsOnly })) {
      const slot = (scope === 'self' ? [id] : kindFacts.get(kindOf(id))) || [id];
      const tokens = slot.map((sid) => byId.get(sid));
      const key = text + UNIT + tokens.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const at = text.indexOf('{v}');
      /* The frame's own tokenization, produced by the same tokenizer the
         trainer used. Added tokens split the BPE, so the prefix and the
         suffix encode exactly as they do inside the trained sentence.

         The LEADING SPACE is load-bearing. The trained frame is
         `<|asst|> He studies at …` — the answer follows the marker after one
         space — so its first token is `" He"`, not `"He"`. Encoding the frame
         without it made the grammar offer tokens the model never produces at
         that position, and the constrained argmax then fell to a wrong frame
         by accident (measured: `I built <project.volunteer>.` for "What is his
         email?"). With the space the allowed tokens are the trained ones and
         the model's own preference survives the constraint. */
      const prefix = tokenizer.encode(' ' + text.slice(0, at));
      const suffix = tokenizer.encode(text.slice(at + 3));
      if (!tokens.length || !nonEmpty(prefix)) continue;
      templates.push({ text, slotTokens: tokens, prefix, suffix });
    }
  }
  if (!templates.length) return null;

  /* A node is `{edges, facts, seps, accept}`: literal tokens in `edges`, a
     slot in `facts` (`{tokens, to}` — the facts this frame may name, and the
     node after them), and the separators that may open another item in `seps`
     (`{token, sink, tokens}`: the first token of the joiner, the node the rest
     of the joiner starts at, and the facts that item may name — carried on the
     entry because a multi-token joiner's sink is a CHAIN node and holds no
     slot of its own). */
  const nodes = [{ edges: new Map(), facts: null, seps: [], accept: false }];
  const newNode = () => {
    nodes.push({ edges: new Map(), facts: null, seps: [], accept: false });
    return nodes.length - 1;
  };
  /* `edges` maps a token to EVERY node it can lead to, not to one: frames
     share prefixes (" His …" opens a dozen of them), and a single-valued map
     silently kept only the last one. MEASURED: the automaton then allowed
     exactly one continuation after ` His`, so the decode walked into a dead
     end at the second token. */
  const edge = (from, id) => {
    const next = newNode();
    const list = nodes[from].edges.get(id);
    if (list) list.push(next);
    else nodes[from].edges.set(id, [next]);
    return next;
  };
  const chain = (from, ids) => {
    let at = from;
    for (const id of ids) at = edge(at, id);
    return at;
  };

  for (const { slotTokens, prefix, suffix } of templates) {
    const slot = chain(0, prefix);
    const after = newNode();
    nodes[slot].facts = { tokens: slotTokens, to: after };
    /* A joined list: `fact -> ", " -> fact`, so the SAME frame carries any
       number of facts of its kind, and it can only end where the frame does.
       The separator is recorded at the node BEFORE it so `allowed` can refuse
       it once every fact of the slot has been used — otherwise a single-fact
       slot (`[project.volunteer]`) let the model write `His projects: <v>, `
       and then have nowhere legal to go (measured: stop reason `grammar`). */
    for (const joiner of joiners) {
      /* The separator's FIRST token is recorded in `seps`, not as an edge:
         an edge would be allowed unconditionally by `allowed`, which is how a
         single-fact slot still let the model write `… <|fact:workflow…|>, `
         and then die there (measured, d21). The rest of a multi-token
         separator (" and " is more than one token) is an ordinary chain. */
      const head = newNode();
      let tail = head;
      for (const id of joiner.ids.slice(1)) tail = edge(tail, id);
      nodes[tail].facts = { tokens: slotTokens, to: after };
      /* The sink is the node AFTER the separator's first token, not the end of
         its chain: `", "` is two tokens and `" aur "` is three, and pointing
         the sink at the last one silently DROPPED the rest of the separator.
         MEASURED on the 2026-11-01 scoped sweep: `His certifications:
         <cert.cpp>,<cert.dbms> and<cert.minor-ai>.` and `… <project.grocery>
         a<project.volunteer>.` — the joined words the model was trained on
         (`" and "`, `" aur "`) never got written, because `step` jumped from
         the first separator token straight into the slot. */
      nodes[after].seps.push({ token: joiner.ids[0], sink: head, tokens: slotTokens });
    }
    nodes[chain(after, suffix)].accept = true;
  }

  const stops = defaultStopIds(tokenizer);
  const abstain = tokenizer.vocab?.[SPECIALS.abstain];
  if (abstain !== undefined) {
    /* Through `edge()` like every other transition: `allowed` reads
       `edges.keys()` and `step` reads `edges.get(id)`, and a value stored as a
       bare node rather than a list would make the two disagree. */
    nodes[edge(0, abstain)].accept = true;
  }

  /* State = `node -> the fact sets that reached it`, where a fact set is
     `,id,id,` so a repeat is one substring test.

     WHY the used-set is part of the state: a list is a LOOP (`after a fact,
     a separator, then another fact`), and without memory the model can loop
     forever. MEASURED on the sft7 export: "उनका फ़ोन नंबर क्या है?" decoded
     `मेरा तरीका: <|fact:workflow.how-he-builds|>, …` 29 times and hit the
     96-token cap. A fact may appear once per sentence, which is what a
     trained list is and what stops the loop. */
  const factIds = new Set(byId.values());
  const start = new Map([[0, new Set([','])]]);
  const unused = (used, id) => !used.includes(`,${id},`);

  return {
    templates: templates.length,
    offered,
    scoped: scoped.length > 0,
    start,
    /** Every token legal here, including the stops at a finished sentence. */
    allowed(state) {
      const out = new Set();
      let done = false;
      for (const [index, usedSets] of state) {
        const node = nodes[index];
        if (node.accept) done = true;
        for (const id of node.edges.keys()) out.add(id);
        for (const used of usedSets) {
          if (node.facts) {
            for (const id of node.facts.tokens) if (unused(used, id)) out.add(id);
          }
          for (const { token, tokens } of node.seps) {
            /* A separator opens another item, so it is only legal while the
               slot still has a fact this path has not named. */
            if (tokens.some((id) => unused(used, id))) out.add(token);
          }
        }
      }
      if (done) for (const id of stops) out.add(id);
      return out;
    },
    step(state, id) {
      const out = new Map();
      const isFact = factIds.has(id);
      for (const [index, usedSets] of state) {
        const node = nodes[index];
        const literal = node.edges.get(id) || [];
        const isSlot = !!node.facts && node.facts.tokens.includes(id);
        const sep = node.seps.find((entry) => entry.token === id);
        for (const used of usedSets) {
          /* A fact may be named once per sentence (see the loop note above). */
          if (isFact && !unused(used, id)) continue;
          const nextUsed = isFact ? `${used}${id},` : used;
          const push = (next) => {
            let bucket = out.get(next);
            if (!bucket) { bucket = new Set(); out.set(next, bucket); }
            bucket.add(nextUsed);
          };
          for (const next of literal) push(next);
          if (isSlot) push(node.facts.to);
          /* A separator is a TRANSITION, not just a permission: `allowed`
             offers it while the slot has a fact this path has not named, so
             `step` has to walk to the node after it. Without this the model's
             `,` after a fact landed on no node at all — MEASURED on the sft7
             export: `His tech stack: <|fact:skill.c|>` stopped at 8 tokens
             with reason `grammar` and no full stop, and every `_conj` list
             (`His tech stack: …`, `His projects: …`) could only ever hold one
             item. */
          if (sep && sep.tokens.some((sid) => unused(used, sid))) push(sep.sink);
        }
      }
      return out;
    },
  };
}
