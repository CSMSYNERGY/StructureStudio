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

// Shared CSV pricing + inclusion importer (mirror of admin-catalog's). rows:
// [{ style, width, length, price, active, inclusions: { item_key: qty } }].
// Inclusion cells are QUANTITIES (2026-07-07): loft = included sq ft (e.g. 50),
// doors = count (e.g. 1); 0/blank/"no" = not included. Legacy yes-style tokens
// still import as quantity 1 so previously downloaded sheets keep working.
// clientId is the JWT-resolved tenant — never trusted from the request body.
// CREATES the size if a (style, width, length) doesn't exist yet, otherwise UPDATES
// it — keyed on dimensions, so re-uploading the same sheet updates prices without
// creating duplicates. A size is offered only when active AND priced (blank price or
// active=no hides it, per the NULL-base-price contract). Never creates styles.
async function importPricingRows(sb: any, clientId: string, rows: any[]) {
  const st = await sb.from("building_styles").select("id, key, label").eq("client_id", clientId);
  if (st.error) throw st.error;
  const sz = await sb.from("building_sizes").select("id, style_id, width_ft, length_ft, sort_order").eq("client_id", clientId);
  if (sz.error) throw sz.error;
  const styleByName = new Map<string, any>();
  for (const s of st.data ?? []) { styleByName.set(String(s.label).toLowerCase(), s); styleByName.set(String(s.key).toLowerCase(), s); }
  const sizeByDims = new Map<string, any>();   // `${style_id}|${w}|${l}` -> row
  const maxSort = new Map<string, number>();   // style_id -> highest sort_order
  for (const z of sz.data ?? []) {
    const zw = Number(z.width_ft), zl = Number(z.length_ft);
    sizeByDims.set(`${z.style_id}|${zw}|${zl}`, { id: z.id });
    const cur = maxSort.get(z.style_id) ?? -1;
    if ((z.sort_order ?? 0) > cur) maxSort.set(z.style_id, z.sort_order ?? 0);
  }
  // Inclusion cell -> included quantity. 0 = not included (delete the row).
  // Numbers win ("50" -> 50 sq ft, "2" -> 2); legacy yes-tokens mean quantity 1;
  // anything else (blank, "no", garbage) is 0 — same delete behavior as before.
  const parseInclusionQty = (v: unknown): number => {
    if (v === true) return 1;
    const s = String(v ?? "").trim().toLowerCase();
    if (s === "") return 0;
    if (["yes", "y", "true", "x", "included"].includes(s)) return 1;
    const n = Number(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const isLegacyYes = (v: unknown) => v === true || ["yes", "y", "true", "x", "included"].includes(String(v ?? "").trim().toLowerCase());
  // Existing inclusion quantities: a legacy "yes" cell (old saved sheet) PRESERVES a
  // configured qty (e.g. loft 50 sq ft) instead of silently downgrading it to 1.
  const existingQty = new Map<string, number>();   // `${size_id}|${item_key}` -> qty
  const exq = await sb.from("building_size_inclusions").select("size_id, item_key, qty").eq("client_id", clientId);
  if (exq.error) throw exq.error;
  for (const r of exq.data ?? []) existingQty.set(`${r.size_id}|${r.item_key}`, Number(r.qty) || 1);
  const inactiveWord = (v: unknown) => ["no", "n", "0", "false", "inactive"].includes(String(v ?? "").trim().toLowerCase());
  const num = (v: unknown) => { const blank = v === "" || v == null; if (blank) return { blank: true, n: NaN }; return { blank: false, n: Number(String(v).replace(/[$,\s]/g, "")) }; };
  const fmt = (n: number) => String(n);
  let created = 0, updated = 0; const skipped: string[] = [];
  for (const row of rows) {
    const styleName = String(row?.style ?? "").trim();
    const wv = num(row?.width), lv = num(row?.length);
    if (!styleName && wv.blank && lv.blank) continue;   // wholly blank line
    const style = styleByName.get(styleName.toLowerCase());
    if (!style) { skipped.push(`${styleName || "(blank)"}: unknown style`); continue; }
    if (wv.blank && lv.blank) { skipped.push(`${styleName}: missing width & length`); continue; }
    if (!Number.isFinite(wv.n) || !Number.isFinite(lv.n) || wv.n <= 0 || lv.n <= 0) {
      skipped.push(`${styleName} ${row?.width}x${row?.length}: invalid width/length`); continue;
    }
    const w = wv.n, l = lv.n;
    const pr = num(row?.price);
    if (!pr.blank && !Number.isFinite(pr.n)) { skipped.push(`${styleName} ${w}x${l}: invalid price "${row?.price}"`); continue; }
    const price = pr.blank ? null : pr.n;
    const active = !inactiveWord(row?.active) && price != null;   // active intent AND priced
    const label = `${fmt(w)}x${fmt(l)}`;
    const dimKey = `${style.id}|${w}|${l}`;
    let sizeId: string;
    const existing = sizeByDims.get(dimKey);
    if (existing) {
      const up = await sb.from("building_sizes").update({ label, base_price: price, active }).eq("id", existing.id);
      if (up.error) { skipped.push(`${styleName} ${label}: ${up.error.message}`); continue; }
      sizeId = existing.id; updated++;
    } else {
      const nextSort = (maxSort.get(style.id) ?? -1) + 1; maxSort.set(style.id, nextSort);
      const insv = await sb.from("building_sizes").insert(
        { client_id: clientId, style_id: style.id, label, width_ft: w, length_ft: l,
          base_price: price, active, sort_order: nextSort }).select("id").maybeSingle();
      if (insv.error) { skipped.push(`${styleName} ${label}: ${insv.error.message}`); continue; }
      sizeId = insv.data!.id; sizeByDims.set(dimKey, { id: sizeId }); created++;
    }
    const inc = (row.inclusions && typeof row.inclusions === "object") ? row.inclusions : {};
    for (const [itemKey, val] of Object.entries(inc)) {
      if (!itemKey) continue;
      let qty = parseInclusionQty(val);
      if (qty === 1 && isLegacyYes(val)) qty = existingQty.get(`${sizeId}|${itemKey}`) ?? 1;
      const incRes = qty > 0
        ? await sb.from("building_size_inclusions").upsert({ client_id: clientId, size_id: sizeId, item_key: itemKey, included: true, qty }, { onConflict: "size_id,item_key" })
        : await sb.from("building_size_inclusions").delete().eq("size_id", sizeId).eq("item_key", itemKey);
      if (incRes.error) skipped.push(`${styleName} ${label} / ${itemKey}: ${incRes.error.message}`);
    }
  }
  return { imported: created + updated, created, updated, skipped };
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

  // Authorization: any linked account may READ (status/catalog), but only the
  // tenant owner/admin may MUTATE. The portal UI hides the settings/pricing/colors
  // tabs for role "user", but that is a client-only control — a direct POST would
  // bypass it — so the gate must also live here (server-side).
  const READ_ACTIONS = new Set(["status", "catalog", "contact_activity"]);
  if (!READ_ACTIONS.has(action) && mapping.role !== "owner" && mapping.role !== "admin") {
    return json({ error: "Your account can view designs and leads but not change settings. Ask an owner or admin." }, 403);
  }

  if (action === "status") {
    const { data, error } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key, ghl_pipeline_id, ghl_stage_send_quote_id, ghl_stage_accepted_id, ghl_stage_invoiced_id, ghl_stage_delivered_id, business_name, business_phone, business_website, business_address, business_logo_url, quote_terms, beta_mode, beta_email, show_pricing, updated_at")
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
      ghlStageAcceptedId: data?.ghl_stage_accepted_id ?? null,
      ghlStageInvoicedId: data?.ghl_stage_invoiced_id ?? null,
      ghlStageDeliveredId: data?.ghl_stage_delivered_id ?? null,
      businessName: data?.business_name ?? null,
      businessPhone: data?.business_phone ?? null,
      businessWebsite: data?.business_website ?? null,
      businessAddress: data?.business_address ?? null,
      businessLogoUrl: data?.business_logo_url ?? null,
      quoteTerms: data?.quote_terms ?? null,
      betaMode: Boolean(data?.beta_mode),
      betaEmail: data?.beta_email ?? null,
      showPricing: Boolean(data?.show_pricing),
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
    if ("ghlStageAcceptedId" in payload) updates.ghl_stage_accepted_id = trimOrNull(payload.ghlStageAcceptedId);
    if ("ghlStageInvoicedId" in payload) updates.ghl_stage_invoiced_id = trimOrNull(payload.ghlStageInvoicedId);
    if ("ghlStageDeliveredId" in payload) updates.ghl_stage_delivered_id = trimOrNull(payload.ghlStageDeliveredId);
    if ("businessName" in payload) updates.business_name = trimOrNull(payload.businessName);
    if ("businessPhone" in payload) updates.business_phone = trimOrNull(payload.businessPhone);
    if ("businessWebsite" in payload) updates.business_website = trimOrNull(payload.businessWebsite);
    if ("businessLogoUrl" in payload) updates.business_logo_url = trimOrNull(payload.businessLogoUrl);
    if ("quoteTerms" in payload) updates.quote_terms = trimOrNull(payload.quoteTerms);
    if ("betaEmail" in payload) updates.beta_email = trimOrNull(payload.betaEmail);
    if ("betaMode" in payload) updates.beta_mode = Boolean(payload.betaMode);
    if ("showPricing" in payload) updates.show_pricing = Boolean(payload.showPricing);
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
      const EXT_BY_CT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
      const ext = EXT_BY_CT[ct];
      if (!ext) return json({ error: "Unsupported image type (use PNG, JPG, WEBP or GIF)." }, 400);
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
    const EXT_BY_CT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
    const ext = EXT_BY_CT[ct];
    if (!ext) return json({ error: "Unsupported image type (use PNG, JPG, WEBP or GIF)." }, 400);
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

  // Per-client catalog for the CSV/pricing UI (JWT-scoped to this tenant) — feeds
  // the downloadable template (styles × sizes + active items + current inclusions).
  if (action === "catalog") {
    const [styles, sizes, items, types, incl, lpRows, colorsRes] = await Promise.all([
      admin.from("building_styles").select("id, key, label, image_url, active, show_image_on_estimate").eq("client_id", clientId).order("sort_order"),
      admin.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, active").eq("client_id", clientId).order("sort_order"),
      admin.from("client_layout_items").select("item_key, label_override, active, sort_order").eq("client_id", clientId).order("sort_order"),
      admin.from("layout_item_types").select("item_key, label"),
      admin.from("building_size_inclusions").select("size_id, item_key, included, qty").eq("client_id", clientId),
      // Default (style_id IS NULL) layout-item prices for the Layout Pricing tab.
      admin.from("layout_item_pricing").select("item_key, pricing_method, rate, image_url").eq("client_id", clientId).is("style_id", null),
      // Color palette for the Colors tab (paint = siding/trim; roof = shingle/metal).
      admin.from("colors").select("id, label, siding, trim, shingle, metal, allow_custom, is_default, rate, pricing_method, hex, image_url, sort_order, active").eq("client_id", clientId).order("sort_order"),
    ]);
    for (const r of [styles, sizes, items, types, incl, lpRows, colorsRes]) if (r.error) return json({ error: r.error.message }, 500);
    const labelByKey: Record<string, string> = {};
    (types.data ?? []).forEach((t: any) => { labelByKey[t.item_key] = t.label; });
    const itemList = (items.data ?? []).filter((i: any) => i.active)
      .map((i: any) => ({ key: i.item_key, label: i.label_override || labelByKey[i.item_key] || i.item_key }));
    return json({ ok: true, clientId, styles: styles.data, sizes: sizes.data, items: itemList, inclusions: incl.data, layoutPricing: lpRows.data ?? [], colors: colorsRes.data ?? [] });
  }

  // CSV pricing + inclusion import (client self-serve). clientId is JWT-resolved,
  // never from the body, so an owner can only ever import into their own tenant.
  if (action === "import_pricing_csv") {
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    try {
      const r = await importPricingRows(admin, clientId, payload.rows);
      return json({ ok: true, ...r });
    } catch (e) { return json({ error: (e as Error).message || String(e) }, 500); }
  }

  // Layout-item pricing (per placeable: doors, windows, workbench, loft, ramp …). Saves
  // only DEFAULT rows (style_id IS NULL); per-style overrides stay DB-managed and are
  // still honored at estimate time. Manual upsert (not PostgREST onConflict) because the
  // unique index is partial — (client_id, item_key) WHERE style_id IS NULL — and can't be
  // inferred by the upsert API. clientId is JWT-resolved, never trusted from the body.
  if (action === "save_layout_pricing") {
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    const ALLOWED_METHODS = new Set(["each", "lineal_ft", "sqft_option", "sqft_building", "perimeter_building", "pct_building_price", "pct_estimate_total"]);
    const itemsRes = await admin.from("client_layout_items").select("item_key, active").eq("client_id", clientId);
    if (itemsRes.error) return json({ error: itemsRes.error.message }, 500);
    const validKeys = new Set((itemsRes.data ?? []).filter((i: any) => i.active).map((i: any) => i.item_key));
    const exRes = await admin.from("layout_item_pricing").select("id, item_key").eq("client_id", clientId).is("style_id", null);
    if (exRes.error) return json({ error: exRes.error.message }, 500);
    const idByKey = new Map<string, string>();
    for (const r of exRes.data ?? []) idByKey.set(r.item_key, r.id);
    let saved = 0; const skipped: string[] = [];
    for (const row of payload.rows) {
      const itemKey = String(row?.item_key ?? "").trim();
      const method = String(row?.pricing_method ?? "").trim();
      const rate = Number(row?.rate);
      if (!itemKey) continue;
      if (!validKeys.has(itemKey)) { skipped.push(`${itemKey}: not an enabled item`); continue; }
      if (!ALLOWED_METHODS.has(method)) { skipped.push(`${itemKey}: invalid method "${method}"`); continue; }
      if (!Number.isFinite(rate) || rate < 0) { skipped.push(`${itemKey}: invalid rate "${row?.rate}"`); continue; }
      // Optional per-item image (shown on the estimate line for this product). Only written
      // when the row carries an imageUrl field, so a save from an older client never blanks
      // it; an explicit empty string clears it.
      const hasImg = Object.prototype.hasOwnProperty.call(row, "imageUrl");
      const imageUrl = hasImg ? (String(row.imageUrl ?? "").trim() || null) : undefined;
      const existingId = idByKey.get(itemKey);
      const patch: Record<string, unknown> = { pricing_method: method, rate };
      if (hasImg) patch.image_url = imageUrl;
      const res = existingId
        ? await admin.from("layout_item_pricing").update(patch).eq("id", existingId)
        : await admin.from("layout_item_pricing").insert({ client_id: clientId, item_key: itemKey, style_id: null, ...patch });
      if (res.error) { skipped.push(`${itemKey}: ${res.error.message}`); continue; }
      saved++;
    }
    return json({ ok: true, saved, skipped });
  }

  // Verify the GHL Location ID + API key against GoHighLevel, then save ONLY if they
  // are valid. Location/key fall back to the stored values when the field is left blank
  // (so an owner can re-verify without re-typing the secret). Also reports whether the
  // location has users (required for estimates) and products (needed for pricing).
  if (action === "verify_save_ghl") {
    const trim = (v: unknown) => String(v ?? "").trim();
    const { data: cur, error: curErr } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key")
      .eq("client_id", clientId)
      .maybeSingle();
    if (curErr) return json({ error: curErr.message }, 500);

    const locationId = trim(payload.ghlLocationId) || (cur?.ghl_location_id ?? "");
    const apiKey = trim(payload.ghlApiKey) || (cur?.ghl_api_key ?? "");
    if (!locationId || !apiKey) {
      return json({ error: "Enter both a GHL Location ID and an API key to verify the connection." }, 400);
    }
    // Guard against browser autofill dropping the login email into the Location ID field.
    if (locationId.includes("@") || /\s/.test(locationId)) {
      return json({ error: `That GHL Location ID looks wrong ("${locationId}") — it should be the sub-account location id like sp58arigVfqozsJSPe1z, not an email. This is usually browser autofill: clear the field and paste the real Location ID.` }, 400);
    }

    const ghlHeaders = {
      "Version": "2021-07-28",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    };
    // Location-scoped read: 200 ⇒ the key is valid for this location; 401/403 ⇒ wrong key/location.
    let prodStatus = 0, prodOk = false, prodBody = "";
    try {
      const r = await fetch(`https://services.leadconnectorhq.com/products/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
      prodStatus = r.status; prodOk = r.ok; prodBody = (await r.text()).slice(0, 600);
    } catch (e) {
      return json({ error: `Couldn't reach GoHighLevel to verify: ${(e as Error).message}` }, 502);
    }
    if (!prodOk) {
      const hint = prodStatus === 401 || prodStatus === 403
        ? "The API key is wrong, expired, or not authorized for this Location ID."
        : `GoHighLevel responded: ${prodBody}`;
      return json({ error: `Verification failed (HTTP ${prodStatus}). ${hint}` }, 400);
    }

    // Estimate-readiness signals (non-blocking).
    let hasProducts = false, hasUsers = false;
    try { const pj = JSON.parse(prodBody || "{}"); hasProducts = Array.isArray(pj?.products) && pj.products.length > 0; } catch { /* ignore */ }
    try {
      const ur = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
      if (ur.ok) { const uj = await ur.json(); hasUsers = Array.isArray(uj?.users) && uj.users.length > 0; }
    } catch { /* non-fatal */ }

    // Verified → save.
    const updates: Record<string, unknown> = {
      client_id: clientId,
      ghl_location_id: locationId,
      ghl_api_key: apiKey,
      updated_at: new Date().toISOString(),
    };
    if ("ghlPipelineId" in payload) updates.ghl_pipeline_id = trim(payload.ghlPipelineId) || null;
    if ("ghlStageSendQuoteId" in payload) updates.ghl_stage_send_quote_id = trim(payload.ghlStageSendQuoteId) || null;
    if ("ghlStageAcceptedId" in payload) updates.ghl_stage_accepted_id = trim(payload.ghlStageAcceptedId) || null;
    if ("ghlStageInvoicedId" in payload) updates.ghl_stage_invoiced_id = trim(payload.ghlStageInvoicedId) || null;
    if ("ghlStageDeliveredId" in payload) updates.ghl_stage_delivered_id = trim(payload.ghlStageDeliveredId) || null;
    const { error: upErr } = await admin.from("client_settings").upsert(updates, { onConflict: "client_id" });
    if (upErr) return json({ error: `Verified, but the save failed: ${upErr.message}` }, 500);

    // Pricing comes from the per-tenant CSV catalog (building_sizes), not GHL products, so a
    // missing product catalog is no longer worth warning about. A missing USER still blocks
    // estimates (GHL requires a userId on the estimate), so keep that one.
    const warning = !hasUsers
      ? "But this GHL location has no users yet — estimates will be rejected until you assign at least one user to the sub-account."
      : "";
    return json({ ok: true, verified: true, ghlLocationIdMasked: maskId(locationId), hasUsers, hasProducts, warning });
  }

  // List this tenant's GoHighLevel pipelines + their stages, for the portal's
  // pipeline/stage dropdowns. Uses the STORED creds (the browser never holds the
  // API key), so it only works once the connection is saved. Owner/admin only
  // (settings config) — deliberately NOT in READ_ACTIONS. Never returns the key.
  if (action === "list_ghl_pipelines") {
    const { data: cur, error: curErr } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key")
      .eq("client_id", clientId)
      .maybeSingle();
    if (curErr) return json({ error: curErr.message }, 500);
    const locationId = cur?.ghl_location_id ?? "";
    const apiKey = cur?.ghl_api_key ?? "";
    if (!locationId || !apiKey) {
      return json({ error: "Connect Synergy/GHL first (save a Location ID + API key), then load pipelines." }, 400);
    }
    const ghlHeaders = {
      "Version": "2021-07-28",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    };
    let r: Response;
    try {
      r = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
    } catch (e) {
      return json({ error: `Couldn't reach GoHighLevel: ${(e as Error).message}` }, 502);
    }
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      const hint = (r.status === 401 || r.status === 403)
        ? "The saved API key may be wrong or expired — re-verify the connection above."
        : body;
      return json({ error: `Couldn't load pipelines (HTTP ${r.status}). ${hint}` }, 400);
    }
    const data = await r.json().catch(() => ({}));
    const pipelines = (Array.isArray(data?.pipelines) ? data.pipelines : []).map((p: any) => ({
      id: p.id,
      name: p.name ?? p.id,
      stages: (Array.isArray(p.stages) ? p.stages : []).map((s: any) => ({ id: s.id, name: s.name ?? s.id })),
    }));
    return json({ ok: true, pipelines });
  }

  // Create a building style for THIS tenant (clientId is JWT-resolved, never from the
  // body) so owners can self-serve styles before pricing. An optional base64 image is
  // uploaded to the public 'branding' bucket. Key allocation mirrors admin-catalog's
  // create_style: derive a slug and retry on unique-violation so a concurrent create
  // never silently overwrites a style.
  if (action === "create_style") {
    const label = String(payload.label ?? "").trim();
    if (!label) return json({ error: "Building style name is required." }, 400);
    let imageUrl: string | null = null;
    if (typeof payload.imageBase64 === "string" && payload.imageBase64.trim()) {
      const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
      const ct = String(payload.imageContentType || "image/jpeg");
      const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
      const ext = EXT[ct];
      if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
      if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
      const path = `${clientId}/style-${Date.now()}.${ext}`;
      const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
      if (up.error) return json({ error: `Image upload failed: ${up.error.message}` }, 500);
      const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
      imageUrl = pub.publicUrl;
    }
    const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "")) || "style";
    // INSERT then retry on a unique-violation (23505) for a per-client key collision. The
    // global building_style_catalog key-reservation was removed with that table in 030.
    let key = base, n = 1;
    for (let attempt = 0; attempt < 50; attempt++) {
      const ins = await admin.from("building_styles").insert(
        { client_id: clientId, key, label, image_url: imageUrl, sort_order: 0, active: true })
        .select("id, key").maybeSingle();
      if (!ins.error) return json({ ok: true, styleId: ins.data!.id, key: ins.data!.key });
      if (ins.error.code !== "23505") return json({ error: ins.error.message }, 500);
      key = `${base}-${++n}`;
    }
    return json({ error: "Could not allocate a unique style key." }, 500);
  }

  // Show/hide one of this tenant's styles (a hidden style drops out of the designer and
  // the pricing template). Scoped to clientId so an owner can only touch their own styles.
  if (action === "set_style_active") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const { error } = await admin.from("building_styles")
      .update({ active: payload.active !== false })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // Toggle whether this style's photo is attached to the GHL estimate's building line
  // (default on). Only affects the estimate attachment — the designer still shows the photo.
  if (action === "set_style_estimate_image") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const { error } = await admin.from("building_styles")
      .update({ show_image_on_estimate: payload.show !== false })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // Upload-only: store a layout-item image in the 'branding' bucket and return its public
  // URL (no DB write). The portal places the URL on the row and persists it via
  // save_layout_pricing → layout_item_pricing.image_url, which submit-estimate then attaches
  // to that item's estimate line. clientId is JWT-resolved (own tenant only).
  if (action === "upload_layout_image") {
    if (typeof payload.imageBase64 !== "string" || !payload.imageBase64.trim()) return json({ error: "No image data." }, 400);
    const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const ct = String(payload.imageContentType || "image/jpeg");
    const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const ext = EXT[ct];
    if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
    if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
    const path = `${clientId}/layout-${Date.now()}.${ext}`;
    const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
    if (up.error) return json({ error: `Image upload failed: ${up.error.message}` }, 500);
    const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
    return json({ ok: true, url: pub.publicUrl });
  }

  // Permanently delete one of this tenant's styles. The FK cascade removes the style's
  // building_sizes (and their size-inclusions) and its style-specific layout_item_pricing
  // overrides; default (style_id IS NULL) pricing, colors, and options are untouched.
  // Irreversible — prefer set_style_active(false) to merely hide a style. Scoped to clientId
  // so an owner can only delete their own styles. Past designs that used this style keep their
  // saved geometry/PDF/estimate, but can no longer be re-priced (submit-estimate will report
  // "No price is set" on resubmit), since the style/sizes are gone from the catalog.
  if (action === "delete_style") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const { error, count } = await admin.from("building_styles")
      .delete({ count: "exact" })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return json({ error: error.message }, 500);
    if (!count) return json({ error: "Style not found (or not yours)." }, 404);
    return json({ ok: true });
  }

  // Update one of this tenant's styles: rename and/or replace its image. Scoped to clientId.
  // Only fields present in the body are written; an absent image leaves the current one intact.
  // Does not touch sizes/prices (CSV) or active state (set_style_active).
  if (action === "update_style") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const updates: Record<string, unknown> = {};
    if ("label" in payload) {
      const label = String(payload.label ?? "").trim();
      if (!label) return json({ error: "Building style name can't be empty." }, 400);
      updates.label = label;
    }
    if (typeof payload.imageBase64 === "string" && payload.imageBase64.trim()) {
      const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
      const ct = String(payload.imageContentType || "image/jpeg");
      const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
      const ext = EXT[ct];
      if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
      if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
      const path = `${clientId}/style-${Date.now()}.${ext}`;
      const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
      if (up.error) return json({ error: `Image upload failed: ${up.error.message}` }, 500);
      const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
      updates.image_url = pub.publicUrl;
    }
    if (Object.keys(updates).length === 0) return json({ error: "Nothing to update." }, 400);
    updates.updated_at = new Date().toISOString();
    const { error, count } = await admin.from("building_styles")
      .update(updates, { count: "exact" })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return json({ error: error.message }, 500);
    if (!count) return json({ error: "Style not found (or not yours)." }, 404);
    return json({ ok: true, imageUrl: updates.image_url ?? null });
  }

  // Reorder this tenant's building styles. `orderedIds` is the desired top-to-bottom order;
  // each style's sort_order is set to its index, which is what get_config / the designer sort
  // by (so the first id becomes the first style shown on the design page). Scoped to clientId.
  if (action === "reorder_styles") {
    if (!Array.isArray(payload.orderedIds) || payload.orderedIds.length === 0) return json({ error: "orderedIds[] required" }, 400);
    let i = 0;
    for (const styleId of payload.orderedIds) {
      const sid = String(styleId ?? "").trim();
      if (!sid) continue;
      const { error } = await admin.from("building_styles")
        .update({ sort_order: i })
        .eq("client_id", clientId).eq("id", sid);
      if (error) return json({ error: error.message }, 500);
      i++;
    }
    return json({ ok: true });
  }

  // Full-replace this tenant's paint palette (Colors tab). Takes the COMPLETE desired list:
  // rows carrying an id are updated, rows without one are inserted, and any existing colour
  // absent from the list is deleted. clientId is JWT-resolved (own tenant only). The designer
  // is selection-only today (get_config exposes label/siding/trim/allowCustom/isDefault/swatch,
  // never a price); rate/pricing_method are persisted here for a later paint-pricing pass.
  if (action === "save_colors") {
    if (!Array.isArray(payload.colors)) return json({ error: "colors[] required" }, 400);
    const ALLOWED_METHODS = new Set(["each", "lineal_ft", "sqft_option", "sqft_building", "perimeter_building", "pct_building_price", "pct_estimate_total"]);
    const exRes = await admin.from("colors").select("id").eq("client_id", clientId);
    if (exRes.error) return json({ error: exRes.error.message }, 500);
    const existingIds = new Set((exRes.data ?? []).map((r: any) => String(r.id)));
    const keptIds = new Set<string>();
    let saved = 0; const skipped: string[] = [];
    let i = 0;
    for (const row of payload.colors) {
      const label = String(row?.label ?? "").trim();
      if (!label) { skipped.push(`row ${i}: blank label`); i++; continue; }
      const method = String(row?.pricingMethod ?? "each").trim() || "each";
      if (!ALLOWED_METHODS.has(method)) { skipped.push(`${label}: invalid method "${method}"`); i++; continue; }
      const rate = Number(row?.rate);
      const rec: Record<string, unknown> = {
        client_id: clientId,
        label,
        siding: row?.siding !== false,       // default true
        trim: row?.trim !== false,           // default true
        allow_custom: row?.allowCustom === true,
        is_default: row?.isDefault === true,
        active: row?.active !== false,       // default true
        rate: Number.isFinite(rate) && rate >= 0 ? rate : 0,
        pricing_method: method,
        // Optional swatch color as a hex string (#RGB / #RRGGBB). Anything else → null.
        hex: (typeof row?.hex === "string" && /^#[0-9a-fA-F]{3,8}$/.test(row.hex.trim())) ? row.hex.trim() : null,
        sort_order: Number.isFinite(Number(row?.sortOrder)) ? Number(row.sortOrder) : i,
        updated_at: new Date().toISOString(),
      };
      // Roof categories (shingle/metal). Only written when the caller sends them, so an older
      // client that doesn't know about these keys can't clear a color's roof categorization.
      if (Object.prototype.hasOwnProperty.call(row, "shingle")) rec.shingle = row.shingle === true;
      if (Object.prototype.hasOwnProperty.call(row, "metal")) rec.metal = row.metal === true;
      if (Object.prototype.hasOwnProperty.call(row, "imageUrl")) {
        rec.image_url = String(row.imageUrl ?? "").trim() || null;
      }
      const rid = String(row?.id ?? "").trim();
      const res = (rid && existingIds.has(rid))
        ? (keptIds.add(rid), await admin.from("colors").update(rec).eq("client_id", clientId).eq("id", rid))
        : await admin.from("colors").insert(rec);
      if (res.error) { skipped.push(`${label}: ${res.error.message}`); i++; continue; }
      saved++; i++;
    }
    const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
    let deleted = 0;
    if (toDelete.length) {
      const del = await admin.from("colors").delete().eq("client_id", clientId).in("id", toDelete);
      if (del.error) return json({ error: del.error.message }, 500);
      deleted = toDelete.length;
    }
    return json({ ok: true, saved, deleted, skipped });
  }

  // ── Contact activity timeline (Contacts tab "Details"): everything we know about
  // one contact's designs — version history (what they changed) + GHL estimate events
  // (sent / viewed / accepted / invoiced). Read-only; any linked account may call it
  // (same posture as sync-design-status: tenant-scoped reads, no settings exposure).
  if (action === "contact_activity") {
    const codes: string[] = Array.isArray(payload?.codes)
      ? payload.codes.map((c: unknown) => String(c)).filter(Boolean).slice(0, 50)
      : [];
    if (codes.length === 0) return json({ ok: true, designs: [], versions: [], estimates: {} });

    const [dRes, vRes] = await Promise.all([
      admin.from("designs")
        .select("short_code, created_at, updated_at, status, selections, items, ghl_estimate_number, ghl_estimate_id")
        .eq("client_id", clientId).in("short_code", codes),
      admin.from("design_versions")
        .select("short_code, version, created_at, selections, image_url")
        .eq("client_id", clientId).in("short_code", codes)
        .order("version", { ascending: true }),
    ]);
    if (dRes.error) return json({ error: dRes.error.message }, 500);
    if (vRes.error) return json({ error: vRes.error.message }, 500);

    // GHL estimate events for these designs' estimates (best-effort — timeline still
    // renders from DB data if GHL is unreachable/unconfigured).
    const estimates: Record<string, unknown> = {};
    const wantIds = new Set((dRes.data ?? []).map((d: any) => String(d.ghl_estimate_id || "")).filter(Boolean));
    if (wantIds.size > 0) {
      const { data: cur } = await admin.from("client_settings")
        .select("ghl_location_id, ghl_api_key").eq("client_id", clientId).maybeSingle();
      if (cur?.ghl_location_id && cur?.ghl_api_key) {
        const ghlHeaders = {
          Authorization: `Bearer ${cur.ghl_api_key}`,
          Version: "2021-07-28",
          Accept: "application/json",
        };
        try {
          const limit = 100;
          for (let offset = 0; offset < 2000; offset += limit) {
            const url = `https://services.leadconnectorhq.com/invoices/estimate/list?altId=${encodeURIComponent(cur.ghl_location_id)}&altType=location&limit=${limit}&offset=${offset}`;
            const r = await fetch(url, { headers: ghlHeaders });
            if (!r.ok) break;
            const d = await r.json();
            const arr: any[] = Array.isArray(d?.estimates) ? d.estimates : [];
            for (const e of arr) {
              const id = String(e?._id ?? "");
              if (wantIds.has(id)) {
                estimates[id] = {
                  estimateStatus: e?.estimateStatus ?? null,
                  estimateNumber: e?.estimateNumber ?? null,
                  createdAt: e?.createdAt ?? null,
                  lastVisitedAt: e?.lastVisitedAt ?? null,      // customer opened the estimate
                  history: Array.isArray(e?.estimateActionHistory) ? e.estimateActionHistory : [],
                };
              }
            }
            if (arr.length < limit) break;
          }
        } catch (_e) { /* best-effort */ }
      }
    }
    // Invoice-send ledger state for these designs (migration 052). Lets the drawer show
    // "invoice created but not emailed — retry" instead of silently looking invoiced.
    const { data: sends } = await admin
      .from("invoice_sends")
      .select("short_code, status, invoice_number, error, updated_at")
      .eq("client_id", clientId).in("short_code", codes);

    return json({ ok: true, designs: dRes.data ?? [], versions: vRes.data ?? [], estimates, invoiceSends: sends ?? [] });
  }

  // ── Send invoice for an ACCEPTED design (Contacts tab). Owner/admin only (it is a
  // mutation, so the role gate above already applies). Converts the design's GHL
  // estimate to an invoice (marking the estimate invoiced) and emails it to the
  // customer — verified live against the LeadConnector API 2026-07-25.
  //
  // The convert is IRREVERSIBLE and the email is a separate call that can fail, so the
  // whole action is serialised through the `invoice_sends` ledger (migration 052):
  //   * the PK insert is the concurrency claim — a racing request cannot convert twice;
  //   * a 'created' row means the invoice exists but was never emailed, so a retry
  //     RE-SENDS the stored invoice id instead of converting again (no orphaned invoice);
  //   * the userId the send endpoint requires is resolved BEFORE converting, so a missing
  //     user fails fast instead of after the estimate has already been flipped.
  if (action === "send_invoice") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);

    const { data: design, error: desErr } = await admin
      .from("designs")
      .select("short_code, status, ghl_estimate_id, contact")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (desErr) return json({ error: desErr.message }, 500);
    if (!design) return json({ error: "Design not found." }, 404);
    if (!design.ghl_estimate_id) return json({ error: "This design has no estimate yet." }, 400);

    const { data: cur, error: curErr } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return json({ error: curErr.message }, 500);
    if (!cur?.ghl_location_id || !cur?.ghl_api_key) {
      return json({ error: "Connect Synergy/GHL first (Settings → Connection)." }, 400);
    }
    const locationId = cur.ghl_location_id;
    const ghlHeaders = {
      Authorization: `Bearer ${cur.ghl_api_key}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const nowIso = () => new Date().toISOString();
    const setClaim = (patch: Record<string, unknown>) =>
      admin.from("invoice_sends").update({ ...patch, updated_at: nowIso() })
        .eq("client_id", clientId).eq("short_code", shortCode);
    // Every GHL call is wrapped: an unhandled fetch rejection would otherwise surface as
    // an opaque 500 with no CORS headers, losing the "invoice was created" warning.
    const ghl = async (url: string, init?: RequestInit) => {
      try {
        const r = await fetch(url, init);
        const body = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, body };
      } catch (e) {
        return { ok: false, status: 0, body: null, netErr: (e as Error)?.message || "network error" };
      }
    };
    const STALE_CLAIM_MS = 3 * 60 * 1000;

    // ── 1. Claim the send (idempotency + recovery). ──────────────────────────────
    let resendInvoiceId: string | null = null;   // set when recovering a created-but-unsent invoice
    let resendInvoiceNumber: string | null = null;
    let resendSenderUserId: string | null = null;
    const claimIns = await admin.from("invoice_sends").insert({
      client_id: clientId, short_code: shortCode,
      ghl_estimate_id: String(design.ghl_estimate_id), status: "claimed", attempts: 1,
    });
    if (claimIns.error) {
      // 23505 = the row exists → inspect it instead of converting again.
      const { data: prior } = await admin.from("invoice_sends")
        .select("status, invoice_id, invoice_number, updated_at, attempts, sender_user_id")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
      if (!prior) return json({ error: claimIns.error.message }, 500);
      const st = String(prior.status || "");
      if (st === "sent") {
        return json({ error: `Invoice ${prior.invoice_number ?? ""} was already sent for this design.` }, 400);
      }
      if (st === "created") {
        // The invoice EXISTS in GHL but was never emailed → re-send it, do not convert.
        resendInvoiceId = prior.invoice_id ? String(prior.invoice_id) : null;
        resendInvoiceNumber = prior.invoice_number ? String(prior.invoice_number) : null;
        resendSenderUserId = prior.sender_user_id ? String(prior.sender_user_id) : null;
        if (!resendInvoiceId) return json({ error: "An invoice was created in Synergy/GHL for this design but its id wasn't recorded — send it from Synergy/GHL." }, 409);
      } else if (st === "claimed") {
        const age = Date.now() - new Date(String(prior.updated_at)).getTime();
        if (age < STALE_CLAIM_MS) {
          return json({ error: "An invoice for this design is already being sent — give it a moment." }, 409);
        }
      }
      await setClaim({ status: "claimed", error: null, attempts: (Number(prior.attempts) || 1) + 1 });
    }

    let invoiceId = resendInvoiceId;
    let invoiceNumber: string | null = resendInvoiceNumber;

    if (!invoiceId) {
      // ── 2. Read the live estimate: must be accepted (and not already invoiced). ──
      let est: any = null;
      const limit = 100;
      for (let offset = 0; offset < 2000 && !est; offset += limit) {
        const r = await ghl(`https://services.leadconnectorhq.com/invoices/estimate/list?altId=${encodeURIComponent(locationId)}&altType=location&limit=${limit}&offset=${offset}`, { headers: ghlHeaders });
        if (!r.ok) {
          await setClaim({ status: "failed", error: `estimate list ${r.status}` });
          return json({ error: `Could not read estimates from Synergy/GHL (${r.status || r.netErr}).` }, 502);
        }
        const arr: any[] = Array.isArray(r.body?.estimates) ? r.body.estimates : [];
        est = arr.find((e) => String(e?._id ?? "") === String(design.ghl_estimate_id)) ?? null;
        if (arr.length < limit) break;
      }
      if (!est) {
        await setClaim({ status: "failed", error: "estimate not found" });
        return json({ error: "The estimate could not be found in Synergy/GHL." }, 404);
      }
      const estStatus = String(est?.estimateStatus ?? "").toLowerCase();
      if (estStatus === "invoiced") {
        await setClaim({ status: "failed", error: "already invoiced in GHL" });
        return json({ error: "This estimate was already invoiced in Synergy/GHL — send that invoice from there." }, 400);
      }
      if (estStatus !== "accepted") {
        await setClaim({ status: "failed", error: `estimate status ${estStatus || "sent"}` });
        return json({ error: `The customer hasn't accepted this estimate yet (status: ${estStatus || "sent"}).` }, 400);
      }

      // ── 3. Resolve the sender BEFORE converting (GHL: "either userId or sentFrom"). ──
      let userId = String(est?.sentBy ?? "");
      if (!userId) {
        const ur = await ghl(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
        const users: any[] = Array.isArray(ur.body?.users) ? ur.body.users : [];
        userId = String(users[0]?.id ?? "");
      }
      if (!userId) {
        // Fail fast: converting first would leave an un-sendable invoice behind.
        await setClaim({ status: "failed", error: "no GHL user to send as" });
        return json({ error: "Synergy/GHL has no user to send the invoice as — add a user to that sub-account, then try again. (Nothing was invoiced.)" }, 400);
      }

      // ── 4. Convert estimate → invoice (IRREVERSIBLE: marks the estimate invoiced). ──
      const convRes = await ghl(`https://services.leadconnectorhq.com/invoices/estimate/${encodeURIComponent(String(design.ghl_estimate_id))}/invoice`, {
        method: "POST", headers: ghlHeaders,
        body: JSON.stringify({ altId: locationId, altType: "location", markAsInvoiced: true }),
      });
      if (!convRes.ok) {
        await setClaim({ status: "failed", error: `convert ${convRes.status}` });
        return json({ error: `Creating the invoice failed: ${convRes.body?.message ?? convRes.status ?? convRes.netErr}` }, 502);
      }
      const invoice = convRes.body?.invoice ?? convRes.body ?? {};
      invoiceId = String(invoice?._id ?? invoice?.id ?? "");
      invoiceNumber = invoice?.invoiceNumber != null ? String(invoice.invoiceNumber) : null;
      if (!invoiceId) {
        await setClaim({ status: "failed", error: "no invoice id returned" });
        return json({ error: "Synergy/GHL did not return an invoice id." }, 502);
      }
      // Record it IMMEDIATELY: from here on the invoice exists in GHL, so even if the
      // email fails (or this function dies) the retry re-sends instead of converting.
      await setClaim({ status: "created", invoice_id: invoiceId, invoice_number: invoiceNumber, error: null, sender_user_id: userId });

      // ── 5. Email it to the customer. ──
      const sendRes = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invoiceId)}/send`, {
        method: "POST", headers: ghlHeaders,
        body: JSON.stringify({ altId: locationId, altType: "location", action: "email", liveMode: true, userId }),
      });
      if (!sendRes.ok) {
        await setClaim({ status: "created", error: `send ${sendRes.status || sendRes.netErr}: ${sendRes.body?.message ?? ""}`.slice(0, 500) });
        return json({
          error: `Invoice ${invoiceNumber ?? ""} was created in Synergy/GHL but the email didn't go out (${sendRes.body?.message ?? sendRes.status ?? sendRes.netErr}). Click Send invoice again to retry the email — it will NOT create a second invoice.`,
          invoiceId, invoiceNumber, created: true, sent: false,
        }, 502);
      }
    } else {
      // ── Recovery path: the invoice already exists, only the email is outstanding.
      //    Reuse the sender recorded on the first attempt when we have it. ──
      let userId = resendSenderUserId || "";
      if (!userId) {
        const ur = await ghl(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
        const users: any[] = Array.isArray(ur.body?.users) ? ur.body.users : [];
        userId = String(users[0]?.id ?? "");
      }
      if (!userId) {
        return json({ error: "Synergy/GHL has no user to send the invoice as — add a user to that sub-account, then retry." }, 400);
      }
      const sendRes = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invoiceId)}/send`, {
        method: "POST", headers: ghlHeaders,
        body: JSON.stringify({ altId: locationId, altType: "location", action: "email", liveMode: true, userId }),
      });
      if (!sendRes.ok) {
        await setClaim({ status: "created", error: `resend ${sendRes.status || sendRes.netErr}`.slice(0, 500) });
        return json({ error: `Retrying the email for invoice ${invoiceNumber ?? ""} failed (${sendRes.body?.message ?? sendRes.status ?? sendRes.netErr}). You can send it from Synergy/GHL.`, invoiceId, invoiceNumber, created: true, sent: false }, 502);
      }
    }

    // ── 6. Done: mark the ledger sent and cache the design's status. ──
    await setClaim({ status: "sent", error: null });
    await admin.from("designs")
      .update({ status: "invoiced", updated_at: nowIso() })
      .eq("client_id", clientId).eq("short_code", shortCode);

    return json({ ok: true, invoiceId, invoiceNumber, sent: true });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
});
