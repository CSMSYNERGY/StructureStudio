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
  if (s >= 400 && s < 500 && !fault) r.headers.set(SS_REFUSAL_HEADER, "1");
  return r;
};

const refusal = (b: unknown, s = 503) => {
  const r = json(b, s);
  r.headers.set(SS_REFUSAL_HEADER, "1");
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

Deno.serve(withErrorLog("portal-payments", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

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
      .select("id, order_id, amount_cents, gateway, gateway_txn_id, voided_at, funding_state")
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
    const { error: uErr } = await admin.from("payments")
      .update({
        voided_at: full ? nowIso : null,
        void_reason: full ? `refunded $${(refundCents / 100).toFixed(2)}` : null,
        note: `Refunded $${(refundCents / 100).toFixed(2)} on ${nowIso.slice(0, 10)} (ref ${out.retref ?? "?"})`,
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
  //   * move pending ACH forward, or mark it returned
  //
  // Called when the Orders tab loads and from an explicit Refresh. There is no pg_cron on
  // this project, so nothing self-heals on a schedule — this is the safety net, and the
  // GitHub Actions sweep calls the same code path.
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
    let pq = admin.from("payments")
      .select("id, order_id, gateway_txn_id, received_at")
      .eq("client_id", clientId).eq("gateway", "cardpointe")
      .eq("funding_state", "pending").is("voided_at", null);
    if (orderId) pq = pq.eq("order_id", orderId);
    const { data: pending } = await pq.limit(200);

    const updated: unknown[] = [];
    if (pending && pending.length) {
      const days = [...new Set(pending.map((p: Record<string, unknown>) => String(p.received_at ?? "").slice(0, 10).replace(/-/g, "")))]
        .filter(Boolean).slice(0, 5);
      const byRetref = new Map<string, string>();
      for (const d of days) {
        try {
          const batch = await cpSettleStat(merchid, d) as Record<string, unknown>;
          const rows = (batch?.txns ?? batch?.transactions ?? []) as Record<string, unknown>[];
          for (const t of Array.isArray(rows) ? rows : []) {
            const rr = String(t.retref ?? "");
            if (rr) byRetref.set(rr, String(t.setlstat ?? t.status ?? ""));
          }
        } catch { /* one bad day must not stop the rest */ }
      }
      const nowIso = new Date().toISOString();
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
        if (next === "returned") {
          logEdgeError({
            fn: "portal-payments",
            req,
            clientId,
            code: "ach_returned",
            message:
              `${clientId}: bank payment ${rr} on order ${p.order_id} was RETURNED — the balance has been reopened and the builder needs to chase it.`,
            context: { paymentId: p.id, retref: rr },
          }).catch(() => {});
        }
      }
    }

    return json({ ok: true, resolved, updated });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
}, { minStatus: 400 }));
