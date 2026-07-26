import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkAdminPassword } from "../_shared/adminGate.ts";

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


Deno.serve(async (req: Request) => {
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

  // Throttled + audited password gate — SAME shared gate as admin-catalog (migration 053).
  // Both must use it: they share one secret, so an unthrottled sibling would be a free
  // guessing oracle for the same password.
  const gate = await checkAdminPassword(req, adminPassword, supabase, String(action ?? ""));
  if (!gate.ok) return json(gate.body, gate.status);

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
