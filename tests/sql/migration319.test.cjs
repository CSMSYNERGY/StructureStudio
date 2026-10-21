// Execute migration 319 for real in PGlite (Postgres compiled to WASM, in memory), on a database
// where migration 244 has run FROM ITS OWN FILE over client_settings / wallet_accounts /
// wallet_transactions shaped like the live ones (128's columns, information_schema 2026-10-21),
// then check what it promises:
//   * four charge columns on tax_lookups, wallet_tx_id a BIGINT foreign key to
//     wallet_transactions(id) with ON DELETE SET NULL (the id is bigint live, not uuid);
//   * the state list and the one shape CHECK refuse every half-written charge: an unknown state,
//     charged without its time or its cents, 0 cents, pending without the price it is attempting,
//     a price on a row that was neither charged, pending nor error, a wallet link or a time on an
//     uncharged row, a price or a wallet link on a row with NO state (a CHECK passes on NULL, so
//     each clause must be NULL-safe), and any charge on a ping;
//   * THE BACKFILL: a row whose tax_ledger key is on a posted wallet row is charged and linked
//     (same tenant, same meter, posted, a debit — a near-miss on any of the four is not), a
//     failed lookup is no_rate, every other closed lookup is inactive, in-flight rows and pings
//     stay NULL;
//   * 244's posture survives: RLS on, no policies, nothing for anon/authenticated even with
//     Supabase's default privileges, the service role writes the new columns;
//   * the file refuses without 244, a re-apply changes nothing, the rehearsal (commit swapped for
//     rollback) leaves nothing, a CRLF checkout applies the same, and broken copies (mutants)
//     are refused by the file's own checks.
// Nothing here touches the live project: no network, no Supabase.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration319.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
//
// Every tenant id, key and amount here is an obviously fake fixture: this repo is public.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const RAW = () => (process.env.MIG_FILE ? fs.readFileSync(process.env.MIG_FILE, "utf8") : fs.readFileSync(path.join(WT, "supabase/migrations/319_tax_lookup_charge_state.sql"), "utf8"));
const M319 = () => RAW().replace(/\r/g, "");
const M244 = () => read("244_avalara_tax_lookups.sql");
const REHEARSAL = "pending at a price, charged + linked, error at a price, every uncharged state; refused: unknown state, half-charged rows, 0 cents, pending without a price, a price or wallet link or time off a charge, a stateless row with a price or wallet row, a charged ping, a missing wallet row; a deleted wallet row unlinks";

// The live shapes 244 and 319 read, trimmed to their columns. Supabase's default privileges are
// reproduced so a missing revoke would show up as a grant.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create table public.client_settings (
  client_id text primary key, billing_exempt boolean not null default false, invoice_in_ghl boolean
);
create table public.wallet_accounts (
  client_id text primary key, balance_cents bigint not null default 0, held_cents bigint not null default 0,
  metered_exempt boolean not null default false, updated_at timestamptz not null default now()
);
create table public.wallet_transactions (
  id                  bigint generated always as identity primary key,
  client_id           text not null,
  kind                text not null check (kind in ('topup','debit','refund','grant','adjustment','reversal')),
  amount_cents        bigint not null,
  balance_after_cents bigint not null,
  meter_kind          text,
  state               text not null default 'posted' check (state in ('held','posted','released','void')),
  idempotency_key     text,
  hold_id             bigint references public.wallet_transactions(id),
  ref_type            text,
  ref_id              text,
  cost_cents          integer,
  usage               jsonb,
  memo                text,
  actor_user_id       uuid,
  created_at          timestamptz not null default now(),
  posted_at           timestamptz
);
create unique index wallet_tx_idem on public.wallet_transactions (client_id, idempotency_key)
  where idempotency_key is not null and state <> 'released';
alter table public.wallet_accounts enable row level security;
alter table public.wallet_transactions enable row level security;
revoke all on public.wallet_accounts, public.wallet_transactions from public, anon, authenticated;
`;

// Ledger rows as they stand before 319, keyed by a letter. `want` is what the backfill must make
// of each: [charge_state, charge_cents, linked to a wallet row].
const L = (n) => `00000000-0000-4000-8000-0000000319${String(n).padStart(2, "0")}`;
const ROWS = {
  A: { kind: "invoice", outcome: "ok", client: "tenant-one", want: ["inactive", null, false] },       // never charged: the meter was off
  B: { kind: "verify", outcome: "ok", client: "tenant-one", want: ["charged", 10, true] },            // its tax_ledger key is a posted debit
  C: { kind: "verify", outcome: "timeout", client: "tenant-one", want: ["no_rate", null, false] },    // a failed lookup is never charged
  D: { kind: "verify", outcome: null, client: "tenant-one", want: [null, null, false] },             // in flight: nothing decided yet
  E: { kind: "ping", outcome: "ok", client: "_platform", want: [null, null, false] },                // a ping is platform cost
  F: { kind: "invoice", outcome: "ok", client: "tenant-one", want: ["inactive", null, false] },      // a key under the OTHER meter is not its charge
  G: { kind: "invoice", outcome: "ok", client: "tenant-two", want: ["inactive", null, false] },      // the right key on another tenant's wallet is not
  H: { kind: "verify", outcome: "ok", client: "tenant-two", want: ["inactive", null, false] },       // a voided row is not a posted charge
  I: { kind: "invoice", outcome: "bad_address", client: "tenant-two", want: ["no_rate", null, false] },
};
const IDS = Object.fromEntries(Object.keys(ROWS).map((k, i) => [k, L(i + 1)]));
const SEED = () => {
  const lookups = Object.entries(ROWS).map(([k, r]) =>
    `('${IDS[k]}', '${r.client}', '${r.kind}', ${r.outcome ? `'${r.outcome}'` : "null"}, ${r.outcome ? "now()" : "null"})`).join(",\n  ");
  return `
insert into public.tax_lookups (id, client_id, kind, outcome, finished_at) values
  ${lookups};
insert into public.wallet_transactions (client_id, kind, amount_cents, balance_after_cents, meter_kind, state, idempotency_key, posted_at) values
  ('tenant-one', 'debit', -10, 4990, 'tax_lookup', 'posted', 'tax_ledger:tax_lookup:${IDS.B}', '2026-10-01 12:00:00+00'),
  ('tenant-one', 'debit', -10, 4980, 'tax_lookup', 'posted', 'tax_ledger:tax_lookup:${IDS.F}', '2026-10-01 12:01:00+00'),
  ('tenant-one', 'debit', -10, 4970, 'tax_invoice', 'posted', 'tax_ledger:tax_invoice:${IDS.G}', '2026-10-01 12:02:00+00'),
  ('tenant-two', 'debit', -10, 4990, 'tax_lookup', 'void', 'tax_ledger:tax_lookup:${IDS.H}', '2026-10-01 12:03:00+00'),
  ('tenant-two', 'topup', 2500, 2500, null, 'posted', 'topup-fixture-1', '2026-10-01 11:00:00+00');
`;
};

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
// Every instance is closed and the run ends by process.exitCode (migration317's reason: forcing
// exit with PGlite's handles in flight trips a libuv assertion on Windows).
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function makeDb({ with244 = true, seed = true } = {}) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  if (with244) await db.exec(M244());
  if (with244 && seed) await db.exec(SEED());
  return db;
}
async function apply(db, sql) {
  const out = await db.exec(sql);
  const record = [...out].reverse().find((r) => r.rows && r.rows.length && r.fields.some((f) => f.name === "migration"));
  return record ? record.rows[0] : null;
}
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
const one = async (db, sql, params) => (await rows(db, sql, params))[0];
async function refused(db, sql, pattern) {
  try { await db.exec(sql); return { refused: false, message: "(accepted)" }; }
  catch (e) { return { refused: !pattern || pattern.test(e.message), message: e.message }; }
  finally { try { await db.exec("reset role"); } catch (_e) { /* not in a role */ } }
}
const snapshot = async (db) => JSON.stringify(await rows(db,
  "select id, charge_state, charge_cents, wallet_tx_id, charged_at is not null as at from public.tax_lookups order by id"));

(async () => {
  console.log("migration 319: what each tax lookup cost");

  // ── 0. Refused without 244 ────────────────────────────────────────────────────────────────
  const early = await makeDb({ with244: false });
  const r0 = await refused(early, M319(), /migration 244 not applied/);
  ok(r0.refused, "319 without 244's tax_lookups is refused", r0.message);

  // ── 1. Apply ───────────────────────────────────────────────────────────────────────────
  const db = await makeDb();
  let R;
  try { R = await apply(db, M319()); ok(true, "319 applied cleanly"); }
  catch (e) { ok(false, "319 applied", e.message); await closeAll(); process.exitCode = 1; return; }
  R = R || {};
  ok(R.columns === 4, "RECORD: four charge columns", String(R.columns));
  ok(R.charged === 1 && R.inactive === 4 && R.no_rate === 2, "RECORD: 1 charged, 4 inactive, 2 no_rate", JSON.stringify(R));
  ok(R.unstated === 1, "RECORD: one verify/invoice row left unstated (the in-flight one)", String(R.unstated));
  ok(R.rehearsal === REHEARSAL, "RECORD: the rehearsal ran to its end", R.rehearsal);
  ok((await one(db, "select count(*)::int n from public.tax_lookups where client_id = '__m319_rehearsal__'")).n === 0, "the rehearsal left no ledger row");
  ok((await one(db, "select count(*)::int n from public.wallet_transactions where client_id = '__m319_rehearsal__'")).n === 0, "  and no wallet row");

  const cols = await rows(db, "select column_name, data_type from information_schema.columns where table_schema='public' and table_name='tax_lookups' and column_name in ('charge_state','charge_cents','wallet_tx_id','charged_at') order by column_name");
  ok(JSON.stringify(cols.map((c) => [c.column_name, c.data_type])) === JSON.stringify([
    ["charge_cents", "integer"], ["charge_state", "text"], ["charged_at", "timestamp with time zone"], ["wallet_tx_id", "bigint"],
  ]), "the columns have the types the functions write (wallet_tx_id bigint, as wallet_transactions.id is)", JSON.stringify(cols));
  const fk = await one(db, `select confdeltype, confrelid::regclass::text as ref from pg_constraint
                             where conrelid = 'public.tax_lookups'::regclass and contype = 'f'`);
  ok(fk && fk.ref === "wallet_transactions" && fk.confdeltype === "n", "wallet_tx_id references wallet_transactions ON DELETE SET NULL", JSON.stringify(fk));

  // ── 2. The backfill ─────────────────────────────────────────────────────────────────────
  console.log("the backfill");
  const after = await rows(db, "select id, charge_state, charge_cents, wallet_tx_id, charged_at from public.tax_lookups");
  const txB = await one(db, `select id from public.wallet_transactions where idempotency_key = 'tax_ledger:tax_lookup:${IDS.B}'`);
  for (const [k, r] of Object.entries(ROWS)) {
    const got = after.find((x) => x.id === IDS[k]);
    const [state, cents, linked] = r.want;
    ok(got && got.charge_state === state && got.charge_cents === cents && (got.wallet_tx_id != null) === linked
      && (got.charged_at != null) === (state === "charged"),
      `${k} (${r.kind}, ${r.outcome ?? "in flight"}) -> ${state ?? "NULL"}${linked ? ", linked" : ""}`, JSON.stringify(got));
  }
  const b = after.find((x) => x.id === IDS.B);
  ok(b && String(b.wallet_tx_id) === String(txB.id), "  B is linked to ITS wallet row", JSON.stringify([b && b.wallet_tx_id, txB.id]));
  ok(b && new Date(b.charged_at).toISOString() === "2026-10-01T12:00:00.000Z", "  B's charged_at is the wallet row's posted_at", b && String(b.charged_at));

  // ── 3. The shape ────────────────────────────────────────────────────────────────────────
  console.log("the shape refuses half-written charges");
  const A = IDS.A, E = IDS.E, D = IDS.D;
  for (const [label, sql] of [
    ["pending without the price it is attempting", `update public.tax_lookups set charge_state = 'pending' where id = '${A}'`],
    ["a price on an exempt row", `update public.tax_lookups set charge_state = 'exempt', charge_cents = 10 where id = '${A}'`],
    ["a price on a row with no state", `update public.tax_lookups set charge_cents = 10 where id = '${D}'`],
    ["a wallet link on a row with no state", `update public.tax_lookups set wallet_tx_id = ${txB.id} where id = '${D}'`],
    ["an unknown state", `update public.tax_lookups set charge_state = 'billed' where id = '${A}'`],
    ["charged with no time", `update public.tax_lookups set charge_state = 'charged', charge_cents = 10 where id = '${A}'`],
    ["charged with no cents", `update public.tax_lookups set charge_state = 'charged', charged_at = now() where id = '${A}'`],
    ["a charge of 0 cents", `update public.tax_lookups set charge_state = 'charged', charge_cents = 0, charged_at = now() where id = '${A}'`],
    ["a negative charge", `update public.tax_lookups set charge_state = 'charged', charge_cents = -10, charged_at = now() where id = '${A}'`],
    ["cents on an uncharged row", `update public.tax_lookups set charge_cents = 10 where id = '${A}'`],
    ["a time on an uncharged row", `update public.tax_lookups set charged_at = now() where id = '${A}'`],
    ["a wallet link on an uncharged row", `update public.tax_lookups set wallet_tx_id = ${txB.id} where id = '${A}'`],
    ["a state on a ping", `update public.tax_lookups set charge_state = 'inactive' where id = '${E}'`],
    ["a charge on a ping", `update public.tax_lookups set charge_state = 'charged', charge_cents = 10, charged_at = now() where id = '${E}'`],
  ]) {
    const r = await refused(db, sql, /check constraint/);
    ok(r.refused, `refused: ${label}`, r.message);
  }
  const ghost = await refused(db, `update public.tax_lookups set charge_state = 'charged', charge_cents = 10, charged_at = now(), wallet_tx_id = 999999 where id = '${A}'`, /foreign key/);
  ok(ghost.refused, "refused: a link to a wallet row that does not exist", ghost.message);
  for (const s of ["exempt", "inactive", "unpriced", "no_rate", "error"]) {
    const r = await refused(db, `update public.tax_lookups set charge_state = '${s}', charge_cents = null where id = '${A}'`);
    ok(!r.refused, `accepted: ${s} on a closed lookup`, r.message);
  }
  for (const s of ["pending", "error"]) {
    const r = await refused(db, `update public.tax_lookups set charge_state = '${s}', charge_cents = 10 where id = '${A}'`);
    ok(!r.refused, `accepted: ${s} carrying the price it attempted`, r.message);
  }
  await db.exec(`update public.tax_lookups set charge_state = 'inactive', charge_cents = null where id = '${A}'`);

  // ── 4. The posture ──────────────────────────────────────────────────────────────────────
  console.log("service-role only, as 244 left it");
  const priv = await one(db, `select
      has_table_privilege('anon', 'public.tax_lookups', 'select') as anon_sel,
      has_table_privilege('authenticated', 'public.tax_lookups', 'select') as auth_sel,
      has_table_privilege('authenticated', 'public.tax_lookups', 'update') as auth_upd,
      has_table_privilege('service_role', 'public.tax_lookups', 'update') as svc_upd,
      (select relrowsecurity from pg_class where oid = 'public.tax_lookups'::regclass) as rls,
      (select count(*)::int from pg_policies where tablename = 'tax_lookups') as policies`);
  ok(!priv.anon_sel && !priv.auth_sel && !priv.auth_upd, "nothing for anon or authenticated, default privileges notwithstanding", JSON.stringify(priv));
  ok(priv.rls === true && priv.policies === 0, "RLS on, zero policies", JSON.stringify(priv));
  for (const role of ["anon", "authenticated"]) {
    const r = await refused(db, `set role ${role}; select charge_state, charge_cents from public.tax_lookups`, /permission denied/);
    ok(r.refused, `${role} cannot read the charge columns`, r.message);
  }
  await db.exec("set role service_role");
  const w = await rows(db, `update public.tax_lookups set charge_state = 'charged', charge_cents = 10, charged_at = now(), wallet_tx_id = $1 where id = $2 returning id`, [txB.id, A]);
  await db.exec("reset role");
  ok(w.length === 1, "the service role writes a charge (what chargeLookup does)");

  // ── 5. ON DELETE SET NULL ───────────────────────────────────────────────────────────────
  await db.exec(`delete from public.wallet_transactions where id = ${txB.id}`);
  const unlinked = await rows(db, `select id, charge_state, charge_cents, wallet_tx_id from public.tax_lookups where id in ('${A}', '${IDS.B}') order by id`);
  ok(unlinked.length === 2 && unlinked.every((x) => x.charge_state === "charged" && x.charge_cents === 10 && x.wallet_tx_id == null),
    "deleting a wallet row unlinks it and the lookup stays charged", JSON.stringify(unlinked));

  // ── 6. Re-apply, rehearsal, CRLF ────────────────────────────────────────────────────────
  console.log("re-apply, rehearsal, CRLF");
  const before = await snapshot(db);
  try {
    const again = await apply(db, M319());
    ok(again && again.rehearsal === REHEARSAL, "a re-apply passes its own checks", JSON.stringify(again));
  } catch (e) { ok(false, "a re-apply passes", e.message); }
  ok((await snapshot(db)) === before, "  and changes nothing");
  ok((await one(db, "select count(*)::int n from pg_constraint where conrelid = 'public.tax_lookups'::regclass and conname like 'tax_lookups_charge_%'")).n === 2,
    "  and adds no second copy of a constraint");

  const rehearse = await makeDb();
  const rec = await apply(rehearse, M319().replace(/^commit;$/m, "rollback;"));
  ok(rec && rec.rehearsal === REHEARSAL && rec.charged === 1, "the rehearsal prints the same RECORD", JSON.stringify(rec));
  const left = await one(rehearse, "select count(*)::int n from information_schema.columns where table_schema='public' and table_name='tax_lookups' and column_name like 'charge%'");
  ok(left.n === 0, "  and leaves nothing behind", String(left.n));

  const crlf = await makeDb();
  try {
    await apply(crlf, RAW().replace(/\r?\n/g, "\r\n"));
    const s = await rows(crlf, "select charge_state from public.tax_lookups order by id");
    ok(JSON.stringify(s.map((x) => x.charge_state)) === JSON.stringify(Object.values(ROWS).map((r) => r.want[0])), "a CRLF checkout applies the same backfill");
  } catch (e) { ok(false, "a CRLF checkout applies", e.message); }

  // ── 7. Mutants ──────────────────────────────────────────────────────────────────────────
  console.log("319 mutants");
  const src = M319();
  for (const [label, mutate, re] of [
    ["the wallet link deletes cascade-free (no ON DELETE SET NULL)",
      (s) => s.replace("references public.wallet_transactions(id) on delete set null,", "references public.wallet_transactions(id),"),
      /319: wallet_tx_id is not one foreign key/],
    ["the wallet link typed uuid", (s) => s.replace("add column if not exists wallet_tx_id bigint", "add column if not exists wallet_tx_id uuid"), /foreign key|incompatible/],
    ["a browser role handed select", (s) => s.replace("revoke all on public.tax_lookups from anon, authenticated;\n",
      "revoke all on public.tax_lookups from anon, authenticated;\ngrant select on public.tax_lookups to authenticated;\n"), /319: tax_lookups is reachable by a browser role/],
    ["a permissive policy", (s) => s.replace("revoke all on public.tax_lookups from public;\n",
      "revoke all on public.tax_lookups from public;\ncreate policy tax_lookups_read on public.tax_lookups for select using (true);\n"), /319: tax_lookups has 1 policies/],
    ["failed lookups backfilled as inactive", (s) => s.replace("case when outcome = 'ok' then 'inactive' else 'no_rate' end", "'inactive'"),
      /319: 2 failed lookup\(s\) were backfilled as inactive/],
    ["no backfill of closed rows", (s) => s.replace("   and kind in ('verify', 'invoice')\n   and outcome is not null;", "   and false;"),
      /319: 6 closed lookup\(s\) were left without a charge state/],
    ["pings allowed a charge", (s) => s.replace("      and (kind <> 'ping' or charge_state is null)\n", ""), /319: a ping was given a charge state/],
    ["charged without its time", (s) => s.replace("          (charge_state is not distinct from 'charged') = (charged_at is not null)\n      and ", "          "),
      /319: a charged row without charged_at was accepted/],
    ["0 cents allowed", (s) => s.replace("      and (charge_cents is null or charge_cents > 0)\n", ""), /319: a charge of 0 cents was accepted/],
    ["a wallet link on any row", (s) => s.replace("      and (wallet_tx_id is null or charge_state is not distinct from 'charged')\n", ""), /319: a wallet row on an uncharged lookup was accepted/],
    ["the wallet clause NULL-unsafe", (s) => s.replace("(wallet_tx_id is null or charge_state is not distinct from 'charged')", "(wallet_tx_id is null or charge_state = 'charged')"),
      /319: a wallet row on a row with no charge state was accepted/],
    ["pending allowed without a price", (s) => s.replace("      and (charge_state is distinct from 'pending' or charge_cents is not null)\n", ""),
      /319: a pending row without the price it is attempting was accepted/],
    ["a price on any row", (s) => s.replace("      and (charge_cents is null or coalesce(charge_state in ('charged', 'pending', 'error'), false))\n", ""),
      /319: a price on a row that was never charged or attempted was accepted/],
    ["the price clause NULL-unsafe", (s) => s.replace("coalesce(charge_state in ('charged', 'pending', 'error'), false)", "charge_state in ('charged', 'pending', 'error')"),
      /319: a price on a row with no charge state was accepted/],
    ["pending missing from the states", (s) => s.replace("or charge_state in ('pending', 'charged',", "or charge_state in ('charged',"), /check constraint/],
  ]) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    const r = await refused(mdb, mm, re);
    ok(r.refused, `mutant "${label}" was refused`, r.message);
    if (r.message !== "(accepted)") {
      await mdb.exec("rollback").catch(() => {});
      const n = await one(mdb, "select count(*)::int n from information_schema.columns where table_schema='public' and table_name='tax_lookups' and column_name like 'charge%'");
      ok(n.n === 0, "  and nothing of it was left applied", String(n.n));
    }
  }

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
