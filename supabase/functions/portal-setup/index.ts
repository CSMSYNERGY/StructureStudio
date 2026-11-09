import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import { usableFeatureSet } from "../_shared/featureCheck.ts";
import { setupStepFits, shedsOnOrOpen } from "../_shared/setupShape.ts";

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
//   account_type (368)       'all' | 'sheds' | 'smartbuild' against the account's shape
//                            (client_settings.sheds_enabled, migration 364). A step for the
//                            other shape never leaves this function, like builder_visible —
//                            the counts and the section headers only ever see the survivors.
//                            The shape read fails OPEN (a shed builder); see _shared/setupShape.ts.
//
// A tenant-only step (added via portal-projects' setup_client_save, so template_item_id is
// NULL) is always visible and never gated. Those are bespoke instructions written for one
// builder who is already in the conversation.
//
// ── JACK (the AI agent's setup piece, jack-agent/setup.ts; migration 376) ──────────
// Two additions, and neither lets a body decide who did anything:
//
//   key            setup_template_items.jack_key, read through template_item_id like the two
//                  flags above, and sent with each row. It names a step for Jack ("business",
//                  "paperwork", ...) so Jack never matches on a title an operator can reword.
//                  A bespoke row (no template) and an unkeyed template row send null.
//   viaProposal    on `toggle`. Jack ticks a step only on a person's Approve, and it says which
//                  card. A tick is stamped completed_via='jack' only when that card is THIS
//                  builder's, is being saved right now (status 'applying'), was approved by the
//                  person making this call, and lists this step in payload.ticks. Anything else
//                  is refused with one sentence. An untick that names a card clears the step
//                  only when that card made the tick, so Jack's Undo never takes back a tick a
//                  person made. A step a person already ticked is left as it is.
//
// Both reads TOLERATE a database without that migration (42703, unknown column): the list
// answers with key null and completed_via null, the way it did before, because this list is on
// every builder's Support page and a deploy ahead of the migration must not take it down. A
// tick that names a card on such a database is refused rather than recorded without its marker.
//
// Actions:
//   { action: "list" }                            → the tenant's items, in order, gated
//   { action: "toggle", id, done, viaProposal? }  → tick/untick, stamping who and when

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // The browser keeps this preflight for 2 h (Chrome's cap) instead of 5 s — see portal-settings.
  "Access-Control-Max-Age": "86400",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

type Gate = { requires: string | null; visible: boolean; audience: string; key: string | null };

/** PostgREST's answer for a column the database doesn't have yet (a deploy ahead of the Jack setup migration). */
// deno-lint-ignore no-explicit-any
const unknownColumn = (e: any) => String(e?.code ?? "") === "42703";

/** The kinds of Jack card that may tick a step (jack-agent/setup.ts). */
const JACK_TICK_KINDS = new Set(["setup_company", "setup_paperwork", "setup_locations", "setup_tick"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_THIS_STEP = "That approval doesn't match this step.";

/** The template flags for a set of tenant rows, keyed by template_item_id.
 *
 *  FAILS CLOSED (throws) — see the posture note in the header. A row whose template says
 *  "not built yet" must not become visible because a query blipped. Only a missing jack_key
 *  column (before that migration) is read again without it. */
async function templateGate(
  // deno-lint-ignore no-explicit-any
  admin: any,
  // deno-lint-ignore no-explicit-any
  rows: any[] | null,
): Promise<Map<string, Gate>> {
  const ids = [...new Set((rows ?? []).map((r) => r.template_item_id).filter(Boolean))];
  const out = new Map<string, Gate>();
  if (!ids.length) return out;
  let { data, error } = await admin.from("setup_template_items")
    .select("id, requires_feature, builder_visible, account_type, jack_key").in("id", ids);
  // Before Jack's migration (376) there is no jack_key: the same read without it.
  if (error && unknownColumn(error)) {
    ({ data, error } = await admin.from("setup_template_items")
      .select("id, requires_feature, builder_visible, account_type").in("id", ids));
  }
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  for (const t of (data ?? []) as any[]) {
    out.set(t.id, {
      requires: t.requires_feature || null, visible: t.builder_visible !== false, audience: t.account_type || "all",
      key: typeof t.jack_key === "string" && t.jack_key ? t.jack_key : null,
    });
  }
  return out;
}

/** True when this Jack card is the one ticking this step right now (see the header). */
async function jackCardTicks(
  // deno-lint-ignore no-explicit-any
  admin: any,
  clientId: string,
  userId: string,
  proposalId: string,
  stepId: string,
): Promise<boolean> {
  const { data, error } = await admin.from("jack_proposals")
    .select("id, kind, status, approved_by, payload").eq("id", proposalId).eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data || !JACK_TICK_KINDS.has(String(data.kind)) || data.status !== "applying" || data.approved_by !== userId) return false;
  const ticks = data.payload && Array.isArray(data.payload.ticks) ? data.payload.ticks : [];
  // deno-lint-ignore no-explicit-any
  return ticks.some((t: any) => t && String(t.id) === stepId);
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
  const { clientId, payload, action, userId, userEmail, operator, role } = r.ctx;

  // deno-lint-ignore no-explicit-any
  const p: any = payload || {};

  switch (action) {
    case "list": {
      const LIST_COLUMNS = "id, template_item_id, title, detail, link_page, section, image_url, position, completed_at, completed_by_kind, completed_by_name";
      // A select built from a string has no row type, so the rows are read as plain objects.
      // deno-lint-ignore no-explicit-any
      const readList = (cols: string): PromiseLike<{ data: any[] | null; error: any }> =>
        admin.from("tenant_setup_items").select(cols).eq("client_id", clientId).order("position");
      let { data: rows, error } = await readList(`${LIST_COLUMNS}, completed_via`);
      if (error && unknownColumn(error)) ({ data: rows, error } = await readList(LIST_COLUMNS));
      if (error) throw error;

      const gate = await templateGate(admin, rows);
      const needed = [...new Set([...gate.values()].map((g) => g.requires).filter(Boolean))] as string[];
      const usable = await usableOrOpen(admin, clientId, needed);
      // Only asked when some step is for one shape — an all-'all' list costs no extra read.
      const shaped = [...gate.values()].some((g) => g.audience !== "all");
      const shedsOn = shaped ? await shedsOnOrOpen(admin, clientId) : true;

      const items = [];
      for (const r of rows ?? []) {
        const g = r.template_item_id ? gate.get(r.template_item_id) : null;
        if (g && !g.visible) continue;   // not built yet — never leaves the server
        if (g && !setupStepFits(g.audience, shedsOn)) continue;   // the other shape's step (368)
        // A step they ALREADY TICKED never re-locks. They plainly had the add-on when they
        // did it, so padlocking it back would rewrite their own history and shrink the
        // progress bar under them for work they did not undo.
        const locked = !!(g && g.requires) && !usable.has(g.requires!) && !r.completed_at;
        // template_item_id is internal plumbing; the browser has no use for it and it
        // names a row in a table the tenant cannot read.
        const { template_item_id: _tpl, completed_via: via, ...rest } = r;
        // `key` and `completed_via` are Jack's (see the header): which step this is, and whether
        // the tick came from a Jack card a person approved. Both null before that migration.
        items.push({ ...rest, key: g?.key ?? null, completed_via: via === "jack" ? "jack" : null, locked, requiresFeature: locked ? g!.requires : null });
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
        // Whether THIS caller's `toggle` will be accepted — the same answer resolveTenant gives
        // it: an operator in view-as needs can_write, a builder's own login needs the legacy
        // owner/admin role (no GATES table here, see the header). This said `true` for everyone,
        // so a sales rep's tick showed, then bounced back with "not change settings".
        canEdit: operator ? !!operator.canWrite : (role === "owner" || role === "admin"),
      });
    }

    case "toggle": {
      const id = String(p.id ?? "").slice(0, 40);
      const done = p.done === true;
      // Jack's card, when Jack is the one asking (see the header). Absent is a person's own press.
      const hasVia = p.viaProposal !== undefined && p.viaProposal !== null && p.viaProposal !== "";
      const viaProposal = hasVia ? String(p.viaProposal) : null;
      if (hasVia && !UUID_RE.test(viaProposal!)) return json({ error: NOT_THIS_STEP }, 400);

      // Scoped to the resolved tenant, so an id from another account matches nothing.
      // deno-lint-ignore no-explicit-any
      const readRow = (cols: string): PromiseLike<{ data: any; error: any }> =>
        admin.from("tenant_setup_items").select(cols).eq("id", id).eq("client_id", clientId).maybeSingle();
      let { data: row, error: rowErr } = await readRow("id, title, template_item_id, completed_at, completed_proposal_id");
      // Before the Jack setup migration there is nowhere to record Jack's marker: a person's own
      // tick still works, and Jack's is refused rather than stamped as theirs.
      const viaColumns = !(rowErr && unknownColumn(rowErr));
      if (!viaColumns) {
        if (hasVia) return json({ error: "Ticking a step from Jack isn't switched on yet." }, 409);
        ({ data: row, error: rowErr } = await readRow("id, title, template_item_id, completed_at"));
      }
      if (rowErr) throw rowErr;
      if (!row) return json({ error: "That setup step is not on your list." }, 404);

      // Re-derived here, not trusted from the browser: an id for a step that has since
      // been hidden or locked can still be sitting in a tab opened before the flag moved.
      const tGate = (await templateGate(admin, [row])).get(row.template_item_id) || null;
      // The SAME wording and status as an id from another tenant, on purpose — a step we
      // have not built yet must not be distinguishable from one that does not exist.
      if (tGate && !tGate.visible) return json({ error: "That setup step is not on your list." }, 404);
      // The same for a step the list hides from this account's shape (368): not on their list.
      if (tGate && tGate.audience !== "all" && !setupStepFits(tGate.audience, await shedsOnOrOpen(admin, clientId))) {
        return json({ error: "That setup step is not on your list." }, 404);
      }
      // Only TICKING is gated. Un-ticking can only reach an already-completed row, which
      // the rule above never locks — so a builder can always undo their own tick.
      if (done && tGate && tGate.requires && !row.completed_at) {
        const usable = await usableOrOpen(admin, clientId, [tGate.requires]);
        if (!usable.has(tGate.requires)) {
          return json({ error: "That step needs an add-on your account doesn't have yet." }, 403);
        }
      }

      // Jack's tick: only for the card being saved right now, and never over a person's tick.
      if (hasVia && done) {
        if (!(await jackCardTicks(admin, clientId, userId, viaProposal!, row.id))) return json({ error: NOT_THIS_STEP }, 403);
        if (row.completed_at) return json({ ok: true, already: true, item: row });
      }
      // Jack's Undo: it takes back only the tick its own card made.
      if (hasVia && !done) {
        if (!row.completed_at) return json({ ok: true, item: row });
        if (row.completed_proposal_id !== viaProposal) {
          return json({ error: "Someone ticked that step themselves, so it stays ticked.", kept: true }, 409);
        }
      }

      // The marker travels with every write once the columns exist: a person's own tick or untick
      // clears it, so "with Jack" is only ever said of a tick Jack's card made.
      const via = viaColumns ? { completed_via: hasVia && done ? "jack" : null, completed_proposal_id: hasVia && done ? viaProposal : null } : {};
      let patch: Record<string, unknown>;
      if (!done) {
        patch = { completed_at: null, completed_by_kind: null, completed_by_name: null, ...via };
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
          ...via,
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
