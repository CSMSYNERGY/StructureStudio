// The accept race (2026-09-17): a customer signs the total on their screen, not whatever the
// quote says by the time the click arrives.
//
// customer-accept re-reads the quote at signature time and freezes THAT total into the
// acceptance. Since a rep can re-price an unsigned quote from the portal (the Verify button, a
// sales-location change, a resubmit), a customer with the page open at $13,316.38 could click
// Accept seconds after a re-price and have a different number frozen as the one they agreed to.
// The page now sends the total it rendered, in cents; a mismatch is refused with the current
// total, so the customer reloads and signs what they can see.
//
// OPTIONAL, AND ABSENT MEANS TODAY. Production runs an older frontend that never sends the
// field, and the edge function is shared, so an absent (or null) value changes nothing. A value
// that is present but is not a whole number of cents is refused rather than ignored: ignoring it
// would silently switch the protection off for a page that meant to ask for it.
//
// THAT CHECK ONLY COVERS A RE-PRICE THAT LANDS BEFORE THE HANDLER'S READ. One that lands between
// the read and the design's promote is the second half of the race, and promoteMiss below is
// how customer-accept closes it (review, 2026-09-17).
//
// promoteMiss has a second caller: portal-settings' push_to_invoice, whose rep attestation is the
// other writer of accepted_at and accepted_snapshot, and promotes with the same compare-and-swap.
//
// Importers: customer-accept and portal-settings. Derive them before a deploy rather than trusting
// this line:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*acceptTotal\.ts"}s' {}

import { totalFromSnapshot } from "./estimateLines.ts";

type RepricedBody = { error: string; reason: "repriced"; totalCents: number | null };

export type AcceptTotalCheck =
  | { ok: true }
  | { ok: false; status: 400; body: { error: string; reason: "bad_request" } }
  | { ok: false; status: 409; body: RepricedBody };

/** Whole cents, the same Math.round(total * 100) orderCentsFromSnapshot uses; null for no total. */
const centsOf = (totalDollars: number | null): number | null =>
  totalDollars == null || !Number.isFinite(totalDollars) ? null : Math.round(totalDollars * 100);

/**
 * The sentence both halves of the race answer with. It must match NONE of the patterns a
 * customer page reads as an expired login: production's my-quotes.html tests every error with
 * /token|session|expired|sign.?in/i and signs the customer out on a match, and "before signing"
 * matched it (review, 2026-09-17). Refused over a re-price, a customer was logged out instead of
 * being shown the new total. The test file pins the sentence against that pattern.
 */
export const REPRICED_SENTENCE = "This quote was just updated. Reload to see the current total, then accept it.";

/** The one refusal both halves of the race answer with, so the page handles a single shape. */
const repriced = (totalDollars: number | null): { status: 409; body: RepricedBody } => ({
  status: 409,
  body: {
    error: REPRICED_SENTENCE,
    reason: "repriced",
    totalCents: centsOf(totalDollars),
  },
});

/**
 * `expected` is the request's expectedTotalCents; `totalDollars` is the total the handler is
 * about to freeze (totalFromSnapshot — null when the snapshot has none). Compared in whole cents,
 * so float dust cannot refuse a signature.
 */
export function checkExpectedTotal(expected: unknown, totalDollars: number | null): AcceptTotalCheck {
  if (expected === undefined || expected === null) return { ok: true };
  if (typeof expected !== "number" || !Number.isSafeInteger(expected)) {
    return { ok: false, status: 400, body: { error: "Invalid expected total.", reason: "bad_request" } };
  }
  if (centsOf(totalDollars) === expected) return { ok: true };
  return { ok: false, ...repriced(totalDollars) };
}

export type PromoteMiss =
  | { kind: "retry"; updatedAt: string | null }
  | { kind: "repriced"; status: 409; body: RepricedBody }
  | { kind: "stop"; why: "gone" | "accepted" };

/**
 * THE SECOND HALF OF THE RACE. customer-accept records the acceptance, then promotes the design
 * (accepted_at, accepted_snapshot) as a compare-and-swap on the updated_at it READ, with
 * accepted_at still null. restampQuoteTax writes the same way, so whichever of the two lands
 * second matches no row. When the promote is the one that missed, this decides why, from a fresh
 * read of the design (`now`, null when the row is gone):
 *   - accepted_at is already set: somebody else promoted it. Stop; a frozen snapshot is never
 *     frozen twice.
 *   - the TOTAL is not the total the customer accepted (`acceptedLines`, the handler's read,
 *     priced by totalFromSnapshot — the same function the acceptance froze its total with, in
 *     whole cents): the quote was re-priced after that read. The acceptance just recorded names
 *     a figure the quote no longer has, so the handler withdraws it and answers with the SAME
 *     409 as the early check, carrying the current total. Whether or not the page sent
 *     expectedTotalCents: without this, the old total would be frozen as the agreement beside a
 *     quote (and an order total) that says something else.
 *   - the total is unchanged: retry against the fresh read's updated_at. Either an unrelated
 *     write moved it (a re-send stamping ss_quote_sent_at), or a re-stamp that left the money
 *     where it was (the same rate under another basis or label, or a fresh resolvedAt). The
 *     customer agreed to that figure, and what freezes is what they were shown. This used to
 *     compare the lines as JSON, which refused a customer over a re-stamp that changed nothing
 *     they pay (review, 2026-09-17); the attempts stay bounded by the caller.
 */
export function promoteMiss(
  acceptedLines: unknown,
  now: { estimate_lines?: unknown; accepted_at?: unknown; updated_at?: unknown } | null | undefined,
): PromoteMiss {
  if (!now) return { kind: "stop", why: "gone" };
  if (now.accepted_at) return { kind: "stop", why: "accepted" };
  const nowTotal = totalFromSnapshot(now.estimate_lines);
  if (centsOf(nowTotal) !== centsOf(totalFromSnapshot(acceptedLines))) {
    return { kind: "repriced", ...repriced(nowTotal) };
  }
  return { kind: "retry", updatedAt: typeof now.updated_at === "string" ? now.updated_at : null };
}
