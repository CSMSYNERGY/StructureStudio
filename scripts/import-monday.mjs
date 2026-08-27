#!/usr/bin/env node
// One-time Monday.com → Projects import (plan phase 4 of the Monday replacement).
//
// Pulls the Bugs Queue and Feature Requests boards (items, groups, column values,
// updates, file assets) plus the merge-report history from the Projects (Repos) board,
// and loads them into the pm_* tables (migration 144). IDEMPOTENT: items upsert on
// pm_items.monday_item_id and updates on pm_updates.monday_update_id, so re-running
// after a partial failure is safe and imports nothing twice. Also safe alongside the
// parallel-run mirror in portal-feedback: a submission that already produced a pm_item
// carries the same monday_item_id and is updated in place, never duplicated.
//
// Usage (PowerShell):
//   $env:MONDAY_API_TOKEN="…"; $env:SUPABASE_URL="https://jzeamjbhdrsbygdnphbm.supabase.co";
//   $env:SUPABASE_SERVICE_ROLE_KEY="…"
//   node scripts/import-monday.mjs --dry-run     # mapping report only — review this first
//   node scripts/import-monday.mjs               # the real import
//   node scripts/import-monday.mjs --skip-assets # everything except file downloads
//
// Mapping rules (never invent, always report what didn't match):
//   * Monday group      → pm_group by exact name on the target board (created if missing).
//   * Status label      → seeded status label by LABEL TEXT ("Awaiting Review" → l_awaiting…).
//                         Unmatched labels are reported and left unset — the item still
//                         imports; fix the label in Board settings and re-run.
//   * People            → app_operators by email. Unmatched people are reported and noted
//                         in the item's Notes value rather than silently dropped.
//   * Severity/priority → Priority dropdown option by label text.
//   * Item              → pm_item; feedback_submission_id resolved via
//                         feedback_submissions.monday_item_id (portal-sourced items);
//                         team-filed / GitHub-funnelled items simply have no link.
//   * Update            → pm_update. /client-marked → client_visible=true and
//                         feedback_comment_id resolved via feedback_comments.monday_update_id
//                         (the copy ALREADY exists tenant-side — never re-copied). Unmarked
//                         updates import as internal — safe: pm_* tables are tenant-unreadable.
//   * Assets            → downloaded with the Monday token and uploaded to the private
//                         pm-attachments bucket at pm/<item_id>/<asset_id>-<name>.
//   * Projects (Repos)  → ONLY item 12385631316's updates, as the history of one item
//                         "Beta→main merge reports" (Roadmap board, "Ops" group). Its uuid is
//                         printed at the end — set it as the PM_MERGE_ITEM_ID repo variable
//                         for the merge workflow's new reporting leg (plan phase 6).

const MONDAY_API = "https://api.monday.com/v2";
const BOARDS = [
  { mondayId: "18419456589", slug: "bugs", statusCol: "bug_status", severityCol: "priority_1", clientCol: "text_mm5n4fhh" },
  { mondayId: "18420525473", slug: "features", statusCol: "color_mm502bcj", severityCol: "single_select62w0enl", clientCol: "text_mm5ndjqh" },
];
const REPO_REPORT_ITEM = "12385631316";
const CLIENT_MARKER = /^\s*\/client\b[:\s-]*/i;

const DRY = process.argv.includes("--dry-run");
const SKIP_ASSETS = process.argv.includes("--skip-assets");
const TOKEN = process.env.MONDAY_API_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!TOKEN || !SB_URL || !SB_KEY) {
  console.error("Set MONDAY_API_TOKEN, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

const report = { boards: {}, unmatchedStatus: new Map(), unmatchedPeople: new Map(), linked: 0, unlinked: 0, updates: 0, clientUpdates: 0, assets: 0, assetFailures: [] };

async function monday(query, variables = {}) {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: TOKEN, "API-Version": "2024-01" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error("Monday API error: " + JSON.stringify(body.errors));
  return body.data;
}

// Minimal PostgREST helpers (service role) — no client library needed.
async function pg(method, path, body, headers = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation", ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const pgGet = (path) => pg("GET", path);

async function uploadAsset(path, bytes, mime) {
  const res = await fetch(`${SB_URL}/storage/v1/object/pm-attachments/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": mime || "application/octet-stream", "x-upsert": "true" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`upload ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function fetchBoardItems(boardId) {
  const items = [];
  let cursor = null;
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
              assets { id name public_url file_size file_extension }
            }
          }
        }
      }
    }`;
    const data = await monday(q, { board: [boardId], cursor });
    const page = data?.boards?.[0]?.items_page;
    items.push(...(page?.items || []));
    cursor = page?.cursor || null;
  } while (cursor);
  return items;
}

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

async function main() {
  console.log(DRY ? "── DRY RUN — nothing is written ──" : "── IMPORT ──");

  // Local lookups, loaded once.
  const pmBoards = await pgGet("pm_boards?select=*");
  const operators = await pgGet("app_operators?select=user_id,email");
  const opByEmail = new Map(operators.map((o) => [String(o.email || "").toLowerCase(), o.user_id]));
  const subs = await pgGet("feedback_submissions?select=id,monday_item_id&monday_item_id=not.is.null");
  const subByMonday = new Map(subs.map((s) => [String(s.monday_item_id), s.id]));
  const comments = await pgGet("feedback_comments?select=id,monday_update_id&monday_update_id=not.is.null");
  const commentByMonday = new Map(comments.map((c) => [String(c.monday_update_id), c.id]));

  for (const cfg of BOARDS) {
    const board = pmBoards.find((b) => b.slug === cfg.slug);
    if (!board) { console.error(`pm_board slug "${cfg.slug}" not found — run migration 144 first.`); process.exit(1); }
    const columns = await pgGet(`pm_columns?select=*&board_id=eq.${board.id}`);
    const groups = await pgGet(`pm_groups?select=*&board_id=eq.${board.id}&order=position`);
    const statusCol = columns.find((c) => c.type === "status");
    const peopleCol = columns.find((c) => c.type === "people");
    const priorityCol = columns.find((c) => c.type === "dropdown" && c.name === "Priority");
    const clientCol = columns.find((c) => c.type === "text" && c.name === "Client");
    const dateCol = columns.find((c) => c.type === "date");
    const notesCol = columns.find((c) => c.type === "long_text");
    const labelByText = new Map((statusCol?.settings?.labels || []).map((l) => [l.label.toLowerCase(), l.id]));
    const optByText = new Map((priorityCol?.settings?.options || []).map((o) => [o.label.toLowerCase(), o.id]));

    const items = await fetchBoardItems(cfg.mondayId);
    const stat = { total: items.length, created: 0, updated: 0, groupsCreated: 0 };
    report.boards[cfg.slug] = stat;
    console.log(`\n${cfg.slug}: ${items.length} Monday items`);

    // Groups by title (create missing ones after the seeds).
    const groupByTitle = new Map(groups.map((g) => [g.name.toLowerCase(), g]));
    let nextGroupPos = Math.max(0, ...groups.map((g) => g.position)) + 1024;
    for (const it of items) {
      const title = (it.group?.title || "Imported").trim();
      if (!groupByTitle.has(title.toLowerCase())) {
        stat.groupsCreated++;
        if (DRY) { groupByTitle.set(title.toLowerCase(), { id: `dry-${title}`, name: title }); }
        else {
          const [g] = await pg("POST", "pm_groups", { board_id: board.id, name: title, color: "#64748B", position: nextGroupPos });
          nextGroupPos += 1024;
          groupByTitle.set(title.toLowerCase(), g);
        }
      }
    }

    let pos = 1024;
    for (const it of items) {
      const values = {};
      const notes = [];
      for (const cv of it.column_values || []) {
        if (cv.id === cfg.statusCol && statusCol) {
          if (cv.text) {
            const lid = labelByText.get(cv.text.toLowerCase());
            if (lid) values[statusCol.id] = lid;
            else bump(report.unmatchedStatus, `${cfg.slug}: "${cv.text}"`);
          }
        } else if (cv.id === cfg.severityCol && priorityCol && cv.text) {
          const oid = optByText.get(cv.text.toLowerCase());
          if (oid) values[priorityCol.id] = [oid];
        } else if (cv.id === cfg.clientCol && clientCol && cv.text) {
          values[clientCol.id] = cv.text;
        } else if (cv.type === "people" && peopleCol && cv.value) {
          try {
            const ids = (JSON.parse(cv.value)?.personsAndTeams || []).map((p) => p.id);
            if (ids.length) {
              // Resolve Monday person ids → emails in one lookup per board run.
              const users = await monday(`query ($ids: [ID!]) { users (ids: $ids) { id email } }`, { ids });
              const emails = (users?.users || []).map((u) => String(u.email || "").toLowerCase());
              const matched = emails.map((e) => opByEmail.get(e)).filter(Boolean);
              if (matched.length) values[peopleCol.id] = matched;
              emails.filter((e) => !opByEmail.get(e)).forEach((e) => { bump(report.unmatchedPeople, e); notes.push(`Monday assignee: ${e}`); });
            }
          } catch { /* unparsable people value — skip */ }
        } else if (cv.type === "date" && dateCol && cv.text && !values[dateCol.id]) {
          const iso = cv.text.slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) values[dateCol.id] = iso;
        }
      }
      if (!values[dateCol?.id] && dateCol && it.created_at) values[dateCol.id] = String(it.created_at).slice(0, 10);
      if (notes.length && notesCol) values[notesCol.id] = notes.join("\n");

      const subId = subByMonday.get(String(it.id)) || null;
      if (subId) report.linked++; else report.unlinked++;
      const group = groupByTitle.get((it.group?.title || "Imported").trim().toLowerCase());

      let itemRow = null;
      if (!DRY) {
        const existing = await pgGet(`pm_items?select=id&monday_item_id=eq.${it.id}`);
        if (existing.length) {
          stat.updated++;
          [itemRow] = await pg("PATCH", `pm_items?id=eq.${existing[0].id}`, { name: it.name.slice(0, 200), values, feedback_submission_id: subId });
        } else {
          stat.created++;
          [itemRow] = await pg("POST", "pm_items", {
            board_id: board.id, group_id: group.id, name: it.name.slice(0, 200), values,
            position: pos, feedback_submission_id: subId, monday_item_id: String(it.id),
            created_at: it.created_at || undefined,
          });
        }
      } else { stat.created++; }
      pos += 1024;

      for (const u of it.updates || []) {
        report.updates++;
        const isClient = CLIENT_MARKER.test(u.text_body || "");
        if (isClient) report.clientUpdates++;
        if (DRY || !itemRow) continue;
        const attachments = [];
        if (!SKIP_ASSETS) {
          for (const a of u.assets || []) {
            try {
              // public_url is a pre-SIGNED S3 URL — an Authorization header breaks the
              // signature (S3 answers 400). Fetch it bare.
              const dl = await fetch(a.public_url);
              if (!dl.ok) throw new Error(`download ${dl.status}`);
              const bytes = Buffer.from(await dl.arrayBuffer());
              const safeName = String(a.name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 100);
              const path = `pm/${itemRow.id}/${a.id}-${safeName}`;
              await uploadAsset(path, bytes, null);
              attachments.push({ path, name: safeName, size: Number(a.file_size) || bytes.length, mime: "" });
              report.assets++;
            } catch (e) {
              report.assetFailures.push(`item ${it.id} asset ${a.id}: ${e.message}`);
            }
          }
        }
        await pg("POST", "pm_updates?on_conflict=monday_update_id", {
          item_id: itemRow.id,
          author_email: u.creator?.email || null,
          body: String(u.text_body || "").trim() || "(empty update)",
          client_visible: isClient,
          feedback_comment_id: isClient ? (commentByMonday.get(String(u.id)) || null) : null,
          monday_update_id: String(u.id),
          attachments,
          created_at: u.created_at || undefined,
        }, { Prefer: "resolution=merge-duplicates,return=representation" });
      }
    }
  }

  // ── Projects (Repos): the merge-report history only ──────────────────────────
  const road = pmBoards.find((b) => b.slug === "roadmap");
  if (road) {
    const opsGroups = await pgGet(`pm_groups?select=*&board_id=eq.${road.id}&name=eq.Ops`);
    const ops = opsGroups[0] || (await pgGet(`pm_groups?select=*&board_id=eq.${road.id}&order=position`))[0];
    const data = await monday(`query ($ids: [ID!]) { items (ids: $ids) {
      id name updates (limit: 100) { id text_body created_at creator { email } } } }`, { ids: [REPO_REPORT_ITEM] });
    const repoItem = data?.items?.[0];
    if (repoItem) {
      console.log(`\nProjects (Repos): ${repoItem.updates.length} merge reports on "${repoItem.name}"`);
      if (!DRY) {
        let [mergeItem] = await pgGet(`pm_items?select=id&board_id=eq.${road.id}&name=eq.${encodeURIComponent("Beta→main merge reports")}`);
        if (!mergeItem) {
          [mergeItem] = await pg("POST", "pm_items", {
            board_id: road.id, group_id: ops.id, name: "Beta→main merge reports",
            values: {}, position: 999999, monday_item_id: String(repoItem.id),
          });
        }
        for (const u of repoItem.updates || []) {
          await pg("POST", "pm_updates?on_conflict=monday_update_id", {
            item_id: mergeItem.id, author_email: u.creator?.email || null,
            body: String(u.text_body || "").trim() || "(empty)",
            client_visible: false, monday_update_id: String(u.id),
            attachments: [], created_at: u.created_at || undefined,
          }, { Prefer: "resolution=merge-duplicates,return=representation" });
        }
        console.log(`PM_MERGE_ITEM_ID (set as a GitHub repo variable for the workflow leg): ${mergeItem.id}`);
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────────
  console.log("\n══ REPORT ══");
  for (const [slug, s] of Object.entries(report.boards)) {
    console.log(`${slug}: ${s.total} items → ${s.created} created, ${s.updated} updated, ${s.groupsCreated} groups added`);
  }
  console.log(`Linked to portal submissions: ${report.linked} · team-filed/no link: ${report.unlinked}`);
  console.log(`Updates: ${report.updates} (${report.clientUpdates} were /client-published — reusing existing tenant copies)`);
  if (!DRY) console.log(`Assets uploaded: ${report.assets}${report.assetFailures.length ? ` · FAILED: ${report.assetFailures.length}` : ""}`);
  report.assetFailures.forEach((f) => console.log("  asset failure:", f));
  if (report.unmatchedStatus.size) {
    console.log("UNMATCHED STATUS LABELS (item imported, status left unset — fix the label and re-run):");
    for (const [k, n] of report.unmatchedStatus) console.log(`  ${k} ×${n}`);
  }
  if (report.unmatchedPeople.size) {
    console.log("UNMATCHED PEOPLE (noted in item Notes; add them to app_operators and re-run to assign):");
    for (const [k, n] of report.unmatchedPeople) console.log(`  ${k} ×${n}`);
  }
  console.log(DRY ? "\nDry run complete — nothing was written." : "\nImport complete.");
}

main().catch((e) => { console.error("IMPORT FAILED:", e.message); process.exit(1); });
