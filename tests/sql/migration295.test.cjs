// Execute migration 295 for real in PGlite (Postgres compiled to WASM, in memory), on top of 292
// and Vault as they are live, then check what it promises: twilio_push_material() returns three
// rows, one per push kind, reading ONLY its five fixed Vault names (nothing else in Vault leaks
// through it, a missing or blank secret reads NULL); twilio_account_forget() removes a parent pin,
// a sub never created at Twilio, and a CLOSED sub with its two Vault secrets (by name only, never a
// secret its id columns were pointed at), and refuses a live or suspended sub; push_skipped takes
// only the three kinds; nobody but the service role may call either function; the apply-time
// rehearsal leaves nothing behind; a re-apply is harmless; and broken copies are refused (mutants).
// Nothing here touches the live project. Every SID and secret below is made up.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration295.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of 295 (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const M292 = () => fs.readFileSync(path.join(WT, "supabase/migrations/292_twilio_accounts.sql"), "utf8");
const MIG_PATH = process.env.MIG_FILE || path.join(WT, "supabase/migrations/295_twilio_provision.sql");
const MIG_TEXT = () => fs.readFileSync(MIG_PATH, "utf8");

const SUB_SID = "AC" + "1".repeat(32);
const LIVE_SID = "AC" + "2".repeat(32);
const TOKEN = "testauthtoken" + "a".repeat(19);
const KEY_SECRET = "testkeysecret" + "c".repeat(19);

// Vault as Supabase ships it, cut to what 292 and 295 use (the same stand-in as migration292.test.cjs).
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

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
${VAULT}
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
insert into public.client_settings (client_id, internal_account) values ('own-account', true);
`;

async function makeDb({ with292 = true } = {}) {
  const db = new PGlite();
  await db.exec(STUBS);
  if (with292) await db.exec(M292());
  return db;
}

async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  const out = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
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
async function as(db, role, fn) {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const svc = (db, sql, params) => as(db, "service_role", () => db.query(sql, params));
const material = async (db) => {
  const rows = (await svc(db, "select * from public.twilio_push_material() order by kind")).rows;
  return Object.fromEntries(rows.map((r) => [r.kind, r]));
};

(async () => {
  // ── 1. Applies on top of 292; the RECORD reads PASS ─────────────────────────────────
  console.log("migration 295: applies on top of 292");
  const db = await makeDb();
  let res;
  try { res = await apply(db); ok(true, "295 applied cleanly, checks and rehearsal included"); }
  catch (e) { ok(false, "295 applied", e.message); process.exit(1); }
  ok(res.notices.some((n) => /295: checks hold/.test(n)), "the checks ran to their notice", res.notices.join(" | "));
  const R = res.record || {};
  ok(R.functions_ready === true && R.column_added === true, "RECORD: functions_ready, column_added", JSON.stringify(R));
  ok(R.material_rows === 3 && R.material_loaded === 0, "RECORD: three material rows, none loaded yet", JSON.stringify(R));
  ok(/^a live sub refused, a closed sub removed with its secret/.test(String(R.rehearsal)), "RECORD: the rehearsal ran to its end", R.rehearsal);
  ok((await one(db, "select count(*)::int n from vault.secrets")).n === 0, "the rehearsal left no Vault secret behind");
  ok((await one(db, "select count(*)::int n from public.twilio_accounts where client_id = 'm295-rehearsal'")).n === 0, "and no rehearsal row");

  // ── 2. twilio_push_material ─────────────────────────────────────────────────────────
  console.log("twilio_push_material");
  let m = await material(db);
  ok(Object.keys(m).join(",") === "apns_dev,apns_prod,fcm", "one row per kind, always", JSON.stringify(Object.keys(m)));
  ok(Object.values(m).every((r) => r.certificate === null && r.private_key === null && r.secret === null), "all NULL with nothing loaded");
  await db.query(`select vault.create_secret('-----BEGIN CERTIFICATE-----prod', 'twilio_push_apns_prod_certificate', 'x'),
                         vault.create_secret('-----BEGIN PRIVATE KEY-----prod', 'twilio_push_apns_prod_private_key', 'x'),
                         vault.create_secret('{"type":"service_account"}', 'twilio_push_fcm_secret', 'x'),
                         vault.create_secret('   ', 'twilio_push_apns_dev_certificate', 'x'),
                         vault.create_secret('not-push-material', 'sss_phone_push_secret', 'x'),
                         vault.create_secret('-----BEGIN PRIVATE KEY-----other', 'twilio_push_apns_dev_private_key_old', 'x')`);
  m = await material(db);
  ok(m.apns_prod.certificate === "-----BEGIN CERTIFICATE-----prod" && m.apns_prod.private_key === "-----BEGIN PRIVATE KEY-----prod",
    "apns_prod: its certificate and key by their names");
  ok(m.fcm.secret === '{"type":"service_account"}' && m.fcm.certificate === null, "fcm: its secret, nothing else");
  ok(m.apns_dev.certificate === null && m.apns_dev.private_key === null,
    "apns_dev: a blank secret reads NULL, and a near-miss name is never read");
  const all = JSON.stringify(Object.values(m));
  ok(!all.includes("not-push-material") && !all.includes("other"), "no other Vault secret comes through it");
  const rec = await one(db, `select (select count(*) from public.twilio_push_material() m
      where (m.kind <> 'fcm' and m.certificate is not null and m.private_key is not null) or (m.kind = 'fcm' and m.secret is not null))::int n`);
  ok(rec.n === 2, "the RECORD's material_loaded counts complete kinds (apns_prod, fcm)", JSON.stringify(rec));
  await db.query("delete from vault.secrets");

  // ── 3. twilio_account_forget ────────────────────────────────────────────────────────
  console.log("twilio_account_forget");
  // 292 pinned own-account (internal).
  ok((await svc(db, "select public.twilio_account_forget('own-account') r")).rows[0].r === "parent_pin", "a parent pin is removed");
  ok((await one(db, "select count(*)::int n from public.twilio_accounts where client_id = 'own-account'")).n === 0, "  and it is gone");
  ok((await svc(db, "select public.twilio_account_forget('nobody') r")).rows[0].r === "none", "no row: none");

  await db.query("insert into public.twilio_accounts (client_id, kind, status, provision_step, last_error) values ('half-made', 'sub', 'failed', 'account', 'account:unreachable')");
  ok((await svc(db, "select public.twilio_account_forget('half-made') r")).rows[0].r === "never_created", "a sub never created at Twilio is removed");

  await db.query("insert into public.twilio_accounts (client_id, kind, account_sid, status, api_key_sid) values ('live-sub', 'sub', $1, 'active', $2)", [LIVE_SID, "SK" + "2".repeat(32)]);
  await svc(db, "select public.twilio_account_secret_put('live-sub', 'auth_token', $1)", [TOKEN]);
  for (const st of ["active", "suspended", "provisioning", "failed"]) {
    await db.query("update public.twilio_accounts set status = $1 where client_id = 'live-sub'", [st]);
    const r = await refused(db, "select public.twilio_account_forget('live-sub')", [], /close it at Twilio first/);
    ok(r.refused, `a sub with a SID that is ${st} is refused`, r.message);
  }
  ok((await one(db, "select count(*)::int n from vault.secrets where name = $1", [`twilio_auth_token_${LIVE_SID}`])).n === 1, "  and its secret is kept");

  await db.query("insert into public.twilio_accounts (client_id, kind, account_sid, status, api_key_sid) values ('closed-sub', 'sub', $1, 'active', $2)", [SUB_SID, "SK" + "1".repeat(32)]);
  await svc(db, "select public.twilio_account_secret_put('closed-sub', 'auth_token', $1)", [TOKEN]);
  await svc(db, "select public.twilio_account_secret_put('closed-sub', 'api_secret', $1)", [KEY_SECRET]);
  // A row pointed at another account's secret: forget must not take it.
  const liveTok = (await one(db, "select auth_token_id id from public.twilio_accounts where client_id = 'live-sub'")).id;
  await db.query("update public.twilio_accounts set status = 'closed', auth_token_id = $1 where client_id = 'closed-sub'", [liveTok]);
  ok((await svc(db, "select public.twilio_account_forget('closed-sub') r")).rows[0].r === "closed_sub", "a closed sub is removed");
  const left = (await db.query("select name from vault.secrets order by 1")).rows.map((r) => r.name);
  ok(JSON.stringify(left) === JSON.stringify([`twilio_auth_token_${LIVE_SID}`]),
    "with its two secrets by name, and never the secret its id was pointed at", JSON.stringify(left));

  // ── 4. push_skipped ─────────────────────────────────────────────────────────────────
  console.log("push_skipped");
  await db.query("update public.twilio_accounts set push_skipped = array['apns_dev','fcm'] where client_id = 'live-sub'");
  ok((await one(db, "select push_skipped p from public.twilio_accounts where client_id = 'live-sub'")).p.join(",") === "apns_dev,fcm", "takes the push kinds");
  ok((await refused(db, "update public.twilio_accounts set push_skipped = array['voip'] where client_id = 'live-sub'", [], /check constraint/)).refused, "refuses anything else");

  // ── 5. Privileges ───────────────────────────────────────────────────────────────────
  console.log("privileges");
  for (const role of ["anon", "authenticated"]) {
    for (const sql of ["select * from public.twilio_push_material()", "select public.twilio_account_forget('live-sub')"]) {
      const r = await as(db, role, () => refused(db, sql, [], /permission denied/));
      ok(r.refused, `${role} may not run ${sql.slice(7, 40)}…`, r.message);
    }
  }

  // ── 6. Re-apply: harmless ───────────────────────────────────────────────────────────
  console.log("re-apply");
  const before = await one(db, "select (select count(*) from public.twilio_accounts)::int a, (select count(*) from vault.secrets)::int s");
  try { await apply(db); ok(true, "295 re-applies cleanly"); } catch (e) { ok(false, "295 re-applies", e.message); }
  const after = await one(db, "select (select count(*) from public.twilio_accounts)::int a, (select count(*) from vault.secrets)::int s");
  ok(JSON.stringify(before) === JSON.stringify(after), "every row and secret is still there", `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  // ── 7. Without 292: refused before anything ─────────────────────────────────────────
  const bare = await makeDb({ with292: false });
  try { await apply(bare); ok(false, "a database without 292 is refused", "it committed"); }
  catch (e) { ok(/migration 292 not applied/.test(e.message), "a database without 292 is refused before anything is created", e.message); }

  // ── 8. Mutants ──────────────────────────────────────────────────────────────────────
  console.log("mutants");
  const src = MIG_TEXT();
  const mutants = [
    ["anon keeps execute on material", (s) => s.replace("revoke all on function public.twilio_push_material() from public, anon, authenticated;", "revoke all on function public.twilio_push_material() from public;"), /may execute public\.twilio_push_material/],
    ["forget open to the browser roles", (s) => s.replace("revoke all on function public.twilio_account_forget(text) from public, anon, authenticated;", ""), /may execute public\.twilio_account_forget/],
    ["forget removes a live sub", (s) => s.replace("if v_row.status <> 'closed' then", "if false then"), /removed a live sub-account/],
    ["forget leaves the secrets", (s) => s.replace(/delete from vault\.secrets s\s+where s\.name in \('twilio_auth_token_'/, "delete from vault.secrets s where false and s.name in ('twilio_auth_token_'"), /did not remove a closed sub and its secret/],
    ["material not a definer", (s) => s.replace(/(returns table \(kind text, certificate text, private_key text, secret text\)\nlanguage sql\nstable\n)security definer\n/, "$1"), /not SECURITY DEFINER/],
  ];
  for (const [label, mutate, re] of mutants) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    try {
      await apply(mdb, mm);
      ok(false, `mutant "${label}" was refused`, "it committed");
    } catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback");
      ok((await one(mdb, "select to_regprocedure('public.twilio_account_forget(text)') is null as gone")).gone, "  and left nothing behind");
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
