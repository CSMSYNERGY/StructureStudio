import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";

// TEMPORARY one-time Monday.com → Projects import (plan phase 4), as an edge function so
// MONDAY_API_TOKEN stays server-side. Same mapping rules as scripts/import-monday.mjs
// (the runnable-from-a-laptop twin); operator-gated like portal-projects, writes need
// can_write. DELETE THIS DEPLOYMENT after the import — it is not a product surface.
//
// Actions: { action: "dry_run" }               → mapping report, zero writes
//          { action: "import", skipAssets? }   → the real import (idempotent)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const MONDAY_API = "https://api.monday.com/v2";
const BOARDS = [
  { mondayId: "18419456589", slug: "bugs", statusCol: "bug_status", severityCol: "priority_1", clientCol: "text_mm5n4fhh" },
  { mondayId: "18420525473", slug: "features", statusCol: "color_mm502bcj", severityCol: "single_select62w0enl", clientCol: "text_mm5ndjqh" },
];
const REPO_REPORT_ITEM = "12385631316";
const CLIENT_MARKER = /^\s*\/client\b[:\s-]*/i;

async function monday(token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2024-01" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error("Monday API error: " + JSON.stringify(body.errors));
  return body.data;
}

// deno-lint-ignore no-explicit-any
async function fetchBoardItems(token: string, boardId: string): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const items: any[] = [];
  let cursor: string | null = null;
  do {
    const q = `query ($board: [ID!], $cursor: String) {
      boards (ids: $board) {
        items_page (limit: 50, cursor: $cursor) {
          cursor
          items {
            id name created_at
            group { id title }
            column_values { id type text value }
            updates (limit: 100) {
              id text_body created_at
              creator { email name }
              assets { id name public_url file_size }
            }
          }
        }
      }
    }`;
    const data = await monday(token, q, { board: [boardId], cursor });
    const page = data?.boards?.[0]?.items_page;
    items.push(...(page?.items || []));
    cursor = page?.cursor || null;
  } while (cursor);
  return items;
}

Deno.serve(withErrorLog("admin-import-monday", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = Deno.env.get("MONDAY_API_TOKEN");
  if (!token) return json({ error: "MONDAY_API_TOKEN is not configured." }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not signed in." }, 401);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: op } = await admin.from("app_operators")
    .select("user_id, email, can_write").eq("user_id", user.id).maybeSingle();
  if (!op) return json({ error: "Operator access required." }, 403);
  if (!op.can_write) return json({ error: "This operator account is read-only." }, 403);

  // deno-lint-ignore no-explicit-any
  let payload: any = {};
  try { payload = await req.json(); } catch { /* default */ }
  const action = String(payload?.action || "");
  const dry = action === "dry_run";
  if (!dry && action !== "import") return json({ error: `Unknown action "${action}".` }, 400);
  const skipAssets = payload?.skipAssets === true;

  // deno-lint-ignore no-explicit-any
  const report: any = {
    dryRun: dry, boards: {}, unmatchedStatus: {}, unmatchedPeople: {},
    linked: 0, unlinked: 0, updates: 0, clientUpdates: 0, assets: 0, assetFailures: [],
    mergeItemId: null,
  };

  const { data: pmBoards } = await admin.from("pm_boards").select("*");
  const { data: operators } = await admin.from("app_operators").select("user_id, email");
  const opByEmail = new Map((operators || []).map((o) => [String(o.email || "").toLowerCase(), o.user_id]));
  const { data: subs } = await admin.from("feedback_submissions").select("id, monday_item_id").not("monday_item_id", "is", null);
  const subByMonday = new Map((subs || []).map((s) => [String(s.monday_item_id), s.id]));
  const { data: comments } = await admin.from("feedback_comments").select("id, monday_update_id").not("monday_update_id", "is", null);
  const commentByMonday = new Map((comments || []).map((c) => [String(c.monday_update_id), c.id]));

  for (const cfg of BOARDS) {
    const board = (pmBoards || []).find((b) => b.slug === cfg.slug);
    if (!board) return json({ error: `pm_board slug "${cfg.slug}" missing — apply migration 144.` }, 500);
    const { data: columns } = await admin.from("pm_columns").select("*").eq("board_id", board.id);
    const { data: groups } = await admin.from("pm_groups").select("*").eq("board_id", board.id).order("position");
    const statusCol = (columns || []).find((c) => c.type === "status");
    const peopleCol = (columns || []).find((c) => c.type === "people");
    const priorityCol = (columns || []).find((c) => c.type === "dropdown" && c.name === "Priority");
    const clientCol = (columns || []).find((c) => c.type === "text" && c.name === "Client");
    const dateCol = (columns || []).find((c) => c.type === "date");
    const notesCol = (columns || []).find((c) => c.type === "long_text");
    // deno-lint-ignore no-explicit-any
    const labelByText = new Map((statusCol?.settings?.labels || []).map((l: any) => [String(l.label).toLowerCase(), l.id]));
    // deno-lint-ignore no-explicit-any
    const optByText = new Map((priorityCol?.settings?.options || []).map((o: any) => [String(o.label).toLowerCase(), o.id]));

    const items = await fetchBoardItems(token, cfg.mondayId);
    const stat = { total: items.length, created: 0, updated: 0, groupsCreated: 0 };
    report.boards[cfg.slug] = stat;

    const groupByTitle = new Map((groups || []).map((g) => [g.name.toLowerCase(), g]));
    let nextGroupPos = Math.max(0, ...(groups || []).map((g) => g.position)) + 1024;
    // Monday person-id → email cache (one users() call per distinct id set).
    const personEmail = new Map<string, string>();

    let pos = 1024;
    for (const it of items) {
      const gTitle = (it.group?.title || "Imported").trim();
      if (!groupByTitle.has(gTitle.toLowerCase())) {
        stat.groupsCreated++;
        if (!dry) {
          const { data: g, error } = await admin.from("pm_groups")
            .insert({ board_id: board.id, name: gTitle, color: "#64748B", position: nextGroupPos }).select().single();
          if (error) throw error;
          nextGroupPos += 1024;
          groupByTitle.set(gTitle.toLowerCase(), g);
        } else {
          groupByTitle.set(gTitle.toLowerCase(), { id: null, name: gTitle });
        }
      }

      const values: Record<string, unknown> = {};
      const notes: string[] = [];
      for (const cv of it.column_values || []) {
        if (cv.id === cfg.statusCol && statusCol) {
          if (cv.text) {
            const lid = labelByText.get(cv.text.toLowerCase());
            if (lid) values[statusCol.id] = lid;
            else report.unmatchedStatus[`${cfg.slug}: "${cv.text}"`] = (report.unmatchedStatus[`${cfg.slug}: "${cv.text}"`] || 0) + 1;
          }
        } else if (cv.id === cfg.severityCol && priorityCol && cv.text) {
          const oid = optByText.get(cv.text.toLowerCase());
          if (oid) values[priorityCol.id] = [oid];
        } else if (cv.id === cfg.clientCol && clientCol && cv.text) {
          values[clientCol.id] = cv.text;
        } else if (cv.type === "people" && peopleCol && cv.value) {
          try {
            // deno-lint-ignore no-explicit-any
            const ids: string[] = (JSON.parse(cv.value)?.personsAndTeams || []).map((p: any) => String(p.id));
            const unknown = ids.filter((id) => !personEmail.has(id));
            if (unknown.length) {
              const users = await monday(token, `query ($ids: [ID!]) { users (ids: $ids) { id email } }`, { ids: unknown });
              // deno-lint-ignore no-explicit-any
              (users?.users || []).forEach((u: any) => personEmail.set(String(u.id), String(u.email || "").toLowerCase()));
            }
            const emails = ids.map((id) => personEmail.get(id) || "");
            const matched = emails.map((e) => opByEmail.get(e)).filter(Boolean);
            if (matched.length) values[peopleCol.id] = matched;
            emails.filter((e) => e && !opByEmail.get(e)).forEach((e) => {
              report.unmatchedPeople[e] = (report.unmatchedPeople[e] || 0) + 1;
              notes.push(`Monday assignee: ${e}`);
            });
          } catch { /* unparsable people value */ }
        } else if (cv.type === "date" && dateCol && cv.text && !values[dateCol.id]) {
          const iso = cv.text.slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) values[dateCol.id] = iso;
        }
      }
      if (dateCol && !values[dateCol.id] && it.created_at) values[dateCol.id] = String(it.created_at).slice(0, 10);
      if (notes.length && notesCol) values[notesCol.id] = notes.join("\n");

      const subId = subByMonday.get(String(it.id)) || null;
      if (subId) report.linked++; else report.unlinked++;
      report.updates += (it.updates || []).length;
      report.clientUpdates += (it.updates || []).filter((u: { text_body?: string }) => CLIENT_MARKER.test(u.text_body || "")).length;
      if (dry) { stat.created++; continue; }

      const group = groupByTitle.get(gTitle.toLowerCase())!;
      const { data: existing } = await admin.from("pm_items").select("id").eq("monday_item_id", String(it.id)).maybeSingle();
      // deno-lint-ignore no-explicit-any
      let itemRow: any;
      if (existing) {
        stat.updated++;
        const { data, error } = await admin.from("pm_items")
          .update({ name: String(it.name).slice(0, 200), values, feedback_submission_id: subId, group_id: group.id })
          .eq("id", existing.id).select().single();
        if (error) throw error;
        itemRow = data;
      } else {
        stat.created++;
        const { data, error } = await admin.from("pm_items").insert({
          board_id: board.id, group_id: group.id, name: String(it.name).slice(0, 200), values,
          position: pos, feedback_submission_id: subId, monday_item_id: String(it.id),
          created_at: it.created_at || undefined,
        }).select().single();
        if (error) throw error;
        itemRow = data;
      }
      pos += 1024;

      for (const u of it.updates || []) {
        const isClient = CLIENT_MARKER.test(u.text_body || "");
        // deno-lint-ignore no-explicit-any
        const attachments: any[] = [];
        if (!skipAssets) {
          for (const a of u.assets || []) {
            try {
              // public_url is a pre-SIGNED S3 URL — an Authorization header breaks the
              // signature (S3 answers 400). Fetch it bare.
              const dl = await fetch(a.public_url);
              if (!dl.ok) throw new Error(`download ${dl.status}`);
              const bytes = new Uint8Array(await dl.arrayBuffer());
              const safeName = String(a.name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 100);
              const path = `pm/${itemRow.id}/${a.id}-${safeName}`;
              // The bucket has a mime allowlist and supabase-js defaults uploads to
              // text/plain — infer the real type from the extension or the upload 400s.
              const MIME: Record<string, string> = {
                png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
                webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime",
                webm: "video/webm", pdf: "application/pdf",
              };
              const ext = (safeName.split(".").pop() || "").toLowerCase();
              const contentType = MIME[ext] || dl.headers.get("content-type") || "application/octet-stream";
              const { error } = await admin.storage.from("pm-attachments")
                .upload(path, bytes, { upsert: true, contentType });
              if (error) throw error;
              attachments.push({ path, name: safeName, size: Number(a.file_size) || bytes.length, mime: contentType });
              report.assets++;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              report.assetFailures.push(`item ${it.id} asset ${a.id}: ${msg}`);
              // Detail into app_errors (severity info) — the browser-side DLP filter
              // redacts responses carrying URL-ish strings, so this is the readable copy.
              await logEdgeError({ fn: "admin-import-monday", message: `asset ${a.id} on item ${it.id}: ${msg}`.slice(0, 500), severity: "info", context: { host: (() => { try { return new URL(a.public_url).host; } catch { return null; } })() } });
            }
          }
        }
        const { error } = await admin.from("pm_updates").upsert({
          item_id: itemRow.id,
          author_email: u.creator?.email || null,
          body: String(u.text_body || "").trim() || "(empty update)",
          client_visible: isClient,
          feedback_comment_id: isClient ? (commentByMonday.get(String(u.id)) || null) : null,
          monday_update_id: String(u.id),
          attachments,
          created_at: u.created_at || undefined,
        }, { onConflict: "monday_update_id" });
        if (error) throw error;
      }
    }
  }

  // Projects (Repos): merge-report history → one Roadmap item.
  const road = (pmBoards || []).find((b) => b.slug === "roadmap");
  if (road) {
    const data = await monday(token, `query ($ids: [ID!]) { items (ids: $ids) {
      id name updates (limit: 100) { id text_body created_at creator { email } } } }`, { ids: [REPO_REPORT_ITEM] });
    const repoItem = data?.items?.[0];
    if (repoItem) {
      report.repoReports = (repoItem.updates || []).length;
      if (!dry) {
        const { data: opsGroups } = await admin.from("pm_groups").select("*").eq("board_id", road.id).eq("name", "Ops");
        const ops = opsGroups?.[0] || (await admin.from("pm_groups").select("*").eq("board_id", road.id).order("position").limit(1)).data?.[0];
        let { data: mergeItem } = await admin.from("pm_items").select("id")
          .eq("board_id", road.id).eq("name", "Beta→main merge reports").maybeSingle();
        if (!mergeItem) {
          const { data, error } = await admin.from("pm_items").insert({
            board_id: road.id, group_id: ops.id, name: "Beta→main merge reports",
            values: {}, position: 999999, monday_item_id: String(repoItem.id),
          }).select().single();
          if (error) throw error;
          mergeItem = data;
        }
        if (!mergeItem) throw new Error("Could not create the merge-reports item.");
        for (const u of repoItem.updates || []) {
          const { error } = await admin.from("pm_updates").upsert({
            item_id: mergeItem.id, author_email: u.creator?.email || null,
            body: String(u.text_body || "").trim() || "(empty)",
            client_visible: false, monday_update_id: String(u.id),
            attachments: [], created_at: u.created_at || undefined,
          }, { onConflict: "monday_update_id" });
          if (error) throw error;
        }
        report.mergeItemId = mergeItem.id;
      }
    }
  }

  return json({ ok: true, report });
}));
