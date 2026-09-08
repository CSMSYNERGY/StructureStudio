// Whose subscription is this? The Deposyt/NMI account is SHARED across CSM Synergy's products,
// so other products' subscription events arrive at StructureStudio's webhook too.
//
// ⚠️ DUPLICATION LEDGER: bundled per function, and `billing-webhook` is its only importer today
// (`grep -rl billingOrderId.ts supabase/functions/*/index.ts`). It lives here rather than inline
// in the webhook for one reason: inline, it could only be tested by slicing the source and
// eval'ing it, and this rule is now TWO incidents deep — it has earned a real test.

/**
 * The prefix of an order_id that PROVES the subscription belongs to another product, or null
 * when it might be ours.
 *
 * Ours is minted only by portal-billing and is always `ss_<clientId>_<planId>` (or the
 * `ss_first_…` first-charge variant). Anything else carrying a recognisable prefix cannot
 * resolve to a StructureStudio tenant, and the caller acks it as processed-with-note instead of
 * throwing — because throwing makes the gateway redeliver for hours, and every attempt files a
 * `severity='error'` row.
 *
 * ⚠️ THE SEPARATOR IS [_-] AND THE MATCH IS CASE-INSENSITIVE. Both halves are scar tissue. This
 * began as /^([a-z]+)_/ — underscore only, lowercase only — written against Framed-UP's `fu_…`
 * and `cs_…` after 40 fault rows for one of their subscriptions (2026-08-24/25). A third product
 * on the same account mints `sub-zW4xVuZ5K7yWubw6Z4ot-CPI_YEARLY-1788299064953`, which separates
 * with a HYPHEN — so the guard did not fire and the event went straight back into the retry loop
 * this rule exists to stop: 18 redeliveries and 18 fault rows in eleven hours, for a
 * subscription that was never ours to record. Do not narrow it back to one separator.
 *
 * An ABSENT or genuinely unparseable order_id returns null ON PURPOSE. That keeps the
 * throw-and-retry behaviour our own out-of-order events depend on — a delete can arrive before
 * its add, and the retry is what lets it land. Refusing to guess is the safe direction: acking
 * something that might be ours would silently drop a real subscription change, and
 * billing-webhook owns every state change after the initial subscribe, so a dropped
 * cancellation leaves a lapsed tenant with full access indefinitely.
 *
 * If a fourth shape ever slips through, the stronger test is the event's own plan id against
 * `billing_plans.gateway_plan_id` — every one of ours is prefixed `SS_`. That costs a query per
 * event, which is why this cheap prefix rule comes first.
 */
export function foreignOrderPrefixOf(orderIdRaw: string): string | null {
  const m = /^([a-z]+)[_-]/i.exec(String(orderIdRaw || ""));
  return m && m[1].toLowerCase() !== "ss" ? m[0] : null;
}
