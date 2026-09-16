-- 243_avalara_tax_lookups.sql — a per-tenant Avalara switch, a ledger of every call, and a
-- wallet_credit that records which meter it charged.
--
-- APPLY BY HAND through the SQL editor, as the owner, then record version 243 in
-- supabase_migrations.schema_migrations. NEVER `supabase db push`. Not as a whole file inline
-- from the CLI: "<newline>$(cat …)" was refused as an EMPTY query when 242 was applied (see
-- 242_lead_sms_consent_box.sql), and inside a double-quoted bash string `$fn$` / `$probe$`
-- expand to nothing. Exit codes prove nothing either way — read it back:
--   select pg_get_function_identity_arguments('public.wallet_credit'::regproc);   -- ends in p_meter_kind text
--   select to_regclass('public.tax_lookups');                                     -- not null
--   select pg_get_function_identity_arguments('public.claim_tax_lookup'::regproc); -- ten arguments
-- The probe at the bottom runs inside the transaction and aborts the whole file if any property
-- below does not hold, so a failed apply leaves the database exactly as it was.
--
-- ── WHY ───────────────────────────────────────────────────────────────────────────────────
-- Real Avalara production credentials exist, there is no sandbox, and every rate lookup is
-- metered against the account. Four things were missing before any path may make one:
--
-- 1. A SWITCH PER TENANT. client_settings.tax_lookup_enabled, default FALSE. Off means no path
--    may call Avalara for that tenant — not the verify button, not the invoice-time check.
--    Operator-set only; builders see it read-only. Every tenant reads false on apply, so this
--    file changes no behaviour by itself.
--
-- 2. A LEDGER OF CALLS, public.tax_lookups. The wallet cannot count calls: a charge is skipped
--    while a meter is disarmed, priced at 0 or the tenant is exempt, and an answer-keyed charge
--    collapses a repeat press that returned the same rate — every one of those still made a
--    request the account paid for. One row per deliberate lookup, written BEFORE the request
--    (outcome null while in flight) and closed after it. It is also the SPEND CAP: the tenant's
--    last 24 hours of verify + invoice rows here are counted, and a lookup at the cap is refused
--    before any request — atomically, by claim_tax_lookup (4). `attempts` records how many HTTP
--    requests the lookup took (a retried 5xx reads 2).
--      client_id  NOT NULL, text like client_settings.client_id, no FK — the ledger row must
--                 never be the thing that blocks (ai_style_calls, 086, has none either). The
--                 operator ping has no builder tenant, so it records the fixed value
--                 '_platform' (_shared/taxLookups.ts PING_CLIENT_ID — no tenant slug can start
--                 with an underscore); the cap counts verify + invoice only, so a ping spends
--                 no allowance.
--      kind       NOT NULL (stricter than a bare CHECK: a row with no kind is uncountable).
--      Free text is length-checked; _shared/taxLookups.ts clips to the same lengths, so a long
--      value is shortened rather than refused.
--    SERVICE-ROLE ONLY: RLS on, zero policies, grants revoked from anon, authenticated AND
--    public — 204_rate_buckets verbatim. The PUBLIC revoke is the one that matters.
--
-- 3. wallet_credit RECORDS meter_kind. Its INSERT omitted the column, so every direct-post
--    debit (both tax meters use direct-post, 179) landed with meter_kind NULL: the Billing tab
--    could only call it "Usage", and no query could answer "what did tax cost this tenant".
--    New trailing parameter p_meter_kind text DEFAULT NULL.
--      DROP + CREATE in one transaction, not CREATE OR REPLACE: adding a parameter makes a NEW
--      overload, and two overloads that both accept eight named arguments make every PostgREST
--      call ambiguous (PGRST203) — the top-up and operator-credit paths would start failing.
--      Callers that omit p_meter_kind (admin-catalog wallet_credit/wallet_adjust,
--      _shared/walletTopup.ts) resolve to the new function through the default, unchanged.
--      Body = the LIVE definition, read 2026-09-17 with pg_get_functiondef (identical to 128),
--      plus the one column. Execute posture re-issued exactly as live reads it: revoked from
--      public, anon, authenticated; service_role only.
--
-- 4. claim_tax_lookup — THE CAP AND THE ROW IN ONE STEP. Counting from the edge function and
--    then inserting is check-then-write: a burst of parallel presses at 99 all read 99, all
--    pass, and every one of them is a billed request. So the count and the insert happen in
--    one function under pg_advisory_xact_lock(hashtext('tax_lookups:' || client_id)): a second
--    claim for the same tenant waits for the first to commit, and its count (a fresh snapshot
--    per statement, READ COMMITTED) includes the row the first one wrote. Two limits:
--      p_daily_cap   verify + invoice rows in the rolling 24 hours (DAILY_TAX_LOOKUP_CAP);
--      p_minute_cap  for kind 'verify' only: verify rows in the last 60 seconds — the Verify
--                    button's burst limit, which used to be a separate fail-open counter in
--                    rate_buckets. Null skips it; the invoice check never passes one.
--    Returns jsonb: {"id": "<uuid>"} when the row was written, {"refused": "daily_cap"} or
--    {"refused": "rate_limited"} when it was not (nothing written). A bad argument RAISES, which
--    the caller reads as an unwritable ledger and refuses — the cap fails closed. Rows in flight
--    count, so the cap can no longer be overshot by parallel claims. The ping is not claimed:
--    it is operator-only, counts toward no cap, and still inserts its own row.
--    SECURITY DEFINER with search_path '' (every name below is schema-qualified); execute
--    revoked from public, anon, authenticated — this project's default privileges make a NEW
--    function callable by anon, so the public revoke is again the one that matters.
--
-- ── ORDER OF APPLY ────────────────────────────────────────────────────────────────────────
-- THIS FILE FIRST, then the edge functions carrying the taxMeter.ts that passes p_meter_kind
-- (portal-settings, submit-estimate). Deployed before this, a charge against the old function
-- finds no match and posts nothing — inert while both tax meters are disarmed (the arming rail
-- returns before the RPC), but it must be in this order before anything is armed. A
-- portal-settings deployed before this finds no claim_tax_lookup, and every paid lookup is
-- refused as an unwritable ledger (fail closed, nothing spent). Nothing reads tax_lookups or
-- tax_lookup_enabled until those deploys, so this file alone is a no-op.
--
-- The meters stay DISARMED. Nothing here touches usage_prices.

begin;

-- 1. The switch.
alter table public.client_settings
  add column if not exists tax_lookup_enabled boolean not null default false;

comment on column public.client_settings.tax_lookup_enabled is
  'Migration 243. true = this tenant may make Avalara rate lookups (the verify button, the invoice-time check). false (default) = no path calls Avalara for it. Operator-set only; builders see it read-only.';

-- 2. The ledger.
create table if not exists public.tax_lookups (
  id             uuid        primary key default gen_random_uuid(),
  client_id      text        not null check (char_length(client_id) between 1 and 100),
  kind           text        not null check (kind in ('verify', 'invoice', 'ping')),
  called_at      timestamptz not null default now(),
  short_code     text        check (short_code is null or char_length(short_code) <= 64),
  invoice_number text        check (invoice_number is null or char_length(invoice_number) <= 64),
  actor_user_id  uuid,
  operator       boolean     not null default false,
  region         text        check (region is null or char_length(region) <= 16),
  postal_code    text        check (postal_code is null or char_length(postal_code) <= 16),
  -- NULL while the request is in flight. A row left NULL (the function died mid-call) still
  -- counts toward the cap, which is the safe direction.
  outcome        text        check (outcome is null or outcome in (
                               'ok', 'credentials_rejected', 'bad_address', 'rate_limited',
                               'timeout', 'network', 'malformed', 'not_configured', 'subscription')),
  http_status    int         check (http_status is null or http_status between 100 and 599),
  attempts       int         check (attempts is null or attempts between 0 and 10),
  -- The same fraction and ceiling as client_settings.ss_tax_rate (158).
  rate           numeric(7,5) check (rate is null or (rate >= 0 and rate <= 0.25)),
  jurisdiction   text        check (jurisdiction is null or char_length(jurisdiction) <= 200),
  finished_at    timestamptz,
  -- A row is closed in one write: an outcome and its time together, or neither.
  constraint tax_lookups_finished_check check ((outcome is null) = (finished_at is null))
);

create index if not exists tax_lookups_client_called
  on public.tax_lookups (client_id, called_at desc);

alter table public.tax_lookups enable row level security;

-- No policies → service_role only. The PUBLIC grant is the one that bites: this project's
-- default privileges make every NEW table world-readable, and that grant survives a revoke
-- aimed only at anon/authenticated. Revoke it explicitly.
revoke all on public.tax_lookups from public;
revoke all on public.tax_lookups from anon, authenticated;

comment on table public.tax_lookups is
  'Migration 243. One row per deliberate Avalara request (verify button, invoice-time check, operator ping), written before the request and closed after it. OUR count of calls, not Avalara''s. The 24h verify+invoice count per tenant is the spend cap (_shared/taxLookups.ts DAILY_TAX_LOOKUP_CAP). Service-role only.';
comment on column public.tax_lookups.attempts is
  'HTTP requests the lookup took, retries included (a retried 5xx or 429 reads 2). One row per lookup; attempts is what Avalara may have counted.';

-- 3. wallet_credit learns the meter kind.
drop function if exists public.wallet_credit(text, bigint, text, text, text, text, text, uuid);

create function public.wallet_credit(
  p_client_id text, p_amount_cents bigint, p_kind text,
  p_ref_type text, p_ref_id text, p_memo text, p_idem text, p_actor uuid,
  p_meter_kind text default null
) returns bigint
language plpgsql security definer set search_path to 'public'
as $fn$
declare v_bal bigint; v_existing bigint;
begin
  if p_idem is not null and p_idem <> '' then
    select balance_after_cents into v_existing
      from public.wallet_transactions
     where client_id = p_client_id and idempotency_key = p_idem;
    if v_existing is not null then return v_existing; end if;   -- replay: no-op
  end if;

  insert into public.wallet_accounts (client_id) values (p_client_id)
    on conflict (client_id) do nothing;
  update public.wallet_accounts
     set balance_cents = balance_cents + p_amount_cents, updated_at = now()
   where client_id = p_client_id
  returning balance_cents into v_bal;

  -- 243: meter_kind is recorded. usage_prices.kind for a metered debit; NULL for a top-up,
  -- grant or adjustment, and for every caller that does not pass it.
  insert into public.wallet_transactions
    (client_id, kind, amount_cents, balance_after_cents, meter_kind, state, idempotency_key,
     ref_type, ref_id, memo, actor_user_id, posted_at)
  values (p_client_id, p_kind, p_amount_cents, v_bal, nullif(p_meter_kind, ''), 'posted', nullif(p_idem, ''),
          p_ref_type, p_ref_id, p_memo, p_actor, now());
  return v_bal;
end $fn$;

revoke execute on function public.wallet_credit(text, bigint, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.wallet_credit(text, bigint, text, text, text, text, text, uuid, text) to service_role;

-- 4. The atomic claim: the cap check and the ledger row in one locked step (see WHY 4).
drop function if exists public.claim_tax_lookup(text, text, integer, integer, text, text, uuid, boolean, text, text);

create function public.claim_tax_lookup(
  p_client_id      text,
  p_kind           text,
  p_daily_cap      integer,
  p_minute_cap     integer default null,
  p_short_code     text    default null,
  p_invoice_number text    default null,
  p_actor_user_id  uuid    default null,
  p_operator       boolean default false,
  p_region         text    default null,
  p_postal_code    text    default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_day    integer;
  v_minute integer;
  v_id     uuid;
begin
  if p_client_id is null or p_client_id = '' then
    raise exception 'claim_tax_lookup: p_client_id is required';
  end if;
  if p_kind is null or p_kind not in ('verify', 'invoice') then
    raise exception 'claim_tax_lookup: p_kind must be verify or invoice (a ping is not claimed)';
  end if;
  if p_daily_cap is null or p_daily_cap < 0 or (p_minute_cap is not null and p_minute_cap < 0) then
    raise exception 'claim_tax_lookup: the caps must be non-negative, and the daily cap is required';
  end if;

  -- Serialises claims per tenant until this transaction commits. Another tenant hashing to the
  -- same key only waits a moment; it never shares a count.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('tax_lookups:' || p_client_id));

  select count(*) into v_day
    from public.tax_lookups
   where client_id = p_client_id
     and kind in ('verify', 'invoice')
     and called_at > pg_catalog.now() - interval '24 hours';
  if v_day >= p_daily_cap then
    return pg_catalog.jsonb_build_object('refused', 'daily_cap');
  end if;

  if p_kind = 'verify' and p_minute_cap is not null then
    select count(*) into v_minute
      from public.tax_lookups
     where client_id = p_client_id
       and kind = 'verify'
       and called_at > pg_catalog.now() - interval '60 seconds';
    if v_minute >= p_minute_cap then
      return pg_catalog.jsonb_build_object('refused', 'rate_limited');
    end if;
  end if;

  insert into public.tax_lookups
    (client_id, kind, short_code, invoice_number, actor_user_id, operator, region, postal_code)
  values
    (p_client_id, p_kind, p_short_code, p_invoice_number, p_actor_user_id, coalesce(p_operator, false),
     p_region, p_postal_code)
  returning id into v_id;

  return pg_catalog.jsonb_build_object('id', v_id);
end $fn$;

revoke execute on function public.claim_tax_lookup(text, text, integer, integer, text, text, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.claim_tax_lookup(text, text, integer, integer, text, text, uuid, boolean, text, text) to service_role;

comment on function public.claim_tax_lookup(text, text, integer, integer, text, text, uuid, boolean, text, text) is
  'Migration 243. The paid-lookup spend cap, atomic: under a per-tenant advisory lock, counts verify+invoice rows in 24h against p_daily_cap and (kind verify) verify rows in 60s against p_minute_cap, and writes the in-flight tax_lookups row only when under both. Returns {"id"} or {"refused":"daily_cap"|"rate_limited"}. Service-role only (_shared/taxLookups.ts claimLookup).';

-- 5. The probe. Everything it writes is undone by the ROLLBACK_PROBE exception; any other
--    exception aborts the whole file.
do $probe$
declare
  n int;
  v_kind text;
  v_bal bigint;
  v_claim jsonb;
  v_raised boolean;
  sig constant text := 'public.wallet_credit(text,bigint,text,text,text,text,text,uuid,text)';
  claim_sig constant text := 'public.claim_tax_lookup(text,text,integer,integer,text,text,uuid,boolean,text,text)';
begin
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'wallet_credit';
  if n <> 1 then
    raise exception '243 probe: % wallet_credit overloads — exactly one, or PostgREST calls are ambiguous', n;
  end if;
  if has_function_privilege('anon', sig, 'execute') or has_function_privilege('authenticated', sig, 'execute') then
    raise exception '243 probe: a browser role can execute wallet_credit';
  end if;
  if not has_function_privilege('service_role', sig, 'execute') then
    raise exception '243 probe: service_role cannot execute wallet_credit';
  end if;
  if has_table_privilege('anon', 'public.tax_lookups', 'select')
     or has_table_privilege('authenticated', 'public.tax_lookups', 'select')
     or has_table_privilege('authenticated', 'public.tax_lookups', 'insert') then
    raise exception '243 probe: tax_lookups is reachable by a browser role';
  end if;
  -- The edge functions write it as service_role, which keeps its grant through this project's
  -- default privileges (rate_buckets reads the same way live). If that ever stops being true,
  -- fail here rather than refuse every lookup after the deploy.
  if not (has_table_privilege('service_role', 'public.tax_lookups', 'select')
          and has_table_privilege('service_role', 'public.tax_lookups', 'insert')
          and has_table_privilege('service_role', 'public.tax_lookups', 'update')) then
    raise exception '243 probe: service_role cannot read and write tax_lookups';
  end if;
  if has_function_privilege('anon', claim_sig, 'execute') or has_function_privilege('authenticated', claim_sig, 'execute') then
    raise exception '243 probe: a browser role can execute claim_tax_lookup';
  end if;
  if not has_function_privilege('service_role', claim_sig, 'execute') then
    raise exception '243 probe: service_role cannot execute claim_tax_lookup';
  end if;
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'claim_tax_lookup'
     and p.prosecdef and array_to_string(p.proconfig, ',') like 'search_path=%';
  if n <> 1 then
    raise exception '243 probe: claim_tax_lookup is not one SECURITY DEFINER function with a pinned search_path (% found)', n;
  end if;

  begin
    -- An eight-argument call — every caller deployed today — still posts, with no meter kind.
    v_bal := public.wallet_credit('probe-243-tenant', 0::bigint, 'adjustment', 'probe', null, '243 probe', 'probe-243-old', null);
    select meter_kind into v_kind from public.wallet_transactions
     where client_id = 'probe-243-tenant' and idempotency_key = 'probe-243-old';
    if not found or v_kind is not null then
      raise exception '243 probe: an eight-argument wallet_credit did not post, or posted a meter kind';
    end if;

    -- The new argument lands in meter_kind, and a replay of the key is still a no-op.
    v_bal := public.wallet_credit('probe-243-tenant', -10::bigint, 'debit', 'probe', null, '243 probe', 'probe-243-new', null, 'tax_lookup');
    v_bal := public.wallet_credit('probe-243-tenant', -10::bigint, 'debit', 'probe', null, '243 probe', 'probe-243-new', null, 'tax_lookup');
    select meter_kind into v_kind from public.wallet_transactions
     where client_id = 'probe-243-tenant' and idempotency_key = 'probe-243-new';
    if v_kind is distinct from 'tax_lookup' then
      raise exception '243 probe: p_meter_kind was not recorded (got %)', v_kind;
    end if;
    select count(*) into n from public.wallet_transactions where client_id = 'probe-243-tenant';
    if n <> 2 or v_bal <> -10 then
      raise exception '243 probe: a replayed key posted twice (% rows, balance %)', n, v_bal;
    end if;

    -- The ledger: an in-flight row is accepted; an outcome with no finish time, or an unknown
    -- outcome, is refused.
    insert into public.tax_lookups (client_id, kind) values ('probe-243-tenant', 'verify');
    begin
      insert into public.tax_lookups (client_id, kind, outcome) values ('probe-243-tenant', 'verify', 'ok');
      raise exception '243 probe: an outcome without finished_at was accepted';
    exception when check_violation then null;
    end;
    begin
      insert into public.tax_lookups (client_id, kind, outcome, finished_at)
      values ('probe-243-tenant', 'verify', 'approximately fine', now());
      raise exception '243 probe: an unknown outcome was accepted';
    exception when check_violation then null;
    end;

    -- The claim. Under the cap it writes the row and returns its id; at the cap it writes
    -- nothing and says why. A ping row spends no allowance. (A parallel burst cannot be staged
    -- inside one transaction; the advisory lock is what serialises it.)
    v_claim := public.claim_tax_lookup('probe-243-claims', 'verify', 2, 5, 'SS-PROBE243QA', null, null, true, 'MO', '63090');
    if v_claim->>'id' is null then
      raise exception '243 probe: a claim under the cap was not written (got %)', v_claim;
    end if;
    select count(*) into n from public.tax_lookups
     where id = (v_claim->>'id')::uuid and client_id = 'probe-243-claims' and kind = 'verify'
       and short_code = 'SS-PROBE243QA' and operator and region = 'MO' and postal_code = '63090' and outcome is null;
    if n <> 1 then
      raise exception '243 probe: the claimed row does not carry what was claimed';
    end if;
    v_claim := public.claim_tax_lookup('probe-243-claims', 'invoice', 2);
    if v_claim->>'id' is null then
      raise exception '243 probe: a second claim under the cap was not written (got %)', v_claim;
    end if;
    v_claim := public.claim_tax_lookup('probe-243-claims', 'verify', 2, 5);
    if v_claim is distinct from '{"refused": "daily_cap"}'::jsonb then
      raise exception '243 probe: a claim at the daily cap was not refused as daily_cap (got %)', v_claim;
    end if;
    select count(*) into n from public.tax_lookups where client_id = 'probe-243-claims';
    if n <> 2 then
      raise exception '243 probe: a refused claim wrote a row (% rows)', n;
    end if;
    insert into public.tax_lookups (client_id, kind) values ('probe-243-claims', 'ping');
    v_claim := public.claim_tax_lookup('probe-243-claims', 'invoice', 3);
    if v_claim->>'id' is null then
      raise exception '243 probe: a ping row was counted against the daily cap (got %)', v_claim;
    end if;

    -- The per-minute limit is the Verify button's, and only the Verify button's.
    v_claim := public.claim_tax_lookup('probe-243-burst', 'verify', 100, 1);
    if v_claim->>'id' is null then
      raise exception '243 probe: a first verify claim was not written (got %)', v_claim;
    end if;
    v_claim := public.claim_tax_lookup('probe-243-burst', 'verify', 100, 1);
    if v_claim is distinct from '{"refused": "rate_limited"}'::jsonb then
      raise exception '243 probe: a verify claim over the per-minute cap was not refused as rate_limited (got %)', v_claim;
    end if;
    v_claim := public.claim_tax_lookup('probe-243-burst', 'invoice', 100, 1);
    if v_claim->>'id' is null then
      raise exception '243 probe: the per-minute cap refused an invoice claim (got %)', v_claim;
    end if;

    -- A malformed claim raises (the caller refuses), never writes.
    v_raised := false;
    begin
      v_claim := public.claim_tax_lookup('probe-243-claims', 'ping', 100);
    exception when raise_exception then v_raised := true;
    end;
    if not v_raised then
      raise exception '243 probe: a ping claim was accepted';
    end if;
    v_raised := false;
    begin
      v_claim := public.claim_tax_lookup('probe-243-claims', 'verify', null);
    exception when raise_exception then v_raised := true;
    end;
    if not v_raised then
      raise exception '243 probe: a claim with no daily cap was accepted';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '243: one wallet_credit, service-role only; eight-argument calls still post; p_meter_kind is recorded; replays are no-ops; tax_lookups is service-role only and refuses a half-closed row; claim_tax_lookup is service-role only, writes under the caps and refuses at them';
      else
        raise;
      end if;
  end;
end
$probe$;

notify pgrst, 'reload schema';

commit;

-- ROLLBACK:
-- Revert the edge functions that pass p_meter_kind or read tax_lookups / tax_lookup_enabled
-- FIRST (portal-settings, submit-estimate, admin-catalog, portal-billing), or their charges
-- fail and their ledger writes and claims refuse lookups. Dropping tax_lookups discards the call history:
-- export it first if it holds rows. wallet_transactions rows already carrying a meter_kind
-- stay as they are — money moved, and the column predates this file.
--
--   begin;
--   drop function if exists public.wallet_credit(text, bigint, text, text, text, text, text, uuid, text);
--   create function public.wallet_credit(
--     p_client_id text, p_amount_cents bigint, p_kind text,
--     p_ref_type text, p_ref_id text, p_memo text, p_idem text, p_actor uuid
--   ) returns bigint
--   language plpgsql security definer set search_path to 'public'
--   as $fn$
--   declare v_bal bigint; v_existing bigint;
--   begin
--     if p_idem is not null and p_idem <> '' then
--       select balance_after_cents into v_existing
--         from public.wallet_transactions
--        where client_id = p_client_id and idempotency_key = p_idem;
--       if v_existing is not null then return v_existing; end if;   -- replay: no-op
--     end if;
--
--     insert into public.wallet_accounts (client_id) values (p_client_id)
--       on conflict (client_id) do nothing;
--     update public.wallet_accounts
--        set balance_cents = balance_cents + p_amount_cents, updated_at = now()
--      where client_id = p_client_id
--     returning balance_cents into v_bal;
--
--     insert into public.wallet_transactions
--       (client_id, kind, amount_cents, balance_after_cents, state, idempotency_key,
--        ref_type, ref_id, memo, actor_user_id, posted_at)
--     values (p_client_id, p_kind, p_amount_cents, v_bal, 'posted', nullif(p_idem, ''),
--             p_ref_type, p_ref_id, p_memo, p_actor, now());
--     return v_bal;
--   end $fn$;
--   revoke execute on function public.wallet_credit(text, bigint, text, text, text, text, text, uuid) from public, anon, authenticated;
--   grant execute on function public.wallet_credit(text, bigint, text, text, text, text, text, uuid) to service_role;
--   drop function if exists public.claim_tax_lookup(text, text, integer, integer, text, text, uuid, boolean, text, text);
--   drop table if exists public.tax_lookups;
--   alter table public.client_settings drop column if exists tax_lookup_enabled;
--   notify pgrst, 'reload schema';
--   commit;
