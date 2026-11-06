// Execute migration 369 for real in PGlite (Postgres compiled to WASM, in memory), on the billing
// tables 317 shaped (317's own stubs, then 317 itself, so the constraint being re-issued is the one
// 317 really declared), then check what it promises:
//   * a card_add agreement is accepted, the four older kinds still are, and an unknown kind is
//     still refused — the CHECK is re-issued, not dropped;
//   * exactly one check constraint on kind remains, under the name the code and the rollback note
//     use (billing_consents_kind_check), and the table's posture is untouched: RLS on, nothing for
//     anon or authenticated;
//   * a re-apply changes nothing (the lookup-and-drop makes it idempotent), the rehearsal (commit
//     swapped for rollback) leaves 317's constraint in place, and a CRLF checkout applies the same.
// Nothing here touches the live project: no network, no Supabase.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration369.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const M317 = () => read(path.join(WT, "supabase/migrations/317_card_on_file_credentials.sql"));
const RAW369 = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/369_card_add_consent_kind.sql"), "utf8");
const M369 = () => RAW369().replace(/\r\n/g, "\n");

// 317's stubs, verbatim: the live shapes trimmed to what 317 reads or alters, with Supabase's
// default privileges reproduced so a missing revoke shows up as a grant.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create table public.billing_plans (id text primary key);
create table public.billing_subscriptions (
  id text primary key, client_id text not null, plan_id text references public.billing_plans(id),
  status text not null default 'active' check (status in ('active','paused','past_due','cancelled')),
  current_period_start timestamptz, current_period_end timestamptz, canceled_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  price_cents integer, past_due_since timestamptz, list_price_cents integer
);
create table public.billing_customers (
  client_id text primary key, vault_id text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.billing_customers enable row level security;
revoke all on public.billing_customers from anon, authenticated;
create table public.billing_charge_attempts (
  id bigint generated always as identity primary key, client_id text not null, plan_id text not null,
  orderid text not null, sale_txn text,
  state text not null default 'open' check (state in ('open', 'closed_ok', 'closed_declined', 'closed_unknown')),
  detail text, created_at timestamptz not null default now(), closed_at timestamptz
);
create unique index billing_charge_attempts_one_open on public.billing_charge_attempts (client_id, plan_id) where state = 'open';
create table public.wallet_accounts (
  client_id text primary key, balance_cents bigint not null default 0, held_cents bigint not null default 0,
  auto_topup_enabled boolean not null default false, auto_topup_threshold_cents bigint, auto_topup_amount_cents bigint,
  auto_topup_last_at timestamptz, auto_topup_disabled_reason text
);
`;

let failures = 0;
const ok = (cond, name, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? `   [${detail}]` : ""}`);
};
// Every instance is closed, and the run ends by process.exitCode rather than process.exit (as
// migration317 does): forcing exit with PGlite's handles in flight trips libuv's UV_HANDLE_CLOSING
// assertion on Windows, and the run exits 127 after printing a pass.
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function fresh() {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(M317());
  return db;
}
const rows = async (db, sql) => (await db.query(sql)).rows;
const refused = async (db, sql) => { try { await db.exec(sql); return false; } catch { return true; } };
const KINDS_317 = ["subscription_card", "topup_card", "auto_topup", "card_update"];
const insertKind = (kind) => `insert into public.billing_consents (client_id, kind, wording_version, wording) values ('tenant-one', '${kind}', '2026-10-20.1', 'I agree')`;
const kindChecks = async (db) => rows(db, `select conname, pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.billing_consents'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\\mkind\\M' order by conname`);

(async () => {
  // ── 0. Before: 317 refuses card_add ─────────────────────────────────────────────────────
  const db = await fresh();
  ok(await refused(db, insertKind("card_add")), "before 369, 317's CHECK refuses card_add (the defect this fixes)");
  const before = await kindChecks(db);
  ok(before.length === 1 && before[0].conname === "billing_consents_kind_check", "317 left one check on kind, named by Postgres", JSON.stringify(before));
  const colsOf = async () => (await rows(db, "select column_name from information_schema.columns where table_schema='public' and table_name='billing_consents' order by ordinal_position")).map((r) => r.column_name);
  const colsBefore = await colsOf();

  // ── 1. Apply ────────────────────────────────────────────────────────────────────────────
  try { await db.exec(M369()); ok(true, "369 applied"); } catch (e) { ok(false, "369 applied", e.message); await closeAll(); process.exitCode = 1; return; }

  ok(!(await refused(db, insertKind("card_add"))), "a card_add agreement is accepted");
  for (const k of KINDS_317) ok(!(await refused(db, insertKind(k))), `the older kind ${k} is still accepted`);
  ok(await refused(db, insertKind("verbal")), "an unknown kind is still refused: the CHECK was re-issued, not dropped");
  const after = await kindChecks(db);
  ok(after.length === 1 && after[0].conname === "billing_consents_kind_check" && /card_add/.test(after[0].def),
    "exactly one check on kind remains, under the name the rollback note uses, and it names card_add", JSON.stringify(after));
  const n = await rows(db, "select count(*)::int as n from public.billing_consents");
  ok(n[0].n === 5, "the five inserts above all landed (one per kind)", JSON.stringify(n));

  // ── 2. The posture is untouched ─────────────────────────────────────────────────────────
  const priv = await rows(db, `select
      has_table_privilege('anon', 'public.billing_consents', 'select') as anon_sel,
      has_table_privilege('authenticated', 'public.billing_consents', 'select') as auth_sel,
      has_table_privilege('authenticated', 'public.billing_consents', 'insert') as auth_ins,
      (select relrowsecurity from pg_class where oid = 'public.billing_consents'::regclass) as rls`);
  ok(!priv[0].anon_sel && !priv[0].auth_sel && !priv[0].auth_ins, "billing_consents: still nothing for anon or authenticated", JSON.stringify(priv[0]));
  ok(priv[0].rls === true, "billing_consents: row level security still on");
  const colsAfter = await colsOf();
  ok(JSON.stringify(colsAfter) === JSON.stringify(colsBefore) && colsBefore.includes("kind"), "no column was added, dropped or moved", JSON.stringify([colsBefore, colsAfter]));

  // ── 3. Re-apply ─────────────────────────────────────────────────────────────────────────
  try { await db.exec(M369()); ok(true, "a re-apply runs"); } catch (e) { ok(false, "a re-apply runs", e.message); }
  const again = await kindChecks(db);
  ok(again.length === 1 && again[0].conname === "billing_consents_kind_check", "...and still leaves exactly one check on kind", JSON.stringify(again));
  ok(!(await refused(db, insertKind("card_add"))) && (await refused(db, insertKind("verbal"))), "...accepting card_add and refusing an unknown kind as before");

  // ── 4. Rehearsal: commit swapped for rollback leaves 317's constraint ───────────────────
  const r = await fresh();
  const rehearsal = M369().replace(/\ncommit;\s*$/, "\nrollback;\n");
  ok(rehearsal !== M369(), "the rehearsal copy differs (the file ends with commit;)");
  try { await r.exec(rehearsal); ok(true, "the rehearsal runs"); } catch (e) { ok(false, "the rehearsal runs", e.message); }
  ok(await refused(r, insertKind("card_add")), "...and leaves card_add refused: nothing escaped the transaction");
  ok(!(await refused(r, insertKind("auto_topup"))), "...with 317's constraint still in place");

  // ── 5. CRLF ─────────────────────────────────────────────────────────────────────────────
  const c = await fresh();
  try { await c.exec(M369().replace(/\n/g, "\r\n")); ok(true, "a CRLF copy applies"); } catch (e) { ok(false, "a CRLF copy applies", e.message); }
  ok(!(await refused(c, insertKind("card_add"))), "...with the same result");

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
