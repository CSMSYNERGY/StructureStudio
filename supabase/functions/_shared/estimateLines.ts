/**
 * Money math over the designs.estimate_lines snapshot — submit-estimate step 11's shape:
 *   { version, discount, lines: [{ kind, itemKey, name, desc, qty, amount, nonTaxable }] }
 *
 * `amount` is the UNIT price; a line's total is qty * amount. Round each line total, sum,
 * subtract a positive discount, round 2dp, clamp at >= 0 — the exact math estimatePdf.ts
 * and qboInvoice.ts use, extracted here (2026-08-23) because a THIRD consumer arrived
 * (customer acceptance snapshots the total the customer signed for; the SS invoice adds a
 * fourth). One implementation, so the PDF, the books, the acceptance record and the
 * customer's screen can never disagree about the same snapshot.
 *
 * Returns null when there is no snapshot — older designs predate it, and null renders
 * honestly as "—" instead of a fabricated $0.00.
 */

// deno-lint-ignore-file no-explicit-any

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function totalFromSnapshot(snap: any): number | null {
  if (!snap || !Array.isArray(snap.lines)) return null;
  let subtotal = 0;
  for (const li of snap.lines) {
    const qty = Number(li?.qty) || 0;
    const unit = Number(li?.amount) || 0;
    subtotal += round2(qty * unit);
  }
  subtotal = round2(subtotal);
  const discount = Number(snap.discount) || 0;
  if (discount > 0) subtotal = round2(subtotal - discount);
  // Clamped at >= 0 like estimatePdf.ts' Total row (audit 2026-08-20).
  return Math.max(0, subtotal);
}
