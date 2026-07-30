import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";

// capture-lead: called by the PUBLIC designer's name+phone gate. Upserts a GHL contact
// (the lead) into the tenant's GHL location using the tenant's stored creds, so an
// interested visitor becomes a CRM contact the moment they pass the gate — even if they
// never finish/submit a design. BEST-EFFORT: never blocks the gate (returns ok on any GHL
// issue). clientId comes from the body (public endpoint) but is validated against
// client_configs; GHL creds are read service-role from client_settings (never exposed to
// the browser). This mirrors submit-estimate's existing anon->GHL exposure; rate-limiting
// is a recommended hardening follow-up.

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
    .select("id, email, street, city, state, zip, ghl_contact_id, source")
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
