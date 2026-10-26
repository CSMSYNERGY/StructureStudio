// Execute migration 293 (one canonical status list on bugs, features and working) for real in
// PGlite (Postgres compiled to WASM, in memory) on the pm_* tables as migration 144/146 created
// them, seeded in the LIVE shape the 2026-10-09 pre-read found (R1 labels, R2 values in use, R3
// facets), and check what it promises:
//   PART 1  the three status columns are found by slug + first position; an unknown label id, item
//           value or facet value aborts the whole file with nothing written;
//   PART 3  item values (archived included) are rewritten through the map, NULL / JSON null /
//           absent stay as they are, saved-view facets are rewritten (string and array shapes,
//           "__none" untouched), the labels become the canonical list; a backup table with RLS on
//           and no browser grants holds every changed row;
//   PART 4  the three lists are identical, one intake each, per-board not-done counts unchanged,
//           and assertion mutants really abort;
//   and the roadmap board and feedback_submissions are untouched, a re-apply changes nothing, and
//   the rollback written in the file's header restores the pre-apply state exactly.
//
// Boards, columns, items, views and submissions are made up. The repo is public: no real id here.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration293.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/293_pm_canonical_statuses.sql"), "utf8").replace(/\r/g, "");

// The pm_* tables as 144 + 146 created them (the columns this file reads and writes, with their
// real types and defaults), and feedback_submissions cut to what a linked item points at. The
// default privileges stand in for Supabase's: a new public table is granted to anon and
// authenticated unless the migration revokes it, so the revoke below is really tested.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
alter default privileges in schema public grant all on tables to anon, authenticated;
create table public.feedback_submissions (
  id uuid primary key, client_id text, status text not null,
  status_changed_at timestamptz, updated_at timestamptz not null default now()
);
create table public.pm_boards (
  id uuid primary key default gen_random_uuid(), slug text not null unique, name text not null,
  position double precision not null default 1024, settings jsonb not null default '{}',
  archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.pm_columns (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.pm_boards(id) on delete cascade,
  type text not null check (type in ('status','text','long_text','number','date','people','dropdown','checkbox','link')),
  name text not null, settings jsonb not null default '{}', position double precision not null default 1024,
  width integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.pm_groups (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.pm_boards(id) on delete cascade,
  name text not null, color text, position double precision not null default 1024, created_at timestamptz not null default now()
);
create table public.pm_items (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.pm_boards(id) on delete cascade,
  group_id uuid not null references public.pm_groups(id),
  name text not null, values jsonb not null default '{}', position double precision not null default 1024,
  feedback_submission_id uuid unique references public.feedback_submissions(id) on delete set null,
  monday_item_id text, created_by uuid, created_by_email text, archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.pm_views (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.pm_boards(id) on delete cascade,
  name text not null, snap jsonb not null default '{}', position double precision not null default 1024,
  created_by uuid, created_by_email text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
`;

// Made-up ids. B* boards, C* columns, G* groups, I* items, V* views, F* submissions.
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const B = { bugs: id(1), features: id(2), working: id(3), roadmap: id(4) };
const C = { bugs: id(11), bugs2: id(12), features: id(13), working: id(14), roadmap: id(15), bugsPrio: id(16) };
const G = { bugs: id(21), features: id(22), working: id(23), roadmap: id(24) };
const L = (labelId, label, extra = {}) => ({ id: labelId, label, color: "#64748B", ...extra });

// R1, as live: Bugs 7, Features 5, Working To Do/Doing/Blocked + the twelve (no client_status there).
const BUG_LABELS = [
  L("l_awaiting", "Awaiting Review", { client_status: "in_review", intake: true }),
  L("l_readydev", "Ready for Dev", { client_status: "planned" }),
  L("l_knownbug", "Known Bug", { client_status: "in_review" }),
  L("l_fixing", "Fixing", { client_status: "in_progress" }),
  L("l_pendeploy", "Pending Deploy", { client_status: "in_progress" }),
  L("l_fixed", "Fixed", { client_status: "shipped", kind: "done" }),
  L("l_missinfo", "Missing Info", { client_status: "needs_info" }),
];
const FEATURE_LABELS = [
  L("l_new", "New", { client_status: "submitted", intake: true }),
  L("l_review", "Under Review", { client_status: "in_review" }),
  L("l_planned", "Planned", { client_status: "planned" }),
  L("l_done", "Completed", { client_status: "shipped", kind: "done" }),
  L("l_declined", "Declined", { client_status: "declined", kind: "done" }),
];
const WORKING_LABELS = [
  L("l_todo", "To Do", { intake: true }), L("l_doing", "Doing", { kind: "working" }), L("l_blocked", "Blocked", { kind: "stuck" }),
  L("l_awaiting", "Awaiting Review"), L("l_readydev", "Ready for Dev"), L("l_knownbug", "Known Bug"), L("l_fixing", "Fixing"),
  L("l_pendeploy", "Pending Deploy"), L("l_missinfo", "Missing Info"), L("l_new", "New"), L("l_review", "Under Review"),
  L("l_planned", "Planned"), L("l_fixed", "Fixed", { kind: "done" }), L("l_done", "Completed", { kind: "done" }),
  L("l_declined", "Declined", { kind: "done" }),
];
const ROADMAP_LABELS = [L("l_idea", "Idea"), L("l_planned", "Planned"), L("l_building", "Building"), L("l_shipped", "Shipped", { kind: "done" })];
// A SECOND status column on bugs, later by position: statusColumnOf never reads it, so 293 must not.
const BUGS2_LABELS = [L("l_fixing", "Triage: fixing"), L("l_custom", "Custom")];

const CANON_IDS = ["l_new", "l_review", "l_missinfo", "l_planned", "l_inprogress", "l_onbeta", "l_done", "l_declined", "l_dup"];
const CANON = [
  { id: "l_new", label: "New", color: "#F59E0B", client_status: "submitted", intake: true },
  { id: "l_review", label: "Under Review", color: "#8B5CF6", client_status: "in_review" },
  { id: "l_missinfo", label: "Missing Info", color: "#F97316", kind: "stuck", client_status: "needs_info" },
  { id: "l_planned", label: "Planned", color: "#6366F1", client_status: "planned" },
  { id: "l_inprogress", label: "In Progress", color: "#2563EB", kind: "working", client_status: "in_progress" },
  { id: "l_onbeta", label: "On Beta", color: "#0891B2", kind: "working", client_status: "in_progress" },
  { id: "l_done", label: "Done", color: "#0E9F6E", kind: "done", client_status: "shipped" },
  { id: "l_declined", label: "Declined", color: "#94A3B8", kind: "done", client_status: "declined" },
  { id: "l_dup", label: "Duplicate", color: "#64748B", kind: "done", client_status: "duplicate" },
];
const MAP = {
  l_awaiting: "l_new", l_todo: "l_new", l_readydev: "l_planned", l_sprints: "l_planned", l_knownbug: "l_review",
  l_fixing: "l_inprogress", l_doing: "l_inprogress", l_pendeploy: "l_onbeta", l_fixed: "l_done", l_blocked: "l_missinfo",
};
for (const c of CANON_IDS) MAP[c] = c;

// R2's shape: every (board, value, archived) combination live has, plus the edge cases the file
// promises to leave alone (absent key, JSON null, SQL-NULL-ish archived row, the second column).
// [itemNo, board, statusValue | undefined (absent) | null (JSON null), archived, linkedSubmissionNo]
const ITEMS = [
  [101, "bugs", "l_awaiting", false, 501], [102, "bugs", "l_awaiting", false, 502], [103, "bugs", "l_awaiting", true, null],
  [104, "bugs", "l_fixed", false, 503], [105, "bugs", "l_fixed", false, null], [106, "bugs", "l_fixing", false, null],
  [107, "bugs", "l_fixing", true, null], [108, "bugs", "l_knownbug", false, null], [109, "bugs", "l_knownbug", true, null],
  [110, "bugs", "l_missinfo", false, null], [111, "bugs", "l_missinfo", true, null], [112, "bugs", "l_readydev", false, 504],
  [113, "bugs", "l_readydev", true, null], [114, "bugs", null, true, null], [115, "bugs", undefined, false, null],
  [116, "bugs", "l_pendeploy", false, null],
  [201, "features", "l_declined", false, 505], [202, "features", "l_done", false, 506], [203, "features", "l_done", false, null],
  [204, "features", "l_new", false, 507], [205, "features", "l_new", true, null], [206, "features", "l_planned", false, 508],
  [207, "features", "l_planned", true, null], [208, "features", "l_review", false, 509], [209, "features", "l_review", false, null],
  [301, "working", "l_todo", false, null], [302, "working", "l_todo", false, null],
  [401, "roadmap", "l_planned", false, null], [402, "roadmap", "l_shipped", false, null],
];
const SUBS = { 501: "in_review", 502: "submitted", 503: "shipped", 504: "in_review", 505: "declined", 506: "shipped", 507: "submitted", 508: "planned", 509: "in_review" };

function seedSql({ bugLabels = BUG_LABELS, items = ITEMS, views = null, dropWorking = false } = {}) {
  const j = (x) => `'${JSON.stringify(x).replace(/'/g, "''")}'::jsonb`;
  const out = [];
  out.push(`insert into public.feedback_submissions (id, client_id, status, updated_at) values ${Object.entries(SUBS)
    .map(([n, s]) => `('${id(n)}', 'acme-sheds', '${s}', '2026-09-01 10:00+00')`).join(", ")};`);
  const boards = dropWorking ? ["bugs", "features", "roadmap"] : ["bugs", "features", "working", "roadmap"];
  out.push(`insert into public.pm_boards (id, slug, name) values ${boards.map((b) => `('${B[b]}', '${b}', '${b}')`).join(", ")};`);
  out.push(`insert into public.pm_groups (id, board_id, name) values ${boards.map((b) => `('${G[b]}', '${B[b]}', 'Incoming')`).join(", ")};`);
  const cols = [
    [C.bugs, "bugs", "status", "Status", { labels: bugLabels, note: "kept" }, 1024],
    [C.bugsPrio, "bugs", "dropdown", "Priority", { options: [{ id: "o_high", label: "High", color: "#B45309" }], multi: false }, 2048],
    [C.bugs2, "bugs", "status", "Triage", { labels: BUGS2_LABELS }, 9000],
    [C.features, "features", "status", "Status", { labels: FEATURE_LABELS }, 1024],
    [C.working, "working", "status", "Status", { labels: WORKING_LABELS }, 1024],
    [C.roadmap, "roadmap", "status", "Status", { labels: ROADMAP_LABELS }, 1024],
  ].filter((c) => boards.includes(c[1]));
  out.push(`insert into public.pm_columns (id, board_id, type, name, settings, position, updated_at) values ${cols
    .map(([cid, b, t, n, s, p]) => `('${cid}', '${B[b]}', '${t}', '${n}', ${j(s)}, ${p}, '2026-09-01 10:00+00')`).join(", ")};`);
  const its = items.filter((it) => boards.includes(it[1])).map(([n, b, v, arch, sub]) => {
    const values = { [`${C[b]}`]: v };
    if (v === undefined) delete values[C[b]];
    if (b === "bugs") { values[C.bugsPrio] = ["o_high"]; values[C.bugs2] = "l_fixing"; }
    return `('${id(n)}', '${B[b]}', '${G[b]}', 'Item ${n}', ${j(values)}, ${arch ? "'2026-09-05 10:00+00'" : "null"}, ${sub ? `'${id(sub)}'` : "null"}, '2026-09-01 10:00+00')`;
  });
  out.push(`insert into public.pm_items (id, board_id, group_id, name, values, archived_at, feedback_submission_id, updated_at) values ${its.join(", ")};`);
  const vs = views || [
    [601, "bugs", "Ready", { q: "", facets: { [C.bugs]: "l_readydev" }, groupBy: "groups" }],
    [602, "bugs", "AWAITING", { q: "x", facets: { [C.bugs]: "l_awaiting", [C.bugsPrio]: "o_high" }, sortKey: "name" }],
    [603, "bugs", "Both", { facets: { [C.bugs]: ["l_fixing", "__none", "l_pendeploy"] } }],
    [604, "bugs", "Unset", { facets: { [C.bugs]: "__none" } }],
    [605, "bugs", "Triage", { facets: { [C.bugs2]: "l_fixing" } }],
    [606, "features", "Review", { facets: { [C.features]: "l_review" } }],
    [607, "roadmap", "Planned", { facets: { [C.roadmap]: "l_planned" } }],
    [608, "features", "No facets", { q: "side nav" }],
  ];
  out.push(`insert into public.pm_views (id, board_id, name, snap, updated_at) values ${vs
    .filter((v) => boards.includes(v[1]))
    .map(([n, b, name, snap]) => `('${id(n)}', '${B[b]}', '${name}', ${j(snap)}, '2026-09-01 10:00+00')`).join(", ")};`);
  return out.join("\n");
}

// jsonb stores keys in its own order, so compare JSON values with their keys sorted.
const norm = (x) => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
async function fresh(opts) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(seedSql(opts));
  return db;
}
const snap = async (db, table) => JSON.stringify(await rows(db, `select * from public.${table} order by 1`));
const everything = async (db) => {
  const out = {};
  for (const t of ["pm_boards", "pm_columns", "pm_groups", "pm_items", "pm_views", "feedback_submissions"]) out[t] = await snap(db, t);
  out.backup = (await one(db, "select to_regclass('public.pm_status_backup_293') t")).t;
  return JSON.stringify(out);
};
const labelsOf = async (db, col) => (await one(db, "select settings from public.pm_columns where id = $1", [col])).settings.labels;
const valueOf = async (db, item, col) => {
  const r = await one(db, "select values from public.pm_items where id = $1", [id(item)]);
  return Object.prototype.hasOwnProperty.call(r.values, col) ? r.values[col] : "<absent>";
};
const facetOf = async (db, view, col) => (await one(db, "select snap from public.pm_views where id = $1", [id(view)])).snap.facets[col];
// Not-done per (board, archived), computed HERE from each board's own labels — independent of the
// SQL under test, by the same rule as _shared/pmOverlay.ts doneLabelIds/isItemDone.
async function notDone(db) {
  const cols = { bugs: C.bugs, features: C.features, working: C.working };
  const out = {};
  for (const [slug, col] of Object.entries(cols)) {
    const done = new Set((await labelsOf(db, col)).filter((l) => l.kind === "done").map((l) => l.id));
    for (const it of await rows(db, "select values, archived_at from public.pm_items where board_id = $1", [B[slug]])) {
      const k = `${slug}${it.archived_at ? " archived" : ""}`;
      const v = it.values[col];
      out[k] = (out[k] || 0) + (typeof v === "string" && done.has(v) ? 0 : 1);
    }
  }
  return JSON.stringify(out);
}
async function applyExpectingAbort(db, sql, re, label) {
  const before = await everything(db);
  let err = null;
  try { await db.exec(sql); } catch (e) { err = e; }
  ok(!!err && re.test(err.message), label, err ? err.message : "applied without error");
  try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
  ok(await everything(db) === before, `${label}: nothing was written (no backup table, every row as it was)`);
}

(async () => {
  console.log("migration 293: applies on the live shape");
  {
    const db = await fresh();
    const before = await everything(db);
    const notDoneBefore = await notDone(db);
    const roadmapBefore = JSON.stringify(await rows(db, "select * from public.pm_columns where board_id = $1 order by id", [B.roadmap]))
      + JSON.stringify(await rows(db, "select * from public.pm_items where board_id = $1 order by id", [B.roadmap]))
      + JSON.stringify(await rows(db, "select * from public.pm_views where board_id = $1 order by id", [B.roadmap]));
    const subsBefore = await snap(db, "feedback_submissions");
    const itemsBefore = await rows(db, "select id, updated_at from public.pm_items order by id");
    const notices = [];
    let applied = true;
    try { await db.exec(MIG(), { onNotice: (n) => notices.push(n.message) }); } catch (e) { applied = false; ok(false, "293 applied", e.message); }
    ok(applied, "293 applied, its assertions included");

    // The lists
    for (const slug of ["bugs", "features", "working"]) {
      const labels = await labelsOf(db, C[slug]);
      ok(JSON.stringify(labels.map((l) => l.id)) === JSON.stringify(CANON_IDS), `${slug}: the nine canonical ids, in order`, JSON.stringify(labels.map((l) => l.id)));
      const sorted = (o) => JSON.stringify(Object.entries(o).sort());
      ok(labels.length === CANON.length && labels.every((l, i) => sorted(l) === sorted(CANON[i])),
        `${slug}: every label exactly as listed (label, colour, kind, client_status, intake)`);
      ok(labels.filter((l) => l.intake === true).length === 1 && labels.find((l) => l.intake === true).id === "l_new", `${slug}: exactly one intake, l_new`);
    }
    const bugsSettings = (await one(db, "select settings from public.pm_columns where id = $1", [C.bugs])).settings;
    ok(bugsSettings.note === "kept", "other keys of the column's settings are kept");
    ok(norm(await labelsOf(db, C.bugs2)) === norm(BUGS2_LABELS), "a board's SECOND status column is not touched (statusColumnOf reads the first)");

    // Item values
    let mapped = true;
    for (const [n, b, v] of ITEMS) {
      if (b === "roadmap") continue;
      const got = await valueOf(db, n, C[b]);
      const want = v === undefined ? "<absent>" : v === null ? null : MAP[v];
      if (got !== want) { mapped = false; ok(false, `item ${n} on ${b}: ${v} -> ${want}`, String(got)); }
    }
    ok(mapped, "every item value is mapped (archived included); JSON null stays null and an absent key stays absent");
    ok(await valueOf(db, 103, C.bugs) === "l_new" && await valueOf(db, 107, C.bugs) === "l_inprogress", "archived items are rewritten too");
    ok(await valueOf(db, 116, C.bugs) === "l_onbeta", "Pending Deploy becomes On Beta");
    ok(await valueOf(db, 101, C.bugs2) === "l_fixing" && JSON.stringify(await valueOf(db, 101, C.bugsPrio)) === '["o_high"]',
      "other keys in values (the second status column, Priority) are untouched");
    const itemsAfter = await rows(db, "select id, updated_at from public.pm_items order by id");
    ok(JSON.stringify(itemsAfter) === JSON.stringify(itemsBefore), "no item's updated_at is bumped");
    ok(await notDone(db) === notDoneBefore, "per-board not-done counts (live and archived apart) are unchanged", `${notDoneBefore} -> ${await notDone(db)}`);

    // Views
    ok(await facetOf(db, 601, C.bugs) === "l_planned", "string facet: Ready (l_readydev) -> l_planned");
    ok(await facetOf(db, 602, C.bugs) === "l_new" && await facetOf(db, 602, C.bugsPrio) === "o_high", "string facet: AWAITING -> l_new; its Priority facet untouched");
    ok(JSON.stringify(await facetOf(db, 603, C.bugs)) === '["l_inprogress","__none","l_onbeta"]', "array facet mapped element by element, order kept, \"__none\" kept");
    ok(await facetOf(db, 604, C.bugs) === "__none", "a \"__none\" facet is left alone");
    ok(await facetOf(db, 605, C.bugs2) === "l_fixing", "a facet on the second status column is left alone");
    ok(await facetOf(db, 606, C.features) === "l_review", "a facet already canonical is unchanged");
    const v602 = (await one(db, "select snap from public.pm_views where id = $1", [id(602)])).snap;
    ok(v602.q === "x" && v602.sortKey === "name", "the rest of a view's snap is kept");

    // Untouched
    const roadmapAfter = JSON.stringify(await rows(db, "select * from public.pm_columns where board_id = $1 order by id", [B.roadmap]))
      + JSON.stringify(await rows(db, "select * from public.pm_items where board_id = $1 order by id", [B.roadmap]))
      + JSON.stringify(await rows(db, "select * from public.pm_views where board_id = $1 order by id", [B.roadmap]));
    ok(roadmapAfter === roadmapBefore, "the roadmap board (columns, items, views) is byte-for-byte untouched");
    ok(await snap(db, "feedback_submissions") === subsBefore, "feedback_submissions is byte-for-byte untouched");
    ok(notices.some((m) => /^293: 2 linked item\(s\) now sit on a label with a different client_status/.test(m)),
      "a NOTICE counts the linked items whose label's client_status changed (the two linked Awaiting Review bugs)", notices.join(" | "));

    // Backup
    const bk = await one(db, `select relrowsecurity r, has_table_privilege('anon', 'public.pm_status_backup_293', 'SELECT') a,
      has_table_privilege('authenticated', 'public.pm_status_backup_293', 'SELECT') u from pg_class where oid = 'public.pm_status_backup_293'::regclass`);
    ok(bk.r === true && bk.a === false && bk.u === false, "the backup table has RLS on and no anon/authenticated access", JSON.stringify(bk));
    const counts = Object.fromEntries((await rows(db, "select kind, count(*)::int n from public.pm_status_backup_293 group by 1")).map((r) => [r.kind, r.n]));
    const changedItems = ITEMS.filter(([, b, v]) => b !== "roadmap" && typeof v === "string" && MAP[v] !== v).length;
    ok(counts.column === 3 && counts.item === changedItems && counts.view === 3, `the backup holds exactly the changed rows (3 columns, ${changedItems} items, 3 views)`, JSON.stringify(counts));
    const bCol = await one(db, "select before from public.pm_status_backup_293 where kind = 'column' and row_id = $1", [C.bugs]);
    ok(norm(bCol.before.labels) === norm(BUG_LABELS), "the column backup is the whole old settings");

    // ── Re-apply: a no-op ──
    const afterFirst = await everything(db);
    const backupFirst = await snap(db, "pm_status_backup_293");
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply", e.message); }
    ok(again && await everything(db) === afterFirst && await snap(db, "pm_status_backup_293") === backupFirst,
      "a re-apply passes and changes nothing (rows, column updated_at and the backup included)");

    // ── Rollback as the header writes it ──
    const header = MIG().split("\n");
    const rb = [];
    let on = false;
    for (const line of header) {
      if (/^-- ── ROLLBACK/.test(line)) { on = true; continue; }
      if (on && /^--   begin;$/.test(line)) rb.push("begin;");
      else if (on && rb.length && /^--   (update|  from|  set|commit;)/.test(line)) rb.push(line.replace(/^--   /, ""));
      if (on && /^--   commit;$/.test(line)) break;
    }
    ok(rb.length >= 8 && rb[0] === "begin;" && rb[rb.length - 1] === "commit;", "the rollback is lifted from the file's own header", rb.join(" / "));
    await db.exec(rb.join("\n"));
    await db.exec("drop table public.pm_status_backup_293;");
    const restored = JSON.parse(await everything(db));
    const orig = JSON.parse(before);
    // pm_columns.updated_at moved on the apply and is not part of the backup: compare without it.
    const noUpd = (s) => JSON.stringify(JSON.parse(s).map(({ updated_at: _u, ...r }) => r));
    ok(noUpd(restored.pm_columns) === noUpd(orig.pm_columns), "rollback: every column's settings are what they were");
    ok(restored.pm_items === orig.pm_items && restored.pm_views === orig.pm_views && restored.feedback_submissions === orig.feedback_submissions && restored.backup === null,
      "rollback: every item value and view facet is what it was, byte for byte");
    await db.close();
  }

  console.log("migration 293: refuses what the map does not know, with nothing written");
  {
    const db = await fresh({ bugLabels: [...BUG_LABELS, L("l_wontfix", "Won't Fix", { kind: "done" })] });
    await applyExpectingAbort(db, MIG(), /^293: unknown status label id\(s\) bugs:l_wontfix/, "an unknown live label id aborts the apply");
    await db.close();
  }
  {
    const db = await fresh({ items: [...ITEMS, [117, "bugs", "l_mystery", true, null]] });
    await applyExpectingAbort(db, MIG(), /^293: unknown item status value\(s\) bugs:l_mystery/, "an unknown item value (on an ARCHIVED item) aborts the apply");
    await db.close();
  }
  {
    const db = await fresh();
    await db.exec(`update public.pm_items set values = jsonb_set(values, '{${C.features}}', '7') where id = '${id(209)}'`);
    await applyExpectingAbort(db, MIG(), /^293: unknown item status value\(s\) features:<number>/, "a non-string item value aborts the apply");
    await db.close();
  }
  {
    const db = await fresh({ views: [[601, "bugs", "Odd", { facets: { [C.bugs]: ["l_fixing", "l_gone"] } }]] });
    await applyExpectingAbort(db, MIG(), /^293: unknown saved-view status facet\(s\) bugs:l_gone/, "an unknown facet value inside an array aborts the apply");
    await db.close();
  }
  {
    const db = await fresh({ dropWorking: true });
    await applyExpectingAbort(db, MIG(), /^293: expected one status column on each of bugs, features and working, found 2/, "a missing board aborts the apply");
    await db.close();
  }
  {
    const db = await fresh();
    await db.exec(`insert into public.pm_columns (board_id, type, name, settings, position) values ('${B.features}', 'status', 'Twin', '{"labels":[]}', 1024)`);
    await applyExpectingAbort(db, MIG(), /^293: two status columns share the first position on features/, "two status columns at the first position abort the apply");
    await db.close();
  }

  console.log("migration 293: the PART 4 assertions really abort (mutants)");
  {
    // A map that sends a done label to a not-done one moves rows onto Ongoing Projects.
    const m = MIG().replace("('l_fixed',      'l_done')", "('l_fixed',      'l_review')");
    ok(m !== MIG(), "the not-done mutant really changed the map");
    const db = await fresh();
    await applyExpectingAbort(db, m, /^293: the not-done count changed on bugs/, "a map that un-finishes Fixed items stops the apply");
    await db.close();
  }
  {
    const m = MIG().replace('{"id":"l_review","label":"Under Review","color":"#8B5CF6","client_status":"in_review"}',
      '{"id":"l_review","label":"Under Review","color":"#8B5CF6","client_status":"in_review","intake":true}');
    ok(m !== MIG(), "the intake mutant really added a second intake");
    const db = await fresh();
    await applyExpectingAbort(db, m, /^293: bugs, features, working does not have exactly one intake label/, "two intake labels stop the apply");
    await db.close();
  }
  {
    // Drop the facet rewrite: the leftover old ids must be caught.
    const m = MIG().replace(/-- Saved views, one at a time[\s\S]*?end \$\$;\n/, "");
    ok(m !== MIG(), "the facet mutant really lost the view rewrite");
    const db = await fresh();
    await applyExpectingAbort(db, m, /^293: 4 saved-view facet value\(s\) are still off the list/, "facets left on old ids stop the apply");
    await db.close();
  }
  {
    // Lose the RLS line: the closing assertion must catch it.
    const m = MIG().replace("alter table public.pm_status_backup_293 enable row level security;\n", "");
    ok(m !== MIG(), "the RLS mutant really lost the enable");
    const db = await fresh();
    await applyExpectingAbort(db, m, /^293: RLS is not enabled on pm_status_backup_293/, "a backup table without RLS stops the apply");
    await db.close();
  }

  console.log("");
  if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
  console.log("ALL CHECKS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
