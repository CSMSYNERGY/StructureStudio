import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

// Constant-time string compare to thwart timing attacks on the admin password.
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { adminPassword, clientId, ghlLocationId, ghlApiKey, action } = payload || {};

  const expected = Deno.env.get("ADMIN_PASSWORD");
  if (!expected) {
    return json({ error: "ADMIN_PASSWORD is not configured on the server. Set it in Supabase → Edge Functions → Secrets." }, 500);
  }
  if (!adminPassword || !safeEqual(String(adminPassword), expected)) {
    return json({ error: "Incorrect admin password." }, 401);
  }
  if (!clientId || typeof clientId !== "string" || !clientId.trim()) {
    return json({ error: "clientId is required." }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

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

  // "save_style_d3" — writes a building style's 3D appearance spec (and its
  // four-side reference photo URLs) into the tenant's config blob:
  // config.buildingStyles[value == styleValue].d3 / .d3Photos. Used by the
  // designer's ?admin=1 calibration editor. Additive: touches only the one
  // style entry; everything else in the config row is preserved.
  if (action === "save_style_d3") {
    const { styleValue, d3, d3Photos } = payload || {};
    if (!styleValue || typeof styleValue !== "string") {
      return json({ error: "styleValue is required." }, 400);
    }
    if (!d3 || typeof d3 !== "object" || !d3.roof || typeof d3.roof !== "object") {
      return json({ error: "d3 spec with a roof object is required." }, 400);
    }
    const roofType = String(d3.roof.type || "");
    if (!["shed", "gable", "gambrel"].includes(roofType)) {
      return json({ error: `Unknown roof type "${roofType}" — expected shed|gable|gambrel.` }, 400);
    }
    const photos = Array.isArray(d3Photos)
      ? d3Photos.filter((u: unknown) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 4)
      : [];

    const { data: row, error: cfgErr } = await supabase
      .from("client_configs")
      .select("config")
      .eq("client_id", clientId.trim())
      .single();
    if (cfgErr || !row) return json({ error: `No config row for client "${clientId}".` }, 404);

    const config = row.config || {};
    const styles = Array.isArray(config.buildingStyles) ? config.buildingStyles : [];
    const idx = styles.findIndex((s: any) => s && s.value === styleValue);
    if (idx === -1) {
      return json({ error: `Style "${styleValue}" not found in this client's buildingStyles.` }, 404);
    }
    styles[idx] = { ...styles[idx], d3, d3Photos: photos };
    config.buildingStyles = styles;

    const { error: upErr } = await supabase
      .from("client_configs")
      .update({ config })
      .eq("client_id", clientId.trim());
    if (upErr) return json({ error: `Config save failed: ${upErr.message}` }, 500);
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
});
