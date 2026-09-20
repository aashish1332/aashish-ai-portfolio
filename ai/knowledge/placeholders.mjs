/* ═══════════════════════════════════════════════════════════════
   ai/knowledge/placeholders.mjs — the `<|fact:id|>` grammar (§7.2)

   §7.2: "The model emits a placeholder; the app substitutes the verified
   value. URLs, emails, dates and numbers are never generated character by
   character." That only holds if the model, the tokenizer and the browser
   agree on one grammar — so the grammar lives here, the tokenizer mirrors
   it in Python (`ai/tokenizer/spec.py`), and both are pinned to the same
   fixture (`tests/fixtures/placeholder_cases.json`). If either runtime
   drifts, a test in that runtime fails.

   Matching rules, and why they are this loose: whitespace is allowed
   inside the delimiters (`<| fact:x |>`), because a model that learned the
   tokens may still emit the surrounding spaces. The id itself is captured
   as `[^|]+?` — never a guess at its shape, since ids come from
   knowledge.json (`project.volunteer.live`) and a restrictive character
   class here would silently stop resolving new ids later.
   ═══════════════════════════════════════════════════════════════ */

/** The pattern source, shared verbatim with the Python mirror. */
export const PLACEHOLDER_PATTERN = '<\\|\\s*fact:([^|]+?)\\s*\\|>';

/** Global form for scanning/replacing. */
export const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_PATTERN, 'g');

/** Anchored copy — kept separate so `.test()` can never carry `lastIndex`. */
const ANCHORED = new RegExp(`^${PLACEHOLDER_PATTERN}$`);

/** Canonical placeholder string for a fact id. */
export function placeholderToken(id) {
  const fid = String(id ?? '').trim();
  if (!fid || /[|<>]/.test(fid)) throw new Error(`invalid fact id: ${id}`);
  return `<|fact:${fid}|>`;
}

/** True only for a complete, well-formed placeholder. */
export function isPlaceholder(value) {
  return ANCHORED.test(String(value ?? '').trim());
}

/** Every fact id referenced in `text`, in order, deduplicated. */
export function iterPlaceholders(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text ?? '').matchAll(PLACEHOLDER_RE)) {
    const id = m[1].trim();
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/** Replace placeholders with `fn(id, match)`. Slash-free so callers can't
 *  inject a regex by accident. */
export function replacePlaceholders(text, fn) {
  return String(text ?? '').replace(PLACEHOLDER_RE, (match, id) => fn(id.trim(), match));
}
