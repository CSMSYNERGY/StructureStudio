// Execute migration 269 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// client_settings as it is live (RLS on, no policy, nothing granted to the browser roles), then
// check what it promises: an integer NOT NULL DEFAULT 30 column; every existing tenant reading 30,
// so no printed "Valid until" moves; the 1..365 range held by the database for an UPDATE, an INSERT
// and an upsert like portal-settings' save; a settings row inserted without the column (what the
// live save does today) reading 30; nothing else on any row touched; a re-apply that changes
// nothing; the browser roles holding nothing on the column; and assertions that really abort the
// whole apply (mutants). Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration269.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/269_quote_docs.sql"), "utf8");

// client_settings cut to the columns this test reads, with the live grants: RLS on, no policy,
// revoked from the browser roles (it holds the CRM API key). `extra` lets a mutant add something
// the assertions must refuse.
const STUBS = (extra = "") => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

-- The live default ACLs: the trap every new table falls into, revoked per table below as live.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;

create table public.client_settings (
  client_id text primary key,
  ghl_api_key text,
  business_name text,
  quote_terms text,
  co_free_days integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.client_settings enable row level security;
revoke all on public.client_settings from anon, authenticated;
${extra}
`;

const SEED = `
insert into public.client_settings (client_id, ghl_api_key, business_name, quote_terms, co_free_days, updated_at) values
  ('acme-sheds',    'harness-key', 'Acme Sheds',    'Deposit due at signing.', 3, '2026-09-01 10:00+00'),
  ('bravo-barns',   null,          'Bravo Barns',   null,                      0, '2026-09-02 10:00+00'),
  ('charlie-cabins', null,         null,            null,                      0, '2026-09-03 10:00+00');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

// Every column but the new one, so "nothing else was touched" is a comparison, not a hope.
const snapshot = async (db) => JSON.stringify(await rows(db,
  "select client_id, ghl_api_key, business_name, quote_terms, co_free_days, updated_at from public.client_settings order by client_id"));

/** Did this statement fail on the 1..365 check? */
async function refused(db, sql) {
  await db.exec("savepoint probe");
  try {
    await db.exec(sql);
    await db.exec("release savepoint probe");
    return false;
  } catch (e) {
    await db.exec("rollback to savepoint probe");
    return /client_settings_quote_valid_days_range/.test(e.message);
  }
}

async function fresh(extra) {
  const db = new PGlite();
  await db.exec(STUBS(extra));
  await db.exec(SEED);
  return db;
}

(async () => {
  console.log("migration 269: applies on the live shape and changes no tenant's quotes");
  {
    const db = await fresh();
    const before = await snapshot(db);
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "269 applied", e.message); }
    ok(applied, "269 applied cleanly, assertions included");

    const col = await one(db, `select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'client_settings' and column_name = 'quote_valid_days'`);
    ok(col && col.data_type === "integer" && col.is_nullable === "NO" && col.column_default === "30",
      "an integer NOT NULL DEFAULT 30 column", JSON.stringify(col));

    const days = await rows(db, "select client_id, quote_valid_days from public.client_settings order by client_id");
    ok(days.length === 3 && days.every((r) => r.quote_valid_days === 30), "every existing tenant reads 30, the fixed value quotes printed before", JSON.stringify(days));
    ok(await snapshot(db) === before, "every other column of every row, updated_at included, is untouched");

    // The assertions' own range probe was rolled back: nobody was left at 0, 366 or -1.
    const probed = await one(db, "select count(*)::int n from public.client_settings where quote_valid_days <> 30");
    ok(probed.n === 0, "the apply-time range probe left nothing behind", JSON.stringify(probed));

    // ── The range, at the database ──
    await db.exec("begin");
    ok(await refused(db, "update public.client_settings set quote_valid_days = 0 where client_id = 'acme-sheds'"), "0 days is refused");
    ok(await refused(db, "update public.client_settings set quote_valid_days = 366 where client_id = 'acme-sheds'"), "366 days is refused");
    ok(await refused(db, "update public.client_settings set quote_valid_days = -5 where client_id = 'acme-sheds'"), "a negative number is refused");
    ok(!(await refused(db, "update public.client_settings set quote_valid_days = 1 where client_id = 'acme-sheds'")), "1 day is allowed");
    ok(!(await refused(db, "update public.client_settings set quote_valid_days = 365 where client_id = 'bravo-barns'")), "365 days is allowed");
    let nullRefused = false;
    await db.exec("savepoint n");
    try { await db.exec("update public.client_settings set quote_valid_days = null where client_id = 'acme-sheds'"); await db.exec("release savepoint n"); }
    catch (e) { nullRefused = /null value/.test(e.message); await db.exec("rollback to savepoint n"); }
    ok(nullRefused, "NULL is refused: 'not set' is the default, never a blank");
    await db.exec("rollback");

    // ── What the live save does: an upsert of named columns, without this one ──
    // A tenant's first save inserts the row; the default fills the column. A later save that does
    // not name the column leaves the builder's chosen number alone.
    await db.exec(`insert into public.client_settings (client_id, business_name, updated_at) values ('delta-decks', 'Delta Decks', now())
                   on conflict (client_id) do update set business_name = excluded.business_name, updated_at = excluded.updated_at`);
    ok((await one(db, "select quote_valid_days d from public.client_settings where client_id = 'delta-decks'")).d === 30,
      "a settings row inserted without the column reads 30");
    await db.exec("update public.client_settings set quote_valid_days = 14 where client_id = 'acme-sheds'");
    await db.exec(`insert into public.client_settings (client_id, quote_terms, updated_at) values ('acme-sheds', 'New terms.', now())
                   on conflict (client_id) do update set quote_terms = excluded.quote_terms, updated_at = excluded.updated_at`);
    ok((await one(db, "select quote_valid_days d from public.client_settings where client_id = 'acme-sheds'")).d === 14,
      "a save that does not name the column keeps the builder's 14 days");
    await db.exec("begin");
    ok(await refused(db, `insert into public.client_settings (client_id, quote_valid_days) values ('echo-sheds', 400)
                          on conflict (client_id) do update set quote_valid_days = excluded.quote_valid_days`),
      "an upsert carrying 400 is refused (the Settings save refuses it first, with a sentence)");
    await db.exec("rollback");

    // ── Re-apply: a no-op that keeps every chosen number ──
    const chosen = JSON.stringify(await rows(db, "select client_id, quote_valid_days from public.client_settings order by client_id"));
    const all = await snapshot(db);
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply", e.message); }
    ok(again, "a second apply succeeds (the constraint rides inside ADD COLUMN IF NOT EXISTS)");
    ok(JSON.stringify(await rows(db, "select client_id, quote_valid_days from public.client_settings order by client_id")) === chosen && await snapshot(db) === all,
      "and changes nothing: every builder's number, and every other column, as it was");
    const cons = await one(db, "select count(*)::int n from pg_constraint where conname = 'client_settings_quote_valid_days_range'");
    ok(cons.n === 1, "exactly one range constraint after two applies", JSON.stringify(cons));

    // ── Grants: the browser roles hold nothing on the column; the service role does ──
    const priv = await one(db, `select
        has_column_privilege('anon', 'public.client_settings', 'quote_valid_days', 'SELECT') a1,
        has_column_privilege('authenticated', 'public.client_settings', 'quote_valid_days', 'SELECT') a2,
        has_column_privilege('authenticated', 'public.client_settings', 'quote_valid_days', 'UPDATE') a3,
        has_column_privilege('service_role', 'public.client_settings', 'quote_valid_days', 'SELECT') s1,
        has_column_privilege('service_role', 'public.client_settings', 'quote_valid_days', 'UPDATE') s2,
        has_column_privilege('service_role', 'public.client_settings', 'quote_valid_days', 'INSERT') s3`);
    ok(!priv.a1 && !priv.a2 && !priv.a3, "anon and authenticated hold nothing on the column", JSON.stringify(priv));
    ok(priv.s1 && priv.s2 && priv.s3, "the service role can read and write it", JSON.stringify(priv));
    await db.close();
  }

  console.log("migration 269: applies on an empty table too");
  {
    const db = new PGlite();
    await db.exec(STUBS());
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "269 on an empty table", e.message); }
    ok(applied, "no rows to probe is not a failure; the constraint is still checked by name");
    await db.close();
  }

  console.log("migration 269: the assertions abort the whole migration");
  {
    // A browser role that can read the table can read the new column: refused, and the column goes with it.
    const db = await fresh("grant select on public.client_settings to authenticated;");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /269: authenticated holds SELECT on client_settings\.quote_valid_days/.test(err.message), "a browser-readable client_settings stops the apply", err && err.message);
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const n = await one(db, `select count(*)::int n from information_schema.columns where table_schema = 'public'
      and table_name = 'client_settings' and column_name = 'quote_valid_days'`);
    ok(n.n === 0, "and nothing of it is left behind", JSON.stringify(n));
    await db.close();
  }
  {
    const db = await fresh("create policy client_settings_owner on public.client_settings for select to authenticated using (true);");
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /269: client_settings has a policy/.test(err.message), "a policy on client_settings stops the apply", err && err.message);
    await db.close();
  }
  {
    // A copy that lost its range check: the probe catches it before anything is kept.
    const db = await fresh();
    const broken = MIG().replace(/\n\s+constraint client_settings_quote_valid_days_range check \(quote_valid_days between 1 and 365\)/, "");
    ok(broken !== MIG(), "the mutant really lost its range check");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /269: quote_valid_days took 0 days/.test(err.message), "a lost range check stops the apply", err && err.message);
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const d = await rows(db, "select quote_valid_days from public.client_settings").catch(() => null);
    ok(d === null, "and the column is gone with it (nobody was left at 0 days)", JSON.stringify(d));
    await db.close();
  }
  {
    // A copy whose default drifted: every tenant's printed date would move. Refused.
    const db = await fresh();
    const broken = MIG().replace("quote_valid_days integer not null default 30", "quote_valid_days integer not null default 14");
    ok(broken !== MIG(), "the mutant really changed the default");
    let err = null;
    try { await db.exec(broken); } catch (e) { err = e; }
    ok(!!err && /269: client_settings\.quote_valid_days should be integer NOT NULL DEFAULT 30/.test(err.message), "a default other than 30 stops the apply", err && err.message);
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
