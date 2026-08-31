import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { clientIp } from "../_shared/adminGate.ts";

// capture-lead: called by the PUBLIC designer's name+phone gate. Upserts a GHL contact
// (the lead) into the tenant's GHL location using the tenant's stored creds, so an
// interested visitor becomes a CRM contact the moment they pass the gate — even if they
// never finish/submit a design. BEST-EFFORT: never blocks the gate (returns ok on any GHL
// issue). clientId comes from the body (public endpoint) but is validated against
// client_configs; GHL creds are read service-role from client_settings (never exposed to
// the browser). This mirrors submit-estimate's existing anon->GHL exposure.
//
// RATE LIMITED per tenant since 2026-07-30 — see RATE_* below. Before that, anyone holding
// the public anon key could drive unlimited contact upserts into ANY configured tenant's
// GHL location. The real damage was never table growth: it was burning the tenant's GHL
// rate budget and polluting their CRM.

// ── Abuse guards (two, because there are two different attacks) ──────────────
// GUARD 1 — per-tenant volume cap. Counts captured_leads rows updated inside the window,
// index-backed by `captured_leads_client (client_id, updated_at DESC)`. This catches the
// damaging shape: MANY DIFFERENT phones, which grows the table and floods the tenant's CRM
// with junk contacts.
//
// It does NOT catch one phone hammered — that is a single row, so the count stays at 1 no
// matter how many requests arrive. Guard 2 exists for exactly that, because a row count can
// never see it.
//
// Deliberately no GLOBAL cap. The vulnerability is per-tenant (whose GHL budget is burned),
// and a global cap needs an `updated_at`-only scan with no index to serve it — a seq scan on
// every public request, which becomes its own DoS surface as the table grows. Per-tenant,
// multiplied by the tenant count, already bounds the total.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_TENANT = 30;   // generous: a real gate sees single digits per minute
// A breach logs only while the count sits in [MAX, MAX+2], so a sustained flood writes ~3
// rows per window instead of one per request. app_errors has NO fingerprint dedupe in this
// project (unlike BuildBridge and Framed-UP), so self-limiting here is the only thing
// stopping an attacker from turning our own error log into the amplification.
const RATE_LOG_CEILING = RATE_MAX_PER_TENANT + 2;

// GUARD 2 — per-lead debounce, which is what actually stops one phone being hammered.
// If this exact (tenant, phone) was captured moments ago AND this request carries nothing
// new, the outbound GHL upsert would be a no-op write of identical data, so skip it.
// Enrichment is explicitly preserved: the gate sends name+phone, and the later Details-open
// capture adds email/address — that request DOES carry something new, so it always goes
// through regardless of how recent the previous one was.
const LEAD_DEBOUNCE_MS = 15_000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(withErrorLog("capture-lead", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 200) : "";
  const phoneRaw = typeof body?.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  const email = typeof body?.email === "string" ? body.email.trim().slice(0, 200) : "";
  // Optional address — sent by the designer's silent Details-open capture, where the
  // visitor has just filled the whole contact form. All best-effort, same as email.
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const street = str(body?.street, 200);
  const city = str(body?.city, 100);
  const state = str(body?.state, 60);
  const zip = str(body?.zip, 12);
  const phoneDigits = phoneRaw.replace(/\D/g, "");

  // ── SMS consent, from the public gate's checkbox ──────────────────────────
  // ⚠️ The DISCLOSURE SENTENCE IS STORED VERBATIM, not a template id. The wording will be
  // edited; today's copy is not evidence of what was on screen last March, and the whole
  // value of a consent record is being able to show exactly what someone agreed to.
  //
  // ⚠️ Consent is OPTIONAL at the gate — it is a lead-gen funnel, and blocking the designer
  // on a texting opt-in would cost the builder leads. So `false` here is the normal case,
  // not a failure, and it simply records nothing.
  const smsConsent = body?.smsConsent === true;
  const consentText = typeof body?.consentText === "string" ? body.consentText.trim().slice(0, 1000) : "";
  const consentUrl = typeof body?.consentUrl === "string" ? body.consentUrl.trim().slice(0, 500) : "";

  // Basic validation — don't spam the CRM with empty/garbage. Not fatal: skip quietly.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) return json({ ok: false, skipped: "bad_client" });
  if (!name || phoneDigits.length < 10) return json({ ok: false, skipped: "incomplete" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Validate the tenant exists (same guard the public RPCs use).
  const { data: cfg } = await sb.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
  if (!cfg) return json({ ok: false, skipped: "unknown_client" });

  // ── Local record FIRST (migration 062) ─────────────────────────────────────────
  // The portal's browsing-leads view reads THIS table, so a lead must exist here even when
  // GHL is unconfigured, down, or rejects the upsert — previously those leads evaporated.
  // One row per (tenant, phone); later captures ENRICH, never blank: the gate sends only
  // name+phone, and a Details-open capture adds email/address onto the same row. COALESCE
  // against the existing row so the fuller value always wins over an empty resend.
  const source = body?.source === "details" ? "details" : "gate";
  const { data: existingLead } = await sb.from("captured_leads")
    .select("id, name, email, street, city, state, zip, ghl_contact_id, source, updated_at")
    .eq("client_id", clientId).eq("phone_digits", phoneDigits).maybeSingle();
  const leadRow = {
    client_id: clientId,
    name,
    phone_digits: phoneDigits,
    phone: phoneRaw,
    email: email || existingLead?.email || null,
    street: street || existingLead?.street || null,
    city: city || existingLead?.city || null,
    state: state || existingLead?.state || null,
    zip: zip || existingLead?.zip || null,
    // 'details' outranks 'gate': it means they went as far as asking for prices.
    source: source === "details" || existingLead?.source === "details" ? "details" : "gate",
    ghl_contact_id: existingLead?.ghl_contact_id || null,
    updated_at: new Date().toISOString(),
  };
  const { data: savedLead, error: leadErr } = await sb.from("captured_leads")
    .upsert(leadRow, { onConflict: "client_id,phone_digits" })
    .select("id").maybeSingle();
  if (leadErr) {
    // The local row is the one the tenant SEES — its failure is worth a durable error even
    // though the GHL leg below may still succeed.
    await logEdgeError({ fn: "capture-lead", req, clientId, code: "local_upsert",
      message: `captured_leads upsert failed: ${leadErr.message}` });
  }

  // ── The consent record ────────────────────────────────────────────────────
  // Keyed on the PHONE, not the lead row: consent belongs to the person and has to survive
  // their contact being merged, renamed or re-created. Append-only — a later opt-out is a
  // second row, never an edit of this one, so the history stays readable.
  //
  // ⚠️ REFUSED WITHOUT THE SENTENCE. A consent record that cannot say what was shown is not
  // evidence, so a `true` flag with no text is dropped rather than stored as a half-record
  // that looks like proof until someone reads it.
  if (smsConsent && consentText && phoneDigits.length >= 10) {
    const tenDigits = phoneDigits.length === 11 && phoneDigits.startsWith("1")
      ? phoneDigits.slice(1) : phoneDigits.slice(-10);
    const { error: consentErr } = await sb.from("sms_consent_log").insert({
      client_id: clientId,
      phone_digits: tenDigits,
      action: "granted",
      source: "web_form",
      disclosure_text: consentText,
      consent_url: consentUrl || null,
      ip: clientIp(req),
      user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
      detail: { name: name || null, leadId: savedLead?.id ?? null },
    });
    if (consentErr) {
      // Worth a durable row: a consent we failed to record is a text we later cannot justify
      // sending. ⚠️ No phone digits in the message — the PII rule this function already keeps.
      await logEdgeError({ fn: "capture-lead", req, clientId, code: "consent_insert",
        message: `sms_consent_log insert failed: ${consentErr.message}` });
    }
    // The opt-out ledger is deliberately NOT touched here. Granting consent must never clear
    // an earlier STOP — that instruction outranks a checkbox on a later visit, and quietly
    // un-blocking someone who asked us to stop is the one mistake with a statutory penalty.
  }

  // ── GUARD 2: per-lead debounce (the same-phone flood) ───────────────────────
  // Computed from the row as it was BEFORE the upsert above, which is why `existingLead` is
  // captured earlier. "Adds nothing new" is judged field by field against that snapshot: a
  // repeat of identical name+phone is a no-op to GHL, whereas a Details capture arriving
  // seconds later brings email/address and must not be suppressed.
  if (existingLead?.updated_at) {
    const sinceLast = Date.now() - Date.parse(existingLead.updated_at);
    const addsSomething =
      (!!email && email !== (existingLead.email || "")) ||
      (!!street && street !== (existingLead.street || "")) ||
      (!!city && city !== (existingLead.city || "")) ||
      (!!state && state !== (existingLead.state || "")) ||
      (!!zip && zip !== (existingLead.zip || "")) ||
      (!!name && name !== (existingLead.name || "")) ||
      (source === "details" && existingLead.source !== "details");
    if (Number.isFinite(sinceLast) && sinceLast >= 0 && sinceLast < LEAD_DEBOUNCE_MS && !addsSomething) {
      // No log: this is the ordinary double-fire case (a visitor re-submitting the gate, a
      // double-click, a retry) as much as it is abuse. Logging it would be noise.
      return json({ ok: true, captured: false, reason: "debounced" });
    }
  }

  // ── GUARD 1: per-tenant volume cap, AFTER the local row and BEFORE the GHL leg ──
  // Order is deliberate. A legitimate lead arriving during someone else's flood must still
  // land in captured_leads (the tenant's own view of it), so the cap only ever suppresses
  // the OUTBOUND GHL write — the part that costs the tenant their API budget and pollutes
  // their CRM. And it returns ok:true like every other soft path here: the public gate must
  // never block, so a cap breach is invisible to the visitor by design.
  {
    const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const { count, error: rateErr } = await sb.from("captured_leads")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId).gt("updated_at", since);
    // A failed count must not become a free pass OR an outage: fall through and allow.
    // Failing closed here would let one bad query silence a tenant's lead capture entirely.
    if (!rateErr && (count ?? 0) > RATE_MAX_PER_TENANT) {
      if ((count ?? 0) <= RATE_LOG_CEILING) {
        await logEdgeError({
          fn: "capture-lead", req, clientId, code: "rate_limited",
          message: `capture-lead rate cap hit — ${count} captures in ${RATE_WINDOW_MS / 1000}s; ` +
                   `GHL upsert skipped, lead saved locally`,
          context: { count, limit: RATE_MAX_PER_TENANT, windowMs: RATE_WINDOW_MS },
        });
      }
      return json({ ok: true, captured: false, reason: "rate_limited" });
    }
  }

  // GHL creds (service-role only). If unset the lead still exists locally — skip quietly.
  const { data: settings } = await sb.from("client_settings")
    .select("ghl_location_id, ghl_api_key").eq("client_id", clientId).maybeSingle();
  const locationId = settings?.ghl_location_id || "";
  const apiKey = settings?.ghl_api_key || "";
  if (!locationId || !apiKey) return json({ ok: true, captured: false, reason: "ghl_not_configured" });

  try {
    const r = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: {
        "Version": "2021-07-28",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        name,
        phone: phoneRaw,
        ...(email ? { email } : {}),
        ...(street ? { address1: street } : {}),
        ...(city ? { city } : {}),
        ...(state ? { state } : {}),
        ...(zip ? { postalCode: zip } : {}),
        locationId,
        source: "StructureStudio Designer",
        tags: ["structurestudio-lead"],
      }),
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      console.warn("capture-lead: GHL upsert non-OK", r.status, detail);
      // Logged explicitly: this returns HTTP 200 by design (the gate must never block),
      // so withErrorLog cannot see it — yet a lead was just lost.
      await logEdgeError({
        fn: "capture-lead", req, clientId, code: `ghl_${r.status}`,
        message: `GHL contact upsert failed (${r.status}) — lead saved locally only`,
        context: { ghlStatus: r.status, ghlBody: detail },
      });
      return json({ ok: true, captured: false, reason: `ghl_${r.status}` });
    }
    const d = await r.json();
    const contactId = (d && d.contact && d.contact.id) || null;
    // Link the local row to the CRM contact — the portal shows this as "in your CRM".
    if (contactId && savedLead) {
      await sb.from("captured_leads").update({ ghl_contact_id: contactId }).eq("id", savedLead.id)
        .then(() => undefined, () => undefined);
    }
    return json({ ok: true, captured: true, contactId });
  } catch (e) {
    console.warn("capture-lead: GHL upsert error", (e as Error).message);
    await logEdgeError({
      fn: "capture-lead", req, clientId, code: "ghl_error",
      message: `GHL contact upsert threw — lead saved locally only: ${(e as Error).message}`,
    });
    return json({ ok: true, captured: false, reason: "ghl_error" });
  }
}));
