-- 299_twilio_usage_drop_day_key.sql — twilio_usage_daily drops its old (day, category) primary key
--                                     (Workstream 2, phase 7, step 2 of 2; 298 is step 1).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, AND ONLY AFTER ALL OF THESE (SETUP.md 7f):
--    1. 298 is applied (this file refuses without its key);
--    2. the phone-api Worker that upserts on "day,account_sid,category" is LIVE: download the live
--       bundle and find that string in it, and `npx wrangler versions view <live version>`;
--    3. one 09:00 UTC run has gone through on that Worker: `select max(fetched_at) from
--       public.twilio_usage_daily;` reads a time after its deploy, and app_errors has no
--       twilio_usage_key_pending row after it (that row means it fell back to the old key).
--    An OLD Worker still upserts on (day, category): with that key gone its 09:00 run fails (42P10)
--    and the day's usage is not stored. That is the one way this goes wrong, and step 2 rules it out.
--    Pipe this file to `supabase db query --linked` (stdin), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('299', '299_twilio_usage_drop_day_key') returning version, name;
--    NEVER `supabase db push`. THE RECORD at the end is what the apply shows.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Renumber with 298 (this file must stay after it), renaming its test (tests/sql/migration299.test.cjs).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- With the old key (day, category) a sub-account's row for a day and category the parent also has
-- collides with the parent's row, so the Worker skips every sub-account's usage
-- (twilio_usage_sub_key_pending) until it is gone. 298's UNIQUE NULLS NOT DISTINCT (day, account_sid,
-- category) then is the table's key: one row per day, account and category, the parent's NULL
-- matching itself. A table without a primary key is fine here: nothing references it, the Worker
-- names its conflict target, and it is in no publication (checked below: a published table without
-- a replica identity would refuse every UPDATE, i.e. every refreshed day).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Dropping a primary key is a catalog change and an index drop on a table of a few hundred rows.
-- No row changes.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Only if no sub-account row is stored (or after exporting and deleting them):
--   select count(*) from public.twilio_usage_daily where account_sid is not null;   -- must be 0
--   alter table public.twilio_usage_daily add primary key (day, category);
--   delete from supabase_migrations.schema_migrations where version = '299';
-- The Worker keeps working either way (it upserts on 298's key, which stays).

begin;

set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.twilio_usage_daily') is null then
    raise exception '299: twilio_usage_daily is missing (migration 259 not applied?)';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c join pg_catalog.pg_index i on i.indexrelid = c.conindid
                  where c.conrelid = 'public.twilio_usage_daily'::regclass and c.conname = 'twilio_usage_daily_account_key'
                    and c.contype = 'u' and i.indnullsnotdistinct) then
    raise exception '299: twilio_usage_daily_account_key is missing or not NULLS NOT DISTINCT (migration 298 not applied?)';
  end if;
  if exists (select 1 from pg_catalog.pg_publication p where p.puballtables)
     or exists (select 1 from pg_catalog.pg_publication_tables t where t.schemaname = 'public' and t.tablename = 'twilio_usage_daily') then
    raise exception '299: twilio_usage_daily is in a publication; without a primary key it would refuse every UPDATE. Take it out of the publication first.';
  end if;
end
$pre$;

create temp table m299_before on commit drop as select count(*)::bigint as n from public.twilio_usage_daily;

do $drop$
declare
  v_name text;
begin
  select c.conname into v_name from pg_catalog.pg_constraint c
   where c.conrelid = 'public.twilio_usage_daily'::regclass and c.contype = 'p';
  if v_name is not null then
    execute format('alter table public.twilio_usage_daily drop constraint %I', v_name);
  end if;
end
$drop$;

comment on table public.twilio_usage_daily is
  'Migration 259, keyed per account since 298/299. Twilio Usage Records (Daily), one row per day, account and category (twilio_usage_daily_account_key: account_sid NULL = the parent; the parent''s rows are its own usage, IncludeSubaccounts=false), price in positive micros. Upserted by the phone-api Worker each morning for yesterday. Operator-only: it is our cost.';

-- ── CHECKS ───────────────────────────────────────────────────────────────────────────────
do $check$
declare
  v_out text;
begin
  if exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.twilio_usage_daily'::regclass and c.contype = 'p') then
    raise exception '299: the old primary key is still there';
  end if;
  if (select n from m299_before) <> (select count(*) from public.twilio_usage_daily) then
    raise exception '299: the row count moved during the apply — run it again';
  end if;
  begin
    insert into public.twilio_usage_daily (day, category, count) values ('1900-01-01', 'm299-probe', 1)
      on conflict (day, account_sid, category) do update set count = excluded.count;
    insert into public.twilio_usage_daily (day, account_sid, category, count) values ('1900-01-01', 'AC' || repeat('f', 32), 'm299-probe', 2)
      on conflict (day, account_sid, category) do update set count = excluded.count;
    insert into public.twilio_usage_daily (day, category, count) values ('1900-01-01', 'm299-probe', 3)
      on conflict (day, account_sid, category) do update set count = excluded.count;
    if (select count(*) from public.twilio_usage_daily where day = '1900-01-01') <> 2
       or (select count from public.twilio_usage_daily where day = '1900-01-01' and account_sid is null) <> 3 then
      raise exception '299: a parent row and a sub row for the same day and category did not sit side by side, one each';
    end if;
    begin
      insert into public.twilio_usage_daily (day, category, count) values ('1900-01-01', 'm299-probe', 4);
      raise exception '299: a second parent row for the same day and category was accepted';
    exception when unique_violation then null;
    end;
    raise exception using errcode = 'S2990', message = 'a parent and a sub row side by side, one each; a second parent row refused';
  exception when sqlstate 'S2990' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.twilio_usage_daily where day = '1900-01-01') then
    raise exception '299: the rehearsal left a row behind';
  end if;
  perform set_config('ss.m299_rehearsal', v_out, true);
  raise notice '299: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD ──────────────────────────────────────────────────────────────────────────
-- PASS: usage_pk null, account_key 'day,account_sid,category', rows = the count before,
-- rehearsal 'a parent and a sub row side by side, one each; a second parent row refused'.
select
  '299' as migration,
  (select string_agg(a.attname, ',' order by k.ord)
     from pg_catalog.pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
     join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = 'public.twilio_usage_daily'::regclass and c.contype = 'p') as usage_pk,
  (select string_agg(a.attname, ',' order by k.ord)
     from pg_catalog.pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
     join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = 'public.twilio_usage_daily'::regclass and c.conname = 'twilio_usage_daily_account_key') as account_key,
  (select count(*) from public.twilio_usage_daily)::int as rows,
  current_setting('ss.m299_rehearsal', true) as rehearsal;

commit;
