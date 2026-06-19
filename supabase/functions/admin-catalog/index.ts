import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Operator (super-admin) catalog tool, used by the standalone admin.html page.
// Gated by the shared ADMIN_PASSWORD edge-function secret (same secret as
// admin-save-settings). Manages the GLOBAL master catalog (layout_item_types,
// building_style_catalog + sizes) and per-client assignments (client_layout_items,
// building_styles/building_sizes). All writes use the service role (bypass RLS).
// Kept separate from admin-save-settings so GHL-credential logic stays isolated.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}
const reqStr = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required.`);
  return v.trim();
};

// Validate a client_id: DNS-safe slug AND must exist in client_configs — so a
// write/upload can never land under a typo'd or malformed tenant prefix.
async function assertClient(sb: any, clientId: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) throw new Error("invalid client id");
  const { data, error } = await sb.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("unknown client");
  return clientId;
}

// Shared CSV pricing + inclusion importer (also used by portal-settings).
// rows: [{ style, width, length, price, active, inclusions: { item_key: yes/no } }].
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
  const truthy = (v: unknown) => v === true || ["yes", "y", "1", "true", "x", "included"].includes(String(v ?? "").trim().toLowerCase());
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
      const incRes = truthy(val)
        ? await sb.from("building_size_inclusions").upsert({ client_id: clientId, size_id: sizeId, item_key: itemKey, included: true }, { onConflict: "size_id,item_key" })
        : await sb.from("building_size_inclusions").delete().eq("size_id", sizeId).eq("item_key", itemKey);
      if (incRes.error) skipped.push(`${styleName} ${label} / ${itemKey}: ${incRes.error.message}`);
    }
  }
  return { imported: created + updated, created, updated, skipped };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let p: any;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const expected = Deno.env.get("ADMIN_PASSWORD");
  if (!expected) return json({ error: "ADMIN_PASSWORD is not configured on the server." }, 500);
  if (!p?.adminPassword || !safeEqual(String(p.adminPassword), expected)) {
    return json({ error: "Incorrect admin password." }, 401);
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const action = p.action;

  try {
    switch (action) {
      // ── reads ───────────────────────────────────────────────────────────
      case "list_clients": {
        const { data, error } = await sb.from("client_configs").select("client_id, company_name").order("client_id");
        if (error) throw error;
        return json({ ok: true, clients: data });
      }
      case "get_master": {
        const [items, styles, sizes] = await Promise.all([
          sb.from("layout_item_types").select("*").order("sort_order").order("item_key"),
          sb.from("building_style_catalog").select("*").order("sort_order").order("key"),
          sb.from("building_style_catalog_sizes").select("*").order("style_key").order("sort_order"),
        ]);
        if (items.error) throw items.error; if (styles.error) throw styles.error; if (sizes.error) throw sizes.error;
        return json({ ok: true, layoutItemTypes: items.data, buildingStyleCatalog: styles.data, catalogSizes: sizes.data });
      }
      case "get_client_catalog": {
        const clientId = reqStr(p.clientId, "clientId");
        const [styles, sizes, items, incl] = await Promise.all([
          sb.from("building_styles").select("id, client_id, key, label, image_url, sort_order, active").eq("client_id", clientId).order("sort_order"),
          sb.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, sort_order, active").eq("client_id", clientId).order("sort_order"),
          sb.from("client_layout_items").select("*").eq("client_id", clientId).order("sort_order"),
          sb.from("building_size_inclusions").select("size_id, item_key, included").eq("client_id", clientId),
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

      // ── building-style assignment ───────────────────────────────────────
      case "assign_style": {
        const clientId = reqStr(p.clientId, "clientId");
        const styleKey = reqStr(p.styleKey, "styleKey");
        const cat = await sb.from("building_style_catalog").select("label, default_image_url").eq("key", styleKey).maybeSingle();
        if (cat.error) throw cat.error;
        if (!cat.data) throw new Error("unknown style key");
        const up = await sb.from("building_styles").upsert(
          { client_id: clientId, key: styleKey, label: cat.data.label, image_url: cat.data.default_image_url, active: true },
          { onConflict: "client_id,key" }).select("id").maybeSingle();
        if (up.error) throw up.error;
        const styleId = up.data!.id;
        // clone master default sizes (only where missing), base_price null
        const ms = await sb.from("building_style_catalog_sizes").select("label, width_ft, length_ft, sort_order").eq("style_key", styleKey);
        if (ms.error) throw ms.error;
        for (const s of ms.data ?? []) {
          await sb.from("building_sizes").upsert(
            { client_id: clientId, style_id: styleId, label: s.label, width_ft: s.width_ft, length_ft: s.length_ft,
              sort_order: s.sort_order, active: true }, { onConflict: "style_id,label" });
        }
        return json({ ok: true, styleId });
      }
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
        // Reserve master catalog keys: a created style must not share a key with
        // a master style, else a later assign_style upsert would overwrite it.
        const masterKeys = new Set<string>();
        const mk = await sb.from("building_style_catalog").select("key");
        if (mk.error) throw mk.error;
        for (const m of mk.data ?? []) masterKeys.add(String(m.key));
        // INSERT (not upsert) so a concurrent same-key create surfaces as a 23505
        // we retry — never a silent overwrite of an existing style.
        let key = base, n = 1;
        for (let attempt = 0; attempt < 50; attempt++) {
          if (masterKeys.has(key)) { key = `${base}-${++n}`; continue; }
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
      case "save_master_style": {
        const key = reqStr(p.key, "key");
        const { error } = await sb.from("building_style_catalog").upsert({
          key, label: reqStr(p.label, "label"), default_image_url: p.defaultImageUrl ?? null,
          sort_order: p.sortOrder ?? 0, active: p.active !== false, updated_at: new Date().toISOString(),
        }, { onConflict: "key" });
        if (error) throw error;
        if (Array.isArray(p.sizes)) {
          for (const s of p.sizes) {
            await sb.from("building_style_catalog_sizes").upsert({
              style_key: key, label: reqStr(s.label, "size.label"),
              width_ft: s.widthFt, length_ft: s.lengthFt, sort_order: s.sortOrder ?? 0,
            }, { onConflict: "style_key,label" });
          }
        }
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
        if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) throw new Error("Client id must be lowercase letters, numbers and hyphens (DNS-safe).");
        const reserved = ["www", "beta", "dev", "staging", "app", "api", "admin", "portal"];
        if (reserved.includes(clientId)) throw new Error(`"${clientId}" is a reserved id.`);
        const companyName = reqStr(p.companyName, "companyName");
        const exists = await sb.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
        if (exists.error) throw exists.error;
        if (exists.data) throw new Error(`A client "${clientId}" already exists.`);
        // templateClientId === "__none__" => start blank (no clone): a standard contact
        // form so the designer works, and empty sizes/options the operator fills in via
        // the tabs + pricing CSV. Otherwise clone the named template (or junior-barns).
        const blank = String(p.templateClientId || "").trim().toLowerCase() === "__none__";
        let contactFields: unknown, defaultSizes: unknown, options: unknown;
        if (blank) {
          contactFields = ["name", "email", "phone", "street", "city", "state", "zip"];
          defaultSizes = [];
          options = [];
        } else {
          const tmplId = (typeof p.templateClientId === "string" && p.templateClientId.trim()) ? p.templateClientId.trim() : "junior-barns";
          const tmpl = await sb.from("client_configs").select("contact_fields, default_sizes, options").eq("client_id", tmplId).maybeSingle();
          if (tmpl.error) throw tmpl.error;
          if (!tmpl.data) throw new Error(`Template client "${tmplId}" not found.`);
          contactFields = tmpl.data.contact_fields; defaultSizes = tmpl.data.default_sizes; options = tmpl.data.options;
        }
        const opt = (v: unknown) => (typeof v === "string" && v.trim()) ? v.trim() : null;
        const ins = await sb.from("client_configs").insert({
          client_id: clientId, company_name: companyName,
          tagline: opt(p.tagline), accent_color: opt(p.accentColor), header_bg: opt(p.headerBg), logo_url: opt(p.logoUrl),
          contact_fields: contactFields, default_sizes: defaultSizes, options,
          updated_at: new Date().toISOString(),
        });
        if (ins.error) throw ins.error;
        return json({ ok: true, clientId, blank });
      }

      // ── link a user login to a client (with a role) ────────────────────
      // Finds-or-CREATES the Supabase auth user for the email, then maps it to the
      // client in client_users. No manual "Authentication → Add user" step: if the
      // login doesn't exist we create it and try to email an invite (best-effort,
      // needs SMTP), and either way we return a one-time set-password link the
      // operator can copy & send. role: "owner"/"admin" (full access incl. Pricing +
      // Settings) or "user" (Designs & Leads only).
      case "link_owner": {
        const clientId = await assertClient(sb, reqStr(p.clientId, "clientId"));
        const email = reqStr(p.email, "email").toLowerCase();
        const role = ["owner", "admin", "user"].includes(String(p.role || "").toLowerCase())
          ? String(p.role).toLowerCase() : "owner";
        // Where the set-password link lands (the portal). The panel passes
        // location.origin + "/portal.html"; fall back to production.
        const portalUrl = (typeof p.portalUrl === "string" && /^https?:\/\/[^\s]+$/.test(p.portalUrl))
          ? p.portalUrl : "https://structurestudio.app/portal.html";

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
          throw new Error(`"${email}" is already linked to client "${existingLink.data.client_id}". Pass reassign:true to move them to "${clientId}".`);
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

      // ── delete a tenant and ALL of its data (operator hard delete) ──────
      // Removes the client's designs, catalog (styles/sizes/inclusions/layout
      // items), settings, error logs, user mappings + their now-orphaned auth
      // logins, and uploaded storage objects (floor-plans + branding), then the
      // client_configs row itself. Requires the typed client id to match
      // (confirmClientId) so a stray/mistaken call can't nuke a tenant.
      // Irreversible. GHL-side contacts/estimates are external and untouched.
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
        // Catalog/design rows first (FKs: inclusions→sizes→styles), config last.
        await wipe("designs");
        await wipe("building_size_inclusions");
        await wipe("building_sizes");
        await wipe("building_styles");
        await wipe("client_layout_items");
        await wipe("client_settings");
        try { await wipe("app_errors"); } catch (_) { /* error logs are best-effort */ }

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

        // Storage: remove everything under <clientId>/ in both buckets.
        let files = 0;
        for (const bucket of ["floor-plans", "branding"]) {
          try {
            const { data: list } = await sb.storage.from(bucket).list(clientId, { limit: 1000 });
            const paths = (list ?? []).map((o: any) => `${clientId}/${o.name}`);
            if (paths.length) { const rm = await sb.storage.from(bucket).remove(paths); if (!rm.error) files += paths.length; }
          } catch (_) { /* storage cleanup is best-effort */ }
        }
        deleted["storage_files"] = files;

        const cc = await sb.from("client_configs").delete({ count: "exact" }).eq("client_id", clientId);
        if (cc.error) throw new Error(`client_configs: ${cc.error.message}`);
        deleted["client_configs"] = cc.count ?? 0;

        return json({ ok: true, clientId, deleted });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 400);
  }
});
