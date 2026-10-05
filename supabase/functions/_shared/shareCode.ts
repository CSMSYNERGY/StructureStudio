// Is a design's share code short enough to guess? (2026-10-05)
//
// The share code IS the capability: load_design is anon-callable and returns a design to whoever
// knows its code. genShortCode emits 10 characters, but 48 designs from before that carry 6, and
// enumerating that space finds one of them in about 22 million probes. So migration 156
// (load_design) and 193 (the two version RPCs) withhold the customer's details for any code under
// 8 characters after "SS-".
//
// This is the same test for the documents the server writes under a key derived from the code
// alone (<client>/<code>-quote.pdf, -estimate.pdf, -invoice.pdf, all in the public floor-plans
// bucket). A document that printed the customer under such a key would hand back exactly what
// 156 withholds, under a new name. So for these codes the documents print no customer block.
//
// The threshold must stay the SQL's: `length(regexp_replace(short_code, '^SS-', '')) < 8`.
// shareCode.test.ts reads 156 and 193 and fails the push if either says anything else.

export const GUESSABLE_CODE_BELOW = 8;

/** True for a code too short to be a credential, and for anything that is not a code at all (the
 *  safe direction: a caller that lost the code prints no customer rather than the wrong one). */
export function shareCodeIsGuessable(shortCode: unknown): boolean {
  if (typeof shortCode !== "string") return true;
  return shortCode.replace(/^SS-/, "").length < GUESSABLE_CODE_BELOW;
}
