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
import { portalInventoryUrl } from "../_shared/customerPortalUrl.ts";
import { dueNow } from "../_shared/shopPricing.ts";

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

Deno.serve(withErrorLog("shop-checkout", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const action = body?.action === "request" ? "request" : "price";
  const clientId = str(body?.clientId, 64).toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(clientId)) return json({ error: "Unknown builder." }, 404);
  const unitIds = [...new Set((Array.isArray(body?.unitIds) ? body.unitIds : []).map((x: unknown) => String(x ?? "").trim()).filter((x: string) => UUID.test(x)))] as string[];
  if (!unitIds.length) return json({ error: "Your cart is empty." }, 400);
  if (unitIds.length > MAX_CART) return json({ error: `A cart can hold up to ${MAX_CART} buildings.` }, 400);
  const a = (body?.address && typeof body.address === "object") ? body.address : {};
  const address = { street: str(a.street, 200), city: str(a.city, 100), state: str(a.state, 60), zip: str(a.zip, 12) };
  const payInFullAsked = body?.payInFull === true;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ip = clientIp(req);
  if (await overCap(admin, `shop-checkout:${action}:ip:${ip}`, action === "request" ? RATE_REQUEST_PER_IP : RATE_PRICE_PER_IP)) {
    return json({ error: "Too many tries right now. Wait a minute and try again." }, 429);
  }
  if (action === "request" && await overCap(admin, `shop-checkout:request:${clientId}`, RATE_REQUEST_PER_TENANT)) {
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
    items.push({
      unitId: u.id, serial: u.serial, label, lotName: lot?.name ?? null,
      priceCents: u.asking_price_cents, deliveryCents, deliveryNote, taxCents, taxLabel: rate != null ? taxLabel : null,
      totalCents, dueNowCents: dueNow(totalCents, rule, payInFull),
    });
  }
  const totalCents = items.reduce((s, i) => s + i.totalCents, 0);
  const dueNowCents = items.reduce((s, i) => s + i.dueNowCents, 0);
  const priced = { ok: true, items, problems, totalCents, dueNowCents, payInFull, depositMode: rule.mode, depositValue: rule.value, allowPayInFull: shop.allow_pay_in_full !== false };

  if (action === "price") return json(priced);

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

  // Email the owners/admins (customer-accept's invoice-request pattern: one message each, never
  // an address in a log line, bounded by a timeout so a slow provider can't hold the shopper).
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
        const content = shopRequestEmail({
          businessName: cfg.company_name || cs?.business_name || clientId,
          customerName: name, phone, email: email || null,
          deliverTo: [address.street, address.city, address.state, address.zip].filter(Boolean).join(", "),
          message: message || null,
          items: items.map((i) => ({ label: i.label, totalCents: i.totalCents, note: i.lotName ? "on your " + i.lotName + " lot" : null })),
          totalCents, dueNowCents, payInFull,
          reviewUrl: portalInventoryUrl(req),
        });
        const results = await Promise.allSettled(to.map((addr) => rsSendEmail({
          from: PLATFORM_NOTIFY_FROM, to: addr, subject: content.subject, html: content.html, text: content.text,
          tags: [{ name: "kind", value: "shop_request" }, { name: "client_id", value: clientId }],
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
  await admin.from("shop_requests").update(outcome.sent > 0
    ? { notified_at: new Date().toISOString(), notify_error: outcome.error }
    : { notify_error: outcome.error ?? "not sent" }).eq("id", row.id);
  if (outcome.sent === 0) {
    await logEdgeError({ fn: "shop-checkout", req, clientId, code: "shop_request_notify", message: `builder not emailed about a purchase request: ${outcome.error ?? "not sent"}` }).catch(() => {});
  }
  return json({ ...priced, requestId: row.id });
}));
