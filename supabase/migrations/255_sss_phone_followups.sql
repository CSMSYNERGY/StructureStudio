-- 255_sss_phone_followups.sql — SSS Phone follow-ups to 254: where a number's caller-ID trust
--                               registration stands (SHAKEN/STIR and Voice Integrity), and the
--                               claim that keeps two registrations of one number from racing.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--    254 is APPLIED and is never edited; everything here is additive on top of it.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Plan section 14, "Caller ID reputation", phase 6. Twilio signs a builder's outbound calls at
-- SHAKEN/STIR level A only when the number sits on BOTH an approved business profile and an
-- approved SHAKEN/STIR Trust Product; the texting setup (portal-sms, 165) creates the builder's
-- Secondary Customer Profile but never put a number on it. Level A alone does not fight "Spam
-- Likely", so each number is also registered with Twilio Voice Integrity (its own Trust
-- Product). portal-settings' OPERATOR-ONLY actions phone_trust_setup / phone_trust_status build
-- and read those two products (_shared/twilioTrustHub.ts setupVoiceTrust / fetchTrustProduct),
-- and this migration is where they record the outcome, per number:
--
--   shaken_trust_product_sid           BU… of the number's SHAKEN/STIR Trust Product
--   shaken_status                      its Twilio review status, as last read
--   voice_integrity_trust_product_sid  BU… of the number's Voice Integrity Trust Product
--   voice_integrity_status             its Twilio review status, as last read
--   caller_id_checked_at               when either status was last read from Twilio
--   caller_id_lock_until               phone_trust_setup's single-flight claim (see below)
--
-- Statuses are Twilio's TrustProduct enum verbatim (draft | pending-review | in-review |
-- twilio-rejected | twilio-approved), NULL = never registered. A value outside it is refused
-- here, so a new Twilio state can never be stored as if it were one we understand (the code
-- maps anything unknown to NULL rather than guessing).
--
-- The SIDs live on sms_numbers, not on sms_registrations, because each Trust Product holds
-- NUMBERS (ChannelEndpointAssignments) and the number is the thing a Phone tab shows; one
-- number per builder (plan D6) makes that one row. A Trust Product id is not a secret, but like
-- every column on this table it is service-role only (165 revoked anon and authenticated, and
-- PART 2 below asserts that is still true).
--
-- ── ONE SETUP AT A TIME PER NUMBER (review BE-2) ─────────────────────────────────────────
-- phone_trust_setup looks for an existing Trust Product and creates one when there is none. Two
-- presses at once (two operators, two tabs) would both miss and both create, and each would
-- write its own SID over the other's. So the setup first CLAIMS the number in one conditional
-- statement, exactly as portal-sms's `advance` claims sms_registrations.advance_lock_until:
--   update sms_numbers set caller_id_lock_until = now() + 5 min
--    where id = … and client_id = … and (caller_id_lock_until is null or caller_id_lock_until < now())
--   returning id;                       -- no row back = someone else holds it → 409
-- and clears it when the run ends (only if it is still its own). NULL = nobody is working on it.
-- An expired value is the same as NULL, so a run that died only parks the number five minutes.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Six NULLable columns with no default rewrite no
-- rows and change no existing reader: sendTenantSms, sms-inbound, the phone-api Worker's RPCs
-- (254 phone_route_for_number / phone_caller_context read sms_numbers%rowtype and pick named
-- fields) and portal-settings' number reads name their columns. portal-settings reads the
-- first five in a SEPARATE, error-tolerant select, so a portal-settings deploy that lands before
-- this migration shows "Caller ID registration isn't available yet" instead of failing the
-- Phone tab.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Only after portal-settings is redeployed without phone_trust_setup / phone_trust_status (the
-- Trust Products themselves stay at Twilio; delete them in the Console if they must go):
--   begin;
--   alter table public.sms_numbers
--     drop constraint if exists sms_numbers_shaken_status_chk,
--     drop constraint if exists sms_numbers_voice_integrity_status_chk,
--     drop constraint if exists sms_numbers_trust_product_sids_chk,
--     drop column if exists shaken_trust_product_sid,
--     drop column if exists shaken_status,
--     drop column if exists voice_integrity_trust_product_sid,
--     drop column if exists voice_integrity_status,
--     drop column if exists caller_id_checked_at,
--     drop column if exists caller_id_lock_until;
--   delete from supabase_migrations.schema_migrations where version = '255';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the columns and their checks
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.sms_numbers
  add column if not exists shaken_trust_product_sid          text,
  add column if not exists shaken_status                     text,
  add column if not exists voice_integrity_trust_product_sid text,
  add column if not exists voice_integrity_status            text,
  add column if not exists caller_id_checked_at              timestamptz,
  add column if not exists caller_id_lock_until              timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_numbers_shaken_status_chk') then
    alter table public.sms_numbers
      add constraint sms_numbers_shaken_status_chk
      check (shaken_status is null
             or shaken_status in ('draft','pending-review','in-review','twilio-rejected','twilio-approved'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sms_numbers_voice_integrity_status_chk') then
    alter table public.sms_numbers
      add constraint sms_numbers_voice_integrity_status_chk
      check (voice_integrity_status is null
             or voice_integrity_status in ('draft','pending-review','in-review','twilio-rejected','twilio-approved'));
  end if;
  -- A Trust Product SID is BU + 32 hex (TrustProduct.sid pattern ^BU[0-9a-fA-F]{32}$). Anything
  -- else stored here is a bug that would make the next status read fail at Twilio.
  if not exists (select 1 from pg_constraint where conname = 'sms_numbers_trust_product_sids_chk') then
    alter table public.sms_numbers
      add constraint sms_numbers_trust_product_sids_chk
      check ((shaken_trust_product_sid is null or shaken_trust_product_sid ~ '^BU[0-9a-fA-F]{32}$')
         and (voice_integrity_trust_product_sid is null or voice_integrity_trust_product_sid ~ '^BU[0-9a-fA-F]{32}$'));
  end if;
end $$;

comment on column public.sms_numbers.shaken_trust_product_sid is
  'Migration 255: BU… of this number''s SHAKEN/STIR Trust Product (plan §14). Written by portal-settings phone_trust_setup (operator-only) the moment Twilio names it, before the later steps, so a retry reuses it. NULL = never registered.';
comment on column public.sms_numbers.shaken_status is
  'Migration 255: the SHAKEN/STIR Trust Product''s Twilio review status as last read (draft | pending-review | in-review | twilio-rejected | twilio-approved). Level A attestation needs twilio-approved AND an approved business profile.';
comment on column public.sms_numbers.voice_integrity_trust_product_sid is
  'Migration 255: BU… of this number''s Voice Integrity Trust Product (carrier spam-label registration, plan §14). Written by phone_trust_setup (operator-only). NULL = never registered.';
comment on column public.sms_numbers.voice_integrity_status is
  'Migration 255: the Voice Integrity Trust Product''s Twilio review status as last read (same vocabulary as shaken_status).';
comment on column public.sms_numbers.caller_id_checked_at is
  'Migration 255: when phone_trust_setup / phone_trust_status last read either caller-ID status from Twilio.';
comment on column public.sms_numbers.caller_id_lock_until is
  'Migration 255: phone_trust_setup''s single-flight claim on this number, taken by one conditional UPDATE (only where NULL or expired) and cleared when the run ends. NULL or past = free.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_col  text;
  v_type text;
  v_role text;
  v_priv text;
begin
  for v_col, v_type in
    select * from (values
      ('shaken_trust_product_sid', 'text'), ('shaken_status', 'text'),
      ('voice_integrity_trust_product_sid', 'text'), ('voice_integrity_status', 'text'),
      ('caller_id_checked_at', 'timestamp with time zone'),
      ('caller_id_lock_until', 'timestamp with time zone')) as t(c, ty)
  loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'sms_numbers'
                      and column_name = v_col and data_type = v_type and is_nullable = 'YES'
                      and column_default is null) then
      raise exception '255: sms_numbers.% is missing, not %, not nullable, or has a default', v_col, v_type;
    end if;
  end loop;

  for v_col in select unnest(array['sms_numbers_shaken_status_chk','sms_numbers_voice_integrity_status_chk',
                                   'sms_numbers_trust_product_sids_chk'])
  loop
    if not exists (select 1 from pg_constraint
                    where conname = v_col and conrelid = 'public.sms_numbers'::regclass and contype = 'c') then
      raise exception '255: check constraint % is missing', v_col;
    end if;
  end loop;

  -- 165's posture still holds: the browser roles cannot touch sms_numbers at all, so the new
  -- columns are service-role only like every other one on it.
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if has_table_privilege(v_role, 'public.sms_numbers', v_priv) then
        raise exception '255: % holds % on sms_numbers', v_role, v_priv;
      end if;
    end loop;
    -- Column grants are separate from table grants; none may exist on the new columns either.
    foreach v_priv in array array['SELECT','INSERT','UPDATE'] loop
      foreach v_col in array array['shaken_trust_product_sid','shaken_status','voice_integrity_trust_product_sid',
                                   'voice_integrity_status','caller_id_checked_at','caller_id_lock_until'] loop
        if has_column_privilege(v_role, 'public.sms_numbers', v_col, v_priv) then
          raise exception '255: % holds column % on sms_numbers.%', v_role, v_priv, v_col;
        end if;
      end loop;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT','UPDATE'] loop
    if not has_table_privilege('service_role', 'public.sms_numbers', v_priv) then
      raise exception '255: service_role lost % on sms_numbers', v_priv;
    end if;
  end loop;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — a behavioural probe on one synthetic row, removed before commit
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The checks refuse what they must and take what the code writes. The row is inserted and
-- deleted inside this transaction (live on 2026-09-29, sms_numbers had no triggers and only its
-- primary key; nothing references a fresh id), so nothing is left behind even for an instant
-- outside it. It is inserted already RELEASED, so sms_numbers_live_unique (165, partial on
-- released_at is null) cannot collide with a real number whatever it is.
do $probe$
declare
  v_id uuid;
  v_refused boolean;
begin
  insert into public.sms_numbers (client_id, phone_number, registration_status, released_at)
  values ('__255_probe__', '+15555550100', 'pending_registration', now())
  returning id into v_id;

  update public.sms_numbers
     set shaken_trust_product_sid = 'BU' || repeat('a', 32), shaken_status = 'pending-review',
         voice_integrity_trust_product_sid = 'BU' || repeat('0', 32), voice_integrity_status = 'twilio-approved',
         caller_id_checked_at = now()
   where id = v_id;

  v_refused := false;
  begin
    update public.sms_numbers set shaken_status = 'approved' where id = v_id;
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then raise exception '255: shaken_status accepted a value outside Twilio''s enum'; end if;

  v_refused := false;
  begin
    update public.sms_numbers set voice_integrity_status = 'PENDING' where id = v_id;
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then raise exception '255: voice_integrity_status accepted a value outside Twilio''s enum'; end if;

  v_refused := false;
  begin
    update public.sms_numbers set shaken_trust_product_sid = 'PN' || repeat('a', 32) where id = v_id;
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then raise exception '255: shaken_trust_product_sid accepted a non-BU sid'; end if;

  -- The claim: the first conditional update takes it, a second one while it is held does not, and
  -- an expired one is taken again. Exactly the statement portal-settings sends.
  update public.sms_numbers set caller_id_lock_until = now() + interval '5 minutes'
   where id = v_id and (caller_id_lock_until is null or caller_id_lock_until < now());
  if not found then raise exception '255: a free number could not be claimed'; end if;
  update public.sms_numbers set caller_id_lock_until = now() + interval '5 minutes'
   where id = v_id and (caller_id_lock_until is null or caller_id_lock_until < now());
  if found then raise exception '255: a held claim was taken a second time'; end if;
  update public.sms_numbers set caller_id_lock_until = now() - interval '1 second' where id = v_id;
  update public.sms_numbers set caller_id_lock_until = now() + interval '5 minutes'
   where id = v_id and (caller_id_lock_until is null or caller_id_lock_until < now());
  if not found then raise exception '255: an expired claim could not be taken again'; end if;

  delete from public.sms_numbers where id = v_id;
  if exists (select 1 from public.sms_numbers where client_id = '__255_probe__') then
    raise exception '255: the probe row was not removed';
  end if;
end
$probe$;

commit;
