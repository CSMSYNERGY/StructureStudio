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

/**
 * De-render the GHL-flavored HTML that estimate_lines.desc carries (the floor-plan <a>
 * link prepended to the building line, and <br>-joined credit notes, both entity-escaped)
 * into the plain text every PDF renders: drop anchors whole (a link label with no href is
 * noise on paper), <br> → newline, strip tags, then unescape in reverse of the escape
 * order (&lt;/&gt; before &amp;).
 *
 * Shared here (2026-08-24, moved from submit-estimate's module scope) because the SS
 * invoice renders the same snapshot from portal-settings — two copies of an HTML stripper
 * that must agree is precisely the drift worth avoiding.
 */
export const deHtml = (s: string) =>
  s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();

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

/**
 * ─── AMENDMENTS: what is actually owed once change orders are acknowledged ──────────────
 *
 * THE BUG THIS EXISTS TO KILL (found by an end-to-end test pass, 2026-08-26). The invoice
 * document was built from the estimate_lines snapshot alone. A MANUAL change order — the
 * one a rep records when the customer phones and approves an upgrade — amends only the
 * TOTAL (`change_orders.total_after_cents`, mirrored into `orders.total_cents`); it never
 * rewrites estimate_lines, because there are no priced lines to rewrite. So the bill kept
 * printing the pre-amendment number: CO-1 (+$250) was acknowledged eighteen seconds before
 * SSI-8005 was issued, and the PDF, the customer's card and the sentence they signed all
 * said $3,400 while the order, the balance card and the amendment trail said $4,050. The
 * customer signed for the wrong amount, and "Regenerate & resend" — which promises "from
 * the current totals" — rebuilt from the same snapshot and reproduced it exactly.
 *
 * The staleness guard cannot catch this case: it fires on `acknowledged_at > invoice sent`,
 * and here the change was approved BEFORE the invoice existed. Nothing was stale; the
 * document was simply built from the wrong source.
 *
 * THE FIX, and why it is shaped this way. Carolyn, 2026-08-27: "rebuild the invoice from
 * the order total." Rather than overriding the printed Total — which would leave an invoice
 * whose line items visibly do not add up, the sort of document that loses an argument with
 * a customer — each acknowledged change order becomes a REAL LINE. The lines still foot to
 * the total, and the invoice now says WHY it is what it is. `orders.total_cents` stays
 * authoritative: if it disagrees with snapshot + deltas (a hand-set total on a design-less
 * order, or drift), one explicit adjustment line reconciles the difference instead of the
 * document quietly disagreeing with the books.
 *
 * Every money consumer routes through here for the same reason the file already existed:
 * the PDF, the customer's screen and the signed acceptance record must never be able to
 * name three different numbers for one bill.
 */

/** An acknowledged change order. Field names mirror the `change_orders` columns so a row
 *  can be passed straight through with no remapping. */
export interface AcknowledgedChangeOrder {
  co_no?: number | null;
  description?: string | null;
  total_before_cents?: number | null;
  total_after_cents?: number | null;
}

/** One acknowledged change order's effect on the total, in dollars. Signed: a credit is
 *  negative and prints as one. */
export const changeOrderDelta = (co: any): number =>
  round2(((Number(co?.total_after_cents) || 0) - (Number(co?.total_before_cents) || 0)) / 100);

const coSort = (a: any, b: any) => (Number(a?.co_no) || 0) - (Number(b?.co_no) || 0);

/**
 * The invoice document: the snapshot's lines plus one line per acknowledged change order,
 * reconciled to the order's own total.
 *
 * `acked` must contain ONLY acknowledged change orders — a pending one is not owed, and
 * the callers already refuse to invoice while one is outstanding. Zero-delta rows (a
 * change of scope at no cost) are recorded but add no line: a $0.00 row on a bill reads
 * like a mistake.
 *
 * `orderTotalCents` is `orders.total_cents`, or null when there is no order row to trust.
 *
 * Returns lines that ALWAYS foot to `total` under the PDF's own arithmetic
 * (sum(qty × amount) − discount, clamped at zero) — see estimatePdf.ts' totals block.
 */
export function amendedInvoiceDocument(
  snap: any,
  acked: AcknowledgedChangeOrder[] | null | undefined,
  orderTotalCents: number | null | undefined,
): { lines: any[]; discount: number; total: number } {
  const baseLines = snap && Array.isArray(snap.lines) ? snap.lines : [];
  const discountRaw = Number(snap?.discount);
  const discount = Number.isFinite(discountRaw) && discountRaw > 0 ? round2(discountRaw) : 0;

  // Subtotal space, not total space: the PDF subtracts the discount itself, so reconciling
  // against the printed total means working in the same units it sums.
  let subtotal = 0;
  for (const li of baseLines) subtotal += round2((Number(li?.qty) || 0) * (Number(li?.amount) || 0));
  subtotal = round2(subtotal);

  const extra: any[] = [];
  for (const co of [...(acked ?? [])].sort(coSort)) {
    const delta = changeOrderDelta(co);
    if (delta === 0) continue;
    const label = co?.co_no == null ? "Change order" : `Change order CO-${co.co_no}`;
    extra.push({
      kind: "change_order",
      itemKey: co?.co_no == null ? "change-order" : `change-order-${co.co_no}`,
      name: label,
      desc: deHtml(String(co?.description ?? "")),
      qty: 1,
      amount: delta,
      nonTaxable: false,
    });
    subtotal = round2(subtotal + delta);
  }

  const orderTotal = orderTotalCents == null || !Number.isFinite(Number(orderTotalCents))
    ? null
    : round2(Number(orderTotalCents) / 100);
  if (orderTotal != null && Math.max(0, round2(subtotal - discount)) !== orderTotal) {
    // The order is the book of record. Name the difference rather than silently printing a
    // number the line items do not support.
    const adj = round2(orderTotal + discount - subtotal);
    extra.push({
      kind: "adjustment",
      itemKey: "order-adjustment",
      name: "Order adjustment",
      desc: "Recorded on the order",
      qty: 1,
      amount: adj,
      nonTaxable: false,
    });
    subtotal = round2(subtotal + adj);
  }

  return { lines: [...baseLines, ...extra], discount, total: Math.max(0, round2(subtotal - discount)) };
}

/**
 * What the customer actually owes — the number the invoice prints, the customer's card
 * shows, and the consent sentence names. Null only when there is nothing to go on at all
 * (no snapshot AND no order total), which still renders honestly as "—".
 */
export function amountOwed(
  snap: any,
  acked: AcknowledgedChangeOrder[] | null | undefined,
  orderTotalCents: number | null | undefined,
): number | null {
  const hasSnap = !!(snap && Array.isArray(snap.lines));
  const orderTotal = orderTotalCents == null || !Number.isFinite(Number(orderTotalCents))
    ? null
    : round2(Number(orderTotalCents) / 100);
  if (!hasSnap) return orderTotal;
  return amendedInvoiceDocument(snap, acked, orderTotalCents).total;
}
