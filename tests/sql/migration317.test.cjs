// Execute migration 317 for real in PGlite (Postgres compiled to WASM, in memory), on billing tables
// shaped like the live ones (information_schema, 2026-10-20: 050/052/061 plus their later columns,
// and 164's wallet_accounts auto top-up columns), then check what it promises:
//   * the new columns exist, and the constraints refuse what they should (a last 4 that is not four
//     digits, a COF kind that is not one of the four, a consent kind that is not one of the four);
//   * billing_consents is service-role only: RLS on, and nothing for anon or authenticated even
//     with Supabase's default privileges (which hand every new table to the API roles);
//   * THE BACKFILL picks each subscription's own first sale: the closed_ok attempt with a sale for
//     the same tenant and plan in the 30 minutes before the row, the latest of them (so a declined
//     attempt, a retry that later succeeded, a cancelled-and-resubscribed plan and an attempt from
//     outside the window each land right), marks it initial_cof_flagged = false, and leaves an ACH
//     row and a wallet top-up's sale alone; no unscheduled initial is invented;
//   * a re-apply changes nothing, the rehearsal (commit swapped for rollback) leaves nothing, and a
//     CRLF checkout applies the same.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants, plans and transaction ids are made up. The repo is public.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration317.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const RAW = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/317_card_on_file_credentials.sql"), "utf8");
const M317 = () => RAW().replace(/\r\n/g, "\n");

// The live shapes, trimmed to what 317 reads or alters. Supabase's default privileges are
// reproduced so a missing revoke shows up as a grant.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create table public.billing_plans (id text primary key);
insert into public.billing_plans values ('simple_layout_annual'), ('crm_annual'), ('simple_layout_monthly'), ('full_suite_annual');

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

// subscription id -> the initial the backfill must give it (null = none).
const WANT = {
  "sub-a": "TXN-A",          // one clean first sale, seconds before the row
  "sub-b": "TXN-B-OK",       // two declines then an approval, all inside the window: the approval
  "sub-c1": "TXN-C1",        // cancelled ...
  "sub-c2": "TXN-C2",        // ... and resubscribed a month later: each gets its own sale
  "sub-late": null,          // its only sale was 40 minutes before the row: outside the window
  "sub-ach": null,           // an ACH row: no attempt at all
  "sub-after": null,         // an attempt AFTER the row is not its first sale
};
const SEED = `
insert into public.billing_subscriptions (id, client_id, plan_id, status, created_at) values
  ('sub-a',     'tenant-one', 'simple_layout_annual', 'active',    '2026-08-01 10:00:05+00'),
  ('sub-b',     'tenant-one', 'crm_annual',           'active',    '2026-08-01 10:08:00+00'),
  ('sub-c1',    'tenant-two', 'simple_layout_monthly','cancelled', '2026-07-01 12:00:03+00'),
  ('sub-c2',    'tenant-two', 'simple_layout_monthly','active',    '2026-08-01 12:00:03+00'),
  ('sub-late',  'tenant-three','simple_layout_annual','active',    '2026-09-01 09:40:00+00'),
  ('sub-ach',   'tenant-four', 'full_suite_annual',   'active',    '2026-10-05 19:11:13+00'),
  ('sub-after', 'tenant-five', 'simple_layout_annual','active',    '2026-09-10 08:00:00+00');
insert into public.billing_charge_attempts (client_id, plan_id, orderid, sale_txn, state, created_at) values
  ('tenant-one',  'simple_layout_annual',  'ss_first_tenant-one_simple_layout_annual', 'TXN-A',     'closed_ok',       '2026-08-01 10:00:03+00'),
  ('tenant-one',  'crm_annual',            'ss_first_tenant-one_crm_annual',           null,        'closed_declined', '2026-08-01 10:00:06+00'),
  ('tenant-one',  'crm_annual',            'ss_first_tenant-one_crm_annual',           null,        'closed_declined', '2026-08-01 10:02:00+00'),
  ('tenant-one',  'crm_annual',            'ss_first_tenant-one_crm_annual',           'TXN-B-OK',  'closed_ok',       '2026-08-01 10:07:58+00'),
  ('tenant-two',  'simple_layout_monthly', 'ss_first_tenant-two_simple_layout_monthly','TXN-C1',    'closed_ok',       '2026-07-01 12:00:01+00'),
  ('tenant-two',  'simple_layout_monthly', 'ss_first_tenant-two_simple_layout_monthly','TXN-C2',    'closed_ok',       '2026-08-01 12:00:01+00'),
  ('tenant-three','simple_layout_annual',  'ss_first_tenant-three_simple_layout_annual','TXN-LATE', 'closed_ok',       '2026-09-01 09:00:00+00'),
  ('tenant-five', 'simple_layout_annual',  'ss_first_tenant-five_simple_layout_annual','TXN-AFTER', 'closed_ok',       '2026-09-10 08:00:30+00'),
  ('tenant-one',  'wallet_topup',          'ss_topup_tenant-one_9',                    'TXN-TOPUP', 'closed_ok',       '2026-08-01 10:00:04+00');
insert into public.billing_customers (client_id, vault_id) values ('tenant-one', 'vault-one'), ('tenant-two', 'vault-two');
insert into public.wallet_accounts (client_id, auto_topup_enabled, auto_topup_threshold_cents, auto_topup_amount_cents)
  values ('tenant-one', true, 10000, 25000);
`;

let failures = 0;
const ok = (cond, name, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? `   [${detail}]` : ""}`);
};
// Every instance is closed, and the run ends by process.exitCode rather than process.exit (as
// migration313 does): forcing exit with PGlite's handles in flight trips libuv's UV_HANDLE_CLOSING
// assertion on Windows, and the run exits 127 after printing a pass.
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function fresh() {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(SEED);
  return db;
}
const rows = async (db, sql) => (await db.query(sql)).rows;
const refused = async (db, sql) => { try { await db.exec(sql); return false; } catch { return true; } };
const snapshot = async (db) => JSON.stringify(await rows(db, "select id, initial_transaction_id, initial_cof_flagged from public.billing_subscriptions order by id"));

(async () => {
  // ── 1. Apply ────────────────────────────────────────────────────────────────────────────
  const db = await fresh();
  try { await db.exec(M317()); ok(true, "317 applied"); } catch (e) { ok(false, "317 applied", e.message); await closeAll(); process.exitCode = 1; return; }

  const cols = async (t) => (await rows(db, `select column_name from information_schema.columns where table_schema='public' and table_name='${t}'`)).map((r) => r.column_name);
  const has = (list, want) => want.every((c) => list.includes(c));
  ok(has(await cols("billing_customers"), ["unscheduled_initial_txn", "unscheduled_initial_at", "card_last4", "card_brand", "card_saved_at"]), "billing_customers gains the unscheduled initial and the card's last 4");
  ok(has(await cols("billing_subscriptions"), ["initial_transaction_id", "initial_cof_flagged"]), "billing_subscriptions gains its initial");
  ok(has(await cols("billing_charge_attempts"), ["cof", "billing_method", "cof_supported", "receipt_sent_at", "receipt_error"]), "billing_charge_attempts gains the COF record and the receipt outcome");
  ok(has(await cols("wallet_accounts"), ["auto_topup_consent_id"]), "wallet_accounts gains the agreement its auto top-up runs on");
  ok(has(await cols("billing_consents"), ["client_id", "kind", "wording_version", "wording", "terms", "user_id", "user_email", "card_last4", "transaction_id", "ip", "user_agent", "created_at"]), "billing_consents exists with every field the agreement needs");

  // ── 2. Constraints ──────────────────────────────────────────────────────────────────────
  ok(await refused(db, "update public.billing_customers set card_last4 = 'abcd' where client_id = 'tenant-one'"), "a last 4 that is not digits is refused");
  ok(await refused(db, "update public.billing_customers set card_last4 = '41111' where client_id = 'tenant-one'"), "a last 4 that is five digits is refused");
  ok(!(await refused(db, "update public.billing_customers set card_last4 = '4242' where client_id = 'tenant-one'")), "four digits are kept");
  ok(await refused(db, "insert into public.billing_charge_attempts (client_id, plan_id, orderid, cof) values ('t', 'p', 'o', 'cit_whatever')"), "an unknown COF kind is refused");
  for (const k of ["cit_initial_recurring", "cit_initial_unscheduled", "cit_used", "mit_unscheduled"]) {
    ok(!(await refused(db, `insert into public.billing_charge_attempts (client_id, plan_id, orderid, cof, state) values ('t-${k}', 'p', 'o', '${k}', 'closed_ok')`)), `COF kind ${k} is accepted`);
  }
  ok(await refused(db, "insert into public.billing_consents (client_id, kind, wording_version, wording) values ('t', 'verbal', 'v', 'w')"), "an unknown consent kind is refused");
  const c = await rows(db, "insert into public.billing_consents (client_id, kind, wording_version, wording) values ('tenant-one', 'auto_topup', '2026-10-20.1', 'I agree') returning id, terms");
  ok(c.length === 1 && JSON.stringify(c[0].terms) === "{}", "an agreement row takes the four kinds, terms default {}");
  ok(!(await refused(db, `update public.wallet_accounts set auto_topup_consent_id = ${c[0].id} where client_id = 'tenant-one'`)), "wallet_accounts points at the agreement");
  ok(await refused(db, "update public.wallet_accounts set auto_topup_consent_id = 999999 where client_id = 'tenant-one'"), "…and only at one that exists");

  // ── 3. Lockdown ─────────────────────────────────────────────────────────────────────────
  const priv = await rows(db, `select
      has_table_privilege('anon', 'public.billing_consents', 'select') as anon_sel,
      has_table_privilege('authenticated', 'public.billing_consents', 'select') as auth_sel,
      has_table_privilege('authenticated', 'public.billing_consents', 'insert') as auth_ins,
      (select relrowsecurity from pg_class where oid = 'public.billing_consents'::regclass) as rls`);
  ok(!priv[0].anon_sel && !priv[0].auth_sel && !priv[0].auth_ins, "billing_consents: nothing for anon or authenticated, default privileges notwithstanding", JSON.stringify(priv[0]));
  ok(priv[0].rls === true, "billing_consents: row level security on");

  // ── 4. The backfill ─────────────────────────────────────────────────────────────────────
  const subs = await rows(db, "select id, initial_transaction_id, initial_cof_flagged from public.billing_subscriptions");
  for (const [id, want] of Object.entries(WANT)) {
    const r = subs.find((s) => s.id === id);
    ok(r && r.initial_transaction_id === want, `backfill: ${id} -> ${want ?? "none"}`, JSON.stringify(r));
    ok(r && r.initial_cof_flagged === (want ? false : null), `backfill: ${id} is marked ${want ? "unflagged (sent before 317)" : "with no flag"}`, JSON.stringify(r));
  }
  const unsched = await rows(db, "select count(*)::int as n from public.billing_customers where unscheduled_initial_txn is not null");
  ok(unsched[0].n === 0, "no unscheduled initial is invented (not even from a top-up's sale on another plan)");
  const autoOn = await rows(db, "select auto_topup_enabled, auto_topup_consent_id from public.wallet_accounts where client_id = 'tenant-one'");
  ok(autoOn[0].auto_topup_enabled === true, "the migration leaves an existing auto top-up's setting alone (the code moves it over)");

  // ── 5. Re-apply, rehearsal, CRLF ────────────────────────────────────────────────────────
  const before = await snapshot(db);
  try { await db.exec(M317()); ok(true, "a re-apply runs"); } catch (e) { ok(false, "a re-apply runs", e.message); }
  ok((await snapshot(db)) === before, "…and changes nothing");

  const rehearse = await fresh();
  await rehearse.exec(M317().replace(/^commit;$/m, "rollback;"));
  const left = await rows(rehearse, `select
      (select count(*)::int from information_schema.tables where table_schema='public' and table_name='billing_consents') as tbl,
      (select count(*)::int from information_schema.columns where table_schema='public' and table_name='billing_subscriptions' and column_name='initial_transaction_id') as col`);
  ok(left[0].tbl === 0 && left[0].col === 0, "the rehearsal (commit -> rollback) leaves nothing behind", JSON.stringify(left[0]));

  const crlf = await fresh();
  try {
    await crlf.exec(RAW().replace(/\r?\n/g, "\r\n"));
    ok((await snapshot(crlf)) === before, "a CRLF checkout applies the same");
  } catch (e) { ok(false, "a CRLF checkout applies the same", e.message); }

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
