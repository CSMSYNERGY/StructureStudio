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
        const [styles, sizes, items] = await Promise.all([
          sb.from("building_styles").select("id, key, label, image_url, sort_order, active").eq("client_id", clientId).order("sort_order"),
          sb.from("building_sizes").select("id, style_id, label, width_ft, depth_ft, base_price, sort_order, active").eq("client_id", clientId).order("sort_order"),
          sb.from("client_layout_items").select("*").eq("client_id", clientId).order("sort_order"),
        ]);
        if (styles.error) throw styles.error; if (sizes.error) throw sizes.error; if (items.error) throw items.error;
        return json({ ok: true, buildingStyles: styles.data, buildingSizes: sizes.data, clientLayoutItems: items.data });
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
        const ms = await sb.from("building_style_catalog_sizes").select("label, width_ft, depth_ft, sort_order").eq("style_key", styleKey);
        if (ms.error) throw ms.error;
        for (const s of ms.data ?? []) {
          await sb.from("building_sizes").upsert(
            { client_id: clientId, style_id: styleId, label: s.label, width_ft: s.width_ft, depth_ft: s.depth_ft,
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
        const patch: any = { updated_at: undefined };
        if ("label" in p)     patch.label = p.label;
        if ("imageUrl" in p)  patch.image_url = p.imageUrl;
        if ("sortOrder" in p) patch.sort_order = p.sortOrder;
        if ("active" in p)    patch.active = !!p.active;
        delete patch.updated_at;
        const { error } = await sb.from("building_styles").update(patch).eq("client_id", clientId).eq("key", styleKey);
        if (error) throw error;
        return json({ ok: true });
      }
      case "save_sizes": {
        // body.sizes: [{ label, widthFt, depthFt, basePrice, sortOrder, active }]
        const clientId = reqStr(p.clientId, "clientId");
        const styleId  = reqStr(p.styleId, "styleId");
        if (!Array.isArray(p.sizes)) throw new Error("sizes[] required");
        for (const s of p.sizes) {
          await sb.from("building_sizes").upsert({
            client_id: clientId, style_id: styleId, label: reqStr(s.label, "size.label"),
            width_ft: s.widthFt, depth_ft: s.depthFt,
            base_price: (s.basePrice === "" || s.basePrice == null) ? null : Number(s.basePrice),
            sort_order: s.sortOrder ?? 0, active: s.active !== false,
          }, { onConflict: "style_id,label" });
        }
        return json({ ok: true });
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
              width_ft: s.widthFt, depth_ft: s.depthFt, sort_order: s.sortOrder ?? 0,
            }, { onConflict: "style_key,label" });
          }
        }
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 400);
  }
});
