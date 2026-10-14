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
  billingFromRequest,
  chargeInvoicePayment,
  MAX_PAYMENT_CENTS,
  type MerchantOfRecord,
  merchantOfRecord,
  MIN_PAYMENT_CENTS,
  paymentAmountDecision,
  readOrderMoney,
  resolveUnknownAttempt,
} from "../_shared/invoicePayment.ts";
import {
  cardpointeConfigured,
  cpBillingFields,
  cpEnvLabel,
  cpFunding,
  cpRefund,
  cpSettleStat,
  cpSurchargeProbe,
  cpTokenizerHeight,
  cpTokenizerOrigin,
  cpTokenizerUrl,
  cpVoid,
  isGatewayConfig,
  isGatewayThrottled,
  isGatewayUnknown,
} from "../_shared/cardpointe.ts";
import { type CpMerchant, cpMerchant, readPaymentSettings, testModeNeedsExempt } from "../_shared/paymentSettings.ts";
import {
  achFundingRead,
  fundingAnswerShape,
  fundingStateFromSetlstat,
  returnedPaymentPatch,
  settlementStatuses,
} from "../_shared/achState.ts";
import { addressFrom } from "../_shared/contactAddress.ts";

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

/** settlestat is ONE call per merchant and DAY and never one per payment — the 40 TPM per-MID
 *  quota is shared with live charges, so a per-payment inquire loop would starve real money.
 *  This caps the (merchant, day) calls a single reconcile may spend; they are spent OLDEST
 *  FIRST, so the payment that has been stuck longest is always the one we ask about. */
const MAX_SETTLESTAT_DAYS = 5;

/** How long after funding a bank payment can still come back. Most NACHA codes return
 *  within two business days; R10 (unauthorised) has sixty. The wide window costs no extra
 *  gateway calls — only a wider SELECT — and the narrow one would mean a return arriving on
 *  day nine is never seen at all. */
const ACH_RETURN_WINDOW_DAYS = 60;

/** /funding calls one reconcile may spend, across every merchant and day. Fiserv (CardPointe
 *  integrations), 2026-10-14: a bank payment's fate (and its return: every UAT one comes back R03)
 *  shows in the FUNDING data, which settlestat does not carry. Like settlestat it is one call per
 *  merchant and day, and it shares the 40 TPM per-MID quota with live charges: with
 *  MAX_SETTLESTAT_DAYS and the 10 recovery inquires, one reconcile asks the gateway at most 23
 *  times. Each (merchant, day) is read ONCE: payments.funding_checked_through (migration 309)
 *  remembers how far each bank payment has been read, so a sweep starts where the last one stopped
 *  and a day already read is never asked for again. Spent on the days a payment still clearing
 *  needs before the days a settled one needs, and each payment's oldest unread day first. */
const MAX_FUNDING_CALLS = 8;

/** A funding day is read once it is over: through the day before yesterday (UTC). By then the
 *  US day it names ended over 40 hours ago, so a day still filling up is never read and then
 *  remembered as done. The cost is that a bank payment reads as funded two or three days after the
 *  money moved, not on the day. */
const FUNDING_DAY_READABLE_AFTER_MS = 2 * 86400000;

/** How long a bank payment nobody has heard back about is held as clearing. The portal tells the
 *  customer 2-3 business days, and most NACHA returns land within two banking days of settlement;
 *  seven calendar days covers five banking days across any weekend. After it:
 *    * settlestat's "Accepted" may move it to settled (before it, only the funding data may: a
 *      debit the processor has accepted can still come back R03 before it funds), and
 *    * refund_payment no longer refuses it as clearing, so an order whose bank payment no reader
 *      ever moves (an answer we cannot read) is never frozen for good.
 *  A return after that is still caught (the funding pass reads settled bank payments for
 *  ACH_RETURN_WINDOW_DAYS) but a refund already sent is money the builder has to chase. */
const ACH_CLEARED_AFTER_DAYS = 7;

/** A pending bank payment cannot be refunded while it is clearing (ACH_CLEARED_AFTER_DAYS):
 *  refunding a debit that has not funded pays the customer back money that may never arrive, and if
 *  the debit is then returned, reconcile skips the voided row and nobody sees it. A same-day void is
 *  still allowed (void_payment). */
const ACH_PENDING_REFUND_TEXT = "This bank payment is still clearing. It can be refunded once it clears.";

/** Whether a bank payment is still inside its clearing hold: pending, and either younger than
 *  ACH_CLEARED_AFTER_DAYS or of an age we cannot read (held, never let through on a guess). */
function achClearing(p: { method?: unknown; funding_state?: unknown; received_at?: unknown }, nowMs = Date.now()): boolean {
  if (p.method !== "ach" || p.funding_state !== "pending") return false;
  const age = nowMs - Date.parse(String(p.received_at ?? ""));
  return !(age >= ACH_CLEARED_AFTER_DAYS * 86400000);
}

/** A failed charge as the modal reads it: the sentence, whether a human must look first, and
 *  `newCardNeeded: true` ONLY when invoicePayment set it, i.e. the attempt reached /auth and did not
 *  stand as a payment (a decline, a voided partial). The token's CVV is spent, so the modal asks for
 *  the card again. A refusal before /auth, and every blocking failure, never carries it. */
function failureBody(r: { error: string; blocking: boolean; newCardNeeded?: true }) {
  return { error: r.error, blocking: r.blocking, ...(r.newCardNeeded ? { newCardNeeded: true } : {}) };
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // The browser keeps this preflight for 2 h (Chrome's cap) instead of 5 s — see portal-settings.
  "Access-Control-Max-Age": "86400",
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
    // closed_declined also holds the gateway's rate limiter and OUR configuration errors
    // (invoicePayment.ts closes both that way — "rate limited: …" / "gateway configuration: …")
    // because neither charged anything. Neither is the gateway answering about a CARD, so
    // neither may count, or five tries through a broken credential or a busy minute read as
    // "several declined attempts" and lock the login out for an hour.
    .not("detail", "like", "rate limited:%")
    .not("detail", "like", "gateway configuration:%")
    .gt("created_at", since);
  return Number(count ?? 0);
}

/**
 * Whether reconcile has already filed a row under `code` for this tenant in the last 24 hours that
 * names EVERY one of `values` in its context[`field`]. Reconcile runs on each Orders visit while a
 * bank payment is pending, and what it files (an orphan, a gateway call it could not read, a funding
 * shape it does not know) usually stays true until a human acts, so without this one problem filed
 * a row per visit, and info rows are never deleted. Something NEW (an orphan, a merchant, a class of
 * failure the earlier row did not name) is filed at once. Any read failure answers false: a
 * doubtful check files again rather than staying quiet. void_payment / refund_payment file their own
 * refusal every time, since a person pressed something.
 */
async function filedToday(
  // deno-lint-ignore no-explicit-any
  admin: any,
  clientId: string,
  code: string,
  field: string,
  values: string[],
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await admin.from("app_errors")
      .select("context")
      .eq("client_id", clientId)
      .eq("source", "edge:portal-payments")
      .eq("code", code)
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error || !Array.isArray(data)) return false;
    return data.some((row: Record<string, unknown>) => {
      const seen = (row?.context as Record<string, unknown> | null)?.[field];
      return Array.isArray(seen) && values.every((v) => seen.map(String).includes(v));
    });
  } catch {
    return false;
  }
}

/** The orphaned payments (no merchant of record) of filedToday: one row a day names them all. */
// deno-lint-ignore no-explicit-any
const orphansFiledToday = (admin: any, clientId: string, paymentIds: string[]) =>
  filedToday(admin, clientId, "payment_no_merchant_of_record", "paymentIds", paymentIds);

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
  const { clientId, payload, action, userId, audit, operator, canEdit } = r.ctx;

  // Neither system configured: this deployment takes no cards at all, so every action is refused
  // the way it always was. One system configured is enough to go on: which one a tenant needs is
  // decided per merchant below.
  if (!cardpointeConfigured("uat") && !cardpointeConfigured("prod")) {
    return refusal({ error: "Card payments aren't configured on this deployment yet." });
  }

  /** A merchant whose system this deployment has no credentials for: refused with nothing sent,
   *  and filed as a FAULT (the refusal itself files as info), because it means an operator switched
   *  a tenant to a system whose secrets are missing, or they were removed. set_payments refuses to
   *  create that state; this is the second line. */
  const systemMissing = async (merchant: CpMerchant, error: string) => {
    await logEdgeError({
      fn: "portal-payments",
      req,
      clientId,
      code: "payments_env_not_configured",
      message: `${clientId}: ${action} refused: the tenant's ${cpEnvLabel(merchant.env)} CardPointe system has no credentials on this deployment. Nothing was sent.`,
      context: { action, env: merchant.env },
    });
    return refusal({ error, reason: "env_not_configured" });
  };

  // ⚠️ THE SWITCH GUARDS TAKING MONEY, AND ONLY THAT (2026-10). `payments_online_enabled` and the
  // tenant's CURRENT merchant are for a new charge. Void, refund and reconcile act on money
  // already taken, on the account it was taken on (merchantOfRecord), so a tenant switched off, or
  // moved to a new MID, can still give a customer their money back and still see a bank payment
  // clear or come back. All seven actions used to sit behind this refusal and use this MID.
  //
  // The merchant is the tenant's OWN MID and system (paymentSettings.ts cpMerchant). There is no
  // deployment default any more: a tenant switched on with no MID is refused like one switched off.
  const TAKES_MONEY = new Set(["pay_options", "surcharge_probe", "charge", "charge_adhoc"]);
  let currentMerchant: CpMerchant = { merchid: "", env: "uat" };
  if (TAKES_MONEY.has(action)) {
    const { row: settings, error: sErr } = await readPaymentSettings(admin, clientId, ["business_name", "billing_exempt"]);
    if (sErr) return dbFail(req, clientId, "read your payment settings", sErr);
    const merchant = cpMerchant(settings);
    if (settings?.payments_online_enabled !== true || !merchant) {
      return refusal({ error: "Taking cards isn't switched on for this account yet." });
    }
    // ⛔ TEST MODE ON A BILLABLE ACCOUNT. The test system moves no real money, so a card "taken" there
    // pays nothing while the order reads paid. set_payments and set_billing both refuse to create this
    // state; this catches it however it arose (a row changed by hand). Refused with nothing sent, and
    // filed as a fault: it is ours to fix, by moving the builder to live or switching them off.
    if (testModeNeedsExempt(settings)) {
      await logEdgeError({
        fn: "portal-payments",
        req,
        clientId,
        code: "payments_test_mode_billable",
        message: `${clientId}: ${action} refused: the tenant takes cards on the test system (UAT) but is billable. Nothing was sent.`,
        context: { action, env: merchant.env },
      });
      return refusal({ error: "Taking cards isn't available for this account right now. Nothing was charged, and we've been told.", reason: "test_mode_billable" });
    }
    if (!cardpointeConfigured(merchant.env)) {
      return await systemMissing(merchant, "Taking cards isn't available for this account right now. Nothing was charged, and we've been told.");
    }
    currentMerchant = merchant;
  }

  // ── pay_options ───────────────────────────────────────────────────────────────────
  /**
   * The two refusals `customer-pay` has always made and this function never did
   * (customer-pay/index.ts:178-195). A rep's terminal must not be the way round a refusal the
   * customer's own screen enforces — that is not a difference of altitude, it is the same
   * bill.
   *
   *   change_pending  a change nobody has approved is not owed. `draft` counts as much as
   *                   `pending_ack`: a half-edited order is not a bill either.
   *   invoice_stale   the invoice was issued BEFORE an approved change, so the document names
   *                   a number that is no longer the amount due.
   *
   * Soft on its own failure, deliberately. A missing change_orders table or a read error must
   * not stop a builder taking money they are owed — the same tolerance `send_invoice`'s
   * pending check carries. Returns the sentence to refuse with, or null to proceed.
   */
  //
  // ⚠️ IT RETURNS WHICH REFUSAL, NOT JUST A SENTENCE (fixed 2026-09-08, found by testing).
  // These are TWO different problems with two different remedies — chase the customer, or
  // regenerate the invoice — and both were being reported as `reason: "change_pending"`. The
  // `message` was right, so a rep who read it was fine; any code branching on the classifier
  // was not, and a classifier that cannot tell two states apart is worse than none, because
  // it looks like it can.
  const changeRefusal = async (
    shortCode: string | null,
  ): Promise<{ reason: "change_pending" | "invoice_stale"; message: string } | null> => {
    if (!shortCode) return null;
    try {
      const [coRes, invRes] = await Promise.all([
        admin.from("change_orders").select("status, acknowledged_at")
          .eq("client_id", clientId).eq("short_code", shortCode),
        // `document_at` since migration 221: staleness is a property of the DOCUMENT, and
        // `updated_at` only moves when an email lands — so a bad address made this refusal
        // permanent and locked the order out of every payment path. Coalesced for rows
        // written before 221.
        admin.from("invoice_sends").select("updated_at, document_at")
          .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
      ]);
      if (coRes.error) return null;
      const cos = coRes.data ?? [];
      if (cos.some((c) => c.status === "pending_ack" || c.status === "draft")) {
        return {
          reason: "change_pending",
          message: "There's a change on this order the customer hasn't approved yet. Settle that first — the amount due may move.",
        };
      }
      const invoiceAt = Date.parse(String(invRes.data?.document_at || invRes.data?.updated_at || "")) || 0;
      const stale = invoiceAt > 0 && cos.some((c) =>
        c.status === "acknowledged" && (Date.parse(String(c.acknowledged_at || "")) || 0) > invoiceAt
      );
      if (stale) {
        return {
          reason: "invoice_stale",
          message: "This invoice was issued before the latest approved change. Regenerate and resend it, then take the payment.",
        };
      }
      return null;
    } catch (_) {
      return null;
    }
  };

  if (action === "pay_options") {
    const orderId = String(payload?.orderId ?? "").trim();
    if (!orderId) return json({ error: "orderId is required." }, 400);
    const money = await readOrderMoney(admin, clientId, orderId);
    if (!money) return json({ error: "Order not found." }, 404);
    const decision = paymentAmountDecision(money);
    // An unapproved change outranks the amount arithmetic: the figure is not wrong, it is
    // not yet owed. Surfaced through the same three fields the modal already renders, so the
    // rep reads a sentence rather than finding a disabled button.
    const blocked = await changeRefusal(money.shortCode);
    // The keyed-card modal's Name on card, Street and ZIP, prefilled from the design's contact
    // (the delivery address) and editable there. ONLY for someone who can take the card: an
    // operator is refused at charge, and a viewer cannot charge at all, so neither is handed a
    // customer's address by a payment endpoint. null when there is no design to read it from.
    let billingPrefill: { name: string; street: string; zip: string } | null = null;
    if (!operator && canEdit("orders") && money.shortCode) {
      const { data: dRow } = await admin.from("designs")
        .select("contact").eq("client_id", clientId).eq("short_code", money.shortCode).maybeSingle();
      const contact = (dRow?.contact ?? {}) as Record<string, unknown>;
      const a = addressFrom(contact);
      const b = cpBillingFields({ name: contact.name, address: a.street ?? undefined, postal: a.zip ?? undefined });
      billingPrefill = { name: b.name ?? "", street: b.address ?? "", zip: b.postal ?? "" };
    }
    return json({
      ok: true,
      billingPrefill,
      canCharge: decision.ok && !blocked,
      reason: blocked ? blocked.reason : (decision.ok ? null : decision.reason),
      message: blocked ? blocked.message : (decision.ok ? null : amountRefusalText(decision.reason)),
      askCents: decision.ok ? decision.askCents : 0,
      askKind: decision.ok ? decision.kind : null,
      balanceCents: decision.balanceCents,
      settledCents: money.settledCents,
      pendingCents: money.pendingCents,
      depositCents: money.depositCents,
      minCents: MIN_PAYMENT_CENTS,
      maxCents: MAX_PAYMENT_CENTS,
      // The tokenizer of the tenant's OWN system (test or live): a token minted on one cannot be
      // charged on the other.
      tokenizer: {
        // Also where the modal tokenizes a bank account itself (the Routing and Checking
        // boxes, 2026-10): the numbers go from the browser to CardSecure, never through here.
        origin: cpTokenizerOrigin(currentMerchant),
        cardUrl: cpTokenizerUrl(currentMerchant, "card"),
        // Unused by the current modal; kept for a portal tab still running the old build.
        achUrl: cpTokenizerUrl(currentMerchant, "ach"),
        // The reader's own frame, with its own parameter set (2026-10-13): it was the card URL
        // plus "&swipeonly=true", whose numeric-only and CVV settings threw away the reader's
        // letters and Shift keys. cpTokenizerUrl's docblock has the whole story.
        swipeUrl: cpTokenizerUrl(currentMerchant, "swipe"),
        cardHeight: cpTokenizerHeight("card"),
        achHeight: cpTokenizerHeight("ach"),
        // Read only by a portal that knows it; an older one sizes the swipe frame by cardHeight.
        swipeHeight: cpTokenizerHeight("swipe"),
      },
    });
  }

  // ── surcharge_probe ───────────────────────────────────────────────────────────────
  if (action === "surcharge_probe") {
    const t = typeof payload?.payToken === "string" ? payload.payToken.trim() : "";
    if (!t || t.length > 256) return json({ ok: true, applies: null, percent: null });
    // The billing ZIP from the modal, when it holds a real one: a fee can turn on where the card
    // is billed. A malformed ZIP is left off rather than sent.
    const probe = await cpSurchargeProbe(currentMerchant, t, cpBillingFields(payload).postal);
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
    // BEFORE the card is touched, and before the amount is confirmed: an unapproved change
    // means the amount due is still moving, and a charge taken against it is money that has
    // to be given back.
    const blocked = await changeRefusal(money.shortCode);
    if (blocked) return json({ error: blocked.message, reason: blocked.reason }, 409);
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
    // A SWIPE sends no ecomind at all: CardPointe defines "R" as RECURRING, not retail (this
    // sent "R" until 2026-10, so every swipe went out as a recurring card-not-present sale). The
    // swipe's own track data is what tells the gateway the card was physically present. A card the
    // builder keys sends T (invoicePayment.ts ecomindFor; Fiserv (CardPointe integrations),
    // 2026-10-14).
    //
    // ⚠️ ONLY ON A CARD. The modal never reset `entry` when the method changed, so Card > Swipe >
    // Bank posted a BANK payment with entry "swipe": the ECHK auth went out with no ecomind and was
    // labelled "Swipe". A bank payment is never a swipe, whatever the page sends.
    const swiped = rail === "card" && payload?.entry === "swipe";

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
    //
    // Since 2026-10 the keyed-card modal also sends Name on card, Street and ZIP (prefilled from
    // pay_options' billingPrefill, editable): what was typed wins, and the contact's name is the
    // fallback. A page that sends none of them charges exactly as before.
    let contact: Record<string, unknown> | null = null;
    if (money.shortCode) {
      const { data: dRow } = await admin.from("designs")
        .select("contact").eq("client_id", clientId).eq("short_code", money.shortCode).maybeSingle();
      contact = (dRow?.contact as Record<string, unknown> | null) ?? null;
    }
    const billing = billingFromRequest(payload, contact);

    const result = await chargeInvoicePayment(admin, {
      clientId,
      merchant: currentMerchant,
      orderId,
      shortCode: money.shortCode,
      amountCents: decision.askCents,
      rail,
      account: token,
      expiry: typeof payload?.expiry === "string" ? payload.expiry.trim().slice(0, 8) : undefined,
      postal: billing.postal,
      name: billing.name,
      address: billing.address,
      entry: swiped ? "swipe" : "keyed",
      actorKind: "staff",
      actorRef: userId ?? null,
      createdBy: userId ?? null,
    });
    // newCardNeeded rides only on a failure that reached /auth and did not stand (a decline, a voided
    // partial): the modal asks for the card again. Nothing refused above this line carries it.
    if (!result.ok) return json(failureBody(result), result.status, result.blocking);
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
    const billing = billingFromRequest(payload, null);
    if (rail === "ach" && !billing.name) {
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
      merchant: currentMerchant,
      orderId: String(order.id),
      shortCode: null,
      amountCents: cents,
      rail,
      account: token,
      expiry: typeof payload?.expiry === "string" ? payload.expiry.trim().slice(0, 8) : undefined,
      postal: billing.postal,
      name: billing.name,
      address: billing.address,
      // A swipe sends no ecomind; a card the builder keys sends T (ecomindFor; Fiserv (CardPointe
      // integrations), 2026-10-14). Swipe only on a card, as in `charge`: a bank payment is never one.
      entry: rail === "card" && payload?.entry === "swipe" ? "swipe" : "keyed",
      actorKind: "staff",
      actorRef: userId ?? null,
      createdBy: userId ?? null,
    });
    if (!result.ok) {
      // The order exists but nothing was collected. Leave it — a zero-paid counter sale is
      // visible and closable, and deleting a row a trigger may already have touched is a
      // worse failure than an empty order.
      return json({ ...failureBody(result), orderId: order.id }, result.status, result.blocking);
    }
    return json({ ...result, orderId: order.id });
  }

  // ── void_payment / refund_payment ────────────────────────────────────────────────
  // The portal's own void button writes voided_at directly, and RLS correctly refuses that
  // for a gateway row — the money is still at CardPointe. So voiding one has to come
  // through here, and the row is only marked voided IF THE GATEWAY AGREES.
  //
  // Asked on the merchant account the charge was TAKEN on (merchantOfRecord, off the payment's
  // attempt), never the tenant's current one: a void or refund on another account is a retref
  // that account has never seen.
  if (action === "void_payment" || action === "refund_payment") {
    const paymentId = String(payload?.paymentId ?? "").trim();
    if (!paymentId) return json({ error: "paymentId is required." }, 400);

    const { data: p, error: pErr } = await admin.from("payments")
      .select("id, order_id, amount_cents, note, method, gateway, gateway_txn_id, voided_at, funding_state, attempt_id, received_at")
      .eq("client_id", clientId).eq("id", paymentId).maybeSingle();
    if (pErr) return dbFail(req, clientId, "load that payment", pErr);
    if (!p) return json({ error: "Payment not found." }, 404);
    if (p.gateway !== "cardpointe" || !p.gateway_txn_id) {
      return json({ error: "That payment wasn't taken here — void it the usual way." }, 400);
    }
    if (p.voided_at) return json({ ok: true, already: true });
    // ⛔ A BANK PAYMENT STILL CLEARING IS NEVER REFUNDED (2026-10-14). Refunding a debit that has
    // not funded pays the customer back money that may never arrive; if the debit then comes back
    // (every UAT one returns R03), the builder has paid out twice and reconcile skips the voided row,
    // so nobody sees it. Refused before the gateway is asked. A same-day VOID stays allowed below:
    // it cancels the debit itself, if the gateway still can.
    //
    // HELD FOR ACH_CLEARED_AFTER_DAYS, NOT FOREVER. Only reconcile moves a bank payment out of
    // pending, and neither of its readers has been seen answering live (the funding shape, the date
    // format). Refused for good, a payment no reader ever moved would leave its order impossible to
    // refund from the portal. After the hold, it refunds like a settled one.
    const achPending = achClearing(p);
    if (action === "refund_payment" && achPending) {
      return json({ error: ACH_PENDING_REFUND_TEXT, reason: "ach_pending" }, 409);
    }

    await audit(`${action}`, null, `payment=${paymentId} retref=${p.gateway_txn_id}`).catch(() => {});

    // Every payment the charge path writes carries its attempt (invoicePayment.ts, both inserts).
    // One without, or whose attempt names no MID, is refused and filed: NEVER sent to the current
    // MID on a guess. Someone finds the account at the gateway and acts there.
    let merchant: MerchantOfRecord | undefined;
    try {
      merchant = (await merchantOfRecord(admin, clientId, [p.attempt_id])).get(String(p.attempt_id ?? ""));
    } catch (e) {
      return dbFail(req, clientId, "find the account that payment was taken on", e);
    }
    if (!merchant) {
      await logEdgeError({
        fn: "portal-payments",
        req,
        clientId,
        code: "payment_no_merchant_of_record",
        message:
          `${clientId}: ${action} REFUSED for payment ${paymentId} (retref ${p.gateway_txn_id}): no charge attempt says which merchant ` +
          `account took it (attempt_id ${p.attempt_id ?? "null"}). Not sent to the current MID. Find the account at the gateway and act there.`,
        context: { paymentId, attemptId: p.attempt_id ?? null, action },
      });
      return json({
        error: "We can't tell which merchant account took this payment, so it can't be cancelled or refunded from here. Nothing has changed, and we've been told.",
      }, 409);
    }
    // The SYSTEM the charge was taken on (test or live) must have credentials here. Without them the
    // gateway call would only throw a configuration error and read as "couldn't reach the network".
    if (!cardpointeConfigured(merchant.env)) {
      return await systemMissing(merchant, "That payment can't be cancelled or refunded from here right now. Nothing has changed, and we've been told.");
    }

    if (action === "void_payment") {
      let ok = false;
      try {
        ok = await cpVoid(merchant, String(p.gateway_txn_id));
      } catch (e) {
        return json({
          error: "We couldn't reach the card network to cancel that payment. Nothing has changed — try again shortly.",
          detail: String((e as Error).message ?? "").slice(0, 160),
        }, 502);
      }
      if (!ok) {
        // A bank payment still clearing has no next step yet: it cannot be refunded until it clears
        // (above). So NO `settled: true` here, which is what makes the portal chain straight to
        // refund_payment (04-orders.jsx, voidGatewayPayment); a page that predates the refusal then
        // shows this sentence instead of sending a refund that would be refused anyway. Past its hold
        // it falls through to `settled: true`, and the refund that follows is allowed.
        if (achPending) return json({ error: ACH_PENDING_REFUND_TEXT, reason: "ach_pending" }, 409);
        // Almost always "already settled". A refund is the honest next step, and the UI
        // switches to it rather than pretending the void worked. A bank payment past its hold may
        // still read pending, so it is not told it "settled".
        return json({
          error: p.method === "ach" && p.funding_state === "pending"
            ? "That bank payment can't be cancelled any more — refund it instead."
            : "That payment has already settled — refund it instead.",
          settled: true,
        }, 409);
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
      out = await cpRefund(merchant, String(p.gateway_txn_id), refundCents);
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
  //   * move pending ACH forward, or mark it returned, or bring back a late return: /funding for
  //     whether a bank payment funded or came back (since 2026-10-14), settlestat for its status word
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

    // Both payment lists below are read WITH payments.funding_checked_through (migration 309), how
    // far the funding pass has read each bank payment. A database without that column refuses the
    // whole select (42703); the lists are then read without it, the funding pass is skipped (filed
    // once a day), and the rest of reconcile works as it did before 309.
    let cursorsOn = true;
    // deno-lint-ignore no-explicit-any
    const cursorMissing = (e: any) => String(e?.code ?? "") === "42703" || /funding_checked_through/.test(String(e?.message ?? ""));
    // deno-lint-ignore no-explicit-any
    const readWithCursor = async (make: (cols: string) => PromiseLike<any>, cols: string): Promise<{ data: any }> => {
      if (cursorsOn) {
        const r = await make(`${cols}, funding_checked_through`);
        if (!r?.error || !cursorMissing(r.error)) return r;
        cursorsOn = false;
      }
      return await make(cols);
    };

    // Pending bank payments. settlestat returns a whole batch in ONE call, which is the only
    // shape that survives the 40 TPM per-MID cap — a per-payment inquire loop would 429
    // itself into uselessness and starve real customer charges of the same quota.
    //
    // ORDERED, and the order is load-bearing. PostgREST returns rows in no defined order, so
    // an unordered slice of days could ask about today's batch on every sweep and never once
    // about the payment that has been stuck since last week. Oldest received first means the
    // oldest money is always inside the day budget.
    const { data: pending } = await readWithCursor((cols) => {
      let pq = admin.from("payments")
        .select(cols)
        .eq("client_id", clientId).eq("gateway", "cardpointe")
        .eq("funding_state", "pending").is("voided_at", null)
        .order("received_at", { ascending: true });
      if (orderId) pq = pq.eq("order_id", orderId);
      return pq.limit(200);
    }, "id, order_id, method, funding_state, gateway_txn_id, received_at, attempt_id");

    // Bank payments that already funded but are still inside the return window. Settled is
    // NOT final for ACH: a debit can be sent back days later, and without this pass the only
    // record of that is a bank statement nobody reads.
    //
    // ⚠️ Narrow on purpose — cardpointe AND the ach rail. `funding_state` defaults to
    //    'settled' for every pre-174 cash and cheque row, so a broader sweep here would put
    //    historical hand-recorded payments at the mercy of a gateway batch that has never
    //    heard of them.
    const returnSince = new Date(Date.now() - ACH_RETURN_WINDOW_DAYS * 86400000).toISOString();
    const { data: settledAch } = await readWithCursor((cols) => {
      let rq = admin.from("payments")
        .select(cols)
        .eq("client_id", clientId).eq("gateway", "cardpointe").eq("method", "ach")
        .eq("funding_state", "settled").is("voided_at", null)
        .gt("funding_updated_at", returnSince)
        .order("funding_updated_at", { ascending: false });
      if (orderId) rq = rq.eq("order_id", orderId);
      return rq.limit(200);
    }, "id, order_id, method, gateway_txn_id, received_at, attempt_id");

    const nowIso = new Date().toISOString();
    const updated: unknown[] = [];
    // Keyed `${env}|${merchid}|${retref}`: a batch answers for ITS merchant on ITS system (test or
    // live), and a retref is only looked up in the batch of the account the payment was taken on.
    const byRetref = new Map<string, string>();
    // Keyed `${env}|${merchid}|${day}`: settlestat is one call per MERCHANT and day (the 40 TPM quota
    // is per MID), and MAX_SETTLESTAT_DAYS caps how many of those calls one sweep makes.
    const fetchedDays = new Set<string>();
    const skippedDays = new Set<string>();
    const dayOf = (v: unknown) => String(v ?? "").slice(0, 10).replace(/-/g, "");

    // Gateway calls this sweep could not read, settlestat and funding alike, filed ONCE a day (below)
    // with the merchant's last four and the class of failure, never a body (a 4xx carries the
    // gateway's own text). Until 2026-10-14 a settlestat failure was swallowed whole, so "the call
    // failed" and "nothing moved" looked the same, and a date refused on every sweep was invisible.
    const gatewayFailures: { call: "settlestat" | "funding"; merchant: string; env: string; day: string; kind: string }[] = [];
    // Once the limiter says no, this sweep asks nothing more: the 40 TPM quota is shared with live
    // charges, and every further call would only be refused too. What is left waits for the next sweep.
    let limited = false;
    const noteFailure = (call: "settlestat" | "funding", m: MerchantOfRecord, day: string, e: unknown) => {
      const kind = isGatewayConfig(e) ? "config" : isGatewayThrottled(e) ? "throttled" : isGatewayUnknown(e) ? "unknown" : "other";
      if (kind === "throttled") limited = true;
      gatewayFailures.push({ call, merchant: "…" + m.merchid.slice(-4), env: m.env, day, kind });
    };
    // A payment the gateway answered for whose write then FAILED (pg code only): filed once, as a
    // fault, because the row is still saying something the gateway contradicts.
    const writeFailures: { paymentId: unknown; pgCode: string | null }[] = [];

    // Each payment's own merchant of record, in one read for both lists. A payment without one is
    // SKIPPED (left as it is) and filed, never asked about on the tenant's current MID. A failed
    // read skips them all this sweep: the next one asks again.
    const sweep = [...(pending ?? []), ...(settledAch ?? [])] as Record<string, unknown>[];
    let merchants = new Map<string, MerchantOfRecord>();
    let merchantsRead = true;
    try {
      merchants = await merchantOfRecord(admin, clientId, sweep.map((p) => p.attempt_id));
    } catch (e) {
      merchantsRead = false;
      await logEdgeError({
        fn: "portal-payments",
        req,
        clientId,
        code: "reconcile_merchant_read_failed",
        message: `${clientId}: reconcile could not read which merchant account took its bank payments, so it asked the gateway nothing: ${(e as Error).message}`,
      });
    }
    const merchantOf = (row: Record<string, unknown>) =>
      row.attempt_id == null ? undefined : merchants.get(String(row.attempt_id));
    const orphans = merchantsRead ? sweep.filter((row) => !merchantOf(row)) : [];
    // ONCE A DAY, not once a sweep: the Orders tab fires this on every visit while a bank payment
    // is pending, and an orphan stays pending until a human acts, so a row per sweep would bury
    // the queue under one problem (see filedToday).
    if (orphans.length && !(await orphansFiledToday(admin, clientId, orphans.slice(0, 50).map((r) => String(r.id))))) {
      await logEdgeError({
        fn: "portal-payments",
        req,
        clientId,
        code: "payment_no_merchant_of_record",
        message:
          `${clientId}: reconcile skipped ${orphans.length} bank payment(s) with no charge attempt to say which merchant account took them ` +
          `(${orphans.slice(0, 10).map((r) => r.id).join(", ")}). Not asked about on the current MID; check them at the gateway.`,
        context: { paymentIds: orphans.slice(0, 50).map((r) => r.id) },
      });
    }

    /** Spend (merchant, day)-sized pieces of the budget, in the order given, never twice on the
     *  same pair, and never past MAX_SETTLESTAT_DAYS. A row with no merchant asks nothing, and nor
     *  does one on a system this deployment has no credentials for: it stays as it is, and spends
     *  none of the budget on a call that could only be refused. */
    const loadDays = async (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const m = merchantOf(row);
        const d = dayOf(row.received_at);
        if (!m || !d || !cardpointeConfigured(m.env)) continue;
        const key = `${m.env}|${m.merchid}|${d}`;
        if (fetchedDays.has(key) || skippedDays.has(key)) continue;
        if (fetchedDays.size >= MAX_SETTLESTAT_DAYS || limited) { skippedDays.add(key); continue; }
        fetchedDays.add(key);
        try {
          // Whatever the answer is wrapped in (a list of batches, a list of rows, one batch):
          // settlementStatuses walks it. Reading `txns` off the top level found nothing in a list.
          const answer = await cpSettleStat(m, d);
          for (const [rr, st] of settlementStatuses(answer)) byRetref.set(`${m.env}|${m.merchid}|${rr}`, st);
        } catch (e) {
          // One bad day must not stop the rest, but it is no longer silent (gatewayFailures).
          noteFailure("settlestat", m, d, e);
        }
      }
    };
    /** The settlement status the payment's OWN merchant reported for it, if a batch said. */
    const statusOf = (row: Record<string, unknown>) => {
      const m = merchantOf(row);
      return m ? byRetref.get(`${m.env}|${m.merchid}|${String(row.gateway_txn_id ?? "")}`) : undefined;
    };

    /** A return, filed for us. On the TEST system it is info, not a fault: Fiserv (CardPointe
     *  integrations), 2026-10-14, says every UAT bank payment comes back R03, so there it is the
     *  expected outcome. Nothing here emails anyone. */
    const noteReturned = (row: Record<string, unknown>, code: string | null) => {
      const m = merchantOf(row);
      const retref = String(row.gateway_txn_id ?? "");
      logEdgeError({
        fn: "portal-payments",
        req,
        clientId,
        code: "ach_returned",
        severity: m?.env === "uat" ? "info" : "error",
        message:
          `${clientId}: bank payment ${retref} on order ${row.order_id} was RETURNED${code ? ` (${code})` : ""} — the balance has been reopened and the builder needs to chase it.`,
        context: { paymentId: row.id, retref, returnCode: code, env: m?.env ?? null },
      }).catch(() => {});
    };

    // ── bank payments in the FUNDING data (2026-10-14) ──────────────────────────────────
    // Fiserv (CardPointe integrations), 2026-10-14: a bank payment's fate shows in the funding data,
    // and every UAT one comes back R03. achFundingRead says, per payment, what one day's answer
    // shows: funded (pending becomes settled), an R-code (returned and voided), a sign of a return
    // it cannot read (nothing changes; filed, field names only), or nothing at all.
    //
    // WHICH PAYMENTS: every pending bank payment, and every settled one still inside its return
    // window. Settled is not final for a bank payment: a debit can fund and still come back, and
    // only the funding data carries the code (settlestat's "Accepted" comes before it).
    //
    // WHICH DAYS: every funding day from the sale day to the end of its return window, and only
    // days that are over (FUNDING_DAY_READABLE_AFTER_MS). funding_checked_through says how far each
    // payment has already been read, so a day is asked for once, and one call per (merchant, day)
    // serves every payment on that merchant. Days a payment still clearing needs come first, then
    // each payment's oldest unread day before its next, so a fresh payment is not starved by an old
    // one and every payment's reading only moves forward. At most MAX_FUNDING_CALLS a sweep (a
    // failed call counts). BEFORE the settlestat pass, so a return found here is booked before
    // settlestat can say anything about the same payment.
    const DAY_MS = 86400000;
    const dayStart = (v: unknown): number | null => {
      const t = Date.parse(String(v ?? ""));
      return Number.isFinite(t) ? Math.floor(t / DAY_MS) * DAY_MS : null;
    };
    const ymdOf = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
    const lastReadable = Math.floor((Date.now() - FUNDING_DAY_READABLE_AFTER_MS) / DAY_MS) * DAY_MS;
    type Watched = { row: Record<string, unknown>; m: MerchantOfRecord; pending: boolean; cursor: number | null; days: number[] };
    const watched: Watched[] = [];
    const watch = (row: Record<string, unknown>, isPending: boolean) => {
      const m = merchantOf(row);
      const sale = dayStart(row.received_at);
      if (!m || sale === null || !cardpointeConfigured(m.env)) return;
      const cursor = dayStart(row.funding_checked_through);
      const last = Math.min(lastReadable, sale + (ACH_RETURN_WINDOW_DAYS + ACH_CLEARED_AFTER_DAYS) * DAY_MS);
      const days: number[] = [];
      for (let d = cursor === null ? sale : Math.max(sale, cursor + DAY_MS); d <= last; d += DAY_MS) days.push(d);
      watched.push({ row, m, pending: isPending, cursor, days });
    };
    if (cursorsOn) {
      for (const p of (pending ?? []) as Record<string, unknown>[]) if (p.method === "ach") watch(p, true);
      for (const p of (settledAch ?? []) as Record<string, unknown>[]) watch(p, false);
    }
    const fundingKey = (m: MerchantOfRecord, d: number) => `${m.env}|${m.merchid}|${ymdOf(d)}`;
    /** Every (merchant, day) some payment still needs: whether a payment still clearing needs it,
     *  and the lowest place it holds in the unread days of a payment of that kind. */
    const wanted = new Map<string, { m: MerchantOfRecord; day: number; clearing: boolean; rank: number }>();
    for (const w of watched) {
      w.days.forEach((d, rank) => {
        const k = fundingKey(w.m, d);
        const prior = wanted.get(k);
        if (!prior || (w.pending && !prior.clearing)) wanted.set(k, { m: w.m, day: d, clearing: w.pending, rank });
        else if (w.pending === prior.clearing) prior.rank = Math.min(prior.rank, rank);
      });
    }
    const fundingOrder = [...wanted.entries()].sort(([, a], [, b]) =>
      Number(b.clearing) - Number(a.clearing) || a.rank - b.rank || a.day - b.day
    );
    // Only answers in a shape achFundingRead can read; a day that failed, or came back in a shape it
    // does not know, is not here, so no payment is read past it.
    const fundingAnswers = new Map<string, unknown>();
    let fundingCalls = 0;
    let fundingLeft = 0;
    // A refusal (a 4xx: a date the gateway does not take, a login it will not accept) would be the
    // same refusal on every call after it, so the first one ends the funding pass for this sweep,
    // the way the limiter ends every call.
    let fundingRefused = false;
    const unrecognised: { merchant: string; env: string; day: string; keyPaths: string[] }[] = [];
    for (const [key, w] of fundingOrder) {
      if (fundingCalls >= MAX_FUNDING_CALLS || limited || fundingRefused) { fundingLeft++; continue; }
      fundingCalls++;
      const day = ymdOf(w.day);
      try {
        const answer = await cpFunding(w.m, day);
        const shape = fundingAnswerShape(answer);
        if (shape.recognised) fundingAnswers.set(key, answer);
        else unrecognised.push({ merchant: "…" + w.m.merchid.slice(-4), env: w.m.env, day, keyPaths: shape.keyPaths });
      } catch (e) {
        noteFailure("funding", w.m, day, e);
        if (isGatewayConfig(e)) fundingRefused = true;
      }
    }

    const moved = new Set<string>();
    /** Payments the funding data shows something like a return for that it could not read. They are
     *  not settled on settlestat's word either, however old. */
    const unreadReturn = new Set<string>();
    const unreadHints: { paymentId: unknown; env: string; merchant: string; keys: string[] }[] = [];
    for (const w of watched) {
      const id = String(w.row.id);
      let code: string | null = null;
      let unreadKeys: string[] | null = null;
      let funded = false;
      // How far this payment has now been read: the unbroken run of days from its first unread one
      // that came back readable and held nothing unread for it. A day not read this sweep (the
      // budget, a failure, a shape we do not know) or one with a return we cannot read ends the run,
      // and the next sweep starts there.
      let through: number | null = null;
      let unbroken = true;
      for (const d of w.days) {
        const answer = fundingAnswers.get(fundingKey(w.m, d));
        if (answer === undefined) { unbroken = false; continue; }
        const read = achFundingRead(answer, w.row.gateway_txn_id);
        if (read.kind === "returned") { code = read.code; break; }
        if (read.kind === "return_unread") { unreadKeys ??= read.keys; unbroken = false; continue; }
        if (read.kind === "funded") funded = true;
        if (unbroken) through = d;
      }
      const cursorPatch: Record<string, string> = through !== null && (w.cursor === null || through > w.cursor)
        ? { funding_checked_through: new Date(through).toISOString().slice(0, 10) }
        : {};

      if (code) {
        // Guarded like every write here: still in the state it was read in, still not voided (a
        // builder may have voided or refunded it since the SELECT), and `.select` says whether a
        // row really moved. A settled one is a late return: the money funded and came back.
        const { data: hit, error: wErr } = await admin.from("payments")
          .update(returnedPaymentPatch(code, nowIso))
          .eq("client_id", clientId).eq("id", w.row.id)
          .eq("funding_state", w.pending ? "pending" : "settled").is("voided_at", null)
          .select("id");
        if (wErr) { writeFailures.push({ paymentId: w.row.id, pgCode: wErr.code ?? null }); continue; }
        if (!hit || !hit.length) continue;
        moved.add(id);
        updated.push({ paymentId: w.row.id, to: "returned", returnCode: code });
        noteReturned(w.row, code);
        continue;
      }
      if (unreadKeys) {
        unreadReturn.add(id);
        unreadHints.push({ paymentId: w.row.id, env: w.m.env, merchant: "…" + w.m.merchid.slice(-4), keys: unreadKeys });
      } else if (funded && w.pending) {
        // FUNDED: the money is in, so the payment is no longer clearing. This is what lets
        // Payment Received fire (migration 309 counts a bank payment once it stops being pending).
        // A return after this is still read: the payment is now on the settled list, inside its
        // return window, and its reading carries on from where it stopped.
        const { data: hit, error: wErr } = await admin.from("payments")
          .update({ funding_state: "settled", funding_updated_at: nowIso, ...cursorPatch })
          .eq("client_id", clientId).eq("id", w.row.id)
          .eq("funding_state", "pending").is("voided_at", null)
          .select("id");
        if (wErr) { writeFailures.push({ paymentId: w.row.id, pgCode: wErr.code ?? null }); continue; }
        if (!hit || !hit.length) continue;
        moved.add(id);
        updated.push({ paymentId: w.row.id, to: "settled" });
        continue;
      }
      // Nothing to decide: only remember how far it has been read. Bookkeeping, so a failed write is
      // not filed; the next sweep reads those days again, which costs calls and changes nothing.
      if (cursorPatch.funding_checked_through) {
        try {
          await admin.from("payments").update(cursorPatch).eq("client_id", clientId).eq("id", w.row.id);
        } catch { /* see above */ }
      }
    }

    if (pending && pending.length) {
      // A payment the funding pass already moved spends none of the settlestat budget.
      const rest = (pending as Record<string, unknown>[]).filter((p) => !moved.has(String(p.id)));
      await loadDays(rest);
      for (const p of rest) {
        const raw = statusOf(p);
        const next = fundingStateFromSetlstat(raw);
        // null means "we do not recognise that status" — LEAVE IT PENDING. Never guess a
        // bank payment into being money.
        if (!next || next === "pending") continue;
        // ⛔ NOT SETTLED ON SETTLESTAT'S WORD WHILE IT IS CLEARING (2026-10-14). For a bank payment
        // "Accepted" is the processor taking the debit, which comes BEFORE the R03 Fiserv says posts
        // in the funding data, so settling on it fired Payment Received (migration 309) on money
        // about to come back. The funding pass settles it when the money is in. Only after
        // ACH_CLEARED_AFTER_DAYS may "Accepted" settle it, so a bank payment the funding data never
        // mentions (or that we cannot read) does not stay pending, its order frozen, for good. A
        // return the funding pass saw but could not read holds it however old it is.
        if (next === "settled" && p.method === "ach" && (achClearing(p) || unreadReturn.has(String(p.id)))) continue;
        // settlestat says a status WORD ("Rejected"), never a NACHA code, so a return booked from
        // it has no return_code. It used to store the word there.
        const patch = next === "returned"
          ? returnedPaymentPatch(null, nowIso)
          : { funding_state: "settled", funding_updated_at: nowIso };
        // Guarded like the late pass below (2026-10-14): a row a builder voided or refunded since the
        // SELECT is left alone (a return used to overwrite a refund's void_reason), and only a row the
        // UPDATE hands back counts as moved. A failed write is filed, not reported as a move.
        const { data: hit, error: wErr } = await admin.from("payments").update(patch)
          .eq("client_id", clientId).eq("id", p.id)
          .eq("funding_state", "pending").is("voided_at", null)
          .select("id");
        if (wErr) { writeFailures.push({ paymentId: p.id, pgCode: wErr.code ?? null }); continue; }
        if (!hit || !hit.length) continue;
        updated.push({ paymentId: p.id, to: next });
        if (next === "returned") noteReturned(p, null);
      }
    }

    // ── late bank returns ────────────────────────────────────────────────────────────
    // The ONLY transition allowed out of settled is 'returned', and only when the gateway
    // says so in as many words. An unrecognised status, a blank one, or a retref that is not
    // in any batch we managed to read all mean the same thing they mean above: leave it
    // alone. Un-paying an invoice on a guess is worse than a late return going unseen. A late
    // return with a CODE is the funding pass's (above); this one reads settlestat's words.
    //
    // ⚠️ Voiding a returned payment does NOT release the inventory unit (migration 105). A
    //    transfer sent back is a collections problem, not an un-sale.
    if (settledAch && settledAch.length) {
      const rest = (settledAch as Record<string, unknown>[]).filter((p) => !moved.has(String(p.id)));
      await loadDays(rest);
      for (const p of rest) {
        const raw = statusOf(p);
        if (raw === undefined) continue;
        if (fundingStateFromSetlstat(raw) !== "returned") continue;
        // The funding_state/voided_at predicates are repeated on the UPDATE so a row someone
        // voided or refunded between the SELECT and here is left alone, and `.select` is what
        // tells us whether a row actually moved — a zero-row update is not an error. The status
        // word is not a NACHA code, so no return_code (it used to store the word).
        const { data: hit, error: rErr } = await admin.from("payments")
          .update(returnedPaymentPatch(null, nowIso))
          .eq("client_id", clientId).eq("id", p.id)
          .eq("funding_state", "settled").is("voided_at", null)
          .select("id");
        if (rErr) { writeFailures.push({ paymentId: p.id, pgCode: rErr.code ?? null }); continue; }
        if (!hit || !hit.length) continue;
        updated.push({ paymentId: p.id, to: "returned" });
        noteReturned(p, null);
      }
    }

    // ONE row a DAY for each kind of trouble (filedToday), never one per day read nor one per
    // Orders visit: info rows are never deleted, and the Orders tab fires this on every visit while a
    // bank payment is pending. Something the earlier row did not name (another merchant, another
    // class of failure, another payment) is filed at once.
    if (gatewayFailures.length) {
      const signatures = [...new Set(gatewayFailures.map((f) => `${f.call}|${f.env}|${f.merchant}|${f.kind}`))];
      if (!(await filedToday(admin, clientId, "reconcile_gateway_failed", "signatures", signatures))) {
        await logEdgeError({
          fn: "portal-payments",
          req,
          clientId,
          code: "reconcile_gateway_failed",
          severity: "info",
          message:
            `${clientId}: reconcile could not read ${gatewayFailures.length} settlement/funding answer(s); the payments they cover were left as they were.`,
          context: { failures: gatewayFailures.slice(0, 20), signatures },
        });
      }
    }
    if (unrecognised.length) {
      const signatures = [...new Set(unrecognised.map((u) => `${u.env}|${u.merchant}`))];
      if (!(await filedToday(admin, clientId, "reconcile_funding_unrecognised", "signatures", signatures))) {
        const keyPaths = [...new Set(unrecognised.flatMap((u) => u.keyPaths))].slice(0, 50);
        await logEdgeError({
          fn: "portal-payments",
          req,
          clientId,
          code: "reconcile_funding_unrecognised",
          severity: "info",
          message:
            `${clientId}: reconcile read ${unrecognised.length} funding answer(s) in a shape it does not know, so no bank payment could be read from them. Key paths only, no values.`,
          context: { answers: unrecognised.slice(0, 8).map(({ keyPaths: _k, ...where }) => where), keyPaths, signatures },
        });
      }
    }
    // The first live return in a shape the reader does not take files here: which fields looked like
    // it, never what they held. On the live system it is a fault: a real bank payment is sitting
    // pending (or settled) on a return nobody has booked.
    if (unreadHints.length) {
      const signatures = [...new Set(unreadHints.map((h) => `${h.paymentId}|${h.keys.join(",")}`))];
      if (!(await filedToday(admin, clientId, "reconcile_funding_return_unread", "signatures", signatures))) {
        await logEdgeError({
          fn: "portal-payments",
          req,
          clientId,
          code: "reconcile_funding_return_unread",
          severity: unreadHints.some((h) => h.env !== "uat") ? "error" : "info",
          message:
            `${clientId}: the funding data shows something like a return for ${unreadHints.length} bank payment(s) that reconcile cannot read as a return code, so they were left as they were. ` +
            `Field names only, no values: achState.ts achReturnFromFunding needs to read them.`,
          context: { payments: unreadHints.slice(0, 20), signatures },
        });
      }
    }
    const bankPaymentsToRead = ((pending ?? []) as Record<string, unknown>[]).some((p) => p.method === "ach") || (settledAch ?? []).length > 0;
    if (!cursorsOn && bankPaymentsToRead) {
      if (!(await filedToday(admin, clientId, "reconcile_funding_needs_migration", "signatures", ["funding_checked_through"]))) {
        await logEdgeError({
          fn: "portal-payments",
          req,
          clientId,
          code: "reconcile_funding_needs_migration",
          severity: "info",
          message:
            `${clientId}: reconcile read no funding data, because payments.funding_checked_through is missing (migration 309 is not applied). ` +
            `Bank payments move only on settlestat's word until it is.`,
          context: { signatures: ["funding_checked_through"] },
        });
      }
    }
    if (writeFailures.length) {
      await logEdgeError({
        fn: "portal-payments",
        req,
        clientId,
        code: "reconcile_write_failed",
        message:
          `${clientId}: reconcile could not record what the gateway said for ${writeFailures.length} bank payment(s); they still read as before.`,
        context: { failures: writeFailures.slice(0, 20) },
      });
    }

    // daysChecked/daysSkipped are additive: they say whether the budget covered everything
    // pending, which is the difference between "nothing has changed" and "we did not look".
    // daysChecked stays a list of days (one per day, whichever merchants were asked about it);
    // daysSkipped counts the (merchant, day) calls the budget left for the next sweep. The funding
    // pair says the same for /funding: the calls this sweep made, and the (merchant, day) pairs some
    // bank payment still needs that it did not ask; funding_checked_through keeps the place, so the
    // next sweep starts with those.
    return json({
      ok: true,
      resolved,
      updated,
      daysChecked: [...new Set([...fetchedDays].map((k) => k.split("|")[2]))],
      daysSkipped: skippedDays.size,
      fundingChecked: fundingCalls,
      fundingSkipped: fundingLeft,
    });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
}, { minStatus: 400 }));
