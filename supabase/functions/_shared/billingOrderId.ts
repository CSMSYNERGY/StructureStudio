// Whose subscription is this? The Deposyt/NMI account is SHARED across CSM Synergy's products,
// so other products' subscription events arrive at StructureStudio's webhook too.
//
// ⚠️ DUPLICATION LEDGER: bundled per function, and `billing-webhook` is its only importer today
// (`grep -rl billingOrderId.ts supabase/functions/*/index.ts`). It lives here rather than inline
// in the webhook for one reason: inline, it could only be tested by slicing the source and
// eval'ing it, and this rule is now TWO incidents deep — it has earned a real test.
// ssClientIdOf joined it on 2026-10-05, for the same reason: the webhook now reads it on the add
// AND on every 0-row branch, and the second use decides whether an event is acked or retried.

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
 * on the same account mints ids shaped `sub-<20 chars>-CPI_YEARLY-<epoch ms>`, which separate
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

/**
 * The tenant one of OUR order_ids names, or null when it is not one of ours.
 *
 * portal-billing mints `ss_<clientId>_<planId>` and the first-charge variant
 * `ss_first_<clientId>_<planId>`. clientId is a DNS-safe slug (it doubles as a subdomain, so no
 * underscores), hence the segment after `ss_` is exactly it. Without the optional `first_` hop the
 * capture group returned the literal "first" as the tenant slug, and a gateway-created
 * subscription would have been homed on a nonexistent client called "first".
 *
 * Moved verbatim from billing-webhook's add case. Its second reader is the webhook's 0-row branch:
 * an update/delete/pause for a tenant whose client_configs row is GONE is acked rather than retried,
 * because admin-catalog's delete_client cancels the tenant's subscriptions at the gateway and then
 * wipes the rows those cancellations would have matched.
 *
 * Lowercase and case-sensitive, unlike foreignOrderPrefixOf, and deliberately so: only
 * portal-billing mints these, always lowercase, and a slug is lowercase by construction. Anything
 * else returns null, which keeps the webhook's throw-and-retry — the safe direction for a rule
 * that decides whether an event is dropped.
 */
export function ssClientIdOf(orderIdRaw: string): string | null {
  return /^ss_(?:first_)?([a-z0-9-]+)_/.exec(String(orderIdRaw || ""))?.[1] ?? null;
}
