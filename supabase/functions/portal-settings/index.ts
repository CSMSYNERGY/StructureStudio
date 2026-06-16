import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Owner-facing settings endpoint for the portal (portal.html).
//
// Auth model: the gateway's verify_jwt only proves the caller holds *a* valid JWT —
// the public anon key passes that check too. So this function additionally resolves
// a real signed-in user via auth.getUser(), then maps user → client through the
// client_users table (service role). The client_id is NEVER taken from the request
// body; an owner can only ever read/write their own tenant's settings.
//
// Actions:
//   { action: "status" } → current settings, with the GHL API key reduced to a
//     hasApiKey boolean and the location id masked. Secrets never leave the server.
//   { action: "save", ...fields } → partial upsert of client_settings. Only fields
//     present in the body are written; an absent or empty ghlApiKey never blanks a
//     stored key (the form's password field submits empty when untouched).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function maskId(v: string | null): string | null {
  if (!v) return null;
  return v.length > 8 ? v.slice(0, 4) + "…" + v.slice(-4) : v.slice(0, 2) + "…";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Real user check (the bare anon key passes the gateway but has no user).
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not signed in." }, 401);

  // 2. Resolve the caller's tenant. Service role: client_users has no write
  //    policies and this lookup must not depend on the caller's own claims.
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: mapping, error: mapErr } = await admin
    .from("client_users")
    .select("client_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (mapErr) return json({ error: mapErr.message }, 500);
  if (!mapping) return json({ error: "No business is linked to this account." }, 403);
  const clientId: string = mapping.client_id;

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const action = payload?.action || "status";

  if (action === "status") {
    const { data, error } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key, ghl_pipeline_id, ghl_stage_send_quote_id, business_name, business_phone, business_website, business_address, business_logo_url, quote_terms, beta_mode, beta_email, updated_at")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    // Designer branding lives in client_configs (drives the public ?client= link).
    const { data: cfg } = await admin
      .from("client_configs")
      .select("company_name, tagline, logo_url, accent_color, header_bg")
      .eq("client_id", clientId)
      .maybeSingle();
    return json({
      ok: true,
      clientId,
      role: mapping.role,
      configured: Boolean(data?.ghl_location_id && data?.ghl_api_key),
      ghlLocationIdMasked: maskId(data?.ghl_location_id ?? null),
      hasApiKey: Boolean(data?.ghl_api_key),
      ghlPipelineId: data?.ghl_pipeline_id ?? null,
      ghlStageSendQuoteId: data?.ghl_stage_send_quote_id ?? null,
      businessName: data?.business_name ?? null,
      businessPhone: data?.business_phone ?? null,
      businessWebsite: data?.business_website ?? null,
      businessAddress: data?.business_address ?? null,
      businessLogoUrl: data?.business_logo_url ?? null,
      quoteTerms: data?.quote_terms ?? null,
      betaMode: Boolean(data?.beta_mode),
      betaEmail: data?.beta_email ?? null,
      updatedAt: data?.updated_at ?? null,
      // designer branding (client_configs)
      branding: {
        companyName: cfg?.company_name ?? null,
        tagline: cfg?.tagline ?? null,
        logoUrl: cfg?.logo_url ?? null,
        accentColor: cfg?.accent_color ?? null,
        headerBg: cfg?.header_bg ?? null,
      },
    });
  }

  if (action === "save") {
    const updates: Record<string, unknown> = {};
    const trimOrNull = (v: unknown) => {
      const s = String(v ?? "").trim();
      return s ? s : null;
    };
    // Text fields: present in body → written (empty string clears to null).
    if ("ghlLocationId" in payload) updates.ghl_location_id = trimOrNull(payload.ghlLocationId);
    if ("ghlPipelineId" in payload) updates.ghl_pipeline_id = trimOrNull(payload.ghlPipelineId);
    if ("ghlStageSendQuoteId" in payload) updates.ghl_stage_send_quote_id = trimOrNull(payload.ghlStageSendQuoteId);
    if ("businessName" in payload) updates.business_name = trimOrNull(payload.businessName);
    if ("businessPhone" in payload) updates.business_phone = trimOrNull(payload.businessPhone);
    if ("businessWebsite" in payload) updates.business_website = trimOrNull(payload.businessWebsite);
    if ("businessLogoUrl" in payload) updates.business_logo_url = trimOrNull(payload.businessLogoUrl);
    if ("quoteTerms" in payload) updates.quote_terms = trimOrNull(payload.quoteTerms);
    if ("betaEmail" in payload) updates.beta_email = trimOrNull(payload.betaEmail);
    if ("betaMode" in payload) updates.beta_mode = Boolean(payload.betaMode);
    if ("businessAddress" in payload) {
      const a = payload.businessAddress;
      updates.business_address = a && typeof a === "object" ? a : null;
    }
    // Write-only secret: only overwritten when a non-empty value is sent.
    if (typeof payload.ghlApiKey === "string" && payload.ghlApiKey.trim()) {
      updates.ghl_api_key = payload.ghlApiKey.trim();
    }

    if (Object.keys(updates).length === 0) return json({ error: "Nothing to save." }, 400);
    updates.client_id = clientId;
    updates.updated_at = new Date().toISOString();

    const { error: upErr } = await admin
      .from("client_settings")
      .upsert(updates, { onConflict: "client_id" });
    if (upErr) return json({ error: `Save failed: ${upErr.message}` }, 500);
    return json({ ok: true });
  }

  // Designer branding save → writes client_configs (the public ?client= link).
  // Optionally uploads a logo image (base64) to the public 'branding' bucket.
  if (action === "save_branding") {
    const trimOrNull = (v: unknown) => { const s = String(v ?? "").trim(); return s ? s : null; };
    const updates: Record<string, unknown> = {};
    if ("companyName" in payload) updates.company_name = trimOrNull(payload.companyName);
    if ("tagline" in payload)     updates.tagline      = trimOrNull(payload.tagline);
    if ("accentColor" in payload) updates.accent_color = trimOrNull(payload.accentColor);
    if ("headerBg" in payload)    updates.header_bg    = trimOrNull(payload.headerBg);

    if (typeof payload.logoBase64 === "string" && payload.logoBase64.trim()) {
      const raw = payload.logoBase64.replace(/^data:[^;]+;base64,/, "");
      const ct = String(payload.logoContentType || "image/png");
      const ext = (ct.split("/")[1] || "png").split("+")[0].replace(/[^a-z0-9]/gi, "") || "png";
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); }
      catch { return json({ error: "Invalid logo data." }, 400); }
      if (bytes.length > 2_000_000) return json({ error: "Logo too large (max 2MB)." }, 400);
      const path = `${clientId}/logo-${Date.now()}.${ext}`;
      const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
      if (up.error) return json({ error: `Logo upload failed: ${up.error.message}` }, 500);
      const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
      updates.logo_url = pub.publicUrl;
    } else if ("logoUrl" in payload) {
      updates.logo_url = trimOrNull(payload.logoUrl); // allow setting/clearing by URL
    }

    if (Object.keys(updates).length === 0) return json({ error: "Nothing to save." }, 400);
    const { error: upErr } = await admin.from("client_configs").update(updates).eq("client_id", clientId);
    if (upErr) return json({ error: `Save failed: ${upErr.message}` }, 500);
    return json({ ok: true, logoUrl: updates.logo_url ?? null });
  }

  // Upload-only: store an image in the 'branding' bucket and return its public
  // URL (no DB write). Used by the "Upload image" buttons; the returned URL is
  // placed into a form field and persisted by the normal save action.
  if (action === "upload_logo") {
    if (typeof payload.logoBase64 !== "string" || !payload.logoBase64.trim()) return json({ error: "No logo data." }, 400);
    const raw = payload.logoBase64.replace(/^data:[^;]+;base64,/, "");
    const ct = String(payload.logoContentType || "image/png");
    const ext = (ct.split("/")[1] || "png").split("+")[0].replace(/[^a-z0-9]/gi, "") || "png";
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); }
    catch { return json({ error: "Invalid logo data." }, 400); }
    if (bytes.length > 2_000_000) return json({ error: "Logo too large (max 2MB)." }, 400);
    const prefix = payload.kind === "business" ? "biz-logo" : "logo";
    const path = `${clientId}/${prefix}-${Date.now()}.${ext}`;
    const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
    if (up.error) return json({ error: `Logo upload failed: ${up.error.message}` }, 500);
    const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
    return json({ ok: true, url: pub.publicUrl });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
});
