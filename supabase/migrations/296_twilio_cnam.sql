-- 296_twilio_cnam.sql — where a number's CNAM registration stands (the business's name on the
--                       called party's screen): Workstream 2, phase 6.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('296', '296_twilio_cnam') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints only the last statement's rows: THE
--    RECORD at the end is what the apply shows; no row printed means the file did not run. To see
--    the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Written 2026-10-09 on top of 295 (ss/c1009-twilio-p6-p8). A sibling branch may take 296 first.
-- Read the live ledger and take the next free number, renaming this file, its test
-- (tests/sql/migration296.test.cjs) and every '296' below together:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 5;
-- 297, 298 and 299 of this branch come after it in that order whatever their final numbers.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Caller ID trust had two kinds per number (255: SHAKEN/STIR and Voice Integrity). Phase 6 adds the
-- third, CNAM: the business's name, up to 15 characters, shown by carriers that look the calling
-- number up. It is one more Trust Hub Trust Product on the builder's own business profile, built by
-- the same operator-only actions (portal-settings phone_trust_setup / phone_trust_status with
-- product "cnam"; _shared/twilioTrustHub.ts setupVoiceTrust, POLICY_CNAM_TRUST_PRODUCT), in the
-- builder's own Twilio account. It needs an EIN (or DUNS) on that profile, and the name takes 48-72
-- hours to reach every US carrier after Twilio approves it. This is where the outcome is recorded,
-- per number, beside 255's columns:
--
--   cnam_trust_product_sid   BU… of the number's CNAM Trust Product
--   cnam_status              its Twilio review status, as last read (255's vocabulary: draft |
--                            pending-review | in-review | twilio-rejected | twilio-approved; NULL =
--                            never registered)
--   cnam_display_name        the name Twilio was last sent (what callers will see): 1-15 of
--                            letters, numbers, spaces, periods and commas, starting with a letter
--                            (Twilio's rules; _shared/twilioTrustHub.ts parseCnamDisplayName)
--
-- The checked-at time and the one-run-at-a-time claim are 255's caller_id_checked_at and
-- caller_id_lock_until, shared with the other two kinds.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Three NULLable columns with no default rewrite no rows
-- and change no existing reader (every reader names its columns; 254's RPCs pick named fields).
-- portal-settings reads them in the same select as 255's columns and, when that select fails for a
-- missing column, reads 255's columns alone: a portal-settings deploy that lands before this
-- migration shows CNAM as "not available yet" and leaves SHAKEN/STIR and Voice Integrity working.
-- lock_timeout makes a hung apply give up rather than queue every text behind it.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- Any time, before or after portal-settings (see above). Nothing registers CNAM until an operator
-- presses it on the Phone tab.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- A CNAM Trust Product recorded here still exists at Twilio; its SID is the record of it. Export
-- the rows first if any are set:
--   select id, client_id, cnam_trust_product_sid, cnam_status from public.sms_numbers where cnam_trust_product_sid is not null;
--   alter table public.sms_numbers
--     drop constraint if exists sms_numbers_cnam_status_chk,
--     drop constraint if exists sms_numbers_cnam_sid_chk,
--     drop constraint if exists sms_numbers_cnam_display_name_chk,
--     drop column if exists cnam_trust_product_sid,
--     drop column if exists cnam_status,
--     drop column if exists cnam_display_name;
--   delete from supabase_migrations.schema_migrations where version = '296';

begin;

set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.sms_numbers') is null then
    raise exception '296: sms_numbers is missing (migration 165 not applied?)';
  end if;
  if (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'sms_numbers'
        and c.column_name in ('shaken_status', 'caller_id_checked_at', 'caller_id_lock_until')) <> 3 then
    raise exception '296: sms_numbers has no caller-ID columns (migration 255 not applied?)';
  end if;
end
$pre$;

create temp table m296_before on commit drop as select count(*)::bigint as n from public.sms_numbers;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the columns and their rules
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.sms_numbers
  add column if not exists cnam_trust_product_sid text,
  add column if not exists cnam_status            text,
  add column if not exists cnam_display_name      text;

do $cols$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.sms_numbers'::regclass and conname = 'sms_numbers_cnam_status_chk') then
    alter table public.sms_numbers add constraint sms_numbers_cnam_status_chk
      check (cnam_status is null
             or cnam_status in ('draft','pending-review','in-review','twilio-rejected','twilio-approved'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.sms_numbers'::regclass and conname = 'sms_numbers_cnam_sid_chk') then
    alter table public.sms_numbers add constraint sms_numbers_cnam_sid_chk
      check (cnam_trust_product_sid is null or cnam_trust_product_sid ~ '^BU[0-9a-fA-F]{32}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.sms_numbers'::regclass and conname = 'sms_numbers_cnam_display_name_chk') then
    alter table public.sms_numbers add constraint sms_numbers_cnam_display_name_chk
      check (cnam_display_name is null
             or (char_length(cnam_display_name) between 1 and 15 and cnam_display_name ~ '^[A-Za-z][A-Za-z0-9., ]*$'));
  end if;
end
$cols$;

comment on column public.sms_numbers.cnam_trust_product_sid is
  'Migration 296: BU… of this number''s CNAM Trust Product (the business''s name on the called party''s screen), made by portal-settings phone_trust_setup (product cnam). NULL = never registered.';
comment on column public.sms_numbers.cnam_status is
  'Migration 296: the CNAM Trust Product''s Twilio review status as last read (255''s vocabulary). The name reaches carriers 48-72 hours after twilio-approved.';
comment on column public.sms_numbers.cnam_display_name is
  'Migration 296: the CNAM display name Twilio was last sent: 1-15 letters, numbers, spaces, periods and commas, starting with a letter.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_col  text;
  v_role text;
  v_priv text;
begin
  foreach v_col in array array['cnam_trust_product_sid', 'cnam_status', 'cnam_display_name'] loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = 'sms_numbers' and c.column_name = v_col
                      and c.data_type = 'text' and c.is_nullable = 'YES' and c.column_default is null) then
      raise exception '296: sms_numbers.% is missing, not text, not nullable, or has a default', v_col;
    end if;
    execute format('select 1 from public.sms_numbers where %I is not null limit 1', v_col) into v_role;
    if v_role is not null then
      raise exception '296: sms_numbers.% already holds a value; nothing has registered CNAM yet', v_col;
    end if;
  end loop;
  foreach v_col in array array['sms_numbers_cnam_status_chk', 'sms_numbers_cnam_sid_chk', 'sms_numbers_cnam_display_name_chk'] loop
    if not exists (select 1 from pg_catalog.pg_constraint
                    where conname = v_col and conrelid = 'public.sms_numbers'::regclass and contype = 'c' and convalidated) then
      raise exception '296: check constraint % is missing or not validated', v_col;
    end if;
  end loop;
  -- 165's posture still holds: the browser roles cannot touch sms_numbers, so the new columns are
  -- service-role only like every other one on it.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(v_role, 'public.sms_numbers', v_priv) then
        raise exception '296: % holds % on sms_numbers', v_role, v_priv;
      end if;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      foreach v_col in array array['cnam_trust_product_sid', 'cnam_status', 'cnam_display_name'] loop
        if has_column_privilege(v_role, 'public.sms_numbers', v_col, v_priv) then
          raise exception '296: % holds column % on sms_numbers.%', v_role, v_priv, v_col;
        end if;
      end loop;
    end loop;
  end loop;
  if (select n from m296_before) <> (select count(*) from public.sms_numbers) then
    raise exception '296: the number of sms_numbers rows moved during the apply — run it again';
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — a behavioural probe on one synthetic row, removed before commit
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The rules refuse what they must and take what the code writes. The row is inserted RELEASED (so
-- 165's live-number unique index cannot meet a real number) for a tenant id no account row names
-- (so 295's twilio_number_follows_account lets it through), and deleted in this transaction.
do $probe$
declare
  v_id      uuid;
  v_refused int := 0;
  v_bad     text;
begin
  insert into public.sms_numbers (client_id, phone_number, registration_status, released_at)
    values ('m296-probe', '+15555550296', 'pending_registration', now())
    returning id into v_id;
  foreach v_bad in array array[
    'cnam_status = ''approved''',
    'cnam_trust_product_sid = ''BU123''',
    'cnam_display_name = ''Sixteen chars xx''',
    'cnam_display_name = ''9 Barns''',
    'cnam_display_name = ''Barns & Sheds''',
    'cnam_display_name = '''''
  ] loop
    begin
      execute format('update public.sms_numbers set %s where id = %L', v_bad, v_id);
    exception when check_violation then
      v_refused := v_refused + 1;
    end;
  end loop;
  if v_refused <> 6 then
    raise exception '296: the probe expected 6 refusals, got %', v_refused;
  end if;
  update public.sms_numbers
     set cnam_trust_product_sid = 'BU' || repeat('a', 32), cnam_status = 'pending-review', cnam_display_name = 'Acme Barns, LLC'
   where id = v_id;
  update public.sms_numbers set cnam_display_name = 'J.R. Sheds 2' where id = v_id;
  delete from public.sms_numbers where id = v_id;
  if exists (select 1 from public.sms_numbers where client_id = 'm296-probe') then
    raise exception '296: the probe row was left behind';
  end if;
  perform set_config('ss.m296_probe', 'six bad values refused, a real SID, status and two real names taken, probe removed', true);
  raise notice '296: checks hold';
end
$probe$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- PASS: columns_added 3, constraints 3, rows_with_cnam 0, probe 'six bad values refused, a real
-- SID, status and two real names taken, probe removed'. Anything else: roll back first.
select
  '296' as migration,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'sms_numbers'
     and c.column_name in ('cnam_trust_product_sid', 'cnam_status', 'cnam_display_name'))::int as columns_added,
  (select count(*) from pg_catalog.pg_constraint where conrelid = 'public.sms_numbers'::regclass
     and conname in ('sms_numbers_cnam_status_chk', 'sms_numbers_cnam_sid_chk', 'sms_numbers_cnam_display_name_chk'))::int as constraints,
  (select count(*) from public.sms_numbers where cnam_trust_product_sid is not null or cnam_status is not null or cnam_display_name is not null)::int as rows_with_cnam,
  current_setting('ss.m296_probe', true) as probe;

commit;
