import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkAdminPassword } from "../_shared/adminGate.ts";
import { checkAdminAuth } from "../_shared/adminAuth.ts";
import { withErrorLog } from "../_shared/logError.ts";
import { AUTH_PORTAL_URL } from "../_shared/authPortalUrl.ts";

// Operator (super-admin) catalog tool, used by the standalone admin.html page.
// Gated by the shared ADMIN_PASSWORD edge-function secret (same secret as
// admin-save-settings). Manages the GLOBAL master layout-item palette (layout_item_types)
// and per-client catalog (client_layout_items, building_styles/building_sizes). All writes
// use the service role (bypass RLS).
// Kept separate from admin-save-settings so GHL-credential logic stays isolated.

const cors = {
  "Access-Control-Allow-Origin": "*",
  // x-ss-stepup: sent by portal.html's adminApi on password-carrying step-up calls
  // (delete_client) so its 401s bypass the global session-expired logout. A custom
  // request header MUST be in this allow-list or the browser kills the call at CORS
  // preflight — for right AND wrong passwords alike, which is exactly how the 00a819b
  // step-up fix shipped broken: the header was added client-side only.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ss-stepup",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const reqStr = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required.`);
  return v.trim();
};

// AUTH_PORTAL_URL — the one destination every auth email lands on — moved to
// `_shared/authPortalUrl.ts` (imported above) when operator-portal gained its own
// reset-link action. The reasoning is in that file; the short version is that a second
// copy of this constant would be exactly the drift it exists to prevent.

// ── Supabase Auth custom-SMTP config via the Management API ──────────────────
// Powers the admin.html "Email Sender" card. Pointing the project's Auth SMTP at
// a Google account (Gmail host + app password) makes ALL auth emails — owner
// invites, password resets, email changes — send from that address instead of
// Supabase's default sender, with no per-flow code. Requires a Supabase personal
// access token in the MGMT_TOKEN secret — NOT "SUPABASE_MGMT_TOKEN": Supabase
// reserves the SUPABASE_ prefix and rejects any edge secret named with it. The app
// password is write-only: it lives only inside this Auth config, never returned by GET.
const PROJECT_REF = "jzeamjbhdrsbygdnphbm";
async function mgmtAuthConfig(method: "GET" | "PATCH", body?: unknown) {
  const token = Deno.env.get("MGMT_TOKEN");
  if (!token) {
    throw new Error(
      "Email sending isn't set up on the server yet: the MGMT_TOKEN secret is missing. " +
      "Create a Supabase personal access token at https://supabase.com/dashboard/account/tokens and add " +
      "it as an Edge Function secret named MGMT_TOKEN.");
  }
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const msg = (data && (data.message || data.error || data.msg)) || text || `request failed (${r.status})`;
    // 401/403 means the secret EXISTS but the Management API rejected it — an expired, revoked or
    // wrong-project token. That is a different fix from the missing-secret branch above, and it used
    // to surface as a bare "Supabase Management API: Unauthorized", which reads like a code bug and
    // cost a whole session to diagnose (the giveaway was only that it was NOT the missing-token
    // message). Name the actual cause and the actual fix, matching that branch's helpfulness.
    if (r.status === 401 || r.status === 403) {
      throw new Error(
        "Email sending is misconfigured on the server: the MGMT_TOKEN secret is present but the " +
        "Supabase Management API rejected it (expired, revoked, or issued for a different project). " +
        "Mint a fresh personal access token at https://supabase.com/dashboard/account/tokens and " +
        "replace the Edge Function secret named MGMT_TOKEN, then retry. " +
        `Until then get_email_sender / connect_email / disconnect_email all fail. (API said: ${String(msg).slice(0, 200)})`);
    }
    throw new Error(`Supabase Management API: ${String(msg).slice(0, 500)}`);
  }
  return data;
}

// Validate a client_id: DNS-safe slug AND must exist in client_configs — so a
// write/upload can never land under a typo'd or malformed tenant prefix.
async function assertClient(sb: any, clientId: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) throw new Error("invalid client id");
  const { data, error } = await sb.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("unknown builder");
  return clientId;
}

// Shared CSV pricing + inclusion importer (also used by portal-settings).
// rows: [{ style, width, length, price, active, inclusions: { item_key: qty } }].
// Inclusion cells are QUANTITIES (2026-07-07): loft = included sq ft (e.g. 50),
// doors = count (e.g. 1); 0/blank/"no" = not included. Legacy yes-style tokens
// still import as quantity 1 so previously downloaded sheets keep working.
// Resolves the style by label OR key (case-insensitive). CREATES the size if a
// (style, width, length) combo doesn't exist yet, otherwise UPDATES it — keyed on
// dimensions, so re-uploading the same sheet updates prices without ever creating
// duplicates. A size is offered only when it's active AND priced: a blank price (or
// active=no) hides it (NULL-base-price contract). Never creates styles — those must
// exist first (built via the styles tab), which is what the IDs are matched against.
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

Deno.serve(withErrorLog("admin-catalog", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let p: any;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  // Service-role client is created BEFORE the gate because the gate needs it for the
  // attempt ledger + audit. Creating a client grants nothing on its own.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const action = p.action;

  // Dual-credential gate: a valid operator JWT (the portal's embedded Admin tab, which
  // already carries the operator's session) OR the shared password (standalone admin.html).
  // Password callers keep the full throttle/lockout/audit behaviour of migration 053 —
  // see _shared/adminAuth.ts for why a signed-in NON-operator is refused outright rather
  // than being allowed to fall through and probe the password.
  const gate = await checkAdminAuth(req, p?.adminPassword, sb, String(action ?? ""));
  if (!gate.ok) return json(gate.body, gate.status);
  const identity = gate.identity;

  // Step-up: a few actions stay password-gated even for an operator, because their blast
  // radius is not the one tenant being administered.
  //   delete_client       — irreversibly wipes a tenant AND deletes their auth logins.
  //   connect/disconnect_email — rewrite the PROJECT-WIDE Auth SMTP config, so they affect
  //                         every tenant's password-reset mail, not just this one.
  const PASSWORD_REQUIRED = new Set(["delete_client", "connect_email", "disconnect_email"]);
  if (identity.via === "operator" && PASSWORD_REQUIRED.has(String(action ?? ""))) {
    const stepUp = await checkAdminPassword(req, p?.adminPassword, sb, String(action ?? ""));
    if (!stepUp.ok) return json(stepUp.body, stepUp.status);
  }

  // Per-operator rights (migration 056: can_write / can_bill, both default FALSE).
  //
  // Enumerated as READS rather than writes, deliberately: a new action added below and
  // forgotten here is then denied to read-only operators rather than silently granted to
  // them. Deny-by-default is the only safe direction for a list somebody will extend.
  //
  // Gated on `via === "operator"` ONLY. The password path has no operator row, so
  // `canWrite` is undefined there and an unconditional check would 403 the standalone
  // break-glass console out of every write while telling it the account is read-only.
  const READ_ONLY_ACTIONS = new Set([
    "list_clients", "get_master", "get_client_catalog", "get_email_sender",
  ]);
  if (identity.via === "operator" && !READ_ONLY_ACTIONS.has(String(action ?? ""))) {
    if (!identity.canWrite) {
      return json({ error: "This operator account is read-only." }, 403);
    }
    // Money is a separate grant from configuration — 056's own words: "Adding an operator
    // should never silently grant the ability to charge a client's card." set_billing sets
    // the discount and the exemption that every later charge is computed from.
    if ((String(action ?? "") === "set_billing" || String(action ?? "") === "set_feature_grants")
        && !identity.canBill) {
      return json({ error: "This operator account cannot change billing." }, 403);
    }
  }

  // Successful operator-authenticated calls are recorded. Until now only FAILURES were
  // audited, which meant an authorized admin action left no trace at all.
  if (identity.via === "operator") {
    try {
      await sb.from("admin_audit").insert({
        action: `admin_${String(action ?? "")}`,
        target_client_id: typeof p?.clientId === "string" ? p.clientId : null,
        actor_email: identity.email,
        actor_user_id: identity.userId,
        note: "via=operator_jwt",
      });
    } catch (_e) { /* best-effort: never block the console on a log failure */ }
  }

  try {
    switch (action) {
      // ── reads ───────────────────────────────────────────────────────────
      case "list_clients": {
        const { data, error } = await sb.from("client_configs").select("client_id, company_name").order("client_id");
        if (error) throw error;
        // Billing posture per tenant, so the console can show at a glance who is comped
        // and who is discounted. client_settings is service-role only — this function is
        // the only place it can be read from.
        const { data: cs } = await sb.from("client_settings")
          .select("client_id, billing_exempt, billing_exempt_until, discount_percent, discount_features");
        const byId = new Map((cs ?? []).map((r: any) => [r.client_id, r]));
        // The billable feature list, so the console can offer a per-feature discount
        // picker without hardcoding a copy of the catalogue that would drift from
        // billing_plans. One entry per feature (monthly/annual share a feature).
        const { data: planRows } = await sb.from("billing_plans")
          .select("feature, name, availability, required, operator_grantable").eq("active", true).order("sort_order", { ascending: false });
        const seenFeature = new Set<string>();
        const features = (planRows ?? []).filter((p: any) => {
          if (!p.feature || seenFeature.has(p.feature)) return false;
          seenFeature.add(p.feature);
          return true;
        }).map((p: any) => ({ feature: p.feature, name: p.name, availability: p.availability, required: p.required, operatorGrantable: Boolean(p.operator_grantable) }));
        // Operator grants per tenant (migration 109) — the console's "Early access" card.
        // client_feature_grants is service-role only, so this function is the only reader.
        const { data: grantRows } = await sb.from("client_feature_grants")
          .select("client_id, feature, expires_at");
        const grantsById = new Map<string, any[]>();
        for (const g of (grantRows ?? []) as any[]) {
          const arr = grantsById.get(g.client_id) ?? [];
          arr.push({ feature: g.feature, expiresAt: g.expires_at ?? null });
          grantsById.set(g.client_id, arr);
        }
        const clients = (data ?? []).map((c: any) => {
          const s = byId.get(c.client_id);
          return {
            ...c,
            billingExempt: Boolean(s?.billing_exempt),
            discountPercent: Number(s?.discount_percent) || 0,
            discountFeatures: s?.discount_features ?? null,
            exemptUntil: s?.billing_exempt_until ?? null,
            grants: grantsById.get(c.client_id) ?? [],
          };
        });
        return json({ ok: true, clients, features });
      }
      case "get_master": {
        // Master LAYOUT-ITEM palette only. The global building-style catalog was retired
        // (migration 030) — tenants get styles via the Clone feature or per-client
        // create_style, not by assigning from a global master template.
        const items = await sb.from("layout_item_types").select("*").order("sort_order").order("item_key");
        if (items.error) throw items.error;
        return json({ ok: true, layoutItemTypes: items.data });
      }
      case "get_client_catalog": {
        const clientId = reqStr(p.clientId, "clientId");
        const [styles, sizes, items, incl] = await Promise.all([
          sb.from("building_styles").select("id, client_id, key, label, image_url, sort_order, active").eq("client_id", clientId).order("sort_order"),
          sb.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, sort_order, active").eq("client_id", clientId).order("sort_order"),
          sb.from("client_layout_items").select("*").eq("client_id", clientId).order("sort_order"),
          sb.from("building_size_inclusions").select("size_id, item_key, included, qty").eq("client_id", clientId),
        ]);
        if (styles.error) throw styles.error; if (sizes.error) throw sizes.error; if (items.error) throw items.error; if (incl.error) throw incl.error;
        return json({ ok: true, buildingStyles: styles.data, buildingSizes: sizes.data, clientLayoutItems: items.data, inclusions: incl.data });
      }
      // ── layout-item assignment ──────────────────────────────────────────
      case "toggle_item":
      case "save_item_assignment": {
        const clientId = reqStr(p.clientId, "clientId");
        const itemKey  = reqStr(p.itemKey, "itemKey");
        const row: any = { client_id: clientId, item_key: itemKey,
          active: p.active !== false, sort_order: Number.isFinite(p.sortOrder) ? p.sortOrder : 0,
          updated_at: new Date().toISOString() };
        if (action === "save_item_assignment") {
          row.label_override       = p.labelOverride ?? null;
          row.width_override       = p.widthOverride ?? null;
          row.height_override      = p.heightOverride ?? null;
          row.short_label_override = p.shortLabelOverride ?? null;
        }
        const { error } = await sb.from("client_layout_items").upsert(row, { onConflict: "client_id,item_key" });
        if (error) throw error;
        return json({ ok: true });
      }

      // ── building-style management (per-client; the global master was retired in 030) ──
      case "unassign_style": {
        const clientId = reqStr(p.clientId, "clientId");
        const styleKey = reqStr(p.styleKey, "styleKey");
        const { error } = await sb.from("building_styles").update({ active: false }).eq("client_id", clientId).eq("key", styleKey);
        if (error) throw error;
        return json({ ok: true });
      }
      case "save_style": {
        const clientId = reqStr(p.clientId, "clientId");
        const styleKey = reqStr(p.styleKey, "styleKey");
        const patch: any = {};
        if ("label" in p)     patch.label = p.label;
        if ("imageUrl" in p)  patch.image_url = p.imageUrl;
        if ("sortOrder" in p) patch.sort_order = p.sortOrder;
        if ("active" in p)    patch.active = !!p.active;
        const { error } = await sb.from("building_styles").update(patch).eq("client_id", clientId).eq("key", styleKey);
        if (error) throw error;
        return json({ ok: true });
      }
      case "save_sizes": {
        // body.sizes: [{ label, widthFt, lengthFt, basePrice, sortOrder, active }]
        const clientId = reqStr(p.clientId, "clientId");
        const styleId  = reqStr(p.styleId, "styleId");
        if (!Array.isArray(p.sizes)) throw new Error("sizes[] required");
        for (const s of p.sizes) {
          await sb.from("building_sizes").upsert({
            client_id: clientId, style_id: styleId, label: reqStr(s.label, "size.label"),
            width_ft: s.widthFt, length_ft: s.lengthFt,
            base_price: (s.basePrice === "" || s.basePrice == null) ? null : Number(s.basePrice),
            sort_order: s.sortOrder ?? 0, active: s.active !== false,
          }, { onConflict: "style_id,label" });
        }
        return json({ ok: true });
      }

      // ── per-client style creation (no master dependency) ───────────────
      // Building styles are never shared across companies (every client has
      // their own "garage"/"studio" with their own image + prices), so this
      // creates a style straight on the client, deriving a unique per-client key.
      case "create_style": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        const label    = reqStr(p.label, "label");
        const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "")) || "style";
        // INSERT (not upsert) so a concurrent same-key create surfaces as a 23505 we
        // retry — never a silent overwrite of an existing style. (The global master
        // key-reservation was removed with the building_style_catalog table in 030.)
        let key = base, n = 1;
        for (let attempt = 0; attempt < 50; attempt++) {
          const ins = await sb.from("building_styles").insert(
            { client_id: clientId, key, label, image_url: p.imageUrl ?? null,
              sort_order: Number.isFinite(p.sortOrder) ? p.sortOrder : 0, active: true })
            .select("id, key").maybeSingle();
          if (!ins.error) return json({ ok: true, styleId: ins.data!.id, key: ins.data!.key });
          if (ins.error.code !== "23505") throw ins.error;
          key = `${base}-${++n}`;
        }
        throw new Error("could not allocate a unique style key");
      }
      // Upload a building-style image (base64) to the public 'branding' bucket
      // and return its public URL; the caller stores it via create_style/save_style.
      case "upload_image": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        if (typeof p.imageBase64 !== "string" || !p.imageBase64.trim()) throw new Error("No image data.");
        // Raster allowlist only — reject SVG (script-bearing stored-XSS vector on
        // the public branding bucket) and any other caller-asserted type.
        const ct = String(p.contentType || "image/jpeg");
        const EXT_BY_CT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
        const ext = EXT_BY_CT[ct];
        if (!ext) throw new Error("Unsupported image type (use JPG, PNG, WEBP or GIF).");
        const rawB64 = p.imageBase64.replace(/^data:[^;]+;base64,/, "");
        if (rawB64.length > 4_200_000) throw new Error("Image too large (max 3MB)."); // guard before the full atob decode
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(atob(rawB64), (c) => c.charCodeAt(0)); } catch { throw new Error("Invalid image data."); }
        if (bytes.length > 3_000_000) throw new Error("Image too large (max 3MB).");
        const path = `${clientId}/style-${Date.now()}.${ext}`;
        const upl = await sb.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
        if (upl.error) throw new Error(`Image upload failed: ${upl.error.message}`);
        const { data: pub } = sb.storage.from("branding").getPublicUrl(path);
        return json({ ok: true, url: pub.publicUrl });
      }

      // ── master catalog CRUD ─────────────────────────────────────────────
      case "save_master_item": {
        const row = {
          item_key: reqStr(p.itemKey, "itemKey"),
          label: reqStr(p.label, "label"),
          icon: p.icon ?? "", color: p.color ?? "#000000",
          default_width: Number(p.defaultWidth ?? 3), default_height: Number(p.defaultHeight ?? 3),
          wall_only: !!p.wallOnly, wall_snap: !!p.wallSnap, door_snap: !!p.doorSnap,
          short_label: p.shortLabel ?? "", sort_order: p.sortOrder ?? 0, active: p.active !== false,
          updated_at: new Date().toISOString(),
        };
        const { error } = await sb.from("layout_item_types").upsert(row, { onConflict: "item_key" });
        if (error) throw error;
        return json({ ok: true });
      }

      // ── CSV pricing + inclusion import ──────────────────────────────────
      // body.rows: [{ style, width, length, price, active, inclusions: {item_key: yes/no} }]
      // Creates-or-updates building_sizes by (style, width, length) — see importPricingRows.
      case "import_pricing_csv": {
        const clientId = reqStr(p.clientId, "clientId");
        if (!Array.isArray(p.rows)) throw new Error("rows[] required");
        const r = await importPricingRows(sb, clientId, p.rows);
        return json({ ok: true, ...r });
      }

      // ── create a new tenant (config row only) ──────────────────────────
      // Makes a COMPLETE client_configs row by cloning a template's
      // contact_fields/default_sizes/options + the supplied branding, so
      // get_config returns a valid (empty-catalog) config the moment it exists.
      // The owner LOGIN is created separately in Supabase Auth (account creation
      // is out of scope here); building styles/items/pricing are added via the tabs.
      case "create_client": {
        const clientId = reqStr(p.clientId, "clientId").toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) throw new Error("Builder id must be lowercase letters, numbers and hyphens (DNS-safe).");
        const reserved = ["www", "beta", "dev", "staging", "app", "api", "admin", "portal"];
        if (reserved.includes(clientId)) throw new Error(`"${clientId}" is a reserved id.`);
        const companyName = reqStr(p.companyName, "companyName");
        const exists = await sb.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
        if (exists.error) throw exists.error;
        if (exists.data) throw new Error(`A builder "${clientId}" already exists.`);
        // templateClientId === "__none__" => start blank (no clone): a standard contact
        // form so the designer works, and empty sizes/options the operator fills in via
        // the tabs + pricing CSV. Otherwise clone the named template (or junior-barns).
        const blank = String(p.templateClientId || "").trim().toLowerCase() === "__none__";
        let contactFields: unknown, defaultSizes: unknown, options: unknown;
        let templateId: string | null = null;
        if (blank) {
          contactFields = ["name", "email", "phone", "street", "city", "state", "zip"];
          defaultSizes = [];
          options = [];
        } else {
          const tmplId = (typeof p.templateClientId === "string" && p.templateClientId.trim()) ? p.templateClientId.trim() : "junior-barns";
          const tmpl = await sb.from("client_configs").select("contact_fields, default_sizes, options").eq("client_id", tmplId).maybeSingle();
          if (tmpl.error) throw tmpl.error;
          if (!tmpl.data) throw new Error(`Template builder "${tmplId}" not found.`);
          contactFields = tmpl.data.contact_fields; defaultSizes = tmpl.data.default_sizes; options = tmpl.data.options;
          templateId = tmplId;
        }
        const opt = (v: unknown) => (typeof v === "string" && v.trim()) ? v.trim() : null;
        const ins = await sb.from("client_configs").insert({
          client_id: clientId, company_name: companyName,
          tagline: opt(p.tagline), accent_color: opt(p.accentColor), header_bg: opt(p.headerBg), logo_url: opt(p.logoUrl),
          contact_fields: contactFields, default_sizes: defaultSizes, options,
          updated_at: new Date().toISOString(),
        });
        if (ins.error) throw ins.error;

        // Non-billable (CSM Synergy internal / demo / testing) accounts skip the billing
        // gate entirely. This is the ONLY place the flag is set at creation, and it needs
        // a client_settings row to live in — which create_client otherwise leaves for the
        // owner to fill in via the portal. A normal new client gets no row here, so
        // billing_exempt reads false and the gate applies: they land on Billing and pay
        // before anything unlocks.
        const newDiscount = Math.round(Number(p.discountPercent) || 0);
        if (!Number.isFinite(newDiscount) || newDiscount < 0 || newDiscount > 100) {
          throw new Error("discountPercent must be a whole number from 0 to 100.");
        }
        // Empty/absent = the discount applies to EVERY feature. A list narrows it.
        const newDiscountFeatures = Array.isArray(p.discountFeatures) && p.discountFeatures.length
          ? p.discountFeatures.map((f: unknown) => String(f))
          : null;
        if (p.billingExempt === true || newDiscount > 0) {
          const bx = await sb.from("client_settings").upsert({
            client_id: clientId,
            billing_exempt: p.billingExempt === true,
            discount_percent: newDiscount,
            discount_features: newDiscountFeatures,
            updated_at: new Date().toISOString(),
          }, { onConflict: "client_id" });
          if (bx.error) throw bx.error;
        }

        // Clone the template's FULL catalog so the new client is usable immediately — the
        // config row alone has no styles/sizes/prices/items/colors (the old bug: a cloned
        // client "didn't bring it all over"). New rows get fresh ids; foreign keys are
        // remapped old→new. client_settings is intentionally NOT copied (GHL credentials +
        // business identity are per-client). Inserts only — nothing is dropped or removed.
        let clonedCounts: Record<string, number> | null = null;
        if (templateId) {
          const T = templateId, Cc = clientId;
          const counts: Record<string, number> = {};

          // 1. building_styles → old id → new id (matched by stable per-client key)
          const stSrc = await sb.from("building_styles").select("key, label, image_url, sort_order, active").eq("client_id", T);
          if (stSrc.error) throw new Error(`clone styles read: ${stSrc.error.message}`);
          if ((stSrc.data ?? []).length) {
            const r = await sb.from("building_styles").insert((stSrc.data ?? []).map((s: any) => ({
              client_id: Cc, key: s.key, label: s.label, image_url: s.image_url, sort_order: s.sort_order, active: s.active,
            })));
            if (r.error) throw new Error(`clone styles: ${r.error.message}`);
          }
          const [oldStyles, newStyles] = await Promise.all([
            sb.from("building_styles").select("id, key").eq("client_id", T),
            sb.from("building_styles").select("id, key").eq("client_id", Cc),
          ]);
          if (oldStyles.error) throw oldStyles.error; if (newStyles.error) throw newStyles.error;
          const newStyleIdByKey = new Map<string, string>();
          for (const s of newStyles.data ?? []) newStyleIdByKey.set(String(s.key), s.id);
          const styleIdMap = new Map<string, string>();   // old style id → new style id
          for (const s of oldStyles.data ?? []) { const nid = newStyleIdByKey.get(String(s.key)); if (nid) styleIdMap.set(s.id, nid); }
          counts.building_styles = styleIdMap.size;

          // 2. building_sizes → remap style_id; old size id → new size id (by new style_id|label)
          const szSrc = await sb.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, sort_order, active").eq("client_id", T);
          if (szSrc.error) throw new Error(`clone sizes read: ${szSrc.error.message}`);
          const szRows = (szSrc.data ?? []).filter((z: any) => styleIdMap.has(z.style_id)).map((z: any) => ({
            client_id: Cc, style_id: styleIdMap.get(z.style_id), label: z.label, width_ft: z.width_ft,
            length_ft: z.length_ft, base_price: z.base_price, sort_order: z.sort_order, active: z.active,
          }));
          if (szRows.length) { const r = await sb.from("building_sizes").insert(szRows); if (r.error) throw new Error(`clone sizes: ${r.error.message}`); }
          const newSizes = await sb.from("building_sizes").select("id, style_id, label").eq("client_id", Cc);
          if (newSizes.error) throw newSizes.error;
          const newSizeIdByKey = new Map<string, string>();
          for (const z of newSizes.data ?? []) newSizeIdByKey.set(`${z.style_id}|${z.label}`, z.id);
          const sizeIdMap = new Map<string, string>();   // old size id → new size id
          for (const z of szSrc.data ?? []) { const ns = styleIdMap.get(z.style_id); if (!ns) continue; const nid = newSizeIdByKey.get(`${ns}|${z.label}`); if (nid) sizeIdMap.set(z.id, nid); }
          counts.building_sizes = sizeIdMap.size;

          // 3. fixture_items (the doors/windows/ramps catalog) → old id → new id.
          // Must run BEFORE inclusions: a size can include a FIXTURE, and it references it
          // by the fixture's uuid in item_key (migration 074 dropped that FK so the column
          // can hold either a builtin key or a fixture id). Cloning without this step left
          // the new client with no catalog doors at all AND inclusion rows pointing at the
          // template's fixture ids — invisible rows referencing another tenant's data.
          // Ids are generated up front rather than read back, because fixtures have no
          // stable per-client natural key to re-match on the way the styles clone does.
          // Archived fixtures are skipped: they exist only so a template's OLD designs still
          // render, and a brand-new client has no old designs.
          const fxSrc = await sb.from("fixture_items").select("*").eq("client_id", T).eq("archived", false);
          if (fxSrc.error) throw new Error(`clone fixtures read: ${fxSrc.error.message}`);
          const fixtureIdMap = new Map<string, string>();  // old fixture id → new fixture id
          if ((fxSrc.data ?? []).length) {
            const fxRows = (fxSrc.data ?? []).map((f0: any) => {
              const { id, client_id, created_at, updated_at, ...rest } = f0;
              const newId = crypto.randomUUID();
              fixtureIdMap.set(String(id), newId);
              return { id: newId, client_id: Cc, ...rest };
            });
            const r = await sb.from("fixture_items").insert(fxRows);
            if (r.error) throw new Error(`clone fixtures: ${r.error.message}`);
          }
          counts.fixture_items = fixtureIdMap.size;

          // 4. building_size_inclusions → remap size_id (qty travels with the row —
          // previously dropped here, resetting every clone's quantities to the default 1)
          // and remap item_key when it names a fixture. A uuid-shaped key with no entry in
          // the map belongs to a fixture we did NOT clone (archived, or deleted since the
          // inclusion was written) — copying it would recreate the dangling reference, so
          // the row is dropped and counted instead of silently carried over.
          const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
          const incSrc = await sb.from("building_size_inclusions").select("size_id, item_key, included, qty").eq("client_id", T);
          if (incSrc.error) throw new Error(`clone inclusions read: ${incSrc.error.message}`);
          let incDropped = 0;
          const incRows = (incSrc.data ?? [])
            .filter((x: any) => sizeIdMap.has(x.size_id))
            .map((x: any) => {
              const key = String(x.item_key ?? "");
              let newKey: string | null = key;
              if (fixtureIdMap.has(key)) newKey = fixtureIdMap.get(key) as string;
              else if (isUuid(key)) newKey = null;
              if (newKey === null) { incDropped++; return null; }
              return { client_id: Cc, size_id: sizeIdMap.get(x.size_id), item_key: newKey, included: x.included, qty: x.qty ?? 1 };
            })
            .filter(Boolean) as any[];
          if (incRows.length) { const r = await sb.from("building_size_inclusions").insert(incRows); if (r.error) throw new Error(`clone inclusions: ${r.error.message}`); }
          counts.building_size_inclusions = incRows.length;
          if (incDropped) counts.building_size_inclusions_dropped = incDropped;

          // 5. client_layout_items (no style FK)
          const liSrc = await sb.from("client_layout_items").select("item_key, active, sort_order, label_override, width_override, height_override, short_label_override").eq("client_id", T);
          if (liSrc.error) throw new Error(`clone items read: ${liSrc.error.message}`);
          if ((liSrc.data ?? []).length) {
            const r = await sb.from("client_layout_items").insert((liSrc.data ?? []).map((i: any) => ({ client_id: Cc, ...i })));
            if (r.error) throw new Error(`clone items: ${r.error.message}`);
          }
          counts.client_layout_items = (liSrc.data ?? []).length;

          // 6. layout_item_pricing → remap style_id (NULL default stays NULL)
          const lpSrc = await sb.from("layout_item_pricing").select("item_key, style_id, pricing_method, rate, image_url").eq("client_id", T);
          if (lpSrc.error) throw new Error(`clone pricing read: ${lpSrc.error.message}`);
          const lpRows = (lpSrc.data ?? []).filter((q: any) => !q.style_id || styleIdMap.has(q.style_id)).map((q: any) => ({
            client_id: Cc, item_key: q.item_key, style_id: q.style_id ? styleIdMap.get(q.style_id) : null,
            pricing_method: q.pricing_method, rate: q.rate, image_url: q.image_url,
          }));
          if (lpRows.length) { const r = await sb.from("layout_item_pricing").insert(lpRows); if (r.error) throw new Error(`clone pricing: ${r.error.message}`); }
          counts.layout_item_pricing = lpRows.length;

          // 7. colors (no FK) — copy every column except identity/timestamps
          const colSrc = await sb.from("colors").select("*").eq("client_id", T);
          if (colSrc.error) throw new Error(`clone colors read: ${colSrc.error.message}`);
          if ((colSrc.data ?? []).length) {
            const colRows = (colSrc.data ?? []).map((c0: any) => { const { id, client_id, created_at, updated_at, ...rest } = c0; return { client_id: Cc, ...rest }; });
            const r = await sb.from("colors").insert(colRows); if (r.error) throw new Error(`clone colors: ${r.error.message}`);
          }
          counts.colors = (colSrc.data ?? []).length;

          clonedCounts = counts;
        }
        return json({ ok: true, clientId, blank, cloned: clonedCounts });
      }

      // ── link a user login to a client (with a role) ────────────────────
      // Finds-or-CREATES the Supabase auth user for the email, then maps it to the
      // client in client_users. No manual "Authentication → Add user" step: if the
      // login doesn't exist we create it and try to email an invite (best-effort,
      // needs SMTP), and either way we return a one-time set-password link the
      // operator can copy & send. role: "owner"/"admin" (full access incl. Pricing +
      // Settings) or "user" (Designs & Leads only).
      case "set_feature_grants": {
        // EARLY ACCESS: switch a feature on for ONE builder before it goes on sale.
        // Carolyn 2026-08-18 — "I would like to be able to see the 3D as I'm in beta, but not
        // all clients need to see it." This is a COMP: it creates no subscription, charges
        // nothing, and never touches the billing gate (portal-billing keeps requiredFeatures
        // and entState untouched by grants).
        //
        // Replaces the whole set for this tenant, the way the Team screen replaces an access
        // map: the card sends what should be true now, so an unchecked box is a revoke.
        const clientId = reqStr(p.clientId, "clientId");
        const { data: exists } = await sb.from("client_configs")
          .select("client_id").eq("client_id", clientId).maybeSingle();
        if (!exists) throw new Error(`Unknown builder: ${clientId}`);

        // TWO SERVER-SIDE GUARDS, both mandatory. The UI only ever offers grantable
        // features, but the UI is a courtesy and this is the control.
        const { data: planRows } = await sb.from("billing_plans")
          .select("feature, operator_grantable");
        const grantable = new Set((planRows ?? [])
          .filter((r: any) => r.operator_grantable)
          .map((r: any) => r.feature));
        // Mirrors portal-billing's set. Kept here as well rather than imported, because the
        // two functions are deployed separately and a comp that the reader refuses to honour
        // is confusing, while a comp this writer refuses is self-explanatory.
        const PAID_ONLY_FEATURES = new Set(["schedule_builds", "quickbooks_sync"]);

        const wanted = Array.isArray(p.grants) ? p.grants : [];
        if (wanted.length > 50) throw new Error("Too many grants in one request.");

        // What this tenant holds NOW. Two reasons (both audit 2026-08-19):
        //   1. VALIDATION applies only to what is being ADDED. A grant whose feature was
        //      later un-armed (operator_grantable flipped false) must stay REMOVABLE --
        //      validating the whole replacement set left stale grants that no UI could
        //      revoke, because every save carrying the other, legitimate grants was
        //      refused on the stale one's account.
        //   2. METADATA on merely-preserved grants must survive. The wipe-and-reinsert
        //      rewrote granted_by/granted_at and dropped note on every save that touched a
        //      DIFFERENT feature, erasing the audit trail this table exists to keep.
        const { data: existingRows } = await sb.from("client_feature_grants")
          .select("feature, expires_at").eq("client_id", clientId);
        const existing = new Map((existingRows ?? []).map((r: any) => [r.feature, r.expires_at ?? null]));

        // Last occurrence wins: two rows for one feature share a primary key, so an
        // un-deduped pair turned the whole save into a constraint violation.
        const byFeature = new Map<string, any>();
        for (const g of wanted) {
          const feature = typeof g?.feature === "string" ? g.feature.trim() : "";
          if (feature) byFeature.set(feature, g);
        }

        const rows: Record<string, unknown>[] = [];
        const refused: string[] = [];
        for (const [feature, g] of byFeature) {
          // Refuse LOUDLY rather than dropping silently -- but only for features being
          // ADDED. A feature the tenant already holds passes through so it can be kept
          // or revoked regardless of whether it is still grantable today.
          if (!existing.has(feature) && (!grantable.has(feature) || PAID_ONLY_FEATURES.has(feature))) {
            refused.push(feature);
            continue;
          }
          // PAID_ONLY is refused even for held grants: a hand-inserted row for
          // schedule_builds must not be re-writable through this door.
          if (PAID_ONLY_FEATURES.has(feature)) { refused.push(feature); continue; }
          let expiresAt: string | null = null;
          if (g.expiresAt) {
            const t = Date.parse(String(g.expiresAt));
            if (!Number.isFinite(t)) throw new Error(`Not a date: ${g.expiresAt}`);
            expiresAt = new Date(t).toISOString();
          }
          rows.push({
            client_id: clientId,
            feature,
            // Only the operator-JWT path has a user id. The ADMIN_PASSWORD break-glass path
            // has none, and reading userId off it yields undefined — see _shared/adminAuth.ts.
            granted_by: identity.via === "operator" ? identity.userId : null,
            expires_at: expiresAt,
            note: typeof g.note === "string" ? g.note.slice(0, 300) : null,
          });
        }
        if (refused.length) {
          throw new Error(`Not available for early access: ${refused.join(", ")}. `
            + "A feature must be marked operator_grantable, and paid-only features never are.");
        }

        // Write order matters without a transaction: UPSERT the changed/new rows first,
        // then PRUNE what was un-picked. A failure between the two leaves every feature
        // either at its old value or its new one -- never the wiped-out nothing that
        // delete-then-insert left when the insert failed (audit 2026-08-19). Rows whose
        // expiry is unchanged are skipped entirely, which is what preserves their
        // granted_by/granted_at/note.
        const changed = rows.filter((r: any) =>
          !existing.has(r.feature) || existing.get(r.feature) !== r.expires_at);
        if (changed.length) {
          const { error: upErr } = await sb.from("client_feature_grants")
            .upsert(changed, { onConflict: "client_id,feature" });
          if (upErr) throw upErr;
        }
        const keep = new Set(rows.map((r: any) => r.feature));
        const drop = [...existing.keys()].filter((f) => !keep.has(f));
        if (drop.length) {
          const { error: delErr } = await sb.from("client_feature_grants")
            .delete().eq("client_id", clientId).in("feature", drop);
          if (delErr) throw delErr;
        }
        return json({
          ok: true,
          grants: rows.map((r: any) => ({ feature: r.feature, expiresAt: r.expires_at })),
          note: rows.length
            ? `Early access on for ${rows.length} feature(s). This is a comp — no subscription, no charge.`
            : "Early access cleared for this builder.",
        });
      }
      case "set_billing": {
        // Billing posture for an EXISTING tenant: the comp flag and the account discount.
        // Separate from create_client because the customers most likely to need a discount
        // — founding customers — already exist by the time you decide to give them one.
        //
        // Two things this deliberately does NOT do:
        //   1. It does not touch live subscriptions. NMI stores the amount on the
        //      subscription itself, so a discount set now applies to what they subscribe
        //      to NEXT, not to what is already running. Re-pricing an existing
        //      subscription would mean a gateway update_subscription call and is a
        //      separate, money-moving operation.
        //   2. Clearing billing_exempt on a tenant with no active subscription LOCKS them
        //      out immediately — the gate has nothing to let them in on. Order matters:
        //      set the discount first, let them subscribe, then remove the exemption.
        const clientId = reqStr(p.clientId, "clientId");
        const { data: exists } = await sb.from("client_configs")
          .select("client_id").eq("client_id", clientId).maybeSingle();
        if (!exists) throw new Error(`Unknown builder: ${clientId}`);

        const patch: Record<string, unknown> = { client_id: clientId, updated_at: new Date().toISOString() };
        if (p.billingExempt !== undefined) patch.billing_exempt = p.billingExempt === true;
        if (p.discountPercent !== undefined) {
          const pct = Math.round(Number(p.discountPercent));
          if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
            throw new Error("discountPercent must be a whole number from 0 to 100.");
          }
          patch.discount_percent = pct;
        }
        if (p.discountFeatures !== undefined) {
          patch.discount_features = Array.isArray(p.discountFeatures) && p.discountFeatures.length
            ? p.discountFeatures.map((f: unknown) => String(f))
            : null;
        }
        // Dated free period (059). Empty string clears it. A date-only value is taken as the
        // END of that day in UTC, so "free until Aug 5" includes all of Aug 5 rather than
        // expiring at midnight as it begins.
        if (p.exemptUntil !== undefined) {
          const raw = String(p.exemptUntil ?? "").trim();
          if (!raw) {
            patch.billing_exempt_until = null;
          } else {
            const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
            const t = Date.parse(iso);
            if (!Number.isFinite(t)) throw new Error(`exemptUntil is not a valid date: ${raw}`);
            patch.billing_exempt_until = new Date(t).toISOString();
          }
        }
        const { error } = await sb.from("client_settings").upsert(patch, { onConflict: "client_id" });
        if (error) throw error;

        // Warn the operator when the change cannot take effect on its own.
        const { data: live } = await sb.from("billing_subscriptions")
          .select("id").eq("client_id", clientId).neq("status", "cancelled").limit(1);
        return json({
          ok: true,
          hasLiveSubscription: Boolean(live && live.length),
          note: live && live.length
            ? "Saved. This tenant already has a live subscription — the gateway holds its amount, so a discount change applies only to features they subscribe to from now on."
            : "Saved.",
        });
      }
      case "link_owner": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        const email = reqStr(p.email, "email").toLowerCase();
        const role = ["owner", "admin", "user"].includes(String(p.role || "").toLowerCase())
          ? String(p.role).toLowerCase() : "owner";
        // Where the set-password link lands. ALWAYS the canonical production portal —
        // a caller-supplied portalUrl is deliberately ignored (see AUTH_PORTAL_URL).
        const portalUrl = AUTH_PORTAL_URL;

        // 1. find an existing auth user by email (admin API, paginated)
        let user: any = null;
        for (let page = 1; page <= 20 && !user; page++) {
          const list = await sb.auth.admin.listUsers({ page, perPage: 1000 });
          if (list.error) throw list.error;
          const users = list.data?.users || [];
          user = users.find((u: any) => String(u.email || "").toLowerCase() === email) || null;
          if (users.length < 1000) break;
        }

        // 2. create the login if missing. inviteUserByEmail creates + emails the
        // invite when SMTP is set up; if that fails (e.g. no SMTP) we still want the
        // account, so fall back to a plain confirmed createUser.
        let created = false, emailSent = false;
        if (!user) {
          const inv = await sb.auth.admin.inviteUserByEmail(email, { redirectTo: portalUrl });
          if (!inv.error && inv.data?.user) {
            user = inv.data.user; created = true; emailSent = true;
          } else {
            const cu = await sb.auth.admin.createUser({ email, email_confirm: true });
            if (cu.error && !/already|registered|exist/i.test(cu.error.message || "")) throw cu.error;
            user = cu.data?.user || null;
            if (!user) {
              const relist = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
              user = (relist.data?.users || []).find((u: any) => String(u.email || "").toLowerCase() === email) || null;
            }
            if (!user) throw new Error(`Could not create a login for "${email}".`);
            created = !cu.error; emailSent = false;
          }
        }

        // 3. map the user to this client with the chosen role. Refuse to SILENTLY re-home a
        //    login already linked to a different client (operator typo / isolation footgun);
        //    require an explicit reassign:true to move them.
        const existingLink = await sb.from("client_users").select("client_id").eq("user_id", user.id).maybeSingle();
        if (existingLink.error) throw existingLink.error;
        if (existingLink.data && existingLink.data.client_id && existingLink.data.client_id !== clientId && p.reassign !== true) {
          throw new Error(`"${email}" is already linked to builder "${existingLink.data.client_id}". Pass reassign:true to move them to "${clientId}".`);
        }
        const up = await sb.from("client_users").upsert(
          { user_id: user.id, client_id: clientId, role }, { onConflict: "user_id" });
        if (up.error) throw up.error;

        // 4. always hand back a one-time set-password link (works without SMTP)
        let setupLink: string | null = null;
        try {
          const gl = await sb.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: portalUrl } });
          if (!gl.error) setupLink = gl.data?.properties?.action_link || null;
        } catch (_) { /* link is best-effort */ }

        return json({ ok: true, userId: user.id, email, role, created, emailSent, setupLink });
      }

      // ── email sender: connect a Google account so auth emails send from it ──
      // (Supabase Auth custom SMTP via the Management API — see mgmtAuthConfig.)
      case "get_email_sender": {
        const cfg = await mgmtAuthConfig("GET");
        const host = (cfg && cfg.smtp_host) || "";
        return json({ ok: true, connected: !!host, senderEmail: (cfg && cfg.smtp_admin_email) || null, host: host || null });
      }
      case "connect_email": {
        const email = reqStr(p.email, "email").toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid Google email address.");
        // Google shows app passwords as 4 space-separated groups; strip whitespace
        // to the raw 16 chars. Required on every connect (it's tied to the account),
        // so we never PATCH an empty smtp_pass — the stored secret can't be blanked
        // by an empty save; clearing is the explicit disconnect_email action.
        const appPassword = String(p.appPassword ?? "").replace(/\s+/g, "");
        if (!appPassword) throw new Error("Paste the 16-character Google app password.");
        if (appPassword.length < 16) throw new Error("That app password looks too short — paste the full 16-character code from Google.");
        await mgmtAuthConfig("PATCH", {
          external_email_enabled: true,
          smtp_host: "smtp.gmail.com",
          // String, not number: the Management API's auth-config schema types
          // smtp_port as a string and rejects a number ("Expected string, received number").
          smtp_port: "465",
          smtp_user: email,
          smtp_pass: appPassword,
          smtp_admin_email: email,
          smtp_sender_name: (typeof p.senderName === "string" && p.senderName.trim()) ? p.senderName.trim().slice(0, 100) : "Structure Studio",
        });
        return json({ ok: true, connected: true, senderEmail: email });
      }
      case "disconnect_email": {
        // Revert to Supabase's built-in sender by clearing the custom SMTP fields.
        // Leave external_email_enabled untouched so email logins keep working.
        await mgmtAuthConfig("PATCH", { smtp_host: "", smtp_user: "", smtp_pass: "", smtp_admin_email: "", smtp_sender_name: "" });
        return json({ ok: true, connected: false, senderEmail: null });
      }
      // ── send a test email through the connected sender ──────────────────
      // Proves the configured SMTP actually delivers by pushing a REAL auth email
      // through it — a password-recovery email, which is one of the flows this
      // feature powers and has no side effects: nothing is created, and nothing
      // changes unless the recipient clicks the link (which only lets them set a
      // password they already own). The recipient must be an existing login: GoTrue
      // recover returns 200 even when it skips a non-user, so we verify first rather
      // than report a misleading "sent".
      case "test_email": {
        const email = reqStr(p.email, "email").toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address to send the test to.");

        // Refuse to "test" when there's no custom sender — the email would quietly
        // go out via Supabase's default sender and prove nothing about the connection.
        const cfg = await mgmtAuthConfig("GET");
        if (!(cfg && cfg.smtp_host)) throw new Error("Connect a Google account first — there's no custom sender to test yet.");

        // Confirm the recipient is a real login (recovery only emails existing users).
        let exists = false;
        for (let page = 1; page <= 20 && !exists; page++) {
          const list = await sb.auth.admin.listUsers({ page, perPage: 1000 });
          if (list.error) throw list.error;
          const users = list.data?.users || [];
          exists = users.some((u: any) => String(u.email || "").toLowerCase() === email);
          if (users.length < 1000) break;
        }
        if (!exists) throw new Error(`"${email}" isn't a login yet, so no test can be sent to it. Use an existing owner/operator login address (or create it first under "Link owner").`);

        // Where the reset link lands; the panel passes location.origin + "/portal.html".
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: AUTH_PORTAL_URL });
        if (error) throw error;
        return json({ ok: true, sentTo: email, senderEmail: (cfg && cfg.smtp_admin_email) || null });
      }

      // ── delete a tenant and ALL of its data (operator hard delete) ──────
      // Removes the client's designs + version history + captured leads, catalog
      // (styles/sizes/inclusions/layout items/colours/pricing), fixtures catalog,
      // settings, error logs, feedback submissions (and their comments, by cascade),
      // billing subscription + vaulted-card mirrors, QuickBooks item map, user
      // mappings + their now-orphaned auth logins, and uploaded storage objects in
      // all four buckets (floor-plans, branding, fixtures, feedback-attachments),
      // then the client_configs row itself. Requires the typed client id to match
      // (confirmClientId) so a stray/mistaken call can't nuke a tenant.
      // Irreversible. GHL-side contacts/estimates are external and untouched.
      // ⚠️ NOT removed: the financial ledgers (orders/payments/invoice_sends/
      // billing_charge_attempts). Those are records of money that moved, so the
      // response reports their counts as `retained` instead of silently keeping
      // them — deciding to destroy them is a retention call, not a code change.
      // Keep this list in step with the wipes below; drift here is what left a
      // deleted tenant's PII in the database twice already.
      case "delete_client": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        if (reqStr(p.confirmClientId, "confirmClientId") !== clientId) {
          throw new Error("Confirmation text does not match the client id.");
        }
        const deleted: Record<string, number> = {};
        const wipe = async (table: string) => {
          const { error, count } = await sb.from(table).delete({ count: "exact" }).eq("client_id", clientId);
          if (error) throw new Error(`${table}: ${error.message}`);
          deleted[table] = count ?? 0;
        };
        // Catalog/design rows first, config last. Order respects FKs
        // (layout_item_pricing & building_sizes → building_styles; inclusions → sizes).
        await wipe("designs");
        // design_versions and captured_leads were BOTH missing from this list until
        // 2026-07-30. Neither has a foreign key to designs (verified: zero FKs on either), so
        // nothing cascaded and both survived a tenant hard-delete — leaving that tenant's
        // full quote history and their browsing leads, complete with customer names, phone
        // numbers and addresses, in a database the tenant no longer exists in.
        await wipe("design_versions");
        await wipe("captured_leads");
        await wipe("layout_item_pricing");      // FK style_id → building_styles
        await wipe("colors");                   // standalone per-tenant palette
        await wipe("building_size_inclusions");
        await wipe("building_sizes");
        await wipe("building_styles");
        await wipe("client_layout_items");
        await wipe("client_settings");
        // 2026-08-01: the same orphan-cascade hole as design_versions/captured_leads above, on the
        // tables added since. Verified against information_schema rather than by memory — no FK
        // chain reaches any of these from anything wiped here.
        //
        //   billing_subscriptions + billing_customers are the DANGEROUS pair, and not merely
        //   untidy: entitlement is computed purely from surviving rows keyed on client_id, and
        //   `hasCard` / the charge vault come from billing_customers.vault_id. Recreating a slug
        //   (a re-onboard, or just reusing a test slug) therefore handed the new tenant the dead
        //   one's 'active' subscription — full product, no payment — and made a subscribe call
        //   charge the FORMER customer's stored card, on an invoice nobody could attribute.
        //   Neither table is an accounting record; both are mirrors of gateway state, and the
        //   gateway remains the source of truth.
        await wipe("billing_subscriptions");
        await wipe("billing_customers");
        //   feedback_submissions holds submitter_name + submitter_email — the named people who
        //   filed bugs from that portal. feedback_comments cascades from it (verified ON DELETE
        //   CASCADE), and the attachments live under {client_id}/ in the bucket loop below.
        await wipe("feedback_submissions");
        //   fixture_items is the per-tenant door catalog; its photos are served PUBLICLY from the
        //   `fixtures` bucket, now included below.
        await wipe("fixture_items");
        //   qbo_item_map points at QuickBooks item ids from the DELETED tenant's company. Only the
        //   style-scoped rows cascade (via qbo_item_map_style_id_fkey); the tenant-default rows
        //   (style_id IS NULL) survived, so a recreated slug that connects a DIFFERENT QuickBooks
        //   company would resolve its first invoice against stale ids and bill whatever items
        //   happen to share them — exactly the harm qbo-oauth-callback's realm-change wipe exists
        //   to prevent.
        await wipe("qbo_item_map");
        try { await wipe("app_errors"); } catch (_) { /* error logs are best-effort */ }

        // DELIBERATELY RETAINED, and reported rather than silently kept: the financial ledgers.
        // orders (payments cascades from it), invoice_sends and billing_charge_attempts are
        // records of money that actually moved. Destroying them is a data-retention decision with
        // accounting consequences, not a bug fix, so it is NOT made here — but leaving them
        // unmentioned is how this class of miss happened in the first place. The counts go back in
        // the response so the operator can see exactly what outlived the tenant and escalate if a
        // deletion request requires them gone too.
        const retained: Record<string, number> = {};
        for (const t of ["orders", "payments", "invoice_sends", "billing_charge_attempts"]) {
          const { count } = await sb.from(t).select("client_id", { count: "exact", head: true }).eq("client_id", clientId);
          if (count) retained[t] = count;
        }

        // Capture the logins mapped to this client, unmap them, then delete any
        // that aren't also attached to another client.
        const cu = await sb.from("client_users").select("user_id").eq("client_id", clientId);
        if (cu.error) throw cu.error;
        const userIds = [...new Set((cu.data ?? []).map((r: any) => r.user_id).filter(Boolean))];
        await wipe("client_users");
        let deletedUsers = 0;
        for (const uid of userIds) {
          const still = await sb.from("client_users").select("user_id").eq("user_id", uid).maybeSingle();
          if (!still.error && !still.data) { const d = await sb.auth.admin.deleteUser(uid); if (!d.error) deletedUsers++; }
        }
        deleted["auth_logins"] = deletedUsers;

        // Storage: remove everything under <clientId>/ in every bucket that can hold their files.
        //
        // `fixtures` and `feedback-attachments` were missing. fixtures is PUBLIC, so a deleted
        // tenant's product/door photos stayed downloadable by anyone holding the old URL;
        // feedback-attachments holds their users' bug-report screenshots. Both are keyed
        // {client_id}/…, so the same loop covers them.
        //
        // Paginated: list() caps at 1000 per call, and the old single call meant a tenant with
        // more than 1000 objects silently left the overflow behind — junior-barns alone already has
        // 93 floor plans, and nothing warned that the sweep was partial.
        let files = 0;
        for (const bucket of ["floor-plans", "branding", "fixtures", "feedback-attachments"]) {
          try {
            // Always re-list from offset 0: each round DELETES what it listed, so the next page
            // shifts down into the same window. The bound is a round counter, not an offset —
            // if a remove() ever fails we must not re-list the same 1000 objects forever.
            for (let round = 0; round < 20; round++) {
              const { data: list, error: lsErr } = await sb.storage.from(bucket)
                .list(clientId, { limit: 1000 });
              if (lsErr) break;
              const batch = list ?? [];
              if (batch.length === 0) break;
              const paths = batch.map((o: any) => `${clientId}/${o.name}`);
              const rm = await sb.storage.from(bucket).remove(paths);
              if (rm.error) break;                    // stop rather than spin on the same page
              files += rm.data?.length ?? paths.length;
              if (batch.length < 1000) break;         // that was the last page
            }
          } catch (_) { /* storage cleanup is best-effort */ }
        }
        deleted["storage_files"] = files;

        const cc = await sb.from("client_configs").delete({ count: "exact" }).eq("client_id", clientId);
        if (cc.error) throw new Error(`client_configs: ${cc.error.message}`);
        deleted["client_configs"] = cc.count ?? 0;

        // `retained` is empty for a normal tenant and only appears when financial rows outlived
        // the delete — see the note above. Surfacing it is the point: the dialog says "and ALL of
        // its data", so anything that survives has to be visible rather than assumed.
        return json({ ok: true, clientId, deleted, ...(Object.keys(retained).length ? { retained } : {}) });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 400);
  }
}));
