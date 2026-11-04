// Execute migration 356 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// client_settings as it is live (RLS on, no policy, nothing granted to the browser roles), then
// check what it promises: a nullable text column with no default; every existing tenant reading NULL
// so no quote changes who it goes out as; nothing else on any row touched; the browser roles unable
// to read it; the service role able to read and set it; a re-apply that changes nothing; a second
// claim of the number returning no row; and assertions that really abort the apply (mutants). Nothing
// here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration356.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const SQL = fs.readFileSync(path.join(WT, "supabase/migrations/356_ghl_sender_user.sql"), "utf8").replace(/\r/g, "");

// The header's own piece() recipe, so the test applies exactly what the apply steps apply.
function piece(name) {
  const out = [];
  let on = false;
  for (const line of SQL.split("\n")) {
    if (line === `-- >>> ${name}`) { on = true; continue; }
    if (line === `-- <<< ${name}`) on = false;
    if (on && !line.startsWith("--")) out.push(line);
  }
  if (!out.length) throw new Error(`no piece ${name}`);
  return out.join("\n");
}

const STUBS = (extra = "") => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);

create table public.client_settings (
  client_id text primary key,
  ghl_api_key text,
  business_name text,
  updated_at timestamptz not null default now()
);
alter table public.client_settings enable row level security;
revoke all on public.client_settings from anon, authenticated;
grant all on public.client_settings to service_role;
${extra}
`;

const SEED = `
insert into public.client_settings (client_id, ghl_api_key, business_name, updated_at) values
  ('acme-sheds',  'harness-key', 'Acme Sheds',  '2026-09-01 10:00+00'),
  ('bravo-barns', null,          'Bravo Barns', '2026-09-02 10:00+00');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const rows = async (db, sql) => (await db.query(sql)).rows;
const snapshot = async (db) => JSON.stringify(await rows(db,
  "select client_id, ghl_api_key, business_name, updated_at from public.client_settings order by client_id"));

async function fresh(extra) {
  const db = new PGlite();
  await db.exec(STUBS(extra));
  await db.exec(SEED);
  return db;
}

/** Does this role's read of the column get refused? */
async function refusedFor(db, role) {
  await db.exec(`set role ${role}`);
  try {
    await db.query("select ghl_sender_user_id from public.client_settings");
    return false;
  } catch (e) {
    return /permission denied/.test(e.message);
  } finally {
    await db.exec("reset role");
  }
}

async function aborts(extra) {
  const db = await fresh(extra);
  try {
    await db.exec(piece("P1"));
    return null;
  } catch (e) {
    return e.message;
  } finally {
    await db.close();
  }
}

(async () => {
  console.log("migration 356: applies on the live shape and changes no tenant's quotes");
  {
    const db = await fresh();
    const before = await snapshot(db);

    const claimed = await rows(db, piece("P0"));
    ok(claimed.length === 1 && claimed[0].version === "356" && claimed[0].name === "356_ghl_sender_user", "P0 claims 356 and returns its row", JSON.stringify(claimed));
    const again = await rows(db, piece("P0"));
    ok(again.length === 0, "a second claim returns no row, which is the header's signal that the number is gone", JSON.stringify(again));

    let applied = true;
    try { await db.exec(piece("P1")); } catch (e) { applied = false; ok(false, "P1 applied", e.message); }
    ok(applied, "P1 applied cleanly, assertions included");

    const col = (await rows(db, `select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'client_settings' and column_name = 'ghl_sender_user_id'`))[0];
    ok(col && col.data_type === "text" && col.is_nullable === "YES" && col.column_default === null, "a nullable text column with no default", JSON.stringify(col));

    const pins = await rows(db, "select ghl_sender_user_id from public.client_settings");
    ok(pins.length === 2 && pins.every((r) => r.ghl_sender_user_id === null), "every existing tenant reads NULL, so no quote changes who it goes out as");
    ok(await snapshot(db) === before, "every other column of every row, updated_at included, is untouched");

    const record = (await rows(db, piece("R1")))[0];
    ok(record.column_ready === true && Number(record.pinned_builders) === 0 && Number(record.ledger_rows) === 1, "R1 reads the column ready, nobody pinned, one ledger row", JSON.stringify(record));

    // ── Who can touch it ──
    ok(await refusedFor(db, "anon"), "anon cannot read it");
    ok(await refusedFor(db, "authenticated"), "authenticated cannot read it");
    await db.exec("set role service_role");
    await db.exec("update public.client_settings set ghl_sender_user_id = 'user-1' where client_id = 'acme-sheds'");
    const set = await rows(db, "select client_id, ghl_sender_user_id from public.client_settings order by client_id");
    await db.exec("reset role");
    ok(set[0].ghl_sender_user_id === "user-1" && set[1].ghl_sender_user_id === null, "service_role reads and sets it, one tenant at a time", JSON.stringify(set));

    // ── A re-apply keeps what was set ──
    let reapplied = true;
    try { await db.exec(piece("P1")); } catch (e) { reapplied = false; ok(false, "the re-apply", e.message); }
    ok(reapplied, "P1 applies a second time");
    const kept = await rows(db, "select ghl_sender_user_id from public.client_settings where client_id = 'acme-sheds'");
    ok(kept[0].ghl_sender_user_id === "user-1", "a re-apply keeps a pin that was set", JSON.stringify(kept));
    await db.close();
  }

  // The live table was revoked per column-less table grant, so only a table-level grant or a policy
  // can open it. Each of these must abort P1, or the checks above prove nothing.
  console.log("the apply-time checks really abort");
  {
    const m1 = await aborts("grant select on public.client_settings to authenticated;");
    ok(m1 && /authenticated holds SELECT/.test(m1), "a browser role holding SELECT aborts the apply", String(m1));
    const m2 = await aborts("grant select on public.client_settings to anon;");
    ok(m2 && /anon holds SELECT/.test(m2), "anon holding SELECT aborts the apply", String(m2));
    const m3 = await aborts("alter table public.client_settings disable row level security;");
    ok(m3 && /RLS is off/.test(m3), "RLS off aborts the apply", String(m3));
    const m4 = await aborts("create policy p on public.client_settings for select using (true);");
    ok(m4 && /has a policy/.test(m4), "a policy aborts the apply", String(m4));
    const m5 = await aborts("revoke all on public.client_settings from service_role;");
    ok(m5 && /service_role cannot read/.test(m5), "a service role that cannot read aborts the apply", String(m5));
    const m6 = await aborts("alter table public.client_settings add column ghl_sender_user_id integer;");
    ok(m6 && /should be text/.test(m6), "a column of the wrong shape already there aborts the apply", String(m6));
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
