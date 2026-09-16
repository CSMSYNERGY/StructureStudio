// Charging a tenant for a sales-tax calculation (migration 179).
//
// ⚠️ DUPLICATION LEDGER: this module is bundled per function, so a change here means
// redeploying EVERY importer in the same push — `portal-settings` and `submit-estimate`
// today. Leaving one behind means two copies of the billing rule disagreeing, which is
// unobservable until a builder is charged twice or not at all. Same posture cardpointe.ts
// and nmi.ts state for themselves. Derive the importers before you deploy — with something
// that parses an import (a `grep -rl` over-counts on comments and silently skips
// changeOrderDiff.ts, which holds a NUL byte):
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*taxMeter\.ts"}s' {}
//
// ⛔ MIGRATION 243 BEFORE THE DEPLOY. Every charge passes `p_meter_kind`, which only 243's
// wallet_credit accepts; against the old eight-argument function PostgREST finds no match and
// the charge fails (reported as `error`, never thrown). Harmless while the meters are
// disarmed — the arming rail returns before the RPC — but it must be true before arming.
// The other order is safe: 243 defaults the new parameter, so callers that omit it keep working.
//
// ── WHY DIRECT-POST AND NOT A HOLD ─────────────────────────────────────────────────
// 128's rule is that holds are for expensive, slow, failure-prone meters and cheap ones post
// directly. An Avalara lookup is slow-ish and can fail, which argues for a hold — but
// `wallet_tx_one_hold` is UNIQUE on (client_id, meter_kind), so two of a builder's staff
// invoicing at the same moment would collide on `hold_in_flight` and one of them would be
// refused a tax figure on a document they are trying to send. That is a worse failure than
// the one a hold prevents, so this posts after the fact.
//
// ── THE CHECKS wallet_credit DOES NOT DO ───────────────────────────────────────────
// `wallet_credit` moves the balance and records the row. It does NOT read usage_prices, does
// NOT honour metered_exempt, and does NOT refuse on insufficient funds — every one of those
// lives inside `wallet_hold`, which this path deliberately does not use. So they are done
// here, and getting that wrong is how an internal account or a disarmed meter starts
// charging real money.
//
// ── AND THE ONE IT DELIBERATELY STILL DOES NOT DO ──────────────────────────────────
// INSUFFICIENT FUNDS IS NOT A REFUSAL HERE. A wallet at zero must never stop a builder
// sending an invoice — the tax was already calculated and the customer is waiting on the
// document. The balance goes negative and the top-up conversation happens out of band, the
// same way a phone bill works. This is a considered difference from the SMS path, where
// refusing costs the customer nothing because the message has not been sent yet.

// deno-lint-ignore no-explicit-any
type Admin = any;

export type TaxMeterKind = "tax_invoice" | "tax_lookup";

/**
 * How a charge is deduplicated — exactly one of:
 *   `idem`     a key derived from the ACT (taxInvoiceIdem / taxLookupIdem). The automatic paths,
 *              where the thing to collapse is a retried submit or a resent invoice.
 *   `lookupId` the `tax_lookups` row id (migration 243). The deliberate paths — the verify
 *              button and the invoice-time check — where each row is one real request, so a
 *              second press is a second charge even when it returns the same rate. Keying those
 *              on the answer would bill one press and let the next ones through free while
 *              every one of them was a call the account paid for.
 */
type ChargeKey =
  | { idem: string; lookupId?: undefined }
  | { lookupId: string; idem?: undefined };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TaxChargeResult =
  /** The meter is disarmed, priced at zero, or the tenant is exempt. Nothing was written. */
  | { charged: false; reason: "inactive" | "unpriced" | "exempt" | "unknown_meter" | "error" }
  /** A debit was posted (or replayed harmlessly against the same idempotency key). */
  | { charged: true; priceCents: number; balanceAfterCents: number | null };

/**
 * Post one metered charge for a tax calculation.
 *
 * NEVER THROWS. A billing failure must not take down an invoice send or an estimate submit —
 * the tax figure is already computed and stamped by the time this runs, and losing the charge
 * costs us cents while losing the document costs the builder a sale. Failures are reported in
 * the return value so the caller can log them, and swallowed otherwise.
 *
 * `idem` MUST be derived from the act, never from a timestamp: a resent invoice, a retried
 * submit, or a double-clicked button has to collapse onto the same key or the builder pays
 * twice for one calculation. `wallet_credit` treats a repeated key as a no-op and returns the
 * existing balance. A charge with NO usable key — an empty `idem`, or a `lookupId` that is not
 * a row id — is never posted (`error`): wallet_credit reads an empty key as "no idempotency",
 * and a charge nothing can deduplicate is one a retry posts twice.
 *
 * The meter kind is recorded on the wallet row (`p_meter_kind`, migration 243), which is what
 * lets the Billing tab label a tax debit as one instead of the bare word "Usage".
 */
export async function chargeTaxCalculation(
  admin: Admin,
  opts: ChargeKey & {
    clientId: string;
    kind: TaxMeterKind;
    refType: string;
    refId: string | null;
    memo?: string | null;
    actorUserId?: string | null;
  },
): Promise<TaxChargeResult> {
  try {
    // 0. THE KEY, before anything is read. See ChargeKey.
    const idem = opts.lookupId != null
      ? (typeof opts.lookupId === "string" && UUID.test(opts.lookupId) ? taxLedgerIdem(opts.kind, opts.lookupId) : "")
      : (typeof opts.idem === "string" ? opts.idem : "");
    if (!idem) return { charged: false, reason: "error" };

    // 1. THE ARMING RAIL. A missing row and a disarmed row mean the same thing to the caller
    //    and neither is an error — this is exactly how 179 ships as a provable no-op.
    const { data: price, error: priceErr } = await admin
      .from("usage_prices")
      .select("price_cents, active")
      .eq("kind", opts.kind)
      .maybeSingle();
    if (priceErr) return { charged: false, reason: "error" };
    if (!price) return { charged: false, reason: "unknown_meter" };
    if (price.active !== true) return { charged: false, reason: "inactive" };

    const cents = Number(price.price_cents) || 0;
    // An armed meter priced at zero writes nothing rather than a £0.00 debit row. 179 seeds
    // both meters at 0 deliberately, so this is the state between "armed" and "priced".
    if (cents <= 0) return { charged: false, reason: "unpriced" };

    // 2. EXEMPT TENANTS. CSM Synergy's own account and the demo tenants carry
    //    metered_exempt; charging them would put our own money through the wallet ledger.
    //    An ABSENT wallet row is not exempt — it is a tenant who has simply never been
    //    charged for anything, and wallet_credit creates the row.
    const { data: acct, error: acctErr } = await admin
      .from("wallet_accounts")
      .select("metered_exempt")
      .eq("client_id", opts.clientId)
      .maybeSingle();
    if (acctErr) return { charged: false, reason: "error" };
    if (acct?.metered_exempt === true) return { charged: false, reason: "exempt" };

    // 3. The debit. Negative amount, kind 'debit' — the shape wallet_transactions' CHECK
    //    expects and the one wallet_capture uses for held charges.
    const { data: bal, error: creditErr } = await admin.rpc("wallet_credit", {
      p_client_id: opts.clientId,
      p_amount_cents: -cents,
      p_kind: "debit",
      p_ref_type: opts.refType,
      p_ref_id: opts.refId,
      p_memo: opts.memo ?? null,
      p_idem: idem,
      p_actor: opts.actorUserId ?? null,
      p_meter_kind: opts.kind,
    });
    if (creditErr) return { charged: false, reason: "error" };

    const n = Number(bal);
    return { charged: true, priceCents: cents, balanceAfterCents: Number.isFinite(n) ? n : null };
  } catch (_e) {
    return { charged: false, reason: "error" };
  }
}

/**
 * The idempotency key for a per-INVOICE charge. Keyed on the invoice identity, so resending
 * the same invoice — which builders do — never charges twice, while a genuine second invoice
 * on the same design does.
 */
export function taxInvoiceIdem(clientId: string, shortCode: string, invoiceNo: string | number | null): string {
  return `tax_invoice:${clientId}:${shortCode}:${invoiceNo ?? "1"}`;
}

/**
 * The idempotency key for a per-LOOKUP charge. Keyed on the design AND the resolved rate:
 * resubmitting an unchanged quote is the same lookup and must not charge again, but a
 * genuinely different answer — a moved delivery address, a rate change — is a new one.
 * (`resolveRate` is live-until-signed, so a resubmit really can return a different rate.)
 */
export function taxLookupIdem(clientId: string, shortCode: string, rate: number, jurisdiction: string | null): string {
  const r = Number.isFinite(rate) ? rate.toFixed(5) : "0";
  return `tax_lookup:${clientId}:${shortCode}:${r}:${(jurisdiction ?? "").slice(0, 40)}`;
}

/**
 * The idempotency key for a charge behind one `tax_lookups` row — the deliberate paths. One
 * row is one request, so one row is one charge: a replay of the same row collapses, a second
 * press (a new row) does not. Prefixed apart from the two answer-derived keys above so no key
 * from one family can ever equal one from another.
 */
export function taxLedgerIdem(kind: TaxMeterKind, lookupId: string): string {
  return `tax_ledger:${kind}:${lookupId}`;
}
