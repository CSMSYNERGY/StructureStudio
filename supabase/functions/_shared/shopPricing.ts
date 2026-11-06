/**
 * The Online Shop's deposit arithmetic (shop-checkout, 2026-10-17). Pure, so it is tested
 * without a database. shop_settings.deposit_mode: 'full' = the whole total; 'percent' =
 * deposit_value % of the total; 'flat' = deposit_value whole dollars, never more than the total.
 * A buyer who chose to pay in full (and the shop allows it) owes the total.
 */
export function dueNow(totalCents: number, rule: { mode: string; value: number }, payInFull: boolean): number {
  if (payInFull || rule.mode === "full") return totalCents;
  if (rule.mode === "flat") return Math.min(totalCents, Math.max(0, Math.round(rule.value * 100)));
  const pct = Math.min(100, Math.max(0, rule.value));
  return Math.min(totalCents, Math.round(totalCents * pct / 100));
}
