// Execute migration 348 for real in PGlite (Postgres compiled to WASM, in memory), on orders and
// payments shaped like the live ones (the (id, client_id) unique index, payments' checks, its order
// key), then check what it promises:
//   * the backfill: a payment refunded in full before 348 reads amount 0 and refunded = what its note
//     lines say; a partly refunded one keeps its net and gains its refunded total; others are untouched;
//   * amount_cents 0 only on a row refunded in full and voided: a new 0, a 0 without a refund, and
//     un-voiding a fully refunded payment are all refused;
//   * the browser roles cannot move refunded_cents (the guard), the refund steps can;
//   * payment_refund_open / payment_refund_close: a card-network refund opens pending with its own
//     order id, a repeated key is a replay that changes nothing, a second refund while one is in
//     flight (pending OR unknown) is refused, an amount above what is left is refused, done moves
//     the money once (a second close is `already`), failed moves nothing and frees the payment,
//     several partials down to zero void it with the total in void_reason, a voided payment refuses,
//     card-network vs by-hand is enforced both ways, a by-hand refund is done in one call, a key
//     reused for another amount is refused, a done on a payment something else emptied is `short`;
//   * the ledger: RLS on, the browser reads its own tenant's rows and writes none, executes neither
//     function; the service role does everything;
//   * a re-apply changes nothing (no double backfill); the rehearsal leaves nothing; CRLF applies;
//   * refusals with the whole file rolled back: no payments table, no (id, client_id) on orders.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration348.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const RAW = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/348_payment_refunds.sql"), "utf8");
const M348 = () => RAW().replace(/\r\n/g, "\n");

const ROLES = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create function public.current_client_id() returns text language sql stable as $$ select nullif(current_setting('test.client', true), '') $$;
grant execute on function public.current_client_id() to anon, authenticated, service_role;
`;
// orders and payments trimmed to the columns that matter, with the live keys and checks.
const TABLES = `
create table public.orders (id uuid primary key, client_id text not null, total_cents integer);
create unique index orders_id_client_uniq on public.orders (id, client_id);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  order_id uuid not null,
  amount_cents integer not null,
  method text not null check (method in ('card','cash','check','ach','other')),
  reference text,
  received_at timestamptz not null default now(),
  note text,
  voided_at timestamptz,
  void_reason text,
  gateway text,
  gateway_txn_id text,
  created_by uuid,
  funding_state text not null default 'settled' check (funding_state in ('settled','pending','returned')),
  funding_updated_at timestamptz,
  surcharge_cents integer,
  constraint payments_amount_cents_check check (amount_cents > 0),
  constraint payments_order_client_fk foreign key (order_id, client_id) references public.orders (id, client_id) on delete cascade
);
alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;
grant select, insert, update on public.payments to authenticated;
create policy payments_owner_select on public.payments for select to authenticated using (client_id = public.current_client_id());
create policy payments_owner_update on public.payments for update to authenticated
  using (client_id = public.current_client_id() and gateway is null) with check (client_id = public.current_client_id() and gateway is null);
insert into public.orders (id, client_id, total_cents) values
  ('00000000-0000-4000-8000-0000000000a1', 'example-builder', 100000),
  ('00000000-0000-4000-8000-0000000000a2', 'other-builder', 50000);
insert into public.payments (id, client_id, order_id, amount_cents, method, gateway, gateway_txn_id, voided_at, void_reason, note) values
  -- refunded in full before 348 (one note line)
  ('00000000-0000-4000-8000-000000000b01', 'example-builder', '00000000-0000-4000-8000-0000000000a1', 11250, 'card', 'cardpointe', 'rt-full', '2026-10-19', 'refunded $112.50', 'Refunded $112.50 on 2026-10-19 (ref 111)'),
  -- partly refunded before 348 twice: net 60000 left
  ('00000000-0000-4000-8000-000000000b02', 'example-builder', '00000000-0000-4000-8000-0000000000a1', 60000, 'card', 'cardpointe', 'rt-part', null, null, 'Deposit\nRefunded $250.00 on 2026-10-20 (ref 222)\nRefunded $150.00 on 2026-10-21 (ref 333)'),
  -- a card payment nobody refunded
  ('00000000-0000-4000-8000-000000000b03', 'example-builder', '00000000-0000-4000-8000-0000000000a1', 40000, 'card', 'cardpointe', 'rt-plain', null, null, null),
  -- cash recorded by hand
  ('00000000-0000-4000-8000-000000000b04', 'example-builder', '00000000-0000-4000-8000-0000000000a1', 30000, 'cash', null, null, null, null, 'paid at the lot'),
  -- a hand void (not a refund)
  ('00000000-0000-4000-8000-000000000b05', 'example-builder', '00000000-0000-4000-8000-0000000000a1', 5000, 'check', null, null, '2026-10-10', 'voided in portal', null),
  -- another tenant's
  ('00000000-0000-4000-8000-000000000b06', 'other-builder', '00000000-0000-4000-8000-0000000000a2', 50000, 'check', null, null, null, null, null);
`;
const P = (n) => `00000000-0000-4000-8000-000000000b0${n}`;

let failures = 0;
const ok = (cond, name, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? `   [${detail}]` : ""}`);
};
// process.exitCode, never process.exit: PGlite's handles in flight trip libuv on Windows (exit 127).
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function fresh(setup = TABLES) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(ROLES);
  if (setup) await db.exec(setup);
  return db;
}
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
const refused = async (db, sql) => {
  try { await db.exec(sql); return false; } catch { await db.exec("rollback;").catch(() => {}); return true; }
};
const pay = async (db, n) => (await rows(db, "select amount_cents, refunded_cents, voided_at, void_reason, note from public.payments where id = $1", [P(n)]))[0];
const open = async (db, n, cents, key, kind, extra = {}) => (await rows(db,
  "select public.payment_refund_open($1, $2, $3, $4, $5, null, $6, $7, $8) as r",
  [extra.client ?? "example-builder", P(n), cents, key, kind, extra.method ?? null, extra.reference ?? null, extra.reason ?? null]))[0].r;
const close = async (db, id, state, retref = null, code = null, text = null) =>
  (await rows(db, "select public.payment_refund_close($1, $2, $3, $4, $5) as r", [id, state, retref, code, text]))[0].r;
const applyFails = async (db) => {
  let msg = "";
  try { await db.exec(M348()); } catch (e) { msg = String(e.message); }
  await db.exec("rollback;").catch(() => {});
  return msg;
};

(async () => {
  // ── 1. Apply, and the backfill ──────────────────────────────────────────────────────────
  const db = await fresh();
  let record;
  try {
    const res = await db.exec(M348());
    record = res.filter((r) => r.rows && r.rows.length).pop()?.rows?.[0];
    ok(true, "348 applied");
  } catch (e) { ok(false, "348 applied", e.message); await closeAll(); process.exitCode = 1; return; }
  ok(record && Number(record.payments_with_refunds) === 2 && Number(record.refunded_in_full) === 1
    && Number(record.ledger_rows) === 0 && record.ledger_rls === true,
    "THE RECORD: two payments with refunds, one refunded in full, an empty ledger, RLS on", JSON.stringify(record));
  const full = await pay(db, 1);
  ok(full.amount_cents === 0 && full.refunded_cents === 11250 && full.voided_at, "a payment refunded in full before 348 reads amount 0, refunded 11250", JSON.stringify(full));
  const part = await pay(db, 2);
  ok(part.amount_cents === 60000 && part.refunded_cents === 40000 && !part.voided_at, "a payment partly refunded twice keeps its net and gains refunded 40000", JSON.stringify(part));
  ok((await pay(db, 3)).refunded_cents === 0 && (await pay(db, 3)).amount_cents === 40000, "a payment nobody refunded is untouched");
  const hv = await pay(db, 5);
  ok(hv.amount_cents === 5000 && hv.refunded_cents === 0, "a hand void (not a refund) keeps its amount", JSON.stringify(hv));

  // ── 2. The amount check ─────────────────────────────────────────────────────────────────
  ok(await refused(db, `insert into public.payments (client_id, order_id, amount_cents, method) values ('example-builder', '00000000-0000-4000-8000-0000000000a1', 0, 'cash')`),
    "a new payment of 0 is refused");
  ok(await refused(db, `update public.payments set amount_cents = 0 where id = '${P(4)}'`), "amount 0 without a refund is refused");
  ok(await refused(db, `update public.payments set voided_at = null where id = '${P(1)}'`), "un-voiding a payment refunded in full is refused");
  ok(await refused(db, `update public.payments set refunded_cents = -1 where id = '${P(4)}'`), "a negative refunded total is refused");

  // ── 3. The guard on refunded_cents ──────────────────────────────────────────────────────
  await db.exec("set test.client = 'example-builder'");
  await db.exec("set role authenticated");
  const guardMsg = await (async () => { try { await db.exec(`update public.payments set refunded_cents = 100 where id = '${P(4)}'`); return ""; } catch (e) { return String(e.message); } })();
  await db.exec("rollback;").catch(() => {});
  await db.exec("reset role");
  ok(/changed by a refund only/.test(guardMsg), "the browser cannot move refunded_cents on a payment it may otherwise edit", guardMsg);
  await db.exec("set role authenticated");
  const noteEdit = !(await refused(db, `update public.payments set reference = 'chk 1043' where id = '${P(4)}'`));
  await db.exec("reset role");
  ok(noteEdit, "…while its other edits still work (reference on a hand-recorded payment)");

  // ── 4. A card-network refund, step by step ──────────────────────────────────────────────
  await db.exec("set role service_role");
  const o1 = await open(db, 3, 10000, "key-card-0001", "gateway");
  ok(o1.opened && o1.refund.state === "pending" && /^ssr_[0-9a-f]{20}$/.test(o1.refund.gateway_orderid) && o1.refund.method === "card",
    "a card-network refund opens pending, with its own order id and the payment's method", JSON.stringify(o1));
  ok((await pay(db, 3)).amount_cents === 40000, "…and moves no money yet");
  const replay = await open(db, 3, 10000, "key-card-0001", "gateway");
  ok(replay.replay === true && replay.refund.id === o1.refund.id, "the same key again is a replay of the same refund", JSON.stringify(replay));
  const second = await open(db, 3, 5000, "key-card-0002", "gateway");
  ok(second.refused === "in_flight", "a second refund while one is pending is refused", JSON.stringify(second));
  const reused = await open(db, 3, 9999, "key-card-0001", "gateway");
  ok(reused.refused === "key_reused", "a key reused for another amount is refused", JSON.stringify(reused));
  const d1 = await close(db, o1.refund.id, "done", "rf-901", "00", "Approval");
  const after1 = await pay(db, 3);
  ok(d1.done && after1.amount_cents === 30000 && after1.refunded_cents === 10000 && !after1.voided_at,
    "done moves the money: 400.00 -> 300.00 left, 100.00 refunded", JSON.stringify(after1));
  ok(/Refunded \$100\.00 on \d{4}-\d{2}-\d{2} \(ref rf-901\)$/.test(after1.note), "…with a note line naming the refund's reference", after1.note);
  const d1b = await close(db, o1.refund.id, "done", "rf-901");
  ok(d1b.already === true && (await pay(db, 3)).amount_cents === 30000, "a second close of the same refund moves nothing");
  const replayDone = await open(db, 3, 10000, "key-card-0001", "gateway");
  ok(replayDone.replay && replayDone.refund.state === "done" && replayDone.payment.amount_cents === 30000,
    "a replay after it is done says done, with the payment as it is now", JSON.stringify(replayDone));
  const tooMuch = await open(db, 3, 30001, "key-card-0003", "gateway");
  ok(tooMuch.refused === "amount" && tooMuch.refundable_cents === 30000, "more than is left is refused, naming what is left", JSON.stringify(tooMuch));

  // failed frees the payment and moves nothing
  const o2 = await open(db, 3, 5000, "key-card-0004", "gateway");
  const f2 = await close(db, o2.refund.id, "failed", null, "29", "Txn not settled");
  ok(f2.failed && f2.refund.state === "failed" && f2.refund.gateway_resptext === "Txn not settled" && (await pay(db, 3)).amount_cents === 30000,
    "failed records the gateway's answer and moves nothing", JSON.stringify(f2));
  // unknown blocks the next one
  const o3 = await open(db, 3, 5000, "key-card-0005", "gateway");
  await close(db, o3.refund.id, "unknown");
  ok((await open(db, 3, 1000, "key-card-0006", "gateway")).refused === "in_flight", "an UNKNOWN refund blocks the next one too");
  await close(db, o3.refund.id, "done", "rf-905");
  // the rest, in two partials, to zero
  await close(db, (await open(db, 3, 20000, "key-card-0007", "gateway")).refund.id, "done", "rf-907");
  const last = await close(db, (await open(db, 3, 5000, "key-card-0008", "gateway")).refund.id, "done", "rf-908");
  const zero = await pay(db, 3);
  ok(zero.amount_cents === 0 && zero.refunded_cents === 40000 && zero.voided_at && zero.void_reason === "refunded $400.00",
    "partials down to nothing void it, with the total in void_reason", JSON.stringify(zero));
  ok(last.payment.amount_cents === 0 && zero.note.split("\n").length === 4, "four done refunds, four note lines", zero.note);
  ok((await open(db, 3, 100, "key-card-0009", "gateway")).refused === "voided", "a voided payment refuses another refund");
  const ledger = await rows(db, `select state, count(*)::int n, sum(amount_cents)::int s from public.payment_refunds where payment_id = '${P(3)}' group by state order by state`);
  ok(JSON.stringify(ledger) === JSON.stringify([{ state: "done", n: 4, s: 40000 }, { state: "failed", n: 1, s: 5000 }]),
    "the ledger holds four done (400.00) and one failed", JSON.stringify(ledger));

  // ── 5. Kinds, by hand, other tenants ────────────────────────────────────────────────────
  ok((await open(db, 4, 100, "key-hand-0001", "gateway")).refused === "not_gateway", "a card-network refund of a hand-recorded payment is refused");
  ok((await open(db, 2, 100, "key-card-0010", "manual")).refused === "not_manual", "a by-hand refund of a card-network payment is refused");
  ok((await open(db, 4, 100, "key-hand-0002", "manual", { client: "other-builder" })).refused === "not_found", "another tenant's payment is not found");
  const m1 = await open(db, 4, 7500, "key-hand-0003", "manual", { method: "check", reference: "chk 1043", reason: "trim kit returned" });
  const cash = await pay(db, 4);
  ok(m1.done && m1.opened && m1.refund.state === "done" && m1.refund.gateway_orderid === null && cash.amount_cents === 22500 && cash.refunded_cents === 7500,
    "a by-hand refund is done in one call: 300.00 -> 225.00", JSON.stringify(m1));
  ok(/Refunded \$75\.00 by check on \d{4}-\d{2}-\d{2} \(ref chk 1043\)$/.test(cash.note) && cash.note.startsWith("paid at the lot"),
    "…its note line says how it was paid back, under the note already there", cash.note);
  ok((await open(db, 4, 7500, "key-hand-0003", "manual", { method: "check" })).replay === true && (await pay(db, 4)).amount_cents === 22500,
    "a by-hand refund repeated is a replay, not a second refund");
  ok((await open(db, 4, 100, "key-hand-0004", "manual", { method: "wire" })).refused === "method", "an unknown pay-back method is refused");
  ok((await open(db, 4, 100, "short", "manual")).refused === "key", "a key shorter than 8 is refused");

  // short: something emptied the payment while the refund was out
  const o4 = await open(db, 2, 50000, "key-card-0011", "gateway");
  await db.exec("reset role");
  await db.exec(`update public.payments set amount_cents = 10000 where id = '${P(2)}'`);
  await db.exec("set role service_role");
  const s4 = await close(db, o4.refund.id, "done", "rf-911");
  const sp = await pay(db, 2);
  ok(s4.short === true && sp.amount_cents === 0 && sp.voided_at && sp.refunded_cents === 90000,
    "a refund done on a payment with less left than it is recorded, goes no lower than 0, and says `short`", JSON.stringify(sp));
  await db.exec("reset role");
  ok(await refused(db, `insert into public.payment_refunds (client_id, payment_id, order_id, amount_cents, kind, state, request_key)
      values ('example-builder', '${P(4)}', '00000000-0000-4000-8000-0000000000a1', 100, 'manual', 'pending', 'key-direct-1'),
             ('example-builder', '${P(4)}', '00000000-0000-4000-8000-0000000000a1', 100, 'manual', 'unknown', 'key-direct-2')`),
    "the index allows one refund in flight per payment, whatever writes it");

  // ── 6. Lockdown ─────────────────────────────────────────────────────────────────────────
  const priv = (await rows(db, `select
      has_table_privilege('anon', 'public.payment_refunds', 'select') as anon_sel,
      has_table_privilege('authenticated', 'public.payment_refunds', 'select') as auth_sel,
      has_table_privilege('authenticated', 'public.payment_refunds', 'insert') as auth_ins,
      has_table_privilege('authenticated', 'public.payment_refunds', 'update') as auth_upd,
      has_table_privilege('authenticated', 'public.payment_refunds', 'delete') as auth_del,
      has_table_privilege('service_role', 'public.payment_refunds', 'insert') as svc_ins,
      has_function_privilege('authenticated', 'public.payment_refund_open(text,uuid,integer,text,text,uuid,text,text,text)', 'execute') as auth_open,
      has_function_privilege('anon', 'public.payment_refund_close(bigint,text,text,text,text)', 'execute') as anon_close,
      has_function_privilege('authenticated', 'public.payment_refund_close(bigint,text,text,text,text)', 'execute') as auth_close,
      has_function_privilege('service_role', 'public.payment_refund_open(text,uuid,integer,text,text,uuid,text,text,text)', 'execute') as svc_open`))[0];
  ok(!priv.anon_sel && priv.auth_sel && !priv.auth_ins && !priv.auth_upd && !priv.auth_del && priv.svc_ins,
    "the browser reads the ledger and writes nothing; the service role writes", JSON.stringify(priv));
  ok(!priv.auth_open && !priv.anon_close && !priv.auth_close && priv.svc_open, "only the service role runs the refund steps", JSON.stringify(priv));
  await db.exec("set test.client = 'example-builder'");
  await db.exec("set role authenticated");
  const mine = await rows(db, "select count(*)::int n from public.payment_refunds");
  await db.exec("set test.client = 'other-builder'");
  const theirs = await rows(db, "select count(*)::int n from public.payment_refunds");
  await db.exec("reset role");
  ok(mine[0].n === 7 && theirs[0].n === 0, "a builder reads its own refunds and no one else's", JSON.stringify({ mine, theirs }));

  // ── 7. Re-apply, rehearsal, CRLF ────────────────────────────────────────────────────────
  const snap = JSON.stringify(await rows(db, "select id, amount_cents, refunded_cents, voided_at from public.payments order by id"));
  try { await db.exec(M348()); ok(true, "a re-apply runs"); } catch (e) { ok(false, "a re-apply runs", e.message); }
  ok(JSON.stringify(await rows(db, "select id, amount_cents, refunded_cents, voided_at from public.payments order by id")) === snap,
    "…and changes nothing (no second backfill)");

  const rehearse = await fresh();
  try { await rehearse.exec(M348().replace(/^commit;$/m, "rollback;")); } catch (e) { ok(false, "the rehearsal runs", e.message); }
  const left = (await rows(rehearse, `select to_regclass('public.payment_refunds') is null as no_table,
      (select count(*)::int from information_schema.columns where table_name = 'payments' and column_name = 'refunded_cents') as cols,
      (select amount_cents from public.payments where id = '${P(1)}') as full_amt`))[0];
  ok(left.no_table && left.cols === 0 && left.full_amt === 11250, "the rehearsal leaves nothing behind", JSON.stringify(left));

  const crlf = await fresh();
  try {
    await crlf.exec(RAW().replace(/\r?\n/g, "\r\n"));
    ok((await rows(crlf, "select to_regclass('public.payment_refunds') is not null as t"))[0].t, "a CRLF checkout applies the same");
  } catch (e) { ok(false, "a CRLF checkout applies the same", e.message); }

  // ── 8. Refusals ─────────────────────────────────────────────────────────────────────────
  const bare = await fresh("create table public.orders (id uuid primary key, client_id text not null); create unique index on public.orders (id, client_id);");
  ok(/payments is missing/.test(await applyFails(bare)), "a database without payments is refused");
  const noKey = await fresh(TABLES.replace("create unique index orders_id_client_uniq on public.orders (id, client_id);",
    "create unique index orders_id_client_uniq on public.orders (id, client_id);").replace(
    "constraint payments_order_client_fk foreign key (order_id, client_id) references public.orders (id, client_id) on delete cascade", "constraint payments_order_ok check (true)")
    + "drop index public.orders_id_client_uniq;");
  const noKeyMsg = await applyFails(noKey);
  ok(/no unique \(id, client_id\)/.test(noKeyMsg), "orders without a unique (id, client_id) is refused", noKeyMsg);
  ok((await rows(noKey, "select to_regclass('public.payment_refunds') is null as t"))[0].t, "…and nothing is left behind");

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
