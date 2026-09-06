import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";

// Portal-facing bug / feature-request intake for portal.html.
//
// PARALLEL-RUN since 2026-08-27: the team is trialling the in-product Projects module
// as Monday's replacement. A submission is written to `feedback_submissions` FIRST (so
// the tenant sees it in "My Submissions" even if everything else is down), then mirrored
// into the internal Projects board (`mirrorToProjects`, best-effort), then pushed into
// the matching Monday board. A failed Monday push is recorded in `monday_error` and the
// row is still returned as submitted; `action:"retry_push"` re-attempts it. The cutover
// switch is the MONDAY_PUSH_DISABLED=1 secret — it stops the Monday leg (no error
// recorded) without a redeploy. See mirrorToProjects' comment for the documented
// trial-period divergence between Monday statuses and Projects statuses.
//
// Auth model: identical to portal-settings. verify_jwt alone is NOT auth (the public
// anon key passes the gateway), so we resolve a real user via auth.getUser() and map
// user → tenant through client_users on the service role. `client_id` and the
// submitter's identity are NEVER read from the request body — that is precisely what
// makes "which client portal was this filed from" trustworthy in the Monday board.
//
// Actions:
//   { action: "submit", kind, title, detail, severity, attachmentPath }
//   { action: "refresh" }      → pull status + /client updates from Monday for this
//                                tenant's open items (safety net for a missed webhook)
//   { action: "retry_push", id } → re-attempt a submission whose Monday push failed
//   { action: "comment", submissionId, body } → the TENANT replies on their own
//                                submission (mirrored into the linked Projects item)
//
// Required secret: MONDAY_API_TOKEN (already set — shared with github-monday-bug).

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

// ── Monday board map ────────────────────────────────────────────────────────
// MIRROR: the board ids, status column ids and STATUS_TO_CLIENT map below are
// duplicated in supabase/functions/feedback-monday-webhook/index.ts. Change both.
const MONDAY_API = "https://api.monday.com/v2";
const MONDAY_FILE_API = "https://api.monday.com/v2/file";
const APP_LABEL = "Structure Studio";

const BOARDS = {
  bug: {
    boardId: "18419456589",           // Bugs Queue
    groupId: "topics",                // "Incoming Bugs"
    colDetail: "long_text_mm5010qc",
    colApp: "color_mm502d43",
    colSeverity: "priority_1",        // Critical / High / Medium / Low
    colStatus: "bug_status",
    colEmail: "email_mm50927t",
    colClient: "text_mm5n4fhh",
    colFile: "file_mm5nrq83",
    initialStatus: "Awaiting Review",
    severities: ["Critical", "High", "Medium", "Low"],
  },
  feature: {
    boardId: "18420525473",           // Feature Requests (Intake)
    groupId: "topics",                // "Incoming responses"
    colDetail: "long_textfv17jsuo",
    colApp: "single_select2287pvk",
    colSeverity: "single_select62w0enl",
    colStatus: "color_mm502bcj",
    colEmail: "emailrurj9slu",
    colClient: "text_mm5ndjqh",
    colFile: "file_mm5njdz2",
    initialStatus: "New",
    severities: ["Nice to have", "Would really help", "Critical for me"],
  },
} as const;

// Monday's raw labels are internal vocabulary ("Move to 'Sprints'", "Known Bug").
// Everything a tenant sees goes through this map first — see migration 054's
// trust-boundary note. An unmapped label leaves the stored status untouched rather
// than inventing one, so a new Monday label can never surface as raw text.
//
// Keyed on Monday's stable label ID, not the label's TEXT: text is editable in the
// Monday UI, and renaming "Shipped" to "Completed" on 2026-07-27 silently stalled the
// sync. IDs are per-board and COLLIDE across the two boards with different meanings
// (id 2 = "Missing Info" on bugs, "Declined" on features), so always look up
// (board, id) — never id alone.
const STATUS_BY_ID: Record<string, Record<number, string>> = {
  // Bugs Queue · bug_status
  "18419456589": {
    9: "in_review",     // Awaiting Review
    14: "planned",      // Ready for Dev
    3: "planned",       // Move to 'Sprints'
    4: "in_review",     // Known Bug
    0: "in_progress",   // Fixing
    7: "in_progress",   // Pending Deploy
    1: "shipped",       // Fixed
    2: "needs_info",    // Missing Info
    8: "duplicate",     // Duplicated
    // id 5 is the blank label — intentionally unmapped.
  },
  // Feature Requests (Intake) · color_mm502bcj
  "18420525473": {
    7: "submitted",     // New
    9: "in_review",     // Under Review
    10: "planned",      // Planned
    1: "shipped",       // Completed (was "Shipped" until 2026-07-27)
    2: "declined",      // Declined
  },
};

// Fallback for a payload carrying text but no id, and the lookup used by
// statusAfterPush (which works from our own initialStatus constant, not from Monday).
const STATUS_BY_TEXT: Record<string, string> = {
  "Awaiting Review": "in_review",
  "Ready for Dev": "planned",
  "Move to 'Sprints'": "planned",
  "Known Bug": "in_review",
  "Fixing": "in_progress",
  "Pending Deploy": "in_progress",
  "Fixed": "shipped",
  "Missing Info": "needs_info",
  "Duplicated": "duplicate",
  "New": "submitted",
  "Under Review": "in_review",
  "Planned": "planned",
  "Shipped": "shipped",
  "Completed": "shipped",
  "Declined": "declined",
};

function toClientStatus(boardId: string, labelId: unknown, labelText: unknown): string | undefined {
  const byId = STATUS_BY_ID[String(boardId)];
  const id = typeof labelId === "number" ? labelId : (labelId != null && labelId !== "" ? Number(labelId) : NaN);
  if (byId && Number.isFinite(id) && byId[id] !== undefined) return byId[id];
  if (typeof labelText === "string" && STATUS_BY_TEXT[labelText]) return STATUS_BY_TEXT[labelText];
  if (labelText || Number.isFinite(id)) {
    console.error(`UNMAPPED Monday status on board ${boardId}: id=${String(labelId)} text=${JSON.stringify(labelText)} — add it to STATUS_BY_ID in BOTH edge functions`);
  }
  return undefined;
}

// `refresh` is a READ the tenant triggers, so it may only ever carry a status change
// FORWARD. During the parallel run, Projects (portal-projects) writes the client-facing
// status without touching Monday, so Monday's label is legitimately stale for those
// items — re-applying it would walk the tenant's own submission backwards once per
// "Check for updates" click, indefinitely, with no way for them to stop it.
//
// Monday's status cell value carries its own `changed_at`, and every writer of
// feedback_submissions.status (webhook, this function, portal-projects' propagateStatus)
// stamps status_changed_at, so the two timestamps order the writes: only a Monday change
// made AFTER the stored one wins. That keeps the documented last-writer-wins divergence
// intact — a genuine later drag in Monday still lands — while a stale re-read cannot
// overwrite anything. Missing either timestamp (a row from before status_changed_at was
// stamped, or a cell Monday returns without one) falls back to applying it, which is what
// keeps this a safety net for a webhook that never arrived.
function mondayChangeIsNewer(mondayChangedAt: unknown, storedChangedAt: unknown): boolean {
  if (typeof mondayChangedAt !== "string" || typeof storedChangedAt !== "string") return true;
  const m = Date.parse(mondayChangedAt);
  const s = Date.parse(storedChangedAt);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return true;
  return m > s;
}

// A Monday update reaches the tenant ONLY when the team prefixes it with /client.
// Everything else stays internal and is never stored on our side at all.
const CLIENT_MARKER = /^\s*\/client\b[:\s-]*/i;

async function mondayQuery(token: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token, "API-Version": "2024-01" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error("Monday API error: " + JSON.stringify(body.errors));
  return body.data;
}

// Monday file uploads are a separate multipart endpoint (/v2/file), not the JSON API.
// Non-fatal by design: the ticket is worth more than the screenshot, so a failure here
// is logged and swallowed rather than losing the whole submission.
async function attachFile(
  token: string, itemId: string, columnId: string, blob: Blob, filename: string,
): Promise<boolean> {
  try {
    const form = new FormData();
    form.append(
      "query",
      `mutation ($file: File!) { add_file_to_column (item_id: ${itemId}, column_id: "${columnId}", file: $file) { id } }`,
    );
    form.append("variables[file]", blob, filename);
    const res = await fetch(MONDAY_FILE_API, {
      method: "POST",
      headers: { "Authorization": token },
      body: form,
    });
    const body = await res.json();
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return true;
  } catch (e) {
    console.error("attachFile failed for item", itemId, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// The client-facing status a row should hold immediately after a successful push.
// Derived from the board's OWN initial label rather than hardcoded, so the two boards
// stay consistent with what the first sync will report: a bug opens at "Awaiting
// Review" (→ in_review) but a feature opens at "New" (→ submitted). Hardcoding one
// value made feature requests display "In review" and then appear to move BACKWARDS
// to "Submitted" the first time the webhook or reconcile ran.
function statusAfterPush(kind: "bug" | "feature"): string {
  return STATUS_BY_TEXT[BOARDS[kind].initialStatus] ?? "submitted";
}

// ── Parallel-run mirror into the internal Projects boards (2026-08-27) ────────
// While the team trials the in-product Projects module (pm_* tables, migration 144,
// portal-projects fn), every new submission ALSO becomes a pm_item on the matching
// board, linked 1:1 through feedback_submission_id. Fully best-effort: a Projects
// failure must never fail the tenant's submission (same posture as the Monday push).
//
// Divergence during the trial, documented deliberately: the Monday webhook keeps
// updating ONLY the tenant mirror (feedback_submissions); it never touches pm_items.
// A status dragged in Monday therefore updates what the tenant sees but not the
// Projects board, and a later Projects status change overwrites the mirror — last
// writer wins. Last WRITER: `refresh` is a tenant-triggered read and is forward-only
// (mondayChangeIsNewer), so re-reading a stale Monday label is not a write and can
// never undo the Projects side. The team works in Projects; cutover
// (MONDAY_PUSH_DISABLED=1, then stripping the Monday code) ends the divergence.
// deno-lint-ignore no-explicit-any
async function mirrorToProjects(admin: any, row: any): Promise<void> {
  try {
    const { data: board } = await admin.from("pm_boards").select("id")
      .eq("slug", row.kind === "feature" ? "features" : "bugs").maybeSingle();
    if (!board) return;
    const { data: exists } = await admin.from("pm_items").select("id, monday_item_id")
      .eq("feedback_submission_id", row.id).maybeSingle();
    if (exists) {
      // Second call for the same submission (retry_push, or the post-push pass):
      // just backfill the Monday id so the import script can dedupe on it.
      if (row.monday_item_id && !exists.monday_item_id) {
        await admin.from("pm_items").update({ monday_item_id: row.monday_item_id }).eq("id", exists.id);
      }
      return;
    }
    // The board's INTAKE group (migration 150), not "whichever sits first" — the Monday
    // import left two similarly-named intake groups per board, so first-by-position sent
    // submissions to a group nobody was triaging.
    const { data: groups } = await admin.from("pm_groups").select("id, intake")
      .eq("board_id", board.id).order("position");
    const group = (groups || []).find((g: { intake: boolean }) => g.intake) || (groups || [])[0];
    if (!group) return;
    const { data: cols } = await admin.from("pm_columns").select("*").eq("board_id", board.id);
    const values: Record<string, unknown> = {};
    for (const c of cols || []) {
      // Lookups by column NAME and label `intake`/text — never by uuid (seed ids are
      // per-environment) and never by editable label ids from this side.
      if (c.type === "status") {
        const labels = c.settings?.labels || [];
        // deno-lint-ignore no-explicit-any
        const intake = labels.find((l: any) => l.intake === true) || labels[0];
        if (intake) values[c.id] = intake.id;
      } else if (c.type === "text" && c.name === "Client") {
        values[c.id] = row.client_id;
      } else if (c.type === "date" && c.name === "Date") {
        values[c.id] = new Date().toISOString().slice(0, 10);
      } else if (c.type === "dropdown" && c.name === "Priority" && row.severity) {
        // deno-lint-ignore no-explicit-any
        const opt = (c.settings?.options || []).find((o: any) => o.label === row.severity);
        if (opt) values[c.id] = [opt.id];
      }
    }
    const { data: maxRow } = await admin.from("pm_items").select("position")
      .eq("group_id", group.id).order("position", { ascending: false }).limit(1).maybeSingle();
    await admin.from("pm_items").insert({
      board_id: board.id, group_id: group.id,
      name: String(row.title || "").slice(0, 200), values,
      position: (maxRow?.position || 0) + 1024,
      feedback_submission_id: row.id,
      monday_item_id: row.monday_item_id || null,
      created_by: row.submitted_by || null, created_by_email: row.submitter_email || null,
    });
  } catch (e) {
    console.error("Projects mirror failed for submission", row.id, e instanceof Error ? e.message : String(e));
  }
}

// Creates the Monday item for an already-persisted submission row and returns its id.
async function pushToMonday(admin: any, token: string, row: any, businessName: string): Promise<string> {
  const cfg = BOARDS[row.kind as keyof typeof BOARDS];

  const detailBlock = [
    (row.detail || "").trim() || "(no description provided)",
    "",
    "---",
    `Filed from the Structure Studio portal`,
    `Client: ${businessName} (${row.client_id})`,
    `Submitted by: ${row.submitter_name}${row.submitter_email ? ` <${row.submitter_email}>` : ""}`,
    `Portal ref: ${row.id}`,
  ].join("\n");

  const cols: Record<string, unknown> = {
    [cfg.colDetail]: { text: detailBlock },
    [cfg.colApp]: { label: APP_LABEL },
    [cfg.colStatus]: { label: cfg.initialStatus },
    [cfg.colClient]: row.client_id,
  };
  if (row.submitter_email) cols[cfg.colEmail] = { email: row.submitter_email, text: row.submitter_email };
  // Only send a severity Monday actually knows — an unknown label errors the whole mutation.
  if (row.severity && (cfg.severities as readonly string[]).includes(row.severity)) {
    cols[cfg.colSeverity] = { label: row.severity };
  }

  const mutation = `mutation ($board: ID!, $group: String!, $name: String!, $cols: JSON!) {
    create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $cols) { id }
  }`;
  const data = await mondayQuery(token, mutation, {
    board: cfg.boardId,
    group: cfg.groupId,
    name: String(row.title).slice(0, 250),
    cols: JSON.stringify(cols),
  });
  const itemId = data?.create_item?.id;
  if (!itemId) throw new Error("Monday returned no item id");

  if (row.attachment_path) {
    const dl = await admin.storage.from("feedback-attachments").download(row.attachment_path);
    if (dl.data) {
      await attachFile(token, itemId, cfg.colFile, dl.data, row.attachment_path.split("/").pop() || "attachment");
    } else {
      console.error("attachment download failed:", row.attachment_path, dl.error?.message);
    }
  }
  return String(itemId);
}

Deno.serve(withErrorLog("portal-feedback", async (req: Request) => {
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
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = Deno.env.get("MONDAY_API_TOKEN");

  // 1. Real user check (the bare anon key passes the gateway but has no user).
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not signed in." }, 401);

  // 2. Resolve the caller's tenant — never from the body.
  //    limit(1) not maybeSingle(): maybeSingle() ERRORS when a duplicate client_users row
  //    exists, which would lock the user out entirely. portal.html already guards this
  //    the same way (its "audit #F6" comment), as does _shared/resolveTenant.ts.
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: mapRows, error: mapErr } = await admin
    .from("client_users").select("client_id, role").eq("user_id", user.id).limit(1);
  if (mapErr) return json({ error: mapErr.message }, 500);
  const mapping = mapRows && mapRows[0];
  if (!mapping) return json({ error: "No business is linked to this account." }, 403);
  const clientId: string = mapping.client_id;

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body → invalid action below */ }
  const action = body?.action;

  // ── submit ────────────────────────────────────────────────────────────────
  if (action === "submit") {
    const kind = body.kind === "feature" ? "feature" : body.kind === "bug" ? "bug" : null;
    if (!kind) return json({ error: "kind must be 'bug' or 'feature'." }, 400);
    const title = String(body.title ?? "").trim();
    if (!title) return json({ error: "Please give this a short title." }, 400);
    const detail = String(body.detail ?? "").trim();
    const severity = body.severity ? String(body.severity) : null;

    // An attachment must live under this tenant's own prefix — the storage policy
    // enforces it on write, and this re-checks it before we hand the path to Monday.
    let attachmentPath: string | null = body.attachmentPath ? String(body.attachmentPath) : null;
    if (attachmentPath && !attachmentPath.startsWith(clientId + "/")) {
      return json({ error: "Attachment does not belong to this account." }, 403);
    }

    const meta = user.user_metadata || {};
    const submitterName = String(
      body.submitterName || meta.full_name || meta.name || (user.email || "").split("@")[0] || "Unknown",
    ).slice(0, 120);

    const ins = await admin.from("feedback_submissions").insert({
      client_id: clientId,
      submitted_by: user.id,
      submitter_name: submitterName,
      submitter_email: user.email ?? null,
      kind, title: title.slice(0, 250), detail: detail || null,
      severity, attachment_path: attachmentPath,
      status: "submitted",
      monday_board_id: BOARDS[kind].boardId,
    }).select().single();
    if (ins.error) return json({ error: ins.error.message }, 500);
    const row = ins.data;

    // Mirror into the internal Projects board FIRST (best-effort, never throws) —
    // before the Monday push, so an unexpected push crash cannot lose the pm_item.
    await mirrorToProjects(admin, row);

    // Cutover switch: MONDAY_PUSH_DISABLED=1 stops the Monday leg without a redeploy.
    // Deliberately NOT an error state — no monday_error is recorded — because the
    // submission's real home (mirror row + Projects item) is already written.
    if (Deno.env.get("MONDAY_PUSH_DISABLED") === "1") {
      return json({ ok: true, submission: row, pushed: false });
    }

    if (!token) {
      await admin.from("feedback_submissions")
        .update({ monday_error: "MONDAY_API_TOKEN not configured" }).eq("id", row.id);
      return json({ ok: true, submission: row, pushed: false });
    }

    const { data: settings } = await admin
      .from("client_settings").select("business_name").eq("client_id", clientId).maybeSingle();
    const businessName = settings?.business_name || clientId;

    try {
      const itemId = await pushToMonday(admin, token, row, businessName);
      const upd = await admin.from("feedback_submissions")
        .update({ monday_item_id: itemId, monday_error: null, status: statusAfterPush(kind), updated_at: new Date().toISOString() })
        .eq("id", row.id).select().single();
      await mirrorToProjects(admin, { ...row, monday_item_id: itemId });  // backfill the Monday id
      return json({ ok: true, submission: upd.data ?? row, pushed: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Monday push failed for submission", row.id, msg);
      await admin.from("feedback_submissions").update({ monday_error: msg }).eq("id", row.id);
      // Still a success for the tenant: their submission is recorded and visible.
      return json({ ok: true, submission: row, pushed: false });
    }
  }

  // ── retry_push ────────────────────────────────────────────────────────────
  if (action === "retry_push") {
    const { data: row } = await admin.from("feedback_submissions")
      .select("*").eq("id", String(body.id ?? "")).eq("client_id", clientId).maybeSingle();
    if (!row) return json({ error: "Submission not found." }, 404);
    await mirrorToProjects(admin, row);  // a failed first push may also have raced the mirror
    if (Deno.env.get("MONDAY_PUSH_DISABLED") === "1") {
      return json({ ok: true, submission: row, pushed: false });
    }
    if (!token) return json({ error: "Monday is not configured." }, 500);
    if (row.monday_item_id) return json({ ok: true, submission: row, pushed: true });
    const { data: settings } = await admin
      .from("client_settings").select("business_name").eq("client_id", clientId).maybeSingle();
    try {
      const itemId = await pushToMonday(admin, token, row, settings?.business_name || clientId);
      const upd = await admin.from("feedback_submissions")
        .update({ monday_item_id: itemId, monday_error: null, status: statusAfterPush(row.kind), updated_at: new Date().toISOString() })
        .eq("id", row.id).select().single();
      await mirrorToProjects(admin, { ...row, monday_item_id: itemId });  // backfill the Monday id
      return json({ ok: true, submission: upd.data, pushed: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("feedback_submissions").update({ monday_error: msg }).eq("id", row.id);
      return json({ ok: false, error: msg }, 502);
    }
  }

  // ── comment ───────────────────────────────────────────────────────────────
  // The tenant REPLIES on their own submission (Carolyn 2026-08-28: builders should see
  // their submissions in real flow "and actually be able to comment back"). This is the
  // first tenant-authored write into the feedback thread, so three things are load-bearing:
  //
  //   1. The submission is re-read scoped to the caller's OWN clientId. Identity and
  //      tenant never come from the body, exactly as in `submit`.
  //   2. monday_update_id stays NULL. Every Monday reconcile path (this function's
  //      `refresh`, and sync_all in feedback-monday-webhook) deletes comments only by
  //      `.eq("monday_update_id", …)`, so a NULL-keyed row survives them all. A reply
  //      pushed to Monday would also boomerang back as a duplicate.
  //   3. The reply is COPIED into the linked Projects item as a client-authored update,
  //      so the team reads it where they work — best-effort, because a Projects failure
  //      must never lose the customer's words.
  if (action === "comment") {
    const submissionId = String(body.submissionId ?? "").slice(0, 40);
    const text = String(body.body ?? "").trim().slice(0, 4000);
    if (!text) return json({ error: "Write something first." }, 400);

    const { data: row } = await admin.from("feedback_submissions")
      .select("id, client_id, title")
      .eq("id", submissionId).eq("client_id", clientId).maybeSingle();
    if (!row) return json({ error: "Submission not found." }, 404);

    const meta = user.user_metadata || {};
    const authorName = String(
      meta.full_name || meta.name || (user.email || "").split("@")[0] || "Builder",
    ).slice(0, 120);

    const ins = await admin.from("feedback_comments").insert({
      submission_id: row.id,
      monday_update_id: null,
      author_kind: "client",
      author_name: authorName,
      author_user_id: user.id,
      body: text,
    }).select().single();
    if (ins.error) return json({ error: ins.error.message }, 500);

    // Mirror into the Projects thread for whoever is triaging it.
    try {
      const { data: item } = await admin.from("pm_items")
        .select("id, board_id").eq("feedback_submission_id", row.id).maybeSingle();
      if (item) {
        await admin.from("pm_updates").insert({
          item_id: item.id,
          author_kind: "client",
          author_email: user.email ?? null,
          body: text,
          client_visible: true,            // it came FROM the client; they can already see it
          feedback_comment_id: ins.data.id,
          monday_update_id: null,
          attachments: [],
        });
        await admin.from("pm_activity").insert({
          board_id: item.board_id, item_id: item.id,
          actor_email: user.email ?? authorName,
          action: "client_reply", detail: { client_id: clientId },
        });
      }
    } catch (e) {
      console.error("client reply mirror failed for submission", row.id, e instanceof Error ? e.message : String(e));
    }

    // Surfaces "Last update" in My Submissions without touching status — a reply is not
    // a state change, and only the team moves the ladder.
    await admin.from("feedback_submissions")
      .update({ updated_at: new Date().toISOString() }).eq("id", row.id);

    return json({ ok: true, comment: ins.data });
  }

  // ── refresh ───────────────────────────────────────────────────────────────
  // Safety net for a webhook that never arrived: re-read status + /client updates
  // for this tenant's not-yet-closed items. Bounded to 40 items per call.
  if (action === "refresh") {
    if (!token) return json({ ok: true, refreshed: 0 });
    const { data: rows } = await admin.from("feedback_submissions")
      .select("id, monday_item_id, status, status_changed_at")
      .eq("client_id", clientId)
      .not("monday_item_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(40);
    // deno-lint-ignore no-explicit-any
    const ids = (rows ?? []).map((r: any) => r.monday_item_id);
    if (!ids.length) return json({ ok: true, refreshed: 0 });

    // deno-lint-ignore no-explicit-any
    const byItem = new Map((rows ?? []).map((r: any) => [String(r.monday_item_id), r]));
    // board { id } + value.index: label ids collide across boards, and `text` is only
    // a display name the team can rename out from under us.
    const q = `query ($ids: [ID!]) {
      items (ids: $ids) {
        id
        board { id }
        column_values { id text value }
        updates (limit: 50) { id text_body created_at creator { name } }
      }
    }`;
    // deno-lint-ignore no-explicit-any
    let items: any[] = [];
    try {
      const data = await mondayQuery(token, q, { ids });
      items = data?.items ?? [];
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }

    let refreshed = 0;
    for (const it of items) {
      const row = byItem.get(String(it.id));
      if (!row) continue;
      const itemBoard = String(it.board?.id ?? "");
      const statusCell = (it.column_values ?? []).find(
        // deno-lint-ignore no-explicit-any
        (c: any) => c.id === BOARDS.bug.colStatus || c.id === BOARDS.feature.colStatus,
      );
      let cellIndex: unknown = null;
      // `changed_at` rides in the same status cell value as `index` — it is what makes
      // this refresh forward-only instead of authoritative (see mondayChangeIsNewer).
      let cellChangedAt: unknown = null;
      try {
        const parsed = statusCell?.value ? JSON.parse(statusCell.value) : null;
        cellIndex = parsed?.index ?? null;
        cellChangedAt = parsed?.changed_at ?? null;
      } catch { /* text fallback */ }
      const mapped = statusCell ? toClientStatus(itemBoard, cellIndex, statusCell.text) : undefined;
      if (mapped && mapped !== row.status && mondayChangeIsNewer(cellChangedAt, row.status_changed_at)) {
        await admin.from("feedback_submissions").update({
          status: mapped,
          status_changed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", row.id);
        refreshed++;
      }
      // Authoritative, not append-only — see the matching block in
      // feedback-monday-webhook/index.ts (sync_all), which this mirrors. ignoreDuplicates:true
      // meant an EDITED body never re-synced, and `continue` on an unmarked update meant removing
      // the /client prefix to unpublish changed nothing, so the first stored version of a comment
      // was immutable and un-retractable in the tenant's My Submissions. Marked → overwrite;
      // unmarked → remove. Deleting on unmark preserves the safety property: internal chatter is
      // still never STORED, this only removes rows.
      for (const u of it.updates ?? []) {
        const text: string = u.text_body ?? "";
        if (!CLIENT_MARKER.test(text)) {
          await admin.from("feedback_comments").delete().eq("monday_update_id", String(u.id));
          continue;
        }
        await admin.from("feedback_comments").upsert({
          submission_id: row.id,
          monday_update_id: String(u.id),
          author_name: u.creator?.name ?? "Structure Studio",
          body: text.replace(CLIENT_MARKER, "").trim(),
          created_at: u.created_at ?? new Date().toISOString(),
        }, { onConflict: "monday_update_id" });
      }
    }
    return json({ ok: true, refreshed });
  }

  return json({ error: "Unknown action." }, 400);
}));
