/**
 * Money math over the designs.estimate_lines snapshot — submit-estimate step 11's shape:
 *   {
 *     version, discount, lines: [{ kind, itemKey, name, desc, qty, amount, nonTaxable }],
 *     discounts: { taxable, nonTaxable, rows: [{ description, amount, taxable }] },  // 2026-08-27
 *     tax: { rate, amount, label, taxableSubtotal, nonTaxableSubtotal, taxableBase,
 *            source, jurisdiction, address, resolvedAt },                            // 2026-08-27
 *   }
 * The last two keys are written by the SS-mode branch only; a snapshot without them is a
 * pre-tax document, and every function here returns for one exactly what it always did.
 *
 * `amount` is the UNIT price; a line's total is qty * amount. Round each line total, sum,
 * subtract a positive discount, round 2dp, clamp at >= 0 — the exact math estimatePdf.ts
 * and qboInvoice.ts use, extracted here (2026-08-23) because a THIRD consumer arrived
 * (customer acceptance snapshots the total the customer signed for; the SS invoice adds a
 * fourth). One implementation, so the PDF, the books, the acceptance record and the
 * customer's screen can never disagree about the same snapshot — which is also why sales
 * tax landed HERE rather than in the renderer that first needed it.
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

/**
 * The two money pools a taxed document is built from (2026-08-27).
 *
 * Sales tax needs the estimate split in two — what tax is charged on, and what it is not —
 * and the split has to be visible on the document so the arithmetic checks itself in front
 * of the customer (see the totals block in estimatePdf.ts). Both pools come from data that
 * is CHOSEN, never inferred:
 *
 *   - a line is non-taxable because its catalog row says so (`lines[].nonTaxable`, sourced
 *     per item by submit-estimate), and
 *   - a discount reduces the taxable pool or the non-taxable pool because the rep said which
 *     (`discounts.rows[].taxable`), NOT by prorating across both.
 *
 * NO PRORATION. An earlier draft split each discount across the pools by their relative size;
 * Carolyn 2026-08-27: "discounts should select whether they are taxable or not. never assume."
 * A prorated share is a number the reader cannot check against anything printed on the page.
 *
 * Each pool clamps at >= 0 INDEPENDENTLY and does not spill: a discount larger than the pool
 * it was aimed at zeroes that pool and stops, rather than eating into the other one. Spilling
 * would silently move money across the tax boundary — the one thing this whole split exists
 * to prevent.
 */
export interface Subtotals {
  /** Taxable line totals, before discounts. */
  taxable: number;
  /** Non-taxable line totals, before discounts. */
  nonTaxable: number;
  /** Discounts the rep designated taxable. */
  taxableDiscount: number;
  /** Discounts the rep designated non-taxable. */
  nonTaxableDiscount: number;
  /** taxable - taxableDiscount, clamped at >= 0. What tax is charged on. */
  taxableBase: number;
  /** nonTaxable - nonTaxableDiscount, clamped at >= 0. */
  nonTaxableNet: number;
  /** taxableBase + nonTaxableNet — the pre-tax subtotal the Total is built from. */
  subtotal: number;
}

/** Sum of qty * amount over the lines matching `wantTaxable`, each line total rounded first
 *  (the same order estimatePdf.ts and qboInvoice.ts use, so the three cannot disagree). */
function poolOf(lines: any[], wantTaxable: boolean): number {
  let sum = 0;
  for (const li of lines) {
    if (!!li?.nonTaxable === wantTaxable) continue; // nonTaxable true => not the taxable pool
    sum += round2((Number(li?.qty) || 0) * (Number(li?.amount) || 0));
  }
  return round2(sum);
}

/**
 * The pools, or null when there is no snapshot (older designs predate it — see
 * totalFromSnapshot's contract).
 *
 * LEGACY SNAPSHOTS: `discounts` arrived with sales tax. Every snapshot written before it has
 * only the collapsed `discount` number and no per-row taxability, so the whole of it is
 * treated as taxable. Those snapshots also carry no `tax` key, so nothing charges tax against
 * the result — the assignment is inert and exists only so the shape is total.
 */
export function subtotalsFromSnapshot(snap: any): Subtotals | null {
  if (!snap || !Array.isArray(snap.lines)) return null;
  const taxable = poolOf(snap.lines, true);
  const nonTaxable = poolOf(snap.lines, false);

  let taxableDiscount: number;
  let nonTaxableDiscount: number;
  const rows = snap.discounts?.rows;
  if (Array.isArray(rows)) {
    let t = 0, n = 0;
    for (const r of rows) {
      const amt = round2(Math.abs(Number(r?.amount) || 0));
      if (amt <= 0) continue;
      // Absent `taxable` reads as taxable — the designer's default for a new row, and the
      // reading that never quietly removes something from the tax base.
      if (r?.taxable === false) n += amt; else t += amt;
    }
    taxableDiscount = round2(t);
    nonTaxableDiscount = round2(n);
  } else {
    taxableDiscount = round2(Math.max(0, Number(snap.discount) || 0));
    nonTaxableDiscount = 0;
  }

  const taxableBase = Math.max(0, round2(taxable - taxableDiscount));
  const nonTaxableNet = Math.max(0, round2(nonTaxable - nonTaxableDiscount));
  return {
    taxable, nonTaxable, taxableDiscount, nonTaxableDiscount,
    taxableBase, nonTaxableNet,
    subtotal: round2(taxableBase + nonTaxableNet),
  };
}

/**
 * The tax actually charged, READ from the snapshot — never recomputed from the rate.
 *
 * `tax.amount` is what the customer was quoted, signed for and was billed; recomputing it
 * from `tax.rate` here would let a rounding difference put a different number on the invoice
 * than the one on the signed quote. The rate is carried for display ("Sales tax (7.25%)"),
 * not as the source of the figure.
 *
 * Null when the snapshot carries no tax — every GHL-mode snapshot, and every SS snapshot
 * issued before this shipped.
 */
export function taxFromSnapshot(snap: any): number | null {
  const amt = snap?.tax?.amount;
  if (amt == null) return null;
  const n = Number(amt);
  return Number.isFinite(n) ? Math.max(0, round2(n)) : null;
}

/**
 * The number the customer owes: tax-inclusive when the snapshot carries tax.
 *
 * Returns null when there is no snapshot — older designs predate it, and null renders
 * honestly as "—" instead of a fabricated $0.00.
 *
 * The no-tax branch is the ORIGINAL body, kept verbatim rather than expressed through the
 * pools above. It is not equivalent: the old code subtracts the whole discount from the
 * combined subtotal and clamps ONCE, where the pools clamp separately, so an over-discount
 * would land on a different number. Every pre-tax snapshot in the database goes through this
 * branch, so it has to be the same arithmetic it has always been, provably and not
 * approximately. When GHL invoicing is switched off and the last untaxed snapshot is gone,
 * this branch goes with it.
 */
export function totalFromSnapshot(snap: any): number | null {
  if (!snap || !Array.isArray(snap.lines)) return null;

  const tax = taxFromSnapshot(snap);
  if (tax == null) {
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

  const s = subtotalsFromSnapshot(snap)!; // non-null: snap.lines is an array by the guard above
  return Math.max(0, round2(s.subtotal + tax));
}

/**
 * The order ledger's money, in CENTS, from one snapshot (migration 148).
 *
 * `orders.total_cents` became tax-INCLUSIVE for SS orders, which silently breaks any reader
 * that treats it as a pre-tax figure — portal-commissions being the one that mattered, since
 * its base_type is literally 'pretax_subtotal'. So the total is never written alone any more:
 * the three components go together, and pretax + tax = total by construction rather than by a
 * later subtraction that could disagree.
 *
 * `taxCents` is NULL for an untaxed snapshot — deliberately not 0, so "not taxed" stays
 * distinguishable from "taxed at 0%", which is the distinction the whole mandatory-rate setting
 * exists to preserve.
 */
/**
 * `designs.total_cents` from an estimate_lines snapshot (migration 206) — the figure the
 * pipeline board card shows as the deal's value.
 *
 * A one-line wrapper on purpose, so the five call sites that write a snapshot name the thing
 * they are storing instead of each repeating `?.totalCents ?? null`. It is deliberately the
 * SAME arithmetic as orders.total_cents: a card and an order for one design must never show
 * two different numbers, which is exactly the class of drift that hit the Orders screen on
 * 2026-09-02 when a second implementation omitted tax.
 *
 * NULL when there are no lines, and that is load-bearing: the card renders NULL as "No quote
 * yet". 15 of the 43 designs on structure-studio have no lines, and a $0 pipeline card is a
 * lie about a real deal.
 */
export function designTotalCents(snap: unknown): number | null {
  return orderCentsFromSnapshot(snap)?.totalCents ?? null;
}

export function orderCentsFromSnapshot(
  snap: any,
): { totalCents: number; pretaxCents: number; taxCents: number | null } | null {
  const total = totalFromSnapshot(snap);
  if (total == null) return null;
  const tax = taxFromSnapshot(snap);
  const pools = subtotalsFromSnapshot(snap);
  return {
    totalCents: Math.round(total * 100),
    // With no tax the pre-tax base IS the total — and it is taken from `total` rather than from
    // the pools, because the legacy branch of totalFromSnapshot clamps differently (see there).
    pretaxCents: tax == null ? Math.round(total * 100) : Math.round((pools?.subtotal ?? total) * 100),
    taxCents: tax == null ? null : Math.round(tax * 100),
  };
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
 * ONE LINE PER CHANGE, NOT PER CHANGE ORDER (2026-08-28). "It never rewrites estimate_lines"
 * above is true of a MANUAL change order and false of a `design_edit` one: submit-estimate's
 * post-acceptance resubmit and the order card's option change each raise the CO and rewrite
 * estimate_lines in the SAME handler, so the $250 side door that CO bills for is already a
 * priced line in the snapshot we are handed. Charging it again printed a phantom "Change
 * order CO-1 … $250.00" directly under the real door line, and the reconciliation below then
 * credited it back as "Order adjustment / Recorded on the order / −$250.00" — two wrong rows
 * that happen to cancel, on paperwork the customer countersigns, on the ordinary
 * post-acceptance change path rather than the drift the adjustment row was written for. The
 * amount owed was never wrong; the document was. `alreadyInSnapshot` tells the two apart.
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
  /** Migration 211. The builder's change-order fee, stamped onto the row by the guard
   *  trigger from the tenant's policy at the moment the change was opened — never read
   *  from a caller and never re-resolved here. 0 or null = no fee is due. */
  fee_cents?: number | null;
  /** The tax on that fee, frozen at the SAME moment from the rate the agreement already
   *  carries. Honoured verbatim below rather than recomputed: an invoice must never
   *  re-resolve a rate the customer accepted. */
  fee_tax_cents?: number | null;
  fee_taxable?: boolean | null;
  /** `client_settings.co_fee_label`. The tenant names their own fee; the default reads
   *  "Change order fee". Not a column on change_orders — it is joined in by the caller. */
  fee_label?: string | null;
}

/** One acknowledged change order's effect on the total, in dollars. Signed: a credit is
 *  negative and prints as one.
 *
 *  ⚠️ EITHER SIDE MISSING MEANS NO COMPUTABLE EFFECT — ZERO, NOT MINUS THE OTHER SIDE.
 *  `total_after_cents` is nullable and legitimately null on a change order that moved no
 *  money; the amendment trail has always rendered exactly that as "no price change", and
 *  alreadyInSnapshot already skips those rows. This function did not: `Number(null) || 0`
 *  turned a null `after` into a delta of MINUS THE WHOLE ORDER.
 *
 *  It stayed invisible for as long as every caller supplied `orderTotalCents`, because the
 *  reconciliation line silently absorbed the difference. orderCentsAfterAck deliberately
 *  passes null — it is COMPUTING the order total, so it has nothing to reconcile against —
 *  and on a live beta order carrying one such row it wrote $150 over $4,600: the building
 *  vanished and only the change-order fee survived. Found 2026-09-08 by acknowledging a
 *  change on a delivered order and reading the total back.
 *
 *  No row anywhere has `before` null with `after` set, so this loses no legacy behaviour. */
export const changeOrderDelta = (co: any): number => {
  if (co?.total_after_cents == null || co?.total_before_cents == null) return 0;
  return round2((Number(co.total_after_cents) - Number(co.total_before_cents)) / 100);
};

/** The change-order FEE this row carries, in dollars. Never negative: a fee is a charge,
 *  and a negative one would be a refund wearing the wrong name. */
// deno-lint-ignore no-explicit-any
export const changeOrderFee = (co: any): number =>
  Math.max(0, round2((Number(co?.fee_cents) || 0) / 100));

const coSort = (a: any, b: any) => (Number(a?.co_no) || 0) - (Number(b?.co_no) || 0);

/**
 * Which acknowledged change orders the snapshot ALREADY prices — as indexes into a
 * co_no-sorted list. Those must not be billed a second time as lines of their own.
 *
 * `change_orders.source` names them outright ('design_edit' vs 'manual'), but none of the
 * three callers selects that column, so this reads the signature the two design_edit writers
 * leave in the columns they do select: both compute total_before/total_after with
 * totalFromSnapshot and persist the new snapshot in the same handler, so a design edit's
 * `total_after` IS a snapshot total and its `total_before` is the previous one's. Hence the
 * walk backwards from the snapshot we were handed. A manual CO stacked on top is stepped
 * over rather than stopping the walk — it moved the order total without touching the lines,
 * so the design edit beneath it is still the one the snapshot prices.
 *
 * ⚠️ `chain` IS A totalFromSnapshot FIGURE, WHICH IS TAX-INCLUSIVE. That is not a detail —
 * it is the whole reason the comparison works. Seeding it from the pre-tax `subtotal −
 * discount` instead (as this did until 2026-09-07) makes the match impossible on any TAXED
 * design edit, because the column it is compared against was written by totalFromSnapshot.
 * The consequence was visible on every taxed change order: the edit was billed a second time
 * as its own row and the reconciler then subtracted the same figure straight back out, so the
 * customer's invoice carried "Change order CO-1 · $321.75" immediately above "Order
 * adjustment · −$321.75". The Total was right and the document was nonsense. Untaxed
 * snapshots are unaffected — there totalFromSnapshot IS `subtotal − discount`, clamped
 * identically — which is what makes this safe to change under live pre-tax paperwork.
 */
const alreadyInSnapshot = (cos: any[], snapshotTotal: number): Set<number> => {
  const priced = new Set<number>();
  let chain = snapshotTotal;
  for (let i = cos.length - 1; i >= 0; i--) {
    const co = cos[i];
    if (co?.total_after_cents == null) continue;
    if (round2(Number(co.total_after_cents) / 100) !== chain) continue;
    priced.add(i);
    if (co?.total_before_cents != null) chain = round2(Number(co.total_before_cents) / 100);
  }
  return priced;
};

/**
 * The invoice document: the snapshot's lines, one line per acknowledged change order the
 * snapshot does not already price, reconciled to the order's own total.
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
): { lines: any[]; discount: number; total: number; tax: any | null } {
  const baseLines = snap && Array.isArray(snap.lines) ? snap.lines : [];
  const discountRaw = Number(snap?.discount);
  const discount = Number.isFinite(discountRaw) && discountRaw > 0 ? round2(discountRaw) : 0;

  // Subtotal space, not total space: the PDF subtracts the discount itself, so reconciling
  // against the printed total means working in the same units it sums.
  let subtotal = 0;
  for (const li of baseLines) subtotal += round2((Number(li?.qty) || 0) * (Number(li?.amount) || 0));
  subtotal = round2(subtotal);

  const orderTotal = orderTotalCents == null || !Number.isFinite(Number(orderTotalCents))
    ? null
    : round2(Number(orderTotalCents) / 100);

  // Count each change exactly once: a design edit is already priced in `baseLines`, so it
  // gets no line of its own. Only go looking when the deltas do NOT already reconcile to the
  // order — a manual chain that nets back to the snapshot total (an upgrade added, then
  // cancelled) is indistinguishable from a design edit by the totals alone, and it is owed
  // both of its rows.
  const cos = [...(acked ?? [])].sort(coSort);
  const deltas = cos.map(changeOrderDelta);
  const summed = round2(deltas.reduce((a, b) => a + b, 0));
  // The FEES ride in this reconciliation check beside the deltas, because they ride in
  // `orders.pretax_subtotal_cents` too — the acknowledging writer adds both. Leaving them
  // out here would make an otherwise-explained order look unexplained, sending the walk into
  // alreadyInSnapshot and printing a bogus "Order adjustment" row worth exactly the fee.
  const fees = cos.map(changeOrderFee);
  const feeSum = round2(fees.reduce((a, b) => a + b, 0));
  const priced = orderTotal != null &&
      Math.max(0, round2(subtotal + summed + feeSum - discount)) === orderTotal
    ? new Set<number>()
    // Tax-inclusive, to match what total_after_cents holds — see alreadyInSnapshot's warning.
    // The fallback is the old seed and is reached only when there is no usable snapshot, in
    // which case there are no base lines for a change order to be hiding inside anyway.
    : alreadyInSnapshot(cos, totalFromSnapshot(snap) ?? Math.max(0, round2(subtotal - discount)));

  const extra: any[] = [];
  for (let i = 0; i < cos.length; i++) {
    const co = cos[i];
    const delta = deltas[i];
    if (!priced.has(i) && delta !== 0) {
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

    // ── THE FEE (migration 211; Carolyn 2026-09-06: "one it's own line") ───────────────
    // Emitted OUTSIDE both guards above, and that placement is the point:
    //   * `priced.has(i)` means the snapshot already prices the DESIGN EDIT. It can never
    //     price the fee — submit-estimate rebuilds estimate_lines wholesale from the catalog
    //     on every resubmit, so a fee line living in there is destroyed by the next edit and
    //     the money simply vanishes.
    //   * `delta === 0` means the change itself cost nothing. The fee is charged for making
    //     a change at all, so a no-cost change outside the free window still owes it — the
    //     case a rep is most likely to be surprised by, and therefore the one that most has
    //     to appear on the paper.
    const fee = fees[i];
    if (fee > 0) {
      const frozen = Number(co?.fee_tax_cents);
      extra.push({
        kind: "change_order_fee",
        itemKey: co?.co_no == null ? "change-order-fee" : `change-order-fee-${co.co_no}`,
        name: String(co?.fee_label ?? "").trim() || "Change order fee",
        desc: co?.co_no == null ? "" : `Applies to change order CO-${co.co_no}`,
        qty: 1,
        amount: fee,
        // The tenant's own co_fee_taxable, stamped on the row at insert. Deliberately NOT
        // inferred from fee_tax_cents: a taxable fee in a 0% jurisdiction freezes zero tax
        // and still belongs in the taxable pool, or the pools stop adding to the subtotal.
        nonTaxable: co?.fee_taxable !== true,
        // Read by amendedTax INSTEAD of the rate, and printed by nothing.
        taxCentsFrozen: Number.isFinite(frozen) ? Math.max(0, Math.round(frozen)) : 0,
      });
      subtotal = round2(subtotal + fee);
    }
  }

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

  return {
    lines: [...baseLines, ...extra],
    discount,
    total: Math.max(0, round2(subtotal - discount)),
    tax: amendedTax(snap?.tax, extra),
  };
}

/**
 * The snapshot's tax object, moved forward over the lines this function just added.
 *
 * WHY THIS EXISTS. estimatePdf's totals block does NOT sum the lines it prints — it computes
 * the grand total from the tax object's POOLS (`taxableBase + nonTaxableNet + amount`, see
 * estimatePdf.ts' `grand`). So every line added above — a change order, its fee, the
 * reconciliation row — was printed on the document and then silently left out of the Total,
 * on a taxed order. Proved on SSI-8005: the PDF said $3,400 while the ledger, the balance card
 * and `emailAmountDue` all said $4,050, and a regenerate rebuilt the same wrong file. The
 * amount owed was never wrong; the document was, and it is the document the customer signs.
 *
 * THE ACCEPTED AMOUNT IS NEVER RECOMPUTED. `taxFromSnapshot`'s rule holds: `tax.amount` is
 * what the customer was quoted and signed for, and re-deriving it from the rate could shift
 * it by a cent. Only the INCREMENT is computed, from the taxable extras alone, and added.
 *
 * The cent-scaling below is `salesTax.ts::taxOn` — THE SOURCE OF TRUTH, copied rather than
 * imported because that module reads Deno.env at load and this one is pure (estimateLines.test.ts
 * runs with no permissions). If the rounding there changes, change it here in the same commit.
 * `dollars * rate` rounded at the end is a real half-cent bug, not a style preference — see its
 * comment.
 *
 * A line may arrive with `taxCentsFrozen` — the change-order FEE does. That number was
 * stamped on the change_orders row when the change was opened, from the rate the agreement
 * already carries, and it is added VERBATIM rather than recomputed. Today the two arithmetics
 * agree exactly (the trigger rounds `fee_cents * rate`; the block below rounds the same
 * product), so this moves no number. What it buys is that they cannot come apart later, when
 * a tenant's rate changes under an order that was already priced.
 *
 * Returns null when the snapshot carries no tax, which keeps every pre-tax document byte
 * identical to what it prints today.
 */
function amendedTax(baseTax: any, extra: any[]): any | null {
  if (!baseTax || baseTax.amount == null) return null;
  const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

  let addTaxable = 0;      // taxable extras whose tax THIS function computes
  let addNonTaxable = 0;
  let frozenBase = 0;      // taxable extras that arrived with their tax already decided
  let frozenTaxCents = 0;
  for (const li of extra) {
    const amt = round2((Number(li?.qty) || 0) * (Number(li?.amount) || 0));
    if (li?.nonTaxable) { addNonTaxable = round2(addNonTaxable + amt); continue; }
    if (li?.taxCentsFrozen != null && Number.isFinite(Number(li.taxCentsFrozen))) {
      frozenBase = round2(frozenBase + amt);
      frozenTaxCents += Math.max(0, Math.round(Number(li.taxCentsFrozen)));
      continue;
    }
    addTaxable = round2(addTaxable + amt);
  }
  if (addTaxable === 0 && addNonTaxable === 0 && frozenBase === 0) return baseTax;

  // Bounded exactly as salesTax.ts::sane bounds it: a percent-shaped 7.25 slipping through
  // would multiply the increment by a hundred, and a missing rate is not a 0% rate.
  const r = Number(baseTax.rate);
  const rate = Number.isFinite(r) && r >= 0 && r <= 0.25 ? Math.round(r * 100000) / 100000 : 0;
  const addTax = addTaxable > 0 && rate > 0
    ? Math.round(Math.round(addTaxable * 100) * rate) / 100
    : 0;

  // A frozen line is still part of the taxable BASE — it WAS taxed, just not here — so its
  // amount joins the pool while its tax comes from the stamp.
  return {
    ...baseTax,
    taxableBase: round2(num(baseTax.taxableBase, num(baseTax.taxableSubtotal)) + addTaxable + frozenBase),
    nonTaxableNet: round2(num(baseTax.nonTaxableNet, num(baseTax.nonTaxableSubtotal)) + addNonTaxable),
    amount: Math.max(0, round2(num(baseTax.amount) + addTax + frozenTaxCents / 100)),
  };
}

/**
 * The three `orders` money columns as they stand once a change order has been acknowledged.
 *
 * ONE ARITHMETIC. This is amendedInvoiceDocument with the order deliberately NOT supplied, so
 * nothing reconciles against the figure being replaced — the document the customer will be
 * shown and the ledger the builder will read are computed by the same code from the same
 * inputs, which is the only way they cannot drift.
 *
 * WHY NOT `total_cents = co.total_after_cents`, which is what the acknowledging writers did
 * until 2026-09-07. Three separate silent failures:
 *
 *   1. IT DROPS EVERY EARLIER FEE. `total_after_cents` is computed by totalFromSnapshot from
 *      the design's LINES, and a fee is never in those lines (it cannot be — submit-estimate
 *      rebuilds them from the catalog on every edit). Acknowledging CO-2 therefore overwrote
 *      the total with a figure that had never heard of CO-1's fee, silently refunding it.
 *   2. IT DROPS EVERY EARLIER MANUAL CHANGE ORDER. Same reason, and worse: a manual change
 *      moves the total without touching the lines at all. On the beta order this was proved
 *      against, two acknowledged manual changes worth $650 sat on top of a $3,400 design —
 *      and one design edit afterwards would have reset the order to the design's own total,
 *      erasing both. The walk below recognises what the snapshot already prices and bills
 *      only what it does not.
 *   3. IT LEAVES pretax_subtotal_cents AND tax_cents BEHIND. Migration 148 made the three
 *      columns a set that must agree, and send_invoice hands `pretax_subtotal_cents` to
 *      amendedInvoiceDocument as the figure the printed lines are reconciled against. Move
 *      the total alone and the invoice grows an "Order adjustment" row on the customer's bill.
 *
 * `agreedSnap` must be the design as acknowledged — change_orders_stamp_agreed has already
 * moved accepted_snapshot forward by the time this is called — and `allAcknowledged` must
 * include the change just acknowledged, with its fee columns selected.
 *
 * ⚠️ ONE THING THIS DOES NOT RESOLVE, because it was never decided: a MANUAL change order's
 * total is a figure a rep typed, with no line behind it to tax. It is carried into the pre-tax
 * column, which is where the document prints its row — so on a TAXED order with a manual
 * change the document's tax row and this tax column differ by the tax on that row. Untaxed
 * orders (every manual change order that exists today) are exact. Naming it here rather than
 * inventing an answer inside a money function.
 *
 * Returns null when there is no usable snapshot — nothing to write, and writing a fabricated
 * zero over a real order total would be the worst outcome available.
 *
 * ⚠️ Duplication ledger — importers, ALL of which must be redeployed together:
 *      customer-accept/index.ts   (the customer signs the change)
 *      portal-settings/index.ts   (the rep attests to it)
 */
export function orderCentsAfterAck(
  // deno-lint-ignore no-explicit-any
  agreedSnap: any,
  allAcknowledged: AcknowledgedChangeOrder[] | null | undefined,
): { totalCents: number; pretaxCents: number; taxCents: number | null } | null {
  if (!agreedSnap || !Array.isArray(agreedSnap.lines)) return null;

  // null, not the order's own total: reconciling against the number being replaced would
  // make this function agree with whatever was already there, which is not a calculation.
  const doc = amendedInvoiceDocument(agreedSnap, allAcknowledged ?? [], null);
  const taxAmount = doc.tax == null || doc.tax.amount == null ? null : Number(doc.tax.amount);

  const pretaxCents = Math.round(doc.total * 100);
  const taxCents = taxAmount == null || !Number.isFinite(taxAmount)
    ? null
    : Math.max(0, Math.round(taxAmount * 100));
  return { totalCents: pretaxCents + (taxCents ?? 0), pretaxCents, taxCents };
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

/**
 * The four tax columns an evidence row freezes from the snapshot it was shown against
 * (migration 148). Returns {} when the snapshot carries no tax — every GHL-mode design, and
 * every SS design issued before tax shipped — so the columns stay NULL rather than 0,
 * keeping "was not taxed" distinguishable from "was taxed at nothing".
 *
 * Moved here from customer-accept's module scope (2026-09-02) when push_to_invoice needed
 * the same freeze for a rep-attested acceptance. These columns are what a disputed change
 * order turns on, and they must mean the same thing whether the customer clicked, signed, or
 * the rep attested — two copies is exactly the drift that would be invisible until it
 * mattered.
 *
 * ⚠️ Duplication ledger — importers, ALL of which must be redeployed together when this
 *    changes (_shared bundles PER function):
 *      customer-accept/index.ts
 *      portal-settings/index.ts
 */
// deno-lint-ignore no-explicit-any
export function taxFreeze(snap: any): Record<string, unknown> {
  const t = snap?.tax;
  if (!t || t.amount == null) return {};
  return {
    tax_rate: Number(t.rate) || 0,
    tax_amount: Number(t.amount) || 0,
    tax_jurisdiction: t.jurisdiction ?? null,
    tax_source: t.source === "avalara" || t.source === "fallback" ? t.source : null,
  };
}
