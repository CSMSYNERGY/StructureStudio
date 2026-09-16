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
// Importer: customer-accept only. Derive it before a deploy rather than trusting this line:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*acceptTotal\.ts"}s' {}

export type AcceptTotalCheck =
  | { ok: true }
  | { ok: false; status: 400; body: { error: string; reason: "bad_request" } }
  | { ok: false; status: 409; body: { error: string; reason: "repriced"; totalCents: number | null } };

/**
 * `expected` is the request's expectedTotalCents; `totalDollars` is the total the handler is
 * about to freeze (totalFromSnapshot — null when the snapshot has none). Compared in whole cents,
 * the same Math.round(total * 100) orderCentsFromSnapshot uses, so float dust cannot refuse a
 * signature.
 */
export function checkExpectedTotal(expected: unknown, totalDollars: number | null): AcceptTotalCheck {
  if (expected === undefined || expected === null) return { ok: true };
  if (typeof expected !== "number" || !Number.isSafeInteger(expected)) {
    return { ok: false, status: 400, body: { error: "Invalid expected total.", reason: "bad_request" } };
  }
  const totalCents = totalDollars == null || !Number.isFinite(totalDollars) ? null : Math.round(totalDollars * 100);
  if (totalCents === expected) return { ok: true };
  return {
    ok: false,
    status: 409,
    body: {
      error: "This quote was updated. Reload to see the current total before signing.",
      reason: "repriced",
      totalCents,
    },
  };
}
