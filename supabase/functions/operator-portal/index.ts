import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";

// Operator account-switcher backend (portal.html "Accounts" tab): lets a platform
// operator (app_operators row — Carolyn / Ahsan / support) open any tenant's portal
// read-only, GHL-subaccounts style.
//
// Auth model (two layers, both server-side):
//   1. Real signed-in user via auth.getUser() — verify_jwt alone is NOT auth, the
//      bare anon key passes the gateway (same rule as portal-settings).
//   2. Operator membership via a service-role app_operators lookup. client_users is
//      irrelevant here — operators are cross-tenant by design.
// RLS can never yield another tenant's rows to a user JWT (current_client_id() is
// the policy anchor), so every cross-tenant read below is a service-role read that
// happens ONLY after both checks pass — never a faked session or weakened policy
// (same rule as admin-catalog's get_client_portal).
//
// Actions:
//   { action: "list_clients" }            → [{ clientId, companyName }] for the picker
//   { action: "get_portal", clientId }    → the tenant's designs + versions + name,
//     byte-compatible with what portal.html's DesignsTable/LeadsTable read for the
//     owner's own tenant. Every call is audit-logged to admin_audit (cross-tenant PII).

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

// Same shape as admin-catalog's assertClient: slug + must exist in client_configs.
// deno-lint-ignore no-explicit-any
async function assertClient(admin: any, raw: unknown): Promise<string> {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v || !/^[a-z0-9][a-z0-9-]*$/.test(v)) throw new Error("Invalid clientId.");
  const { data, error } = await admin.from("client_configs").select("client_id").eq("client_id", v).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Unknown client "${v}".`);
  return v;
}

Deno.serve(withErrorLog("operator-portal", async (req: Request) => {
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

  // 2. Operator membership — service role (app_operators has no browser policies).
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: op, error: opErr } = await admin
    .from("app_operators")
    .select("user_id, email")
    .eq("user_id", user.id)
    .maybeSingle();
  if (opErr) return json({ error: opErr.message }, 500);
  if (!op) return json({ error: "Operator access required." }, 403);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const action = payload?.action;

  const audit = async (action: string, targetClientId: string | null, rowCount: number | null) => {
    try {
      await admin.from("admin_audit").insert({
        action,
        target_client_id: targetClientId,
        row_count: rowCount,
        note: `operator:${op.email || user.email || user.id}`,
      });
    } catch (_) { /* audit is best-effort — never block the view on a log failure */ }
  };

  try {
    switch (action) {
      case "list_clients": {
        const { data, error } = await admin
          .from("client_configs")
          .select("client_id, company_name")
          .order("client_id");
        if (error) throw error;
        await audit("operator_list_clients", null, (data || []).length);
        return json({
          ok: true,
          clients: (data || []).map((r: any) => ({ clientId: r.client_id, companyName: r.company_name || r.client_id })),
        });
      }
      case "get_portal": {
        const clientId = await assertClient(admin, payload.clientId);
        // Same columns/shape as the owner portal's own reads (and as admin-catalog's
        // get_client_portal) so DesignsTable/LeadsTable render unchanged.
        const [designs, versions, cfg] = await Promise.all([
          admin.from("designs")
            .select("short_code, created_at, updated_at, status, contact, selections, ghl_estimate_number, image_url")
            .eq("client_id", clientId).order("created_at", { ascending: false }),
          admin.from("design_versions")
            .select("short_code, version, created_at, selections, image_url")
            .eq("client_id", clientId).order("version", { ascending: false }),
          admin.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
        ]);
        if (designs.error) throw designs.error;
        if (versions.error) throw versions.error;
        await audit("operator_get_portal", clientId, (designs.data || []).length);
        return json({
          ok: true, clientId,
          companyName: (cfg.data && (cfg.data as any).company_name) || clientId,
          designs: designs.data || [], versions: versions.data || [],
        });
      }
      default:
        return json({ error: `Unknown action "${action}".` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || "Unexpected error" }, 400);
  }
}));
