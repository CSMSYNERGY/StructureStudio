// portal-payments: the builder taking money in the Orders tab.
//
// This is the SERVER half of the "Record a payment" modal. That modal already records money
// collected elsewhere — cash, a cheque, a card run on someone else's terminal — by inserting
// straight into `payments` under RLS, and it keeps doing exactly that. What lands here is
// the other half: actually CHARGING a card or a bank account, which cannot be a browser
// insert for two independent reasons.
//
//   1. RLS forbids it. `payments_owner_insert` carries
//      `WITH CHECK (client_id = current_client_id() AND gateway IS NULL)`, so an
//      authenticated team member cannot write a row claiming settled gateway funds, and
//      `payments_owner_update` blocks editing or voiding one. That is the database saying
//      the same thing this function exists to enforce.
//   2. Charging has an outcome the browser cannot be trusted to record: "we do not know
//      whether that card was charged" has to become a durable, blocking state.
//
// Its own function rather than another action on the 6,000-line portal-settings: a money
// path deserves its own GATES table and its own error contract.
//
// ⚠️ Add to SS_TENANT_SCOPED_FNS in portal/01-core.jsx or operator view-as will not inject
//    targetClientId, and every gate here will resolve against the wrong tenant.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, SS_REFUSAL_HEADER, withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import type { GateTable } from "../_shared/access.ts";
import {
  amountRefusalText,
  chargeInvoicePayment,
  MAX_PAYMENT_CENTS,
  MIN_PAYMENT_CENTS,
  paymentAmountDecision,
  readOrderMoney,
  resolveUnknownAttempt,
} from "../_shared/invoicePayment.ts";
import {
  cardpointeConfigured,
  CP_DEFAULT_MERCHID,
  cpRefund,
  cpSettleStat,
  cpSurchargeProbe,
  cpTokenizerHeight,
  cpTokenizerOrigin,
  cpTokenizerUrl,
  cpVoid,
} from "../_shared/cardpointe.ts";
import { fundingStateFromSetlstat, returnedPaymentPatch } from "../_shared/achState.ts";

// Every action needs a line here or resolveTenant refuses it at runtime AND the preflight
// GATES cross-check refuses the push. Taking money sits at orders:edit, matching
// send_invoice — the same people who can bill a customer can collect from them.
//
// ⚠️ Open with Carolyn: sales reps hold orders:'view', and a rep at a shed lot is exactly
//    the person who would swipe a card. If that changes, it wants its own area rather than
//    widening orders:edit — and a new area means editing _shared/access.ts AND its SQL
//    mirror (154) together.
const GATES: GateTable = {
  pay_options:      { area: "orders", level: "view" },
  surcharge_probe:  { area: "orders", level: "view" },
  charge:           { area: "orders", level: "edit" },
  charge_adhoc:     { area: "orders", level: "edit" },
  void_payment:     { area: "orders", level: "edit" },
  refund_payment:   { area: "orders", level: "edit" },
  reconcile:        { area: "orders", level: "view" },
};

/** Declined attempts one member may make in an hour before this function stops asking the
 *  gateway. customer-pay carries the same number on the shopper side; the difference is
 *  WHAT it is counted on. There the order is the natural key. Here it cannot be: a walk-in
 *  charge mints a brand new order on every call, so an order-scoped counter never reaches
 *  two and a loop of throwaway sales would read back card validity for free, on the
 *  builder's merchant account, one `orders` row at a time. Counting the ACTOR closes both
 *  the ad-hoc and the invoice path with one number.
 *
 *  Five is deliberately above realistic counter traffic: it counts DECLINES only, so three
 *  good walk-in payments in a row never approach it. */
const MAX_DECLINES_PER_HOUR = 5;

/** Said to a member, not a shopper — customer-pay's phrasing, aimed at the person holding
 *  the terminal rather than the person holding the card. */
const DECLINE_THROTTLE_TEXT =
  "That's several declined attempts in a row from this login. Give it an hour, or take the payment another way.";

/** settlestat is ONE call per DAY and never one per payment — the 40 TPM per-MID quota is
 *  shared with live charges, so a per-payment inquire loop would starve real money. This
 *  caps the days a single reconcile may spend; they are spent OLDEST FIRST, so the payment
 *  that has been stuck longest is always the one we ask about. */
const MAX_SETTLESTAT_DAYS = 5;

/** How long after funding a bank payment can still come back. Most NACHA codes return
 *  within two business days; R10 (unauthorised) has sixty. The wide window costs no extra
 *  gateway calls — only a wider SELECT — and the narrow one would mean a return arriving on
 *  day nine is never seen at all. */
const ACH_RETURN_WINDOW_DAYS = 60;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
/** Same severity split as customer-pay, and for the same reason: this function logs at
 *  minStatus 400 so the money trail is durable, which means a gate refusal and a declined
 *  card would otherwise sit in the fault queue beside the rows that need a human. A 4xx
 *  files as `info` by default; the money-critical exceptions pass `fault: true` at the
 *  return site, never inferred. */
const json = (b: unknown, s = 200, fault = false) => {
  const r = new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });
  // EXPOSED, or the browser cannot read it. A custom response header is invisible to
  // cross-origin JS unless it is named in Access-Control-Expose-Headers, and the portal
  // calls this function cross-origin. Without this line the mark is set, travels, and is
  // silently unreadable in the browser - so a deliberate 5xx refusal ("Taking cards is not
  // switched on for this account yet") kept filing as a FAULT in app_errors.
  if (s >= 400 && s < 500 && !fault) r.headers.set(SS_REFUSAL_HEADER, "1");
  if (r.headers.get(SS_REFUSAL_HEADER) === "1") r.headers.set("Access-Control-Expose-Headers", SS_REFUSAL_HEADER);
  return r;
};

const refusal = (b: unknown, s = 503) => {
  const r = json(b, s);
  r.headers.set(SS_REFUSAL_HEADER, "1");
  r.headers.set("Access-Control-Expose-Headers", SS_REFUSAL_HEADER);
  return r;
};

// deno-lint-ignore no-explicit-any
function dbFail(req: Request, clientId: string | null, where: string, err: any) {
  logEdgeError({
    fn: "portal-payments",
    req,
    clientId,
    code: err?.code ?? 500,
    message: `${where}: ${err?.message ?? "unknown database error"}`,
    context: { where, pgCode: err?.code ?? null, details: err?.details ?? null, hint: err?.hint ?? null },
  }).catch(() => {});
  return json({ error: `Something went wrong trying to ${where}. Please try again in a moment.` }, 500);
}

/**
 * How many of this member's charges the gateway has DECLINED on this tenant in the last
 * hour. Declines only — an approval, an unknown and a gateway-config refusal all leave the
 * counter where it was, because none of them is a probe reading back an answer.
 *
 * Deliberately NOT in _shared/invoicePayment.ts: _shared bundles per function, so putting
 * it there would either leave customer-pay carrying a second throttle beside its own or
 * force both functions to redeploy in lockstep on any change to either.
 */
async function recentDeclines(
  // deno-lint-ignore no-explicit-any
  admin: any,
  clientId: string,
  actorRef: string | null,
): Promise<number> {
  if (!actorRef) return 0;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await admin.from("payment_attempts")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("actor_kind", "staff")
    .eq("actor_ref", actorRef)
    .eq("state", "closed_declined")
    .gt("created_at", since);
  return Number(count ?? 0);
}

Deno.serve(withErrorLog("portal-payments", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Warm-up ───────────────────────────────────────────────────────────────────────
  // A table-free ping, the same shape as portal-schedule's, so the first real call does not
  // also pay a cold isolate boot (~2.5 s before the first query). Three properties are
  // deliberate and load-bearing:
  //   • it answers BEFORE any client, auth or tenant resolution, so it costs no round trip
  //     and cannot log a refusal — a ping firing on every boot must never fill app_errors;
  //   • it is a QUERY PARAM, not an action, so it needs no GATES entry (preflight
  //     cross-checks gates against action branches) and unknown-action handling is untouched;
  //   • it never reads the request BODY — the code below owns the single parse of that
  //     stream, and consuming it here would break every real call.
  // Booting the isolate IS the whole job; there is nothing to return but the acknowledgement.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const r = await resolveTenant(req, admin, {
    gates: GATES,
    readActions: new Set(["pay_options", "surcharge_probe", "reconcile"]),
    defaultAction: "pay_options",
  });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, payload, action, userId, audit, operator } = r.ctx;

  if (!cardpointeConfigured) {
    return refusal({ error: "Card payments aren't configured on this deployment yet." });
  }

  const { data: settings, error: sErr } = await admin.from("client_settings")
    .select("payments_online_enabled, cardpointe_merchid, business_name")
    .eq("client_id", clientId).maybeSingle();
  if (sErr) return dbFail(req, clientId, "read your payment settings", sErr);
  const merchid = String(settings?.cardpointe_merchid || CP_DEFAULT_MERCHID || "").trim();
  if (settings?.payments_online_enabled !== true || !merchid) {
    return refusal({ error: "Taking cards isn't switched on for this account yet." });
  }

  // ── pay_options ───────────────────────────────────────────────────────────────────
  if (action === "pay_options") {
    const orderId = String(payload?.orderId ?? "").trim();
    if (!orderId) return json({ error: "orderId is required." }, 400);
    const money = await readOrderMoney(admin, clientId, orderId);
    if (!money) return json({ error: "Order not found." }, 404);
    const decision = paymentAmountDecision(money);
    return json({
      ok: true,
      canCharge: decision.ok,
      reason: decision.ok ? null : decision.reason,
      message: decision.ok ? null : amountRefusalText(decision.reason),
      askCents: decision.ok ? decision.askCents : 0,
      askKind: decision.ok ? decision.kind : null,
      balanceCents: decision.balanceCents,
      settledCents: money.settledCents,
      pendingCents: money.pendingCents,
      depositCents: money.depositCents,
      minCents: MIN_PAYMENT_CENTS,
      maxCents: MAX_PAYMENT_CENTS,
      tokenizer: {
        origin: cpTokenizerOrigin(),
        cardUrl: cpTokenizerUrl("card"),
        achUrl: cpTokenizerUrl("ach"),
        // swipeonly is a SEPARATE url: the reader is a USB keyboard, and letting it share
        // the keyed-entry frame would mean a swipe could also be typed by hand.
        swipeUrl: cpTokenizerUrl("card") + "&swipeonly=true",
        cardHeight: cpTokenizerHeight("card"),
        achHeight: cpTokenizerHeight("ach"),
      },
    });
  }

  // ── surcharge_probe ───────────────────────────────────────────────────────────────
  if (action === "surcharge_probe") {
    const t = typeof payload?.payToken === "string" ? payload.payToken.trim() : "";
    if (!t || t.length > 256) return json({ ok: true, applies: null, percent: null });
    const probe = await cpSurchargeProbe(merchid, t, typeof payload?.postal === "string" ? payload.postal : undefined);
    return json({ ok: true, applies: probe.applies, percent: probe.percent });
  }

  // ── charge ────────────────────────────────────────────────────────────────────────
  // The card half of "Record a payment". Same shared choreography the customer path uses.
  if (action === "charge") {
    const orderId = String(payload?.orderId ?? "").trim();
    if (!orderId) return json({ error: "orderId is required." }, 400);

    // THE OPERATOR REFUSAL, carried over from portal-billing:593-600 unchanged in spirit.
    // A payment token is minted in the CARDHOLDER'S browser. In operator mode that browser
    // belongs to CSM Synergy staff, so an operator-supplied token means someone HERE typed
    // a shed shopper's card number. A builder's own staff are not `operator` — a rep taking
    // a card at their own lot is the legitimate case and stays allowed.
    if (operator) {
      return json({
        error: "An operator can't enter a customer's card. Ask the builder to take the payment themselves.",
      }, 403);
    }

    const money = await readOrderMoney(admin, clientId, orderId);
    if (!money) return json({ error: "Order not found." }, 404);
    const decision = paymentAmountDecision(money);
    if (!decision.ok) return json({ error: amountRefusalText(decision.reason), reason: decision.reason }, 409);

    if (Number(payload?.confirmChargeCents) !== decision.askCents) {
      return json({
        error: `The amount due is now $${(decision.askCents / 100).toFixed(2)}. Check it and try again.`,
        askCents: decision.askCents,
      }, 400);
    }

    const rail: "card" | "ach" = payload?.rail === "ach" ? "ach" : "card";
    const token = typeof payload?.payToken === "string" ? payload.payToken.trim() : "";
    if (!token || token.length > 4096) return json({ error: "No card details were captured." }, 400);
    // A swiped blob is far longer than a token; ecomind "R" is what tells the gateway (and
    // the interchange table) that the card was physically present.
    const swiped = payload?.entry === "swipe";

    await audit(`charge_${rail}`, null, `order=${orderId} cents=${decision.askCents}`).catch(() => {});

    // The audit above is deliberately ahead of this refusal: a throttled attempt is still
    // an attempt, and the trail has to show it was made as well as refused.
    if (await recentDeclines(admin, clientId, userId ?? null) >= MAX_DECLINES_PER_HOUR) {
      await audit("charge_throttled", null, `order=${orderId}`).catch(() => {});
      return json({ error: DECLINE_THROTTLE_TEXT }, 429);
    }

    // ⚠️ ACH REQUIRES AN ACCOUNT-HOLDER NAME. Without it the gateway declines with
    // "all name fields are empty" — a refusal that reads like a card problem and is really
    // an incomplete request from us. customer-pay always had this (it passes the contact off
    // the design); this path did not, so every bank payment taken by a builder failed while
    // the identical customer-side charge succeeded. Card does not need it, but sending it
    // improves AVS, so it goes on both rails.
    let payerName: string | undefined;
    if (money.shortCode) {
      const { data: dRow } = await admin.from("designs")
        .select("contact").eq("client_id", clientId).eq("short_code", money.shortCode).maybeSingle();
      const n = (dRow?.contact as Record<string, unknown> | null)?.name;
      if (typeof n === "string" && n.trim()) payerName = n.trim().slice(0, 60);
    }

    const result = await chargeInvoicePayment(admin, {
      clientId,
      merchid,
      orderId,
      shortCode: money.shortCode,
      amountCents: decision.askCents,
      rail,
      account: token,
      expiry: typeof payload?.expiry === "string" ? payload.expiry.trim().slice(0, 8) : undefined,
      postal: typeof payload?.postal === "string" ? payload.postal.trim().slice(0, 12) : undefined,
      name: payerName,
      ecomind: swiped ? "R" : "E",
      actorKind: "staff",
      actorRef: userId ?? null,
      createdBy: userId ?? null,
    });
    if (!result.ok) return json({ error: result.error, blocking: result.blocking }, result.status, result.blocking);
    return json(result);
  }

  // ── charge_adhoc ──────────────────────────────────────────────────────────────────
  // Carolyn's walk-in case: someone buys a couple of pieces of trim, with no quote and no
  // invoice behind it.
  //
  // ⚠️ It creates a real `orders` row rather than a dangling payment, because
  //    payments.order_id is NOT NULL on live and relaxing that would be the wrong fix
  //    anyway. A walk-in sale IS an order — giving it one keeps the Orders list, the
  //    balance arithmetic, refunds and the payments FK correct with no change to any of
  //    them. It is the one payment path with no signature gate, because there is no
  //    document to sign.
  if (action === "charge_adhoc") {
    if (operator) {
      return json({ error: "An operator can't enter a customer's card." }, 403);
    }
    const cents = Number(payload?.amountCents);
    if (!Number.isInteger(cents) || cents < MIN_PAYMENT_CENTS || cents > MAX_PAYMENT_CENTS) {
      return json({ error: "Enter an amount between $1 and $50,000." }, 400);
    }
    if (Number(payload?.confirmChargeCents) !== cents) {
      return json({ error: "Confirm the amount and try again." }, 400);
    }
    const token = typeof payload?.payToken === "string" ? payload.payToken.trim() : "";
    if (!token || token.length > 4096) return json({ error: "No card details were captured." }, 400);
    const rail: "card" | "ach" = payload?.rail === "ach" ? "ach" : "card";
    const note = typeof payload?.note === "string" ? payload.note.trim().slice(0, 200) : "";
    // A counter sale has no design to read a name off, so the operator supplies one. ACH
    // cannot proceed without it — refuse here with a sentence that says what to do, rather
    // than letting the gateway answer "all name fields are empty".
    const adhocName = typeof payload?.name === "string" ? payload.name.trim().slice(0, 60) : "";
    if (rail === "ach" && !adhocName) {
      return json({ error: "Enter the name on the bank account — a bank payment can't be taken without it." }, 400);
    }

    // BEFORE the orders insert, not after: a throttled probe must not leave an empty counter
    // sale behind it. The audit row is what records that the attempt was made.
    if (await recentDeclines(admin, clientId, userId ?? null) >= MAX_DECLINES_PER_HOUR) {
      await audit("charge_adhoc_throttled", null, `cents=${cents}`).catch(() => {});
      return json({ error: DECLINE_THROTTLE_TEXT }, 429);
    }

    const { data: order, error: oErr } = await admin.from("orders").insert({
      client_id: clientId,
      total_cents: cents,
      pretax_subtotal_cents: cents,
      total_source: "manual",
      ordered_at: new Date().toISOString(),
      notes: note || "Counter sale",
      submitter_user_id: userId ?? null,
    }).select("id").maybeSingle();
    if (oErr || !order) return dbFail(req, clientId, "open a counter sale", oErr);

    await audit("charge_adhoc", null, `order=${order.id} cents=${cents}`).catch(() => {});

    const result = await chargeInvoicePayment(admin, {
      clientId,
      merchid,
      orderId: String(order.id),
      shortCode: null,
      amountCents: cents,
      rail,
      account: token,
      expiry: typeof payload?.expiry === "string" ? payload.expiry.trim().slice(0, 8) : undefined,
      postal: typeof payload?.postal === "string" ? payload.postal.trim().slice(0, 12) : undefined,
      name: adhocName || undefined,
      ecomind: payload?.entry === "swipe" ? "R" : "E",
      actorKind: "staff",
      actorRef: userId ?? null,
      createdBy: userId ?? null,
    });
    if (!result.ok) {
      // The order exists but nothing was collected. Leave it — a zero-paid counter sale is
      // visible and closable, and deleting a row a trigger may already have touched is a
      // worse failure than an empty order.
      return json({ error: result.error, blocking: result.blocking, orderId: order.id }, result.status, result.blocking);
    }
    return json({ ...result, orderId: order.id });
  }

  // ── void_payment / refund_payment ────────────────────────────────────────────────
  // The portal's own void button writes voided_at directly, and RLS correctly refuses that
  // for a gateway row — the money is still at CardPointe. So voiding one has to come
  // through here, and the row is only marked voided IF THE GATEWAY AGREES.
  if (action === "void_payment" || action === "refund_payment") {
    const paymentId = String(payload?.paymentId ?? "").trim();
    if (!paymentId) return json({ error: "paymentId is required." }, 400);

    const { data: p, error: pErr } = await admin.from("payments")
      .select("id, order_id, amount_cents, note, gateway, gateway_txn_id, voided_at, funding_state")
      .eq("client_id", clientId).eq("id", paymentId).maybeSingle();
    if (pErr) return dbFail(req, clientId, "load that payment", pErr);
    if (!p) return json({ error: "Payment not found." }, 404);
    if (p.gateway !== "cardpointe" || !p.gateway_txn_id) {
      return json({ error: "That payment wasn't taken here — void it the usual way." }, 400);
    }
    if (p.voided_at) return json({ ok: true, already: true });

    await audit(`${action}`, null, `payment=${paymentId} retref=${p.gateway_txn_id}`).catch(() => {});

    if (action === "void_payment") {
      let ok = false;
      try {
        ok = await cpVoid(merchid, String(p.gateway_txn_id));
      } catch (e) {
        return json({
          error: "We couldn't reach the card network to cancel that payment. Nothing has changed — try again shortly.",
          detail: String((e as Error).message ?? "").slice(0, 160),
        }, 502);
      }
      if (!ok) {
        // Almost always "already settled". A refund is the honest next step, and the UI
        // switches to it rather than pretending the void worked.
        return json({ error: "That payment has already settled — refund it instead.", settled: true }, 409);
      }
      const nowIso = new Date().toISOString();
      const { error: uErr } = await admin.from("payments")
        .update({ voided_at: nowIso, void_reason: "voided at the card network", funding_updated_at: nowIso })
        .eq("client_id", clientId).eq("id", paymentId);
      if (uErr) return dbFail(req, clientId, "record that void", uErr);
      return json({ ok: true, voided: true });
    }

    // A refund is a NEW event, never a mutation: the original settled, and the books have to
    // show both. So the original row is left standing and a negative-amount row is written
    // beside it. `payments_amount_cents_check` forbids a negative amount, so the refund is
    // recorded as a voided-out original plus an explicit note — see below.
    const refundCents = Number(payload?.amountCents ?? p.amount_cents);
    if (!Number.isInteger(refundCents) || refundCents <= 0 || refundCents > Number(p.amount_cents)) {
      return json({ error: "Enter a refund amount up to the original payment." }, 400);
    }
    let out;
    try {
      out = await cpRefund(merchid, String(p.gateway_txn_id), refundCents);
    } catch (e) {
      return json({
        error: "We couldn't reach the card network to refund that payment. Nothing has changed — try again shortly.",
        detail: String((e as Error).message ?? "").slice(0, 160),
      }, 502);
    }
    if (!out.ok) return json({ error: "The card network refused that refund." }, 409);

    const nowIso = new Date().toISOString();
    const full = refundCents === Number(p.amount_cents);
    // A partial refund leaves the row live and refundable again, so the next one used to
    // OVERWRITE this note — and the retref it names is the only record of that refund
    // anywhere in the database (the audit line above carries the ORIGINAL txn's retref).
    // Append instead, newest last, capped so repeated refunds cannot grow the row forever.
    const refundLine = `Refunded $${(refundCents / 100).toFixed(2)} on ${nowIso.slice(0, 10)} (ref ${out.retref ?? "?"})`;
    const priorNote = typeof p.note === "string" ? p.note.trim() : "";
    const { error: uErr } = await admin.from("payments")
      .update({
        voided_at: full ? nowIso : null,
        void_reason: full ? `refunded $${(refundCents / 100).toFixed(2)}` : null,
        note: (priorNote ? `${priorNote}\n${refundLine}` : refundLine).slice(-2000),
        amount_cents: full ? Number(p.amount_cents) : Number(p.amount_cents) - refundCents,
        funding_updated_at: nowIso,
      })
      .eq("client_id", clientId).eq("id", paymentId);
    if (uErr) return dbFail(req, clientId, "record that refund", uErr);
    return json({ ok: true, refunded: refundCents, retref: out.retref });
  }

  // ── reconcile ─────────────────────────────────────────────────────────────────────
  // Two jobs in one action, because both are "go and ask the gateway what really happened":
  //   * resolve any attempt whose response we never saw (the closed_unknown recovery)
  //   * move pending ACH forward, or mark it returned, or bring back a late return
  //
  // ⚠️ THIS ACTION ONLY WORKS IF SOMETHING CALLS IT. There is no pg_cron on this project, so
  //    nothing self-heals on a schedule: bank money stays `pending` and an unresolved attempt
  //    stays blocking until a caller asks. It is gated orders:'view' and sits in readActions
  //    precisely so the Orders tab can fire it on load — fire-and-forget, never awaited in
  //    the paint path, then re-read the money — and so an explicit Refresh can too.
  if (action === "reconcile") {
    const orderId = String(payload?.orderId ?? "").trim();
    const resolved: unknown[] = [];

    let q = admin.from("payment_attempts")
      .select("id, order_id, state").eq("client_id", clientId).eq("state", "closed_unknown");
    if (orderId) q = q.eq("order_id", orderId);
    const { data: unknowns } = await q.limit(10);
    for (const a of unknowns ?? []) {
      const out = await resolveUnknownAttempt(admin, clientId, Number(a.id));
      resolved.push({ attemptId: a.id, ...out });
    }

    // Pending bank payments. settlestat returns a whole batch in ONE call, which is the only
    // shape that survives the 40 TPM per-MID cap — a per-payment inquire loop would 429
    // itself into uselessness and starve real customer charges of the same quota.
    //
    // ORDERED, and the order is load-bearing. PostgREST returns rows in no defined order, so
    // an unordered slice of days could ask about today's batch on every sweep and never once
    // about the payment that has been stuck since last week. Oldest received first means the
    // oldest money is always inside the day budget.
    let pq = admin.from("payments")
      .select("id, order_id, gateway_txn_id, received_at")
      .eq("client_id", clientId).eq("gateway", "cardpointe")
      .eq("funding_state", "pending").is("voided_at", null)
      .order("received_at", { ascending: true });
    if (orderId) pq = pq.eq("order_id", orderId);
    const { data: pending } = await pq.limit(200);

    // Bank payments that already funded but are still inside the return window. Settled is
    // NOT final for ACH: a debit can be sent back days later, and without this pass the only
    // record of that is a bank statement nobody reads.
    //
    // ⚠️ Narrow on purpose — cardpointe AND the ach rail. `funding_state` defaults to
    //    'settled' for every pre-174 cash and cheque row, so a broader sweep here would put
    //    historical hand-recorded payments at the mercy of a gateway batch that has never
    //    heard of them.
    const returnSince = new Date(Date.now() - ACH_RETURN_WINDOW_DAYS * 86400000).toISOString();
    let rq = admin.from("payments")
      .select("id, order_id, gateway_txn_id, received_at")
      .eq("client_id", clientId).eq("gateway", "cardpointe").eq("method", "ach")
      .eq("funding_state", "settled").is("voided_at", null)
      .gt("funding_updated_at", returnSince)
      .order("funding_updated_at", { ascending: false });
    if (orderId) rq = rq.eq("order_id", orderId);
    const { data: settledAch } = await rq.limit(200);

    const nowIso = new Date().toISOString();
    const updated: unknown[] = [];
    const byRetref = new Map<string, string>();
    const fetchedDays = new Set<string>();
    const skippedDays = new Set<string>();
    const dayOf = (v: unknown) => String(v ?? "").slice(0, 10).replace(/-/g, "");

    /** Spend day-sized pieces of the per-MID budget, in the order given, never twice on the
     *  same day, and never past MAX_SETTLESTAT_DAYS. */
    const loadDays = async (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const d = dayOf(row.received_at);
        if (!d || fetchedDays.has(d) || skippedDays.has(d)) continue;
        if (fetchedDays.size >= MAX_SETTLESTAT_DAYS) { skippedDays.add(d); continue; }
        fetchedDays.add(d);
        try {
          const batch = await cpSettleStat(merchid, d) as Record<string, unknown>;
          const rs = (batch?.txns ?? batch?.transactions ?? []) as Record<string, unknown>[];
          for (const t of Array.isArray(rs) ? rs : []) {
            const rr = String(t.retref ?? "");
            if (rr) byRetref.set(rr, String(t.setlstat ?? t.status ?? ""));
          }
        } catch { /* one bad day must not stop the rest */ }
      }
    };

    const noteReturned = (paymentId: unknown, orderRef: unknown, retref: string) => {
      logEdgeError({
        fn: "portal-payments",
        req,
        clientId,
        code: "ach_returned",
        message:
          `${clientId}: bank payment ${retref} on order ${orderRef} was RETURNED — the balance has been reopened and the builder needs to chase it.`,
        context: { paymentId, retref },
      }).catch(() => {});
    };

    if (pending && pending.length) {
      await loadDays(pending as Record<string, unknown>[]);
      for (const p of pending) {
        const rr = String(p.gateway_txn_id ?? "");
        const next = fundingStateFromSetlstat(byRetref.get(rr));
        // null means "we do not recognise that status" — LEAVE IT PENDING. Never guess a
        // bank payment into being money.
        if (!next || next === "pending") continue;
        const patch = next === "returned"
          ? returnedPaymentPatch(byRetref.get(rr), nowIso)
          : { funding_state: "settled", funding_updated_at: nowIso };
        await admin.from("payments").update(patch).eq("client_id", clientId).eq("id", p.id);
        updated.push({ paymentId: p.id, to: next });
        if (next === "returned") noteReturned(p.id, p.order_id, rr);
      }
    }

    // ── late bank returns ────────────────────────────────────────────────────────────
    // The ONLY transition allowed out of settled is 'returned', and only when the gateway
    // says so in as many words. An unrecognised status, a blank one, or a retref that is not
    // in any batch we managed to read all mean the same thing they mean above: leave it
    // alone. Un-paying an invoice on a guess is worse than a late return going unseen.
    //
    // ⚠️ Voiding a returned payment does NOT release the inventory unit (migration 105). A
    //    transfer sent back is a collections problem, not an un-sale.
    if (settledAch && settledAch.length) {
      await loadDays(settledAch as Record<string, unknown>[]);
      for (const p of settledAch) {
        const rr = String(p.gateway_txn_id ?? "");
        const raw = byRetref.get(rr);
        if (raw === undefined) continue;
        if (fundingStateFromSetlstat(raw) !== "returned") continue;
        // The funding_state/voided_at predicates are repeated on the UPDATE so a row someone
        // voided or refunded between the SELECT and here is left alone, and `.select` is what
        // tells us whether a row actually moved — a zero-row update is not an error.
        const { data: hit, error: rErr } = await admin.from("payments")
          .update(returnedPaymentPatch(raw, nowIso))
          .eq("client_id", clientId).eq("id", p.id)
          .eq("funding_state", "settled").is("voided_at", null)
          .select("id");
        if (rErr || !hit || !hit.length) continue;
        updated.push({ paymentId: p.id, to: "returned" });
        noteReturned(p.id, p.order_id, rr);
      }
    }

    // daysChecked/daysSkipped are additive: they say whether the budget covered everything
    // pending, which is the difference between "nothing has changed" and "we did not look".
    return json({
      ok: true,
      resolved,
      updated,
      daysChecked: [...fetchedDays],
      daysSkipped: skippedDays.size,
    });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
}, { minStatus: 400 }));
