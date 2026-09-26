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

/* ── fitting the window ──────────────────────────────────────────
   The model has `max_position_embeddings` positions and no more. A prompt
   that wants one token past the end does not degrade — `LlamaEngine.forward`
   throws, and a thrown prompt is a visitor told "the model stopped" for a
   question the portfolio can answer.

   That is not hypothetical. Measured on the shipping tokenizer
   (`npm run probe:tokens`): 14 of the 60 evaluation questions produced a
   prompt over 512 tokens, and "What are his skills?" produced 764 — because
   the context budget was computed at 4 chars/token on a tokenizer that
   spends 1.5, so a "300-token" context was really about 750.

   So the budget is enforced HERE, with the real tokenizer and the real
   frame, instead of estimated upstream and hoped for:

     · context lines are dropped from the TAIL first. They arrive in
       retrieval order (best first), so the weakest evidence goes first;
       and because a line boundary is where the prompt diverges, dropping
       from the tail also leaves the longest possible shared prefix for
       `LlamaEngine.reusePrefix` to skip re-prefilling;
     · then conversation turns, oldest first, which is §10's rule for
       `history` anyway;
     · a prompt that still does not fit with neither left is a genuine
       error — the question alone does not fit — and it throws, because
       silently answering a different question would be worse.

   The caller is told what was dropped, and `guardedAnswer` re-checks the
   guard against the context that was actually read, so a trimmed line can
   never ground a claim. */
export function fitToBudget({
  tokenizer, question, context = '', history = [], rules = 'first',
  maxNewTokens = 96, maxSeq,
}) {
  if (!Number.isFinite(maxSeq)) throw new Error('fitToBudget needs maxSeq');
  const lines = String(context ?? '').split('\n').filter((line) => line.length);
  let turns = [...history];

  const count = (ctx, hist) => tokenizer.encode(
    frame({ question, context: ctx, history: hist, rules })).length;
  const fits = (ctx, hist) => count(ctx, hist) + maxNewTokens <= maxSeq;

  let droppedLines = 0;
  while (lines.length && !fits(lines.join('\n'), turns)) {
    lines.pop();
    droppedLines += 1;
  }
  let droppedTurns = 0;
  while (turns.length && !fits(lines.join('\n'), turns)) {
    turns = turns.slice(1);
    droppedTurns += 1;
  }

  const fittedContext = lines.join('\n');
  const promptTokens = count(fittedContext, turns);
  if (promptTokens + maxNewTokens > maxSeq) {
    throw new Error(`${promptTokens} prompt tokens + ${maxNewTokens} new tokens ` +
      `exceeds the ${maxSeq}-token context, and there is no context left to trim`);
  }

  return {
    context: fittedContext, history: turns, promptTokens,
    /* What the context alone costs inside this frame — the number §8.2's
       budget was always trying to be, measured instead of estimated. */
    contextTokens: promptTokens - count('', turns),
    droppedContextLines: droppedLines, droppedHistoryTurns: droppedTurns,
  };
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
