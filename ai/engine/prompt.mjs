/* ═══════════════════════════════════════════════════════════════
   ai/engine/prompt.mjs — the §7.4 training frame, at inference time.

   The model was trained on exactly one layout:

     <|sys|> RULES <|ctx|> context <|user|> question <|asst|> answer <|end|>

   with the parts joined by single spaces (`instruction.format_example`).
   Rebuilding that string differently at runtime — a newline where training
   had a space, the rules omitted, the context before the rules — is the
   cheapest way to make a trained model look broken, so:

     * the strings live in `prompt_contract.json`, generated from
       `ai/data/instruction.py` by `inference/export_prompt_contract.py`
       and pinned by `tests/py/test_prompt_contract.py`. There is no second
       copy of the rules to drift;
     * `frame()` is the only place a prompt is assembled.
   ═══════════════════════════════════════════════════════════════ */

import contract from './prompt_contract.json' with { type: 'json' };

export const PROMPT_CONTRACT = contract;
export const SPECIALS = contract.frames;

/** The part of the frame that does not depend on the question.
 *
 * This exists because of a measured cost, not for tidiness: the specials and
 * the rules are 125 tokens at the config this runs, which is 46% of a typical
 * prompt and about 2.2 s of prefill on the dev laptop - paid again on every
 * question, for tokens whose K/V is identical every time. The engine keeps
 * those positions in its KV cache and skips them (see
 * `LlamaEngine.reusePrefix`), so the wait a visitor feels is the part that
 * actually changed.
 *
 * `frame()` is defined in terms of this, so the split can never drift from
 * the string the model was trained on. */
export function framePrefix({ rules = 'first' }) {
  const sys = contract.rules[rules];
  if (!sys) throw new Error(`unknown rules key ${rules}`);
  return `${SPECIALS.sys} ${sys} ${SPECIALS.ctx} `;
}

/** `{ prefix, rest }` — `frame(args) === framePrefix(args) + rest`, asserted
 *  in `tests/engine.test.mjs` so a layout change cannot silently make the
 *  cached prefix a different string from the one being prefilled. */
export function frameParts({ question, context, rules = 'first', history = [] }) {
  const parts = [context ?? ''];
  for (const [user, assistant] of history) {
    parts.push(SPECIALS.user, user, SPECIALS.asst, assistant, SPECIALS.end);
  }
  parts.push(SPECIALS.user, question, SPECIALS.asst);
  return { prefix: framePrefix({ rules }), rest: parts.join(' ') };
}

/** The §7.2 frame for one turn. `history` is the bounded turns already in
 *  the conversation (`[[user, assistant], …]`, §10: 3–4 turns), oldest
 *  first, dropped from the front when the budget is exceeded. */
export function frame(args) {
  const { prefix, rest } = frameParts(args);
  return prefix + rest;
}

/** The prompt the runtime actually feeds the model: the same frame, then
 *  ids, then greedy decode until `<|end|>`. Kept here so chat, voice and
 *  the tests all generate from one definition. */
export function promptIds(tokenizer, args) {
  return tokenizer.encode(frame(args));
}

/** What the model may not finish a sentence with: the turn ends at
 *  `<|end|>` (the model's own habit from training) or at a new `<|asst|>`,
 *  which would otherwise leak the next turn's frame into the answer. */
export function defaultStopIds(tokenizer, { includeAbstain = false } = {}) {
  const stops = new Set();
  const end = tokenizer.vocab[SPECIALS.end];
  if (end !== undefined) stops.add(end);
  const asst = tokenizer.vocab[SPECIALS.asst];
  if (asst !== undefined) stops.add(asst);
  // `<|abstain|>` is a *result*, not a stop: the engine reports it so the
  // answer layer can say "I don't have that" instead of showing a token.
  if (includeAbstain) {
    const abstain = tokenizer.vocab[SPECIALS.abstain];
    if (abstain !== undefined) stops.add(abstain);
  }
  return stops;
}

export function abstainId(tokenizer) {
  return tokenizer.vocab[SPECIALS.abstain];
}
