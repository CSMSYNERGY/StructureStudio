// customer-pay: the shed shopper paying their builder's invoice from my-quotes.html.
//
// Separate from customer-accept for the reason customer-accept gives for being separate
// from customer-quotes: one narrow contract per capability. Signing and paying are
// different acts, with different failure modes and different evidence. A signature is
// recorded; a payment MOVES MONEY, and the states it can end in — including "we cannot
// tell whether your card was charged" — have no analogue in the signing flow.
//
// Public in practice: the anon key passes the gateway, so verify_jwt is NOT auth. The real
// gate is the customer_sessions token (checkSession), and on top of it the ownership
// compare — a payment only ever attaches to a design whose contact phone matches the
// session's OTP-verified phone.
//
// ⚠️ withErrorLog runs at minStatus 400 here, DELIBERATELY, against the customer-function
//    default of 500. On a money path every refusal deserves a durable row: the 409 that
//    says "we could not confirm whether your card was charged" is exactly what support has
//    to be able to find. Migration 141's severity split already files 4xx as `info`, so
//    the fault queue stays clean while the money trail does not.
//
// ORDER OF WRITES lives in _shared/invoicePayment.ts. This file is the gate ladder and the
// projection; it decides WHO may pay and HOW MUCH, and never how the charge is made.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, SS_REFUSAL_HEADER, withErrorLog } from "../_shared/logError.ts";
import { checkSession } from "../_shared/customerSession.ts";
import { phoneKey } from "../_shared/phoneKey.ts";
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
  cpSurchargeProbe,
  cpTokenizerHeight,
  cpTokenizerOrigin,
  cpTokenizerUrl,
} from "../_shared/cardpointe.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
/**
 * ⚠️ THE SEVERITY SPLIT, and it needs saying because this function logs at minStatus 400
 * while every other customer function logs at 500.
 *
 * Dropping to 400 is what puts the money trail in app_errors — a declined card and a
 * "we could not confirm whether you were charged" are exactly what support has to be able
 * to find. But it also means an expired session and a typo'd action land there too, and
 * left as faults they would bury the handful of rows that actually need a human.
 *
 * So a 4xx from here files as `info` by DEFAULT — it is the product correctly declining —
 * and the money-critical exceptions declare themselves with `fault: true` at the return
 * site. That is the direction migration 141's split cares about: a real fault must never
 * be silently demoted, and `fault` is only ever passed explicitly.
 */
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

/** A deliberate refusal that has to answer with a 5xx — a tenant who has not switched
 *  payments on is the product declining, not something broken. */
const refusal = (b: unknown, s = 503) => {
  const r = json(b, s);
  r.headers.set(SS_REFUSAL_HEADER, "1");
  r.headers.set("Access-Control-Expose-Headers", SS_REFUSAL_HEADER);
  return r;
};

// deno-lint-ignore no-explicit-any
function dbFail(req: Request, clientId: string | null, where: string, err: any) {
  logEdgeError({
    fn: "customer-pay",
    req,
    clientId,
    code: err?.code ?? 500,
    message: `${where}: ${err?.message ?? "unknown database error"}`,
    context: { where, pgCode: err?.code ?? null, details: err?.details ?? null, hint: err?.hint ?? null },
  }).catch(() => {});
  return json({ error: "Something went wrong on our side. Please try again in a moment." }, 500);
}

/** How many declines on one order in an hour before we stop answering.
 *  WITHOUT THIS, a leaked session token turns the builder's merchant account into a
 *  card-validity oracle: fire tokens at it and read which ones approve. The NMI path has
 *  no equivalent and should get one. */
const MAX_DECLINES_PER_HOUR = 5;

type Ctx = {
  clientId: string;
  shortCode: string;
  orderId: string;
  merchid: string;
  design: Record<string, unknown>;
};

/**
 * The gate ladder, run before ANY money question is asked. Returns a Response on refusal.
 *
 * Order matters: cheap and non-disclosing checks first, and "not found" and "not yours"
 * share one sentence so this endpoint never confirms that someone else's quote exists.
 */
// deno-lint-ignore no-explicit-any
async function gate(req: Request, admin: any, identity: any, body: any): Promise<Ctx | Response> {
  if (!cardpointeConfigured) {
    return refusal({ error: "Online payments aren't switched on yet." });
  }

  const code = typeof body?.quoteRef === "string" ? body.quoteRef.trim() : "";
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(code)) return json({ error: "Invalid quote reference." }, 400);

  const { data: settings, error: sErr } = await admin.from("client_settings")
    .select("invoice_in_ghl, payments_online_enabled, cardpointe_merchid, business_name")
    .eq("client_id", identity.clientId).maybeSingle();
  if (sErr) return dbFail(req, identity.clientId, "check your builder's settings", sErr);

  if (!settings || settings.invoice_in_ghl !== false) {
    return json(
      { error: "This builder handles invoicing through their own system — use the link in your email." },
      409,
    );
  }
  if (settings.payments_online_enabled !== true) {
    return refusal({ error: "Your builder hasn't switched on online payments yet." }, 503);
  }
  const merchid = String(settings.cardpointe_merchid || CP_DEFAULT_MERCHID || "").trim();
  if (!merchid) {
    return refusal({ error: "Your builder hasn't finished setting up payments yet." }, 503);
  }

  const { data: d, error: dErr } = await admin.from("designs")
    .select("short_code, status, contact, ss_quote_number, estimate_lines")
    .eq("client_id", identity.clientId).eq("short_code", code).maybeSingle();
  if (dErr) return dbFail(req, identity.clientId, "load your invoice", dErr);

  // ONE sentence for "no such design" and "not your design". Never a 403 — a different
  // status here would confirm that somebody else's quote exists.
  const notYours = json({ error: "That invoice wasn't found on your account." }, 404);
  if (!d) return notYours;
  const dPhone = phoneKey((d.contact as Record<string, unknown> | null)?.phone);
  if (!dPhone || dPhone !== phoneKey(identity.phoneDigits)) return notYours;

  const { data: inv, error: iErr } = await admin.from("invoice_sends")
    .select("invoice_number, status, issued_by, signed_at, updated_at, deposit_cents")
    .eq("client_id", identity.clientId).eq("short_code", code).maybeSingle();
  if (iErr) return dbFail(req, identity.clientId, "load your invoice", iErr);
  if (!inv || inv.issued_by !== "structurestudio" || !["created", "sent"].includes(String(inv.status))) {
    return json({ error: "Your invoice isn't ready yet — your builder still has to send it." }, 409);
  }

  // PAYMENT FOLLOWS THE SIGNATURE. Migration 136 made the invoice signature the
  // commitment; taking money against an uncommitted document inverts that ladder. A
  // deposit fits inside this rule rather than around it — the builder names the deposit,
  // the customer signs, then pays it.
  if (!inv.signed_at && !["invoiced", "delivered"].includes(String(d.status))) {
    return json({ error: "Please sign the invoice first — the pay button appears once you have." }, 409);
  }

  const { data: cos } = await admin.from("change_orders")
    .select("status, acknowledged_at")
    .eq("client_id", identity.clientId).eq("short_code", code);
  for (const c of cos ?? []) {
    if (c.status === "pending_ack") {
      return json({ error: "There's a change to approve before you can pay — check the change order above." }, 409);
    }
  }
  const invoiceAt = Date.parse(String(inv.updated_at || "")) || 0;
  const stale = (cos ?? []).some((c: Record<string, unknown>) =>
    c.status === "acknowledged" && (Date.parse(String(c.acknowledged_at || "")) || 0) > invoiceAt
  );
  if (stale) {
    return json(
      { error: "This invoice was issued before your latest approved change — ask your builder to resend it." },
      409,
    );
  }

  const { data: order, error: oErr } = await admin.from("orders")
    .select("id").eq("client_id", identity.clientId).eq("short_code", code).maybeSingle();
  if (oErr) return dbFail(req, identity.clientId, "load your order", oErr);
  if (!order) return json({ error: "Your builder hasn't opened this order yet." }, 409);

  return {
    clientId: identity.clientId,
    shortCode: code,
    orderId: String(order.id),
    merchid,
    design: d as Record<string, unknown>,
  };
}

Deno.serve(withErrorLog("customer-pay", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const action = typeof body?.action === "string" ? body.action : "";
  // Dispatch BEFORE auth, the customer-quotes convention: an unknown action costs no
  // session lookup.
  if (action !== "pay_options" && action !== "surcharge_probe" && action !== "pay" && action !== "status") {
    return json({ error: "Unknown action" }, 400);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const identity = await checkSession(admin, body?.token);
  if (!identity) return json({ error: "Session expired — sign in again." }, 401);

  const ctx = await gate(req, admin, identity, body);
  if (ctx instanceof Response) return ctx;

  const money = await readOrderMoney(admin, ctx.clientId, ctx.orderId);
  if (!money) return json({ error: "Your builder hasn't opened this order yet." }, 409);
  const decision = paymentAmountDecision(money);

  // ── pay_options ───────────────────────────────────────────────────────────────────
  // Everything the page needs to render the pay panel, INCLUDING the tokenizer URLs.
  // Those are composed server-side because this repo is public and because it puts the
  // isv-uat/production switch in a secret rather than in a file a customer downloads.
  if (action === "pay_options") {
    return json({
      ok: true,
      canPay: decision.ok,
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
        // Served, not hardcoded in the page: at 132px the CVV sat below the fold of a
        // non-scrolling frame and the form was quietly uncompletable.
        cardHeight: cpTokenizerHeight("card"),
        achHeight: cpTokenizerHeight("ach"),
      },
    });
  }

  // ── surcharge_probe ───────────────────────────────────────────────────────────────
  // Carolyn wants the card fee on the invoice BEFORE the charge, and it cannot be known
  // until the CARD is known — the card brands forbid surcharging debit, so the same order
  // is $3,650.00 on one card and $3,759.50 on another. Tokenize, probe, show, then charge.
  //
  // Best-effort by construction: a probe failure returns applies:null and the page falls
  // back to the standing "a card fee may apply" disclaimer. A fee we could not look up must
  // never block a payment.
  if (action === "surcharge_probe") {
    const probeToken = typeof body?.payToken === "string" ? body.payToken.trim() : "";
    if (!probeToken || probeToken.length > 256) {
      return json({ ok: true, applies: null, percent: null, feeCents: null });
    }
    const postal = typeof body?.postal === "string" ? body.postal.trim().slice(0, 12) : undefined;
    const probe = await cpSurchargeProbe(ctx.merchid, probeToken, postal);
    const feeCents = probe.applies && probe.percent && decision.ok
      ? Math.round(decision.askCents * (probe.percent / 100))
      : null;
    return json({
      ok: true,
      applies: probe.applies,
      percent: probe.percent,
      feeCents,
      // The figure that will actually hit the card, so the page never has to do this sum.
      chargeCents: decision.ok ? decision.askCents + (feeCents ?? 0) : null,
    });
  }

  // ── status ────────────────────────────────────────────────────────────────────────
  // Resolve an attempt whose response we never saw. This is what the durable orderid was
  // minted for: it turns "we could not confirm whether your card was charged" from a phone
  // call into a question the gateway answers in seconds.
  if (action === "status") {
    const { data: att } = await admin.from("payment_attempts")
      .select("id, state, created_at")
      .eq("client_id", ctx.clientId).eq("order_id", ctx.orderId)
      .in("state", ["open", "closed_unknown"])
      .order("id", { ascending: false }).limit(1);
    if (!att || !att.length) {
      return json({ ok: true, pending: false, resolved: null, balanceCents: decision.balanceCents });
    }
    const r = await resolveUnknownAttempt(admin, ctx.clientId, Number(att[0].id));
    const after = await readOrderMoney(admin, ctx.clientId, ctx.orderId);
    return json({
      ok: true,
      pending: !r.resolved,
      resolved: r.resolved ? r.outcome : null,
      balanceCents: after ? (after.owedCents ?? 0) - after.settledCents : decision.balanceCents,
    });
  }

  // ── pay ───────────────────────────────────────────────────────────────────────────
  if (!decision.ok) {
    return json({ error: amountRefusalText(decision.reason), reason: decision.reason }, 409);
  }

  const rail: "card" | "ach" = body?.rail === "ach" ? "ach" : "card";
  const payToken = typeof body?.payToken === "string" ? body.payToken.trim() : "";
  if (!payToken || payToken.length > 256) {
    return json({ error: "We didn't get your payment details — try entering them again." }, 400);
  }

  // THE CONFIRM HANDSHAKE. The browser never supplies a price — but it must ECHO the one
  // it displayed, and a mismatch aborts with the fresh figure. That keeps three numbers
  // provably identical: what was on screen, what the token was minted against, and what is
  // charged. Strict equality is possible here (rather than the echo it degrades to on the
  // wallet path) precisely because there is exactly ONE payable amount at any moment.
  if (Number(body?.confirmChargeCents) !== decision.askCents) {
    return json({
      error: `The amount due has changed to $${(decision.askCents / 100).toFixed(2)}. Check it and try again.`,
      askCents: decision.askCents,
      balanceCents: decision.balanceCents,
    }, 400);
  }

  // Decline throttle. Counted on the ORDER, over an hour.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: declines } = await admin.from("payment_attempts")
    .select("id", { count: "exact", head: true })
    .eq("client_id", ctx.clientId).eq("order_id", ctx.orderId)
    .eq("state", "closed_declined").gt("created_at", since);
  if ((declines ?? 0) >= MAX_DECLINES_PER_HOUR) {
    return json(
      { error: "That's several declined attempts in a row. Give it an hour, or call your builder." },
      429,
    );
  }

  const contact = (ctx.design.contact ?? {}) as Record<string, unknown>;
  const result = await chargeInvoicePayment(admin, {
    clientId: ctx.clientId,
    merchid: ctx.merchid,
    orderId: ctx.orderId,
    shortCode: ctx.shortCode,
    amountCents: decision.askCents,
    rail,
    account: payToken,
    expiry: typeof body?.expiry === "string" ? body.expiry.trim().slice(0, 8) : undefined,
    postal: typeof body?.postal === "string" ? body.postal.trim().slice(0, 12) : undefined,
    name: typeof contact.name === "string" ? contact.name.slice(0, 60) : undefined,
    ecomind: "E",
    actorKind: "customer",
    actorRef: identity.phoneDigits,
  });

  if (!result.ok) {
    // `blocking` IS the fault flag, and the mapping is exact: blocking means the outcome
    // could not be verified and a human must reconcile it before anyone tries again. A
    // plain decline is not that, and must not be filed as though it were.
    return json({ error: result.error, blocking: result.blocking }, result.status, result.blocking);
  }

  return json({
    ok: true,
    already: result.already,
    amountCents: result.amountCents,
    surchargeCents: result.surchargeCents,
    brand: result.brand,
    last4: result.last4,
    pending: result.fundingState === "pending",
    balanceCents: result.balanceCents,
  });
}, { minStatus: 400 }));
