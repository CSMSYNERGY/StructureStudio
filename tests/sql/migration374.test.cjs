// Execute migration 374 for real in PGlite (Postgres compiled to WASM, in memory), on
// email_inbound as 135 made it and 194 narrowed it (both lifted from their files, not copied),
// then check what it promises:
//   * before: a signed-in rep whose Contacts level is 'own' reads every reply in their company
//     (the defect), and 'none' reads nothing (194 working);
//   * after: anon and authenticated can't read, insert, update or delete, at any Contacts level,
//     and hold no table, column or PUBLIC privilege; both policies are gone; RLS is still on;
//   * the server side is untouched: service_role reads and writes, an insert still fires its
//     trigger, and a security definer function called by a signed-in user still updates rows
//     (the shape of crm_merge_contacts);
//   * a re-apply is harmless, the rehearsal (commit swapped for rollback) leaves 135's grant in
//     place, a CRLF checkout applies the same, and each assertion really aborts a broken copy
//     (mutants), leaving the table exactly as it was.
// Nothing here touches the live project: no network, no Supabase, no email.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration374.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const M135 = () => read(path.join(WT, "supabase/migrations/135_email_inbound.sql"));
const RAW374 = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/374_email_inbound_server_only.sql"), "utf8");
const M374 = () => RAW374().replace(/\r\n/g, "\n");

// 194's email_inbound policy, lifted from the file so the "before" state is the real one.
function policy194() {
  const s = read(path.join(WT, "supabase/migrations/194_area_access_rls_extend.sql"));
  const a = s.indexOf("drop policy if exists email_inbound_area_select on public.email_inbound;");
  const b = s.indexOf("using (public.current_area_level('contacts') <> 'none');", a);
  if (a < 0 || b < 0) throw new Error("could not lift 194's email_inbound policy: re-point policy194()");
  return s.slice(a, b + "using (public.current_area_level('contacts') <> 'none');".length);
}

// The roles and helpers 135 and 194 lean on, with Supabase's default privileges reproduced so a
// missing revoke shows up as a grant. current_area_level is a stand-in that reads a setting:
// 154's real resolver is tested by its own file, and here only its answer matters.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;

create table public.client_users (user_id uuid primary key, client_id text not null);
create or replace function public.current_client_id() returns text language sql stable security definer
  set search_path to '' as $f$
  select client_id from public.client_users where user_id = (select auth.uid()) limit 1
$f$;
create or replace function public.current_area_level(p_area text) returns text language sql stable security definer
  set search_path to '' as $f$
  select coalesce(nullif(current_setting('test.contacts_level', true), ''), 'edit')
$f$;
`;

// What the server side does today, in miniature: a broadcast-style trigger on insert and a
// security definer merge. Here they belong to PGlite's superuser. Live they belong to postgres,
// which is not a superuser but owns the table and has BYPASSRLS (FORCE RLS is off), so a
// policy-less table lets them through by that route instead. Same result.
const SERVER_SIDE = `
create table public.notify_log (id bigint generated always as identity primary key, inbound_id uuid);
create or replace function public.inbound_notify_stub() returns trigger language plpgsql security definer
  set search_path to '' as $f$
begin
  insert into public.notify_log (inbound_id) values (new.id);
  return new;
end $f$;
create trigger inbound_notify_stub after insert on public.email_inbound
  for each row execute function public.inbound_notify_stub();
create or replace function public.merge_stub(p_client text, p_loser uuid, p_winner uuid) returns integer
  language plpgsql security definer set search_path to '' as $f$
declare n integer;
begin
  update public.email_inbound set contact_id = p_winner where client_id = p_client and contact_id = p_loser;
  get diagnostics n = row_count;
  return n;
end $f$;
grant execute on function public.merge_stub(text, uuid, uuid) to authenticated;
`;

const T1 = "tenant-one-374";
const T2 = "tenant-two-374";
const REP = "00000000-0000-4000-8000-000000000374";
const OTHER = "00000000-0000-4000-8000-000000000375";
const C_MINE = "00000000-0000-4000-8000-0000000003a1";
const C_THEIRS = "00000000-0000-4000-8000-0000000003a2";
const C_ELSEWHERE = "00000000-0000-4000-8000-0000000003a3";
const C_WINNER = "00000000-0000-4000-8000-0000000003a4";
const SEED = `
insert into public.client_users (user_id, client_id) values ('${REP}', '${T1}'), ('${OTHER}', '${T2}');
insert into public.email_inbound (client_id, contact_id, from_email, subject, body_text) values
  ('${T1}', '${C_MINE}',      'mine@example.test',      'About my shed',  'Assigned to the rep.'),
  ('${T1}', '${C_THEIRS}',    'theirs@example.test',    'Private',        'Assigned to someone else.'),
  ('${T2}', '${C_ELSEWHERE}', 'elsewhere@example.test', 'Other company',  'Another tenant.');
`;

let failures = 0;
const ok = (cond, name, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? `   [${detail}]` : ""}`);
};
// Every instance is closed, and the run ends by process.exitCode rather than process.exit:
// forcing exit with PGlite's handles in flight trips libuv's UV_HANDLE_CLOSING assertion on
// Windows, and the run exits 127 after printing a pass.
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function fresh() {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(M135());
  await db.exec(policy194());
  await db.exec(SERVER_SIDE);
  await db.exec(SEED);
  return db;
}
const rows = async (db, sql) => (await db.query(sql)).rows;

// Run one statement as a signed-in user (or anon), at a Contacts level, and always come back.
async function as(db, role, { uid = null, level = "edit" } = {}, sql) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid || ""}', false), set_config('test.contacts_level', '${level}', false)`);
  await db.exec(`set role ${role}`);
  try { return { rows: (await db.query(sql)).rows, error: null }; }
  catch (e) { return { rows: null, error: e }; }
  finally { await db.exec("reset role"); }
}
const denied = (r) => !!r.error && /permission denied/i.test(r.error.message || "");

const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
async function posture(db) {
  const priv = {};
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const p of PRIVS) {
      priv[`${role}:${p}`] = (await rows(db, `select has_table_privilege('${role}', 'public.email_inbound', '${p}') v`))[0].v;
    }
    priv[`${role}:anycol`] = (await rows(db, `select has_any_column_privilege('${role}', 'public.email_inbound', 'SELECT') v`))[0].v;
  }
  const pol = (await rows(db, "select policyname from pg_policies where schemaname='public' and tablename='email_inbound' order by 1")).map((r) => r.policyname);
  const rls = (await rows(db, "select relrowsecurity v from pg_class where oid='public.email_inbound'::regclass"))[0].v;
  const pub = (await rows(db, "select count(*)::int n from pg_class c, aclexplode(c.relacl) a where c.oid='public.email_inbound'::regclass and a.grantee=0"))[0].n;
  return { priv, pol, rls, pub };
}
const apiRoleHoldsNothing = (p) => ["anon", "authenticated"].every((r) => PRIVS.every((x) => !p.priv[`${r}:${x}`]) && !p.priv[`${r}:anycol`]);

(async () => {
  // ── 0. Before: the gap is real, and 194 still does its part ──────────────────────────────
  const db = await fresh();
  const own0 = await as(db, "authenticated", { uid: REP, level: "own" }, "select subject, body_text from public.email_inbound order by subject");
  ok(!own0.error && own0.rows.length === 2 && own0.rows.some((r) => r.subject === "Private"),
    "before 374, an 'own' rep reads every reply in their company, including a customer assigned to someone else (the defect)",
    JSON.stringify(own0.error ? own0.error.message : own0.rows));
  const none0 = await as(db, "authenticated", { uid: REP, level: "none" }, "select count(*)::int n from public.email_inbound");
  ok(!none0.error && none0.rows[0].n === 0, "before 374, Contacts 'none' reads nothing (194's restrictive policy)", JSON.stringify(none0));
  const p0 = await posture(db);
  ok(p0.priv["authenticated:SELECT"] === true && p0.pol.length === 2, "before 374, authenticated holds SELECT under two policies", JSON.stringify(p0));

  // ── 1. Apply ────────────────────────────────────────────────────────────────────────────
  try { await db.exec(M374()); ok(true, "374 applied"); } catch (e) { ok(false, "374 applied", e.message); await closeAll(); process.exitCode = 1; return; }

  // ── 2. The browser roles are shut out, at every level ───────────────────────────────────
  for (const level of ["own", "team", "edit"]) {
    const r = await as(db, "authenticated", { uid: REP, level }, "select subject from public.email_inbound");
    ok(denied(r), `a signed-in user at Contacts '${level}' is refused the read`, r.error ? r.error.message : JSON.stringify(r.rows));
  }
  const anonRead = await as(db, "anon", {}, "select subject from public.email_inbound");
  ok(denied(anonRead), "anon is refused the read", anonRead.error ? anonRead.error.message : JSON.stringify(anonRead.rows));
  const writes = {
    insert: `insert into public.email_inbound (client_id, from_email) values ('${T1}', 'forged@example.test')`,
    update: `update public.email_inbound set subject = 'changed' where client_id = '${T1}'`,
    delete: `delete from public.email_inbound where client_id = '${T1}'`,
  };
  for (const [what, sql] of Object.entries(writes)) {
    const r = await as(db, "authenticated", { uid: REP, level: "edit" }, sql);
    ok(denied(r), `a signed-in user is refused ${what}`, r.error ? r.error.message : "it ran");
  }
  const p1 = await posture(db);
  ok(apiRoleHoldsNothing(p1), "anon and authenticated hold no table or column privilege", JSON.stringify(p1.priv));
  ok(p1.pub === 0, "PUBLIC holds nothing on the table", String(p1.pub));
  ok(p1.pol.length === 0, "both SELECT policies are gone", JSON.stringify(p1.pol));
  ok(p1.rls === true, "row level security is still on (deny by default)");

  // ── 3. The server side is untouched ─────────────────────────────────────────────────────
  ok(["SELECT", "INSERT", "UPDATE", "DELETE"].every((x) => p1.priv[`service_role:${x}`]), "service_role keeps select, insert, update and delete", JSON.stringify(p1.priv));
  const svcRead = await as(db, "service_role", {}, "select count(*)::int n from public.email_inbound");
  ok(!svcRead.error && svcRead.rows[0].n === 3, "service_role reads every row, both tenants (the feed, the inbox list, the Worker)", JSON.stringify(svcRead));
  const svcIns = await as(db, "service_role", {}, `insert into public.email_inbound (client_id, contact_id, from_email, subject) values ('${T1}', '${C_MINE}', 'new@example.test', 'A new reply') returning id`);
  ok(!svcIns.error && svcIns.rows.length === 1, "service_role inserts a reply (the email-inbound webhook)", svcIns.error ? svcIns.error.message : "");
  const fired = svcIns.rows ? await rows(db, `select count(*)::int n from public.notify_log where inbound_id = '${svcIns.rows[0].id}'`) : [{ n: 0 }];
  ok(fired[0].n === 1, "...and its security definer trigger still fires (the phone broadcast and push)", JSON.stringify(fired));
  const merged = await as(db, "authenticated", { uid: REP, level: "edit" }, `select public.merge_stub('${T1}', '${C_MINE}', '${C_WINNER}') n`);
  ok(!merged.error && merged.rows[0].n === 2, "a security definer function called by a signed-in user still updates rows (crm_merge_contacts' shape)", merged.error ? merged.error.message : JSON.stringify(merged.rows));
  const svcUpd = await as(db, "service_role", {}, `update public.email_inbound set contact_id = '${C_MINE}' where contact_id = '${C_WINNER}'`);
  ok(!svcUpd.error, "service_role updates rows (re-filing a reply)", svcUpd.error ? svcUpd.error.message : "");
  const cols = await rows(db, "select count(*)::int n from information_schema.columns where table_schema='public' and table_name='email_inbound'");
  const idx = await rows(db, "select count(*)::int n from pg_indexes where schemaname='public' and tablename='email_inbound'");
  ok(cols[0].n === 17 && idx[0].n === 5, "no column or index changed (17 columns, 5 indexes as 135 made them)", JSON.stringify([cols, idx]));

  // ── 4. Re-apply ─────────────────────────────────────────────────────────────────────────
  try { await db.exec(M374()); ok(true, "a re-apply runs"); } catch (e) { ok(false, "a re-apply runs", e.message); }
  const p2 = await posture(db);
  ok(JSON.stringify(p2) === JSON.stringify(p1), "...and leaves the same posture", JSON.stringify([p1, p2]));

  // ── 5. Rehearsal: commit swapped for rollback leaves 135's grant ────────────────────────
  const r = await fresh();
  const rehearsal = M374().replace(/\ncommit;\s*$/, "\nrollback;\n");
  ok(rehearsal !== M374(), "the rehearsal copy differs (the file ends with commit;)");
  try { await r.exec(rehearsal); ok(true, "the rehearsal runs"); } catch (e) { ok(false, "the rehearsal runs", e.message); }
  const pr = await posture(r);
  ok(pr.priv["authenticated:SELECT"] === true && pr.pol.length === 2, "...and leaves authenticated's SELECT and both policies: nothing escaped the transaction", JSON.stringify(pr));

  // ── 6. CRLF ─────────────────────────────────────────────────────────────────────────────
  const c = await fresh();
  try { await c.exec(M374().replace(/\n/g, "\r\n")); ok(true, "a CRLF copy applies"); } catch (e) { ok(false, "a CRLF copy applies", e.message); }
  ok(apiRoleHoldsNothing(await posture(c)), "...with the same result");

  // ── 7. Mutants: each assertion aborts a broken copy, and the table is left as it was ────
  const MUTANTS = [
    ["no revoke", (s) => s.replace("revoke all on public.email_inbound from public, anon, authenticated;", ""), /authenticated still has SELECT/],
    ["revoke misses authenticated", (s) => s.replace("from public, anon, authenticated;", "from public, anon;"), /authenticated still has SELECT/],
    ["a column grant slipped back", (s) => s.replace("drop policy if exists email_inbound_owner_select", "grant select (subject) on public.email_inbound to authenticated;\ndrop policy if exists email_inbound_owner_select"), /column-level SELECT/],
    ["MAINTAIN granted back", (s) => s.replace("drop policy if exists email_inbound_owner_select", "grant maintain on public.email_inbound to authenticated;\ndrop policy if exists email_inbound_owner_select"), /authenticated still has MAINTAIN/],
    ["PUBLIC granted back",(s) => s.replace("drop policy if exists email_inbound_owner_select", "grant references on public.email_inbound to public;\ndrop policy if exists email_inbound_owner_select"), /still has REFERENCES|PUBLIC still holds/],
    ["owner policy kept", (s) => s.replace("drop policy if exists email_inbound_owner_select on public.email_inbound;", ""), /policies still on public.email_inbound: email_inbound_owner_select/],
    ["area policy kept", (s) => s.replace("drop policy if exists email_inbound_area_select on public.email_inbound;", ""), /policies still on public.email_inbound: email_inbound_area_select/],
    ["RLS switched off", (s) => s.replace("alter table public.email_inbound enable row level security;", "alter table public.email_inbound disable row level security;"), /row level security is off/],
    ["service_role revoked too", (s) => s.replace("from public, anon, authenticated;", "from public, anon, authenticated, service_role;"), /service_role lost SELECT/],
  ];
  for (const [name, mutate, expect] of MUTANTS) {
    const m = await fresh();
    const text = mutate(M374());
    if (text === M374()) { ok(false, `mutant "${name}" changed the text`, "the replace found nothing: re-point it"); continue; }
    let err = null;
    try { await m.exec(text); } catch (e) { err = e; }
    ok(!!err && expect.test(err.message || ""), `mutant "${name}" is refused by its assertion`, err ? err.message : "it applied");
    try { await m.exec("rollback"); } catch (_e) { /* the failed transaction is already gone */ }
    const pm = await posture(m);
    ok(pm.priv["authenticated:SELECT"] === true && pm.pol.length === 2, `...and leaves the table as 135 and 194 left it`, JSON.stringify(pm));
  }

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
