-- 298_twilio_usage_account_key.sql — twilio_usage_daily gets its per-account key, BESIDE the old
--                                    one (Workstream 2, phase 7, step 1 of 2; 299 is step 2).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('298', '298_twilio_usage_account_key') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run. To see the same row and
--    change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Written 2026-10-09 after 296 and 297 of the same branch (ss/c1009-twilio-p6-p8). Take the next
-- free number from the live ledger, renaming this file, its test (tests/sql/migration298.test.cjs)
-- and every '298' below; 299 must stay AFTER it, whatever both become.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- twilio_usage_daily (259) holds Twilio's daily Usage Records for ONE account: its key is
-- (day, category). With a sub-account per builder (Workstream 2) each account's records are stored
-- separately: (day, account_sid, category), account_sid NULL for the parent (292's one encoding).
-- A primary key cannot hold that NULL, and a plain unique index never matches two NULLs (every
-- day's parent rows would be added again instead of refreshed), so the key is
--   UNIQUE NULLS NOT DISTINCT (day, account_sid, category)            (Postgres 15+)
-- which is what the phone-api Worker's upsert names (onConflict "day,account_sid,category",
-- src/cron/usageCharge.ts USAGE_ACCOUNT_KEY).
--
-- ── THE ORDER, SO THE 09:00 UTC RUN NEVER BREAKS (SETUP.md 7f, "Usage per account") ───────
--   1. THIS migration: adds the new key and KEEPS the old primary key (day, category). Both hold
--      for the parent's rows, so whichever Worker is live keeps working: the old one upserts on
--      (day, category), the new one on (day, account_sid, category).
--   2. The Worker that writes the new key (it also asks for the parent's usage alone,
--      IncludeSubaccounts=false). It may even go first: before this migration it falls back to
--      (day, category) and logs twilio_usage_key_pending once (info).
--   3. One 09:00 UTC run on that Worker (the live bundle contains "day,account_sid,category").
--   4. 299: drops the old primary key. Only from then can a sub-account's rows sit beside the
--      parent's for the same day and category; until then the Worker skips them and logs
--      twilio_usage_sub_key_pending (info). 299 before step 2 would break the old Worker's run.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- One unique constraint on a table of a few hundred rows (an index build of a moment). Every row
-- today has account_sid NULL and (day, category) unique, so (day, NULL, category) is unique too:
-- nothing can collide. The old key and every existing row are untouched. Readers (admin-catalog's
-- phone usage report) name their columns and sum by category, so rows of several accounts add up
-- to the whole bill.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Only while the old primary key is still there (299 not applied), and with the Worker back on
-- (day, category) first, or its upsert has no key to name (42P10, then it falls back by itself):
--   alter table public.twilio_usage_daily drop constraint if exists twilio_usage_daily_account_key;
--   delete from supabase_migrations.schema_migrations where version = '298';

begin;

set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.twilio_usage_daily') is null then
    raise exception '298: twilio_usage_daily is missing (migration 259 not applied?)';
  end if;
  if not exists (select 1 from information_schema.columns c where c.table_schema = 'public'
                   and c.table_name = 'twilio_usage_daily' and c.column_name = 'account_sid') then
    raise exception '298: twilio_usage_daily.account_sid is missing (migration 292 not applied?)';
  end if;
  if current_setting('server_version_num')::int < 150000 then
    raise exception '298: UNIQUE NULLS NOT DISTINCT needs Postgres 15 or later';
  end if;
end
$pre$;

create temp table m298_before on commit drop as select count(*)::bigint as n from public.twilio_usage_daily;

do $key$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.twilio_usage_daily'::regclass
                   and conname = 'twilio_usage_daily_account_key') then
    alter table public.twilio_usage_daily
      add constraint twilio_usage_daily_account_key unique nulls not distinct (day, account_sid, category);
  end if;
end
$key$;

comment on constraint twilio_usage_daily_account_key on public.twilio_usage_daily is
  'Migration 298: one row per day, account and category; account_sid NULL = the parent, and NULLS NOT DISTINCT so the parent''s NULL matches itself. The phone-api Worker upserts on it (day,account_sid,category). 299 drops the old (day, category) primary key once that Worker is live.';

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_cols text;
  v_pk   text;
  v_out  text;
  v_role text;
  v_priv text;
begin
  select string_agg(a.attname, ',' order by k.ord) into v_cols
    from pg_catalog.pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.twilio_usage_daily'::regclass and c.conname = 'twilio_usage_daily_account_key' and c.contype = 'u';
  if v_cols is distinct from 'day,account_sid,category' then
    raise exception '298: the account key should be unique (day, account_sid, category), is (%)', coalesce(v_cols, 'missing');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c join pg_catalog.pg_index i on i.indexrelid = c.conindid
                  where c.conrelid = 'public.twilio_usage_daily'::regclass and c.conname = 'twilio_usage_daily_account_key'
                    and i.indnullsnotdistinct) then
    raise exception '298: the account key must be NULLS NOT DISTINCT, or every day''s parent rows would be added again';
  end if;
  select string_agg(a.attname, ',' order by k.ord) into v_pk
    from pg_catalog.pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.twilio_usage_daily'::regclass and c.contype = 'p';
  if v_pk is distinct from 'day,category' then
    raise exception '298: the old primary key (day, category) must still be there until 299 (it is %)', coalesce(v_pk, 'gone');
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(v_role, 'public.twilio_usage_daily', v_priv) then
        raise exception '298: % holds % on twilio_usage_daily', v_role, v_priv;
      end if;
    end loop;
  end loop;
  if (select n from m298_before) <> (select count(*) from public.twilio_usage_daily) then
    raise exception '298: the row count moved during the apply — run it again';
  end if;

  -- ── The rehearsal: both upserts the Worker can send, then rolled back ──
  begin
    -- The new Worker's parent upsert: twice on (day, account_sid, category), ONE row (NULL matches NULL).
    insert into public.twilio_usage_daily (day, category, count) values ('1900-01-01', 'm298-probe', 1)
      on conflict (day, account_sid, category) do update set count = excluded.count;
    insert into public.twilio_usage_daily (day, category, count) values ('1900-01-01', 'm298-probe', 2)
      on conflict (day, account_sid, category) do update set count = excluded.count;
    if (select count(*) from public.twilio_usage_daily where day = '1900-01-01') <> 1
       or (select count from public.twilio_usage_daily where day = '1900-01-01') <> 2 then
      raise exception '298: the parent''s upsert on the new key added a second row instead of refreshing the first';
    end if;
    -- The old Worker's upsert still works on (day, category).
    insert into public.twilio_usage_daily (day, category, count) values ('1900-01-01', 'm298-probe', 3)
      on conflict (day, category) do update set count = excluded.count;
    -- A sub-account's row beside the parent's waits for 299: the old key refuses it.
    begin
      insert into public.twilio_usage_daily (day, account_sid, category, count) values ('1900-01-01', 'AC' || repeat('f', 32), 'm298-probe', 4)
        on conflict (day, account_sid, category) do update set count = excluded.count;
      raise exception '298: a sub-account row beside the parent''s was accepted while the old key is there';
    exception when unique_violation then null;
    end;
    raise exception using errcode = 'S2980', message = 'both upserts refresh one parent row; a sub row waits for 299';
  exception when sqlstate 'S2980' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.twilio_usage_daily where day = '1900-01-01') then
    raise exception '298: the rehearsal left a row behind';
  end if;
  perform set_config('ss.m298_rehearsal', v_out, true);
  raise notice '298: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- PASS: account_key 'day,account_sid,category', nulls_not_distinct true, usage_pk 'day,category'
-- (still), rows = the count before, rehearsal 'both upserts refresh one parent row; a sub row waits for 299'.
select
  '298' as migration,
  (select string_agg(a.attname, ',' order by k.ord)
     from pg_catalog.pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
     join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = 'public.twilio_usage_daily'::regclass and c.conname = 'twilio_usage_daily_account_key') as account_key,
  (select i.indnullsnotdistinct from pg_catalog.pg_constraint c join pg_catalog.pg_index i on i.indexrelid = c.conindid
    where c.conrelid = 'public.twilio_usage_daily'::regclass and c.conname = 'twilio_usage_daily_account_key') as nulls_not_distinct,
  (select string_agg(a.attname, ',' order by k.ord)
     from pg_catalog.pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
     join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = 'public.twilio_usage_daily'::regclass and c.contype = 'p') as usage_pk,
  (select count(*) from public.twilio_usage_daily)::int as rows,
  current_setting('ss.m298_rehearsal', true) as rehearsal;

commit;
