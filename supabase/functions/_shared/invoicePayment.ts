// _shared/invoicePayment.ts — charge a customer's card or bank account against an order
// balance, exactly once.
//
// ONE implementation, two callers that must never diverge:
//   customer-pay      the shed shopper paying their own invoice from my-quotes.html
//   portal-payments   the builder taking a card in the Orders tab's Record-a-payment modal
//
// Both move the same money through the same gateway into the same `payments` table, so they
// are the same function. What differs is who is asking and how they are authenticated —
// which is the caller's job, not this module's.
//
// ⚠️ Duplication ledger — the attempt-ledger choreography here (closed_unknown block, stale
//    open promotion, insert-as-concurrency-guard, closeAttempt) is a deliberate mirror of
//    _shared/walletTopup.ts and of the subscribe loop in portal-billing/index.ts. Those move
//    money on a DIFFERENT processor for a DIFFERENT merchant of record. If you change the
//    double-charge posture in one, change all three.
//    Importers: customer-pay/index.ts, portal-payments/index.ts
//
// THE ORDERING RULE, which is the whole point of this file: the charge attempt exists in OUR
// records BEFORE the card is touched, and the balance is credited only AFTER the sale is
// known to have succeeded. Every failure between those two points is recorded as a state a
// human can resolve, never guessed at.

import {
  cpAuth,
  cpCents,
  cpInquireByOrderId,
  cpSummary,
  cpVoid,
  isGatewayConfig,
  isGatewayThrottled,
  isGatewayUnknown,
  throttledRetryAfter,
} from "./cardpointe.ts";
import { amountOwed } from "./estimateLines.ts";

/** $1 floor — below it the card fee exceeds the payment. $50,000 ceiling: above that a
 *  figure is more likely a typo than a shed, and "call your builder" is the right answer.
 *  Exported so both edge functions validate against these and the browser is TOLD them
 *  rather than hardcoding a second copy. */
export const MIN_PAYMENT_CENTS = 100;
export const MAX_PAYMENT_CENTS = 5_000_000;

/** How long an `open` attempt may sit before it is treated as a charge that died
 *  mid-flight — the one failure no catch below can observe. */
export const STALE_OPEN_MS = 10 * 60 * 1000;

// deno-lint-ignore no-explicit-any
type Admin = any;

export type PaymentResult =
  | {
    ok: true;
    paymentId: string;
    retref: string;
    amountCents: number;
    surchargeCents: number | null;
    brand: string | null;
    last4: string | null;
    fundingState: "settled" | "pending";
    balanceCents: number;
    already: boolean;
  }
  | { ok: false; error: string; blocking: boolean; status: number };

// ─────────────────────────────────────────────────────────────────────────────────────
// The amount, decided in one pure place.
//
// PURE so it can be unit-tested with no database and no gateway, and so there is exactly
// ONE definition of "what is payable right now" shared by the intent call that renders the
// button, the confirm handshake, and the charge itself. Every refusal is a named reason
// rather than a bare false: "why can't I pay?" needs an answer on a customer's phone.
// ─────────────────────────────────────────────────────────────────────────────────────

export type AmountInput = {
  /** From amountOwed(), ALREADY converted to cents by the caller. */
  owedCents: number | null;
  settledCents: number;
  pendingCents: number;
  /** invoice_sends.deposit_cents — NULL means pay in full. */
  depositCents: number | null;
};

export type AmountDecision =
  | { ok: true; askCents: number; kind: "deposit" | "balance"; balanceCents: number }
  | { ok: false; reason: string; balanceCents: number | null };

export function paymentAmountDecision(input: AmountInput): AmountDecision {
  const { owedCents, settledCents, pendingCents, depositCents } = input;

  if (owedCents == null || !Number.isFinite(owedCents)) {
    return { ok: false, reason: "no_total", balanceCents: null };
  }
  const balanceCents = owedCents - settledCents;
  if (balanceCents <= 0) {
    return { ok: false, reason: "paid_in_full", balanceCents };
  }
  // A bank payment that has not funded is not money — but it is also not nothing. Any
  // pending amount blocks a further payment on this order until it settles or returns.
  // The way a customer pays twice is by being shown a button that still says they owe it.
  if (pendingCents > 0) {
    return { ok: false, reason: "pending_clearing", balanceCents };
  }

  const onDeposit = depositCents != null && Number.isFinite(depositCents) &&
    settledCents < depositCents;
  const askCents = onDeposit
    ? Math.min((depositCents as number) - settledCents, balanceCents)
    : balanceCents;

  if (askCents < MIN_PAYMENT_CENTS) {
    return { ok: false, reason: "below_minimum", balanceCents };
  }
  if (askCents > MAX_PAYMENT_CENTS) {
    return { ok: false, reason: "above_maximum", balanceCents };
  }
  return { ok: true, askCents, kind: onDeposit ? "deposit" : "balance", balanceCents };
}

/** The customer-facing sentence for each refusal. Kept beside the reasons so a new reason
 *  cannot ship without one. */
export function amountRefusalText(reason: string): string {
  switch (reason) {
    case "no_total":
      return "Your builder hasn't set the total on this order yet.";
    case "paid_in_full":
      return "This order is already paid in full.";
    case "pending_clearing":
      return "A bank payment on this order is still clearing. Nothing more to do until it lands.";
    case "below_minimum":
      return "That amount is too small to charge.";
    case "above_maximum":
      return "That amount is too large to take online — please call your builder.";
    default:
      return "That payment can't be taken right now.";
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Reading the current money position for one order.
// ─────────────────────────────────────────────────────────────────────────────────────

export type OrderMoney = {
  orderId: string;
  shortCode: string | null;
  owedCents: number | null;
  settledCents: number;
  pendingCents: number;
  depositCents: number | null;
};

/**
 * ⚠️ amountOwed() returns DOLLARS as a float — it is the one function on this money path
 * that breaks the repo's integer-cents convention (it has no _cents suffix, so it is
 * technically consistent, which is exactly what makes it easy to miss). It is converted to
 * cents HERE, once, and nowhere else.
 */
export async function readOrderMoney(
  admin: Admin,
  clientId: string,
  orderId: string,
): Promise<OrderMoney | null> {
  const { data: order } = await admin.from("orders")
    .select("id, short_code, total_cents")
    .eq("client_id", clientId).eq("id", orderId).maybeSingle();
  if (!order) return null;

  const shortCode: string | null = order.short_code ?? null;

  let owedCents: number | null = order.total_cents == null ? null : Number(order.total_cents);
  let depositCents: number | null = null;

  if (shortCode) {
    const [{ data: design }, { data: cos }, { data: inv }] = await Promise.all([
      admin.from("designs").select("estimate_lines")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
      admin.from("change_orders")
        .select("co_no, description, total_before_cents, total_after_cents")
        .eq("client_id", clientId).eq("short_code", shortCode).eq("status", "acknowledged"),
      admin.from("invoice_sends").select("deposit_cents")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
    ]);
    depositCents = inv?.deposit_cents == null ? null : Number(inv.deposit_cents);
    const owedDollars = amountOwed(
      design?.estimate_lines,
      cos ?? [],
      order.total_cents == null ? null : Number(order.total_cents),
    );
    owedCents = owedDollars == null ? owedCents : Math.round(owedDollars * 100);
  }

  const { data: pays } = await admin.from("payments")
    .select("amount_cents, funding_state, voided_at")
    .eq("client_id", clientId).eq("order_id", orderId);

  let settledCents = 0;
  let pendingCents = 0;
  // Array.isArray rather than `?? []`: a money total must not throw its way out of a
  // function on an unexpected shape. An empty read reads as "nothing paid", which is the
  // conservative direction — it can only ever ASK for more, never record less.
  for (const p of Array.isArray(pays) ? pays : []) {
    if (p.voided_at) continue;
    const c = Number(p.amount_cents) || 0;
    if (p.funding_state === "pending") pendingCents += c;
    else if (p.funding_state !== "returned") settledCents += c;
  }

  return { orderId, shortCode, owedCents, settledCents, pendingCents, depositCents };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The charge.
// ─────────────────────────────────────────────────────────────────────────────────────

export type ChargeOpts = {
  clientId: string;
  merchid: string;
  orderId: string;
  shortCode: string | null;
  amountCents: number;
  rail: "card" | "ach";
  /** CardSecure token from the iFrame, or raw encrypted track data from the VP3350. */
  account: string;
  expiry?: string;
  postal?: string;
  name?: string;
  /** "E" online, "R" card present at the counter. */
  ecomind?: "E" | "R";
  actorKind: "customer" | "operator" | "staff";
  actorRef?: string | null;
  createdBy?: string | null;
};

/** A durable, unguessable order reference minted BEFORE the attempt row exists — which is
 *  what makes /inquireByOrderid able to answer for a charge whose response we never saw.
 *  The `ssp_` prefix is distinct from the NMI path's `ss_` / `ss_topup_` on purpose: a
 *  different gateway account entirely, and distinct vocabulary is free. */
function mintOrderRef(): string {
  return "ssp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/**
 * Never throws. Every outcome is a PaymentResult the caller can render or log.
 * `blocking: true` means DO NOT retry automatically — a human has to look.
 */
export async function chargeInvoicePayment(
  admin: Admin,
  opts: ChargeOpts,
): Promise<PaymentResult> {
  const { clientId, orderId, amountCents, rail } = opts;

  if (!Number.isInteger(amountCents) || amountCents < MIN_PAYMENT_CENTS || amountCents > MAX_PAYMENT_CENTS) {
    return { ok: false, error: "That payment amount isn't allowed.", blocking: false, status: 400 };
  }
  if (!opts.account) {
    return { ok: false, error: "No payment details were provided.", blocking: false, status: 400 };
  }

  // 1. A prior attempt whose outcome we could not verify blocks this ORDER entirely.
  //    Scoped to the order rather than the tenant: a stuck charge must not freeze a
  //    builder's whole book. Retrying an unverified charge is how a customer is billed twice.
  const { data: unknownPrior } = await admin.from("payment_attempts")
    .select("id, orderid").eq("client_id", clientId).eq("order_id", orderId)
    .eq("state", "closed_unknown").limit(1);
  if (unknownPrior && unknownPrior.length) {
    return {
      ok: false,
      error:
        "A previous payment on this order could not be confirmed. To avoid a double charge, contact your builder before trying again.",
      blocking: true,
      status: 409,
    };
  }

  // 2. An 'open' attempt older than STALE_OPEN_MS means a charge died mid-flight — the one
  //    failure nothing below can observe. That is exactly as unknown as a lost gateway
  //    response, so promote it rather than leaving it blocking behind "in progress".
  //    The .eq("state","open") on the UPDATE is a compare-and-swap: two racing promoters
  //    cannot both act.
  const { data: staleOpen } = await admin.from("payment_attempts")
    .select("id, created_at").eq("client_id", clientId).eq("order_id", orderId)
    .eq("state", "open").limit(1);
  if (staleOpen && staleOpen.length) {
    const ageMs = Date.now() - Date.parse(staleOpen[0].created_at);
    if (ageMs > STALE_OPEN_MS) {
      await admin.from("payment_attempts")
        .update({
          state: "closed_unknown",
          detail: "stale open attempt - the charge died mid-flight; verify at the gateway by orderid",
          closed_at: new Date().toISOString(),
        })
        .eq("id", staleOpen[0].id).eq("state", "open");
      return {
        ok: false,
        error:
          "A previous payment on this order did not finish and could not be confirmed. To avoid a double charge, contact your builder before trying again.",
        blocking: true,
        status: 409,
      };
    }
    return {
      ok: false,
      error: "Another payment on this order is already going through. Give it a moment, then refresh.",
      blocking: false,
      status: 409,
    };
  }

  // 3. Insert 'open'. This write IS the concurrency guard — the partial unique index on
  //    (client_id, order_id) where state='open' means a simultaneous second request stops
  //    HERE, before any money moves. Two tabs, a double-tap, or a customer paying while a
  //    rep charges the same balance all land on this.
  const orderRef = mintOrderRef();
  const { data: attempt, error: attErr } = await admin.from("payment_attempts")
    .insert({
      client_id: clientId,
      order_id: orderId,
      short_code: opts.shortCode ?? null,
      amount_cents: amountCents,
      rail,
      merchid: opts.merchid,
      orderid: orderRef,
      actor_kind: opts.actorKind,
      actor_ref: opts.actorRef ?? null,
    })
    .select("id").maybeSingle();
  if (attErr || !attempt) {
    return {
      ok: false,
      error: "Another payment on this order is already going through. Give it a moment, then refresh.",
      blocking: false,
      status: 409,
    };
  }

  // Closing the ledger must never become a second failure — it swallows its own errors,
  // exactly as walletTopup's does.
  const closeAttempt = (
    state: string,
    detail: string | null,
    extra: Record<string, unknown> = {},
  ) =>
    admin.from("payment_attempts")
      .update({ state, detail, closed_at: new Date().toISOString(), ...extra })
      .eq("id", attempt.id).then(() => undefined, () => undefined);

  const logFault = (code: string, message: string) =>
    admin.from("app_errors").insert({
      source: "edge:invoice-payment",
      severity: "error",
      code,
      message,
      client_id: clientId,
    }).then(() => undefined, () => undefined);

  // 4. The sale.
  let auth;
  try {
    auth = await cpAuth({
      merchid: opts.merchid,
      amountCents,
      account: opts.account,
      expiry: opts.expiry,
      orderid: orderRef,
      postal: opts.postal,
      name: opts.name,
      ecomind: opts.ecomind ?? "E",
      rail,
    });
  } catch (se) {
    const msg = String((se as Error).message ?? "");

    if (isGatewayUnknown(se)) {
      // The card MAY have been charged and we cannot know. Do not record, do not retry.
      // The orderid on the attempt row is what resolves this later without a phone call.
      await closeAttempt("closed_unknown", `charge outcome unverifiable: ${msg}`);
      await logFault(
        "payment_charge_unknown",
        `${clientId}: ${amountCents} cent ${rail} charge on order ${orderId} is UNVERIFIABLE. ` +
          `Resolve with /inquireByOrderid orderid=${orderRef} merchid=${opts.merchid} before allowing another attempt. ${msg}`,
      );
      return {
        ok: false,
        error:
          "We could not confirm whether your payment went through. Do NOT try again — contact your builder and we will confirm it.",
        blocking: true,
        status: 409,
      };
    }

    if (isGatewayThrottled(se)) {
      // KNOWN not charged: the documented limiter rejects rather than queues.
      await closeAttempt("closed_declined", `rate limited: ${msg}`);
      const secs = throttledRetryAfter(se);
      return {
        ok: false,
        error: secs
          ? `The payment system is busy. Try again in about ${secs} seconds.`
          : "The payment system is busy. Try again in a moment.",
        blocking: false,
        status: 429,
      };
    }

    if (isGatewayConfig(se)) {
      // Our problem, not the customer's card. Never rendered as a decline.
      await closeAttempt("closed_declined", `gateway configuration: ${msg}`);
      await logFault("payment_gateway_config", `${clientId}: CardPointe rejected our request — ${msg}`);
      return {
        ok: false,
        error: "Payments aren't available right now. Your builder has been notified.",
        blocking: false,
        status: 503,
      };
    }

    // A plain decline: the gateway answered, nothing was charged. Safe to say so, and the
    // reason is the one thing the customer can act on. Capped and stripped — it is still
    // third-party text.
    await closeAttempt("closed_declined", msg);
    const clean = msg.replace(/[ -]/g, " ").trim().slice(0, 200);
    return { ok: false, error: clean || "The payment was declined.", blocking: false, status: 402 };
  }

  // 4e. PARTIAL APPROVAL. Neither an approval nor a decline: it takes some of the money
  //     without satisfying the ask, and this product has no split-tender model. Stamp the
  //     retref FIRST so the void has a durable subject even if what follows fails, then
  //     release the hold. There is never a payments row for a partial.
  if (auth.kind === "partial") {
    await admin.from("payment_attempts")
      .update({ retref: auth.retref, respstat: "A", detail: "partial approval - voiding" })
      .eq("id", attempt.id).then(() => undefined, () => undefined);
    let voided = false;
    try {
      voided = await cpVoid(opts.merchid, auth.retref);
    } catch {
      voided = false;
    }
    if (voided) {
      await closeAttempt("closed_declined", `partial approval voided (approved ${auth.approvedCents} of ${auth.requestedCents})`, {
        retref: auth.retref,
      });
      return {
        ok: false,
        error:
          `Your card only approved $${(auth.approvedCents / 100).toFixed(2)} of $${(auth.requestedCents / 100).toFixed(2)}. ` +
          "That hold has been released — nothing was taken. Try another card.",
        blocking: false,
        status: 402,
      };
    }
    await closeAttempt("closed_unknown", `partial approval and the void FAILED (retref ${auth.retref})`, {
      retref: auth.retref,
    });
    await logFault(
      "payment_partial_void_failed",
      `${clientId}: partial approval ${auth.approvedCents} of ${auth.requestedCents} on order ${orderId}, retref ${auth.retref}, and the void failed. Release it by hand at the gateway.`,
    );
    return {
      ok: false,
      error:
        "Your card only approved part of the amount and we could not release the hold. Do NOT try again — contact your builder.",
      blocking: true,
      status: 409,
    };
  }

  // 5. Record it. ACH is money three days from now, so it lands `pending` and counts toward
  //    nothing until the reconcile sweep says otherwise.
  const fundingState: "settled" | "pending" = rail === "ach" ? "pending" : "settled";
  const nowIso = new Date().toISOString();
  const row = {
    client_id: clientId,
    order_id: orderId,
    amount_cents: amountCents,
    method: rail,
    reference: auth.retref,
    received_at: nowIso,
    gateway: "cardpointe",
    gateway_txn_id: auth.retref,
    attempt_id: attempt.id,
    funding_state: fundingState,
    funding_updated_at: nowIso,
    gateway_authcode: auth.authcode,
    instrument_brand: auth.brand ?? (rail === "ach" ? "ACH" : null),
    instrument_last4: auth.last4,
    entry_mode: auth.entrymode ?? (opts.ecomind === "R" ? "Retail" : "ECommerce"),
    avs_result: auth.avsresp,
    cvv_result: auth.cvvresp,
    surcharge_cents: auth.surchargeCents,
    created_by: opts.createdBy ?? null,
  };

  const { data: payment, error: payErr } = await admin.from("payments")
    .insert(row).select("id").maybeSingle();

  if (payErr || !payment) {
    const msg = String(payErr?.message ?? "insert returned no row");

    // payments_gateway_txn_uniq is UNIQUE on (client_id, gateway, gateway_txn_id). Hitting
    // it means this exact charge is ALREADY recorded — a replay, i.e. success. Read the row
    // that is there rather than double-recording.
    if (/duplicate key|unique constraint|23505/i.test(msg)) {
      const { data: existing } = await admin.from("payments")
        .select("id").eq("client_id", clientId).eq("gateway", "cardpointe")
        .eq("gateway_txn_id", auth.retref).maybeSingle();
      await closeAttempt("closed_ok", "payment already recorded (idempotent replay)", {
        retref: auth.retref,
        payment_id: existing?.id ?? null,
        respstat: "A",
      });
      const after = await readOrderMoney(admin, clientId, orderId);
      return {
        ok: true,
        paymentId: String(existing?.id ?? ""),
        retref: auth.retref,
        amountCents,
        surchargeCents: auth.surchargeCents,
        brand: auth.brand,
        last4: auth.last4,
        fundingState,
        balanceCents: after ? (after.owedCents ?? 0) - after.settledCents : 0,
        already: true,
      };
    }

    // MONEY MOVED, THE BALANCE DIDN'T. The worst state this function can reach.
    //
    // ⚠️ NO AUTOMATIC REVERSAL, and this DIFFERS from portal-billing's subscribe unwind on
    //    purpose. Subscribe voids because the thing the money bought — a subscription —
    //    does not exist. Here the thing the money bought is a paid-down balance, and it is
    //    real; only our bookkeeping broke. Reversing a good customer payment on a guess
    //    un-pays a real invoice. walletTopup.ts already made exactly this call.
    //
    //    This branch can also be reached by the payments_claim_inventory trigger (105)
    //    aborting the transaction, which has nothing to do with payments — the message says
    //    so, or triage chases a phantom database fault.
    await closeAttempt("closed_unknown", `charge ${auth.retref} succeeded but the payments insert failed: ${msg}`, {
      retref: auth.retref,
      respstat: "A",
    });
    await logFault(
      "payment_recorded_failed",
      `${clientId}: CARD CHARGED ${amountCents} cents (retref ${auth.retref}) on order ${orderId} but the payments row was NOT written: ${msg}. ` +
        `Record it by hand and close attempt ${attempt.id}. If this reads as a constraint error, check payments_claim_inventory / inventory_units before assuming a database fault. ` +
        `Gateway said: ${JSON.stringify(cpSummary(auth.raw))}`,
    );
    return {
      ok: false,
      error:
        "Your payment went through but our records didn't update. Your builder has been notified and will put it right — do NOT try again.",
      blocking: true,
      status: 500,
    };
  }

  // 6. Only now is the attempt closed OK: charged AND recorded.
  await closeAttempt("closed_ok", null, {
    retref: auth.retref,
    payment_id: payment.id,
    respstat: "A",
  });

  const after = await readOrderMoney(admin, clientId, orderId);
  return {
    ok: true,
    paymentId: String(payment.id),
    retref: auth.retref,
    amountCents,
    surchargeCents: auth.surchargeCents,
    brand: auth.brand,
    last4: auth.last4,
    fundingState,
    balanceCents: after ? (after.owedCents ?? 0) - after.settledCents : 0,
    already: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Resolving an unverifiable charge.
//
// This is what the durable `orderid` was for. It turns a closed_unknown from "phone CSM
// Synergy" — which is what the NMI path still means — into a question the gateway answers
// in seconds.
// ─────────────────────────────────────────────────────────────────────────────────────

export type ResolveResult =
  | { resolved: true; outcome: "charged"; retref: string; paymentId: string | null }
  | { resolved: true; outcome: "not_charged" }
  | { resolved: false; reason: string };

export async function resolveUnknownAttempt(
  admin: Admin,
  clientId: string,
  attemptId: number,
): Promise<ResolveResult> {
  const { data: att } = await admin.from("payment_attempts")
    .select("id, order_id, short_code, amount_cents, rail, merchid, orderid, state, retref")
    .eq("client_id", clientId).eq("id", attemptId).maybeSingle();
  if (!att) return { resolved: false, reason: "not_found" };
  if (att.state !== "closed_unknown" && att.state !== "open") {
    return { resolved: false, reason: "already_closed" };
  }

  let found: Record<string, unknown> | null;
  try {
    found = await cpInquireByOrderId(att.merchid, att.orderid);
  } catch (e) {
    return { resolved: false, reason: isGatewayUnknown(e) ? "gateway_unreachable" : "inquire_failed" };
  }

  if (!found) {
    // The gateway has no record of that orderid, so nothing was ever charged. Safe to
    // unblock the order.
    await admin.from("payment_attempts")
      .update({
        state: "closed_declined",
        detail: "resolved by inquireByOrderid: the gateway has no record — nothing was charged",
        closed_at: new Date().toISOString(),
      })
      .eq("id", att.id).then(() => undefined, () => undefined);
    return { resolved: true, outcome: "not_charged" };
  }

  // It DID charge. Complete the choreography that was interrupted. The insert is idempotent
  // via payments_gateway_txn_uniq, so this is safe to run more than once.
  const retref = String(found.retref);
  const chargedCents = cpCents(found.amount) ?? Number(att.amount_cents);
  const surcharge = chargedCents > Number(att.amount_cents) ? chargedCents - Number(att.amount_cents) : null;
  const nowIso = new Date().toISOString();

  const { data: payment } = await admin.from("payments").insert({
    client_id: clientId,
    order_id: att.order_id,
    amount_cents: att.amount_cents,
    method: att.rail,
    reference: retref,
    received_at: nowIso,
    gateway: "cardpointe",
    gateway_txn_id: retref,
    attempt_id: att.id,
    funding_state: att.rail === "ach" ? "pending" : "settled",
    funding_updated_at: nowIso,
    surcharge_cents: surcharge,
    note: "recovered by reconciliation",
  }).select("id").maybeSingle();

  const { data: existing } = payment
    ? { data: payment }
    : await admin.from("payments").select("id")
      .eq("client_id", clientId).eq("gateway", "cardpointe").eq("gateway_txn_id", retref).maybeSingle();

  await admin.from("payment_attempts")
    .update({
      state: "closed_ok",
      retref,
      payment_id: existing?.id ?? null,
      detail: "resolved by inquireByOrderid: the charge DID go through and has been recorded",
      closed_at: nowIso,
    })
    .eq("id", att.id).then(() => undefined, () => undefined);

  return { resolved: true, outcome: "charged", retref, paymentId: existing?.id ?? null };
}
