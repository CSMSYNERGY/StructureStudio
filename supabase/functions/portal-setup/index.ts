import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import { usableFeatureSet } from "../_shared/featureCheck.ts";

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
// ── GATING (migration 185) ────────────────────────────────────────────────────────────
// Two flags live on the TEMPLATE row and are read through template_item_id at request
// time, never copied onto the tenant's row — so finishing a build reaches every existing
// builder at once instead of needing a per-tenant backfill:
//
//   builder_visible = false  we have not finished building this part of the product. The
//                            row NEVER LEAVES THIS FUNCTION — not hidden by CSS, not sent
//                            and ignored. Section headers therefore cannot orphan either,
//                            because the browser only ever sees the surviving rows.
//   requires_feature         the step needs a paid add-on. It IS sent, flagged `locked`,
//                            and the browser greys it with a padlock and a Billing link
//                            (Carolyn 2026-09-04 — she wants it visible as the upsell).
//                            Locked steps are excluded from `counts`, so "X of Y done"
//                            only ever counts work the builder can actually do.
//
// ⚠️ THE TWO GATES HAVE OPPOSITE FAILURE POSTURES, deliberately. The template read fails
// CLOSED (throws): guessing "show it" because a query failed is how half-built work
// reaches a builder. The entitlement read fails OPEN (caught, everything unlocked):
// wrongly padlocking a step a builder can do strands them mid-setup, and the feature's own
// screens fail closed anyway — this one is guidance, not enforcement.
//
// A tenant-only step (added via portal-projects' setup_client_save, so template_item_id is
// NULL) is always visible and never gated. Those are bespoke instructions written for one
// builder who is already in the conversation.
//
// Actions:
//   { action: "list" }                  → the tenant's items, in order, gated
//   { action: "toggle", id, done }      → tick/untick, stamping who and when

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

type Gate = { requires: string | null; visible: boolean };

/** The template flags for a set of tenant rows, keyed by template_item_id.
 *
 *  FAILS CLOSED (throws) — see the posture note in the header. A row whose template says
 *  "not built yet" must not become visible because a query blipped. */
async function templateGate(
  // deno-lint-ignore no-explicit-any
  admin: any,
  // deno-lint-ignore no-explicit-any
  rows: any[] | null,
): Promise<Map<string, Gate>> {
  const ids = [...new Set((rows ?? []).map((r) => r.template_item_id).filter(Boolean))];
  const out = new Map<string, Gate>();
  if (!ids.length) return out;
  const { data, error } = await admin.from("setup_template_items")
    .select("id, requires_feature, builder_visible").in("id", ids);
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  for (const t of (data ?? []) as any[]) {
    out.set(t.id, { requires: t.requires_feature || null, visible: t.builder_visible !== false });
  }
  return out;
}

/** Which of these features the tenant may use, failing OPEN. See the header. */
async function usableOrOpen(
  // deno-lint-ignore no-explicit-any
  admin: any,
  clientId: string,
  features: string[],
): Promise<Set<string>> {
  if (!features.length) return new Set();
  try {
    return await usableFeatureSet(admin, clientId, features);
  } catch (e) {
    console.error("portal-setup: entitlement read failed, leaving every step unlocked:", (e as Error)?.message);
    return new Set(features);
  }
}

Deno.serve(withErrorLog("portal-setup", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Warm-up ───────────────────────────────────────────────────────────────────────
  // A table-free ping, the same shape as portal-schedule's, so the first real call does not
  // also pay a cold isolate boot (~2.5 s before the first query). Three properties are
  // deliberate and load-bearing:
  //   • it answers BEFORE any client, auth or tenant resolution, so it costs no round trip
  //     and cannot log a refusal — a ping firing on every boot must never fill app_errors;
  //   • it is a QUERY PARAM, not an action, so it needs no GATES entry (preflight
  //     cross-checks gates against action branches) and unknown-action handling is untouched;
  //   • it never reads the request BODY — the code below owns the single parse of that
  //     stream, and consuming it here would break every real call.
  // Booting the isolate IS the whole job; there is nothing to return but the acknowledgement.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

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
      const { data: rows, error } = await admin.from("tenant_setup_items")
        .select("id, template_item_id, title, detail, link_page, section, image_url, position, completed_at, completed_by_kind, completed_by_name")
        .eq("client_id", clientId).order("position");
      if (error) throw error;

      const gate = await templateGate(admin, rows);
      const needed = [...new Set([...gate.values()].map((g) => g.requires).filter(Boolean))] as string[];
      const usable = await usableOrOpen(admin, clientId, needed);

      const items = [];
      for (const r of rows ?? []) {
        const g = r.template_item_id ? gate.get(r.template_item_id) : null;
        if (g && !g.visible) continue;   // not built yet — never leaves the server
        // A step they ALREADY TICKED never re-locks. They plainly had the add-on when they
        // did it, so padlocking it back would rewrite their own history and shrink the
        // progress bar under them for work they did not undo.
        const locked = !!(g && g.requires) && !usable.has(g.requires!) && !r.completed_at;
        // template_item_id is internal plumbing; the browser has no use for it and it
        // names a row in a table the tenant cannot read.
        const { template_item_id: _tpl, ...rest } = r;
        items.push({ ...rest, locked, requiresFeature: locked ? g!.requires : null });
      }

      // Counts cover only what they can actually do — a padlocked step is not homework.
      const counted = items.filter((i) => !i.locked);
      return json({
        items,
        counts: {
          total: counted.length,
          done: counted.filter((i) => i.completed_at).length,
          open: counted.filter((i) => !i.completed_at).length,
        },
        canEdit: true,
      });
    }

    case "toggle": {
      const id = String(p.id ?? "").slice(0, 40);
      const done = p.done === true;

      // Scoped to the resolved tenant, so an id from another account matches nothing.
      const { data: row } = await admin.from("tenant_setup_items")
        .select("id, title, template_item_id, completed_at").eq("id", id).eq("client_id", clientId).maybeSingle();
      if (!row) return json({ error: "That setup step is not on your list." }, 404);

      // Re-derived here, not trusted from the browser: an id for a step that has since
      // been hidden or locked can still be sitting in a tab opened before the flag moved.
      const tGate = (await templateGate(admin, [row])).get(row.template_item_id) || null;
      // The SAME wording and status as an id from another tenant, on purpose — a step we
      // have not built yet must not be distinguishable from one that does not exist.
      if (tGate && !tGate.visible) return json({ error: "That setup step is not on your list." }, 404);
      // Only TICKING is gated. Un-ticking can only reach an already-completed row, which
      // the rule above never locks — so a builder can always undo their own tick.
      if (done && tGate && tGate.requires && !row.completed_at) {
        const usable = await usableOrOpen(admin, clientId, [tGate.requires]);
        if (!usable.has(tGate.requires)) {
          return json({ error: "That step needs an add-on your account doesn't have yet." }, 403);
        }
      }

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
