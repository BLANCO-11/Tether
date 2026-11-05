// T004 — normalisation for injection-pattern matching (plan D6 / research R5).
//
// Every pattern in patterns.ts matches against the output of this function, and
// every WARNING reports the RAW value. Both halves matter:
//
//   - Matching the raw string is defeated by one zero-width space.
//   - Reporting the normalised string sends the operator looking for text that
//     does not appear in their own tool registry.
//
// No dependency: NFKC folding and the code-point classes below are enough
// (constitution Article IV).

/** U+200B..U+200D and U+FEFF — render as nothing, so they hide inside a word. */
const ZERO_WIDTH = /[​-‍﻿]/g;

/**
 * Bidirectional formatting and isolate controls (U+202A..U+202E, U+2066..U+2069).
 * These reorder RENDERED text without changing the code points, so a description
 * can display as something other than what it contains.
 */
const BIDI_CONTROL = /[‪-‮⁦-⁩]/g;

/**
 * Fold a registered value into the form patterns are written against.
 *
 * Order is deliberate: strip the invisibles FIRST, so NFKC cannot compose a
 * zero-width character into something that survives, then fold, then lowercase,
 * then collapse whitespace so a phrase split across a newline still matches.
 */
export function normalizeForMatching(value: string): string {
  return value
    .replace(ZERO_WIDTH, "")
    .replace(BIDI_CONTROL, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
