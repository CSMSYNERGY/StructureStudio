import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";

// Internal "Projects" module backend (portal.html Projects tab): CSM Synergy's own
// project management — bugs, feature requests, roadmap — replacing Monday.com.
// Monday-style boards with user-defined typed columns, groups, items (values in one
// jsonb keyed by column id), an updates thread, and an append-only activity audit.
//
// Auth model — OPERATORS ONLY, the operator-portal pattern, NOT resolveTenant:
//   1. Real signed-in user via auth.getUser() (verify_jwt alone is not auth).
//   2. Operator membership via a service-role app_operators lookup; every write
//      additionally requires app_operators.can_write. There is no tenant in this
//      function's world: pm_* tables are cross-tenant internal data with zero RLS
//      policies, so every read below is service-role AFTER both checks pass.
//   This function must NOT be added to portal.html's SS_TENANT_SCOPED_FNS — it takes
//   no targetClientId and a body field honoured for some callers is how holes open.
//
// The client boundary (the /client-marker replacement — migration 144's design note):
//   * Everything here is invisible to tenants BY CONSTRUCTION (no read path).
//   * A status label may carry `client_status` (one of feedback_submissions' 8 states).
//     Changing a linked item's status to such a label updates the tenant-facing mirror
//     row; labels without one are pure-internal and touch nothing tenant-side.
//   * Saved views (pm_views) are per BOARD and shared by the whole operator team.
//   * The Assignee roster IS app_operators — a PRIVILEGE table. See the roster
//     actions below before touching them.
//   * An update marked client_visible is COPIED into feedback_comments (author
//     "CSM Synergy", monday_update_id NULL — both Monday reconcile paths delete only
//     by monday_update_id, so copies survive a Monday refresh). Editing/deleting the
//     pm_update maintains its copy through pm_updates.feedback_comment_id.

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

// ── Validation helpers (whitelist-rebuild — never patch user jsonb in place) ──

const COLUMN_TYPES = new Set([
  "status", "text", "long_text", "number", "date", "people", "dropdown", "checkbox", "link",
]);
// The tenant-facing ladder from migration 054 — the ONLY values client_status may hold.
const CLIENT_STATUSES = new Set([
  "submitted", "in_review", "planned", "in_progress", "needs_info", "shipped", "declined", "duplicate",
]);
const LABEL_KINDS = new Set(["done", "working", "stuck"]);

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function cssColor(v: unknown): string | undefined {
  const s = str(v, 40);
  return /^[#a-zA-Z0-9(),.% -]+$/.test(s) && s ? s : undefined;
}
function slugId(prefix: string): string {
  return prefix + "_" + crypto.randomUUID().slice(0, 8);
}

// Rebuild a column's settings for its type. Existing stable ids are preserved when the
// caller sends them back; entries without an id get one minted here (ids are what item
// values store, so they must never be caller-invented free text).
// deno-lint-ignore no-explicit-any
function sanitizeSettings(type: string, raw: any): Record<string, unknown> {
  if (type === "status") {
    const labels = Array.isArray(raw?.labels) ? raw.labels : [];
    const seen = new Set<string>();
    // deno-lint-ignore no-explicit-any
    const out = labels.slice(0, 30).map((l: any) => {
      let id = str(l?.id, 40);
      if (!/^l_[a-z0-9_]{1,30}$/i.test(id) || seen.has(id)) id = slugId("l");
      seen.add(id);
      const label: Record<string, unknown> = {
        id,
        label: str(l?.label, 60) || "Label",
        color: cssColor(l?.color) || "#64748B",
      };
      if (LABEL_KINDS.has(l?.kind)) label.kind = l.kind;
      if (CLIENT_STATUSES.has(l?.client_status)) label.client_status = l.client_status;
      if (l?.intake === true) label.intake = true;
      return label;
    });
    return { labels: out };
  }
  if (type === "dropdown") {
    const options = Array.isArray(raw?.options) ? raw.options : [];
    const seen = new Set<string>();
    // deno-lint-ignore no-explicit-any
    const out = options.slice(0, 50).map((o: any) => {
      let id = str(o?.id, 40);
      if (!/^o_[a-z0-9_]{1,30}$/i.test(id) || seen.has(id)) id = slugId("o");
      seen.add(id);
      return { id, label: str(o?.label, 60) || "Option", color: cssColor(o?.color) || "#64748B" };
    });
    return { options: out, multi: raw?.multi === true };
  }
  if (type === "number") {
    const out: Record<string, unknown> = {};
    const unit = str(raw?.unit, 12);
    if (unit) out.unit = unit;
    const p = Number(raw?.precision);
    if (Number.isInteger(p) && p >= 0 && p <= 4) out.precision = p;
    return out;
  }
  return {};
}

// Rebuild an item's values against the board's real columns. Unknown keys are dropped;
// each value is coerced to its column type's shape or omitted. `operatorIds` guards the
// people type — an assignee must be a real operator.
// deno-lint-ignore no-explicit-any
function sanitizeValues(columns: any[], raw: any, operatorIds: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const col of columns) {
    if (!(col.id in raw)) continue;
    const v = raw[col.id];
    if (v === null || v === undefined || v === "") { out[col.id] = null; continue; }
    switch (col.type) {
      case "text": { out[col.id] = str(v, 200); break; }
      case "long_text": { out[col.id] = str(v, 8000); break; }
      case "number": { const n = Number(v); if (Number.isFinite(n)) out[col.id] = n; break; }
      case "date": { const s = str(v, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out[col.id] = s; break; }
      case "checkbox": { out[col.id] = v === true; break; }
      case "status": {
        // deno-lint-ignore no-explicit-any
        const ids = new Set((col.settings?.labels || []).map((l: any) => l.id));
        const s = str(v, 40);
        if (ids.has(s)) out[col.id] = s;
        break;
      }
      case "dropdown": {
        // deno-lint-ignore no-explicit-any
        const ids = new Set((col.settings?.options || []).map((o: any) => o.id));
        const arr = (Array.isArray(v) ? v : [v]).map((x) => str(x, 40)).filter((x) => ids.has(x));
        const multi = col.settings?.multi === true;
        out[col.id] = multi ? arr.slice(0, 20) : arr.slice(0, 1);
        break;
      }
      case "people": {
        const arr = (Array.isArray(v) ? v : [v]).map((x) => str(x, 40)).filter((x) => operatorIds.has(x));
        out[col.id] = arr.slice(0, 10);
        break;
      }
      case "link": {
        const url = str(v?.url, 500);
        try {
          const u = new URL(url);
          if (u.protocol === "http:" || u.protocol === "https:") {
            out[col.id] = { url, text: str(v?.text, 120) };
          }
        } catch { /* not a URL — drop */ }
        break;
      }
    }
  }
  return out;
}

// Rebuild a saved view's snapshot. Shared by the whole operator team, so it is
// whitelist-rebuilt exactly like column settings and item values: unknown keys dropped,
// every string capped, and the column ids it names checked against this board. A view
// referencing a since-deleted column simply loses that part rather than 500ing the board.
// deno-lint-ignore no-explicit-any
function sanitizeSnap(raw: any, columnIds: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.q = str(raw?.q, 200);
  const facets: Record<string, string> = {};
  if (raw?.facets && typeof raw.facets === "object") {
    for (const k of Object.keys(raw.facets).slice(0, 40)) {
      if (!columnIds.has(k)) continue;
      const v = str(raw.facets[k], 60);
      if (v) facets[k] = v;
    }
  }
  out.facets = facets;
  if (raw?.when && typeof raw.when === "object" && str(raw.when.cond, 30)) {
    const colId = str(raw.when.colId, 40);
    out.when = {
      colId: columnIds.has(colId) ? colId : null,
      cond: str(raw.when.cond, 30),
      a: str(raw.when.a, 10), b: str(raw.when.b, 10),
      month: str(raw.when.month, 7), n: str(raw.when.n, 6),
      unit: ["days", "weeks", "months"].includes(raw.when.unit) ? raw.when.unit : "days",
    };
  } else out.when = null;
  const groupBy = str(raw?.groupBy, 40);
  out.groupBy = groupBy === "groups" || columnIds.has(groupBy) ? groupBy : "groups";
  const sortKey = str(raw?.sortKey, 40);
  out.sortKey = sortKey === "name" || columnIds.has(sortKey) ? sortKey : "name";
  out.sortDir = raw?.sortDir === "desc" ? "desc" : "asc";
  out.hiddenCols = (Array.isArray(raw?.hiddenCols) ? raw.hiddenCols : [])
    .map((x: unknown) => str(x, 40)).filter((x: string) => columnIds.has(x)).slice(0, 40);
  return out;
}

// Fractional ordering: new position between neighbours; caller renumbers on collapse.
function midpoint(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1024;
  if (before === null) return (after as number) - 1024;
  if (after === null) return before + 1024;
  return (before + after) / 2;
}

Deno.serve(withErrorLog("portal-projects", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Real user (the bare anon key passes the gateway but has no user).
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
    .select("user_id, email, can_write")
    .eq("user_id", user.id)
    .maybeSingle();
  if (opErr) return json({ error: opErr.message }, 500);
  if (!op) return json({ error: "Operator access required." }, 403);

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(payload?.action || "");

  const READ_ACTIONS = new Set(["list_boards", "get_board", "get_item", "sign_attachment"]);
  if (!READ_ACTIONS.has(action) && !op.can_write) {
    return json({ error: "This operator account is read-only." }, 403);
  }

  const actorEmail = op.email || user.email || user.id;
  // Best-effort activity log — accountability for shared write access; never blocks.
  const act = async (boardId: string | null, itemId: string | null, action: string, detail: Record<string, unknown> = {}) => {
    try {
      await admin.from("pm_activity").insert({
        board_id: boardId, item_id: itemId,
        actor_user_id: user.id, actor_email: actorEmail,
        action, detail,
      });
    } catch (_) { /* best-effort */ }
  };

  // deno-lint-ignore no-explicit-any
  const boardColumns = async (boardId: string): Promise<any[]> => {
    const { data, error } = await admin.from("pm_columns").select("*")
      .eq("board_id", boardId).order("position");
    if (error) throw error;
    return data || [];
  };
  const operatorIdSet = async (): Promise<Set<string>> => {
    const { data, error } = await admin.from("app_operators").select("user_id");
    if (error) throw error;
    return new Set((data || []).map((r: { user_id: string }) => r.user_id));
  };
  // deno-lint-ignore no-explicit-any
  const getItem = async (id: string): Promise<any> => {
    const { data, error } = await admin.from("pm_items").select("*").eq("id", str(id, 40)).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Item not found.");
    return data;
  };

  // Propagate a status change to the tenant mirror when the label maps to a client
  // status and the item is linked to a feedback submission.
  // deno-lint-ignore no-explicit-any
  const propagateStatus = async (item: any, columns: any[], newValues: Record<string, unknown>, oldValues: Record<string, unknown>) => {
    if (!item.feedback_submission_id) return;
    for (const col of columns) {
      if (col.type !== "status" || !(col.id in newValues)) continue;
      if (newValues[col.id] === oldValues?.[col.id]) continue;
      // deno-lint-ignore no-explicit-any
      const label = (col.settings?.labels || []).find((l: any) => l.id === newValues[col.id]);
      if (!label) continue;
      if (label.client_status && CLIENT_STATUSES.has(label.client_status)) {
        const { error } = await admin.from("feedback_submissions")
          .update({ status: label.client_status, status_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", item.feedback_submission_id);
        if (error) throw error;
        await act(item.board_id, item.id, "client_status", { to: label.client_status, label: label.label });
      } else {
        await act(item.board_id, item.id, "status", { label: label.label });
      }
    }
  };

  try {
    switch (action) {
      // ── Reads ─────────────────────────────────────────────────────────────
      case "list_boards": {
        const { data: boards, error } = await admin.from("pm_boards").select("*")
          .is("archived_at", null).order("position");
        if (error) throw error;
        const counts: Record<string, number> = {};
        for (const b of boards || []) {
          const { count } = await admin.from("pm_items")
            .select("id", { count: "exact", head: true })
            .eq("board_id", b.id).is("archived_at", null);
          counts[b.id] = count || 0;
        }
        return json({ boards, counts, canWrite: !!op.can_write });
      }

      case "get_board": {
        const boardId = str(payload.boardId, 40);
        const { data: board, error: bErr } = await admin.from("pm_boards").select("*")
          .eq("id", boardId).maybeSingle();
        if (bErr) throw bErr;
        if (!board) return json({ error: "Board not found." }, 404);
        const [columns, groupsRes, itemsRes, opsRes, viewsRes] = await Promise.all([
          boardColumns(boardId),
          admin.from("pm_groups").select("*").eq("board_id", boardId).order("position"),
          admin.from("pm_items").select("*").eq("board_id", boardId).is("archived_at", null)
            .order("position").limit(2000),
          admin.from("app_operators").select("user_id, email, display_name, can_write"),
          admin.from("pm_views").select("*").eq("board_id", boardId).order("position"),
        ]);
        if (groupsRes.error) throw groupsRes.error;
        if (itemsRes.error) throw itemsRes.error;
        if (opsRes.error) throw opsRes.error;
        if (viewsRes.error) throw viewsRes.error;
        return json({
          board, columns, groups: groupsRes.data, items: itemsRes.data,
          operators: opsRes.data, views: viewsRes.data, canWrite: !!op.can_write,
        });
      }

      case "get_item": {
        const item = await getItem(payload.id);
        const [updatesRes, actRes] = await Promise.all([
          admin.from("pm_updates").select("*").eq("item_id", item.id).order("created_at", { ascending: false }).limit(100),
          admin.from("pm_activity").select("*").eq("item_id", item.id).order("created_at", { ascending: false }).limit(50),
        ]);
        if (updatesRes.error) throw updatesRes.error;
        if (actRes.error) throw actRes.error;
        // Signed URLs for update attachments (short-lived, service role — the bucket has no policies).
        const updates = [];
        for (const u of updatesRes.data || []) {
          // deno-lint-ignore no-explicit-any
          const atts: any[] = [];
          for (const a of (Array.isArray(u.attachments) ? u.attachments : [])) {
            const { data: signed } = await admin.storage.from("pm-attachments").createSignedUrl(a.path, 600);
            atts.push({ ...a, url: signed?.signedUrl || null });
          }
          updates.push({ ...u, attachments: atts });
        }
        // Linked tenant submission (the client-facing truth) if any.
        let submission = null;
        if (item.feedback_submission_id) {
          const { data: sub } = await admin.from("feedback_submissions")
            .select("id, client_id, submitter_name, submitter_email, kind, title, detail, severity, status, status_changed_at, attachment_path, created_at")
            .eq("id", item.feedback_submission_id).maybeSingle();
          if (sub) {
            let attachmentUrl = null;
            if (sub.attachment_path) {
              const { data: signed } = await admin.storage.from("feedback-attachments").createSignedUrl(sub.attachment_path, 600);
              attachmentUrl = signed?.signedUrl || null;
            }
            submission = { ...sub, attachmentUrl };
          }
        }
        return json({ item, updates, activity: actRes.data, submission, canWrite: !!op.can_write });
      }

      case "sign_attachment": {
        const path = str(payload.path, 300);
        if (!path) return json({ error: "Missing path." }, 400);
        const { data: signed, error } = await admin.storage.from("pm-attachments").createSignedUrl(path, 600);
        if (error) throw error;
        return json({ url: signed?.signedUrl });
      }

      // ── Boards ────────────────────────────────────────────────────────────
      case "create_board": {
        const name = str(payload.name, 80);
        if (!name) return json({ error: "Board name is required." }, 400);
        let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "board";
        const { data: clash } = await admin.from("pm_boards").select("id").eq("slug", slug).maybeSingle();
        if (clash) slug = `${slug}-${crypto.randomUUID().slice(0, 4)}`;
        const { data: maxRow } = await admin.from("pm_boards").select("position").order("position", { ascending: false }).limit(1).maybeSingle();
        const { data: board, error } = await admin.from("pm_boards")
          .insert({ slug, name, position: (maxRow?.position || 0) + 1024 }).select().single();
        if (error) throw error;
        const { error: gErr } = await admin.from("pm_groups")
          .insert({ board_id: board.id, name: "Items", color: "#3D3672", position: 1024 });
        if (gErr) throw gErr;
        await act(board.id, null, "create_board", { name });
        return json({ board });
      }

      case "update_board": {
        const id = str(payload.id, 40);
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (payload.name !== undefined) {
          const name = str(payload.name, 80);
          if (!name) return json({ error: "Board name is required." }, 400);
          patch.name = name;
        }
        const { error } = await admin.from("pm_boards").update(patch).eq("id", id);
        if (error) throw error;
        await act(id, null, "update_board", {});
        return json({ ok: true });
      }

      case "archive_board": {
        const id = str(payload.id, 40);
        const { error } = await admin.from("pm_boards")
          .update({ archived_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        await act(id, null, "archive_board", {});
        return json({ ok: true });
      }

      // ── Columns ───────────────────────────────────────────────────────────
      case "create_column": {
        const boardId = str(payload.boardId, 40);
        const type = str(payload.type, 20);
        if (!COLUMN_TYPES.has(type)) return json({ error: "Unknown column type." }, 400);
        const name = str(payload.name, 80);
        if (!name) return json({ error: "Column name is required." }, 400);
        const { data: maxRow } = await admin.from("pm_columns").select("position")
          .eq("board_id", boardId).order("position", { ascending: false }).limit(1).maybeSingle();
        const settings = sanitizeSettings(type, payload.settings);
        // A status column must have at least one label to be usable.
        if (type === "status" && !(settings.labels as unknown[]).length) {
          settings.labels = [
            { id: slugId("l"), label: "To do", color: "#64748B" },
            { id: slugId("l"), label: "Working on it", color: "#F59E0B", kind: "working" },
            { id: slugId("l"), label: "Done", color: "#0E9F6E", kind: "done" },
          ];
        }
        const { data: column, error } = await admin.from("pm_columns").insert({
          board_id: boardId, type, name, settings,
          position: (maxRow?.position || 0) + 1024,
          width: Number.isInteger(payload.width) ? payload.width : null,
        }).select().single();
        if (error) throw error;
        await act(boardId, null, "create_column", { name, type });
        return json({ column });
      }

      case "update_column": {
        const id = str(payload.id, 40);
        const { data: col, error: cErr } = await admin.from("pm_columns").select("*").eq("id", id).maybeSingle();
        if (cErr) throw cErr;
        if (!col) return json({ error: "Column not found." }, 404);
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (payload.name !== undefined) {
          const name = str(payload.name, 80);
          if (!name) return json({ error: "Column name is required." }, 400);
          patch.name = name;
        }
        if (payload.width !== undefined) {
          patch.width = Number.isInteger(payload.width) && payload.width > 40 ? payload.width : null;
        }
        if (payload.settings !== undefined) {
          const settings = sanitizeSettings(col.type, payload.settings);
          // Removing a status label needs every item using it reassigned — a value
          // pointing at a vanished label would render as blank with no explanation.
          if (col.type === "status") {
            // deno-lint-ignore no-explicit-any
            const oldIds = new Set((col.settings?.labels || []).map((l: any) => l.id));
            // deno-lint-ignore no-explicit-any
            const newIds = new Set((settings.labels as any[]).map((l) => l.id));
            const removed = [...oldIds].filter((x) => !newIds.has(x));
            if (removed.length) {
              const reassign = payload.reassign || {};
              for (const rid of removed) {
                const to = str(reassign[rid as string], 40);
                if (!newIds.has(to)) {
                  return json({ error: "Removing a label needs a replacement for items using it.", removed }, 400);
                }
              }
              const { data: rows, error: iErr } = await admin.from("pm_items")
                .select("id, values").eq("board_id", col.board_id);
              if (iErr) throw iErr;
              for (const row of rows || []) {
                const cur = row.values?.[col.id];
                if (removed.includes(cur)) {
                  const { error } = await admin.from("pm_items")
                    .update({ values: { ...row.values, [col.id]: reassign[cur] }, updated_at: new Date().toISOString() })
                    .eq("id", row.id);
                  if (error) throw error;
                }
              }
            }
          }
          patch.settings = settings;
        }
        const { error } = await admin.from("pm_columns").update(patch).eq("id", id);
        if (error) throw error;
        await act(col.board_id, null, "update_column", { name: patch.name || col.name });
        return json({ ok: true });
      }

      case "delete_column": {
        const id = str(payload.id, 40);
        const { data: col } = await admin.from("pm_columns").select("board_id, name").eq("id", id).maybeSingle();
        const { error } = await admin.from("pm_columns").delete().eq("id", id);
        if (error) throw error;
        await act(col?.board_id || null, null, "delete_column", { name: col?.name });
        return json({ ok: true });
      }

      case "reorder_columns": {
        const boardId = str(payload.boardId, 40);
        const ids = Array.isArray(payload.orderedIds) ? payload.orderedIds.map((x: unknown) => str(x, 40)) : [];
        let pos = 1024;
        for (const id of ids) {
          const { error } = await admin.from("pm_columns").update({ position: pos }).eq("id", id).eq("board_id", boardId);
          if (error) throw error;
          pos += 1024;
        }
        return json({ ok: true });
      }

      // ── Groups ────────────────────────────────────────────────────────────
      case "create_group": {
        const boardId = str(payload.boardId, 40);
        const name = str(payload.name, 80) || "New group";
        const { data: maxRow } = await admin.from("pm_groups").select("position")
          .eq("board_id", boardId).order("position", { ascending: false }).limit(1).maybeSingle();
        const { data: group, error } = await admin.from("pm_groups").insert({
          board_id: boardId, name, color: cssColor(payload.color) || "#3D3672",
          position: (maxRow?.position || 0) + 1024,
        }).select().single();
        if (error) throw error;
        await act(boardId, null, "create_group", { name });
        return json({ group });
      }

      case "update_group": {
        const id = str(payload.id, 40);
        const patch: Record<string, unknown> = {};
        if (payload.name !== undefined) patch.name = str(payload.name, 80) || "Group";
        if (payload.color !== undefined) patch.color = cssColor(payload.color) || null;
        const { error } = await admin.from("pm_groups").update(patch).eq("id", id);
        if (error) throw error;
        return json({ ok: true });
      }

      case "reorder_groups": {
        const boardId = str(payload.boardId, 40);
        const ids = Array.isArray(payload.orderedIds) ? payload.orderedIds.map((x: unknown) => str(x, 40)) : [];
        let pos = 1024;
        for (const id of ids) {
          const { error } = await admin.from("pm_groups").update({ position: pos }).eq("id", id).eq("board_id", boardId);
          if (error) throw error;
          pos += 1024;
        }
        return json({ ok: true });
      }

      case "delete_group": {
        const id = str(payload.id, 40);
        const moveTo = str(payload.moveToGroupId, 40);
        const { data: group, error: gErr } = await admin.from("pm_groups").select("*").eq("id", id).maybeSingle();
        if (gErr) throw gErr;
        if (!group) return json({ error: "Group not found." }, 404);
        const { count } = await admin.from("pm_groups")
          .select("id", { count: "exact", head: true }).eq("board_id", group.board_id);
        if ((count || 0) <= 1) return json({ error: "A board needs at least one group." }, 400);
        const { count: itemCount } = await admin.from("pm_items")
          .select("id", { count: "exact", head: true }).eq("group_id", id);
        if ((itemCount || 0) > 0) {
          if (!moveTo || moveTo === id) return json({ error: "Pick a group to move this group's items into." }, 400);
          const { data: dest } = await admin.from("pm_groups").select("id, board_id").eq("id", moveTo).maybeSingle();
          if (!dest || dest.board_id !== group.board_id) return json({ error: "Destination group is not on this board." }, 400);
          const { error } = await admin.from("pm_items").update({ group_id: moveTo }).eq("group_id", id);
          if (error) throw error;
        }
        const { error } = await admin.from("pm_groups").delete().eq("id", id);
        if (error) throw error;
        await act(group.board_id, null, "delete_group", { name: group.name });
        return json({ ok: true });
      }

      // ── Items ─────────────────────────────────────────────────────────────
      case "create_item": {
        const boardId = str(payload.boardId, 40);
        const groupId = str(payload.groupId, 40);
        const name = str(payload.name, 200);
        if (!name) return json({ error: "Item name is required." }, 400);
        const { data: group } = await admin.from("pm_groups").select("id, board_id").eq("id", groupId).maybeSingle();
        if (!group || group.board_id !== boardId) return json({ error: "Group is not on this board." }, 400);
        const [columns, opIds] = await Promise.all([boardColumns(boardId), operatorIdSet()]);
        const values = sanitizeValues(columns, payload.values, opIds);
        const { data: maxRow } = await admin.from("pm_items").select("position")
          .eq("group_id", groupId).order("position", { ascending: false }).limit(1).maybeSingle();
        const { data: item, error } = await admin.from("pm_items").insert({
          board_id: boardId, group_id: groupId, name, values,
          position: (maxRow?.position || 0) + 1024,
          created_by: user.id, created_by_email: actorEmail,
        }).select().single();
        if (error) throw error;
        await act(boardId, item.id, "create_item", { name });
        await propagateStatus(item, columns, values, {});
        return json({ item });
      }

      case "update_item": {
        const item = await getItem(payload.id);
        const [columns, opIds] = await Promise.all([boardColumns(item.board_id), operatorIdSet()]);
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (payload.name !== undefined) {
          const name = str(payload.name, 200);
          if (!name) return json({ error: "Item name is required." }, 400);
          patch.name = name;
        }
        let newValues: Record<string, unknown> | null = null;
        if (payload.values !== undefined) {
          const clean = sanitizeValues(columns, payload.values, opIds);
          newValues = { ...item.values, ...clean };
          patch.values = newValues;
        }
        const { data: updated, error } = await admin.from("pm_items").update(patch).eq("id", item.id).select().single();
        if (error) throw error;
        if (newValues) await propagateStatus(item, columns, newValues, item.values || {});
        else await act(item.board_id, item.id, "rename_item", {});
        return json({ item: updated });
      }

      case "move_items": {
        const ids = (Array.isArray(payload.ids) ? payload.ids : []).map((x: unknown) => str(x, 40)).filter(Boolean);
        const groupId = str(payload.groupId, 40);
        if (!ids.length) return json({ error: "No items given." }, 400);
        const { data: dest } = await admin.from("pm_groups").select("id, board_id, name").eq("id", groupId).maybeSingle();
        if (!dest) return json({ error: "Group not found." }, 404);
        const { data: maxRow } = await admin.from("pm_items").select("position")
          .eq("group_id", groupId).order("position", { ascending: false }).limit(1).maybeSingle();
        let pos = (maxRow?.position || 0) + 1024;
        for (const id of ids) {
          const { error } = await admin.from("pm_items")
            .update({ group_id: groupId, position: pos, updated_at: new Date().toISOString() })
            .eq("id", id).eq("board_id", dest.board_id);  // never move across boards
          if (error) throw error;
          pos += 1024;
        }
        await act(dest.board_id, ids.length === 1 ? ids[0] : null, "move_items", { count: ids.length, to: dest.name });
        return json({ ok: true });
      }

      case "reorder_item": {
        const item = await getItem(payload.id);
        const beforeId = str(payload.beforeId, 40);  // the row the item lands ABOVE
        const groupId = str(payload.groupId, 40) || item.group_id;
        const { data: rows, error: rErr } = await admin.from("pm_items")
          .select("id, position").eq("group_id", groupId).is("archived_at", null).order("position");
        if (rErr) throw rErr;
        const others = (rows || []).filter((r: { id: string }) => r.id !== item.id);
        let before: number | null = null, after: number | null = null;
        if (beforeId) {
          const idx = others.findIndex((r: { id: string }) => r.id === beforeId);
          if (idx === -1) return json({ error: "Reference row not found." }, 400);
          after = others[idx].position;
          before = idx > 0 ? others[idx - 1].position : null;
        } else {
          before = others.length ? others[others.length - 1].position : null;
        }
        let pos = midpoint(before, after);
        // Renumber the group when the gap collapses below float comfort.
        if (before !== null && after !== null && Math.abs(after - before) < 1e-6) {
          let p = 1024;
          for (const r of others) {
            const { error } = await admin.from("pm_items").update({ position: p }).eq("id", r.id);
            if (error) throw error;
            p += 1024;
          }
          pos = beforeId ? (others.findIndex((r: { id: string }) => r.id === beforeId) + 0.5) * 1024 : p;
        }
        const { error } = await admin.from("pm_items")
          .update({ group_id: groupId, position: pos, updated_at: new Date().toISOString() }).eq("id", item.id);
        if (error) throw error;
        return json({ ok: true });
      }

      case "archive_items": {
        const ids = (Array.isArray(payload.ids) ? payload.ids : []).map((x: unknown) => str(x, 40)).filter(Boolean);
        if (!ids.length) return json({ error: "No items given." }, 400);
        const { error } = await admin.from("pm_items")
          .update({ archived_at: new Date().toISOString() }).in("id", ids);
        if (error) throw error;
        await act(null, ids.length === 1 ? ids[0] : null, "archive_items", { count: ids.length });
        return json({ ok: true });
      }

      case "restore_item": {
        const id = str(payload.id, 40);
        const { error } = await admin.from("pm_items").update({ archived_at: null }).eq("id", id);
        if (error) throw error;
        return json({ ok: true });
      }

      // ── Saved views (shared by the operator team) ─────────────────────────
      case "save_view": {
        const boardId = str(payload.boardId, 40);
        const name = str(payload.name, 60);
        if (!name) return json({ error: "Give this view a name." }, 400);
        const columns = await boardColumns(boardId);
        if (!columns.length) return json({ error: "Board not found." }, 404);
        const snap = sanitizeSnap(payload.snap, new Set(columns.map((c) => c.id)));
        const { data: maxRow } = await admin.from("pm_views").select("position")
          .eq("board_id", boardId).order("position", { ascending: false }).limit(1).maybeSingle();
        // Upsert on (board_id, name): saving over a name replaces that view, which is what
        // re-using a name means - and it keeps two people from making rival "Mine" chips.
        const { data: view, error } = await admin.from("pm_views").upsert({
          board_id: boardId, name, snap,
          position: (maxRow?.position || 0) + 1024,
          created_by: user.id, created_by_email: actorEmail,
          updated_at: new Date().toISOString(),
        }, { onConflict: "board_id,name" }).select().single();
        if (error) throw error;
        await act(boardId, null, "save_view", { name });
        return json({ view });
      }

      case "delete_view": {
        const id = str(payload.id, 40);
        const { data: v } = await admin.from("pm_views").select("board_id, name").eq("id", id).maybeSingle();
        const { error } = await admin.from("pm_views").delete().eq("id", id);
        if (error) throw error;
        await act(v?.board_id || null, null, "delete_view", { name: v?.name });
        return json({ ok: true });
      }

      // ── Assignee roster (app_operators) ───────────────────────────────────
      // ⚠️ PRIVILEGE TABLE. A row here is not just "can be assigned work" — it grants
      // operator access to EVERY builder's account (051). So: only people who already
      // have a StructureStudio login can be added (no account creation from here, no
      // passwords), every change is written to admin_audit with the actor, and nobody can
      // remove themselves — locking the last operator out of the console is not something
      // a click should be able to do.
      case "list_operators": {
        const { data, error } = await admin.from("app_operators")
          .select("user_id, email, display_name, can_write, can_bill").order("email");
        if (error) throw error;
        return json({ operators: data, me: user.id });
      }

      case "save_operator": {
        const userId = str(payload.userId, 40);
        const { data: row } = await admin.from("app_operators").select("user_id, email, can_write").eq("user_id", userId).maybeSingle();
        if (!row) return json({ error: "That person is not on the team." }, 404);
        const patch: Record<string, unknown> = {};
        if (payload.displayName !== undefined) patch.display_name = str(payload.displayName, 80) || null;
        if (payload.canWrite !== undefined) patch.can_write = payload.canWrite === true;
        if (!Object.keys(patch).length) return json({ ok: true });
        const { error } = await admin.from("app_operators").update(patch).eq("user_id", userId);
        if (error) throw error;
        if (patch.can_write !== undefined && patch.can_write !== row.can_write) {
          const { error: aErr } = await admin.from("admin_audit").insert({
            action: "operator_can_write", target_client_id: null, row_count: null,
            note: `operator:${actorEmail} set can_write=${patch.can_write} for ${row.email}`,
          });
          if (aErr) throw new Error(`Could not record this change in the audit log: ${aErr.message}`);
        }
        return json({ ok: true });
      }

      case "add_operator": {
        const email = str(payload.email, 200).toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That does not look like an email address." }, 400);
        const { data: found, error: fErr } = await admin.rpc("pm_find_user_by_email", { p_email: email });
        if (fErr) throw fErr;
        const hit = Array.isArray(found) ? found[0] : found;
        if (!hit) {
          return json({ error: `No StructureStudio login for ${email} yet. They need an account before they can be added to the team.` }, 404);
        }
        const { data: exists } = await admin.from("app_operators").select("user_id").eq("user_id", hit.id).maybeSingle();
        if (exists) return json({ error: "They are already on the team." }, 409);
        // New operators start READ-ONLY. Being able to see the boards is the small grant;
        // being able to change other people's tenants is the one someone should choose.
        const { error } = await admin.from("app_operators").insert({
          user_id: hit.id, email: hit.email,
          display_name: str(payload.displayName, 80) || null,
          can_write: false, can_bill: false,
        });
        if (error) throw error;
        const { error: aErr } = await admin.from("admin_audit").insert({
          action: "operator_added", target_client_id: null, row_count: null,
          note: `operator:${actorEmail} added ${hit.email} to app_operators (read-only)`,
        });
        if (aErr) throw new Error(`Could not record this change in the audit log: ${aErr.message}`);
        return json({ ok: true });
      }

      case "remove_operator": {
        const userId = str(payload.userId, 40);
        if (userId === user.id) return json({ error: "You cannot remove your own access." }, 400);
        const { data: row } = await admin.from("app_operators").select("email").eq("user_id", userId).maybeSingle();
        if (!row) return json({ ok: true });
        const { error } = await admin.from("app_operators").delete().eq("user_id", userId);
        if (error) throw error;
        const { error: aErr } = await admin.from("admin_audit").insert({
          action: "operator_removed", target_client_id: null, row_count: null,
          note: `operator:${actorEmail} removed ${row.email} from app_operators`,
        });
        if (aErr) throw new Error(`Could not record this change in the audit log: ${aErr.message}`);
        return json({ ok: true });
      }

      // ── Feedback linkage ──────────────────────────────────────────────────
      case "link_feedback": {
        const item = await getItem(payload.itemId);
        const subId = str(payload.submissionId, 40);
        const { data: sub } = await admin.from("feedback_submissions").select("id").eq("id", subId).maybeSingle();
        if (!sub) return json({ error: "Submission not found." }, 404);
        const { error } = await admin.from("pm_items")
          .update({ feedback_submission_id: subId, updated_at: new Date().toISOString() }).eq("id", item.id);
        if (error) {
          if (String(error.message || "").includes("unique")) {
            return json({ error: "That submission is already linked to another item." }, 409);
          }
          throw error;
        }
        await act(item.board_id, item.id, "link_feedback", { submissionId: subId });
        return json({ ok: true });
      }

      case "unlink_feedback": {
        const item = await getItem(payload.itemId);
        const { error } = await admin.from("pm_items")
          .update({ feedback_submission_id: null, updated_at: new Date().toISOString() }).eq("id", item.id);
        if (error) throw error;
        await act(item.board_id, item.id, "unlink_feedback", {});
        return json({ ok: true });
      }

      // ── Updates (the conversation) ────────────────────────────────────────
      case "add_update": {
        const item = await getItem(payload.itemId);
        const body = str(payload.body, 8000);
        if (!body) return json({ error: "Write something first." }, 400);
        const clientVisible = payload.clientVisible === true;
        if (clientVisible && !item.feedback_submission_id) {
          return json({ error: "This item isn't linked to a client submission — there is nobody to publish to." }, 400);
        }
        let feedbackCommentId: string | null = null;
        if (clientVisible) {
          const { data: comment, error } = await admin.from("feedback_comments").insert({
            submission_id: item.feedback_submission_id,
            monday_update_id: null,               // null = PM-authored; Monday reconciles only delete by their own ids
            author_name: "CSM Synergy",
            body,
          }).select().single();
          if (error) throw error;
          feedbackCommentId = comment.id;
        }
        const { data: update, error } = await admin.from("pm_updates").insert({
          item_id: item.id, author_user_id: user.id, author_email: actorEmail,
          body, client_visible: clientVisible, feedback_comment_id: feedbackCommentId,
          attachments: [],
        }).select().single();
        if (error) throw error;
        await act(item.board_id, item.id, clientVisible ? "publish_update" : "add_update", {});
        return json({ update });
      }

      case "publish_update": {
        const id = str(payload.id, 40);
        const { data: u, error: uErr } = await admin.from("pm_updates").select("*").eq("id", id).maybeSingle();
        if (uErr) throw uErr;
        if (!u) return json({ error: "Update not found." }, 404);
        if (u.client_visible) return json({ ok: true });
        const item = await getItem(u.item_id);
        if (!item.feedback_submission_id) {
          return json({ error: "This item isn't linked to a client submission — there is nobody to publish to." }, 400);
        }
        const { data: comment, error: cErr } = await admin.from("feedback_comments").insert({
          submission_id: item.feedback_submission_id, monday_update_id: null,
          author_name: "CSM Synergy", body: u.body,
        }).select().single();
        if (cErr) throw cErr;
        const { error } = await admin.from("pm_updates")
          .update({ client_visible: true, feedback_comment_id: comment.id }).eq("id", id);
        if (error) throw error;
        await act(item.board_id, item.id, "publish_update", {});
        return json({ ok: true });
      }

      case "edit_update": {
        const id = str(payload.id, 40);
        const body = str(payload.body, 8000);
        if (!body) return json({ error: "Write something first." }, 400);
        const { data: u } = await admin.from("pm_updates").select("*").eq("id", id).maybeSingle();
        if (!u) return json({ error: "Update not found." }, 404);
        const { error } = await admin.from("pm_updates")
          .update({ body, edited_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        if (u.feedback_comment_id) {
          const { error: cErr } = await admin.from("feedback_comments")
            .update({ body }).eq("id", u.feedback_comment_id);
          if (cErr) throw cErr;
        }
        return json({ ok: true });
      }

      case "delete_update": {
        const id = str(payload.id, 40);
        const { data: u } = await admin.from("pm_updates").select("*").eq("id", id).maybeSingle();
        if (!u) return json({ ok: true });
        // Take the FILES with the note. Without this every deleted note left its uploads
        // in the bucket forever, unreferenced and unreachable — a private bucket quietly
        // filling with screenshots nobody can see or remove.
        const paths = (Array.isArray(u.attachments) ? u.attachments : [])
          .map((a: { path?: string }) => str(a?.path, 300)).filter(Boolean);
        if (paths.length) {
          const { error: sErr } = await admin.storage.from("pm-attachments").remove(paths);
          // A storage failure must not strand the row: the note is what the person asked
          // to delete, and an orphan file is recoverable where a stuck note is confusing.
          if (sErr) console.error("attachment cleanup failed for update", id, sErr.message);
        }
        if (u.feedback_comment_id) {
          const { error: cErr } = await admin.from("feedback_comments").delete().eq("id", u.feedback_comment_id);
          if (cErr) throw cErr;
        }
        const { error } = await admin.from("pm_updates").delete().eq("id", id);
        if (error) throw error;
        const item = await getItem(u.item_id).catch(() => null);
        await act(item?.board_id || null, u.item_id, "delete_update", { wasPublished: !!u.feedback_comment_id });
        return json({ ok: true });
      }

      case "upload_attachment": {
        // Returns a one-time signed UPLOAD url; the browser PUTs the bytes, then sends
        // attach_meta to record it on the update. Path shape: pm/{item}/{uuid}-{name}.
        const item = await getItem(payload.itemId);
        const name = str(payload.name, 120).replace(/[^\w.\- ]+/g, "_") || "file";
        const path = `pm/${item.id}/${crypto.randomUUID().slice(0, 8)}-${name}`;
        const { data, error } = await admin.storage.from("pm-attachments").createSignedUploadUrl(path);
        if (error) throw error;
        return json({ path, token: data?.token, signedUrl: data?.signedUrl });
      }

      case "attach_meta": {
        const id = str(payload.updateId, 40);
        const { data: u } = await admin.from("pm_updates").select("*").eq("id", id).maybeSingle();
        if (!u) return json({ error: "Update not found." }, 404);
        const meta = {
          path: str(payload.path, 300),
          name: str(payload.name, 120),
          size: Number(payload.size) || 0,
          mime: str(payload.mime, 80),
        };
        if (!meta.path.startsWith(`pm/${u.item_id}/`)) return json({ error: "Path does not belong to this item." }, 400);
        const attachments = [...(Array.isArray(u.attachments) ? u.attachments : []), meta].slice(0, 10);
        const { error } = await admin.from("pm_updates").update({ attachments }).eq("id", id);
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action "${action}".` }, 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "Item not found.") return json({ error: msg }, 404);
    throw e;  // withErrorLog records it in app_errors
  }
}));
