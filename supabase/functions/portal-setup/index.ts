import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";

// The builder's SETUP checklist (portal.html → What's New → "Getting set up").
//
// Carolyn 2026-08-28: new builders should get an ordered list of setup steps assigned to
// them, in the order they should do them, from a template operators maintain in Projects.
// This function is the TENANT half — read your own list, tick an item off. The template
// itself, assigning it, and the per-client progress view are operator-side actions in
// portal-projects (setup_template*, setup_client_*), because they cross tenants.
//
// Auth: resolveTenant — JWT → auth.getUser() → client_users; clientId is NEVER read from
// the body. This function IS in portal.html's SS_TENANT_SCOPED_FNS, so an operator in
// view-as reaches a tenant's list through the standard targetClientId injection, and
// resolveTenant checks app_operators.can_write before letting them change anything.
//
// Gating (no GATES table on purpose): a setup checklist is not a per-area feature
// (migration 100) and inventing an area for it would put a meaningless row in every
// person's access matrix. `list` is a read any linked account may do; `toggle` falls
// through to the legacy owner/admin gate, which is who runs an account's setup.
//
// WHY THE TICK IS A SERVER ACTION AT ALL: tenant_setup_items is read-only to the browser
// (migration 157). Completion carries attribution — who ticked it, the builder or us —
// and that must be derived from the caller's identity here, never accepted from the body,
// or "Done · CSM Synergy" would be something a tenant could write about themselves.
//
// Actions:
//   { action: "list" }                  → the tenant's items, in order
//   { action: "toggle", id, done }      → tick/untick, stamping who and when

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(withErrorLog("portal-setup", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const r = await resolveTenant(req, admin, {
    readActions: new Set(["list"]),
    defaultAction: "list",
  });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, payload, action, userId, userEmail, operator } = r.ctx;

  // deno-lint-ignore no-explicit-any
  const p: any = payload || {};

  switch (action) {
    case "list": {
      const { data, error } = await admin.from("tenant_setup_items")
        .select("id, title, detail, link_page, position, completed_at, completed_by_kind, completed_by_name")
        .eq("client_id", clientId).order("position");
      if (error) throw error;
      return json({ items: data || [], canEdit: true });
    }

    case "toggle": {
      const id = String(p.id ?? "").slice(0, 40);
      const done = p.done === true;

      // Scoped to the resolved tenant, so an id from another account matches nothing.
      const { data: row } = await admin.from("tenant_setup_items")
        .select("id, title").eq("id", id).eq("client_id", clientId).maybeSingle();
      if (!row) return json({ error: "That setup step is not on your list." }, 404);

      let patch: Record<string, unknown>;
      if (!done) {
        patch = { completed_at: null, completed_by_kind: null, completed_by_name: null };
      } else {
        // WHO gets recorded is decided here, from the resolved caller — an operator in
        // view-as is us doing it for them ("we set this up on the call"), and the builder
        // ticking their own box is them.
        let name = (userEmail || "").split("@")[0] || "Someone";
        if (operator) {
          const { data: op } = await admin.from("app_operators")
            .select("display_name, email").eq("user_id", operator.userId).maybeSingle();
          name = (op?.display_name || (op?.email || operator.email || "").split("@")[0] || "CSM Synergy");
        } else {
          const { data: me } = await admin.from("client_users")
            .select("full_name").eq("user_id", userId).maybeSingle();
          if (me?.full_name) name = String(me.full_name);
        }
        patch = {
          completed_at: new Date().toISOString(),
          completed_by_kind: operator ? "team" : "client",
          completed_by_name: name.slice(0, 120),
        };
      }

      const { data: updated, error } = await admin.from("tenant_setup_items")
        .update(patch).eq("id", row.id).select().single();
      if (error) throw error;
      return json({ ok: true, item: updated });
    }

    default:
      return json({ error: `Unknown action "${action}".` }, 400);
  }
}));
