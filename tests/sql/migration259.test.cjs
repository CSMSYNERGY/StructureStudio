// Execute migration 259 for real in PGlite (Postgres compiled to WASM, in memory) on top of the
// wallet as 128 + 151 + 164 + 169 + 244 + 248 left it (those files are applied for real), plus the
// phone and sms tables shaped as 150 + 254 left them. Checks: it applies (assertions and probe
// included), leaves nothing behind, backfills existing ledger rows exactly, keeps every pre-259
// wallet path reconciling in cents AND micros, re-applies as a no-op (also over configured
// settings), the RPCs behave as service_role and are refused to the browser roles, and ten
// deliberately broken copies each abort the whole file. Nothing here touches the live project: no network, no Supabase, no Twilio.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration259.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIGDIR = path.join(WT, "supabase/migrations");
// LF only: with core.autocrlf on, a Windows checkout has CRLF .sql files, and the broken-copy
// mutations below match the migration's text across line breaks.
const lf = (s) => s.replace(/\r\n/g, "\n");
const read = (f) => lf(fs.readFileSync(path.join(MIGDIR, f), "utf8"));
const MIG = () => lf(fs.readFileSync(process.env.MIG_FILE || path.join(MIGDIR, "259_usage_billing.sql"), "utf8"));

// 165's three sms meters (as 169 left them: inactive) and 254 PART 9's three phone meters.
const PRICES = `
insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note) values
  ('sms_registration',   'Text messaging setup',  'one-time', 4900, false, true, 20, null),
  ('sms_number_monthly', 'Text messaging number', 'month',    2900, false, true, 21, null),
  ('sms_segment',        'Extra text segment',    'segment',     3, false, false, 22, 'old note'),
  ('phone_line_monthly', 'Phone line', 'month', 0, false, true, 40, null),
  ('voice_minute', 'Call minutes', 'minute', 0, false, true, 41, 'old note'),
  ('voicemail_transcription', 'Voicemail transcription', 'minute', 0, false, true, 42, null)
on conflict (kind) do nothing;`;

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- The project's default ACLs: browser roles get every NEW table, and (244's trap) so does PUBLIC.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;
alter default privileges in schema public grant select on tables to public;

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

create table public.client_settings (
  client_id text primary key, business_name text, billing_exempt boolean not null default false,
  phone_status text not null default 'off');
alter table public.client_settings enable row level security;
revoke all on public.client_settings from public, anon, authenticated;

-- 150 + 254 PART 2
create table public.sms_messages (
  id uuid primary key default gen_random_uuid(), client_id text not null, contact_id uuid, short_code text,
  direction text not null check (direction in ('out', 'in')), from_number text not null, to_number text not null,
  body text, status text not null default 'received'
    check (status in ('claimed', 'sent', 'delivered', 'undelivered', 'failed', 'received')),
  error_code text, provider text not null default 'twilio', provider_sid text, num_segments integer, sent_by uuid,
  delivered_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  client_temp_id text, sent_via text, num_media integer not null default 0);
create unique index sms_messages_sid_uniq on public.sms_messages (provider_sid) where provider_sid is not null and provider_sid <> '';
alter table public.sms_messages enable row level security;
revoke all on public.sms_messages from anon, authenticated;
grant select on public.sms_messages to authenticated;

-- 254 PART 3 (FKs to sms_numbers / crm_contacts dropped: those tables are not stubbed)
create table public.phone_calls (
  id uuid primary key default gen_random_uuid(), client_id text not null, number_id uuid, contact_id uuid,
  direction text not null check (direction in ('in', 'out')), from_e164 text not null, to_e164 text not null,
  twilio_call_sid text unique, client_call_sid text, placed_by uuid, answered_by uuid,
  rang_user_ids uuid[] not null default '{}', transferred_from uuid,
  transfer_state text check (transfer_state in ('transferring', 'conference')),
  status text not null default 'ringing'
    check (status in ('ringing', 'in_progress', 'completed', 'missed', 'voicemail', 'failed', 'busy', 'no_answer')),
  started_at timestamptz not null default now(), answered_at timestamptz, ended_at timestamptz,
  duration_s integer, cost_cents integer, error_code text, is_emergency boolean not null default false);
create table public.phone_call_events (
  id bigint generated always as identity primary key,
  call_id uuid not null references public.phone_calls(id) on delete cascade,
  type text not null, at timestamptz not null default clock_timestamp(), data jsonb);
create table public.phone_voicemails (
  id uuid primary key default gen_random_uuid(), call_id uuid not null unique references public.phone_calls(id) on delete cascade,
  client_id text not null, recording_sid text unique, duration_s integer, transcript text,
  listened_at timestamptz, listened_by uuid, deleted_at timestamptz, created_at timestamptz not null default now());
alter table public.phone_calls enable row level security;
alter table public.phone_call_events enable row level security;
alter table public.phone_voicemails enable row level security;
revoke all on public.phone_calls, public.phone_call_events, public.phone_voicemails from public, anon, authenticated;
grant select, insert, update, delete on public.phone_calls, public.phone_call_events, public.phone_voicemails to service_role;
`;

// Live-shaped history written BEFORE 259: a top-up, a captured 3D generation, a released hold,
// a sales-tax direct-post debit, and two calls and two texts the enqueue should and should not take.
const HISTORY = `
update public.usage_prices set active = true where kind = 'video_3d_generation';
select public.wallet_credit('tenant-a', 5000::bigint, 'topup', 'nmi_sale', 'sale-1', 'Added funds', 'topup-1', null);
select * from public.wallet_hold('tenant-a', 'video_3d_generation', 'press-1', null);
select public.wallet_capture((select id from public.wallet_transactions where idempotency_key = 'press-1'), 120, '{"model":"x"}'::jsonb, 'call-1');
select * from public.wallet_hold('tenant-a', 'video_3d_generation', 'press-2', null);
select public.wallet_release((select id from public.wallet_transactions where idempotency_key = 'press-2'), 'model timeout');
select public.wallet_credit('tenant-a', -25::bigint, 'debit', 'tax', 'inv-1', 'Tax lookup', 'tax-1', null, 'tax_lookup');
update public.usage_prices set active = false where kind = 'video_3d_generation';
insert into public.phone_calls (client_id, direction, from_e164, to_e164, status, started_at, ended_at, duration_s)
values ('tenant-a', 'out', '+15550100001', '+15550100002', 'completed', now() - interval '10 minutes', now() - interval '8 minutes', 120),
       ('tenant-a', 'in',  '+15550100003', '+15550100001', 'in_progress', now() - interval '1 minute', null, null);
insert into public.sms_messages (client_id, direction, from_number, to_number, body, status, provider_sid, created_at)
values ('tenant-a', 'out', '+15550100001', '+15550100002', 'hi', 'delivered', 'SM00000000000000000000000000000001', now() - interval '5 minutes'),
       ('tenant-a', 'in',  '+15550100002', '+15550100001', 'yo', 'received',  'SM00000000000000000000000000000002', now() - interval '4 minutes');
`;

const BASE = () => [
  STUBS,
  read("128_usage_wallet.sql"),
  read("151_wallet_stale_hold_release.sql"),
  read("164_wallet_topup.sql"),
  PRICES,
  read("169_sms_meters_disarmed.sql"),
  read("244_avalara_tax_lookups.sql"),
  read("248_wallet_released_key_reusable.sql"),
  HISTORY,
];

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, p) => (await db.query(sql, p)).rows[0];
const refused = async (db, sql, re, msg) => {
  try { await db.exec(sql); ok(false, msg, "no error"); } catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 110)})`, e.message); }
  try { await db.exec("reset role"); } catch (_e) { /* ignore */ }
};
const fresh = async () => {
  const db = new PGlite();
  for (const sql of BASE()) await db.exec(sql);
  return db;
};
const reconcileOk = async (db) => (await db.query(`select * from public.wallet_reconcile
  where stored_balance_cents <> ledger_balance_cents or stored_held_cents <> ledger_held_cents
     or stored_balance_exact_micros <> ledger_balance_exact_micros`)).rows;

(async () => {
  console.log("migration 259: applies on the live shape");
  {
    const db = await fresh();
    const before = await one(db, "select count(*)::int n from public.wallet_transactions");
    const notices = [];
    let applied = true;
    try { await db.exec(MIG(), { onNotice: (n) => notices.push(n.message) }); } catch (e) { applied = false; ok(false, "259 applied", e.message); }
    ok(applied, "259 applied cleanly, assertions and probe included");
    ok(notices.some((m) => /259 probe: three 4150-micro debits/.test(m)), "the probe ran to its ROLLBACK_PROBE", JSON.stringify(notices));

    // Nothing of the probe is left.
    const left = await one(db, `select
      (select count(*)::int from public.wallet_transactions where client_id like 'probe-259-%') tx,
      (select count(*)::int from public.wallet_accounts where client_id like 'probe-259-%') acct,
      (select count(*)::int from public.client_settings where client_id like 'probe-259-%') cs,
      (select count(*)::int from public.usage_charges) uc,
      (select count(*)::int from public.phone_calls where client_id like 'probe-259-%') calls,
      (select count(*)::int from public.sms_messages where client_id like 'probe-259-%') sms,
      (select count(*)::int from public.wallet_transactions) all_tx`);
    ok(left.tx === 0 && left.acct === 0 && left.cs === 0 && left.uc === 0 && left.calls === 0 && left.sms === 0 && left.all_tx === before.n,
      "the probe left nothing behind", JSON.stringify(left));
    const s = await one(db, "select markup, armed_at, pilot_client_ids, floor_cents, fallback_after_hours from public.phone_billing_settings");
    ok(s.markup === null && s.armed_at === null && Array.isArray(s.pilot_client_ids) && s.pilot_client_ids.length === 0 && s.floor_cents === 500,
      "settings ship disarmed: no markup, no armed_at, empty pilot", JSON.stringify(s));
    const meters = (await db.query(`select kind, pricing, active, visible, price_cents, label from public.usage_prices
      where kind in ('voice_minute','voice_minute_in','sms_segment','sms_in') order by kind`)).rows;
    ok(meters.length === 4 && meters.every((m) => m.pricing === "cost_plus" && m.active === false), "four cost_plus meters, all off", JSON.stringify(meters));
    ok(meters.find((m) => m.kind === "voice_minute_in")?.label === "Incoming call minutes" && meters.find((m) => m.kind === "sms_in")?.label === "Incoming texts", "the two inbound meters carry the contract labels");
    const fixed = await one(db, "select count(*)::int n from public.usage_prices where pricing = 'fixed'");
    ok(fixed.n === 5, "every other meter stays fixed", JSON.stringify(fixed));

    // The backfill is exact for every pre-259 row.
    const bf = (await db.query(`select id, kind, state, amount_cents, amount_exact_micros, balance_after_cents, balance_after_exact_micros
      from public.wallet_transactions order by id`)).rows;
    ok(bf.length >= 4 && bf.every((r) => Number(r.amount_exact_micros) === Number(r.amount_cents) * 10000
      && Number(r.balance_after_exact_micros) === Number(r.balance_after_cents) * 10000), "existing ledger rows backfilled as cents x 10000", JSON.stringify(bf));
    ok((await reconcileOk(db)).length === 0, "wallet_reconcile agrees in cents and micros after the backfill");

    // The worker path, as service_role through the RPCs.
    await db.exec("set role service_role");
    const d1 = await one(db, `select * from public.wallet_usage_debit('tenant-a', 'sms_segment', 12800, 8300, 'sms_message', 'm1',
      'Text to (555) 010-0002 · 1 segment', '{"units":1,"unit":"segment","direction":"out"}'::jsonb, 'usage:sms:m1')`);
    ok(Number(d1.amount_cents) === -1 && d1.replayed === false && Number(d1.amount_exact_micros) === -12800 && Number(d1.cost_micros) === 8300,
      "service_role posts a usage debit (12800 micros -> 1 cent) and is told its exact charge and cost", JSON.stringify(d1));
    // A retry that re-priced the text (a different charge AND cost) is told what the ledger holds.
    const d2 = await one(db, `select * from public.wallet_usage_debit('tenant-a', 'sms_segment', 25600, 9999, 'sms_message', 'm1',
      'x', null, 'usage:sms:m1')`);
    ok(d2.replayed === true && String(d2.tx_id) === String(d1.tx_id) && Number(d2.balance_after_cents) === Number(d1.balance_after_cents)
      && Number(d2.amount_exact_micros) === -12800 && Number(d2.cost_micros) === 8300,
      "a replay as service_role returns the original row, its exact charge and cost included", JSON.stringify(d2));
    const rem = await one(db, "select usage_remainder_micros r, balance_cents b from public.wallet_accounts where client_id = 'tenant-a'");
    ok(rem.r === 2800, "remainder 2800 after one 12800 debit", JSON.stringify(rem));
    const g = await one(db, "select public.wallet_usage_gate('tenant-a', 'voice_minute') g");
    ok(g.g.reason === "disarmed" && g.g.allow === true, "the gate answers disarmed as shipped", JSON.stringify(g));
    const enq = await one(db, "select public.usage_charges_enqueue(now() - interval '3 days', 500) n");
    ok(enq.n === 3, "enqueue takes the finished call and both texts, not the live call", JSON.stringify(enq));
    const enq2 = await one(db, "select public.usage_charges_enqueue(now() - interval '3 days', 500) n");
    ok(enq2.n === 0, "a second enqueue queues nothing new");
    const claimed = (await db.query("select * from public.usage_charges_claim(40, 240)")).rows;
    ok(claimed.length === 3 && claimed.every((r) => r.attempts === 1 && r.lease_until), "claim leases all three", JSON.stringify(claimed.map((r) => [r.source, r.attempts])));
    // The Worker settles one as charged and one as shadow, directly (service_role has the table).
    await db.exec(`update public.usage_charges set state = 'charged', wallet_tx_id = ${d1.tx_id}, cost_micros = 8300, charge_micros = 12800, markup = 1.5, lease_until = null where id = ${claimed[1].id}`);
    await db.exec(`update public.usage_charges set state = 'shadow', cost_micros = 8300, lease_until = null where id = ${claimed[2].id}`);
    await db.exec(`insert into public.twilio_usage_daily (day, category, count, usage, price_micros) values (current_date - 1, 'sms-outbound', 1, 1, 8300)
      on conflict (day, category) do update set price_micros = excluded.price_micros, fetched_at = now()`);
    ok(true, "service_role settles queue rows and upserts twilio_usage_daily");
    await db.exec("reset role");
    ok((await reconcileOk(db)).length === 0, "wallet_reconcile agrees after a usage debit");

    // Pre-259 wallet paths still post, and the trigger fills them, including a capture.
    await db.exec("update public.usage_prices set active = true where kind = 'video_3d_generation'");
    const h = await one(db, "select * from public.wallet_hold('tenant-a', 'video_3d_generation', 'press-3', null)");
    ok(h.err === null && h.hold_id, "wallet_hold still holds", JSON.stringify(h));
    const held = await one(db, `select balance_after_cents b, balance_after_exact_micros x, amount_exact_micros a from public.wallet_transactions where id = ${h.hold_id}`);
    await db.exec(`select public.wallet_capture(${h.hold_id}, 90, null, 'call-3')`);
    const cap = await one(db, `select t.balance_after_cents b, t.balance_after_exact_micros x, a.usage_remainder_micros r, a.balance_cents ab
      from public.wallet_transactions t join public.wallet_accounts a using (client_id) where t.id = ${h.hold_id}`);
    ok(Number(held.a) === -20000000 && Number(cap.x) === Number(cap.b) * 10000 - cap.r && Number(cap.b) === Number(cap.ab),
      "a captured hold's exact balance follows wallet_capture (and keeps the remainder)", JSON.stringify({ held, cap }));
    const cr = await one(db, "select public.wallet_credit('tenant-a', 1000::bigint, 'topup', 'nmi_sale', 's2', 'Added funds', 'topup-2', null) b");
    const crow = await one(db, "select amount_exact_micros a, balance_after_exact_micros x from public.wallet_transactions where idempotency_key = 'topup-2'");
    ok(Number(crow.a) === 10000000 && Number(crow.x) === Number(cr.b) * 10000 - 2800, "a top-up after a usage debit carries the remainder in its exact balance", JSON.stringify({ cr, crow }));
    const rep = await one(db, "select public.wallet_credit('tenant-a', 1000::bigint, 'topup', 'nmi_sale', 's2', 'Added funds', 'topup-2', null) b");
    ok(Number(rep.b) === Number(cr.b), "wallet_credit's replay is unchanged");
    ok((await reconcileOk(db)).length === 0, "wallet_reconcile agrees after holds, captures, credits and usage debits");

    // Explicit exact values win over the trigger.
    await db.exec(`insert into public.wallet_transactions (client_id, kind, amount_cents, balance_after_cents, amount_exact_micros, balance_after_exact_micros, state)
      values ('tenant-x', 'adjustment', 0, 0, -1, -1, 'void')`);
    const ex = await one(db, "select amount_exact_micros a, balance_after_exact_micros x from public.wallet_transactions where client_id = 'tenant-x'");
    ok(Number(ex.a) === -1 && Number(ex.x) === -1, "a writer's own exact values are kept");

    // Constraints the Worker and an operator meet.
    await refused(db, "update public.phone_billing_settings set markup = 0.5", /check constraint|violates/, "a markup below 1.0 is refused");
    await refused(db, "update public.phone_billing_settings set armed_at = now()", /phone_billing_settings_armed_needs_markup/, "armed_at without a markup is refused");
    await refused(db, "insert into public.phone_billing_settings (id) values (false)", /check constraint|violates/, "a second settings row is refused");
    await refused(db, "update public.phone_billing_settings set pilot_client_ids = array['a', null]", /phone_billing_settings_pilot_no_nulls/, "a NULL pilot id is refused");
    await refused(db, "update public.wallet_accounts set usage_remainder_micros = 10000", /usage_remainder_micros/, "a remainder of a whole cent or more is refused");
    await refused(db, `update public.usage_charges set state = 'charged', wallet_tx_id = null where id = ${claimed[0].id}`, /usage_charges_charged_has_tx/, "charged without a ledger row is refused");
    await refused(db, `insert into public.usage_charges (source, source_id, client_id, direction, occurred_at) select source, source_id, client_id, direction, occurred_at from public.usage_charges limit 1`, /usage_charges_source_key/, "a call or text queued twice is refused");

    // Arguments the RPCs refuse.
    await refused(db, "select public.usage_charges_claim(0, 240)", /p_limit must be 1..500/, "claim refuses a limit of 0");
    await refused(db, "select public.usage_charges_claim(40, 5)", /p_lease_s must be 10..3600/, "claim refuses a 5 s lease");
    await refused(db, "select public.usage_charges_enqueue(null, 500)", /p_since is required/, "enqueue refuses a NULL since");
    await refused(db, "select * from public.wallet_usage_debit('tenant-a', null, 1, null, null, null, null, null, 'k')", /p_meter_kind is required/, "a debit with no meter is refused");

    // The browser roles reach none of it.
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["usage_charges", "phone_billing_settings", "twilio_usage_daily", "wallet_reconcile"]) {
        await refused(db, `set role ${role}; select * from public.${t}`, /permission denied/, `${role} cannot read ${t}`);
      }
      await refused(db, `set role ${role}; select public.wallet_usage_gate('tenant-a', 'voice_minute')`, /permission denied/, `${role} cannot call wallet_usage_gate`);
      await refused(db, `set role ${role}; select * from public.wallet_usage_debit('tenant-a', 'sms_segment', 1, null, null, null, null, null, 'k2')`, /permission denied/, `${role} cannot call wallet_usage_debit`);
      await refused(db, `set role ${role}; select public.usage_charges_enqueue(now(), 1)`, /permission denied/, `${role} cannot call usage_charges_enqueue`);
      await refused(db, `set role ${role}; select * from public.usage_charges_claim(1, 60)`, /permission denied/, `${role} cannot call usage_charges_claim`);
      await refused(db, `set role ${role}; select public.phone_usage_armed('tenant-a', 'voice_minute')`, /permission denied/, `${role} cannot call phone_usage_armed`);
    }
    const pc = await one(db, `select has_column_privilege('authenticated','public.phone_calls','cost_cents','SELECT') a,
      has_table_privilege('authenticated','public.phone_calls','SELECT') t`);
    ok(!pc.a && !pc.t, "authenticated cannot read phone_calls.cost_cents (254's posture)", JSON.stringify(pc));

    // Re-applying is a no-op (meters still off), also after the operator has configured the
    // settings row: a markup, a pilot armed, a different floor. The probe must test the functions
    // against the shipped values and leave the live row as it found it.
    await db.exec(`update public.phone_billing_settings
      set markup = 2.0, armed_at = now(), pilot_client_ids = array['tenant-a'], floor_cents = 700 where id`);
    const txBefore = await one(db, "select count(*)::int n, sum(amount_exact_micros)::text s from public.wallet_transactions");
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply", e.message); }
    ok(again, "a second apply is harmless, with the settings row configured");
    const kept = await one(db, "select markup::text m, armed_at is not null a, pilot_client_ids p, floor_cents f from public.phone_billing_settings");
    ok(kept.m === "2.000" && kept.a === true && kept.p.length === 1 && kept.p[0] === "tenant-a" && kept.f === 700,
      "and leaves the configured settings exactly as they were", JSON.stringify(kept));
    const txAfter = await one(db, "select count(*)::int n, sum(amount_exact_micros)::text s from public.wallet_transactions");
    ok(txBefore.n === txAfter.n && txBefore.s === txAfter.s, "and moves nothing on the ledger", JSON.stringify({ txBefore, txAfter }));
    const uc = await one(db, "select count(*)::int n from public.usage_charges");
    ok(uc.n === 3, "and keeps the queue", JSON.stringify(uc));
    await db.close();
  }

  console.log("migration 259: the assertions and the probe abort the whole migration");
  const broken = async (label, mutate, re) => {
    const db = await fresh();
    const src = mutate(MIG());
    if (src === MIG()) { ok(false, `${label}: the mutation did not apply`); await db.close(); return; }
    let err = null;
    try { await db.exec(src); } catch (e) { err = e; }
    ok(!!err && re.test(err.message), `${label} stops the apply`, err ? err.message : "applied");
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const n = await one(db, `select to_regclass('public.usage_charges') t,
      (select count(*)::int from information_schema.columns where table_name = 'wallet_accounts' and column_name = 'usage_remainder_micros') c,
      (select count(*)::int from pg_trigger where tgname = 'wallet_transactions_fill_exact') g`);
    ok(n.t === null && n.c === 0 && n.g === 0, `${label}: nothing of 259 is left behind`, JSON.stringify(n));
    await db.close();
  };
  await broken("a browser-readable usage_charges",
    (s) => s.replace("revoke all on public.usage_charges from anon, authenticated;", "revoke all on public.usage_charges from anon;"),
    /259: authenticated holds SELECT on usage_charges/);
  await broken("PUBLIC left on twilio_usage_daily",
    (s) => s.replace("revoke all on public.twilio_usage_daily from public;", ""),
    /259: (PUBLIC holds a privilege on twilio_usage_daily|anon holds SELECT on twilio_usage_daily)/);
  await broken("a claim without a pinned search_path",
    (s) => s.replace(/(create or replace function public\.usage_charges_claim[\s\S]*?security definer\n)set search_path = ''\n/, "$1"),
    /usage_charges_claim\(integer,integer\) must be SECURITY DEFINER/);
  await broken("a debit that rounds instead of carrying the remainder",
    (s) => s.replace("v_cents     := v_total / 10000;", "v_cents     := round(v_total / 10000.0)::bigint;"),
    /259 probe: (first|second|third) 4150 debit answered/);
  await broken("a debit with no replay check",
    // Replay check skipped entirely: the replay probe must catch it.
    (s) => s.replace("if v_id is not null then\n    return query select v_id, v_prev_amt, v_prev_bal, true, v_prev_x, v_prev_cost;", "if false then\n    return query select v_id, v_prev_amt, v_prev_bal, true, v_prev_x, v_prev_cost;"),
    /259 probe: a replayed key answered|duplicate key value/);
  await broken("a replay that echoes the retry's charge and cost instead of the ledger's",
    (s) => s.replace("return query select v_id, v_prev_amt, v_prev_bal, true, v_prev_x, v_prev_cost;", "return query select v_id, v_prev_amt, v_prev_bal, true, -p_charge_micros, p_cost_micros;"),
    /259 probe: a replayed key answered/);
  await broken("a gate that ignores the remainder",
    (s) => s.replace("- pg_catalog.ceil(coalesce(v_rem, 0) / 10000.0)::bigint;", ";"),
    /259 probe: the shipped gate answered/);
  await broken("an INSERT-only fill trigger",
    (s) => s.replace("before insert or update of amount_cents, balance_after_cents on public.wallet_transactions", "before insert on public.wallet_transactions"),
    /259 probe: a captured hold kept a stale exact balance/);
  await broken("an enqueue that limits before skipping queued rows",
    (s) => s.replace(/\n         and not exists \(select 1 from public\.usage_charges u\n                          where u\.source = 'call' and u\.source_id = c\.id\)/, "")
             .replace(/\n         and not exists \(select 1 from public\.usage_charges u\n                          where u\.source = 'sms' and u\.source_id = m\.id\)/, ""),
    /259 probe: a second enqueue with limit 1 queued/);
  await broken("a meter seeded armed",
    (s) => s.replace("('sms_in',          'Incoming texts',        'segment', 0, false, false, 23,", "('sms_in',          'Incoming texts',        'segment', 0, true, false, 23,"),
    /259: a call or text meter is ARMED/);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
