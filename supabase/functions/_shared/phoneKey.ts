// _shared/phoneKey.ts — the canonical phone comparison for customer ownership checks.
//
// WHY THIS IS ITS OWN MODULE. This one function decides whether a stranger can read, sign,
// or now PAY someone else's invoice. It existed as a private copy in customer-accept and
// customer-quotes; customer-pay would have made three. Three copies of the comparison that
// gates a money path is how one of them drifts, and the drift would be silent in exactly
// the direction that matters.
//
// It is a tiny dedicated module rather than a function on customerSession.ts so that
// module keeps one responsibility and the redeploy set stays small and obvious.
//
// ⚠️ Duplication ledger — importers, ALL of which must be redeployed together when this
//    changes (_shared bundles PER function):
//      customer-accept/index.ts
//      customer-quotes/index.ts
//      customer-pay/index.ts
//      portal-payments/index.ts

/**
 * Canonical last-10-digits phone form for the ownership compares.
 *
 * The session identity is the 10 digits after "+1" (customer-auth), but stored contact
 * phones are formatted display strings — "+1 (816) 555-0123" strips to 11 digits, which
 * used to never match and refused a verified customer their own quotes and their own
 * signature (failing closed, but wrongly).
 *
 * Strips exactly one leading US "1" from an 11-digit string; nothing looser — any other
 * shape compares as-is, so an international number is never silently truncated into
 * somebody else's.
 *
 * COMPARE-ONLY. The stored `phone_digits` evidence keeps the raw identity.
 */
export function phoneKey(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}
