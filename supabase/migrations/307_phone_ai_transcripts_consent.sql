-- 307_phone_ai_transcripts_consent.sql — each team member's yes or no to third-party AI on their
--                                        calls (the phone app's transcripts notice).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('307', '307_phone_ai_transcripts_consent') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run. To see the same row and
--    change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-13: 305 is the newest. 306 is held by ss/c1012-csv-import
-- (306_crm_import_leads.sql), so this is 307. Neither needs the other. Take the next free number
-- at apply time, renaming this file, its test (tests/sql/migration307.test.cjs) and every '307'
-- below; record the ledger row with `returning`: no row back means the number was taken.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- App Store guideline 5.1.2(i) (revised 2025-11-13): an app "must clearly disclose where personal
-- data will be shared with third parties, including with third-party AI, and obtain explicit
-- permission before doing so". Since the phone-api Worker's CALL_TRANSCRIBE rail went on
-- (2026-10-13), every recorded call goes to Cloudflare Workers AI for a transcript and the
-- transcript to Anthropic's Claude for a summary, behind nothing but the business owner's switch
-- (client_settings.phone_transcribe_calls, default true). The phone app's notice (build 9) asks
-- each person; this is where the answer lives, so that it decides whether their calls are sent
-- (the Worker reads it at the moment of sending), not only whether the app shows the text, and so
-- it follows them to every device.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * phone_user_settings gains three columns, all NULL for everyone (nobody has answered):
--       ai_transcripts          'allowed' | 'declined' | NULL (never answered)
--       ai_transcripts_version  the notice version answered (the apps' AI_NOTICE_VERSION), >= 1
--       ai_transcripts_at       when
--     All three set or all three NULL (one check). Written only by phone-api
--     POST /settings/me/ai-transcripts, as the service role.
--   * Nothing else. No backfill: NULL is "never answered", which the Worker treats as no.
--
-- ── WHAT THE WORKER DOES WITH IT (workers/phone-api src/aiConsent.ts) ────────────────────
-- A recorded call goes to Workers AI, and its transcript to Claude, only while EVERY team member
-- on the call has 'allowed' at version >= AI_CONSENT_MIN_VERSION. NULL or 'declined' for anyone
-- on it: settled off, never sent. So from the moment the Worker that reads this is live, no call
-- is transcribed until the people on it say yes in build 9 of the phone app.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- ADD COLUMN with no default is a catalog change (no rewrite). The constraints go on NOT VALID
-- and are then validated: a scan of a table that had 1 row on 2026-10-13. The ALTERs take a brief
-- ACCESS EXCLUSIVE lock on phone_user_settings, which /token, inbound routing and /settings/me
-- read; lock_timeout makes a hung apply give up rather than queue calls behind it (retry it). The
-- table keeps its one trigger (set_updated_at), its RLS (on, no policy) and its grants
-- (service_role only): new columns inherit the table's privileges, and the checks below prove
-- the browser roles still hold nothing on them.
--
-- ── ORDER (workers/phone-api SETUP.md 7d) ────────────────────────────────────────────────
--   1. This file.
--   2. The phone-api Worker that reads it (StructureStudio branch ss/c1013-ai-notice-flag). An
--      older Worker ignores the columns. The newer Worker on a database WITHOUT this file still
--      answers /token (it leaves `ai_consent` out and logs ai_consent_unreadable), but its minute
--      tick sends nothing (its read fails, so it fails closed) and the save refuses: apply this
--      first.
--   3. Phone app build 9.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Roll the Worker back to one that doesn't read these first (or its minute tick sends nothing:
-- the read fails, fail closed). Then:
--   alter table public.phone_user_settings
--     drop constraint if exists phone_user_settings_ai_transcripts_chk,
--     drop constraint if exists phone_user_settings_ai_transcripts_whole,
--     drop column if exists ai_transcripts_at,
--     drop column if exists ai_transcripts_version,
--     drop column if exists ai_transcripts;
--   notify pgrst, 'reload schema';
--   delete from supabase_migrations.schema_migrations where version = '307';
-- ⚠️ Dropping the columns forgets every answer: everyone is asked again, and an older Worker
-- goes back to sending every call of a business with transcripts on.

begin;

set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.phone_user_settings') is null then
    raise exception '307: phone_user_settings is missing (migration 254 not applied?)';
  end if;
end
$pre$;

-- The rows, and how many answers they hold, BEFORE anything here runs (none on a first apply; a
-- re-apply after people answered must leave every answer as it was).
create temp table m307_before on commit drop as
  select count(*)::bigint as n, 0::bigint as answered from public.phone_user_settings;
do $snap$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'phone_user_settings' and column_name = 'ai_transcripts') then
    execute 'update m307_before set answered = (select count(*) from public.phone_user_settings where ai_transcripts is not null)';
  end if;
end
$snap$;

-- ── THE CHANGE ───────────────────────────────────────────────────────────────────────────
alter table public.phone_user_settings
  add column if not exists ai_transcripts         text,
  add column if not exists ai_transcripts_version smallint,
  add column if not exists ai_transcripts_at      timestamptz;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'phone_user_settings_ai_transcripts_chk'
                    and conrelid = 'public.phone_user_settings'::regclass) then
    alter table public.phone_user_settings
      add constraint phone_user_settings_ai_transcripts_chk
      check (ai_transcripts is null or ai_transcripts in ('allowed', 'declined')) not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'phone_user_settings_ai_transcripts_whole'
                    and conrelid = 'public.phone_user_settings'::regclass) then
    alter table public.phone_user_settings
      add constraint phone_user_settings_ai_transcripts_whole
      check (
        (ai_transcripts is null and ai_transcripts_version is null and ai_transcripts_at is null)
        -- Every part spelt out as not null: a NULL inside an AND makes the whole check NULL,
        -- and a CHECK lets NULL through.
        or (ai_transcripts is not null and ai_transcripts_version is not null and ai_transcripts_version >= 1
            and ai_transcripts_at is not null)
      ) not valid;
  end if;
end
$$;
alter table public.phone_user_settings validate constraint phone_user_settings_ai_transcripts_chk;
alter table public.phone_user_settings validate constraint phone_user_settings_ai_transcripts_whole;

comment on column public.phone_user_settings.ai_transcripts is
  'SSS Phone (migration 307): this person''s answer to the phone app''s transcripts notice (App Store guideline 5.1.2(i)): ''allowed'', ''declined'', or NULL (never answered). A recorded call goes to Cloudflare Workers AI for a transcript, and its transcript to Anthropic''s Claude for a summary, only while EVERY team member on the call has ''allowed'' (phone-api src/aiConsent.ts, read at the moment of sending); NULL counts as no. On top of the owner''s client_settings.phone_transcribe_calls and the Worker''s CALL_TRANSCRIBE rail. Written by phone-api POST /settings/me/ai-transcripts only.';
comment on column public.phone_user_settings.ai_transcripts_version is
  'SSS Phone (migration 307): the notice version the answer was given to (the apps'' AI_NOTICE_VERSION), >= 1; NULL with no answer. An ''allowed'' below phone-api AI_CONSENT_MIN_VERSION no longer counts.';
comment on column public.phone_user_settings.ai_transcripts_at is
  'SSS Phone (migration 307): when the answer was given; NULL with no answer.';

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_role text;
  v_priv text;
  v_c    text;
  v_type text;
  v_out  text;
  v_cols constant text[] := array['ai_transcripts', 'ai_transcripts_version', 'ai_transcripts_at'];
  v_types constant text[] := array['text', 'smallint', 'timestamp with time zone'];
  v_probe constant uuid := '00000000-0000-4000-8000-00000000c307';
begin
  -- ── The three columns: their types, nullable, no default ──
  for i in 1 .. array_length(v_cols, 1) loop
    select c.data_type into v_type from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'phone_user_settings' and c.column_name = v_cols[i]
       and c.is_nullable = 'YES' and c.column_default is null;
    if v_type is distinct from v_types[i] then
      raise exception '307: phone_user_settings.% should be a nullable % with no default, is %', v_cols[i], v_types[i], coalesce(v_type, 'missing (or not nullable, or defaulted)');
    end if;
  end loop;

  -- ── Both checks there and validated ──
  if (select count(*) from pg_catalog.pg_constraint
       where conrelid = 'public.phone_user_settings'::regclass and contype = 'c' and convalidated
         and conname in ('phone_user_settings_ai_transcripts_chk', 'phone_user_settings_ai_transcripts_whole')) <> 2 then
    raise exception '307: the two ai_transcripts checks are not both there and validated';
  end if;

  -- ── Nobody's answer was made up or lost: as many answers as before (none on a first apply) ──
  if (select count(*) from public.phone_user_settings where ai_transcripts is not null) <> (select answered from m307_before) then
    raise exception '307: the number of answers moved (% before, % now); this file writes none',
      (select answered from m307_before), (select count(*) from public.phone_user_settings where ai_transcripts is not null);
  end if;
  if (select n from m307_before) <> (select count(*) from public.phone_user_settings) then
    raise exception '307: the row count moved during the apply — run it again';
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles on the new
  --    columns (254 PART 3's posture), and the service role can read and write them ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.phone_user_settings'::regclass) then
    raise exception '307: RLS is off on phone_user_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.phone_user_settings'::regclass) then
    raise exception '307: phone_user_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_c in array v_cols loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
        if has_column_privilege(v_role, 'public.phone_user_settings', v_c, v_priv) then
          raise exception '307: % holds % on phone_user_settings.%', v_role, v_priv, v_c;
        end if;
      end loop;
    end loop;
  end loop;
  foreach v_c in array v_cols loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if not has_column_privilege('service_role', 'public.phone_user_settings', v_c, v_priv) then
        raise exception '307: service_role lacks % on phone_user_settings.% — the Worker could not save or read an answer', v_priv, v_c;
      end if;
    end loop;
  end loop;

  -- ── The rehearsal: the Worker's two writes, and the shapes the checks must refuse, on a probe
  --    row that a sub-block's own exception rolls back ──
  if exists (select 1 from public.phone_user_settings where user_id = v_probe) then
    raise exception '307: a phone_user_settings row for % already exists; the rehearsal will not touch it', v_probe;
  end if;
  begin
    insert into public.phone_user_settings (user_id, client_id, ai_transcripts, ai_transcripts_version, ai_transcripts_at)
      values (v_probe, '__m307_rehearsal__', 'allowed', 1, now())
      on conflict (user_id) do update set ai_transcripts = excluded.ai_transcripts;
    insert into public.phone_user_settings (user_id, client_id, ai_transcripts, ai_transcripts_version, ai_transcripts_at)
      values (v_probe, '__m307_rehearsal__', 'declined', 1, now())
      on conflict (user_id) do update
        set ai_transcripts = excluded.ai_transcripts, ai_transcripts_version = excluded.ai_transcripts_version, ai_transcripts_at = excluded.ai_transcripts_at;
    if (select ai_transcripts from public.phone_user_settings where user_id = v_probe) is distinct from 'declined' then
      raise exception '307: the second save did not replace the first';
    end if;
    begin
      update public.phone_user_settings set ai_transcripts = 'maybe' where user_id = v_probe;
      raise exception '307: an answer other than allowed / declined was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.phone_user_settings set ai_transcripts_version = null where user_id = v_probe;
      raise exception '307: an answer with no notice version was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.phone_user_settings set ai_transcripts_version = 0 where user_id = v_probe;
      raise exception '307: notice version 0 was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.phone_user_settings set ai_transcripts = null where user_id = v_probe;
      raise exception '307: a version and a time with no answer were accepted';
    exception when check_violation then null;
    end;
    raise exception using errcode = 'S3070', message = 'allowed then declined saved; maybe, no version, version 0 and a stray version refused';
  exception when sqlstate 'S3070' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.phone_user_settings where user_id = v_probe) then
    raise exception '307: the rehearsal row % was not rolled back', v_probe;
  end if;
  perform set_config('ss.m307_rehearsal', v_out, true);
  raise notice '307: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. Expected on a first apply (2026-10-13):
--   columns 'ai_transcripts text,ai_transcripts_version smallint,ai_transcripts_at timestamp with time zone',
--   rows_total 1, rows_answered 0 (a re-apply later: the answers saved by then, unchanged),
--   rehearsal 'allowed then declined saved; maybe, no version, version 0 and a stray version refused'
select
  '307' as migration,
  (select string_agg(c.column_name || ' ' || c.data_type, ',' order by c.ordinal_position)
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'phone_user_settings' and c.column_name like 'ai\_transcripts%') as columns,
  (select count(*) from public.phone_user_settings)::int as rows_total,
  (select count(*) from public.phone_user_settings where ai_transcripts is not null)::int as rows_answered,
  current_setting('ss.m307_rehearsal', true) as rehearsal;

commit;

-- After this: everyone reads "never answered", so the Worker that reads these sends no call to
-- Workers AI or Claude until the people on it say yes in the phone app.
