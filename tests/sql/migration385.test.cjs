// Execute migration 385 for real in PGlite (Postgres compiled to WASM, in memory), on the four
// tables as 131, 143 and 150 made them and 164 and 194 narrowed them (all lifted from their
// files, not copied), then check what it promises:
//   * before: a signed-in rep whose Contacts level is 'own' reads every note, activity, field
//     change and text in their company (the defect), and 'none' reads nothing (164/194 working);
//   * after: anon and authenticated can't read, insert, update or delete any of the four, at any
//     Contacts level, and hold no table, column or PUBLIC privilege; all eight policies are
//     gone; RLS is still on;
//   * the server side is untouched: service_role reads and writes, an insert still fires its
//     security definer trigger, and a security definer function called by a signed-in user
//     still updates rows in all four (the shape of crm_merge_contacts);
//   * no column or index changes, a re-apply is harmless, the rehearsal (commit swapped for
//     rollback) leaves the old grants in place, a CRLF checkout applies the same, and each
//     assertion really aborts a broken copy (mutants), leaving every table exactly as it was.
// Nothing here touches the live project: no network, no Supabase, no SMS.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration385.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = (f) => path.join(WT, "supabase/migrations", f);
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const RAW385 = () => fs.readFileSync(process.env.MIG_FILE || MIG("385_crm_reads_server_only.sql"), "utf8");
const M385 = () => RAW385().replace(/\r\n/g, "\n");

// Lift [start, end) out of a migration, or [start, end] when `inclusive`. Throws when either
// marker moved, so a rewritten source file breaks this test loudly instead of testing a guess.
function lift(file, start, end, { inclusive = false } = {}) {
  const s = read(MIG(file));
  const a = s.indexOf(start);
  const b = a < 0 ? -1 : s.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`could not lift from ${file}: re-point the markers (${JSON.stringify(start)} .. ${JSON.stringify(end)})`);
  return s.slice(a, inclusive ? b + end.length : b);
}
const BEFORE = () => [
  // 131: crm_notes + crm_activities, their RLS, revoke, grant select and owner policies.
  lift("131_crm_notes_activities.sql", "create table if not exists public.crm_notes (", "-- Belt and braces"),
  // 143: crm_field_changes, likewise.
  lift("143_crm_field_changes.sql", "create table if not exists public.crm_field_changes (", "-- ── The editor"),
  // 150: sms_messages, likewise.
  lift("150_crm_sms.sql", "create table if not exists public.sms_messages (", "comment on table public.sms_messages is"),
  // 164: sms_messages' restrictive Contacts gate.
  lift("164_sms_consent_and_guard.sql", "create policy sms_messages_area_select on public.sms_messages",
    "using (public.current_area_level('contacts') <> 'none');", { inclusive: true }),
  // 194: the other three tables' restrictive Contacts gate.
  lift("194_area_access_rls_extend.sql", "drop policy if exists crm_notes_area_select on public.crm_notes;", "-- ── orders:"),
].join("\n");

const TABLES = ["crm_notes", "crm_activities", "crm_field_changes", "sms_messages"];

// The roles and helpers those migrations lean on, with Supabase's default privileges reproduced
// so a missing revoke shows up as a grant. current_area_level is a stand-in that reads a setting:
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
create table public.crm_contacts (id uuid primary key, client_id text not null);
`;

// What the server side does today, in miniature: a broadcast-style trigger on a new text and a
// security definer merge that moves every row from one contact to another. Here they belong to
// PGlite's superuser. Live they belong to postgres, which is not a superuser but owns the tables
// and has BYPASSRLS (FORCE RLS is off), so a policy-less table lets them through by that route
// instead. Same result.
const SERVER_SIDE = `
create table public.notify_log (id bigint generated always as identity primary key, sms_id uuid);
create or replace function public.sms_notify_stub() returns trigger language plpgsql security definer
  set search_path to '' as $f$
begin
  insert into public.notify_log (sms_id) values (new.id);
  return new;
end $f$;
create trigger sms_notify_stub after insert on public.sms_messages
  for each row execute function public.sms_notify_stub();
create or replace function public.merge_stub(p_client text, p_loser uuid, p_winner uuid) returns integer
  language plpgsql security definer set search_path to '' as $f$
declare n integer; total integer := 0;
begin
  update public.crm_notes set contact_id = p_winner where client_id = p_client and contact_id = p_loser;
  get diagnostics n = row_count; total := total + n;
  update public.crm_activities set contact_id = p_winner where client_id = p_client and contact_id = p_loser;
  get diagnostics n = row_count; total := total + n;
  update public.crm_field_changes set contact_id = p_winner where client_id = p_client and contact_id = p_loser;
  get diagnostics n = row_count; total := total + n;
  update public.sms_messages set contact_id = p_winner where client_id = p_client and contact_id = p_loser;
  get diagnostics n = row_count; total := total + n;
  return total;
end $f$;
grant execute on function public.merge_stub(text, uuid, uuid) to authenticated;
`;

const T1 = "tenant-one-385";
const T2 = "tenant-two-385";
const REP = "00000000-0000-4000-8000-000000000385";
const OTHER = "00000000-0000-4000-8000-000000000386";
const C_MINE = "00000000-0000-4000-8000-0000000003b1";
const C_THEIRS = "00000000-0000-4000-8000-0000000003b2";
const C_ELSEWHERE = "00000000-0000-4000-8000-0000000003b3";
const C_WINNER = "00000000-0000-4000-8000-0000000003b4";
const SEED = `
insert into public.client_users (user_id, client_id) values ('${REP}', '${T1}'), ('${OTHER}', '${T2}');
insert into public.crm_contacts (id, client_id) values
  ('${C_MINE}', '${T1}'), ('${C_THEIRS}', '${T1}'), ('${C_ELSEWHERE}', '${T2}'), ('${C_WINNER}', '${T1}');
insert into public.crm_notes (client_id, contact_id, body) values
  ('${T1}', '${C_MINE}', 'mine'), ('${T1}', '${C_THEIRS}', 'Private'), ('${T2}', '${C_ELSEWHERE}', 'elsewhere');
insert into public.crm_activities (client_id, contact_id, kind, subject) values
  ('${T1}', '${C_MINE}', 'call', 'mine'), ('${T1}', '${C_THEIRS}', 'task', 'Private'), ('${T2}', '${C_ELSEWHERE}', 'call', 'elsewhere');
insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value) values
  ('${T1}', '${C_MINE}', 'phone', 'a', 'mine'), ('${T1}', '${C_THEIRS}', 'phone', 'b', 'Private'), ('${T2}', '${C_ELSEWHERE}', 'phone', 'c', 'elsewhere');
insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body) values
  ('${T1}', '${C_MINE}', 'in', '+15550000001', '+15550000009', 'mine'),
  ('${T1}', '${C_THEIRS}', 'in', '+15550000002', '+15550000009', 'Private'),
  ('${T2}', '${C_ELSEWHERE}', 'in', '+15550000003', '+15550000008', 'elsewhere');
`;
// The column that holds each seed row's marker text ('mine', 'Private', 'elsewhere').
const TEXT_COL = { crm_notes: "body", crm_activities: "subject", crm_field_changes: "new_value", sms_messages: "body" };

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
  await db.exec(BEFORE());
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
const msg = (r) => (r.error ? r.error.message : JSON.stringify(r.rows));

const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
async function posture(db) {
  const out = {};
  for (const t of TABLES) {
    const priv = {};
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const p of PRIVS) {
        priv[`${role}:${p}`] = (await rows(db, `select has_table_privilege('${role}', 'public.${t}', '${p}') v`))[0].v;
      }
      priv[`${role}:anycol`] = (await rows(db, `select has_any_column_privilege('${role}', 'public.${t}', 'SELECT') v`))[0].v;
    }
    const pol = (await rows(db, `select policyname from pg_policies where schemaname='public' and tablename='${t}' order by 1`)).map((r) => r.policyname);
    const rls = (await rows(db, `select relrowsecurity v from pg_class where oid='public.${t}'::regclass`))[0].v;
    const pub = (await rows(db, `select count(*)::int n from pg_class c, aclexplode(c.relacl) a where c.oid='public.${t}'::regclass and a.grantee=0`))[0].n;
    out[t] = { priv, pol, rls, pub };
  }
  return out;
}
const apiRoleHoldsNothing = (p) => ["anon", "authenticated"].every((r) => PRIVS.every((x) => !p.priv[`${r}:${x}`]) && !p.priv[`${r}:anycol`]);
const asBefore = (p) => p.priv["authenticated:SELECT"] === true && p.pol.length === 2;
async function shape(db) {
  const cols = await rows(db, `select table_name, string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) c
    from information_schema.columns where table_schema='public' and table_name = any(array['${TABLES.join("','")}']) group by 1 order by 1`);
  const idx = await rows(db, `select tablename, string_agg(indexname, ',' order by indexname) i
    from pg_indexes where schemaname='public' and tablename = any(array['${TABLES.join("','")}']) group by 1 order by 1`);
  return JSON.stringify([cols, idx]);
}

(async () => {
  // ── 0. Before: the gap is real, and 164/194 still do their part ───────────────────────────
  const db = await fresh();
  for (const t of TABLES) {
    const own0 = await as(db, "authenticated", { uid: REP, level: "own" }, `select ${TEXT_COL[t]} v from public.${t} order by 1`);
    ok(!own0.error && own0.rows.length === 2 && own0.rows.some((r) => r.v === "Private"),
      `before 385, an 'own' rep reads every ${t} row in their company, including a customer assigned to someone else (the defect)`, msg(own0));
    const none0 = await as(db, "authenticated", { uid: REP, level: "none" }, `select count(*)::int n from public.${t}`);
    ok(!none0.error && none0.rows[0].n === 0, `before 385, Contacts 'none' reads no ${t} (the restrictive area policy)`, msg(none0));
  }
  const p0 = await posture(db);
  ok(TABLES.every((t) => asBefore(p0[t])), "before 385, authenticated holds SELECT under two policies on each table", JSON.stringify(p0));
  const shape0 = await shape(db);

  // ── 1. Apply ────────────────────────────────────────────────────────────────────────────
  try { await db.exec(M385()); ok(true, "385 applied"); } catch (e) { ok(false, "385 applied", e.message); await closeAll(); process.exitCode = 1; return; }

  // ── 2. The browser roles are shut out, at every level, on every table ───────────────────
  for (const t of TABLES) {
    for (const level of ["own", "own_view", "view", "edit"]) {
      const r = await as(db, "authenticated", { uid: REP, level }, `select ${TEXT_COL[t]} from public.${t}`);
      ok(denied(r), `a signed-in user at Contacts '${level}' is refused the ${t} read`, msg(r));
    }
    const anonRead = await as(db, "anon", {}, `select count(*) from public.${t}`);
    ok(denied(anonRead), `anon is refused the ${t} read`, msg(anonRead));
    const writes = {
      insert: `insert into public.${t} (client_id) values ('${T1}')`,
      update: `update public.${t} set contact_id = '${C_MINE}' where client_id = '${T1}'`,
      delete: `delete from public.${t} where client_id = '${T1}'`,
    };
    for (const [what, sql] of Object.entries(writes)) {
      const r = await as(db, "authenticated", { uid: REP, level: "edit" }, sql);
      ok(denied(r), `a signed-in user is refused ${what} on ${t}`, r.error ? r.error.message : "it ran");
    }
  }
  const p1 = await posture(db);
  for (const t of TABLES) {
    ok(apiRoleHoldsNothing(p1[t]), `anon and authenticated hold no table or column privilege on ${t}`, JSON.stringify(p1[t].priv));
    ok(p1[t].pub === 0, `PUBLIC holds nothing on ${t}`, String(p1[t].pub));
    ok(p1[t].pol.length === 0, `both SELECT policies are gone from ${t}`, JSON.stringify(p1[t].pol));
    ok(p1[t].rls === true, `row level security is still on for ${t} (deny by default)`);
  }

  // ── 3. The server side is untouched ─────────────────────────────────────────────────────
  for (const t of TABLES) {
    ok(["SELECT", "INSERT", "UPDATE", "DELETE"].every((x) => p1[t].priv[`service_role:${x}`]), `service_role keeps select, insert, update and delete on ${t}`, JSON.stringify(p1[t].priv));
    const svcRead = await as(db, "service_role", {}, `select count(*)::int n from public.${t}`);
    ok(!svcRead.error && svcRead.rows[0].n === 3, `service_role reads every ${t} row, both tenants (the feed, the inbox, the Worker)`, msg(svcRead));
  }
  const svcIns = await as(db, "service_role", {}, `insert into public.sms_messages (client_id, contact_id, direction, from_number, to_number, body) values ('${T1}', '${C_MINE}', 'in', '+15550000004', '+15550000009', 'a new text') returning id`);
  ok(!svcIns.error && svcIns.rows.length === 1, "service_role inserts a text (the sms-inbound webhook)", msg(svcIns));
  const fired = svcIns.rows ? await rows(db, `select count(*)::int n from public.notify_log where sms_id = '${svcIns.rows[0].id}'`) : [{ n: 0 }];
  ok(fired[0].n === 1, "...and its security definer trigger still fires (the phone broadcast and push)", JSON.stringify(fired));
  const svcNote = await as(db, "service_role", {}, `insert into public.crm_notes (client_id, contact_id, body) values ('${T1}', '${C_MINE}', 'a new note') returning id`);
  ok(!svcNote.error && svcNote.rows.length === 1, "service_role inserts a note (portal-settings)", msg(svcNote));
  const merged = await as(db, "authenticated", { uid: REP, level: "edit" }, `select public.merge_stub('${T1}', '${C_MINE}', '${C_WINNER}') n`);
  ok(!merged.error && merged.rows[0].n === 6, "a security definer function called by a signed-in user still moves rows in all four tables (crm_merge_contacts' shape)", msg(merged));
  const svcUpd = await as(db, "service_role", {}, `update public.sms_messages set contact_id = '${C_MINE}' where contact_id = '${C_WINNER}'`);
  ok(!svcUpd.error, "service_role updates rows (re-filing a text)", msg(svcUpd));
  const svcDel = await as(db, "service_role", {}, `delete from public.crm_activities where client_id = '${T2}'`);
  ok(!svcDel.error, "service_role deletes rows (tenant purge)", msg(svcDel));
  ok((await shape(db)) === shape0, "no column or index changed on any of the four tables");

  // ── 4. Re-apply ─────────────────────────────────────────────────────────────────────────
  try { await db.exec(M385()); ok(true, "a re-apply runs"); } catch (e) { ok(false, "a re-apply runs", e.message); }
  const p2 = await posture(db);
  ok(JSON.stringify(p2) === JSON.stringify(p1), "...and leaves the same posture", JSON.stringify([p1, p2]));

  // ── 5. Rehearsal: commit swapped for rollback leaves the old grants ─────────────────────
  const r = await fresh();
  const rehearsal = M385().replace(/\ncommit;\s*$/, "\nrollback;\n");
  ok(rehearsal !== M385(), "the rehearsal copy differs (the file ends with commit;)");
  try { await r.exec(rehearsal); ok(true, "the rehearsal runs"); } catch (e) { ok(false, "the rehearsal runs", e.message); }
  const pr = await posture(r);
  ok(TABLES.every((t) => asBefore(pr[t])), "...and leaves authenticated's SELECT and both policies on every table: nothing escaped the transaction", JSON.stringify(pr));

  // ── 6. CRLF ─────────────────────────────────────────────────────────────────────────────
  const c = await fresh();
  try { await c.exec(M385().replace(/\n/g, "\r\n")); ok(true, "a CRLF copy applies"); } catch (e) { ok(false, "a CRLF copy applies", e.message); }
  const pc = await posture(c);
  ok(TABLES.every((t) => apiRoleHoldsNothing(pc[t]) && pc[t].pol.length === 0), "...with the same result");

  // ── 7. Mutants: each assertion aborts a broken copy, and every table is left as it was ──
  const before = (anchor, extra) => (s) => s.replace(anchor, `${extra}\n${anchor}`);
  const FIRST_DROP = "drop policy if exists crm_notes_owner_select";
  const MUTANTS = [
    ["no revoke on sms_messages", (s) => s.replace("revoke all on public.sms_messages      from public, anon, authenticated;", ""), /authenticated still has SELECT on (public\.)?sms_messages/],
    ["crm_notes revoke misses authenticated", (s) => s.replace("revoke all on public.crm_notes         from public, anon, authenticated;", "revoke all on public.crm_notes from public, anon;"), /authenticated still has SELECT on (public\.)?crm_notes/],
    ["a column grant slipped back", before(FIRST_DROP, "grant select (new_value) on public.crm_field_changes to authenticated;"), /column-level SELECT on (public\.)?crm_field_changes/],
    ["MAINTAIN granted back", before(FIRST_DROP, "grant maintain on public.crm_activities to authenticated;"), /authenticated still has MAINTAIN on (public\.)?crm_activities/],
    ["PUBLIC granted back", before(FIRST_DROP, "grant references on public.sms_messages to public;"), /still has REFERENCES on (public\.)?sms_messages|PUBLIC still holds/],
    ["owner policy kept", (s) => s.replace("drop policy if exists crm_activities_owner_select    on public.crm_activities;", ""), /policies still on (public\.)?crm_activities: crm_activities_owner_select/],
    ["area policy kept", (s) => s.replace("drop policy if exists sms_messages_area_select       on public.sms_messages;", ""), /policies still on (public\.)?sms_messages: sms_messages_area_select/],
    ["RLS switched off", (s) => s.replace("alter table public.crm_field_changes enable row level security;", "alter table public.crm_field_changes disable row level security;"), /row level security is off on (public\.)?crm_field_changes/],
    ["a table left out of the checks", (s) => s.replace("array['crm_notes', 'crm_activities', 'crm_field_changes', 'sms_messages'] loop", "array['crm_notes', 'crm_activities', 'crm_field_changes'] loop").replace("revoke all on public.sms_messages      from public, anon, authenticated;", ""), null],
    ["service_role revoked too", (s) => s.replace("revoke all on public.crm_notes         from public, anon, authenticated;", "revoke all on public.crm_notes from public, anon, authenticated, service_role;"), /service_role lost SELECT on (public\.)?crm_notes/],
  ];
  for (const [name, mutate, expect] of MUTANTS) {
    const m = await fresh();
    const text = mutate(M385());
    if (text === M385()) { ok(false, `mutant "${name}" changed the text`, "the replace found nothing: re-point it"); continue; }
    let err = null;
    try { await m.exec(text); } catch (e) { err = e; }
    if (expect === null) {
      // Proves the loop list is what guards sms_messages: drop it from the list and the missing
      // revoke goes unnoticed. The real file keeps all four (checked against the text below).
      ok(!err, `mutant "${name}" applies silently (so the list in the checks matters)`, err ? err.message : "");
      continue;
    }
    ok(!!err && expect.test(err.message || ""), `mutant "${name}" is refused by its assertion`, err ? err.message : "it applied");
    try { await m.exec("rollback"); } catch (_e) { /* the failed transaction is already gone */ }
    const pm = await posture(m);
    ok(TABLES.every((t) => asBefore(pm[t])), "...and leaves every table as 131-194 left it", JSON.stringify(pm));
  }
  ok(M385().includes("foreach v_table in array array['crm_notes', 'crm_activities', 'crm_field_changes', 'sms_messages'] loop"),
    "the assertion loop names all four tables");

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
