// Execute migration 265 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// qbo_item_map, invoice_sends and client_settings' QuickBooks columns as they are live, then check
// what it promises: two nullable text columns; every mapping and every PUSHED invoice of a tenant
// with a QuickBooks company on file stamped with that company (the disconnect tombstone counts);
// a tenant with no company on file (taken over, cleared by hand, never connected) left NULL;
// invoices not yet in QuickBooks left NULL; nothing else on any row touched; a re-apply that
// changes nothing and never overwrites a stamp; the browser roles holding nothing on either
// column; and assertions that really abort the whole apply (mutants). It also pins, in SQL, the
// two facts the code leans on: `<>` (PostgREST's neq) never matches a NULL, so the callback's
// wipe needs its second, IS NULL delete; and `=` (the status count) never counts one either.
// Nothing here touches the live project: no network, no Supabase, no QuickBooks.
//
// Tenants and realm ids are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration265.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/265_qbo_item_map_realm.sql"), "utf8");

// Made-up Intuit-shaped realm ids.
const BOOKS_ACME = "4620000000000000001";
const BOOKS_TOMB = "4620000000000000002";
const BOOKS_OTHER = "4620000000000000009";

// The live shapes on 2026-10-04 (information_schema / pg_constraint / pg_indexes), cut to what 265
// reads and writes. qbo_item_map and invoice_sends are whole: their column lists are the point.
// `extra` lets a mutant add something the assertions must refuse.
const STUBS = (extra = "") => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

-- The live default ACLs: the trap every new table falls into, revoked per table below as live.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;

create table public.building_styles (id uuid primary key default gen_random_uuid(), client_id text not null);

create table public.client_settings (
  client_id text primary key,
  qbo_realm_id text, qbo_company_name text, qbo_connected_at timestamptz, qbo_disconnect_reason text
);
create unique index client_settings_qbo_realm_uniq on public.client_settings (qbo_realm_id) where qbo_realm_id is not null;
alter table public.client_settings enable row level security;
revoke all on public.client_settings from anon, authenticated;

-- 066 + 239's CHECK.
create table public.qbo_item_map (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  line_kind text not null,
  item_key text not null default '',
  style_id uuid references public.building_styles(id) on delete cascade,
  qbo_item_id text not null,
  qbo_item_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qbo_item_map_line_kind_check check (line_kind = any (array['building','paint','roof','door','window','ramp',
    'layout_item','custom_option','discount','delivery','fallback','wall_height','build_on_site','cladding','insulation',
    'electrical','electrical_item','foundation'])),
  constraint qbo_item_map_key_shape check ((line_kind = 'layout_item') = (item_key <> '')),
  constraint qbo_item_map_style_shape check (style_id is null or line_kind = any (array['building','layout_item']))
);
create unique index qbo_item_map_default_uniq on public.qbo_item_map (client_id, line_kind, item_key) where style_id is null;
create unique index qbo_item_map_override_uniq on public.qbo_item_map (client_id, line_kind, item_key, style_id) where style_id is not null;
create index qbo_item_map_client_idx on public.qbo_item_map (client_id);
alter table public.qbo_item_map enable row level security;
revoke all on public.qbo_item_map from anon, authenticated;

-- 052 onward, as live (the acceptance_id FK left out: its table is not part of this).
create table public.invoice_sends (
  client_id text not null, short_code text not null, ghl_estimate_id text, invoice_id text, invoice_number text,
  status text not null default 'claimed', error text, attempts integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  sender_user_id text, sent_by_operator text,
  qbo_invoice_id text, qbo_doc_number text, qbo_pushed_at timestamptz, qbo_error text,
  qbo_attempts integer not null default 0, qbo_tid text,
  invoice_type text not null default 'new_build', issued_by text not null default 'ghl',
  invoice_pdf_url text, signed_at timestamptz, acceptance_id uuid, deposit_cents integer,
  ghl_sender_user_id text, document_at timestamptz,
  primary key (client_id, short_code),
  constraint invoice_sends_status_check check (status = any (array['claimed','created','sent','failed'])),
  constraint invoice_sends_issued_by_check check (issued_by = any (array['ghl','structurestudio'])),
  constraint invoice_sends_type_check check (invoice_type = any (array['new_build','inventory','repair'])),
  constraint invoice_sends_deposit_positive check (deposit_cents is null or deposit_cents > 0)
);
create index invoice_sends_client_status_idx on public.invoice_sends (client_id, status);
alter table public.invoice_sends enable row level security;
revoke all on public.invoice_sends from anon, authenticated;
${extra}
`;

// The data the apply has to live with, one tenant per way a realm can or cannot be on file:
//   acme-sheds         connected to BOOKS_ACME
//   tombstone-builds   disconnected, realm kept as the tombstone (BOOKS_TOMB)
//   displaced-barns    its company was taken over (084): realm NULL, map kept
//   never-connected    no client_settings row at all
const SEED = `
insert into public.building_styles (id, client_id) values ('00000000-0000-4000-8000-0000000000a1', 'acme-sheds');
insert into public.client_settings (client_id, qbo_realm_id, qbo_company_name, qbo_connected_at, qbo_disconnect_reason) values
  ('acme-sheds',       '${BOOKS_ACME}', 'Acme Sheds Books', '2026-08-06 09:55+00', null),
  ('tombstone-builds', '${BOOKS_TOMB}', 'Tombstone Books',  null,                  null),
  ('displaced-barns',  null,            'Displaced Books',  null,                  'That QuickBooks company was connected to a different StructureStudio account.');
insert into public.qbo_item_map (client_id, line_kind, item_key, style_id, qbo_item_id, qbo_item_name, created_at, updated_at) values
  ('acme-sheds',       'building',    '',      null,                                   '11', 'Buildings',      '2026-08-06 10:00+00', '2026-08-06 10:00+00'),
  ('acme-sheds',       'building',    '',      '00000000-0000-4000-8000-0000000000a1', '12', 'Buildings:Barn', '2026-08-06 10:00+00', '2026-08-07 10:00+00'),
  ('acme-sheds',       'layout_item', 'loft',  null,                                   '16', 'Options',        '2026-08-06 10:00+00', '2026-08-06 10:00+00'),
  ('acme-sheds',       'fallback',    '',      null,                                   '16', 'Options',        '2026-08-06 10:00+00', '2026-08-06 10:00+00'),
  ('tombstone-builds', 'fallback',    '',      null,                                   '7',  'Sales',          '2026-08-01 10:00+00', '2026-08-01 10:00+00'),
  ('displaced-barns',  'building',    '',      null,                                   '11', 'Sheds',          '2026-08-01 10:00+00', '2026-08-01 10:00+00'),
  ('displaced-barns',  'fallback',    '',      null,                                   '3',  'Misc',           '2026-08-01 10:00+00', '2026-08-01 10:00+00'),
  ('never-connected',  'fallback',    '',      null,                                   '5',  'Other',          '2026-08-01 10:00+00', '2026-08-01 10:00+00');
insert into public.invoice_sends (client_id, short_code, invoice_number, status, qbo_invoice_id, qbo_doc_number, qbo_pushed_at, qbo_error, qbo_attempts, updated_at) values
  ('acme-sheds',       'SS-AAAAAAAAA1', 'INV-1', 'sent',    '101', 'INV-1', '2026-08-06 11:17+00', null, 1, '2026-08-06 11:17+00'),
  ('acme-sheds',       'SS-AAAAAAAAA2', 'INV-2', 'sent',    '102', 'INV-2', '2026-09-24 12:00+00', 'pushed_with_total_mismatch: QBO $1.00 vs GHL $1.01', 1, '2026-09-24 12:00+00'),
  ('acme-sheds',       'SS-AAAAAAAAA3', 'INV-3', 'sent',    null,  null,    null, 'unmapped: delivery (Delivery) — map these under Settings → QuickBooks, then Retry', 1, '2026-09-25 12:00+00'),
  ('acme-sheds',       'SS-AAAAAAAAA4', null,    'claimed', null,  null,    null, null, 0, '2026-09-26 12:00+00'),
  ('tombstone-builds', 'SS-TTTTTTTTT1', 'T-1',   'sent',    '55',  'T-1',   '2026-08-01 11:00+00', null, 1, '2026-08-01 11:00+00'),
  ('displaced-barns',  'SS-DDDDDDDDD1', 'D-1',   'sent',    '9',   'D-1',   '2026-08-01 11:00+00', null, 1, '2026-08-01 11:00+00');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

// Everything on both tables except the two new columns, so "nothing else was touched" is a
// comparison, not a hope. Ordered so two snapshots line up row for row.
const snapshot = async (db) => JSON.stringify({
  maps: await rows(db, `select client_id, line_kind, item_key, style_id, qbo_item_id, qbo_item_name, created_at, updated_at
                          from public.qbo_item_map order by client_id, line_kind, item_key, style_id nulls first`),
  sends: await rows(db, `select client_id, short_code, invoice_number, status, qbo_invoice_id, qbo_doc_number, qbo_pushed_at,
                                qbo_error, qbo_attempts, updated_at from public.invoice_sends order by client_id, short_code`),
});
const stamps = async (db) => JSON.stringify({
  maps: await rows(db, `select client_id, line_kind, item_key, style_id, realm_id from public.qbo_item_map
                         order by client_id, line_kind, item_key, style_id nulls first`),
  sends: await rows(db, "select client_id, short_code, qbo_realm_id from public.invoice_sends order by client_id, short_code"),
});

async function fresh(extra) {
  const db = new PGlite();
  await db.exec(STUBS(extra));
  await db.exec(SEED);
  return db;
}

(async () => {
  console.log("migration 265: applies on the live shape and stamps what it can");
  {
    const db = await fresh();
    const before = await snapshot(db);
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "265 applied", e.message); }
    ok(applied, "265 applied cleanly, assertions included");

    const cols = await rows(db, `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and ((table_name = 'qbo_item_map' and column_name = 'realm_id')
         or (table_name = 'invoice_sends' and column_name = 'qbo_realm_id')) order by table_name`);
    ok(cols.length === 2 && cols.every((c) => c.data_type === "text" && c.is_nullable === "YES" && c.column_default === null),
      "two nullable text columns, no defaults", JSON.stringify(cols));

    // ── Mapping rows: the tenant's company on file, the tombstone included; nobody else's ──
    const realmOf = async (cid) => (await rows(db, "select distinct realm_id from public.qbo_item_map where client_id = $1", [cid])).map((r) => r.realm_id);
    ok(JSON.stringify(await realmOf("acme-sheds")) === JSON.stringify([BOOKS_ACME]), "every one of a connected tenant's rows (style override and layout item too) names its company");
    ok(JSON.stringify(await realmOf("tombstone-builds")) === JSON.stringify([BOOKS_TOMB]), "a disconnected tenant's rows name the tombstone company, so reconnecting it keeps them");
    ok(JSON.stringify(await realmOf("displaced-barns")) === JSON.stringify([null]), "a taken-over tenant (realm NULL, map kept) stays NULL: nobody can say which company those ids came from");
    ok(JSON.stringify(await realmOf("never-connected")) === JSON.stringify([null]), "a tenant with no settings row stays NULL");

    // ── Invoices: only the ones that reached QuickBooks, and only where the company is known ──
    const send = async (code) => (await one(db, "select qbo_realm_id r from public.invoice_sends where short_code = $1", [code])).r;
    ok(await send("SS-AAAAAAAAA1") === BOOKS_ACME && await send("SS-AAAAAAAAA2") === BOOKS_ACME, "a connected tenant's pushed invoices name its company (a total-mismatch note is still pushed)");
    ok(await send("SS-AAAAAAAAA3") === null, "an invoice that never reached QuickBooks stays NULL: the push stamps wherever it lands");
    ok(await send("SS-AAAAAAAAA4") === null, "an invoice not sent yet stays NULL");
    ok(await send("SS-TTTTTTTTT1") === BOOKS_TOMB, "a disconnected tenant's pushed invoice names the tombstone company");
    ok(await send("SS-DDDDDDDDD1") === null, "a taken-over tenant's pushed invoice stays NULL (unknown, so retry keeps answering 'already in QuickBooks')");

    // ── Nothing else moved: not updated_at (qbo_pending orders by it), not one other column ──
    ok(await snapshot(db) === before, "every other column of every row, updated_at included, is untouched");

    // ── Re-apply: a no-op ──
    const stamped = await stamps(db);
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply", e.message); }
    ok(again && await stamps(db) === stamped && await snapshot(db) === before, "a second apply changes nothing");

    // ── …and never overwrites a stamp, while still catching a row saved unstamped in between ──
    // A row left from another company (a wipe that failed) keeps its stamp: it is ignored by the
    // code, and the next connect clears it. A row the OLD save_item_map inserted after the first
    // apply (realm_id NULL, the write-order gap) is exactly what re-running PART 1 is for.
    await db.exec(`insert into public.qbo_item_map (client_id, line_kind, qbo_item_id, realm_id) values ('acme-sheds', 'door', '21', '${BOOKS_OTHER}');
                   insert into public.qbo_item_map (client_id, line_kind, qbo_item_id) values ('acme-sheds', 'window', '22');`);
    await db.exec(MIG());
    const kinds = Object.fromEntries((await rows(db, "select line_kind, realm_id from public.qbo_item_map where client_id = 'acme-sheds' and line_kind in ('door','window')")).map((r) => [r.line_kind, r.realm_id]));
    ok(kinds.door === BOOKS_OTHER, "a re-apply leaves another company's stamp alone", JSON.stringify(kinds));
    ok(kinds.window === BOOKS_ACME, "a re-apply stamps a row saved unstamped since the first apply", JSON.stringify(kinds));

    // ── The two SQL facts the code is built on ──
    // The status count is `realm_id = <company>`: unstamped and other-company rows are not counted.
    const counted = (await one(db, "select count(*)::int n from public.qbo_item_map where client_id = 'acme-sheds' and realm_id = $1", [BOOKS_ACME])).n;
    ok(counted === 5, "the status count (= the company) counts the company's five rows and not the other company's", String(counted));
    // The callback's wipe, as PostgREST runs it: `neq` is `<>`, which never matches NULL…
    await db.exec(`insert into public.qbo_item_map (client_id, line_kind, qbo_item_id) values ('acme-sheds', 'paint', '23');`); // unstamped
    await db.exec("begin");
    await db.query("delete from public.qbo_item_map where client_id = 'acme-sheds' and realm_id <> $1", [BOOKS_ACME]);
    const leftNeq = (await rows(db, "select line_kind from public.qbo_item_map where client_id = 'acme-sheds' and realm_id is null")).map((r) => r.line_kind);
    ok(JSON.stringify(leftNeq) === JSON.stringify(["paint"]), "a neq delete alone leaves the unstamped row behind", JSON.stringify(leftNeq));
    // …so the second, IS NULL delete is what makes it IS DISTINCT FROM: only the company's rows remain.
    await db.query("delete from public.qbo_item_map where client_id = 'acme-sheds' and realm_id is null");
    const left = await rows(db, "select distinct realm_id from public.qbo_item_map where client_id = 'acme-sheds'");
    ok(left.length === 1 && left[0].realm_id === BOOKS_ACME, "with the is-null delete, exactly the connected company's rows remain", JSON.stringify(left));
    const others = (await one(db, "select count(*)::int n from public.qbo_item_map where client_id <> 'acme-sheds'")).n;
    ok(others === 4, "and no other tenant's row was touched", String(others));
    await db.exec("rollback");

    // ── Grants: the browser roles hold nothing on either new column; the service role does ──
    const priv = await one(db, `select
        has_column_privilege('anon', 'public.qbo_item_map', 'realm_id', 'SELECT') a1,
        has_column_privilege('authenticated', 'public.qbo_item_map', 'realm_id', 'SELECT') a2,
        has_column_privilege('authenticated', 'public.qbo_item_map', 'realm_id', 'UPDATE') a3,
        has_column_privilege('anon', 'public.invoice_sends', 'qbo_realm_id', 'SELECT') a4,
        has_column_privilege('authenticated', 'public.invoice_sends', 'qbo_realm_id', 'SELECT') a5,
        has_column_privilege('service_role', 'public.qbo_item_map', 'realm_id', 'INSERT') s1,
        has_column_privilege('service_role', 'public.invoice_sends', 'qbo_realm_id', 'UPDATE') s2`);
    ok(!priv.a1 && !priv.a2 && !priv.a3 && !priv.a4 && !priv.a5, "anon and authenticated hold nothing on either column", JSON.stringify(priv));
    ok(priv.s1 && priv.s2, "the service role can write both", JSON.stringify(priv));
    await db.close();
  }

  console.log("migration 265: the assertions abort the whole migration");
  {
    // A browser role that can read the table can read the new column: refused, and the columns go with it.
    const db = await fresh("grant select on public.qbo_item_map to anon;");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /265: anon holds SELECT on qbo_item_map\.realm_id/.test(err.message), "a browser-readable qbo_item_map stops the apply", err && err.message);
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const n = await one(db, `select count(*)::int n from information_schema.columns where table_schema = 'public'
      and ((table_name = 'qbo_item_map' and column_name = 'realm_id') or (table_name = 'invoice_sends' and column_name = 'qbo_realm_id'))`);
    ok(n.n === 0, "and nothing of it is left behind", JSON.stringify(n));
    await db.close();
  }
  {
    const db = await fresh("create policy qbo_item_map_owner on public.qbo_item_map for select to authenticated using (true);");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /265: qbo_item_map has a policy/.test(err.message), "a policy on qbo_item_map stops the apply", err && err.message);
    await db.close();
  }
  {
    // A copy whose mapping backfill was lost: the unstamped-rows assertion catches it.
    const db = await fresh();
    const broken = MIG().replace(/update public\.qbo_item_map m\s+set realm_id = cs\.qbo_realm_id[\s\S]*?and m\.realm_id is null;/, "-- (backfill removed)");
    ok(broken !== MIG(), "the mutant really lost its mapping backfill");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /265: 5 mapping row\(s\) of a tenant with a QuickBooks company on file are unstamped/.test(err.message), "a lost mapping backfill stops the apply", err && err.message);
    await db.close();
  }
  {
    // The same for the invoice backfill.
    const db = await fresh();
    const broken = MIG().replace(/update public\.invoice_sends i\s+set qbo_realm_id = cs\.qbo_realm_id[\s\S]*?and i\.qbo_realm_id is null;/, "-- (backfill removed)");
    ok(broken !== MIG(), "the mutant really lost its invoice backfill");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /265: 3 pushed invoice\(s\) of a tenant with a QuickBooks company on file are unstamped/.test(err.message), "a lost invoice backfill stops the apply", err && err.message);
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
