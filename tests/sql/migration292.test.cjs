// Execute migration 292 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// sms_registrations, sms_numbers, twilio_usage_daily and Vault as they are live, then check what it
// promises: twilio_accounts exists, service-role only, RLS on and NOT forced; the parent is encoded
// only as a NULL account SID; every tenant already holding something on the parent gets a parent
// pin row, and no tenant holding anything there can be made a sub (one tenant, one account); the
// two definer functions put a sub's secrets in Vault and read them back by tenant and by SID, only
// ever a secret named for the row's own SID (a row pointed at another secret reads and writes
// nothing of it), and nobody but the service role may call them; every existing row stays on the
// parent and twilio_usage_daily keeps its key; the apply-time rehearsal leaves nothing behind; a
// re-apply is harmless; and broken copies are refused (mutants). Nothing here touches
// the live project: no network, no Supabase, no Twilio. Every SID and secret below is made up.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration292.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_PATH = process.env.MIG_FILE || path.join(WT, "supabase/migrations/292_twilio_accounts.sql");
const MIG_TEXT = () => fs.readFileSync(MIG_PATH, "utf8");

const SUB_SID = "AC" + "1".repeat(32);
const SUB2_SID = "AC" + "2".repeat(32);
const TOKEN_A = "testauthtoken" + "a".repeat(19);
const TOKEN_B = "testauthtoken" + "b".repeat(19);
const KEY_SECRET = "testkeysecret" + "c".repeat(19);
const KEY_SID = "SK" + "3".repeat(32);
const SUB3_SID = "AC" + "4".repeat(32);
const EVIL_SID = "AC" + "7".repeat(32);

// Vault as Supabase ships it, cut to what 292 uses: vault.secrets (name unique), the
// decrypted_secrets view, and create_secret / update_secret with their live signatures. The
// "encryption" is left out (PGlite has no pgsodium); the contract (ids, names, the decrypted
// column, update in place) is what 292 relies on.
const VAULT = `
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(), name text, description text not null default '',
  secret text not null, key_id uuid, nonce bytea, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index secrets_name_idx on vault.secrets (name) where name is not null;
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id) values (new_secret, new_name, coalesce(new_description, ''), new_key_id)
  returning id into v_id;
  return v_id;
end $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null)
returns void language plpgsql as $$
begin
  update vault.secrets s set secret = coalesce(new_secret, s.secret), name = coalesce(new_name, s.name),
    description = coalesce(new_description, s.description), key_id = coalesce(new_key_id, s.key_id), updated_at = now()
   where s.id = secret_id;
end $$;
revoke all on schema vault from public;
`;

// The live shapes (165, 259), cut to the columns that matter here, with Supabase's live default
// ACLs: every new table and function in public is granted to the browser roles until revoked.
const STUBS = ({ vault = true } = {}) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
${vault ? VAULT : ""}

create table public.sms_registrations (
  client_id text primary key, status text not null default 'none', customer_profile_sid text, a2p_profile_sid text,
  brand_sid text, messaging_service_sid text, campaign_sid text, campaign_cm_sid text
);
create table public.client_settings (
  client_id text primary key, sms_number text, sms_status text not null default 'off',
  internal_account boolean not null default false
);
create table public.sms_numbers (
  id uuid primary key default gen_random_uuid(), client_id text not null, phone_number text not null,
  twilio_sid text, messaging_service_sid text, registration_status text not null default 'pending_registration',
  released_at timestamptz
);
create table public.twilio_usage_daily (
  day date not null, category text not null, count numeric, usage numeric, price_micros bigint,
  fetched_at timestamptz not null default now(), primary key (day, category)
);
alter table public.sms_registrations enable row level security;
alter table public.sms_numbers enable row level security;
alter table public.twilio_usage_daily enable row level security;
alter table public.client_settings enable row level security;

-- Who already lives on the parent: demo-tenant (a number and a registration), own-account (our
-- internal account, nothing else), legacy-tenant (a texting number from before 165, no number
-- row). Not pinned: quiet-tenant (a registration that never reached Twilio), gone-tenant (only a
-- released number), plain-tenant (settings only).
insert into public.sms_registrations (client_id, status, messaging_service_sid) values
  ('demo-tenant', 'active', 'MG' || repeat('0', 32)), ('quiet-tenant', 'none', null);
insert into public.sms_numbers (client_id, phone_number, twilio_sid, registration_status, released_at) values
  ('demo-tenant', '+15555550100', 'PN' || repeat('0', 32), 'registered', null),
  ('gone-tenant', '+15555550111', 'PN' || repeat('1', 32), 'registered', now());
insert into public.client_settings (client_id, sms_number, internal_account) values
  ('demo-tenant', '+15555550100', false), ('own-account', null, true), ('legacy-tenant', '+15555550177', false),
  ('plain-tenant', '', false), ('quiet-tenant', null, false);
insert into public.twilio_usage_daily (day, category, count, usage, price_micros) values
  ('2026-10-01', 'sms-outbound', 3, 3, 24900), ('2026-10-01', 'calls-inbound', 2, 7, 59500);
`;

async function makeDb(opts) {
  const db = new PGlite();
  await db.exec(STUBS(opts));
  return db;
}

async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  const out = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  // The RECORD is the last statement that returns rows.
  const record = [...out].reverse().find((r) => r.rows && r.rows.length && r.fields.some((f) => f.name === "migration"));
  return { notices, record: record ? record.rows[0] : null };
}

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
async function refused(db, sql, params, pattern) {
  try {
    await db.query(sql, params);
    return { refused: false, message: "(accepted)" };
  } catch (e) {
    return { refused: !pattern || pattern.test(e.message), message: e.message };
  }
}

// Run as a role, always back to the owner afterwards.
async function as(db, role, fn) {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const svc0 = (db, sql, params) => as(db, "service_role", () => db.query(sql, params));

(async () => {
  // ── 1. The live shape: applies, checks pass, the RECORD reads PASS ─────────────────────
  console.log("migration 292: applies on the live shape");
  const db = await makeDb();
  let res;
  try { res = await apply(db); ok(true, "292 applied cleanly, assertions and rehearsal included"); }
  catch (e) { ok(false, "292 applied", e.message); process.exit(1); }
  ok(res.notices.some((n) => /292: checks hold/.test(n)), "the checks ran to their notice", res.notices.join(" | "));
  const R = res.record || {};
  ok(R.table_ready === true && R.functions_ready === true && R.guard_ready === true, "RECORD: table_ready, functions_ready and guard_ready", JSON.stringify(R));
  ok(R.parent_pins === 3 && R.subs === 0 && R.unpinned_holders === 0, "RECORD: three parent pins, no subs, nobody left unpinned", JSON.stringify(R));
  ok(R.columns_added === 3 && R.rows_not_parent === 0, "RECORD: three columns, every row on the parent", JSON.stringify(R));
  ok(R.usage_pk === "day,category", "RECORD: twilio_usage_daily keeps (day, category)", R.usage_pk);
  ok(/^secrets stored, replaced in place, bound to their names and read back by tenant and by SID/.test(String(R.rehearsal)), "RECORD: the rehearsal ran to its end", R.rehearsal);
  ok((await one(db, "select count(*)::int n from vault.secrets")).n === 0, "the rehearsal left no Vault secret behind");
  ok((await one(db, "select count(*)::int n from public.twilio_accounts where client_id = 'm292-rehearsal'")).n === 0, "and no rehearsal row");

  // ── 1b. The parent pins ───────────────────────────────────────────────────────────────
  console.log("parent pins");
  const pins = (await db.query("select client_id, kind, account_sid, status from public.twilio_accounts order by 1")).rows;
  ok(JSON.stringify(pins.map((r) => r.client_id)) === JSON.stringify(["demo-tenant", "legacy-tenant", "own-account"]),
    "pinned: the tenant with a number and a registration, the pre-165 texting number, our internal account", JSON.stringify(pins));
  ok(pins.every((r) => r.kind === "parent" && r.account_sid === null && r.status === "active"), "every pin is kind 'parent', NULL SID, active");
  const holds = await one(db, `select public.twilio_parent_holdings('demo-tenant') d, public.twilio_parent_holdings('legacy-tenant') l,
      public.twilio_parent_holdings('quiet-tenant') q, public.twilio_parent_holdings('gone-tenant') g,
      public.twilio_parent_holdings('plain-tenant') p, public.twilio_parent_holdings('own-account') o`);
  ok(holds.d === "a live number" && holds.l === "a texting number" && holds.q === null && holds.g === null && holds.p === null && holds.o === null,
    "twilio_parent_holdings: a live number / a texting number; nothing for a registration that never reached Twilio, a released number, an empty setting", JSON.stringify(holds));
  ok((await one(db, "select public.twilio_parent_holdings('nobody') h")).h === null, "and nothing for a tenant with no rows at all");

  // ── 2. Existing rows: untouched, NULL = the parent ────────────────────────────────────
  console.log("existing rows");
  const nn = await one(db, `select
    (select count(*) from public.sms_registrations where twilio_account_sid is null)::int r,
    (select count(*) from public.sms_numbers where twilio_account_sid is null)::int n,
    (select count(*) from public.twilio_usage_daily where account_sid is null)::int u`);
  ok(nn.r === 2 && nn.n === 2 && nn.u === 2, "every existing registration, number and usage row reads NULL (the parent)", JSON.stringify(nn));
  ok((await refused(db, "insert into public.twilio_usage_daily (day, category, account_sid) values ('2026-10-01', 'sms-outbound', $1)", [SUB_SID], /duplicate key/)).refused,
    "twilio_usage_daily's key is still (day, category): a second account's row for the same day and category collides (phase 7 swaps it)");
  for (const [t, c] of [["sms_registrations", "twilio_account_sid"], ["sms_numbers", "twilio_account_sid"], ["twilio_usage_daily", "account_sid"]]) {
    ok((await refused(db, `update public.${t} set ${c} = 'not-a-sid'`, [], /check constraint/)).refused, `${t}.${c} refuses a value that is not an AC… SID`);
  }
  await db.query("update public.sms_numbers set twilio_account_sid = $1", [SUB_SID]);
  ok((await one(db, "select twilio_account_sid s from public.sms_numbers")).s === SUB_SID, "sms_numbers.twilio_account_sid takes a real-shaped SID");
  await db.query("update public.sms_numbers set twilio_account_sid = null");

  // ── 3. The table: who can see it, and what a row may say ──────────────────────────────
  console.log("twilio_accounts: privileges and RLS");
  const cls = await one(db, "select relrowsecurity r, relforcerowsecurity f from pg_class where oid = 'public.twilio_accounts'::regclass");
  ok(cls.r === true && cls.f === false, "RLS enabled, NOT forced");
  ok((await one(db, "select count(*)::int n from pg_policy where polrelid = 'public.twilio_accounts'::regclass")).n === 0, "no policies");
  for (const role of ["anon", "authenticated"]) {
    const r = await as(db, role, () => refused(db, "select * from public.twilio_accounts", [], /permission denied/));
    ok(r.refused, `${role} cannot read twilio_accounts`, r.message);
    const w = await as(db, role, () => refused(db, "insert into public.twilio_accounts (client_id, kind) values ('x', 'parent')", [], /permission denied/));
    ok(w.refused, `${role} cannot write twilio_accounts`, w.message);
    const f1 = await as(db, role, () => refused(db, "select * from public.twilio_account_creds(p_account_sid := $1)", [SUB_SID], /permission denied/));
    ok(f1.refused, `${role} cannot call twilio_account_creds`, f1.message);
    const f2 = await as(db, role, () => refused(db, "select public.twilio_account_secret_put('x', 'auth_token', $1)", [TOKEN_A], /permission denied/));
    ok(f2.refused, `${role} cannot call twilio_account_secret_put`, f2.message);
  }
  const fns = (await db.query(`select p.proname, p.prosecdef, p.proconfig from pg_proc p
     where p.proname in ('twilio_account_creds', 'twilio_account_secret_put') order by 1`)).rows;
  ok(fns.length === 2 && fns.every((f) => f.prosecdef && JSON.stringify(f.proconfig) === JSON.stringify(['search_path=""'])),
    "both functions are SECURITY DEFINER with search_path ''", JSON.stringify(fns));

  console.log("twilio_accounts: constraints");
  const bad = [
    ["the parent with an account SID", "insert into public.twilio_accounts (client_id, kind, account_sid, status) values ('p1', 'parent', $1, 'active')", [SUB_SID]],
    ["the parent with a secret id", "insert into public.twilio_accounts (client_id, kind, status, auth_token_id) values ('p1', 'parent', 'active', gen_random_uuid())", []],
    ["an active sub with no SID", "insert into public.twilio_accounts (client_id, kind, status) values ('s1', 'sub', 'active')", []],
    ["a malformed SID", "insert into public.twilio_accounts (client_id, kind, account_sid, status) values ('s1', 'sub', 'AC123', 'active')", []],
    ["an unknown kind", "insert into public.twilio_accounts (client_id, kind) values ('s1', 'child')", []],
    ["an unknown status", "insert into public.twilio_accounts (client_id, kind, status) values ('s1', 'sub', 'pending')", []],
    ["a client id that is not a slug", "insert into public.twilio_accounts (client_id, kind) values ('Bad Slug', 'parent')", []],
    ["a long last_error", "insert into public.twilio_accounts (client_id, kind, last_error) values ('s1', 'sub', repeat('x', 201))", []],
    ["a malformed key SID", "insert into public.twilio_accounts (client_id, kind, account_sid, status, api_key_sid) values ('s1', 'sub', $1, 'active', 'XX1')", [SUB_SID]],
  ];
  for (const [label, sql, params] of bad) {
    const r = await refused(db, sql, params, /check constraint/);
    ok(r.refused, `refuses ${label}`, r.message);
  }
  await db.query("insert into public.twilio_accounts (client_id, kind, status) values ('parent-pin', 'parent', 'active')");
  await db.query("insert into public.twilio_accounts (client_id, kind, status) values ('new-builder', 'sub', 'provisioning')");
  await db.query("insert into public.twilio_accounts (client_id, kind, account_sid, status, api_key_sid) values ('sub-builder', 'sub', $1, 'active', $2)", [SUB_SID, KEY_SID]);
  ok(true, "accepts a parent pin (no SID), a sub still provisioning (no SID yet), and an active sub with its SID");
  const dup = await refused(db, "insert into public.twilio_accounts (client_id, kind, account_sid, status) values ('other', 'sub', $1, 'active')", [SUB_SID], /duplicate key/);
  ok(dup.refused, "one tenant per sub-account SID", dup.message);

  // ── 3b. One tenant, one account: no sub over anything still on the parent ──────────────
  console.log("twilio_accounts_no_split");
  const svcR = (sql, params, re) => as(db, "service_role", () => refused(db, sql, params, re));
  let r = await svcR("update public.twilio_accounts set kind = 'sub', status = 'provisioning' where client_id = 'demo-tenant'", [], /no_split.*still has a live number on the parent/);
  ok(r.refused, "a parent pin holding a live number cannot be turned into a sub (as the service role)", r.message);
  r = await svcR("update public.twilio_accounts set kind = 'sub', status = 'provisioning' where client_id = 'legacy-tenant'", [], /still has a texting number/);
  ok(r.refused, "nor one holding only a pre-165 texting number", r.message);
  // The window between this migration and phase 3: a registration made on the parent after the pins.
  await db.query("insert into public.sms_registrations (client_id, status, customer_profile_sid) values ('late-tenant', 'profile_pending', 'BU' || repeat('9', 32))");
  r = await svcR("insert into public.twilio_accounts (client_id, kind, status) values ('late-tenant', 'sub', 'provisioning')", [], /still has a texting registration/);
  ok(r.refused, "a tenant that registered on the parent after the pins cannot be given a sub either", r.message);
  r = await svcR("update public.twilio_accounts set client_id = 'late-tenant' where client_id = 'new-builder'", [], /still has a texting registration/);
  ok(r.refused, "nor can an existing sub row be re-pointed at it", r.message);
  // Moved (the runbook step): its registration says which sub it is in; then the row is allowed.
  await db.query("update public.sms_registrations set twilio_account_sid = $1 where client_id = 'late-tenant'", [SUB3_SID]);
  await svc0(db, "insert into public.twilio_accounts (client_id, kind, status) values ('late-tenant', 'sub', 'provisioning')");
  ok(true, "once its registration is marked as the sub's, the sub row is accepted");
  await svc0(db, "update public.twilio_accounts set status = 'failed', last_error = 'step:create' where client_id = 'late-tenant'");
  ok(true, "a sub row's own updates (status, step) are not re-judged");
  await db.query("delete from public.twilio_accounts where client_id = 'late-tenant'");
  await db.query("delete from public.sms_registrations where client_id = 'late-tenant'");
  await svc0(db, "insert into public.twilio_accounts (client_id, kind, status) values ('gone-tenant', 'sub', 'provisioning')");
  ok(true, "a tenant whose only number was released may have a sub");
  await db.query("delete from public.twilio_accounts where client_id = 'gone-tenant'");

  // ── 4. The secret functions, as the service role ──────────────────────────────────────
  console.log("twilio_account_secret_put / twilio_account_creds");
  const svc = (sql, params) => as(db, "service_role", () => db.query(sql, params));
  const svcRefused = (sql, params, re) => as(db, "service_role", () => refused(db, sql, params, re));

  for (const [label, args, re] of [
    ["the parent", ["parent-pin", "auth_token", TOKEN_A], /parent account/],
    ["a tenant with no row", ["nobody", "auth_token", TOKEN_A], /no twilio_accounts row/],
    ["a sub with no SID yet", ["new-builder", "auth_token", TOKEN_A], /SID before its secrets/],
    ["an unknown kind", ["sub-builder", "password", TOKEN_A], /p_kind must be/],
    ["a secret that is not a Twilio secret", ["sub-builder", "auth_token", "short"], /not a Twilio secret/],
    ["a secret with a quote in it", ["sub-builder", "auth_token", "abcdefghijklmnop'; drop table x"], /not a Twilio secret/],
  ]) {
    const r = await svcRefused("select public.twilio_account_secret_put($1, $2, $3)", args, re);
    ok(r.refused, `put refuses ${label}`, r.message);
  }
  ok((await one(db, "select count(*)::int n from vault.secrets")).n === 0, "a refused put stores nothing");

  await svc("select public.twilio_account_secret_put($1, 'auth_token', $2)", ["sub-builder", TOKEN_A]);
  await svc("select public.twilio_account_secret_put($1, 'api_secret', $2)", ["sub-builder", KEY_SECRET]);
  const row1 = await one(db, "select auth_token_id, api_secret_id, updated_at from public.twilio_accounts where client_id = 'sub-builder'");
  ok(row1.auth_token_id && row1.api_secret_id, "both Vault ids are written on the row");
  const names = (await db.query("select name from vault.secrets order by name")).rows.map((r) => r.name);
  ok(JSON.stringify(names) === JSON.stringify([`twilio_api_secret_${SUB_SID}`, `twilio_auth_token_${SUB_SID}`]),
    "the secrets are named after the account SID, never the tenant", names.join(", "));
  ok((await one(db, "select count(*)::int n from public.twilio_accounts where auth_token_id is not null or api_secret_id is not null")).n === 1,
    "only the row it was put for points at Vault");

  await svc("select public.twilio_account_secret_put($1, 'auth_token', $2)", ["sub-builder", TOKEN_B]);
  const row2 = await one(db, "select auth_token_id from public.twilio_accounts where client_id = 'sub-builder'");
  ok(row2.auth_token_id === row1.auth_token_id && (await one(db, "select count(*)::int n from vault.secrets")).n === 2,
    "re-putting the auth token (a rotation) replaces it in place: same id, no second secret");

  const bySid = (await svc("select * from public.twilio_account_creds(p_account_sid := $1)", [SUB_SID])).rows;
  ok(bySid.length === 1 && bySid[0].client_id === "sub-builder" && bySid[0].kind === "sub" && bySid[0].status === "active"
    && bySid[0].auth_token === TOKEN_B && bySid[0].api_secret === KEY_SECRET && bySid[0].api_key_sid === KEY_SID,
    "creds by SID: the tenant, the status, the key SID and both decrypted secrets", JSON.stringify(bySid[0]));
  const byTenant = (await svc("select * from public.twilio_account_creds(p_client_id := $1)", ["sub-builder"])).rows;
  ok(byTenant.length === 1 && byTenant[0].account_sid === SUB_SID && byTenant[0].auth_token === TOKEN_B, "creds by tenant: the same account");
  const parentRow = (await svc("select * from public.twilio_account_creds(p_client_id := 'parent-pin')")).rows;
  ok(parentRow.length === 1 && parentRow[0].kind === "parent" && parentRow[0].account_sid === null && parentRow[0].auth_token === null,
    "a parent pin answers kind 'parent' with no SID and no secrets (the caller uses the environment)");
  ok((await svc("select * from public.twilio_account_creds(p_client_id := 'nobody')")).rows.length === 0, "no row: no answer (the caller treats it as the parent)");
  ok((await svc("select * from public.twilio_account_creds(p_account_sid := $1)", [SUB2_SID])).rows.length === 0, "an unknown SID: no answer");
  for (const [label, sql] of [
    ["both arguments", `select * from public.twilio_account_creds('sub-builder', '${SUB_SID}')`],
    ["neither argument", "select * from public.twilio_account_creds()"],
  ]) {
    const r = await svcRefused(sql, [], /exactly one/);
    ok(r.refused, `creds refuses ${label}`, r.message);
  }

  // A secret already in Vault under the account's name (the row lost its id): adopted, not duplicated.
  await db.query("insert into public.twilio_accounts (client_id, kind, account_sid, status) values ('sub-two', 'sub', $1, 'active')", [SUB2_SID]);
  await db.query("select vault.create_secret($1, $2, 'made by hand', null)", [TOKEN_A, `twilio_auth_token_${SUB2_SID}`]);
  await svc("select public.twilio_account_secret_put('sub-two', 'auth_token', $1)", [TOKEN_B]);
  const adopted = await one(db, `select (select count(*)::int from vault.secrets where name = $1) n,
      (select s.secret from vault.secrets s join public.twilio_accounts a on a.auth_token_id = s.id where a.client_id = 'sub-two') v`, [`twilio_auth_token_${SUB2_SID}`]);
  ok(adopted.n === 1 && adopted.v === TOKEN_B, "a secret already in Vault under this account's name is adopted and replaced, never duplicated", JSON.stringify(adopted));

  // Bound to the name: the service role can write the id columns, so a row pointed at ANY other
  // Vault secret (here 256's push webhook secret) must neither read it nor overwrite it.
  const other = (await one(db, "select vault.create_secret('unrelated-push-secret-value', 'sss_phone_push_secret', 'not twilio') id")).id;
  await svc("insert into public.twilio_accounts (client_id, kind, account_sid, status, auth_token_id, api_secret_id) values ('evil-row', 'sub', $1, 'active', $2, $2)", [EVIL_SID, other]);
  const evil = (await svc("select auth_token, api_secret from public.twilio_account_creds(p_client_id := 'evil-row')")).rows[0];
  ok(evil && evil.auth_token === null && evil.api_secret === null, "creds: a row pointed at a secret not named for it reads NULL, never that secret", JSON.stringify(evil));
  await svc("select public.twilio_account_secret_put('evil-row', 'auth_token', $1)", [TOKEN_A]);
  const untouched = await one(db, "select secret, name from vault.secrets where id = $1", [other]);
  ok(untouched.secret === "unrelated-push-secret-value" && untouched.name === "sss_phone_push_secret", "put: never writes through an id that is not this account's secret", JSON.stringify(untouched));
  const repointed = await one(db, "select s.name, s.secret from public.twilio_accounts a join vault.secrets s on s.id = a.auth_token_id where a.client_id = 'evil-row'");
  ok(repointed && repointed.name === `twilio_auth_token_${EVIL_SID}` && repointed.secret === TOKEN_A, "put: the row is re-pointed at its own, correctly named secret", JSON.stringify(repointed));
  // Another sub's own secret is foreign too, Twilio-named or not.
  const subTwoTok = (await one(db, "select auth_token_id id from public.twilio_accounts where client_id = 'sub-two'")).id;
  await db.query("update public.twilio_accounts set api_secret_id = $1 where client_id = 'evil-row'", [subTwoTok]);
  ok((await svc("select api_secret from public.twilio_account_creds(p_client_id := 'evil-row')")).rows[0].api_secret === null,
    "creds: another account's own secret is foreign too");
  await db.query("delete from public.twilio_accounts where client_id = 'evil-row'");
  await db.query("delete from vault.secrets where name in ('sss_phone_push_secret', $1)", [`twilio_auth_token_${EVIL_SID}`]);

  // ── 5. Re-apply: harmless, the rows and secrets kept ─────────────────────────────────
  console.log("re-apply");
  const before = await one(db, "select (select count(*) from public.twilio_accounts)::int a, (select count(*) from vault.secrets)::int s");
  try { await apply(db); ok(true, "292 re-applies cleanly"); } catch (e) { ok(false, "292 re-applies", e.message); }
  const after = await one(db, "select (select count(*) from public.twilio_accounts)::int a, (select count(*) from vault.secrets)::int s");
  ok(JSON.stringify(before) === JSON.stringify(after), "every account row and Vault secret is still there", `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  ok((await svc("select * from public.twilio_account_creds(p_account_sid := $1)", [SUB_SID])).rows[0]?.auth_token === TOKEN_B, "and the creds still read back");

  // ── 6. Mutants: broken copies of the file must refuse to commit ──────────────────────
  console.log("mutants");
  const src = MIG_TEXT();
  const mutants = [
    ["FORCE row level security", (s) => s.replace("alter table public.twilio_accounts no force row level security;", "alter table public.twilio_accounts force row level security;"), /FORCE ROW LEVEL SECURITY/],
    ["the browser roles keep the table", (s) => s.replace("revoke all on public.twilio_accounts from anon, authenticated;", ""), /holds .* on twilio_accounts/],
    ["anon keeps execute on creds", (s) => s.replace("revoke all on function public.twilio_account_creds(text, text) from public, anon, authenticated;", "revoke all on function public.twilio_account_creds(text, text) from public;"), /may execute public\.twilio_account_creds/],
    ["a policy", (s) => s.replace("grant select, insert, update, delete on public.twilio_accounts to service_role;", "grant select, insert, update, delete on public.twilio_accounts to service_role;\ncreate policy m292_open on public.twilio_accounts for select using (true);"), /has a policy/],
    ["a public search_path", (s) => s.replace(/(twilio_account_creds\(p_client_id text default null[\s\S]*?)set search_path to ''/, "$1set search_path to 'public'"), /empty search_path/],
    ["the parent allowed a SID", (s) => s.replace("then account_sid is null and api_key_sid is null", "then api_key_sid is null"), /parent row with an account SID was accepted/],
    ["a put that ignores its row", (s) => s.replace("update public.twilio_accounts set auth_token_id = v_id, updated_at = now() where client_id = p_client_id;", "null;"), /did not give back what was put/],
    ["creds not bound to the secret's name", (s) => s.replace("where s.id = a.auth_token_id and s.name = 'twilio_auth_token_' || a.account_sid)", "where s.id = a.auth_token_id)"), /read a secret that is not named for the row/],
    ["a put not bound to the secret's name", (s) => s.replace("where s.id = v_id and s.name = v_name) then", "where s.id = v_id) then"), /wrote through an id that is not named for the row/],
    ["no guard against a split tenant", (s) => s.replace(/create trigger twilio_accounts_no_split[\s\S]*?execute function public\.twilio_accounts_no_split\(\);/, ""), /no_split trigger is missing/],
    ["no parent pins", (s) => s.replace("on conflict (client_id) do nothing;", "and false on conflict (client_id) do nothing;"), /have no parent pin row/],
    ["holdings open to the browser roles", (s) => s.replace("revoke all on function public.twilio_parent_holdings(text) from public, anon, authenticated;", ""), /may execute twilio_parent_holdings/],
  ];
  for (const [label, mutate, re] of mutants) {
    const m = mutate(src);
    if (m === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    try {
      await apply(mdb, m);
      ok(false, `mutant "${label}" was refused`, "it committed");
    } catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      // The file's own begin; is still open and aborted: end it the way a failed apply ends.
      await mdb.exec("rollback");
      ok((await one(mdb, "select to_regclass('public.twilio_accounts') is null as gone")).gone, `  and left no table behind`);
    }
  }
  // A tenant id that is not a slug cannot have a row: it stays on the parent unpinned, counted.
  const odd = await makeDb();
  await odd.exec("insert into public.client_settings (client_id, sms_number) values ('Odd_Tenant', '+15555550188')");
  const oddRes = await apply(odd);
  ok(oddRes.record && oddRes.record.unpinned_holders === 1 && oddRes.record.parent_pins === 3,
    "a non-slug tenant holding a number is left unpinned and counted (unpinned_holders), not a failed apply", JSON.stringify(oddRes.record));

  const novault = await makeDb({ vault: false });
  try { await apply(novault); ok(false, "a database without Vault is refused", "it committed"); }
  catch (e) { ok(/Vault is not available/.test(e.message), "a database without Vault is refused before anything is created", e.message); }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
