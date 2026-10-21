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
// ⛔ MIGRATION 244 BEFORE THE DEPLOY. Every charge passes `p_meter_kind`, which only 244's
// wallet_credit accepts; against the old eight-argument function PostgREST finds no match and
// the charge fails (reported as `error`, never thrown). Harmless while the meters are
// disarmed — the arming rail returns before the RPC — but it must be true before arming.
// The other order is safe: 244 defaults the new parameter, so callers that omit it keep working.
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
//
// ── BOTH METERS ARMED IS THE INTENDED STATE (2026-10-21) ───────────────────────────
// 179_tax_meters.sql's header says arming both meters at once would double-charge and that
// exactly one should ever be active. That was true when it was written (2026-09-01): the invoice
// charge then billed for re-using the quote-time answer, so one Avalara call could be charged
// twice. It is STALE since 2026-09-17: each meter is now keyed on its OWN real call — tax_lookup on
// a Verify press's tax_lookups row, tax_invoice on the invoice-time check's row — so arming both
// charges each call once, and the 2026-09-08 decision (work log, "Both meters stay armed") is to
// arm both. Arming only one leaves the other path's calls free. 179 is an applied migration and
// is not edited; this note is the correction.
//
// ── WHAT EACH CALL COST (migration 319) ────────────────────────────────────────────
// A charge keyed on a ledger row also records its outcome on that row (recordLookupCharge:
// charge_state, charge_cents, wallet_tx_id, charged_at), so "what did this call cost, and was it
// billed" is one row. A failed charge is `error` and is replayed by admin-catalog
// tax_charge_retry (retryLookupCharges below) with the SAME idem key: a debit that did post is
// found by wallet_credit's replay check, never posted twice.

// deno-lint-ignore no-explicit-any
type Admin = any;

export type TaxMeterKind = "tax_invoice" | "tax_lookup";

/** The meter each deliberate lookup kind (tax_lookups.kind) is charged on. */
export const TAX_METER_FOR_LOOKUP: Readonly<Record<"verify" | "invoice", TaxMeterKind>> = {
  verify: "tax_lookup",
  invoice: "tax_invoice",
};

/**
 * How a charge is deduplicated — exactly one of:
 *   `idem`     a key derived from the ACT (taxInvoiceIdem / taxLookupIdem). The automatic paths,
 *              where the thing to collapse is a retried submit or a resent invoice.
 *   `lookupId` the `tax_lookups` row id (migration 244). The deliberate paths — the verify
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
  /** A debit was posted (or replayed harmlessly against the same idempotency key). `walletTxId`
   *  is that wallet_transactions row (bigint id), or null when it could not be read back. */
  | { charged: true; priceCents: number; balanceAfterCents: number | null; walletTxId: number | null };

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
 * The meter kind is recorded on the wallet row (`p_meter_kind`, migration 244), which is what
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

    // 2b. NON-BILLABLE ACCOUNTS generate free too (Carolyn 2026-09-21: Non-billable means
    //     "full access to everything", and she was asked about this one specifically
    //     because it is real model spend rather than a feature flag).
    //     Deliberately a SECOND lookup rather than a widening of metered_exempt: the two
    //     answer different questions and both must keep working. metered_exempt is the
    //     per-wallet override for a tenant who IS billed; billing_exempt is the account
    //     posture, set from the Billing posture card, and carries the whole entitlement
    //     map with it (portal-billing, _shared/featureCheck.ts, migration 228).
    //     Checked only after metered_exempt misses, so a wallet-exempt tenant still costs
    //     one query, and an absent client_settings row is simply not exempt.
    const { data: cs, error: csErr } = await admin
      .from("client_settings")
      .select("billing_exempt")
      .eq("client_id", opts.clientId)
      .maybeSingle();
    if (csErr) return { charged: false, reason: "error" };
    if (cs?.billing_exempt === true) return { charged: false, reason: "exempt" };

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

    // 4. The wallet row, for the ledger (migration 319). Read by the key the debit was written
    //    under, so a replay finds the row the FIRST attempt posted. Best-effort: a failed read
    //    costs the link, never the charge, which has already posted.
    let walletTxId: number | null = null;
    try {
      const { data: tx, error: txErr } = await admin
        .from("wallet_transactions")
        .select("id")
        .eq("client_id", opts.clientId)
        .eq("idempotency_key", idem)
        .eq("state", "posted")
        .maybeSingle();
      const id = Number(tx?.id);
      if (!txErr && Number.isSafeInteger(id) && id > 0) walletTxId = id;
    } catch (_e) { /* the charge stands without its link */ }

    const n = Number(bal);
    return { charged: true, priceCents: cents, balanceAfterCents: Number.isFinite(n) ? n : null, walletTxId };
  } catch (_e) {
    return { charged: false, reason: "error" };
  }
}

// ── The charge, recorded on its ledger row (migration 319) ─────────────────────────────

/** Mirrors 319's CHECK on tax_lookups.charge_state. */
export type TaxChargeState = "pending" | "charged" | "exempt" | "inactive" | "unpriced" | "no_rate" | "error";
export const TAX_CHARGE_STATES: readonly TaxChargeState[] = ["pending", "charged", "exempt", "inactive", "unpriced", "no_rate", "error"];

/** What a charge attempt can come back as: chargeTaxCalculation's answer, or chargeLookup's
 *  `no_rate` for a lookup that produced no rate (never charged). */
export type TaxChargeOutcome = TaxChargeResult | { charged: false; reason: "no_rate" };

/** The state a charge outcome is recorded as. A meter with no usage_prices row is the same as a
 *  disarmed one (step 1 above says why), so `unknown_meter` is `inactive`. */
export function chargeStateOf(r: TaxChargeOutcome): Exclude<TaxChargeState, "pending"> {
  if (r.charged) return "charged";
  switch (r.reason) {
    case "exempt": return "exempt";
    case "inactive":
    case "unknown_meter": return "inactive";
    case "unpriced": return "unpriced";
    case "no_rate": return "no_rate";
    default: return "error";
  }
}

/** The four columns 319 adds, as one charge outcome writes them. Every column is written every
 *  time, so a row moving from `error` to `charged` (a retry) carries no leftover of either. */
export function chargeColumns(r: TaxChargeOutcome, now: Date = new Date()): {
  charge_state: Exclude<TaxChargeState, "pending">;
  charge_cents: number | null;
  wallet_tx_id: number | null;
  charged_at: string | null;
} {
  if (r.charged) {
    const cents = Number(r.priceCents);
    return {
      charge_state: "charged",
      charge_cents: Number.isSafeInteger(cents) && cents > 0 ? cents : null,
      wallet_tx_id: r.walletTxId ?? null,
      charged_at: now.toISOString(),
    };
  }
  return { charge_state: chargeStateOf(r), charge_cents: null, wallet_tx_id: null, charged_at: null };
}

// Only a row with no outcome yet, or one waiting on its charge, may be (re)written: a row already
// charged is never turned back into anything else by a late or repeated write.
const OPEN_CHARGE = "charge_state.is.null,charge_state.in.(pending,error)";

/**
 * Mark a ledger row's charge as being attempted, just before the attempt. A function that dies
 * between the debit and recordLookupCharge then leaves `pending`, which an operator can see and
 * tax_charge_retry can replay (the key is the row, so a replay of a debit that posted finds it).
 * Only a row with no state yet moves to pending: an `error` row being retried keeps its state
 * until the retry has an answer. NEVER THROWS; false = not written (no row, a database without
 * migration 319, a read failure). The charge goes ahead either way.
 */
export async function markChargePending(admin: Admin, lookupId: string): Promise<boolean> {
  try {
    if (typeof lookupId !== "string" || !UUID.test(lookupId)) return false;
    const { data, error } = await admin
      .from("tax_lookups")
      .update({ charge_state: "pending", charge_cents: null, wallet_tx_id: null, charged_at: null })
      .eq("id", lookupId)
      .is("charge_state", null)
      .select("id");
    return !error && Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

/**
 * Write what a charge attempt did onto its ledger row. Best-effort and NEVER THROWS: the lookup's
 * answer and the charge itself are already decided, and a builder must never lose a rate or an
 * invoice over a bookkeeping write. False = not written; the caller logs it. A row already
 * `charged` is left alone (OPEN_CHARGE).
 */
export async function recordLookupCharge(admin: Admin, lookupId: string, r: TaxChargeOutcome, now: Date = new Date()): Promise<boolean> {
  try {
    if (typeof lookupId !== "string" || !UUID.test(lookupId)) return false;
    const { data, error } = await admin
      .from("tax_lookups")
      .update(chargeColumns(r, now))
      .eq("id", lookupId)
      .or(OPEN_CHARGE)
      .select("id");
    return !error && Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

// ── The wallet line's words ────────────────────────────────────────────────────────────

/** The two meters' names, as the Billing tab's labels give them (walletLedger.ts METER_LABELS;
 *  taxMeter.test.ts pins the two lists to each other). */
const TAX_METER_LABELS: Record<TaxMeterKind, string> = {
  tax_lookup: "Tax verification",
  tax_invoice: "Invoice tax check",
};

const memoPart = (v: unknown, max: number): string => {
  const s = v == null ? "" : String(v);
  // Control characters out (a memo is printed in the ledger and its CSV), whitespace folded.
  const clean = [...s].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("");
  return clean.replace(/\s+/g, " ").trim().slice(0, max).trim();
};

/**
 * The memo a tax debit carries, which the builder's Transactions view shows as the line
 * (walletLedger.ts MEMO_METERS): the meter's name, the document, and the state the rate was
 * looked up for — "Tax verification · SST-5021 · Minnesota", "Invoice tax check · Invoice 1042 ·
 * Missouri". A missing part is left out rather than shown blank. `state` is the delivery address's
 * state as the contact holds it (the designer stores the full name).
 */
export function taxChargeMemo(input: {
  kind: TaxMeterKind;
  quoteNumber?: unknown;
  invoiceNumber?: unknown;
  state?: unknown;
}): string {
  const label = TAX_METER_LABELS[input.kind] ?? "Sales tax";
  const inv = memoPart(input.invoiceNumber, 40);
  const quote = memoPart(input.quoteNumber, 40);
  const doc = input.kind === "tax_invoice" ? (inv ? `Invoice ${inv}` : quote) : (quote || (inv ? `Invoice ${inv}` : ""));
  return [label, doc, memoPart(input.state, 40)].filter(Boolean).join(" · ").slice(0, 200);
}

// ── tax_charge_retry: replaying failed charges ─────────────────────────────────────────

/** A pending row older than this is a charge whose function died mid-way; a younger one may
 *  still be finishing, and replaying it would only race its own record. */
export const STALE_PENDING_MS = 15 * 60 * 1000;
export const RETRY_LIMIT_MAX = 200;

export type RetryRow = {
  id: string;
  client_id: string;
  kind: "verify" | "invoice";
  short_code: string | null;
  invoice_number: string | null;
  region: string | null;
  charge_state: "error" | "pending";
  called_at: string;
};
export type RetryResult =
  | { ok: false; refused: "meter_disarmed"; meters: { kind: TaxMeterKind; active: boolean; priceCents: number }[]; candidates: number }
  | { ok: false; refused: "unreadable"; error: string }
  | {
    ok: true;
    candidates: number;
    charged: number;
    exempt: number;
    stillFailed: number;
    rows: { id: string; clientId: string; kind: "verify" | "invoice"; from: "error" | "pending"; result: TaxChargeState | "unchanged"; priceCents: number | null }[];
  };

const RETRY_COLUMNS = "id, client_id, kind, short_code, invoice_number, region, charge_state, called_at";

/**
 * Replay the charges that failed (`error`) or never finished (`pending` for over STALE_PENDING_MS),
 * oldest first, at most `limit`, optionally for one tenant. Each replay is chargeTaxCalculation on
 * the SAME ledger row, so the SAME tax_ledger idem key: a debit the first attempt really posted is
 * found by wallet_credit's replay check and linked, never posted again.
 *
 * REFUSES WHEN A METER IS DISARMED: if any candidate's meter is inactive or priced at 0, nothing
 * is replayed (`meter_disarmed`, naming the meters). Replaying then would record those rows as
 * `inactive`, which would be a lie about a charge that failed while the meter was on.
 *
 * The price is the meter's price NOW (chargeTaxCalculation reads it). A replayed row that comes
 * back charged or exempt is recorded; one that fails again stays `error` (a stuck `pending` becomes
 * `error`, so it shows as failed); a replay that meets a meter disarmed in the meantime changes
 * nothing. Never throws.
 */
export async function retryLookupCharges(admin: Admin, opts: {
  clientId?: string | null;
  limit?: number;
  actorUserId?: string | null;
  now?: Date;
}): Promise<RetryResult> {
  try {
    const now = opts.now ?? new Date();
    const limit = Math.max(1, Math.min(RETRY_LIMIT_MAX, Math.floor(Number(opts.limit) || 50)));
    const staleBefore = new Date(now.getTime() - STALE_PENDING_MS).toISOString();
    const base = () => {
      let q = admin.from("tax_lookups").select(RETRY_COLUMNS).in("kind", ["verify", "invoice"]).eq("outcome", "ok");
      if (opts.clientId) q = q.eq("client_id", opts.clientId);
      return q;
    };
    const [errRes, pendRes] = await Promise.all([
      base().eq("charge_state", "error").order("called_at", { ascending: true }).limit(limit),
      base().eq("charge_state", "pending").lt("called_at", staleBefore).order("called_at", { ascending: true }).limit(limit),
    ]);
    if (errRes?.error || pendRes?.error) {
      return { ok: false, refused: "unreadable", error: String((errRes?.error ?? pendRes?.error)?.message ?? "read failed") };
    }
    const candidates: RetryRow[] = [...(errRes.data ?? []), ...(pendRes.data ?? [])]
      .filter((r: RetryRow) => r && typeof r.id === "string" && (r.kind === "verify" || r.kind === "invoice"))
      .sort((a: RetryRow, b: RetryRow) => String(a.called_at).localeCompare(String(b.called_at)))
      .slice(0, limit);
    if (!candidates.length) return { ok: true, candidates: 0, charged: 0, exempt: 0, stillFailed: 0, rows: [] };

    // The arming rail, before any replay.
    const kinds = [...new Set(candidates.map((r) => TAX_METER_FOR_LOOKUP[r.kind]))];
    const { data: prices, error: pErr } = await admin.from("usage_prices").select("kind, active, price_cents").in("kind", kinds);
    if (pErr) return { ok: false, refused: "unreadable", error: String(pErr.message ?? "price read failed") };
    const meters = kinds.map((k) => {
      const p = (prices ?? []).find((x: { kind: string }) => x.kind === k);
      return { kind: k, active: p?.active === true, priceCents: Number(p?.price_cents) || 0 };
    });
    if (meters.some((m) => !m.active || m.priceCents <= 0)) {
      return { ok: false, refused: "meter_disarmed", meters, candidates: candidates.length };
    }

    const out = { charged: 0, exempt: 0, stillFailed: 0 };
    const rows: Extract<RetryResult, { ok: true }>["rows"] = [];
    for (const row of candidates) {
      const kind = TAX_METER_FOR_LOOKUP[row.kind];
      const r = await chargeTaxCalculation(admin, {
        clientId: row.client_id,
        kind,
        lookupId: row.id,
        refType: row.kind === "verify" ? "design" : "invoice",
        refId: (row.kind === "verify" ? row.short_code : row.invoice_number) ?? null,
        memo: taxChargeMemo({ kind, quoteNumber: row.short_code, invoiceNumber: row.invoice_number, state: row.region }),
        actorUserId: opts.actorUserId ?? null,
      });
      const state = chargeStateOf(r);
      // A meter disarmed between the check above and this row: leave the row exactly as it was.
      const record = state === "charged" || state === "exempt" || (state === "error" && row.charge_state === "pending");
      if (record) await recordLookupCharge(admin, row.id, r, now);
      if (state === "charged") out.charged++;
      else if (state === "exempt") out.exempt++;
      else out.stillFailed++;
      rows.push({
        id: row.id, clientId: row.client_id, kind: row.kind, from: row.charge_state,
        result: record ? state : "unchanged", priceCents: r.charged ? r.priceCents : null,
      });
    }
    return { ok: true, candidates: candidates.length, ...out, rows };
  } catch (e) {
    return { ok: false, refused: "unreadable", error: String((e as Error)?.message ?? e) };
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
