// Execute migration 346 for real in PGlite (Postgres compiled to WASM, in memory), on a
// client_settings shaped like the live one (RLS on, no policy, nothing for the browser roles,
// Supabase's default privileges notwithstanding), then check what it promises:
//   * client_settings.support_ai_beta exists, is boolean NOT NULL DEFAULT false, and every row that
//     was there reads false; a builder made afterwards (an insert that does not name it) reads false;
//     null is refused;
//   * nothing else on any row moves (updated_at included);
//   * the browser roles reach the column in no way; the service role reads and writes it;
//     RLS still on, still no policy;
//   * THE RECORD, the one row `supabase db query` prints;
//   * a re-apply changes nothing and keeps an operator's switch; the rehearsal (the last commit;
//     swapped for rollback;) leaves nothing; a CRLF checkout applies the same;
//   * refusals with the whole file rolled back: a database without client_settings, a
//     client_settings that has grown a policy, one that hands the browser roles the table, and a
//     hand-made support_ai_beta of the wrong shape.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration346.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const RAW = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/346_support_ai_beta.sql"), "utf8");
const M346 = () => RAW().replace(/\r\n/g, "\n");

const ROLES = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`;
// client_settings trimmed to a few of its columns, with its live posture: RLS on, no policy, the
// browser roles' default grants taken back, the service role kept.
const TABLE = `
create table public.client_settings (
  client_id text primary key,
  updated_at timestamptz not null default '2026-10-01T00:00:00Z',
  business_website text,
  lead_sms_consent_box boolean not null default true,
  internal_account boolean not null default false
);
alter table public.client_settings enable row level security;
revoke all on public.client_settings from anon, authenticated;
grant select, insert, update, delete on public.client_settings to service_role;
insert into public.client_settings (client_id, business_website, lead_sms_consent_box, internal_account) values
  ('example-builder', 'https://example.test', true, false),
  ('other-builder', null, false, false),
  ('internal-tenant', 'https://internal.example.test', true, true);
`;

let failures = 0;
const ok = (cond, name, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? `   [${detail}]` : ""}`);
};
// process.exitCode, never process.exit: PGlite's handles in flight trip libuv on Windows (exit 127).
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function fresh(withTable = true) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(ROLES);
  if (withTable) await db.exec(TABLE);
  return db;
}
const rows = async (db, sql) => (await db.query(sql)).rows;
const refused = async (db, sql) => { try { await db.exec(sql); return false; } catch { return true; } };
const colCount = async (db) => (await rows(db,
  "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='client_settings' and column_name='support_ai_beta'"))[0].n;
const others = async (db) => JSON.stringify(await rows(db,
  "select client_id, updated_at, business_website, lead_sms_consent_box, internal_account from public.client_settings order by client_id"));
// A refused apply leaves the session inside the file's aborted `begin;` (exactly what `db query`
// does with it: nothing commits), so the next read first ends that transaction the way the
// server would at disconnect.
const applyFails = async (db) => {
  let msg = "";
  try { await db.exec(M346()); } catch (e) { msg = String(e.message); }
  await db.exec("rollback;").catch(() => {});
  return msg;
};

(async () => {
  // ── 1. Apply ────────────────────────────────────────────────────────────────────────────
  const db = await fresh();
  const before = await others(db);
  let record;
  try {
    const res = await db.exec(M346());
    record = res.filter((r) => r.rows && r.rows.length).pop()?.rows?.[0];
    ok(true, "346 applied");
  } catch (e) { ok(false, "346 applied", e.message); await closeAll(); process.exitCode = 1; return; }
  ok(record && record.migration === "346" && record.column_added === true && record.browser_blocked === true
    && record.turned_on === 0 && record.settings_rows === 3,
    "THE RECORD reads column_added, browser_blocked, turned_on 0, three settings rows", JSON.stringify(record));

  const col = (await rows(db, `select data_type, is_nullable, column_default from information_schema.columns
     where table_schema='public' and table_name='client_settings' and column_name='support_ai_beta'`))[0];
  ok(col && col.data_type === "boolean" && col.is_nullable === "NO" && col.column_default === "false",
    "client_settings.support_ai_beta is boolean NOT NULL DEFAULT false", JSON.stringify(col));
  const flags = await rows(db, "select client_id, support_ai_beta from public.client_settings order by client_id");
  ok(flags.length === 3 && flags.every((r) => r.support_ai_beta === false), "every existing builder reads off", JSON.stringify(flags));
  ok((await others(db)) === before, "nothing else on any row moved (updated_at included)");
  const comment = (await rows(db, `select col_description('public.client_settings'::regclass,
     (select attnum from pg_attribute where attrelid = 'public.client_settings'::regclass and attname = 'support_ai_beta')) as c`))[0].c;
  ok(/Migration 346/.test(String(comment)) && /operator/.test(String(comment)), "the column carries its comment", String(comment));

  // ── 2. New rows, nulls, the operator's switch ───────────────────────────────────────────
  await db.exec("insert into public.client_settings (client_id) values ('new-builder')");
  const made = (await rows(db, "select support_ai_beta from public.client_settings where client_id = 'new-builder'"))[0];
  ok(made && made.support_ai_beta === false, "a builder made later (an insert that does not name it) reads off");
  ok(await refused(db, "update public.client_settings set support_ai_beta = null where client_id = 'example-builder'"), "null is refused");
  ok(!(await refused(db, "update public.client_settings set support_ai_beta = true where client_id = 'example-builder'")), "an operator turns one builder on");
  const after = await rows(db, "select client_id from public.client_settings where support_ai_beta order by client_id");
  ok(after.length === 1 && after[0].client_id === "example-builder", "…and only that builder", JSON.stringify(after));

  // ── 3. Lockdown ─────────────────────────────────────────────────────────────────────────
  const priv = (await rows(db, `select
      has_column_privilege('anon', 'public.client_settings', 'support_ai_beta', 'select') as anon_sel,
      has_column_privilege('anon', 'public.client_settings', 'support_ai_beta', 'update') as anon_upd,
      has_column_privilege('authenticated', 'public.client_settings', 'support_ai_beta', 'select') as auth_sel,
      has_column_privilege('authenticated', 'public.client_settings', 'support_ai_beta', 'insert') as auth_ins,
      has_column_privilege('authenticated', 'public.client_settings', 'support_ai_beta', 'update') as auth_upd,
      has_column_privilege('service_role', 'public.client_settings', 'support_ai_beta', 'select') as svc_sel,
      has_column_privilege('service_role', 'public.client_settings', 'support_ai_beta', 'update') as svc_upd,
      (select relrowsecurity from pg_class where oid = 'public.client_settings'::regclass) as rls,
      (select count(*)::int from pg_policy where polrelid = 'public.client_settings'::regclass) as policies`))[0];
  ok(!priv.anon_sel && !priv.anon_upd && !priv.auth_sel && !priv.auth_ins && !priv.auth_upd,
    "the browser roles reach the column in no way", JSON.stringify(priv));
  ok(priv.svc_sel === true && priv.svc_upd === true, "the service role reads and writes it (support-agent; the operator's SQL)");
  ok(priv.rls === true && priv.policies === 0, "RLS still on, still no policy");

  // ── 4. Re-apply, rehearsal, CRLF ────────────────────────────────────────────────────────
  const snap = JSON.stringify(await rows(db, "select client_id, support_ai_beta, updated_at from public.client_settings order by client_id"));
  let again;
  try {
    const res = await db.exec(M346());
    again = res.filter((r) => r.rows && r.rows.length).pop()?.rows?.[0];
    ok(true, "a re-apply runs");
  } catch (e) { ok(false, "a re-apply runs", e.message); }
  ok(JSON.stringify(await rows(db, "select client_id, support_ai_beta, updated_at from public.client_settings order by client_id")) === snap,
    "…and changes nothing (the builder an operator switched on stays on)");
  ok(again && again.turned_on === 1, "…and its record counts the one switched on", JSON.stringify(again));

  const rehearse = await fresh();
  let dry;
  try {
    const res = await rehearse.exec(M346().replace(/^commit;$/m, "rollback;"));
    dry = res.filter((r) => r.rows && r.rows.length).pop()?.rows?.[0];
  } catch (e) { ok(false, "the rehearsal runs", e.message); }
  ok(dry && dry.migration === "346" && dry.column_added === true, "the rehearsal prints the same record", JSON.stringify(dry));
  ok((await colCount(rehearse)) === 0, "…and leaves nothing behind");

  const crlf = await fresh();
  try {
    await crlf.exec(RAW().replace(/\r?\n/g, "\r\n"));
    ok((await colCount(crlf)) === 1, "a CRLF checkout applies the same");
  } catch (e) { ok(false, "a CRLF checkout applies the same", e.message); }

  // ── 5. Refusals, each with the whole file rolled back ───────────────────────────────────
  const bare = await fresh(false);
  const bareMsg = await applyFails(bare);
  ok(/client_settings is missing/.test(bareMsg), "a database without client_settings is refused", bareMsg);

  const policied = await fresh();
  await policied.exec("create policy cs_read on public.client_settings for select to authenticated using (true)");
  const polMsg = await applyFails(policied);
  ok(/has a policy/.test(polMsg), "a client_settings that has grown a policy is refused (it is service-role only)", polMsg);
  ok((await colCount(policied)) === 0, "…and nothing is left behind");

  const leaky = await fresh();
  await leaky.exec("grant select on public.client_settings to authenticated");
  const leakMsg = await applyFails(leaky);
  ok(/authenticated holds SELECT/.test(leakMsg), "a client_settings the browser can read is refused", leakMsg);
  ok((await colCount(leaky)) === 0, "…and nothing is left behind");

  const wrong = await fresh();
  await wrong.exec("alter table public.client_settings add column support_ai_beta text");
  const wrongMsg = await applyFails(wrong);
  ok(/not boolean not null default false/.test(wrongMsg), "a hand-made support_ai_beta of another shape is refused, not kept", wrongMsg);

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
