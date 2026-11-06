// Execute migration 340 (the support assistant: support_conversations, support_messages, the 'ticket'
// kind, client_settings.support_ai_daily_cap and support_usage()) for real in PGlite (Postgres compiled
// to WASM, in memory) on top of the two tables it alters, cut to their live columns (read 2026-10-27).
// Then check what the file promises:
//   * both support tables exist with RLS on, NO policy, and nothing a browser role can read; the
//     usage function is service-role only;
//   * a 'ticket' row inserts, bug and feature still insert, anything else is refused;
//   * a message over 8,000 characters, or with a role other than user/assistant, is refused;
//   * deleting a chat takes its messages; deleting a ticket or a chat only unlinks the other side;
//   * our own (internal) tenants get an unlimited cap, every other tenant keeps NULL (the default);
//   * support_usage counts only the builder's own messages: the tenant's last 24 h, the user's last
//     10 minutes, and the whole month's cost across every tenant;
//   * a re-apply changes nothing (a cap someone set by hand survives), the header's ROLLBACK undoes
//     it and the file applies again after it;
//   * a file that would leave out 'ticket', or add a browser policy, aborts the whole batch (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration340.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const FILE = path.join(WT, "supabase/migrations/340_support_agent.sql");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || FILE, "utf8").replace(/\r/g, "");

// The header's ROLLBACK, lifted from the file itself so the test exercises the text a person would run.
const ROLLBACK = (() => {
  const t = MIG();
  const i = t.indexOf("-- ROLLBACK");
  const j = t.indexOf("\n\n", i);
  if (i < 0 || j < 0) throw new Error("340's ROLLBACK block moved; re-point the test");
  return t.slice(i, j).split("\n").slice(1).map((l) => l.replace(/^--\s?/, "")).join("\n");
})();

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create table public.client_settings (
  client_id text primary key,
  internal_account boolean not null default false,
  ai_style_daily_cap integer
);
create table public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  client_id text,
  submitted_by uuid,
  submitter_name text not null,
  submitter_email text,
  kind text not null check (kind in ('bug','feature')),
  title text not null,
  detail text,
  severity text,
  attachment_path text,
  status text not null default 'submitted'
    check (status in ('submitted','in_review','planned','in_progress','needs_info','shipped','declined','duplicate')),
  monday_item_id text,
  monday_board_id text,
  monday_error text,
  created_at timestamptz not null default now(),
  status_changed_at timestamptz,
  updated_at timestamptz not null default now(),
  source_app text,
  source_ref text
);
-- The project's default privileges hand every new table to PUBLIC; mimic that so the revoke is tested.
grant all on all tables in schema public to public;
alter default privileges in schema public grant all on tables to public;
alter default privileges in schema public grant execute on functions to public;
insert into public.client_settings (client_id, internal_account) values
  ('our-own', true), ('builder-a', false), ('builder-b', false);
`;

const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000a2";
const U3 = "00000000-0000-4000-8000-0000000000b1";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) fails++; };
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const refused = async (db, sql, params) => {
  try { await db.query(sql, params); return false; } catch { return true; }
};

async function fresh() {
  const db = new PGlite();
  await db.exec(STUBS);
  return db;
}

async function main() {
  // ── apply ───────────────────────────────────────────────────────────────────────────────────
  const db = await fresh();
  await db.exec(MIG());

  const rls = await db.query(`select relname, relrowsecurity from pg_class where relname in ('support_conversations','support_messages') order by 1`);
  check(rls.rows.length === 2 && rls.rows.every((r) => r.relrowsecurity), "both support tables exist with RLS on");
  const pol = await one(db, `select count(*)::int n from pg_policies where tablename in ('support_conversations','support_messages')`);
  check(pol.n === 0, "no policy on either support table");
  for (const role of ["anon", "authenticated"]) {
    for (const t of ["support_conversations", "support_messages"]) {
      for (const priv of ["select", "insert", "update", "delete"]) {
        const r = await one(db, `select has_table_privilege($1, $2, $3) ok`, [role, `public.${t}`, priv]);
        check(!r.ok, `${role} has no ${priv} on ${t}`);
      }
    }
    const f = await one(db, `select has_function_privilege($1, 'public.support_usage(text, uuid)', 'execute') ok`, [role]);
    check(!f.ok, `${role} cannot run support_usage`);
  }
  const sr = await one(db, `select has_table_privilege('service_role', 'public.support_messages', 'insert') a,
    has_function_privilege('service_role', 'public.support_usage(text, uuid)', 'execute') b`);
  check(sr.a && sr.b, "service_role can write the tables and run support_usage");

  // ── tickets ─────────────────────────────────────────────────────────────────────────────────
  for (const kind of ["bug", "feature", "ticket"]) {
    const ok = !(await refused(db, `insert into feedback_submissions (client_id, submitter_name, kind, title) values ('builder-a', 'Pat', $1, 'x')`, [kind]));
    check(ok, `a '${kind}' submission inserts`);
  }
  check(await refused(db, `insert into feedback_submissions (client_id, submitter_name, kind, title) values ('builder-a', 'Pat', 'question', 'x')`),
    "an unknown kind is still refused");

  // ── caps on the tenant ──────────────────────────────────────────────────────────────────────
  const caps = await db.query(`select client_id, support_ai_daily_cap cap from client_settings order by client_id`);
  const capOf = Object.fromEntries(caps.rows.map((r) => [r.client_id, r.cap]));
  check(capOf["our-own"] === 0, "the internal tenant is unlimited (0)");
  check(capOf["builder-a"] === null && capOf["builder-b"] === null, "every other tenant keeps NULL (the default of 60)");

  // ── messages and the cascade ────────────────────────────────────────────────────────────────
  const c1 = (await one(db, `insert into support_conversations (client_id, user_id) values ('builder-a', $1) returning id`, [U1])).id;
  check(await refused(db, `insert into support_messages (conversation_id, client_id, user_id, role, body) values ($1, 'builder-a', $2, 'user', $3)`, [c1, U1, "x".repeat(8001)]),
    "a message over 8,000 characters is refused");
  check(!(await refused(db, `insert into support_messages (conversation_id, client_id, user_id, role, body) values ($1, 'builder-a', $2, 'user', $3)`, [c1, U1, "x".repeat(8000)])),
    "a message of exactly 8,000 characters inserts");
  check(await refused(db, `insert into support_messages (conversation_id, client_id, user_id, role, body) values ($1, 'builder-a', $2, 'system', 'x')`, [c1, U1]),
    "a role other than user/assistant is refused");
  check(await refused(db, `insert into support_conversations (client_id, user_id, status) values ('builder-a', $1, 'pending')`, [U1]),
    "a status other than open/handed_off/closed is refused");

  const tk = (await one(db, `insert into feedback_submissions (client_id, submitter_name, kind, title, support_conversation_id) values ('builder-a', 'Pat', 'ticket', 'help', $1) returning id`, [c1])).id;
  await db.query(`update support_conversations set status = 'handed_off', submission_id = $2 where id = $1`, [c1, tk]);
  await db.query(`delete from feedback_submissions where id = $1`, [tk]);
  const afterTicket = await one(db, `select submission_id, status from support_conversations where id = $1`, [c1]);
  check(afterTicket && afterTicket.submission_id === null, "deleting the ticket only unlinks the chat");

  const tk2 = (await one(db, `insert into feedback_submissions (client_id, submitter_name, kind, title, support_conversation_id) values ('builder-a', 'Pat', 'ticket', 'help', $1) returning id`, [c1])).id;
  await db.query(`delete from support_conversations where id = $1`, [c1]);
  const msgsLeft = await one(db, `select count(*)::int n from support_messages where conversation_id = $1`, [c1]);
  check(msgsLeft.n === 0, "deleting a chat takes its messages");
  const tkLeft = await one(db, `select support_conversation_id from feedback_submissions where id = $1`, [tk2]);
  check(tkLeft && tkLeft.support_conversation_id === null, "deleting a chat keeps the ticket and only unlinks it");

  // ── support_usage ───────────────────────────────────────────────────────────────────────────
  const ca = (await one(db, `insert into support_conversations (client_id, user_id) values ('builder-a', $1) returning id`, [U1])).id;
  const ca2 = (await one(db, `insert into support_conversations (client_id, user_id) values ('builder-a', $1) returning id`, [U2])).id;
  const cb = (await one(db, `insert into support_conversations (client_id, user_id) values ('builder-b', $1) returning id`, [U3])).id;
  const msg = (conv, client, user, role, ago, cost) => db.query(
    `insert into support_messages (conversation_id, client_id, user_id, role, body, cost_micros, created_at)
     values ($1, $2, $3, $4, 'x', $5, now() - $6::interval)`, [conv, client, user, role, cost, ago]);
  await msg(ca, "builder-a", U1, "user", "1 minute", 0);          // U1, 10 min: yes; tenant 24h: yes
  await msg(ca, "builder-a", U1, "assistant", "1 minute", 5000);  // assistant: never counted toward caps
  await msg(ca, "builder-a", U1, "user", "5 minutes", 0);         // U1 10 min: yes
  await msg(ca, "builder-a", U1, "user", "20 minutes", 0);        // tenant 24h: yes; U1 10 min: no
  await msg(ca2, "builder-a", U2, "user", "2 minutes", 0);        // tenant 24h: yes; U1: no
  await msg(ca, "builder-a", U1, "user", "25 hours", 0);          // too old for either
  await msg(cb, "builder-b", U3, "user", "1 minute", 0);          // another tenant
  await msg(cb, "builder-b", U3, "assistant", "1 minute", 7000);  // counts toward the month only
  // A row from last month must not count toward this month's cost.
  await db.query(`insert into support_messages (conversation_id, client_id, user_id, role, body, cost_micros, created_at)
    values ($1, 'builder-b', $2, 'assistant', 'x', 999999, date_trunc('month', now() at time zone 'utc') at time zone 'utc' - interval '1 second')`, [cb, U3]);
  // The 8,000-character message from the cascade check was deleted with its chat; nothing else is here.
  const u = (await one(db, `select public.support_usage('builder-a', $1) u`, [U1])).u;
  check(Number(u.tenant_24h) === 4, `tenant_24h counts the tenant's own user messages in 24 h (got ${u.tenant_24h}, want 4)`);
  check(Number(u.user_10m) === 2, `user_10m counts this user's messages in 10 min (got ${u.user_10m}, want 2)`);
  check(Number(u.month_cost_micros) === 12000, `month_cost_micros sums this month across tenants (got ${u.month_cost_micros}, want 12000)`);
  const ub = (await one(db, `select public.support_usage('builder-b', $1) u`, [U3])).u;
  check(Number(ub.tenant_24h) === 1 && Number(ub.user_10m) === 1, "another tenant sees only its own counts");

  // ── re-apply is a no-op; a hand-set cap survives ────────────────────────────────────────────
  await db.query(`update client_settings set support_ai_daily_cap = 2 where client_id = 'our-own'`);
  await db.exec(MIG());
  const kept = await one(db, `select support_ai_daily_cap cap from client_settings where client_id = 'our-own'`);
  check(kept.cap === 2, "a re-apply leaves a cap set by hand alone");
  const still = await one(db, `select count(*)::int n from support_messages`);
  check(still.n > 0, "a re-apply keeps every row");

  // ── rollback, then apply again ──────────────────────────────────────────────────────────────
  await db.exec(ROLLBACK);
  const gone = await one(db, `select to_regclass('public.support_messages') m, to_regclass('public.support_conversations') c,
    (select count(*)::int from information_schema.columns where table_name = 'feedback_submissions' and column_name = 'support_conversation_id') col,
    (select count(*)::int from feedback_submissions where kind = 'ticket') tickets`);
  check(gone.m === null && gone.c === null && gone.col === 0 && gone.tickets === 0, "the header's ROLLBACK takes 340 out");
  check(await refused(db, `insert into feedback_submissions (client_id, submitter_name, kind, title) values ('builder-a', 'Pat', 'ticket', 'x')`),
    "after ROLLBACK a ticket is refused again");
  await db.exec(MIG());
  check(!(await refused(db, `insert into feedback_submissions (client_id, submitter_name, kind, title) values ('builder-a', 'Pat', 'ticket', 'x')`)),
    "the file applies again after ROLLBACK");
  await db.close();

  // ── mutants: the closing DO block must refuse a half-applied state ──────────────────────────
  const mutate = async (label, from, to) => {
    const src = MIG();
    if (!src.includes(from)) { check(false, `mutant "${label}": anchor not found`); return; }
    const m = await fresh();
    const bad = src.replace(from, to);
    const aborted = await refused(m, bad);
    check(aborted, `mutant "${label}" aborts the apply`);
    await m.close();
  };
  await mutate("no ticket kind", "check (kind in ('bug', 'feature', 'ticket'))", "check (kind in ('bug', 'feature'))");
  await mutate("a browser policy", "-- ── Tickets", "create policy leak on public.support_messages for select to authenticated using (true);\n-- ── Tickets");
  await mutate("a browser grant", "-- ── Tickets", "grant select on public.support_conversations to authenticated;\n-- ── Tickets");
  await mutate("usage open to the browser", "grant execute on function public.support_usage(text, uuid) to service_role;",
    "grant execute on function public.support_usage(text, uuid) to service_role, authenticated;");

  console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
