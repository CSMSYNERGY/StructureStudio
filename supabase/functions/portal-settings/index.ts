import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { qboFetch, qboOauthReady, QboBroken, QboNotConnected } from "../_shared/qboToken.ts";
import { pushQboInvoice } from "../_shared/qboInvoice.ts";

// Any linked account may read these; everything else requires owner/admin (or an
// operator with can_write). Hoisted above the handler so the resolver can consult it.
const READ_ACTIONS = new Set(["status", "catalog", "contact_activity", "get_profile", "qbo_status"]);
// Self-service: a WRITE any role may make, because it only ever touches the caller's own
// client_users row (scoped to ctx.userId below, never to anything from the body). Kept out of
// READ_ACTIONS on purpose — mislabelling a write as a read would make the permission gate
// misdescribe what it allows. Without this a "user"-role account could not set its own name.
const SELF_ACTIONS = new Set(["save_profile"]);

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

// ── floor-plans object keys ─────────────────────────────────────────────────────
// delete_design hands object keys to a SERVICE-ROLE remove(), which bypasses storage RLS,
// and the only record of which file belongs to which design is designs/design_versions
// .image_url — a column the anon-callable save_design RPC writes verbatim. So a stored URL
// is untrusted input: it may say WHICH of this design's objects to remove, never WHOSE.
const FLOOR_PLANS = "floor-plans";
const OBJECT_PATH = `/storage/v1/object/public/${FLOOR_PLANS}/`;

// The only tails our uploader has ever produced: none (the pre-2026-06-15 `<code>.pdf`
// shape) or submitQuote's `-${Date.now()}` suffix.
const KEY_TAIL = /^(-[0-9]+)?\.(pdf|png)$/;

// The bucket-root era — slash-less object names, before per-tenant prefixes. It is CLOSED:
// the newest row referencing one was created 2026-06-12, the first prefixed row 2026-06-15,
// and migration 031's storage INSERT policy now requires a "<slug>/" prefix, so no new root
// object can be created. The date therefore records finished history, not policy. Only a
// design row from that era may name a root object; a row with no parseable created_at is
// treated as newer, which is the safe direction.
const LEGACY_ROOT_ERA_END = Date.parse("2026-06-14T00:00:00Z");

/** Object key from a stored public URL, or null if it is not one of our floor-plan URLs. */
function floorPlanKey(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  let path: string;
  try { path = new URL(u.trim()).pathname; } catch { return null; } // not a URL at all
  if (!path.startsWith(OBJECT_PATH)) return null;
  const key = path.slice(OBJECT_PATH.length);
  // Percent-escapes are REJECTED, never decoded: decodeURIComponent throws on a lone "%",
  // withErrorLog would turn that into a 500, and the design would become undeletable.
  // Nothing legitimate needs them — the code alphabet is [A-HJ-NP-Z2-9] and the tail is
  // digits. new URL() has already resolved any "../" and dropped query/fragment.
  // Only the PATH is pinned, deliberately not the host: the key is checked against
  // server-derived values below, so an off-host URL can still only name this design's own
  // object, whereas anchoring on SUPABASE_URL would reject every row under
  // `functions serve` or behind a future storage CDN and silently orphan every file.
  return key && key.length <= 300 && !key.includes("%") ? key : null;
}

/** Could THIS design's own uploads have produced `key`? Both inputs are server-resolved and
 *  neither is ever read from the request body. shortCode comes from the matched row, and
 *  designs.short_code is globally UNIQUE (designs_short_code_key), so it names at most one
 *  design anywhere — that uniqueness IS the authorization test here, not the date gate above.
 *  clientId is the resolved tenant slug: straight from client_users on the ordinary
 *  owner/admin path, assertClient-validated only on the operator-override path. So it is NOT
 *  shape-guaranteed here and must not need to be — plain string ops only, and no RegExp is
 *  ever built from either value, which is what keeps this correct whatever a slug contains. */
function isOwnFloorPlanKey(key: string, clientId: string, shortCode: string, legacyOk: boolean): boolean {
  let name = key;
  if (key.startsWith(`${clientId}/`)) name = key.slice(clientId.length + 1);
  // Another tenant's prefix, or a root object this row is too new to have created.
  else if (key.includes("/") || !legacyOk) return false;
  return name.startsWith(shortCode) && KEY_TAIL.test(name.slice(shortCode.length));
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

Deno.serve(withErrorLog("portal-settings", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Auth + tenant resolution, shared with portal-billing / sync-design-status.
  //
  // Authorization: any linked account may READ (status/catalog/contact_activity), but only
  // the tenant owner/admin may MUTATE. The portal UI hides the settings/pricing/colors tabs
  // for role "user", but that is a client-only control — a direct POST would bypass it — so
  // the gate lives in the resolver, server-side.
  //
  // An OPERATOR (app_operators, see _shared/resolveTenant.ts) may additionally pass
  // `targetClientId` to act on another tenant — that is what makes the portal's "view as"
  // mode actually read and write the viewed account instead of the operator's own.
  // Everything below this block is unchanged and simply uses `clientId`.
  const admin = createClient(supabaseUrl, serviceKey);
  const r = await resolveTenant(req, admin, { readActions: READ_ACTIONS, selfActions: SELF_ACTIONS, defaultAction: "status" });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, role, operator, payload, action, audit, auditStrict, userId, userEmail } = r.ctx;

  // Reads are logged best-effort; writes get a durable row (below, per action).
  if (operator) audit(`operator_${action}`).catch(() => {});

  // ── The caller's own name and phone ─────────────────────────────────────────────
  // Keyed on userId from the verified session — NEVER on anything in the body — so this
  // cannot be pointed at another person's row whatever the caller sends. Any role may use
  // it (see SELF_ACTIONS): a "user" account still needs to be able to fill in its own name.
  if (action === "get_profile") {
    const { data, error } = await admin
      .from("client_users").select("full_name, phone, role").eq("user_id", userId).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({
      fullName: data?.full_name ?? "",
      phone: data?.phone ?? "",
      role: data?.role ?? role,
      email: userEmail,
      // Drives the one-time nudge: users predating migration 060 have neither.
      needsDetails: !(data?.full_name || "").trim(),
    });
  }

  if (action === "save_profile") {
    const fullName = String(payload?.fullName ?? "").trim().slice(0, 120);
    const phone = String(payload?.phone ?? "").trim().slice(0, 40);
    if (!fullName) return json({ error: "Please enter your name." }, 400);
    const { error } = await admin.from("client_users")
      .update({ full_name: fullName, phone: phone || null })
      .eq("user_id", userId);        // own row only
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, fullName, phone });
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
      // clientId is the RESOLVED tenant (the viewed one in operator mode). portal.html's
      // invoke wrapper compares it against the targetClientId it injected and refuses the
      // response if they disagree — that tripwire is what stops a frontend deployed ahead
      // of this function from silently reading/writing the operator's own tenant.
      clientId,
      role,
      operatorMode: Boolean(operator),
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
    const [styles, sizes, items, types, incl, lpRows, colorsRes, fixturesRes] = await Promise.all([
      admin.from("building_styles").select("id, key, label, image_url, active, show_image_on_estimate").eq("client_id", clientId).order("sort_order"),
      admin.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, active").eq("client_id", clientId).order("sort_order"),
      admin.from("client_layout_items").select("item_key, label_override, active, sort_order").eq("client_id", clientId).order("sort_order"),
      admin.from("layout_item_types").select("item_key, label"),
      admin.from("building_size_inclusions").select("size_id, item_key, included, qty").eq("client_id", clientId),
      // Default (style_id IS NULL) layout-item prices for the Layout Pricing tab.
      admin.from("layout_item_pricing").select("item_key, pricing_method, rate, image_url").eq("client_id", clientId).is("style_id", null),
      // Color palette for the Colors tab (paint = siding/trim; roof = shingle/metal).
      admin.from("colors").select("id, label, siding, trim, shingle, metal, allow_custom, is_default, rate, pricing_method, hex, image_url, sort_order, active").eq("client_id", clientId).order("sort_order"),
      // Fixtures catalog (Options tab → Doors section; windows/ramps later via `category`).
      admin.from("fixture_items").select("id, category, name, plan_label, width_in, height_in, price, swing_in, swing_out, swing_default, op_right, op_left, op_double, op_slideup, op_default, image_url, show_image_on_estimate, sort_order, active").eq("client_id", clientId).order("sort_order"),
    ]);
    for (const r of [styles, sizes, items, types, incl, lpRows, colorsRes, fixturesRes]) if (r.error) return json({ error: r.error.message }, 500);
    const labelByKey: Record<string, string> = {};
    (types.data ?? []).forEach((t: any) => { labelByKey[t.item_key] = t.label; });
    const itemList = (items.data ?? []).filter((i: any) => i.active)
      .map((i: any) => ({ key: i.item_key, label: i.label_override || labelByKey[i.item_key] || i.item_key }));
    return json({ ok: true, clientId, styles: styles.data, sizes: sizes.data, items: itemList, inclusions: incl.data, layoutPricing: lpRows.data ?? [], colors: colorsRes.data ?? [], fixtures: fixturesRes.data ?? [] });
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
      return json({ error: "Connect your CRM first (save a Location ID + API key), then load pipelines." }, 400);
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

  // Upload-only: store a door photo in the 'fixtures' bucket and return its public URL (no
  // DB write). The portal places the URL on the door row and persists it via save_doors →
  // fixture_items.image_url — the customer-facing photo, and the future 3D source art.
  // clientId is JWT-resolved (own tenant only). Mirrors upload_layout_image.
  if (action === "upload_fixture_image") {
    if (typeof payload.imageBase64 !== "string" || !payload.imageBase64.trim()) return json({ error: "No image data." }, 400);
    const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const ct = String(payload.imageContentType || "image/jpeg");
    const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const ext = EXT[ct];
    if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
    if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
    const path = `${clientId}/door-${Date.now()}.${ext}`;
    const up = await admin.storage.from("fixtures").upload(path, bytes, { contentType: ct, upsert: true });
    if (up.error) return json({ error: `Image upload failed: ${up.error.message}` }, 500);
    const { data: pub } = admin.storage.from("fixtures").getPublicUrl(path);
    return json({ ok: true, url: pub.publicUrl });
  }

  // Permanently delete one of this tenant's styles. The FK cascade removes the style's
  // building_sizes (and their size-inclusions) and its style-specific layout_item_pricing
  // overrides; default (style_id IS NULL) pricing, colors, and options are untouched.
  // Irreversible — prefer set_style_active(false) to merely hide a style. Scoped to clientId
  // so an owner can only delete their own styles. Past designs that used this style keep their
  // saved geometry/PDF/estimate, but can no longer be re-priced (submit-estimate will report
  // "No price is set" on resubmit), since the style/sizes are gone from the catalog.
  // ── Delete one design, its version history, and its PDFs ────────────────────
  // Carolyn, 2026-06-24: deletions had to be done directly in Supabase. This is that control.
  //
  // Guarded by a typed token for anything past Sent, because those are money records: an
  // accepted/invoiced/delivered design has a real estimate (and possibly a real invoice) in
  // the tenant's GHL. Ahsan's call 2026-07-30 was "allow, but make them type it".
  //
  // THREE things have to go, and only the first is obvious:
  //   1. the storage PDFs — the stored image_url columns say WHICH objects, but never get to
  //      say whose: every derived key must match a name this design's own uploads could have
  //      produced (see isOwnFloorPlanKey). The filename cannot simply be rebuilt from the
  //      short_code — three historical shapes exist and the current one carries a Date.now()
  //      suffix — but all three are DERIVABLE from (client_id, short_code), which is what
  //      makes validating them possible where reconstructing them is not.
  //   2. design_versions — there is NO foreign key to designs (verified: zero FKs on either
  //      table), so nothing cascades. Left behind, the rows stay readable by the tenant's own
  //      RLS policy and by list_design_versions/load_design_version, which key on short_code —
  //      i.e. a "deleted" design's full history would remain fetchable.
  //   3. the designs row itself, last, so a failure above never orphans the record that lets
  //      you find the leftovers.
  //
  // …and since 2026-08-01, a FOURTH: the estimate in the tenant's CRM. Carolyn, 2026-07-31 —
  // deleting a design left its estimate behind, so the two systems disagreed about what
  // exists. It is attempted BEFORE the rows go, because `ghl_estimate_id` lives on the row
  // being deleted: run it after and a failure is unretryable, having thrown away the only
  // pointer to the thing left behind. The contact and opportunity are still untouched — they
  // outlive any single design (a repeat customer has several) and are not ours to remove.
  if (action === "delete_design") {
    const shortCode = String(payload.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);

    // Scoped by BOTH client_id and short_code. A code from another tenant matches nothing and
    // returns the same 404 as a code that never existed — no existence oracle.
    const { data: design, error: findErr } = await admin.from("designs")
      .select("id, short_code, status, image_url, ghl_estimate_id, ghl_estimate_number, created_at")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (findErr) return json({ error: findErr.message }, 500);
    if (!design) return json({ error: "Design not found (or not yours)." }, 404);

    const st = design.status && ["sent", "accepted", "invoiced", "delivered"].includes(design.status)
      ? design.status : "sent";
    // What the operator must retype. The estimate number is the meaningful identifier when
    // one exists; a design can be past Sent without one, so fall back to the short code
    // rather than asking for something that isn't on screen.
    const needsConfirm = st !== "sent";
    const expected = design.ghl_estimate_number ? String(design.ghl_estimate_number) : design.short_code;
    if (needsConfirm) {
      const given = String(payload.confirmToken ?? "").trim();
      if (given !== expected) {
        return json({
          error: `This design is ${st} — a billing record. Type "${expected}" to confirm deletion.`,
          needsConfirm: true, expected, status: st,
        }, 409);
      }
    }

    // 1. Version rows first — we need their image_urls, and they are the invisible leftovers.
    //    A failed read is a 500, not a shrug: carrying on would delete the rows at step 3 with
    //    every version PDF unaccounted for. The action is idempotent, so a retry is free and
    //    strictly better than an orphan nobody can trace.
    const { data: versions, error: verErr } = await admin.from("design_versions")
      .select("id, image_url").eq("client_id", clientId).eq("short_code", shortCode);
    if (verErr) return json({ error: verErr.message }, 500);

    // 2. Storage. Every candidate key must be one THIS design could have produced — under
    //    this tenant's prefix and carrying this design's globally-unique short_code. That
    //    reduces image_url from a path to a yes/no, so no value a caller can store selects
    //    another tenant's file, or another design's file within this tenant. Keys that fail
    //    the test are kept and counted, never guessed at.
    const createdAt = Date.parse(String(design.created_at ?? ""));
    const legacyOk = Number.isFinite(createdAt) && createdAt < LEGACY_ROOT_ERA_END;
    const keys = new Set<string>();    // ours — safe to remove
    const kept = new Set<string>();    // distinct stored values we declined to act on
    const foreign = new Set<string>(); // …and the namespaces they named, for triage
    for (const u of [design.image_url, ...(versions ?? []).map((v: any) => v.image_url)]) {
      if (!u) continue; // drafts carry no PDF
      const key = floorPlanKey(u);
      if (key && isOwnFloorPlanKey(key, clientId, design.short_code, legacyOk)) { keys.add(key); continue; }
      kept.add(String(u).slice(0, 300));
      // Only the namespace, and only if it is slug-SHAPED: a real cross-tenant plant names a
      // real slug. Anything else is caller-authored free text, and app_errors is shapes and
      // counts — not a place to let a caller choose what an operator reads.
      const slash = key ? key.indexOf("/") : -1;
      if (key && slash > 0 && !key.startsWith(`${clientId}/`)) {
        const ns = key.slice(0, slash);
        foreign.add(/^[a-z0-9][a-z0-9-]{0,63}$/.test(ns) ? ns : "(non-slug)");
      }
    }
    let filesRemoved = 0;
    if (keys.size) {
      // Best-effort: a storage failure must not block the row delete, or the design becomes
      // undeletable and the tenant is stuck. Orphaned objects are unlisted (migration 042
      // dropped the anon SELECT policy) and cost only space. Refusing a key is best-effort
      // for the same reason — it must never turn into an error the tenant cannot clear.
      const rm = await admin.storage.from(FLOOR_PLANS).remove([...keys]);
      // What storage actually removed. remove() does not error on a key that isn't there, and
      // the old count was the pre-dedupe request length, so it over-reported both ways.
      filesRemoved = rm.error ? 0 : (rm.data?.length ?? 0);
    }

    // 3. The estimate in the tenant's CRM. GHL exposes DELETE /invoices/estimate/:id; altId +
    //    altType scope it to the sub-account, the same pair every other estimate call in this
    //    file already sends. Two rules here, both deliberate:
    //
    //    (a) NEVER once an invoice exists. Converting an estimate marks it invoiced, and that
    //        invoice is the record behind money that may already have been collected —
    //        deleting its estimate would leave an invoice whose origin no longer exists, which
    //        is a worse inconsistency than the one this closes. Those report `skipped_invoiced`
    //        and the dialog tells the operator to void the invoice in the CRM first. The check
    //        reads invoice_sends rather than trusting `status` alone, because status is a
    //        cached projection that sync-design-status can downgrade on a GHL blip — the
    //        claim ledger is the durable fact that an invoice was created.
    //    (b) BEST-EFFORT, exactly like storage. A tenant's key may predate this feature and
    //        lack the estimates scope; a 401/403/5xx must never make the design undeletable
    //        and strand the local rows. The outcome is returned, audited, and (on failure)
    //        logged — never thrown.
    //    (c) OPT-IN PER REQUEST. The caller must send `deleteEstimate: true`. This is a
    //        compatibility gate, not a preference: this function serves beta AND production
    //        portal.html at the same time, and production keeps serving the previous build
    //        until the Monday promotion. That older dialog tells the operator in as many
    //        words that the estimate is NOT affected — so changing the behaviour underneath
    //        it would delete records in a client's CRM that they were just promised would
    //        survive. Old page ⇒ no flag ⇒ old behaviour, exactly.
    let estimate: "none" | "deleted" | "skipped_invoiced" | "not_connected" | "failed" = "none";
    let estimateError: string | null = null;
    if (design.ghl_estimate_id && payload.deleteEstimate === true) {
      const { data: inv } = await admin.from("invoice_sends")
        .select("invoice_id").eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
      if (inv?.invoice_id || st === "invoiced" || st === "delivered") {
        estimate = "skipped_invoiced";
      } else {
        const { data: creds } = await admin.from("client_settings")
          .select("ghl_location_id, ghl_api_key").eq("client_id", clientId).maybeSingle();
        if (!creds?.ghl_location_id || !creds?.ghl_api_key) {
          estimate = "not_connected";
        } else {
          try {
            const r = await fetch(
              `https://services.leadconnectorhq.com/invoices/estimate/${encodeURIComponent(String(design.ghl_estimate_id))}` +
                `?altId=${encodeURIComponent(creds.ghl_location_id)}&altType=location`,
              {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${creds.ghl_api_key}`,
                  Version: "2021-07-28",
                  Accept: "application/json",
                },
              },
            );
            // 404 is the desired end state reached by another route (already deleted in the
            // CRM, or a half-finished earlier attempt), so it counts as done rather than as an
            // error the operator has to interpret. That is also what makes a retry safe.
            estimate = (r.ok || r.status === 404) ? "deleted" : "failed";
            if (estimate === "failed") estimateError = `CRM returned ${r.status}`;
          } catch (e) {
            estimate = "failed";
            estimateError = (e as Error)?.message || "network error";
          }
        }
      }
    }

    // 4. Versions, then the design. The version delete failing is NOT ignorable: deleting the
    //    designs row anyway would strand those version rows, and list_design_versions is
    //    SECURITY DEFINER, granted to anon, and keyed on short_code ALONE — so a stranded row's
    //    contact jsonb stays fetchable by a code that is already sitting in sent customer email,
    //    with no designs row left to show anyone it happened. Stop before that becomes true; the
    //    action is idempotent, so a retry finishes the job.
    const { error: verDelErr, count: versionsDeleted } = await admin.from("design_versions")
      .delete({ count: "exact" }).eq("client_id", clientId).eq("short_code", shortCode);
    if (verDelErr) return json({ error: verDelErr.message }, 500);
    const { error: delErr, count } = await admin.from("designs")
      .delete({ count: "exact" }).eq("client_id", clientId).eq("short_code", shortCode);
    if (delErr) return json({ error: delErr.message }, 500);
    if (!count) return json({ error: "Design not found (or not yours)." }, 404);

    // Durable: deleting a customer's design is not something we accept losing the record of.
    // Signature is (action, rowCount, note) — the tenant is already implicit in the resolved
    // context, so passing clientId here would silently land in rowCount.
    await auditStrict("portal_delete_design", 1 + (versionsDeleted ?? 0),
      `code=${shortCode} status=${st} versions=${versionsDeleted ?? 0} files=${filesRemoved} kept=${kept.size} estimate=${estimate}`);
    // A CRM estimate we could not remove is a real leftover in someone else's system, and the
    // row that pointed at it is now gone — so it goes in error_events, where support can find
    // it, rather than living only in a banner the operator dismisses. The estimate id is the
    // whole point of the record: without it nobody can finish the job by hand.
    if (estimate === "failed") {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "delete_design_estimate_failed",
        message: `CRM estimate delete failed: ${estimateError ?? "unknown"}`,
        context: { shortCode, estimateId: String(design.ghl_estimate_id ?? ""), status: st },
      });
    }
    // A stored URL naming something this design could not have produced is not something a
    // tenant does by accident, so it gets a durable row rather than a substring in a note
    // nobody greps. Counts and namespace slugs only — never the URL itself, and never any
    // customer data (the app_errors doctrine).
    if (kept.size) {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "delete_design_key_refused",
        message: `delete_design kept ${kept.size} unrecognised object key(s)`,
        context: { shortCode, refused: kept.size, namespaces: [...foreign].slice(0, 5) },
      });
    }
    return json({
      ok: true, shortCode, versionsDeleted: versionsDeleted ?? 0, filesRemoved, filesKept: kept.size,
      estimate, estimateNumber: design.ghl_estimate_number ?? null, estimateError,
    });
  }

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

  // Full-replace this tenant's DOORS (Options tab → Doors section, fixture_items). Takes the
  // COMPLETE desired door list: rows with an id update, rows without insert, and any existing
  // door absent from the list is deleted. Scoped to category='door' so windows/ramps (same
  // table, later) are never touched. clientId is JWT-resolved (own tenant only). A swing/op
  // "default" is only persisted when BOTH opposite options are allowed (else null), matching
  // the editor. Mirrors save_colors.
  if (action === "save_doors") {
    if (!Array.isArray(payload.doors)) return json({ error: "doors[] required" }, 400);
    const exRes = await admin.from("fixture_items").select("id").eq("client_id", clientId).eq("category", "door");
    if (exRes.error) return json({ error: exRes.error.message }, 500);
    const existingIds = new Set((exRes.data ?? []).map((r: any) => String(r.id)));
    const keptIds = new Set<string>();
    // "" → null (blank), otherwise a finite number, else NaN (invalid → skipped).
    const numOrNull = (v: unknown) => { const s = String(v ?? "").replace(/[$,\s]/g, ""); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : NaN; };
    let saved = 0; const skipped: string[] = [];
    let i = 0;
    for (const row of payload.doors) {
      const name = String(row?.name ?? "").trim();
      if (!name) { skipped.push(`row ${i}: blank name`); i++; continue; }
      const w = numOrNull(row?.widthIn), h = numOrNull(row?.heightIn);
      if (w === null || Number.isNaN(w) || (w as number) <= 0) { skipped.push(`${name}: invalid width`); i++; continue; }
      if (h === null || Number.isNaN(h) || (h as number) <= 0) { skipped.push(`${name}: invalid height`); i++; continue; }
      const price = numOrNull(row?.price);           // null = not-yet-priced (hidden by NULL-price contract)
      if (Number.isNaN(price)) { skipped.push(`${name}: invalid price`); i++; continue; }
      const swingIn = row?.swingIn === true, swingOut = row?.swingOut === true;
      const opRight = row?.opRight === true, opLeft = row?.opLeft === true;
      const opDouble = row?.opDouble === true, opSlideUp = row?.opSlideUp === true;
      const swingDefault = (swingIn && swingOut && (row?.swingDefault === "in" || row?.swingDefault === "out")) ? row.swingDefault : null;
      const opDefault = (opRight && opLeft && (row?.opDefault === "right" || row?.opDefault === "left")) ? row.opDefault : null;
      const rec: Record<string, unknown> = {
        client_id: clientId, category: "door", name,
        plan_label: (String(row?.planLabel ?? "").trim().slice(0, 12)) || null,
        show_image_on_estimate: row?.showImageOnEstimate !== false,
        width_in: w, height_in: h, price,
        swing_in: swingIn, swing_out: swingOut, swing_default: swingDefault,
        op_right: opRight, op_left: opLeft, op_double: opDouble, op_slideup: opSlideUp, op_default: opDefault,
        active: row?.active !== false,
        sort_order: Number.isFinite(Number(row?.sortOrder)) ? Number(row.sortOrder) : i,
        updated_at: new Date().toISOString(),
      };
      if (Object.prototype.hasOwnProperty.call(row, "imageUrl")) rec.image_url = String(row.imageUrl ?? "").trim() || null;
      const rid = String(row?.id ?? "").trim();
      const res = (rid && existingIds.has(rid))
        ? (keptIds.add(rid), await admin.from("fixture_items").update(rec).eq("client_id", clientId).eq("id", rid))
        : await admin.from("fixture_items").insert(rec);
      if (res.error) { skipped.push(`${name}: ${res.error.message}`); i++; continue; }
      saved++; i++;
    }
    const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
    let deleted = 0;
    if (toDelete.length) {
      const del = await admin.from("fixture_items").delete().eq("client_id", clientId).in("id", toDelete);
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
                  // GHL's estimateActionHistory[].updatedAt is the LOCATION's local time with
                  // NO timezone suffix (verified 2026-07-25: history "…T02:39:13" for an estimate
                  // whose real updatedAt was "…T07:39:13.211Z" — the tenant's Central offset), so
                  // the browser would misparse it. `updatedAt` IS zoned, so the UI uses it for the
                  // current status event instead of trusting the history stamp.
                  updatedAt: e?.updatedAt ?? null,
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
  // ── QuickBooks Online ─────────────────────────────────────────────────────────────
  // Connection status + item-mapping grid. Deliberately its OWN select rather than a
  // widening of the "status" action's hand-enumerated list — QuickBooks state changes on
  // a different cadence and the existing card stays untouched.

  if (action === "qbo_status") {
    const { data, error } = await admin
      .from("client_settings")
      .select("qbo_realm_id, qbo_company_name, qbo_connected_at, qbo_refresh_error, qbo_refresh_token_expires_at")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);

    const connected = !!data?.qbo_realm_id && !!data?.qbo_connected_at;
    const { count } = await admin
      .from("qbo_item_map")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId);

    // Never tokens, never the full realm id. The company NAME is the human handle.
    return json({
      clientId, // operator view-as tripwire
      oauthReady: qboOauthReady(),
      connected,
      companyName: data?.qbo_company_name ?? null,
      realmIdMasked: maskId(data?.qbo_realm_id ?? null),
      connectedAt: data?.qbo_connected_at ?? null,
      broken: connected && !!data?.qbo_refresh_error,
      brokenReason: data?.qbo_refresh_error ?? null,
      refreshTokenExpiresAt: data?.qbo_refresh_token_expires_at ?? null,
      mappedCount: count ?? 0,
    });
  }

  if (action === "list_item_map") {
    const [maps, styles, items] = await Promise.all([
      admin.from("qbo_item_map")
        .select("id, line_kind, item_key, style_id, qbo_item_id, qbo_item_name")
        .eq("client_id", clientId),
      admin.from("building_styles")
        .select("id, label, active").eq("client_id", clientId).eq("active", true),
      admin.from("client_layout_items")
        .select("item_key, label, active").eq("client_id", clientId).eq("active", true),
    ]);
    if (maps.error) return json({ error: maps.error.message }, 500);
    return json({
      clientId,
      mappings: maps.data ?? [],
      styles: styles.data ?? [],
      layoutItems: items.data ?? [],
    });
  }

  if (action === "save_item_map") {
    // rows: [{ lineKind, itemKey?, styleId?, qboItemId, qboItemName? }]
    // Blank qboItemId = delete that mapping. MANUAL upsert, not PostgREST onConflict:
    // the table's uniqueness lives in two partial indexes, which onConflict cannot
    // infer (same documented reason as save_layout_pricing above).
    if (!Array.isArray(payload?.rows)) return json({ error: "rows[] required" }, 400);

    const KINDS = new Set(["building", "paint", "roof", "door", "layout_item", "custom_option", "discount", "delivery", "fallback"]);

    // Validate against the tenant's OWN catalog — an item key or style id from another
    // tenant must not be writable here.
    const [itemsRes, stylesRes, exRes] = await Promise.all([
      admin.from("client_layout_items").select("item_key").eq("client_id", clientId).eq("active", true),
      admin.from("building_styles").select("id").eq("client_id", clientId),
      admin.from("qbo_item_map").select("id, line_kind, item_key, style_id").eq("client_id", clientId),
    ]);
    if (exRes.error) return json({ error: exRes.error.message }, 500);
    const validKeys = new Set((itemsRes.data ?? []).map((i: any) => i.item_key));
    const validStyles = new Set((stylesRes.data ?? []).map((s: any) => s.id));
    const keyOf = (k: string, ik: string, sid: string | null) => `${k}|${ik}|${sid ?? ""}`;
    const idByKey = new Map<string, string>();
    for (const r of exRes.data ?? []) idByKey.set(keyOf(r.line_kind, r.item_key, r.style_id), r.id);

    let saved = 0, deleted = 0;
    const skipped: string[] = [];
    for (const row of payload.rows) {
      const lineKind = String(row?.lineKind ?? "").trim();
      const itemKey = String(row?.itemKey ?? "").trim();
      const styleId = row?.styleId ? String(row.styleId) : null;
      const qboItemId = String(row?.qboItemId ?? "").trim();
      const qboItemName = String(row?.qboItemName ?? "").trim() || null;

      if (!KINDS.has(lineKind)) { skipped.push(`${lineKind || "(blank)"}: unknown line kind`); continue; }
      if ((lineKind === "layout_item") !== (itemKey !== "")) { skipped.push(`${lineKind}: item key ${itemKey ? "not allowed" : "required"}`); continue; }
      if (itemKey && !validKeys.has(itemKey)) { skipped.push(`${itemKey}: not an enabled item`); continue; }
      if (styleId && !validStyles.has(styleId)) { skipped.push(`${lineKind}: unknown style`); continue; }
      if (styleId && !(lineKind === "building" || lineKind === "layout_item")) { skipped.push(`${lineKind}: style override not supported`); continue; }

      const existingId = idByKey.get(keyOf(lineKind, itemKey, styleId));
      if (!qboItemId) {
        if (existingId) {
          const del = await admin.from("qbo_item_map").delete().eq("id", existingId);
          if (del.error) { skipped.push(`${lineKind}: ${del.error.message}`); continue; }
          deleted++;
        }
        continue;
      }
      const res = existingId
        ? await admin.from("qbo_item_map")
            .update({ qbo_item_id: qboItemId, qbo_item_name: qboItemName, updated_at: new Date().toISOString() })
            .eq("id", existingId)
        : await admin.from("qbo_item_map")
            .insert({ client_id: clientId, line_kind: lineKind, item_key: itemKey, style_id: styleId, qbo_item_id: qboItemId, qbo_item_name: qboItemName });
      if (res.error) { skipped.push(`${lineKind}: ${res.error.message}`); continue; }
      saved++;
    }

    await audit("qbo_save_item_map", saved + deleted, skipped.length ? `${skipped.length} skipped` : null);
    return json({ ok: true, saved, deleted, skipped, clientId });
  }

  if (action === "list_qbo_items") {
    // Server-side QBO query; the token never leaves this function (the
    // list_ghl_pipelines doctrine). Fed to the mapping grid's dropdowns.
    const { data: cs } = await admin.from("client_settings")
      .select("qbo_realm_id").eq("client_id", clientId).maybeSingle();
    if (!cs?.qbo_realm_id) return json({ error: "QuickBooks is not connected." }, 400);
    try {
      const q = encodeURIComponent("select Id, Name, Type, Active from Item where Active = true maxresults 1000");
      const body = await qboFetch(admin, clientId, cs.qbo_realm_id, `/query?query=${q}&minorversion=75`);
      const items = (body?.QueryResponse?.Item ?? []).map((i: any) => ({
        id: String(i.Id), name: i.Name ?? String(i.Id), type: i.Type ?? "",
      }));
      return json({ items, clientId });
    } catch (e) {
      if (e instanceof QboBroken) return json({ error: "QuickBooks needs to be reconnected.", broken: true }, 409);
      if (e instanceof QboNotConnected) return json({ error: "QuickBooks is not connected." }, 400);
      return json({ error: "Could not load items from QuickBooks. Try again shortly." }, 502);
    }
  }

  if (action === "qbo_test") {
    // On-demand probe via CompanyInfo THROUGH the token helper, so an expired access
    // token exercises the refresh path — which is exactly what a "Test" should prove.
    const { data: cs } = await admin.from("client_settings")
      .select("qbo_realm_id").eq("client_id", clientId).maybeSingle();
    if (!cs?.qbo_realm_id) return json({ error: "QuickBooks is not connected." }, 400);
    try {
      const body = await qboFetch(admin, clientId, cs.qbo_realm_id,
        `/companyinfo/${cs.qbo_realm_id}?minorversion=75`);
      const name = body?.CompanyInfo?.CompanyName ?? null;
      if (name) {
        // Keep the stored name current — it may have been edited in QuickBooks.
        await admin.from("client_settings")
          .update({ qbo_company_name: name }).eq("client_id", clientId);
      }
      return json({ ok: true, companyName: name, clientId });
    } catch (e) {
      if (e instanceof QboBroken) return json({ ok: false, broken: true, error: "QuickBooks refused the connection — reconnect to restore it.", clientId }, 200);
      return json({ ok: false, error: "Could not reach QuickBooks. Try again shortly.", clientId }, 200);
    }
  }

  if (action === "disconnect_qbo") {
    const { data: cs } = await admin.from("client_settings")
      .select("qbo_realm_id, qbo_refresh_token").eq("client_id", clientId).maybeSingle();
    if (!cs?.qbo_realm_id) return json({ error: "QuickBooks is not connected." }, 400);

    // Best-effort revoke at Intuit — a failure here must not block the disconnect.
    const id = Deno.env.get("QBO_CLIENT_ID"), secret = Deno.env.get("QBO_CLIENT_SECRET");
    if (id && secret && cs.qbo_refresh_token) {
      await fetch("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ token: cs.qbo_refresh_token }),
      }).catch(() => {});
    }

    // KEEP qbo_realm_id (tombstone) and KEEP qbo_item_map: reconnecting the SAME company
    // must not lose mapping work — the callback only wipes the map when the realm CHANGES.
    // Side effect of the tombstone + unique index: this company cannot be attached to a
    // DIFFERENT tenant while the tombstone stands; moving a company between tenants means
    // clearing qbo_realm_id here first. That friction is intentional.
    const { error } = await admin.from("client_settings").update({
      qbo_access_token: null,
      qbo_access_token_expires_at: null,
      qbo_refresh_token: null,
      qbo_refresh_token_expires_at: null,
      qbo_connected_at: null,
      qbo_refresh_error: null,
      qbo_refreshing_at: null,
      qbo_oauth_state: null,
      qbo_oauth_state_expires_at: null,
    }).eq("client_id", clientId);
    if (error) return json({ error: error.message }, 500);

    await auditStrict("qbo_disconnect", 1, `realm kept as tombstone`);
    return json({ ok: true, clientId });
  }

  if (action === "send_invoice") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);

    // An operator is emailing a real invoice to SOMEONE ELSE'S customer. Two extra
    // conditions, neither of which applies to a tenant sending their own:
    //   1. An explicit confirmation in the body. portal.html already shows a confirm
    //      dialog, but that is client-side only and a mis-scoped script must not be able
    //      to email a stranger's customers.
    //   2. A durable audit row written BEFORE the irreversible convert below. This is
    //      auditStrict, not the best-effort audit used for reads: if we cannot record who
    //      triggered it, we do not trigger it.
    if (operator) {
      if (payload?.confirmSend !== true) {
        return json({ error: "Operator sends require explicit confirmation (confirmSend)." }, 400);
      }
      try {
        await auditStrict("operator_send_invoice_attempt", null, `short_code=${shortCode}`);
      } catch (e) {
        return json({ error: (e as Error).message }, 503);
      }
    }

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
      return json({ error: "Connect your CRM first (Settings → CRM Connection)." }, 400);
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
    // The claim key is (client_id, short_code) where client_id is the TENANT — never the
    // actor. Do NOT add the operator to this key: an operator send and an owner send would
    // then each take their own claim on the same design and both could convert the same
    // estimate. Attribution belongs in sent_by_operator, which is not part of the PK.
    const claimIns = await admin.from("invoice_sends").insert({
      client_id: clientId, short_code: shortCode,
      ghl_estimate_id: String(design.ghl_estimate_id), status: "claimed", attempts: 1,
      sent_by_operator: operator ? operator.email : null,
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
        if (!resendInvoiceId) return json({ error: "An invoice was created in your CRM for this design but its id wasn't recorded — send it from your CRM." }, 409);
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
    let ghlInvoiceTotal: number | null = null; // for the QBO push's mismatch note only

    if (!invoiceId) {
      // ── 2. Read the live estimate: must be accepted (and not already invoiced). ──
      let est: any = null;
      const limit = 100;
      for (let offset = 0; offset < 2000 && !est; offset += limit) {
        const r = await ghl(`https://services.leadconnectorhq.com/invoices/estimate/list?altId=${encodeURIComponent(locationId)}&altType=location&limit=${limit}&offset=${offset}`, { headers: ghlHeaders });
        if (!r.ok) {
          await setClaim({ status: "failed", error: `estimate list ${r.status}` });
          return json({ error: `Could not read estimates from your CRM (${r.status || r.netErr}).` }, 502);
        }
        const arr: any[] = Array.isArray(r.body?.estimates) ? r.body.estimates : [];
        est = arr.find((e) => String(e?._id ?? "") === String(design.ghl_estimate_id)) ?? null;
        if (arr.length < limit) break;
      }
      if (!est) {
        await setClaim({ status: "failed", error: "estimate not found" });
        return json({ error: "The estimate could not be found in your CRM." }, 404);
      }
      const estStatus = String(est?.estimateStatus ?? "").toLowerCase();
      if (estStatus === "invoiced") {
        await setClaim({ status: "failed", error: "already invoiced in GHL" });
        return json({ error: "This estimate was already invoiced in your CRM — send that invoice from there." }, 400);
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
        return json({ error: "Your CRM has no user to send the invoice as — add a user to that sub-account, then try again. (Nothing was invoiced.)" }, 400);
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
      ghlInvoiceTotal = Number.isFinite(Number(invoice?.total)) ? Number(invoice.total) : null;
      if (!invoiceId) {
        await setClaim({ status: "failed", error: "no invoice id returned" });
        return json({ error: "Your CRM did not return an invoice id." }, 502);
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
          error: `Invoice ${invoiceNumber ?? ""} was created in your CRM but the email didn't go out (${sendRes.body?.message ?? sendRes.status ?? sendRes.netErr}). Click Send invoice on this design again to retry the email — it will NOT create a second invoice.`,
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
        return json({ error: "Your CRM has no user to send the invoice as — add a user to that sub-account, then retry." }, 400);
      }
      const sendRes = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invoiceId)}/send`, {
        method: "POST", headers: ghlHeaders,
        body: JSON.stringify({ altId: locationId, altType: "location", action: "email", liveMode: true, userId }),
      });
      if (!sendRes.ok) {
        await setClaim({ status: "created", error: `resend ${sendRes.status || sendRes.netErr}`.slice(0, 500) });
        return json({ error: `Retrying the email for invoice ${invoiceNumber ?? ""} failed (${sendRes.body?.message ?? sendRes.status ?? sendRes.netErr}). You can send it from your CRM.`, invoiceId, invoiceNumber, created: true, sent: false }, 502);
      }
    }

    // ── 6. Done: mark the ledger sent and cache the design's status. ──
    await setClaim({ status: "sent", error: null });
    await admin.from("designs")
      .update({ status: "invoiced", updated_at: nowIso() })
      .eq("client_id", clientId).eq("short_code", shortCode);
    // Result row closes the attempt row written before the convert. Best-effort here —
    // the money has already moved, so failing the response now would only mislead.
    if (operator) audit("operator_send_invoice_result", null, `short_code=${shortCode} invoice=${invoiceNumber ?? invoiceId}`);

    // ── 7. QuickBooks push — bookkeeping, strictly after the money moved. ──
    // pushQboInvoice never throws and never touches this response; every outcome lands
    // on the invoice_sends row (qbo_* columns). Dark unless the tenant is connected AND
    // the design has an estimate_lines snapshot, so this is a no-op for everyone today.
    await pushQboInvoice(admin, clientId, {
      shortCode,
      docNumber: invoiceNumber,
      ghlTotal: ghlInvoiceTotal,
    });

    return json({ ok: true, invoiceId, invoiceNumber, sent: true });
  }

  if (action === "retry_qbo_push") {
    // Re-run the QuickBooks push for an invoice that was sent but never landed in the
    // books (typically: mappings were incomplete at send time and the push aborted).
    // Owner/admin by omission from READ_ACTIONS.
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);

    const { data: row } = await admin.from("invoice_sends")
      .select("status, invoice_number, qbo_invoice_id")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (!row) return json({ error: "No invoice has been sent for this design." }, 404);
    if (row.status !== "sent") return json({ error: "The invoice email hasn't gone out yet — retry that first." }, 400);
    if (row.qbo_invoice_id) return json({ ok: true, alreadyPushed: true, qboInvoiceId: row.qbo_invoice_id, clientId });

    await pushQboInvoice(admin, clientId, { shortCode, docNumber: row.invoice_number ?? null });

    const { data: after } = await admin.from("invoice_sends")
      .select("qbo_invoice_id, qbo_doc_number, qbo_error")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    await audit("qbo_retry_push", 1, after?.qbo_invoice_id ? `pushed ${after.qbo_doc_number ?? ""}` : (after?.qbo_error ?? null));
    return json({
      ok: !!after?.qbo_invoice_id,
      qboInvoiceId: after?.qbo_invoice_id ?? null,
      qboDocNumber: after?.qbo_doc_number ?? null,
      error: after?.qbo_invoice_id ? null : (after?.qbo_error ?? "The push did not complete."),
      clientId,
    });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
}));
