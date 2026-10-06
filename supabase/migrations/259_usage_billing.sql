-- 259_usage_billing.sql — cost-plus usage billing for calls and texts: a wallet that can owe
--                         less than a cent, the queue the phone-api Worker charges from, and
--                         the gate that refuses a call or a text at the wallet floor.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- The meters 254 seeded were FIXED-PRICE: usage_prices.price_cents per minute, posted once a
-- day by the Worker's daily minute debit (cron/usageDebit.ts, retired with this change). That
-- cannot track what a call actually costs us. One "call" is two to five Twilio legs (the
-- customer's PSTN leg, the app leg, a forward, a warm-transfer conference), each billed by the
-- minute at its own rate, and a text is a per-segment price plus a carrier fee. So the price
-- becomes Twilio's own cost for that call or text, times one markup:
--
--     charge = round(cost × markup), optionally capped at ceiling × units
--
-- and the cost is read back from Twilio per call and per text, after the fact, by the Worker
-- (cron/usageCharge.ts). This file is the database half of that.
--
-- ── A WALLET THAT CAN OWE LESS THAN A CENT ───────────────────────────────────────────────
-- A text costs us about 0.83¢ plus a ~0.45¢ carrier fee. The wallet is integer cents
-- (balance_cents, 128) and every reader of it — the Billing card, wallet_hold's funds check,
-- the reconcile view — reads cents. Rounding each text up to a whole cent would overcharge a
-- builder by up to 99% of a text; rounding down would give texts away. So each wallet keeps a
-- REMAINDER: wallet_accounts.usage_remainder_micros (0..9999), meaning "owed but not yet
-- taken". A usage debit adds the charge to the remainder and moves only the whole cents:
--
--     total = remainder + charge_micros;  cents = total / 10000;  remainder = total % 10000
--
-- Three texts at 4150 micros post 0, 0 and 1 cent and leave 2450 owed (PART 9 proves it).
-- Nothing is lost and nothing is rounded twice. The ledger keeps the exact figure beside the
-- cents: wallet_transactions.amount_exact_micros (-4150 on a row whose amount_cents is 0) and
-- balance_after_exact_micros (= balance_after_cents × 10000 − remainder). The cents columns
-- mean exactly what they always meant, so wallet_reconcile's cents check is untouched; it
-- gains a micros check beside it (PART 7).
--
-- Units: micros = millionths of a dollar (bigint). 1 cent = 10 000 micros.
--
-- ── IT SHIPS DISARMED, ON THREE RAILS ────────────────────────────────────────────────────
-- Nothing in this file charges anyone or refuses anything. For a single cent to move, ALL of:
--   1. phone_billing_settings.markup is set AND armed_at is set (both NULL here; a CHECK makes
--      armed_at without a markup impossible);
--   2. the meter's usage_prices row is active (all four ship inactive), OR the tenant is listed
--      in phone_billing_settings.pilot_client_ids (empty here);
--   3. the env rail PHONE_USAGE_METERS = "on" in the caller (the Worker's wrangler.jsonc ships
--      "off"; the edge functions read the same name with Deno.env).
-- And a call or text that happened before armed_at is never charged (the Worker writes it as
-- 'shadow'). COST CAPTURE is separate and runs while all of that is off: the Worker records what
-- every call and text cost us as a 'shadow' usage_charges row (PHONE_USAGE_COST_CAPTURE, default
-- on), so the product owner sees real Twilio costs before choosing a markup.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   wallet_accounts.usage_remainder_micros; wallet_transactions.amount_exact_micros,
--            balance_after_exact_micros, cost_micros; the backfill; the fill trigger
--   PART 2   usage_prices.pricing ('fixed' | 'cost_plus'); voice_minute and sms_segment become
--            cost_plus; voice_minute_in and sms_in are added. All four stay INACTIVE.
--   PART 3   phone_billing_settings   one row: markup, floor, fees, fallbacks, ceilings, pilot
--   PART 4   usage_charges            one row per call or text, the Worker's work queue
--            twilio_usage_daily       Twilio's own daily usage, for the operator to compare
--   PART 5   two indexes the enqueue reads: sms_messages(created_at), phone_calls(ended_at)
--   PART 6   wallet_usage_debit, usage_charges_enqueue, usage_charges_claim,
--            phone_usage_armed, wallet_usage_gate                         (service_role only)
--   PART 7   wallet_reconcile gains the micros columns
--   PART 8   apply-time assertions (they RAISE and abort the transaction)
--   PART 9   a behavioural probe on synthetic rows, rolled back, leaving nothing
--   after commit: verification, arming and the full rollback, as comments
--
-- ── GRANTS: 254's POSTURE ────────────────────────────────────────────────────────────────
-- Default privileges hand every NEW table to anon AND authenticated, and every new function to
-- PUBLIC. So each new table gets RLS enabled, zero policies, `revoke all ... from public` and
-- `from anon, authenticated`, then an explicit select/insert/update/delete grant to
-- service_role. Each new function is SECURITY DEFINER with search_path = '' (every name
-- schema-qualified) and gets `revoke execute ... from public, anon, authenticated` plus a grant
-- to service_role. PART 8 asserts all of it, PUBLIC included.
--   cost_micros (wallet_transactions and usage_charges) and phone_billing_settings.markup are
--   OUR margin. No browser role can read any of these tables, and portal-billing's wallet
--   projection names its columns: it never selects cost_cents or usage, and must never select
--   cost_micros either. (The exact amount and balance columns are the builder's own money and
--   are safe to show.)
--
-- ── phone_calls.cost_cents (asked of this stream) ────────────────────────────────────────
-- Tenants cannot read it. phone_calls is RLS on, zero policies, revoked from public, anon and
-- authenticated (254 PART 3, asserted in 254 PART 10), and no later migration grants on it.
-- Every read a builder's app or portal gets goes through the Worker or portal-settings with an
-- explicit column list that omits cost_cents (phone-api db.ts CALL_COLUMNS, reads.ts
-- CALL_SELECT, portal-settings phone_calls_report, _shared/crmFeed.ts slot 14), and the
-- realtime broadcasts carry ids only. So the Worker may write it. The guard is those column
-- lists: a future `select("*")` on phone_calls in a tenant-facing route would serve it.
--
-- ── CHOICES THE PLAN LEFT OPEN (all additive) ────────────────────────────────────────────
--   1. The fill trigger also fires BEFORE UPDATE OF amount_cents, balance_after_cents.
--      wallet_hold writes a held row with the balance BEFORE the hold and wallet_capture
--      rewrites balance_after_cents when it posts; an INSERT-only trigger would leave every
--      captured 3D generation with a stale exact balance. It only fills a value the writer did
--      not set itself, and it never raises: every existing wallet path (top-ups included) now
--      runs through it.
--   2. phone_billing_settings carries backstop CHECKs beyond markup's: armed_at needs a
--      markup; floor, fees and fallbacks are >= 0; fallback_after_hours 1..168; ceilings > 0
--      when set; pilot_client_ids holds no NULL.
--   3. usage_charges: source and direction are NOT NULL (the (source, source_id) key is the
--      dedupe); unit is 'minute' | 'segment'; attempts >= 0; a 'charged' row must name its
--      wallet_transactions row. Two extra indexes: wallet_tx_id (the FK, so a ledger delete is
--      not a scan) and (client_id, occurred_at desc) for per-tenant reports.
--   4. wallet_usage_debit raises on a missing client, meter or idempotency key, and on a single
--      charge above $500 (500 000 000 micros) as well as below zero. The $500 line is a units
--      guard, not a price: Twilio's 4-hour call limit across five legs at markup 10 stays well
--      under it, while a micros/cents mix-up (×10 000) lands far over it. A raise leaves the
--      queue row pending for the Worker's retry and failure handling; it never posts. It also
--      returns amount_exact_micros and cost_micros, the ORIGINAL line's on a replay, so a retry
--      that re-priced the call records what the ledger holds.
--   5. usage_charges_enqueue skips rows already queued BEFORE its LIMIT (not only through ON
--      CONFLICT), oldest first, so a limit always makes progress instead of re-reading the same
--      500 queued rows forever. p_since is required; p_limit 0..5000.
--   6. usage_charges_claim validates p_limit 1..500 and p_lease_s 10..3600, and breaks
--      next_try_at ties by id.
--   7. phone_usage_armed needs the meter's usage_prices row to EXIST, so a typo in a meter name
--      never arms a pilot tenant.
--   8. The two new meters ship visible = false. Their price_cents (0) is not their price; with
--      visible = true, portal-billing would show "$0.00 per minute" the day one is armed. See
--      KNOWN, NOT CLOSED HERE for voice_minute.
--   9. The notes on voice_minute and sms_segment are rewritten (operator-facing only): they
--      described the retired daily debit and a fixed per-segment overage.
--
-- ── KNOWN, NOT CLOSED HERE ───────────────────────────────────────────────────────────────
--   * voice_minute (254) and sms_segment (165) keep visible = true / false and their labels
--     ("Call minutes", "Extra text segment"). portal-billing reads price_cents for every active
--     meter, so before arming either, the Billing card must learn `pricing = 'cost_plus'`, and
--     the product owner should confirm the labels (an outbound-only "Extra text segment" now
--     means every outgoing text segment).
--   * admin-catalog's operator ledger reads wallet_transactions.cost_cents, which usage debits
--     leave NULL; the exact figure is cost_micros.
--   * wallet_hold's funds check reads balance_cents − held_cents and ignores the remainder (at
--     most one cent). wallet_usage_gate counts it.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. On apply:
--   * every existing wallet_transactions row gets its two exact columns backfilled
--     (cents × 10 000; every remainder is 0 until the first usage debit), so the micros check in
--     wallet_reconcile agrees wherever the cents check already did;
--   * the fill trigger starts running on every wallet write: one primary-key read of
--     wallet_accounts per insert, on a row the writer already holds locked;
--   * two plain CREATE INDEXes take a SHARE lock on sms_messages and phone_calls until commit
--     (inserts wait; reads do not). lock_timeout is 3 s, so the apply gives up rather than
--     queueing customers' texts behind a long transaction;
--   * three new tables and five new functions nothing calls until the Worker and the edge
--     functions carrying this feature are deployed.
-- Apply this BEFORE deploying a Worker with cron/usageCharge.ts, or its enqueue RPC is missing
-- and every 5-minute run logs a fault (and charges nothing).
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Panic button, no schema change (stops charging and refusing; cost capture carries on):
--   update public.phone_billing_settings set armed_at = null where id;
-- The full removal is at the bottom of this file, after the commit, in the order it has to run.
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '3s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the wallet learns micros
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.wallet_accounts
  add column if not exists usage_remainder_micros integer not null default 0
    check (usage_remainder_micros between 0 and 9999);

comment on column public.wallet_accounts.usage_remainder_micros is
  'Migration 259. Micros (millionths of a dollar) owed by this wallet but not yet taken, 0..9999: what is left of usage charges after their whole cents moved. Written only by wallet_usage_debit, under the row lock. Exact balance = balance_cents * 10000 - usage_remainder_micros.';

alter table public.wallet_transactions
  add column if not exists amount_exact_micros        bigint,
  add column if not exists balance_after_exact_micros bigint,
  -- OUR cost, in micros. 128's cost_cents is the same fact for the 3D meter, in whole cents,
  -- and is "the single most sensitive column in the schema"; this one is too.
  add column if not exists cost_micros                bigint;

comment on column public.wallet_transactions.amount_exact_micros is
  'Migration 259. The exact signed amount in micros. For a usage debit it is minus the full charge (a row can move 0 cents and carry -4150); for every other row amount_cents * 10000. Sum over posted rows = the wallet''s exact balance (wallet_reconcile).';
comment on column public.wallet_transactions.balance_after_exact_micros is
  'Migration 259. balance_after_cents * 10000 minus the wallet''s usage_remainder_micros at the time of the write. Filled by the wallet_transactions_fill_exact trigger when the writer does not set it.';
comment on column public.wallet_transactions.cost_micros is
  'Migration 259. OUR cost of a usage debit (Twilio''s price plus carrier fees), in micros. Never served to a tenant.';

-- The backfill, BEFORE the trigger exists. Every remainder is 0 until the first usage debit, so
-- cents × 10 000 is exact for every row written so far. Re-running writes nothing.
update public.wallet_transactions
   set amount_exact_micros = amount_cents * 10000
 where amount_exact_micros is null;
update public.wallet_transactions
   set balance_after_exact_micros = balance_after_cents * 10000
 where balance_after_exact_micros is null;

-- ── The fill trigger ────────────────────────────────────────────────────────────────────
-- wallet_credit, wallet_hold and anything else that writes a ledger row knows nothing about
-- micros; this fills the two exact columns for them. It reads the remainder of the row's wallet,
-- which every one of those writers has already locked (wallet_credit's UPDATE, wallet_hold's
-- FOR UPDATE), so the value cannot move under it. It never raises: a top-up must not fail
-- because of a column it does not know exists. A writer that sets a value (wallet_usage_debit)
-- keeps it.
create or replace function public.wallet_tx_fill_exact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_rem integer;
begin
  if tg_op = 'INSERT' then
    if new.amount_exact_micros is null then
      new.amount_exact_micros := new.amount_cents * 10000;
    end if;
    if new.balance_after_exact_micros is null then
      select a.usage_remainder_micros into v_rem
        from public.wallet_accounts a where a.client_id = new.client_id;
      new.balance_after_exact_micros := new.balance_after_cents * 10000 - coalesce(v_rem, 0);
    end if;
    return new;
  end if;

  -- UPDATE OF amount_cents / balance_after_cents: wallet_capture posting a hold rewrites
  -- balance_after_cents from the pre-hold balance to the real one. Follow it, unless the same
  -- statement set the exact value itself.
  if new.amount_cents is distinct from old.amount_cents
     and new.amount_exact_micros is not distinct from old.amount_exact_micros then
    new.amount_exact_micros := new.amount_cents * 10000;
  end if;
  if new.balance_after_cents is distinct from old.balance_after_cents
     and new.balance_after_exact_micros is not distinct from old.balance_after_exact_micros then
    select a.usage_remainder_micros into v_rem
      from public.wallet_accounts a where a.client_id = new.client_id;
    new.balance_after_exact_micros := new.balance_after_cents * 10000 - coalesce(v_rem, 0);
  end if;
  return new;
end
$fn$;

comment on function public.wallet_tx_fill_exact() is
  'Migration 259. BEFORE INSERT OR UPDATE OF amount_cents, balance_after_cents on wallet_transactions: fills amount_exact_micros (cents * 10000) and balance_after_exact_micros (cents * 10000 - the wallet''s usage_remainder_micros) when the writer left them unset. Never raises.';

-- A trigger function is checked for EXECUTE when the trigger is created, not when it fires
-- (254 PART 7), so this revoke changes nothing about who can write the ledger.
revoke execute on function public.wallet_tx_fill_exact() from public, anon, authenticated;
grant  execute on function public.wallet_tx_fill_exact() to service_role;

drop trigger if exists wallet_transactions_fill_exact on public.wallet_transactions;
create trigger wallet_transactions_fill_exact
  before insert or update of amount_cents, balance_after_cents on public.wallet_transactions
  for each row execute function public.wallet_tx_fill_exact();

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — the price list learns cost-plus
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 'fixed' is every meter so far: price_cents per unit. 'cost_plus' means price_cents is unused
-- and the charge is the measured cost times phone_billing_settings.markup. Outbound keeps the
-- meter names it already has (voice_minute, sms_segment); inbound gets its own pair, because
-- Twilio prices the two directions differently and a builder may want to see them apart.
alter table public.usage_prices
  add column if not exists pricing text not null default 'fixed'
    check (pricing in ('fixed', 'cost_plus'));

comment on column public.usage_prices.pricing is
  'Migration 259. fixed = price_cents per unit (every meter before 259). cost_plus = price_cents is unused; each call or text is charged its Twilio cost times phone_billing_settings.markup, by the phone-api Worker (cron/usageCharge.ts).';

insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note, pricing)
values
  ('voice_minute_in', 'Incoming call minutes', 'minute',  0, false, false, 43,
   'Migration 259. Incoming calls, cost_plus: each call is charged its Twilio cost (every leg, plus any voicemail recording) times phone_billing_settings.markup. price_cents is unused. Charged per call by the phone-api Worker.', 'cost_plus'),
  ('sms_in',          'Incoming texts',        'segment', 0, false, false, 23,
   'Migration 259. Incoming texts, cost_plus: each text is charged its Twilio price plus the inbound carrier fee estimate, times phone_billing_settings.markup. price_cents is unused. Charged per text by the phone-api Worker.', 'cost_plus')
on conflict (kind) do nothing;

-- Guarded on pricing, so a re-run neither churns updated_at nor overwrites a note an operator
-- has edited since. active is not touched: both rows are off (169, 254) and PART 8 checks it.
update public.usage_prices
   set pricing = 'cost_plus',
       note = 'Migration 259. Outgoing call minutes, cost_plus: each call is charged its Twilio cost (every leg it used, conference legs estimated) times phone_billing_settings.markup, per call, by the phone-api Worker. price_cents is unused. Replaces 254''s daily per-minute debit.',
       updated_at = now()
 where kind = 'voice_minute' and pricing <> 'cost_plus';
update public.usage_prices
   set pricing = 'cost_plus',
       note = 'Migration 259. Outgoing text segments, cost_plus: each text is charged its Twilio price plus the outbound carrier fee estimate, times phone_billing_settings.markup, per text, by the phone-api Worker. price_cents is unused (it was 165''s fixed overage price).',
       updated_at = now()
 where kind = 'sms_segment' and pricing <> 'cost_plus';
update public.usage_prices
   set pricing = 'cost_plus', updated_at = now()
 where kind in ('voice_minute_in', 'sms_in') and pricing <> 'cost_plus';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — phone_billing_settings: one row of knobs
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A table rather than Worker env vars because the product owner changes these (the markup
-- above all) without a deploy, and because the Worker and the edge functions must read the
-- SAME markup and floor. One row, enforced by the key: id is a boolean that can only be true.
create table if not exists public.phone_billing_settings (
  id                          boolean primary key default true check (id),
  -- NULL = not chosen yet, and then nothing can arm (see the CHECK below).
  markup                      numeric(6,3) check (markup between 1.0 and 10.0),
  floor_cents                 integer not null default 500,
  carrier_fee_out_micros      integer not null default 4500,
  carrier_fee_in_micros       integer not null default 3500,
  fallback_out_min_micros     integer not null default 14000,
  fallback_in_min_micros      integer not null default 8500,
  fallback_client_min_micros  integer not null default 4000,
  fallback_sms_seg_micros     integer not null default 8300,
  fallback_after_hours        integer not null default 6,
  ceiling_min_micros          integer,
  ceiling_seg_micros          integer,
  bill_unanswered_calls       boolean not null default false,
  pilot_client_ids            text[] not null default '{}',
  armed_at                    timestamptz,
  updated_at                  timestamptz default now(),
  updated_by                  uuid,
  constraint phone_billing_settings_armed_needs_markup check (armed_at is null or markup is not null),
  constraint phone_billing_settings_amounts_nonneg check (
    floor_cents >= 0
    and carrier_fee_out_micros >= 0 and carrier_fee_in_micros >= 0
    and fallback_out_min_micros >= 0 and fallback_in_min_micros >= 0
    and fallback_client_min_micros >= 0 and fallback_sms_seg_micros >= 0),
  constraint phone_billing_settings_fallback_hours check (fallback_after_hours between 1 and 168),
  constraint phone_billing_settings_ceilings_positive check (
    (ceiling_min_micros is null or ceiling_min_micros > 0)
    and (ceiling_seg_micros is null or ceiling_seg_micros > 0)),
  constraint phone_billing_settings_pilot_no_nulls check (array_position(pilot_client_ids, null) is null)
);

drop trigger if exists phone_billing_settings_set_updated_at on public.phone_billing_settings;
create trigger phone_billing_settings_set_updated_at
  before update on public.phone_billing_settings
  for each row execute function public.set_updated_at();

insert into public.phone_billing_settings (id) values (true) on conflict (id) do nothing;

comment on table public.phone_billing_settings is
  'Migration 259. The one row of usage-billing knobs for calls and texts, read by the phone-api Worker and wallet_usage_gate. Armed = markup and armed_at set AND (the meter''s usage_prices row active OR the tenant in pilot_client_ids), and the caller''s PHONE_USAGE_METERS env is on. Service-role only: markup is our margin.';
comment on column public.phone_billing_settings.markup is
  'Charge = round(Twilio cost * markup), 1.0..10.0. NULL = not chosen; nothing can arm until it is.';
comment on column public.phone_billing_settings.floor_cents is
  'Outbound calls and texts are refused while the wallet''s available balance (balance - held - the remainder rounded up) is below this, once armed. Inbound is never refused.';
comment on column public.phone_billing_settings.carrier_fee_out_micros is
  'Estimated carrier pass-through fee per outbound text segment, added to Twilio''s price (Twilio bills carrier fees separately and later).';
comment on column public.phone_billing_settings.carrier_fee_in_micros is
  'Estimated carrier pass-through fee per inbound text segment.';
comment on column public.phone_billing_settings.fallback_out_min_micros is
  'Per-minute cost used for an outbound PSTN leg whose Twilio price never arrived within fallback_after_hours (cost_source estimate).';
comment on column public.phone_billing_settings.fallback_in_min_micros is
  'Per-minute cost used for an inbound PSTN leg whose Twilio price never arrived.';
comment on column public.phone_billing_settings.fallback_client_min_micros is
  'Per-minute cost used for an app (Twilio Client) leg whose Twilio price never arrived.';
comment on column public.phone_billing_settings.fallback_sms_seg_micros is
  'Per-segment cost used for a text whose Twilio price never arrived.';
comment on column public.phone_billing_settings.fallback_after_hours is
  'How long the Worker waits for Twilio to price a call or text before charging the fallback estimate instead.';
comment on column public.phone_billing_settings.ceiling_min_micros is
  'Optional cap on the charge per call minute (charge = min(charge, ceiling * minutes)). NULL = no cap.';
comment on column public.phone_billing_settings.ceiling_seg_micros is
  'Optional cap on the charge per text segment. NULL = no cap.';
comment on column public.phone_billing_settings.bill_unanswered_calls is
  'false (default): missed, no-answer, busy and failed calls are never charged, even though Twilio may bill the attempt.';
comment on column public.phone_billing_settings.pilot_client_ids is
  'Tenants armed before the meters are switched on for everyone (still needs markup, armed_at and the env rail).';
comment on column public.phone_billing_settings.armed_at is
  'When charging began. NULL = disarmed (the panic button). A call or text that happened before it is never charged, only recorded as shadow.';

alter table public.phone_billing_settings enable row level security;
revoke all on public.phone_billing_settings from public;
revoke all on public.phone_billing_settings from anon, authenticated;
grant select, insert, update, delete on public.phone_billing_settings to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — the queue, and Twilio's own daily numbers
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── usage_charges: one row per call or text, from "it ended" to "it is settled" ──────────
-- usage_charges_enqueue writes the row once the call or text is final; the Worker claims it,
-- reads the cost from Twilio, and settles it as one of:
--   shadow        cost recorded, nothing charged (disarmed, before armed_at, or env off)
--   charged       wallet_usage_debit posted; wallet_tx_id names the ledger row
--   exempt        the tenant is metered_exempt or billing_exempt
--   not_billable  nothing to charge (a missed call, a failed text, an error code)
--   failed        gave up after the Worker's retries; last_error says why
-- 'pending' rows wait for next_try_at; a claim leases a row for lease_until so two runs never
-- work it at once, and a crashed run's lease simply runs out.
create table if not exists public.usage_charges (
  id            bigint generated always as identity primary key,
  source        text not null check (source in ('call', 'sms')),
  source_id     uuid not null,                         -- phone_calls.id | sms_messages.id
  client_id     text not null,
  direction     text not null check (direction in ('in', 'out')),
  occurred_at   timestamptz not null,                  -- the call's started_at | the text's created_at
  state         text not null default 'pending'
    check (state in ('pending', 'shadow', 'charged', 'exempt', 'not_billable', 'failed')),
  attempts      integer not null default 0 check (attempts >= 0),
  next_try_at   timestamptz not null default now(),
  lease_until   timestamptz,
  cost_micros   bigint,                                -- OUR cost. Never served to a tenant.
  cost_source   text check (cost_source in ('twilio', 'estimate', 'mixed')),
  cost_detail   jsonb,                                 -- per-leg prices, for the operator
  units         numeric(10,2),
  unit          text check (unit in ('minute', 'segment')),
  charge_micros bigint,                                -- what was (or, for shadow, would be) charged
  markup        numeric(6,3),                          -- the markup that charge used
  wallet_tx_id  bigint references public.wallet_transactions(id),
  memo          text,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint usage_charges_source_key unique (source, source_id),
  constraint usage_charges_charged_has_tx check (state <> 'charged' or wallet_tx_id is not null)
);

create index if not exists usage_charges_state_next_idx
  on public.usage_charges (state, next_try_at);
create index if not exists usage_charges_wallet_tx_idx
  on public.usage_charges (wallet_tx_id) where wallet_tx_id is not null;
create index if not exists usage_charges_client_occurred_idx
  on public.usage_charges (client_id, occurred_at desc);

drop trigger if exists usage_charges_set_updated_at on public.usage_charges;
create trigger usage_charges_set_updated_at
  before update on public.usage_charges
  for each row execute function public.set_updated_at();

comment on table public.usage_charges is
  'Migration 259. One row per finished call (source call, phone_calls.id) or text (source sms, sms_messages.id): the phone-api Worker''s queue for reading the Twilio cost and settling the charge. state: pending | shadow | charged | exempt | not_billable | failed. Written by usage_charges_enqueue, leased by usage_charges_claim, settled by the Worker. Service-role only: cost_micros is our cost.';

alter table public.usage_charges enable row level security;
revoke all on public.usage_charges from public;
revoke all on public.usage_charges from anon, authenticated;
grant select, insert, update, delete on public.usage_charges to service_role;

-- ── twilio_usage_daily: what Twilio says it billed, per day and category ────────────────
-- The Worker's 09:00 UTC run stores yesterday's Usage Records (Daily). It is the check on the
-- per-call costs above: summed usage_charges.cost_micros for a day should land near the
-- calls-* and sms-* rows here, and a gap says a leg or a fee is being missed.
create table if not exists public.twilio_usage_daily (
  day          date        not null,
  category     text        not null,
  count        numeric,
  usage        numeric,
  price_micros bigint,
  fetched_at   timestamptz not null default now(),
  primary key (day, category)
);

comment on table public.twilio_usage_daily is
  'Migration 259. Twilio Usage Records (Daily) for the whole account, one row per day and category (calls-inbound, sms-outbound, ...), price in positive micros. Upserted by the phone-api Worker each morning for yesterday. Operator-only: it is our cost.';

alter table public.twilio_usage_daily enable row level security;
revoke all on public.twilio_usage_daily from public;
revoke all on public.twilio_usage_daily from anon, authenticated;
grant select, insert, update, delete on public.twilio_usage_daily to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — the two reads usage_charges_enqueue makes every 5 minutes
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Neither table had an index that leads with the time column the enqueue filters on (150's
-- are all client-first), so without these each run would scan both tables whole.
create index if not exists sms_messages_created_idx on public.sms_messages (created_at);
create index if not exists phone_calls_ended_idx    on public.phone_calls (ended_at);

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 6 — the functions. SECURITY DEFINER, search_path '', service_role only.
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── wallet_usage_debit: post one usage charge, to the micro ─────────────────────────────
-- ORDER IS THE POINT. The wallet row is locked FIRST, and only then is the idempotency key
-- looked up: a second call with the same key (a Worker retry after a lost reply, two runs
-- racing on one queue row) waits on the lock, then finds the first one's row committed and
-- returns it with replayed = true. Checking the key first (wallet_credit's order) would let both
-- pass the check before either inserted.
--
-- NEVER REFUSES FOR FUNDS. The call was made and the text was sent; the money is owed whatever
-- the balance says (the taxMeter / 254 posture). The balance may go negative. Refusing is the
-- gate's job, before the next call (wallet_usage_gate).
--
-- Returns the ledger row: tx_id, amount_cents (the whole cents this charge moved, <= 0),
-- balance_after_cents, replayed, amount_exact_micros (-charge) and cost_micros. A replay returns
-- the ORIGINAL row's values, and the last two are why: a retry after a lost reply may arrive
-- with a different charge or cost (Twilio priced a leg that was estimated the first time, or
-- the markup was edited in between), and the Worker must record what the ledger holds, not
-- what it worked out this time.
--
-- Dropped first: CREATE OR REPLACE cannot change a function's result columns, and drafts of
-- this file returned only the first four. The revoke and grant below follow in the same
-- transaction, so there is no moment without them.
drop function if exists public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text);
create or replace function public.wallet_usage_debit(
  p_client_id     text,
  p_meter_kind    text,
  p_charge_micros bigint,
  p_cost_micros   bigint,
  p_ref_type      text,
  p_ref_id        text,
  p_memo          text,
  p_usage         jsonb,
  p_idem          text
) returns table (tx_id bigint, amount_cents bigint, balance_after_cents bigint, replayed boolean,
                  amount_exact_micros bigint, cost_micros bigint)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_bal       bigint;
  v_rem       integer;
  v_total     bigint;
  v_cents     bigint;
  v_rem_after integer;
  v_id        bigint;
  v_prev_amt  bigint;
  v_prev_bal  bigint;
  v_prev_x    bigint;
  v_prev_cost bigint;
begin
  -- Every column below is qualified: the OUT names amount_cents, balance_after_cents,
  -- amount_exact_micros and cost_micros are also wallet_transactions columns, and an
  -- unqualified one is "ambiguous" in PL/pgSQL.
  if p_client_id is null or p_client_id = '' then
    raise exception 'wallet_usage_debit: p_client_id is required';
  end if;
  if p_meter_kind is null or p_meter_kind = '' then
    raise exception 'wallet_usage_debit: p_meter_kind is required';
  end if;
  if p_idem is null or p_idem = '' then
    -- A usage debit with no key is a double charge waiting for the first retry.
    raise exception 'wallet_usage_debit: p_idem is required';
  end if;
  if p_charge_micros is null or p_charge_micros < 0 then
    raise exception 'wallet_usage_debit: p_charge_micros must be zero or more (got %)', p_charge_micros;
  end if;
  if p_charge_micros > 500000000 then
    raise exception 'wallet_usage_debit: a single charge of % micros is over the $500 units guard', p_charge_micros;
  end if;

  -- 1. The wallet row exists, and is ours until commit.
  insert into public.wallet_accounts (client_id) values (p_client_id)
    on conflict (client_id) do nothing;
  select a.balance_cents, a.usage_remainder_micros into v_bal, v_rem
    from public.wallet_accounts a
   where a.client_id = p_client_id
     for update;

  -- 2. Replay: the same intent already posted. A released row does not count (248's index
  --    reads the same way), though a usage debit is never held, so none is ever released.
  select t.id, t.amount_cents, t.balance_after_cents, t.amount_exact_micros, t.cost_micros
    into v_id, v_prev_amt, v_prev_bal, v_prev_x, v_prev_cost
    from public.wallet_transactions t
   where t.client_id = p_client_id and t.idempotency_key = p_idem and t.state <> 'released'
   order by t.id desc
   limit 1;
  if v_id is not null then
    return query select v_id, v_prev_amt, v_prev_bal, true, v_prev_x, v_prev_cost;
    return;
  end if;

  -- 3. Whole cents move; the rest stays owed.
  v_total     := v_rem + p_charge_micros;
  v_cents     := v_total / 10000;
  v_rem_after := (v_total % 10000)::integer;

  update public.wallet_accounts a
     set balance_cents          = a.balance_cents - v_cents,
         usage_remainder_micros = v_rem_after,
         updated_at             = pg_catalog.now()
   where a.client_id = p_client_id
  returning a.balance_cents into v_bal;

  -- 4. The ledger row, exact columns set here so the fill trigger leaves them alone.
  insert into public.wallet_transactions
    (client_id, kind, amount_cents, balance_after_cents, amount_exact_micros,
     balance_after_exact_micros, cost_micros, meter_kind, state, idempotency_key,
     ref_type, ref_id, memo, usage, posted_at)
  values
    (p_client_id, 'debit', -v_cents, v_bal, -p_charge_micros,
     v_bal * 10000 - v_rem_after, p_cost_micros, p_meter_kind, 'posted', p_idem,
     nullif(p_ref_type, ''), nullif(p_ref_id, ''), p_memo, p_usage, pg_catalog.now())
  returning id into v_id;

  return query select v_id, -v_cents, v_bal, false, -p_charge_micros, p_cost_micros;
end
$fn$;

comment on function public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text) is
  'Migration 259. Posts one cost-plus usage charge (micros) to a wallet: locks the wallet row, returns the existing row for a repeated p_idem (replayed = true, with that row''s own amount_exact_micros and cost_micros, whatever this call passed), else moves the whole cents of remainder + charge and keeps the rest in usage_remainder_micros. Never refuses for funds (the balance may go negative). Raises on a missing client, meter or key, a negative charge, or one above 500000000 micros. Service-role only (phone-api cron/usageCharge.ts).';

revoke execute on function public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text) from public, anon, authenticated;
grant  execute on function public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text) to service_role;

-- ── usage_charges_enqueue: queue every call and text that has finished ──────────────────
-- One set-based insert. A row is queued once it can no longer change in a way that matters:
--   calls  status completed | missed | voicemail | no_answer | busy | failed, ended_at >= p_since
--          (occurred_at = started_at). Ringing and in-progress calls wait for the next run.
--   texts  outbound sent | delivered | undelivered | failed, inbound received, with a Twilio SID
--          (a text that never reached Twilio cost nothing), created_at >= p_since. 'sent' is
--          queued before it settles to delivered; the Worker waits for Twilio's price anyway.
-- Unbillable rows are queued too, so their cost is still recorded and the queue says why
-- nothing was charged. Already-queued rows are skipped BEFORE the limit (CHOICE 5); ON CONFLICT
-- covers two runs racing. Returns how many rows it queued.
create or replace function public.usage_charges_enqueue(p_since timestamptz, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
begin
  if p_since is null then
    raise exception 'usage_charges_enqueue: p_since is required';
  end if;
  if p_limit is null or p_limit < 0 or p_limit > 5000 then
    raise exception 'usage_charges_enqueue: p_limit must be 0..5000 (got %)', p_limit;
  end if;

  insert into public.usage_charges (source, source_id, client_id, direction, occurred_at)
  select s.source, s.source_id, s.client_id, s.direction, s.occurred_at
    from (
      select 'call'::text as source, c.id as source_id, c.client_id, c.direction,
             c.started_at as occurred_at, c.ended_at as ready_at
        from public.phone_calls c
       where c.ended_at >= p_since
         and c.status in ('completed', 'missed', 'voicemail', 'no_answer', 'busy', 'failed')
         and not exists (select 1 from public.usage_charges u
                          where u.source = 'call' and u.source_id = c.id)
      union all
      select 'sms'::text, m.id, m.client_id, m.direction, m.created_at, m.created_at
        from public.sms_messages m
       where m.created_at >= p_since
         and m.provider_sid is not null and m.provider_sid <> ''
         and ((m.direction = 'out' and m.status in ('sent', 'delivered', 'undelivered', 'failed'))
              or (m.direction = 'in' and m.status = 'received'))
         and not exists (select 1 from public.usage_charges u
                          where u.source = 'sms' and u.source_id = m.id)
    ) s
   order by s.ready_at, s.source, s.source_id
   limit p_limit
  on conflict (source, source_id) do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.usage_charges_enqueue(timestamptz, integer) is
  'Migration 259. Queues finished calls (ended_at >= p_since) and texts with a Twilio SID (created_at >= p_since) into usage_charges, oldest first, at most p_limit, skipping ones already queued. Returns the number queued. Service-role only (phone-api cron/usageCharge.ts).';

revoke execute on function public.usage_charges_enqueue(timestamptz, integer) from public, anon, authenticated;
grant  execute on function public.usage_charges_enqueue(timestamptz, integer) to service_role;

-- ── usage_charges_claim: lease the next rows due ────────────────────────────────────────
-- SKIP LOCKED, so two Worker runs that overlap take different rows instead of waiting on each
-- other; the lease is what keeps a row from being taken twice once the claim has committed.
-- attempts counts claims, so a row that keeps crashing its run is visible and can be failed.
create or replace function public.usage_charges_claim(p_limit integer, p_lease_s integer)
returns setof public.usage_charges
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'usage_charges_claim: p_limit must be 1..500 (got %)', p_limit;
  end if;
  if p_lease_s is null or p_lease_s < 10 or p_lease_s > 3600 then
    raise exception 'usage_charges_claim: p_lease_s must be 10..3600 (got %)', p_lease_s;
  end if;

  return query
    with picked as (
      select u.id
        from public.usage_charges u
       where u.state = 'pending'
         and u.next_try_at <= pg_catalog.now()
         and (u.lease_until is null or u.lease_until < pg_catalog.now())
       order by u.next_try_at, u.id
       limit p_limit
         for update skip locked
    )
    update public.usage_charges u
       set lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_s),
           attempts    = u.attempts + 1
      from picked
     where u.id = picked.id
    returning u.*;
end
$fn$;

comment on function public.usage_charges_claim(integer, integer) is
  'Migration 259. Leases up to p_limit pending usage_charges rows that are due (next_try_at passed, no live lease) for p_lease_s seconds, oldest first, FOR UPDATE SKIP LOCKED; attempts + 1. Returns the leased rows. Service-role only (phone-api cron/usageCharge.ts).';

revoke execute on function public.usage_charges_claim(integer, integer) from public, anon, authenticated;
grant  execute on function public.usage_charges_claim(integer, integer) to service_role;

-- ── phone_usage_armed: is this meter charging this tenant? ──────────────────────────────
-- THE ONE DEFINITION of armed, which wallet_usage_gate also calls. The env rail
-- (PHONE_USAGE_METERS) is the caller's; this is the database's half:
--   markup set AND armed_at set AND the meter's row exists AND (it is active OR the tenant is
--   in the pilot list).
-- No settings row, no meter row, a NULL anything: not armed. Every doubt falls to "free".
create or replace function public.phone_usage_armed(p_client_id text, p_meter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((
    select s.markup is not null
       and s.armed_at is not null
       and (coalesce(up.active, false)
            or coalesce(p_client_id = any (s.pilot_client_ids), false))
      from public.phone_billing_settings s
      join public.usage_prices up on up.kind = p_meter
     where s.id
  ), false);
$fn$;

comment on function public.phone_usage_armed(text, text) is
  'Migration 259. true when phone_billing_settings has a markup and armed_at, the usage_prices row p_meter exists, and it is active or p_client_id is in pilot_client_ids. The env rail PHONE_USAGE_METERS is checked by the caller. Service-role only.';

revoke execute on function public.phone_usage_armed(text, text) from public, anon, authenticated;
grant  execute on function public.phone_usage_armed(text, text) to service_role;

-- ── wallet_usage_gate: may this tenant start a call or send a text? ─────────────────────
-- Read-only, no lock: it answers before a call, it does not reserve anything. Answers
--   {allow, reason, available_cents, floor_cents, auto_topup_enabled}
-- reason disarmed    not armed for this tenant and meter (allow)
--        exempt      wallet_accounts.metered_exempt or client_settings.billing_exempt (allow)
--        above_floor available >= floor (allow)
--        below_floor available < floor (REFUSE)
-- available = balance − held − the remainder rounded up to a cent: what could be spent now,
-- counting the fraction already owed. No wallet row reads as zero. auto_topup_enabled lets the
-- caller say "being topped up" instead of "empty" and fire the top-up.
create or replace function public.wallet_usage_gate(p_client_id text, p_meter text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_armed          boolean;
  v_floor          integer;
  v_bal            bigint;
  v_held           bigint;
  v_rem            integer;
  v_meter_exempt   boolean;
  v_auto           boolean;
  v_billing_exempt boolean;
  v_avail          bigint;
  v_reason         text;
begin
  v_armed := public.phone_usage_armed(p_client_id, p_meter);

  select s.floor_cents into v_floor from public.phone_billing_settings s where s.id;
  v_floor := coalesce(v_floor, 500);

  select a.balance_cents, a.held_cents, a.usage_remainder_micros, a.metered_exempt, a.auto_topup_enabled
    into v_bal, v_held, v_rem, v_meter_exempt, v_auto
    from public.wallet_accounts a
   where a.client_id = p_client_id;
  select cs.billing_exempt into v_billing_exempt
    from public.client_settings cs
   where cs.client_id = p_client_id;

  v_avail := coalesce(v_bal, 0) - coalesce(v_held, 0)
             - pg_catalog.ceil(coalesce(v_rem, 0) / 10000.0)::bigint;

  if not v_armed then
    v_reason := 'disarmed';
  elsif coalesce(v_meter_exempt, false) or coalesce(v_billing_exempt, false) then
    v_reason := 'exempt';
  elsif v_avail >= v_floor then
    v_reason := 'above_floor';
  else
    v_reason := 'below_floor';
  end if;

  return pg_catalog.jsonb_build_object(
    'allow',              v_reason <> 'below_floor',
    'reason',             v_reason,
    'available_cents',    v_avail,
    'floor_cents',        v_floor,
    'auto_topup_enabled', coalesce(v_auto, false)
  );
end
$fn$;

comment on function public.wallet_usage_gate(text, text) is
  'Migration 259. The wallet floor for calls and texts: {allow, reason: disarmed|exempt|above_floor|below_floor, available_cents, floor_cents, auto_topup_enabled}. available = balance - held - ceil(usage_remainder_micros / 10000). allow = not armed (phone_usage_armed) OR exempt OR available >= floor. Read-only; the env rail is the caller''s. Service-role only (phone-api wallet.ts, _shared/usageGate.ts).';

revoke execute on function public.wallet_usage_gate(text, text) from public, anon, authenticated;
grant  execute on function public.wallet_usage_gate(text, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 7 — wallet_reconcile checks the micros too
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 128's view, verbatim, with two columns appended (CREATE OR REPLACE VIEW may only append).
-- The cents pair keeps meaning exactly what it meant: a usage debit moves balance_cents and
-- amount_cents by the same whole cents. The micros pair is the new invariant:
--   balance_cents * 10000 − usage_remainder_micros = sum(amount_exact_micros) over posted rows
-- which holds for usage debits by construction and for every other row because its exact
-- amount is cents × 10 000 and it leaves the remainder alone.
create or replace view public.wallet_reconcile as
  select a.client_id,
         a.balance_cents                                            as stored_balance_cents,
         coalesce(sum(t.amount_cents) filter (where t.state = 'posted'), 0) as ledger_balance_cents,
         a.held_cents                                               as stored_held_cents,
         coalesce(-sum(t.amount_cents) filter (where t.state = 'held'), 0)  as ledger_held_cents,
         a.balance_cents * 10000 - a.usage_remainder_micros         as stored_balance_exact_micros,
         coalesce(sum(t.amount_exact_micros) filter (where t.state = 'posted'), 0) as ledger_balance_exact_micros
    from public.wallet_accounts a
    left join public.wallet_transactions t on t.client_id = a.client_id
   group by a.client_id, a.balance_cents, a.held_cents, a.usage_remainder_micros;

-- 128 revoked anon and authenticated only; PUBLIC is the grant this project's defaults add.
revoke all on public.wallet_reconcile from public;
revoke all on public.wallet_reconcile from anon, authenticated;
grant select on public.wallet_reconcile to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 8 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_tbl  text;
  v_role text;
  v_priv text;
  v_fn   text;
  v_n    integer;
begin
  -- ── The grant posture on the three new tables (and the extended view) ──
  foreach v_tbl in array array['phone_billing_settings', 'usage_charges', 'twilio_usage_daily'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = ('public.' || v_tbl)::regclass) then
      raise exception '259: RLS is not enabled on %', v_tbl;
    end if;
    if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = ('public.' || v_tbl)::regclass) then
      raise exception '259: % has a policy; it is meant to be service-role only', v_tbl;
    end if;
    foreach v_role in array array['anon', 'authenticated'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(v_role, 'public.' || v_tbl, v_priv) then
          raise exception '259: % holds % on % — the default-privilege trap is open', v_role, v_priv, v_tbl;
        end if;
      end loop;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.' || v_tbl, v_priv) then
        raise exception '259: service_role lacks % on % — the Worker could not use it', v_priv, v_tbl;
      end if;
    end loop;
  end loop;
  foreach v_tbl in array array['phone_billing_settings', 'usage_charges', 'twilio_usage_daily', 'wallet_reconcile'] loop
    if exists (select 1 from pg_catalog.pg_class c,
                      pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
                where c.oid = ('public.' || v_tbl)::regclass and acl.grantee = 0) then
      raise exception '259: PUBLIC holds a privilege on %', v_tbl;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.wallet_reconcile', 'SELECT')
     or has_table_privilege('authenticated', 'public.wallet_reconcile', 'SELECT') then
    raise exception '259: wallet_reconcile is readable by a browser role';
  end if;
  if not has_table_privilege('service_role', 'public.wallet_reconcile', 'SELECT') then
    raise exception '259: service_role cannot read wallet_reconcile';
  end if;

  -- ── The six functions: definer, pinned path, service_role only, PUBLIC included ──
  foreach v_fn in array array[
      'public.wallet_usage_debit(text,text,bigint,bigint,text,text,text,jsonb,text)',
      'public.usage_charges_enqueue(timestamptz,integer)',
      'public.usage_charges_claim(integer,integer)',
      'public.phone_usage_armed(text,text)',
      'public.wallet_usage_gate(text,text)',
      'public.wallet_tx_fill_exact()'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '259: % is callable from the browser', v_fn;
    end if;
    if exists (select 1 from pg_catalog.pg_proc p,
                      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
                where p.oid = v_fn::regprocedure and acl.grantee = 0) then
      raise exception '259: PUBLIC can execute %', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '259: service_role cannot call %', v_fn;
    end if;
    if not (select p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=""%', false)
              from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception '259: % must be SECURITY DEFINER with search_path ''''', v_fn;
    end if;
  end loop;
  -- One overload each, or a PostgREST call by name is ambiguous (PGRST203, 244's lesson).
  select count(*) into v_n from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('wallet_usage_debit', 'usage_charges_enqueue', 'usage_charges_claim',
                       'phone_usage_armed', 'wallet_usage_gate');
  if v_n <> 5 then
    raise exception '259: expected one overload of each of the five RPCs, found % functions', v_n;
  end if;

  -- ── The ledger columns, the backfill and the trigger ──
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'wallet_transactions'
         and column_name in ('amount_exact_micros', 'balance_after_exact_micros', 'cost_micros')) <> 3 then
    raise exception '259: a wallet_transactions micros column is missing';
  end if;
  if exists (select 1 from public.wallet_transactions
              where amount_exact_micros is null or balance_after_exact_micros is null) then
    raise exception '259: the backfill left ledger rows without exact columns';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'wallet_transactions_fill_exact' and not t.tgisinternal and t.tgenabled = 'O'
                    and t.tgrelid = 'public.wallet_transactions'::regclass
                    and t.tgfoid = 'public.wallet_tx_fill_exact()'::regprocedure) then
    raise exception '259: the fill trigger is missing or disabled';
  end if;
  -- Wherever the cents already reconciled, the micros do too (the backfill is exact).
  select count(*) into v_n from public.wallet_reconcile r
   where r.stored_balance_cents = r.ledger_balance_cents
     and r.stored_balance_exact_micros <> r.ledger_balance_exact_micros;
  if v_n <> 0 then
    raise exception '259: % wallet(s) reconcile in cents but not in micros', v_n;
  end if;

  -- ── The meters: four cost_plus rows, every one OFF ──
  if (select count(*) from public.usage_prices
       where kind in ('voice_minute', 'voice_minute_in', 'sms_segment', 'sms_in') and pricing = 'cost_plus') <> 4 then
    raise exception '259: the four call and text meters are not all present and cost_plus';
  end if;
  -- Re-applying this file after a meter has been armed stops here, deliberately: arming is a
  -- separate statement (below the commit), and a re-apply should be a decision too.
  if exists (select 1 from public.usage_prices
              where kind in ('voice_minute', 'voice_minute_in', 'sms_segment', 'sms_in') and active) then
    raise exception '259: a call or text meter is ARMED — they must ship off (169''s rail)';
  end if;
  if (select count(*) from public.phone_billing_settings) <> 1 then
    raise exception '259: phone_billing_settings must hold exactly one row';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 9 — behavioural probe. Synthetic tenants, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 244 and 254's pattern: exercise every branch that matters, then raise ROLLBACK_PROBE so the
-- inner block's writes vanish; any other exception aborts the whole file. The tenants are
-- obviously fake and none has a client_settings row with phone_status 'on', so neither
-- phone_realtime_notify (254) nor phone_push_text (256) sends anything for the rows below.
-- It briefly arms the settings row and one meter, inside the rolled-back block only.
do $probe$
declare
  k_a constant text := 'probe-259-a';   -- debits, replay, a negative balance, a pilot below the floor
  k_b constant text := 'probe-259-b';   -- not in the pilot: disarmed until the meter is active
  k_c constant text := 'probe-259-c';   -- wallet_accounts.metered_exempt
  k_d constant text := 'probe-259-d';   -- client_settings.billing_exempt
  k_e constant text := 'probe-259-e';   -- funded, and a 3D hold captured through the trigger
  r          record;
  g          jsonb;
  v_bal      bigint;
  v_rem      integer;
  v_n        integer;
  v_tx1      bigint;
  v_tx3      bigint;
  v_hold     bigint;
  v_raised   boolean;
  v_amt_x    bigint;
  v_bal_x    bigint;
  v_call     uuid;
  v_call_old uuid;
  v_call_rng uuid;
  v_sms_out  uuid;
  v_sms_in   uuid;
  v_sms_clm  uuid;
  v_sms_nos  uuid;
  v_ids      uuid[];
begin
  begin
    -- ── 0. The shipped settings, whatever the live row says ──
    -- A re-apply may meet a row the operator has since configured (a markup, a pilot list, a
    -- different floor). The probe tests the FUNCTIONS against the shipped values, so it puts
    -- those back first; the ROLLBACK_PROBE below restores the live row untouched. Without this,
    -- a re-apply after "set markup = 2.0" aborted on "armed_at was accepted without a markup".
    update public.phone_billing_settings
       set markup = null, armed_at = null, pilot_client_ids = '{}', floor_cents = 500
     where id;

    -- ── 1. A wallet_credit row: the trigger fills both exact columns ──
    v_bal := public.wallet_credit(k_a, 100::bigint, 'grant', 'probe', null, '259 probe', 'probe-259-credit-1', null);
    select t.amount_exact_micros, t.balance_after_exact_micros into v_amt_x, v_bal_x
      from public.wallet_transactions t where t.client_id = k_a and t.idempotency_key = 'probe-259-credit-1';
    if v_bal <> 100 or v_amt_x is distinct from 1000000 or v_bal_x is distinct from 1000000 then
      raise exception '259 probe: a wallet_credit row was not filled (balance %, exact %, balance exact %)', v_bal, v_amt_x, v_bal_x;
    end if;

    -- ── 2. Three 4150-micro texts post 0, 0 and 1 cent and leave 2450 owed ──
    select * into r from public.wallet_usage_debit(k_a, 'sms_segment', 4150, 3000, 'sms_message', 'probe-1',
      'Text to (555) 010-0001 · 1 segment', '{"units": 1, "unit": "segment", "direction": "out"}'::jsonb, 'usage:sms:probe-259-1');
    if r.amount_cents <> 0 or r.balance_after_cents <> 100 or r.replayed then
      raise exception '259 probe: first 4150 debit answered %', to_jsonb(r);
    end if;
    v_tx1 := r.tx_id;
    select * into r from public.wallet_usage_debit(k_a, 'sms_segment', 4150, 3000, 'sms_message', 'probe-2',
      'Text to (555) 010-0001 · 1 segment', '{"units": 1, "unit": "segment", "direction": "out"}'::jsonb, 'usage:sms:probe-259-2');
    if r.amount_cents <> 0 or r.balance_after_cents <> 100 or r.replayed then
      raise exception '259 probe: second 4150 debit answered %', to_jsonb(r);
    end if;
    select * into r from public.wallet_usage_debit(k_a, 'sms_segment', 4150, 3000, 'sms_message', 'probe-3',
      'Text to (555) 010-0001 · 1 segment', '{"units": 1, "unit": "segment", "direction": "out"}'::jsonb, 'usage:sms:probe-259-3');
    if r.amount_cents <> -1 or r.balance_after_cents <> 99 or r.replayed
       or r.amount_exact_micros is distinct from -4150 or r.cost_micros is distinct from 3000 then
      raise exception '259 probe: third 4150 debit answered %', to_jsonb(r);
    end if;
    v_tx3 := r.tx_id;
    select a.usage_remainder_micros into v_rem from public.wallet_accounts a where a.client_id = k_a;
    if v_rem <> 2450 then
      raise exception '259 probe: remainder after three 4150 debits is %, expected 2450', v_rem;
    end if;
    if not exists (select 1 from public.wallet_transactions t
                    where t.id = v_tx3 and t.kind = 'debit' and t.state = 'posted' and t.posted_at is not null
                      and t.meter_kind = 'sms_segment' and t.amount_cents = -1 and t.amount_exact_micros = -4150
                      and t.balance_after_cents = 99 and t.balance_after_exact_micros = 987550
                      and t.cost_micros = 3000 and t.ref_type = 'sms_message' and t.ref_id = 'probe-3'
                      and t.usage ->> 'unit' = 'segment') then
      raise exception '259 probe: the third debit''s ledger row is not what was posted';
    end if;
    if not exists (select 1 from public.wallet_transactions t
                    where t.id = v_tx1 and t.amount_cents = 0 and t.amount_exact_micros = -4150
                      and t.balance_after_exact_micros = 995850) then
      raise exception '259 probe: a 0-cent debit did not carry its exact amount';
    end if;

    -- ── 3. A replay is a no-op that returns the original row ──
    -- With a different charge and cost on purpose: a Worker retry after a lost reply may have
    -- re-priced the text, and must be told what the ledger holds (usageCharge.ts decide()).
    select * into r from public.wallet_usage_debit(k_a, 'sms_segment', 9990, 4990, 'sms_message', 'probe-3',
      'Text to (555) 010-0001 · 1 segment', '{"units": 1, "unit": "segment", "direction": "out"}'::jsonb, 'usage:sms:probe-259-3');
    if not r.replayed or r.tx_id <> v_tx3 or r.amount_cents <> -1 or r.balance_after_cents <> 99
       or r.amount_exact_micros is distinct from -4150 or r.cost_micros is distinct from 3000 then
      raise exception '259 probe: a replayed key answered %', to_jsonb(r);
    end if;
    select count(*) into v_n from public.wallet_transactions t where t.client_id = k_a;
    select a.balance_cents, a.usage_remainder_micros into v_bal, v_rem from public.wallet_accounts a where a.client_id = k_a;
    if v_n <> 4 or v_bal <> 99 or v_rem <> 2450 then
      raise exception '259 probe: a replay moved money (% rows, balance %, remainder %)', v_n, v_bal, v_rem;
    end if;

    -- ── 4. A credit after a remainder: the exact balance carries what is owed ──
    v_bal := public.wallet_credit(k_a, 5::bigint, 'grant', 'probe', null, '259 probe', 'probe-259-credit-2', null);
    select t.amount_exact_micros, t.balance_after_exact_micros into v_amt_x, v_bal_x
      from public.wallet_transactions t where t.client_id = k_a and t.idempotency_key = 'probe-259-credit-2';
    if v_bal <> 104 or v_amt_x <> 50000 or v_bal_x <> 104 * 10000 - 2450 then
      raise exception '259 probe: a credit after a remainder was filled as % / %', v_amt_x, v_bal_x;
    end if;

    -- ── 5. Never refuses for funds: the balance goes negative ──
    select * into r from public.wallet_usage_debit(k_a, 'voice_minute', 2000000, 900000, 'phone_call', 'probe-call',
      'Outbound call to (555) 010-0002 · 12 min', '{"units": 12, "unit": "minute", "direction": "out"}'::jsonb, 'usage:call:probe-259-1');
    select a.balance_cents, a.usage_remainder_micros into v_bal, v_rem from public.wallet_accounts a where a.client_id = k_a;
    if r.amount_cents <> -200 or r.balance_after_cents <> -96 or v_bal <> -96 or v_rem <> 2450 then
      raise exception '259 probe: a debit past zero answered % (balance %, remainder %)', to_jsonb(r), v_bal, v_rem;
    end if;

    -- ── 6. Bad arguments raise and post nothing ──
    v_raised := false;
    begin
      perform public.wallet_usage_debit(k_a, 'sms_segment', -1, null, 'probe', null, null, null, 'usage:sms:probe-259-neg');
    exception when raise_exception then v_raised := true;
    end;
    if not v_raised then raise exception '259 probe: a negative charge was accepted'; end if;
    v_raised := false;
    begin
      perform public.wallet_usage_debit(k_a, 'sms_segment', 100, null, 'probe', null, null, null, '');
    exception when raise_exception then v_raised := true;
    end;
    if not v_raised then raise exception '259 probe: a debit with no idempotency key was accepted'; end if;
    v_raised := false;
    begin
      perform public.wallet_usage_debit(k_a, 'sms_segment', 500000001, null, 'probe', null, null, null, 'usage:sms:probe-259-big');
    exception when raise_exception then v_raised := true;
    end;
    if not v_raised then raise exception '259 probe: a charge over the $500 units guard was accepted'; end if;
    select count(*) into v_n from public.wallet_transactions t where t.client_id = k_a;
    if v_n <> 6 then raise exception '259 probe: a refused debit wrote a row (% rows)', v_n; end if;

    -- ── 7. A 3D hold, captured: the UPDATE half of the trigger follows the new balance ──
    v_bal := public.wallet_credit(k_e, 1000::bigint, 'grant', 'probe', null, '259 probe', 'probe-259-credit-e', null);
    insert into public.wallet_transactions (client_id, kind, amount_cents, balance_after_cents, meter_kind, state, ref_type)
    values (k_e, 'debit', -20, 1000, 'probe_259_meter', 'held', 'probe')
    returning id into v_hold;
    update public.wallet_accounts set held_cents = held_cents + 20 where client_id = k_e;
    select t.amount_exact_micros, t.balance_after_exact_micros into v_amt_x, v_bal_x
      from public.wallet_transactions t where t.id = v_hold;
    if v_amt_x <> -200000 or v_bal_x <> 10000000 then
      raise exception '259 probe: a held row was filled as % / %', v_amt_x, v_bal_x;
    end if;
    perform public.wallet_capture(v_hold, null::integer, null::jsonb, 'probe');
    select t.balance_after_cents, t.balance_after_exact_micros into v_bal, v_bal_x
      from public.wallet_transactions t where t.id = v_hold;
    if v_bal <> 980 or v_bal_x <> 9800000 then
      raise exception '259 probe: a captured hold kept a stale exact balance (% / %)', v_bal, v_bal_x;
    end if;

    -- ── 8. wallet_reconcile agrees, in cents AND micros, for both wallets ──
    select count(*) into v_n from public.wallet_reconcile w
     where w.client_id in (k_a, k_e)
       and w.stored_balance_cents = w.ledger_balance_cents
       and w.stored_held_cents = w.ledger_held_cents
       and w.stored_balance_exact_micros = w.ledger_balance_exact_micros;
    if v_n <> 2 then
      raise exception '259 probe: wallet_reconcile reports drift after usage debits (% of 2 agree)', v_n;
    end if;
    if (select w.ledger_balance_exact_micros from public.wallet_reconcile w where w.client_id = k_a) <> -962450 then
      raise exception '259 probe: the exact ledger balance is not -962450';
    end if;

    -- ── 9. The gate, as shipped: disarmed for everyone ──
    g := public.wallet_usage_gate(k_a, 'voice_minute');
    if g ->> 'reason' <> 'disarmed' or not (g ->> 'allow')::boolean
       or (g ->> 'available_cents')::bigint <> -97 or (g ->> 'floor_cents')::int <> 500
       or (g ->> 'auto_topup_enabled')::boolean then
      raise exception '259 probe: the shipped gate answered %', g;
    end if;
    if public.phone_usage_armed(k_a, 'voice_minute') then
      raise exception '259 probe: a meter is armed as shipped';
    end if;
    -- Arming needs a markup.
    begin
      update public.phone_billing_settings set armed_at = now() where id;
      raise exception '259 probe: armed_at was accepted without a markup';
    exception when check_violation then null;
    end;

    -- ── 10. Armed for the pilot only (every meter still inactive) ──
    update public.phone_billing_settings
       set markup = 2.0, armed_at = now(), pilot_client_ids = array[k_a, k_c, k_d, k_e]
     where id;
    if not public.phone_usage_armed(k_a, 'voice_minute') or public.phone_usage_armed(k_b, 'voice_minute') then
      raise exception '259 probe: the pilot list did not decide who is armed';
    end if;
    if public.phone_usage_armed(k_a, 'no_such_meter') then
      raise exception '259 probe: an unknown meter armed a pilot tenant';
    end if;
    g := public.wallet_usage_gate(k_b, 'voice_minute');
    if g ->> 'reason' <> 'disarmed' or not (g ->> 'allow')::boolean then
      raise exception '259 probe: a tenant outside the pilot was gated: %', g;
    end if;
    -- available = -96 balance - 0 held - 1 (2450 micros owed, rounded up).
    g := public.wallet_usage_gate(k_a, 'voice_minute');
    if g ->> 'reason' <> 'below_floor' or (g ->> 'allow')::boolean or (g ->> 'available_cents')::bigint <> -97 then
      raise exception '259 probe: a pilot tenant below the floor answered %', g;
    end if;
    update public.wallet_accounts
       set auto_topup_enabled = true, auto_topup_threshold_cents = 2000, auto_topup_amount_cents = 2000
     where client_id = k_a;
    g := public.wallet_usage_gate(k_a, 'sms_segment');
    if g ->> 'reason' <> 'below_floor' or not (g ->> 'auto_topup_enabled')::boolean then
      raise exception '259 probe: auto top-up did not reach the gate: %', g;
    end if;
    insert into public.wallet_accounts (client_id, metered_exempt) values (k_c, true);
    g := public.wallet_usage_gate(k_c, 'voice_minute');
    if g ->> 'reason' <> 'exempt' or not (g ->> 'allow')::boolean then
      raise exception '259 probe: a metered_exempt tenant answered %', g;
    end if;
    insert into public.client_settings (client_id, business_name, billing_exempt) values (k_d, 'Probe 259', true);
    g := public.wallet_usage_gate(k_d, 'voice_minute');
    if g ->> 'reason' <> 'exempt' or not (g ->> 'allow')::boolean then
      raise exception '259 probe: a billing_exempt tenant answered %', g;
    end if;
    g := public.wallet_usage_gate(k_e, 'voice_minute');
    if g ->> 'reason' <> 'above_floor' or not (g ->> 'allow')::boolean or (g ->> 'available_cents')::bigint <> 980 then
      raise exception '259 probe: a funded pilot tenant answered %', g;
    end if;

    -- ── 11. An active meter arms everyone; no wallet reads as zero ──
    update public.usage_prices set active = true where kind = 'voice_minute';
    g := public.wallet_usage_gate(k_b, 'voice_minute');
    if g ->> 'reason' <> 'below_floor' or (g ->> 'allow')::boolean or (g ->> 'available_cents')::bigint <> 0 then
      raise exception '259 probe: an active meter did not gate a tenant with no wallet: %', g;
    end if;
    if public.phone_usage_armed(k_b, 'sms_segment') then
      raise exception '259 probe: arming voice_minute armed sms_segment';
    end if;
    -- The panic button.
    update public.phone_billing_settings set armed_at = null where id;
    g := public.wallet_usage_gate(k_a, 'voice_minute');
    if g ->> 'reason' <> 'disarmed' or not (g ->> 'allow')::boolean then
      raise exception '259 probe: clearing armed_at did not disarm: %', g;
    end if;

    -- ── 12. The queue: what is enqueued, what is not, and the limit makes progress ──
    insert into public.phone_calls (client_id, direction, from_e164, to_e164, status, started_at, ended_at, duration_s)
    values (k_a, 'out', '+15550100001', '+15550100002', 'completed', now() - interval '2 minutes', now(), 95)
    returning id into v_call;
    insert into public.phone_calls (client_id, direction, from_e164, to_e164, status, started_at, ended_at, duration_s)
    values (k_a, 'out', '+15550100001', '+15550100002', 'completed', now() - interval '2 days', now() - interval '2 days', 60)
    returning id into v_call_old;
    insert into public.phone_calls (client_id, direction, from_e164, to_e164, status)
    values (k_a, 'in', '+15550100002', '+15550100001', 'ringing')
    returning id into v_call_rng;
    insert into public.sms_messages (client_id, direction, from_number, to_number, body, status, provider_sid)
    values (k_a, 'out', '+15550100001', '+15550100002', 'probe', 'sent', 'SM' || replace(gen_random_uuid()::text, '-', ''))
    returning id into v_sms_out;
    insert into public.sms_messages (client_id, direction, from_number, to_number, body, status, provider_sid)
    values (k_a, 'in', '+15550100002', '+15550100001', 'probe', 'received', 'SM' || replace(gen_random_uuid()::text, '-', ''))
    returning id into v_sms_in;
    insert into public.sms_messages (client_id, direction, from_number, to_number, body, status, provider_sid)
    values (k_a, 'out', '+15550100001', '+15550100002', 'probe', 'claimed', 'SM' || replace(gen_random_uuid()::text, '-', ''))
    returning id into v_sms_clm;
    insert into public.sms_messages (client_id, direction, from_number, to_number, body, status)
    values (k_a, 'out', '+15550100001', '+15550100002', 'probe', 'sent')
    returning id into v_sms_nos;
    v_ids := array[v_call, v_call_old, v_call_rng, v_sms_out, v_sms_in, v_sms_clm, v_sms_nos];

    -- p_since = now(), this transaction's start: the probe's rows qualify and every live row
    -- written before this file began does not. Anything written since sorts after them.
    -- Limit 1, twice: the second must take the NEXT row, not trip over the first (CHOICE 5).
    v_n := public.usage_charges_enqueue(now(), 1);
    if v_n <> 1 or (select count(*) from public.usage_charges u where u.source_id = any (v_ids)) <> 1 then
      raise exception '259 probe: enqueue with limit 1 queued % (probe rows %)', v_n,
        (select count(*) from public.usage_charges u where u.source_id = any (v_ids));
    end if;
    v_n := public.usage_charges_enqueue(now(), 1);
    if v_n <> 1 or (select count(*) from public.usage_charges u where u.source_id = any (v_ids)) <> 2 then
      raise exception '259 probe: a second enqueue with limit 1 queued % (probe rows %); the limit must skip rows already queued', v_n,
        (select count(*) from public.usage_charges u where u.source_id = any (v_ids));
    end if;
    perform public.usage_charges_enqueue(now(), 500);
    perform public.usage_charges_enqueue(now(), 500);
    if (select count(*) from public.usage_charges u where u.source_id = any (v_ids)) <> 3
       or not exists (select 1 from public.usage_charges u where u.source = 'call' and u.source_id = v_call)
       or not exists (select 1 from public.usage_charges u where u.source = 'sms' and u.source_id = v_sms_out)
       or not exists (select 1 from public.usage_charges u where u.source = 'sms' and u.source_id = v_sms_in) then
      raise exception '259 probe: the queue holds the wrong probe rows: %',
        (select jsonb_agg(jsonb_build_object('source', u.source, 'id', u.source_id)) from public.usage_charges u where u.source_id = any (v_ids));
    end if;
    if not exists (select 1 from public.usage_charges u, public.phone_calls c
                    where u.source_id = v_call and c.id = v_call
                      and u.client_id = k_a and u.direction = 'out' and u.occurred_at = c.started_at
                      and u.state = 'pending' and u.attempts = 0 and u.lease_until is null) then
      raise exception '259 probe: the queued call row is not what enqueue should write';
    end if;
    if exists (select 1 from public.usage_charges u where u.source_id = v_sms_in and u.direction <> 'in') then
      raise exception '259 probe: an inbound text was queued as outbound';
    end if;

    -- ── 13. The claim leases, does not hand a leased row out twice, and takes it back ──
    select count(*) into v_n from public.usage_charges_claim(500, 240) c
     where c.source_id = any (v_ids) and c.attempts = 1 and c.lease_until > now();
    if v_n <> 3 then
      raise exception '259 probe: the first claim leased % of the 3 probe rows', v_n;
    end if;
    select count(*) into v_n from public.usage_charges_claim(500, 240) c where c.source_id = any (v_ids);
    if v_n <> 0 then
      raise exception '259 probe: a leased row was claimed again (% rows)', v_n;
    end if;
    update public.usage_charges set lease_until = now() - interval '1 second' where source_id = v_call;
    update public.usage_charges set lease_until = null, state = 'shadow' where source_id = v_sms_in;
    update public.usage_charges set lease_until = null, next_try_at = now() + interval '10 minutes' where source_id = v_sms_out;
    select count(*) into v_n from public.usage_charges_claim(500, 240) c
     where c.source_id = any (v_ids) and (c.source_id <> v_call or c.attempts <> 2);
    if v_n <> 0 or (select u.attempts from public.usage_charges u where u.source_id = v_call) <> 2 then
      raise exception '259 probe: an expired lease was not reclaimed, or a settled or future row was';
    end if;

    -- ── 14. A charged row must name its ledger row ──
    begin
      update public.usage_charges set state = 'charged' where source_id = v_sms_out;
      raise exception '259 probe: a charged row with no wallet_tx_id was accepted';
    exception when check_violation then null;
    end;
    update public.usage_charges set state = 'charged', wallet_tx_id = v_tx1 where source_id = v_sms_out;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '259 probe: three 4150-micro debits post 0, 0, -1 with 2450 owed; replays are no-ops; the balance may go negative; the trigger fills credits, holds and captures; reconcile agrees in micros; the gate answers disarmed, exempt, pilot and below/above floor; the queue enqueues, limits, leases and re-leases; nothing was kept';
      else
        raise;
      end if;
  end;
end
$probe$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — verification (read-only)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Disarmed, everywhere:
--      select markup, armed_at, pilot_client_ids from public.phone_billing_settings;        -- null, null, {}
--      select kind, pricing, active from public.usage_prices
--       where kind in ('voice_minute','voice_minute_in','sms_segment','sms_in');           -- cost_plus, false x4
-- B. The ledger still reconciles, now in micros too (no rows):
--      select * from public.wallet_reconcile
--       where stored_balance_cents <> ledger_balance_cents
--          or stored_balance_exact_micros <> ledger_balance_exact_micros;
-- C. Once the Worker runs, shadow rows fill in with real costs:
--      select state, count(*), sum(cost_micros) / 1e6 as cost_usd from public.usage_charges group by 1;
--
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ⚠️ ARMING — deliberately NOT part of this file (128's and 169's rail)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Watch shadow rows for real calls and texts first, and compare a day of usage_charges costs
-- with twilio_usage_daily. Then, IN THIS ORDER:
--   1. Set PHONE_USAGE_METERS = "on" for the phone-api Worker (wrangler.jsonc vars, then
--      deploy) AND as an edge-function secret (the text send path reads it through Deno.env).
--      With armed_at still NULL this charges and refuses nothing: the database is the master
--      switch (the monthly line fee also needs phone_line_monthly active and priced, which
--      ships off). Confirm both are live before step 2.
--   2. Then, for one pilot tenant:
--        update public.phone_billing_settings
--           set markup = <chosen>, armed_at = now(), pilot_client_ids = array['<tenant id>'], updated_at = now()
--         where id;
-- NOT the other way round. armed_at first, with the Worker still on "off", settles every call
-- and text from armed_at until the deploy as 'shadow', which is final: that gap is never
-- charged. Likewise texts, if the edge secret is set after armed_at. To disarm, clear armed_at
-- (the panic button); leave the env rails on. For everyone, later, per meter:
--   update public.usage_prices set active = true where kind in ('voice_minute', 'voice_minute_in', 'sms_segment', 'sms_in');
-- Before that, the Billing card must understand pricing = 'cost_plus' (KNOWN, NOT CLOSED HERE).
--
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- FULL ROLLBACK — in this order. Deploy a Worker and edge functions that no longer call the
-- five RPCs FIRST, or every 5-minute run and every text send logs a fault.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Money already moved stays moved: posted usage debits are ordinary ledger rows in cents and
-- remain after the micros columns are gone. Dropping usage_remainder_micros forgives what each
-- wallet owed below a cent (under 1¢ per wallet). Export usage_charges and twilio_usage_daily
-- first if their cost history matters.
--   begin;
--   drop function if exists public.wallet_usage_gate(text, text);
--   drop function if exists public.phone_usage_armed(text, text);
--   drop function if exists public.usage_charges_claim(integer, integer);
--   drop function if exists public.usage_charges_enqueue(timestamptz, integer);
--   drop function if exists public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text);
--   drop index if exists public.phone_calls_ended_idx;
--   drop index if exists public.sms_messages_created_idx;
--   drop table if exists public.twilio_usage_daily;
--   drop table if exists public.usage_charges;
--   drop table if exists public.phone_billing_settings;
--   delete from public.usage_prices u
--    where u.kind in ('voice_minute_in', 'sms_in')
--      and not exists (select 1 from public.wallet_transactions w where w.meter_kind = u.kind);
--   alter table public.usage_prices drop column if exists pricing;
--   -- 128's view, verbatim (a view cannot drop columns in place):
--   drop view if exists public.wallet_reconcile;
--   create view public.wallet_reconcile as
--     select a.client_id,
--            a.balance_cents                                            as stored_balance_cents,
--            coalesce(sum(t.amount_cents) filter (where t.state = 'posted'), 0) as ledger_balance_cents,
--            a.held_cents                                               as stored_held_cents,
--            coalesce(-sum(t.amount_cents) filter (where t.state = 'held'), 0)  as ledger_held_cents
--       from public.wallet_accounts a
--       left join public.wallet_transactions t on t.client_id = a.client_id
--      group by a.client_id, a.balance_cents, a.held_cents;
--   revoke all on public.wallet_reconcile from public, anon, authenticated;
--   grant select on public.wallet_reconcile to service_role;
--   drop trigger if exists wallet_transactions_fill_exact on public.wallet_transactions;
--   drop function if exists public.wallet_tx_fill_exact();
--   alter table public.wallet_transactions drop column if exists amount_exact_micros,
--                                          drop column if exists balance_after_exact_micros,
--                                          drop column if exists cost_micros;
--   alter table public.wallet_accounts drop column if exists usage_remainder_micros;
--   delete from supabase_migrations.schema_migrations where version = '259';
--   notify pgrst, 'reload schema';
--   commit;
-- The notes 259 wrote on voice_minute and sms_segment stay; they are operator-only text.
