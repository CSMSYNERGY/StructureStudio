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
// Importer: customer-accept only. Derive it before a deploy rather than trusting this line:
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

/** The one refusal both halves of the race answer with, so the page handles a single shape. */
const repriced = (totalDollars: number | null): { status: 409; body: RepricedBody } => ({
  status: 409,
  body: {
    error: "This quote was updated. Reload to see the current total before signing.",
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
 *   - the lines are not the lines the customer accepted (`acceptedLines`, the handler's read):
 *     the quote was re-priced after that read. The acceptance just recorded is for a quote that
 *     no longer exists, so the handler withdraws it and answers with the SAME 409 as the early
 *     check, carrying the current total. Whether or not the page sent expectedTotalCents: without
 *     this, the old lines would be frozen as the agreement beside a quote (and an order total)
 *     that says something else. Any change to the lines counts, not only a changed total; the
 *     acceptance row froze the tax too, and a reload costs the customer one tap.
 *   - the lines are unchanged: an unrelated write moved updated_at (a re-send stamping
 *     ss_quote_sent_at). Retry against the new value.
 * The lines are compared as JSON: jsonb comes back key-normalised, so two reads of the same stored
 * value stringify alike (restampQuoteTax's comparison, for the same reason).
 */
export function promoteMiss(
  acceptedLines: unknown,
  now: { estimate_lines?: unknown; accepted_at?: unknown; updated_at?: unknown } | null | undefined,
): PromoteMiss {
  if (!now) return { kind: "stop", why: "gone" };
  if (now.accepted_at) return { kind: "stop", why: "accepted" };
  if (JSON.stringify(now.estimate_lines ?? null) !== JSON.stringify(acceptedLines ?? null)) {
    return { kind: "repriced", ...repriced(totalFromSnapshot(now.estimate_lines)) };
  }
  return { kind: "retry", updatedAt: typeof now.updated_at === "string" ? now.updated_at : null };
}
