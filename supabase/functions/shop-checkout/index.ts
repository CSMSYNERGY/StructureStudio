// shop-checkout — the Online Shop's cart (phase 3, Carolyn 2026-10-17).
//
// Two actions, both PUBLIC (the anon key passes the gateway; config.toml keeps verify_jwt = true
// so a bare request is still refused early):
//
//   price   — {clientId, unitIds[], address?, payInFull?} → each building's asking price, delivery
//             (from the lot that building sits on, the same _shared/deliveryQuote.ts every other
//             surface uses), estimated sales tax and what would be due now under the builder's
//             deposit rule. Called as the cart and the address fill in.
//   request — the same, plus the shopper's name/phone/email/message → a PURCHASE REQUEST row
//             (migration 311), a note on their CRM contact, and an email to the builder's owners
//             and admins. Nothing is charged and no building is marked sold: the builder follows
//             up and sends the estimate from the Inventory tab. Online card payment is phase 4.
//
// THE SERVER PRICES EVERYTHING. The browser sends unit ids and an address, never a number, and
// `request` recomputes the whole cart rather than trusting what `price` returned a minute ago —
// a building can sell, or a builder can hide its price, between the two calls.
//
// A building whose price is not shown online (unit.show_price_online off, or the shop's
// hide_all_prices on) can never be in a cart: it answers "Call for price" on the page, and both
// actions refuse it here, because a cart cannot total a number the shopper was never shown.
//
// TAX IS AN ESTIMATE, and says so: the lot's own rate (builder_locations.tax_rate), else the
// company rate (client_settings.ss_tax_rate). Avalara is never called from here — every lookup
// is metered and the public must not be able to spend a builder's money. No rate on file means
// "tax is added on your estimate" rather than a guessed number.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { clientIp } from "../_shared/adminGate.ts";
import { quoteDelivery } from "../_shared/deliveryQuote.ts";
import { shopRequestEmail } from "../_shared/emailTemplates.ts";
import { rsSendEmail, resendConfigured, ResendApiError } from "../_shared/resend.ts";
import { portalInventoryUrl, portalOrderUrl } from "../_shared/customerPortalUrl.ts";
import { dueNow } from "../_shared/shopPricing.ts";
import { genShortCode, includedLines, purchaseSentence, purchaseSnapshot } from "../_shared/shopPurchase.ts";
import { cpTokenizerHeight, cpTokenizerOrigin, cpTokenizerUrl } from "../_shared/cardpointe.ts";
import { cpMerchant, readPaymentSettings, testModeNeedsExempt } from "../_shared/paymentSettings.ts";
import { chargeInvoicePayment } from "../_shared/invoicePayment.ts";
import { checkSession } from "../_shared/customerSession.ts";
import { orderCentsFromSnapshot, taxFreeze } from "../_shared/estimateLines.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";

const RATE_WINDOW_MS = 60_000;
const RATE_PRICE_PER_IP = 30;
const RATE_REQUEST_PER_IP = 4;
const RATE_REQUEST_PER_TENANT = 20;
const MAX_CART = 6;
const MAX_RECIPIENTS = 5;
const NOTIFY_MS = 8_000;
const PLATFORM_NOTIFY_FROM = "StructureStudio <no-reply@mail.structurestudiosuite.com>";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Count first, then decide (delivery-quote's shape). Fails OPEN on a storage error.
// deno-lint-ignore no-explicit-any
async function overCap(admin: any, bucket: string, max: number): Promise<boolean> {
  const nowMs = Date.now();
  const { data: rl, error } = await admin.from("rate_buckets").select("window_started_at, hits").eq("bucket", bucket).maybeSingle();
  if (error) return false;
  const startedAt = rl?.window_started_at ? Date.parse(String(rl.window_started_at)) : NaN;
  const inWindow = Number.isFinite(startedAt) && (nowMs - startedAt) < RATE_WINDOW_MS;
  const hits = (inWindow ? (Number(rl?.hits) || 0) : 0) + 1;
  await admin.from("rate_buckets").upsert({
    bucket,
    window_started_at: inWindow ? rl!.window_started_at : new Date(nowMs).toISOString(),
    hits,
    updated_at: new Date(nowMs).toISOString(),
  }, { onConflict: "bucket" });
  return hits > max;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

export interface PricedItem {
  unitId: string;
  serial: number;
  label: string;
  lotName: string | null;
  priceCents: number;
  deliveryCents: number | null;
  deliveryNote: string | null;
  taxCents: number | null;
  taxLabel: string | null;
  totalCents: number;
  dueNowCents: number;
}

const MIN_CHARGE_CENTS = 100;
const MAX_CHARGE_CENTS = 5_000_000;
const HOLD_STALE_MS = 15 * 60_000;
const usd = (c: number | null | undefined) =>
  c == null ? "—" : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * PURCHASE — pay first, sign the invoice after (Carolyn 2026-10-17). Per building, in order:
 *   hold the unit (shop_unit_holds, so two shoppers can never both be charged for one building)
 *   → re-check it is unsold → write the customer's estimate from the unit's master (accepted by
 *   this purchase: a CLICK, never a signature) → the acceptance row with the sentence the buyer
 *   ticked → the order → charge the card (chargeInvoicePayment, which records the payment; the
 *   payments_claim_inventory trigger sells the unit) → raise "Invoice to approve" for the builder.
 * The customer signs the invoice when the builder sends it (customer-accept sign_invoice, unchanged).
 *
 * A charge that is DECLINED undoes everything written for that building and frees the hold. A
 * charge whose outcome is UNKNOWN (blocking) keeps every row — money may have moved, and the
 * records are how anyone finds out — and stops the cart. Buildings already paid for stay paid.
 */
// deno-lint-ignore no-explicit-any
async function purchase(c: any): Promise<Response> {
  const { admin, req, clientId, body, address, haveAddress, items, problems, meta, totalCents, dueNowCents, payInFull, business, consentText, priced } = c;
  if (problems.length) return json({ ...priced, ok: false, error: "Something in your cart changed. Review it and try again." }, 409);
  if (!items.length) return json({ error: "Your cart is empty." }, 400);
  if (!haveAddress) return json({ error: "Please enter the delivery city, state and zip." }, 400);
  // deno-lint-ignore no-explicit-any
  if (items.some((i: any) => i.deliveryCents == null)) {
    return json({ ...priced, ok: false, code: "delivery_unpriced", error: "We need to price delivery to your address ourselves — send a purchase request instead and we'll be in touch." }, 409);
  }
  // deno-lint-ignore no-explicit-any
  if (items.some((i: any) => i.dueNowCents < MIN_CHARGE_CENTS || i.dueNowCents > MAX_CHARGE_CENTS)) {
    return json({ ...priced, ok: false, code: "amount", error: "That amount can't be paid online — send a purchase request instead." }, 409);
  }
  // The buyer ticked THIS sentence. If the money moved since (a price change, a new address), the
  // tick was for different words, so it is refused rather than stored against the new total.
  if (body?.consent !== true || str(body?.consentText, 2000) !== consentText) {
    return json({ ...priced, ok: false, code: "consent_mismatch", error: "The total changed — please review it and tick the box again." }, 409);
  }
  const identity = await checkSession(admin, body?.token);
  if (!identity || identity.clientId !== clientId) return json({ ok: false, code: "session", error: "Please verify your phone number again." }, 401);
  const ps = await payReady(admin, clientId);
  if (!ps.ok) return json({ ok: false, code: "payments_unavailable", error: "Online payment isn't available right now — send a purchase request instead." }, 409);
  const account = str(body?.account, 300);
  const expiry = str(body?.expiry, 8);
  if (!account) return json({ ok: false, error: "Enter your card details." }, 400);
  const name = str(body?.name, 200);
  if (!name) return json({ ok: false, error: "Please enter your name." }, 400);
  const phoneDigits = identity.phoneDigits || str(body?.phone, 40).replace(/\D/g, "").slice(-10);
  if (phoneDigits.length !== 10) return json({ ok: false, error: "Please enter a 10-digit phone number." }, 400);
  const phone = `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
  const email = identity.emailLower || str(body?.email, 200).toLowerCase();
  const message = str(body?.message, 2000);
  const holder = identity.phoneDigits ? `phone:${identity.phoneDigits}` : `email:${identity.emailLower}`;
  const ua = (req.headers.get("user-agent") || "").slice(0, 300);
  const ip = clientIp(req);

  let contactId: string | null = null;
  try {
    const { data } = await admin.rpc("crm_ensure_contact", { p_client_id: clientId, p_name: name, p_phone: phone, p_email: email || null });
    contactId = data ? String(data) : null;
  } catch (e) {
    await logEdgeError({ fn: "shop-checkout", req, clientId, code: "crm_link", message: `purchase contact not linked: ${(e as Error).message}` }).catch(() => {});
  }

  // Everything the estimates are written from: the masters in full, and the names the page shows.
  // deno-lint-ignore no-explicit-any
  const codes = items.map((i: any) => meta.get(i.unitId).u.design_short_code);
  const [{ data: masters }, { data: layout }, { data: elec }] = await Promise.all([
    admin.from("designs").select("short_code, selections, paint_colors, items, custom_options, ro_dimensions, bldg_w, bldg_h, image_url").eq("client_id", clientId).in("short_code", codes),
    admin.from("client_layout_items").select("item_key, label_override").eq("client_id", clientId),
    admin.from("electrical_items").select("id, name").eq("client_id", clientId),
  ]);
  // deno-lint-ignore no-explicit-any
  // deno-lint-ignore no-explicit-any
  const masterBy = new Map<string, any>((masters ?? []).map((m: any) => [m.short_code, m]));
  const names = {
    // deno-lint-ignore no-explicit-any
    layout: Object.fromEntries((layout ?? []).filter((l: any) => l.label_override).map((l: any) => [l.item_key, l.label_override])),
    // deno-lint-ignore no-explicit-any
    electrical: Object.fromEntries((elec ?? []).map((e: any) => [String(e.id), e.name])),
  };
  const CLADDING: Record<string, string> = { lap: "Lap siding", lp: "LP SmartSide", t111: "T1-11 siding", board: "Board & batten", vinyl: "Vinyl siding", metal: "Metal siding" };

  const paid: { label: string; estimateNumber: string; shortCode: string; paidCents: number; surchargeCents: number | null; last4: string | null; brand: string | null; totalCents: number }[] = [];
  let failure: { label: string; error: string; newCardNeeded?: boolean; blocking?: boolean } | null = null;

  for (const it of items) {
    const m = meta.get(it.unitId);
    const master = masterBy.get(m.u.design_short_code);
    const fail = (error: string, extra: Record<string, unknown> = {}) => { failure = { label: it.label, error, ...extra }; };

    // 1. Hold the building. A stale hold (a browser that vanished mid-checkout) may be taken over.
    await admin.from("shop_unit_holds").delete().eq("unit_id", it.unitId).lt("held_at", new Date(Date.now() - HOLD_STALE_MS).toISOString());
    const { error: holdErr } = await admin.from("shop_unit_holds").insert({ unit_id: it.unitId, client_id: clientId, holder });
    if (holdErr) { fail(`Someone else is checking out ${it.label} right now. Try again in a few minutes.`); break; }
    const releaseHold = () => admin.from("shop_unit_holds").delete().eq("unit_id", it.unitId).eq("holder", holder);

    // 2. Still for sale?
    const { data: fresh } = await admin.from("inventory_units").select("sale_state, listed").eq("id", it.unitId).maybeSingle();
    if (!fresh || fresh.sale_state !== "unsold" || !fresh.listed || !master) { await releaseHold(); fail(`${it.label} was just sold.`); break; }

    // 3. The estimate, from exactly the figures the buyer saw — and proven to total the same.
    const sel = master.selections || {};
    const paint = master.paint_colors || {};
    const options: { name: string; desc: string }[] = [];
    if (sel.cladding) options.push({ name: "Siding", desc: CLADDING[sel.cladding] || String(sel.cladding) });
    if (paint.body || paint.trim) options.push({ name: "Paint Colors", desc: [paint.body ? `Body: ${paint.body}` : "", paint.trim ? `Trim: ${paint.trim}` : ""].filter(Boolean).join(", ") });
    if (sel.roofType || sel.roofColor) options.push({ name: "Roof", desc: [sel.roofType, sel.roofColor].filter(Boolean).join(" — ") });
    if (sel.loftPackage && !/^no\b/i.test(String(sel.loftPackage))) options.push({ name: String(sel.loftPackage), desc: "" });
    const snap = purchaseSnapshot({
      buildingName: m.u.public_title || `${m.styleName || "Building"}${sel.size ? ` (${sel.size})` : ""}`,
      serial: m.u.serial, lotName: m.lot?.name ?? null, priceCents: it.priceCents,
      included: includedLines(master.items, names), options,
      deliveryCents: it.deliveryCents, deliveryNote: it.deliveryNote, deliveryTaxable: m.deliveryTaxable,
      tax: it.taxCents != null && m.rate != null
        ? { rate: m.rate, amountCents: it.taxCents, label: m.taxLabel, basis: m.lot?.tax_rate != null ? "location" : "company", locationId: m.lot?.tax_rate != null ? m.lot.id : null }
        : null,
    });
    const oc = orderCentsFromSnapshot(snap);
    if (!oc || oc.totalCents !== it.totalCents) {
      await releaseHold();
      await logEdgeError({ fn: "shop-checkout", req, clientId, code: "purchase_total_mismatch", message: `estimate total ${oc?.totalCents} != shown ${it.totalCents} for unit ${it.unitId}` }).catch(() => {});
      fail("We couldn't confirm the price of this building. Nothing was charged — please send a purchase request.");
      break;
    }
    const { data: qno, error: qErr } = await admin.rpc("allocate_ss_quote_number", { p_client_id: clientId });
    if (qErr || !qno) { await releaseHold(); fail("We couldn't start your order. Nothing was charged — please try again."); break; }

    const code = genShortCode();
    const now = new Date().toISOString();
    const contact = { name, phone, email: email || "", street: address.street || "", city: address.city, state: address.state, zip: address.zip };
    const designRow = {
      short_code: code, client_id: clientId, status: "accepted", contact, contact_id: contactId,
      selections: sel, paint_colors: paint, items: Array.isArray(master.items) ? master.items : [],
      custom_options: master.custom_options ?? [], ro_dimensions: master.ro_dimensions ?? {},
      bldg_w: master.bldg_w, bldg_h: master.bldg_h, image_url: master.image_url ?? null,
      inventory_unit_id: it.unitId, sales_location_id: m.u.location_id ?? null,
      estimate_lines: snap, ss_quote_number: qno, ss_quote_sent_at: now,
      accepted_at: now, accepted_snapshot: { estimateLines: snap, selections: sel, paintColors: paint },
    };
    const undo = async () => {
      await admin.from("design_acceptances").delete().eq("client_id", clientId).eq("short_code", code);
      await admin.from("orders").delete().eq("client_id", clientId).eq("short_code", code);
      await admin.from("design_versions").delete().eq("client_id", clientId).eq("short_code", code);
      await admin.from("designs").delete().eq("client_id", clientId).eq("short_code", code);
      await releaseHold();
    };
    const { error: dErr } = await admin.from("designs").insert(designRow);
    if (dErr) { await releaseHold(); await logEdgeError({ fn: "shop-checkout", req, clientId, code: "purchase_design", message: dErr.message }).catch(() => {}); fail("We couldn't start your order. Nothing was charged — please try again."); break; }
    await admin.from("design_versions").insert({
      short_code: code, client_id: clientId, version: 1, contact, selections: sel, paint_colors: paint,
      items: designRow.items, custom_options: designRow.custom_options, ro_dimensions: designRow.ro_dimensions,
      bldg_w: designRow.bldg_w, bldg_h: designRow.bldg_h, image_url: designRow.image_url, inventory_unit_id: it.unitId,
    });

    // 4. Accepted by the purchase — a click, with the sentence the buyer ticked. Never a signature.
    const acceptanceId = crypto.randomUUID();
    const { error: aErr } = await admin.from("design_acceptances").insert({
      id: acceptanceId, client_id: clientId, short_code: code, subject: "quote", quote_number: qno, design_version: 1,
      total: it.totalCents / 100, ...taxFreeze(snap), method: "click", signer_name: name, typed_signature: null,
      consent_text: consentText, phone_digits: identity.phoneDigits || null, email_lower: identity.emailLower || null,
      session_seen_name: identity.name || null, ip, user_agent: ua, accepted_at: now,
    });
    if (aErr) { await undo(); await logEdgeError({ fn: "shop-checkout", req, clientId, code: "purchase_acceptance", message: aErr.message }).catch(() => {}); fail("We couldn't record your order. Nothing was charged — please try again."); break; }

    // 5. The order.
    await admin.from("orders").upsert({ client_id: clientId, short_code: code, ordered_at: now }, { onConflict: "client_id,short_code", ignoreDuplicates: true });
    await admin.from("orders").update({ total_cents: oc.totalCents, pretax_subtotal_cents: oc.pretaxCents, tax_cents: oc.taxCents, total_source: "manual" })
      .eq("client_id", clientId).eq("short_code", code).is("total_cents", null);
    const { data: order } = await admin.from("orders").select("id").eq("client_id", clientId).eq("short_code", code).maybeSingle();
    if (!order?.id) { await undo(); fail("We couldn't record your order. Nothing was charged — please try again."); break; }

    // 6. The charge. chargeInvoicePayment never throws; it records the payment, and the trigger sells the unit.
    const pay = await chargeInvoicePayment(admin, {
      clientId, merchant: ps.merchant, orderId: order.id, shortCode: code, amountCents: it.dueNowCents, rail: "card",
      account, expiry: expiry || undefined, postal: str(body?.postal, 10) || address.zip.slice(0, 5),
      name, address: str(body?.billingStreet, 200) || address.street || undefined,
      entry: "keyed", actorKind: "customer", actorRef: holder, createdBy: null,
    });
    if (!pay.ok) {
      if (pay.blocking) {
        // Outcome unknown, or charged-but-not-recorded: keep every row; someone must reconcile.
        await logEdgeError({ fn: "shop-checkout", req, clientId, code: "purchase_charge_blocking", message: `unit ${it.unitId} order ${order.id}: ${pay.error}` }).catch(() => {});
        fail(pay.error, { blocking: true });
      } else {
        await undo();
        fail(pay.error, pay.newCardNeeded ? { newCardNeeded: true } : {});
      }
      break;
    }
    await admin.from("shop_unit_holds").delete().eq("unit_id", it.unitId);

    // 7. "Invoice to approve": the builder sends it, the customer signs it.
    await admin.from("invoice_requests").insert({ client_id: clientId, short_code: code, status: "pending", source: "shop_purchase", acceptance_id: acceptanceId, requested_at: now });
    await admin.from("designs").update({ ss_invoice_requested_at: now }).eq("client_id", clientId).eq("short_code", code).is("ss_invoice_requested_at", null);
    paid.push({ label: it.label, estimateNumber: String(qno), shortCode: code, paidCents: pay.amountCents, surchargeCents: pay.surchargeCents, last4: pay.last4, brand: pay.brand, totalCents: it.totalCents });
  }

  if (paid.length) {
    const paidCents = paid.reduce((s, p) => s + p.paidCents, 0);
    const paidItems = items.filter((i: { label: string }) => paid.some((p) => p.label === i.label));
    const { data: row } = await admin.from("shop_requests").insert({
      client_id: clientId, kind: "purchase", contact_id: contactId, name, phone, email: email || null,
      street: address.street || null, city: address.city, state: address.state, zip: address.zip,
      message: message || null, pay_in_full: payInFull, items: paidItems,
      total_cents: paid.reduce((s, p) => s + p.totalCents, 0), due_now_cents: paidCents, paid_cents: paidCents,
      design_codes: paid.map((p) => p.shortCode),
    }).select("id").single();
    if (contactId) {
      const note = [
        `Online Inventory PURCHASE — paid ${usd(paidCents)} by card online. The invoice is waiting for your approval; the customer signs it.`,
        ...paid.map((p) => `• ${p.label}: estimate ${p.estimateNumber}, total ${usd(p.totalCents)}, paid ${usd(p.paidCents)}${p.last4 ? ` (${p.brand || "card"} …${p.last4})` : ""}`),
        `Deliver to: ${[address.street, address.city, address.state, address.zip].filter(Boolean).join(", ")}`,
        message ? `They wrote: "${message}"` : "",
      ].filter(Boolean).join("\n");
      await admin.from("crm_notes").insert({ client_id: clientId, contact_id: contactId, body: note, pinned: true, created_by: null });
    }
    // The builder hears about it the way they hear about a purchase request, with the money on it.
    await notifyBuilder(admin, req, clientId, {
      businessName: business, customerName: name, phone, email: email || null,
      deliverTo: [address.street, address.city, address.state, address.zip].filter(Boolean).join(", "), message: message || null,
      items: paid.map((p) => ({ label: p.label, totalCents: p.totalCents, note: `estimate ${p.estimateNumber} · paid ${usd(p.paidCents)}` })),
      totalCents: paid.reduce((s, p) => s + p.totalCents, 0), dueNowCents: paidCents, payInFull, paidCents,
      reviewUrl: portalOrderUrl(null, req),
    }, row?.id ?? null);
    // The buyer's receipt, from the builder's own sending (sendTenantEmail never throws).
    if (email) {
      const lines = paid.map((p) => `<tr><td style="padding:6px 0">${esc(p.label)}<br><span style="color:#64748B;font-size:12px">Estimate ${esc(p.estimateNumber)}</span></td><td style="padding:6px 0;text-align:right">Paid ${usd(p.paidCents)}<br><span style="color:#64748B;font-size:12px">of ${usd(p.totalCents)}</span></td></tr>`).join("");
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0F172A"><h2 style="margin:0 0 8px">Thank you for your purchase!</h2><p>${esc(business)} has your payment. Nothing else is needed right now — they'll send your invoice to sign, and you'll arrange delivery with them.</p><table style="width:100%;border-collapse:collapse;border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0">${lines}</table><p style="color:#64748B;font-size:13px">Paid by card${paid[0].last4 ? ` ending ${esc(paid[0].last4)}` : ""}. Deliver to ${esc([address.street, address.city, address.state, address.zip].filter(Boolean).join(", "))}.</p></div>`;
      const text = [`Thank you for your purchase!`, `${business} has your payment. They'll send your invoice to sign, and you'll arrange delivery with them.`, "", ...paid.map((p) => `${p.label} (estimate ${p.estimateNumber}): paid ${usd(p.paidCents)} of ${usd(p.totalCents)}`)].join("\n");
      await sendTenantEmail(admin, clientId, { kind: "acceptance", shortCode: paid[0].shortCode, contactId, to: email, subject: `Your purchase from ${business}`, html, text });
    }
  }
  return json({ ok: paid.length > 0 && !failure, paid, failure }, paid.length ? 200 : (failure && (failure as { blocking?: boolean }).blocking ? 502 : 402));
}

/** Email the builder's owners/admins about a purchase request or a paid purchase (customer-accept's
 *  invoice-request pattern: one message each, never an address in a log line, bounded by a timeout
 *  so a slow provider can't hold the shopper). The outcome is written back to the shop_requests row. */
// deno-lint-ignore no-explicit-any
async function notifyBuilder(admin: any, req: Request, clientId: string, input: Parameters<typeof shopRequestEmail>[0], rowId: string | null): Promise<void> {
  let outcome: { sent: number; error: string | null } = { sent: 0, error: "not attempted" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    outcome = await Promise.race([
      (async () => {
        if (!resendConfigured() || Deno.env.get("PLATFORM_EMAIL_DOMAIN_READY") !== "true") return { sent: 0, error: "platform email is not configured" };
        const { data: users } = await admin.from("client_users").select("user_id, role, created_at")
          .eq("client_id", clientId).in("role", ["owner", "admin"]).order("created_at", { ascending: true });
        // deno-lint-ignore no-explicit-any
        const ordered = (users ?? []).slice().sort((x: any, y: any) => (x.role === "owner" ? 0 : 1) - (y.role === "owner" ? 0 : 1));
        const emails = await Promise.all(ordered.slice(0, MAX_RECIPIENTS * 2).map(async (u: { user_id: string }) => {
          try { const { data } = await admin.auth.admin.getUserById(u.user_id); return String(data?.user?.email ?? "").trim().toLowerCase(); } catch { return ""; }
        }));
        const to = [...new Set(emails.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, MAX_RECIPIENTS);
        if (!to.length) return { sent: 0, error: "no owner or admin email on file" };
        const content = shopRequestEmail(input);
        const results = await Promise.allSettled(to.map((addr) => rsSendEmail({
          from: PLATFORM_NOTIFY_FROM, to: addr, subject: content.subject, html: content.html, text: content.text,
          tags: [{ name: "kind", value: input.paidCents != null ? "shop_purchase" : "shop_request" }, { name: "client_id", value: clientId }],
        })));
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (!failed.length) return { sent: to.length, error: null };
        const why = [...new Set(failed.map((r) => r.reason instanceof ResendApiError ? `resend ${r.reason.status}/${r.reason.name_ || "unknown"}` : "send failed"))];
        return { sent: to.length - failed.length, error: `${failed.length} of ${to.length} not sent: ${why.join(", ")}` };
      })(),
      new Promise<{ sent: number; error: string }>((resolve) => { timer = setTimeout(() => resolve({ sent: 0, error: "timed out waiting for the email provider" }), NOTIFY_MS); }),
    ]);
  } catch (_) {
    outcome = { sent: 0, error: "notify failed unexpectedly" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (rowId) {
    await admin.from("shop_requests").update(outcome.sent > 0
      ? { notified_at: new Date().toISOString(), notify_error: outcome.error }
      : { notify_error: outcome.error ?? "not sent" }).eq("id", rowId);
  }
  if (outcome.sent === 0) {
    await logEdgeError({ fn: "shop-checkout", req, clientId, code: "shop_request_notify", message: `builder not emailed about an online inventory ${input.paidCents != null ? "purchase" : "request"}: ${outcome.error ?? "not sent"}` }).catch(() => {});
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));

// deno-lint-ignore no-explicit-any
async function payReady(admin: any, clientId: string): Promise<
  // deno-lint-ignore no-explicit-any
  { ok: true; merchant: any; settings: any } | { ok: false; reason: string }
> {
  const [{ data: shop }, read] = await Promise.all([
    admin.from("shop_settings").select("enabled").eq("client_id", clientId).maybeSingle(),
    readPaymentSettings(admin, clientId, ["billing_exempt", "invoice_in_ghl", "business_name"]),
  ]);
  if (!shop?.enabled) return { ok: false, reason: "shop_off" };
  const row = read.row;
  if (!row || read.error) return { ok: false, reason: "no_settings" };
  if (row.invoice_in_ghl !== false) return { ok: false, reason: "crm_paperwork" };
  if (row.payments_online_enabled !== true) return { ok: false, reason: "payments_off" };
  const merchant = cpMerchant(row);
  if (!merchant) return { ok: false, reason: "no_merchant" };
  if (testModeNeedsExempt(row)) return { ok: false, reason: "test_mode" };
  return { ok: true, merchant, settings: row };
}

Deno.serve(withErrorLog("shop-checkout", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const action = ["request", "purchase", "pay_setup"].includes(body?.action) ? body.action as string : "price";
  const clientId = str(body?.clientId, 64).toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(clientId)) return json({ error: "Unknown builder." }, 404);

  // ── pay_setup: can this builder take a card online, and where is the card frame ─────────
  // Pay first, sign the invoice after (Carolyn 2026-10-17). Online payment needs: the shop on, the
  // builder issuing their own paperwork (invoice_in_ghl false — the invoice the customer signs is
  // ours), card payments switched on with a merchant account, and on Fiserv's TEST system only a
  // non-billable account (paymentSettings.testModeNeedsExempt). Anything else: purchase request.
  if (action === "pay_setup") {
    const adminP = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ps = await payReady(adminP, clientId);
    if (!ps.ok) return json({ ok: false, reason: ps.reason });
    return json({
      ok: true,
      tokenizer: { origin: cpTokenizerOrigin(ps.merchant), cardUrl: cpTokenizerUrl(ps.merchant, "card"), cardHeight: cpTokenizerHeight("card") },
    });
  }
  const unitIds = [...new Set((Array.isArray(body?.unitIds) ? body.unitIds : []).map((x: unknown) => String(x ?? "").trim()).filter((x: string) => UUID.test(x)))] as string[];
  if (!unitIds.length) return json({ error: "Your cart is empty." }, 400);
  if (unitIds.length > MAX_CART) return json({ error: `A cart can hold up to ${MAX_CART} buildings.` }, 400);
  const a = (body?.address && typeof body.address === "object") ? body.address : {};
  const address = { street: str(a.street, 200), city: str(a.city, 100), state: str(a.state, 60), zip: str(a.zip, 12) };
  const payInFullAsked = body?.payInFull === true;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ip = clientIp(req);
  const submits = action === "request" || action === "purchase";
  if (await overCap(admin, `shop-checkout:${action}:ip:${ip}`, submits ? RATE_REQUEST_PER_IP : RATE_PRICE_PER_IP)) {
    return json({ error: "Too many tries right now. Wait a minute and try again." }, 429);
  }
  if (submits && await overCap(admin, `shop-checkout:request:${clientId}`, RATE_REQUEST_PER_TENANT)) {
    await logEdgeError({ fn: "shop-checkout", req, clientId, code: "rate_limited", message: "shop purchase-request cap hit for this builder" }).catch(() => {});
    return json({ error: "Too many requests right now. Wait a minute and try again." }, 429);
  }

  // ── The shop, the builder, the units ───────────────────────────────────────────────────
  const [{ data: shop }, { data: cs }, { data: cfg }] = await Promise.all([
    admin.from("shop_settings").select("*").eq("client_id", clientId).maybeSingle(),
    admin.from("client_settings").select("ss_tax_rate, ss_tax_label, ss_tax_delivery, business_name").eq("client_id", clientId).maybeSingle(),
    admin.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!shop?.enabled || !cfg) return json({ error: "This shop isn't available right now." }, 404);
  if (shop.hide_all_prices) return json({ error: "Please contact us for pricing on these buildings." }, 409);
  const rule = { mode: String(shop.deposit_mode || "percent"), value: Number(shop.deposit_value) || 0 };
  const payInFull = rule.mode === "full" || (payInFullAsked && shop.allow_pay_in_full !== false);

  const { data: units, error: uErr } = await admin.from("inventory_units")
    .select("id, serial, design_short_code, location_id, asking_price_cents, sale_state, sold_at, listed, show_price_online, public_title")
    .eq("client_id", clientId).in("id", unitIds);
  if (uErr) throw new Error(`load units: ${uErr.message}`);
  const byId = new Map((units ?? []).map((u: { id: string }) => [u.id, u]));
  const problems: { unitId: string; reason: string }[] = [];
  // deno-lint-ignore no-explicit-any
  const ok: any[] = [];
  for (const id of unitIds) {
    // deno-lint-ignore no-explicit-any
    const u: any = byId.get(id);
    if (!u || !u.listed) problems.push({ unitId: id, reason: "no_longer_listed" });
    else if (u.sale_state === "sold") problems.push({ unitId: id, reason: "sold" });
    else if (!u.show_price_online || u.asking_price_cents == null) problems.push({ unitId: id, reason: "call_for_price" });
    else ok.push(u);
  }

  // Labels: the public title, else size + the style's catalog label.
  const codes = ok.map((u) => u.design_short_code);
  const lotIds = [...new Set(ok.map((u) => u.location_id).filter(Boolean))];
  const [{ data: masters }, { data: lots }, { data: styles }] = await Promise.all([
    codes.length ? admin.from("designs").select("short_code, selections").eq("client_id", clientId).in("short_code", codes) : Promise.resolve({ data: [] }),
    lotIds.length ? admin.from("builder_locations").select("id, name, tax_rate, tax_label").eq("client_id", clientId).in("id", lotIds) : Promise.resolve({ data: [] }),
    admin.from("building_styles").select("key, label").eq("client_id", clientId),
  ]);
  // deno-lint-ignore no-explicit-any
  const masterBy = new Map((masters ?? []).map((m: any) => [m.short_code, m.selections || {}]));
  // deno-lint-ignore no-explicit-any
  const lotBy = new Map((lots ?? []).map((l: any) => [l.id, l]));
  // deno-lint-ignore no-explicit-any
  const styleBy = new Map((styles ?? []).map((s: any) => [s.key, s.label]));

  const haveAddress = !!(address.city && address.state && /^\d{5}/.test(address.zip));
  const items: PricedItem[] = [];
  // What `purchase` needs beyond the public figures: the unit row, its master's choices, the
  // style's name, the lot, and how delivery and tax were decided — so the estimate it writes is
  // built from exactly the numbers the shopper saw.
  // deno-lint-ignore no-explicit-any
  const meta = new Map<string, { u: any; sel: any; styleName: string; lot: any; deliveryTaxable: boolean; rate: number | null; taxLabel: string }>();
  for (const u of ok) {
    // deno-lint-ignore no-explicit-any
    const sel: any = masterBy.get(u.design_short_code) || {};
    const styleName = sel.style ? (styleBy.get(sel.style) || titleCase(String(sel.style))) : "";
    const label = `#${u.serial} ${u.public_title || [sel.size, styleName].filter(Boolean).join(" ")}`.trim();
    // deno-lint-ignore no-explicit-any
    const lot: any = u.location_id ? lotBy.get(u.location_id) : null;

    let deliveryCents: number | null = null;
    let deliveryNote: string | null = null;
    let deliveryTaxable = !!cs?.ss_tax_delivery;
    if (haveAddress) {
      const q = await quoteDelivery(admin, { clientId, address, repUserId: null, originLocationId: u.location_id || null });
      deliveryTaxable = q.taxable;
      if (!q.configured) deliveryNote = "Delivery priced on your estimate";
      else if (q.amount != null) {
        deliveryCents = Math.round(q.amount * 100);
        deliveryNote = q.miles != null ? `${q.miles} miles from ${q.originName || "our lot"}` : null;
      } else deliveryNote = q.reason === "beyond_last_band" ? "Outside our standard delivery area — we'll price it" : "Delivery priced on your estimate";
    } else deliveryNote = "Add your address to see delivery";

    const rate = lot?.tax_rate != null ? Number(lot.tax_rate) : (cs?.ss_tax_rate != null ? Number(cs.ss_tax_rate) : null);
    const taxLabel = (lot?.tax_rate != null ? lot?.tax_label : cs?.ss_tax_label) || "Sales tax";
    const taxBase = u.asking_price_cents + (deliveryTaxable && deliveryCents ? deliveryCents : 0);
    const taxCents = rate != null && Number.isFinite(rate) ? Math.round(taxBase * rate) : null;
    const totalCents = u.asking_price_cents + (deliveryCents ?? 0) + (taxCents ?? 0);
    meta.set(u.id, { u, sel, styleName, lot, deliveryTaxable, rate, taxLabel });
    items.push({
      unitId: u.id, serial: u.serial, label, lotName: lot?.name ?? null,
      priceCents: u.asking_price_cents, deliveryCents, deliveryNote, taxCents, taxLabel: rate != null ? taxLabel : null,
      totalCents, dueNowCents: dueNow(totalCents, rule, payInFull),
    });
  }
  const totalCents = items.reduce((s, i) => s + i.totalCents, 0);
  const dueNowCents = items.reduce((s, i) => s + i.dueNowCents, 0);
  const business = cfg.company_name || cs?.business_name || clientId;
  const priced = {
    ok: true, items, problems, totalCents, dueNowCents, payInFull, depositMode: rule.mode, depositValue: rule.value,
    allowPayInFull: shop.allow_pay_in_full !== false,
    // The sentence a buyer ticks before paying. Composed HERE, the same way `purchase` composes the
    // one it stores, so the words on screen and the words on file cannot differ.
    consentText: items.length ? purchaseSentence({ business, labels: items.map((i) => i.label), totalCents, dueNowCents, payInFull }) : null,
  };

  if (action === "price") return json(priced);

  if (action === "purchase") {
    return await purchase({ admin, req, clientId, body, address, haveAddress, items, problems, meta, totalCents, dueNowCents, payInFull, business, consentText: priced.consentText, priced });
  }

  // ── request ─────────────────────────────────────────────────────────────────────────────
  if (problems.length) return json({ ...priced, ok: false, error: "Something in your cart changed. Review it and try again." }, 409);
  const name = str(body?.name, 200);
  const phone = str(body?.phone, 40);
  const email = str(body?.email, 200);
  const message = str(body?.message, 2000);
  if (!name) return json({ error: "Please enter your name." }, 400);
  if (phone.replace(/\D/g, "").length < 10) return json({ error: "Please enter a 10-digit phone number." }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email doesn't look right." }, 400);
  if (!haveAddress) return json({ error: "Please enter the delivery city, state and zip." }, 400);

  let contactId: string | null = null;
  try {
    const { data } = await admin.rpc("crm_ensure_contact", { p_client_id: clientId, p_name: name, p_phone: phone, p_email: email || null });
    contactId = data ? String(data) : null;
  } catch (e) {
    await logEdgeError({ fn: "shop-checkout", req, clientId, code: "crm_link", message: `contact not linked: ${(e as Error).message}` }).catch(() => {});
  }

  const { data: row, error: insErr } = await admin.from("shop_requests").insert({
    client_id: clientId, contact_id: contactId, name, phone, email: email || null,
    street: address.street || null, city: address.city, state: address.state, zip: address.zip,
    message: message || null, pay_in_full: payInFull, items, total_cents: totalCents, due_now_cents: dueNowCents,
  }).select("id").single();
  if (insErr) throw new Error(`shop_requests insert: ${insErr.message}`);

  const money = (c: number | null) => (c == null ? "—" : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  if (contactId) {
    const lines = items.map((i) => `• ${i.label}${i.lotName ? " (" + i.lotName + ")" : ""}: ${money(i.priceCents)}`
      + `${i.deliveryCents != null ? " + delivery " + money(i.deliveryCents) : ""}${i.taxCents != null ? " + tax " + money(i.taxCents) : ""} = ${money(i.totalCents)}`);
    const note = [
      `Online Inventory purchase request — nothing charged.`,
      ...lines,
      `Total ${money(totalCents)}; ${payInFull ? "wants to pay in full" : "deposit due " + money(dueNowCents)}.`,
      `Deliver to: ${[address.street, address.city, address.state, address.zip].filter(Boolean).join(", ")}`,
      message ? `They wrote: "${message}"` : "",
    ].filter(Boolean).join("\n");
    const { error: nErr } = await admin.from("crm_notes").insert({ client_id: clientId, contact_id: contactId, body: note, pinned: true, created_by: null });
    if (nErr) await logEdgeError({ fn: "shop-checkout", req, clientId, code: "shop_note", message: `note not filed: ${nErr.message}` }).catch(() => {});
  }

  await notifyBuilder(admin, req, clientId, {
    businessName: cfg.company_name || cs?.business_name || clientId,
    customerName: name, phone, email: email || null,
    deliverTo: [address.street, address.city, address.state, address.zip].filter(Boolean).join(", "),
    message: message || null,
    items: items.map((i) => ({ label: i.label, totalCents: i.totalCents, note: i.lotName ? "on your " + i.lotName + " lot" : null })),
    totalCents, dueNowCents, payInFull,
    reviewUrl: portalInventoryUrl(req),
  }, row.id);
  return json({ ...priced, requestId: row.id });
}));
