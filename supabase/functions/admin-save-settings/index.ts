import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkAdminAuth } from "../_shared/adminAuth.ts";
import { withErrorLog } from "../_shared/logError.ts";
import { sanitizeD3Spec, sanitizePhotoUrls } from "../_shared/styleD3.ts";

// Operator (super-admin) bootstrap tool, used by the designer's ?admin=1 panel.
// Gated by the shared ADMIN_PASSWORD edge-function secret. Owners use the
// portal-settings function instead (JWT-authenticated, tenant-scoped).

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


Deno.serve(withErrorLog("admin-save-settings", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { adminPassword, clientId, ghlLocationId, ghlApiKey, action } = payload || {};

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Created before the gate: the throttle ledger + audit need a service-role client.
  const supabase = createClient(supabaseUrl, serviceKey);

  // SAME dual-credential gate as admin-catalog — operator JWT or the shared password.
  // Both siblings must use the same gate: they share one secret, so an unthrottled (or
  // differently-gated) sibling would be a free guessing oracle for the same password.
  // Behaviour-neutral for today's caller — the designer's ?admin=1 panel sends the anon
  // key, which resolves to no user and falls through to the unchanged password path.
  const gate = await checkAdminAuth(req, adminPassword, supabase, String(action ?? ""));
  if (!gate.ok) return json(gate.body, gate.status);

  // Same per-operator rights rule as admin-catalog (migration 056). "status" only reports
  // booleans about whether credentials exist; everything else writes a tenant's GHL
  // credentials, which is not something a read-only operator should be able to do.
  // Gated on `via === "operator"` only — the password path carries no operator row, so an
  // unconditional check would break the designer's ?admin=1 panel and admin.html.
  if (gate.identity.via === "operator" && action !== "status" && !gate.identity.canWrite) {
    return json({ error: "This operator account is read-only." }, 403);
  }

  if (!clientId || typeof clientId !== "string" || !clientId.trim()) {
    return json({ error: "clientId is required." }, 400);
  }

  // "status" lets the admin UI show whether creds are already configured — without
  // ever revealing them. Returns booleans only.
  if (action === "status") {
    const { data, error } = await supabase
      .from("client_settings")
      .select("client_id, ghl_location_id, updated_at")
      .eq("client_id", clientId.trim())
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ ok: true, configured: false });
    return json({
      ok: true,
      configured: true,
      ghlLocationIdMasked: data.ghl_location_id
        ? data.ghl_location_id.slice(0, 4) + "…" + data.ghl_location_id.slice(-4)
        : null,
      updatedAt: data.updated_at,
    });
  }

  // "save_style_d3" — writes a building style's 3D appearance spec (and its reference
  // photo URLs) to building_styles.d3 / .d3_photos for the designer's ?admin=1
  // calibration editor. Request and response shape are unchanged.
  //
  // This used to read-modify-write `client_configs.config`, a jsonb column dropped back
  // in migration 020 — so on live it returned "column client_configs.config does not
  // exist" and no calibration was EVER saved. 086 gives the spec real columns and
  // teaches get_config to emit it; the validation now lives in _shared/styleD3.ts so
  // this and portal-settings' builder-facing twin cannot drift apart.
  if (action === "save_style_d3") {
    const { styleValue, d3, d3Photos } = payload || {};
    if (!styleValue || typeof styleValue !== "string") {
      return json({ error: "styleValue is required." }, 400);
    }
    const clean = sanitizeD3Spec(d3);
    if (!clean.ok) return json({ error: clean.error }, 400);
    const photos = sanitizePhotoUrls(d3Photos);

    // Matched on the style KEY, which is what the editor knows as `value`;
    // (client_id, key) is unique, so this touches exactly one row.
    const { error: upErr, count } = await supabase
      .from("building_styles")
      .update({ d3: clean.d3, d3_photos: photos, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("client_id", clientId.trim())
      .eq("key", styleValue);
    if (upErr) return json({ error: `Config save failed: ${upErr.message}` }, 500);
    if (!count) return json({ error: `Style "${styleValue}" not found for this client.` }, 404);
    return json({ ok: true });
  }

  // "save" path — upserts the credentials.
  if (!ghlLocationId || typeof ghlLocationId !== "string" || !ghlLocationId.trim()) {
    return json({ error: "ghlLocationId is required." }, 400);
  }
  if (!ghlApiKey || typeof ghlApiKey !== "string" || !ghlApiKey.trim()) {
    return json({ error: "ghlApiKey is required." }, 400);
  }

  const { error: upErr } = await supabase
    .from("client_settings")
    .upsert({
      client_id: clientId.trim(),
      ghl_location_id: ghlLocationId.trim(),
      ghl_api_key: ghlApiKey.trim(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "client_id" });

  if (upErr) return json({ error: `Save failed: ${upErr.message}` }, 500);
  return json({ ok: true });
}));
