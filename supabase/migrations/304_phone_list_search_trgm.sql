-- 304_phone_list_search_trgm.sql — the phone apps' list search stays quick as texts and
--                                  voicemails pile up: trigram indexes for `ilike '%…%'`.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('304', '304_phone_list_search_trgm') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run. To see the same row and
--    change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Written 2026-10-13 on ss/c1012-u8-phone-search-server, beside 303 on ss/c1012-u4-crm-data
-- (neither needs the other). Take the next free number from the live ledger, renaming this file,
-- its test (tests/sql/migration304.test.cjs) and every '304' below.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Asked for 2026-10-12: Messages searched "by anything in the message ... the names of the
-- person, or the phone number", the same on Voicemail, and it has to keep up as the texts grow.
-- The phone-api Worker's POST /threads/search and POST /calls/search (and the older GET /search)
-- ask with `ilike '%term%'` on:
--   sms_messages.body             every text of the business, not only the newest
--   phone_voicemails.transcript   what a caller said (once voicemail transcription is on)
--   crm_contacts.name             the person's name
-- A b-tree cannot serve a pattern that starts with a wildcard, so each of those reads every row
-- of the business. A GIN index with pg_trgm's gin_trgm_ops can: Postgres finds the rows holding
-- the term's three-letter pieces and checks only those. (A 2-character term has no three-letter
-- piece and still reads every row; numbers are matched on the business's calls and texts by the
-- other filters on those reads, and are not indexed here.)
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Indexes only: no table, column, row, grant, policy or function changes. The Worker names no
-- index, so it answers the same before and after this, and the two can ship in either order.
-- Each CREATE INDEX holds a SHARE lock on its table while it builds: reads go on, writes (a text
-- arriving, a call being logged) wait for the build, which on tables of this size is moments.
-- lock_timeout 5 s: if a long write holds a table, the whole file fails and changes nothing; run
-- it again.
-- pg_trgm ships with Supabase. It is created in `extensions` (where Supabase keeps them, as 256
-- did pg_net) unless it is already installed elsewhere, and the operator class is looked up in
-- whichever schema holds it, so an earlier install is used as it is.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   drop index if exists public.sms_messages_body_trgm;
--   drop index if exists public.phone_voicemails_transcript_trgm;
--   drop index if exists public.crm_contacts_name_trgm;
--   delete from supabase_migrations.schema_migrations where version = '304';
--   (pg_trgm itself stays: harmless, and something else may use it by then.)

begin;

set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.sms_messages') is null or to_regclass('public.crm_contacts') is null then
    raise exception '304: sms_messages or crm_contacts is missing (migrations 130 and 150 not applied?)';
  end if;
  if not exists (select 1 from information_schema.columns c where c.table_schema = 'public'
                   and c.table_name = 'phone_voicemails' and c.column_name = 'transcript') then
    raise exception '304: phone_voicemails.transcript is missing (migration 254 not applied?)';
  end if;
end
$pre$;

create extension if not exists pg_trgm with schema extensions;

do $idx$
declare
  v_ops text;
begin
  select format('%I.gin_trgm_ops', n.nspname) into v_ops
    from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_trgm';
  execute format('create index if not exists sms_messages_body_trgm on public.sms_messages using gin (body %s)', v_ops);
  execute format('create index if not exists phone_voicemails_transcript_trgm on public.phone_voicemails using gin (transcript %s)', v_ops);
  execute format('create index if not exists crm_contacts_name_trgm on public.crm_contacts using gin (name %s)', v_ops);
end
$idx$;

comment on index public.sms_messages_body_trgm is
  'Migration 304: the phone apps'' Messages search (phone-api POST /threads/search, body ilike ''%term%'') finds the texts holding a term without reading every text of the business.';
comment on index public.phone_voicemails_transcript_trgm is
  'Migration 304: the Voicemail and Recents search (phone-api POST /calls/search, transcript ilike ''%term%'').';
comment on index public.crm_contacts_name_trgm is
  'Migration 304: a person found by any part of their name (phone-api list search and GET /search, name ilike ''%term%'').';

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
-- Each index: on its table, on its one column, GIN, with pg_trgm's operator class, and valid.
-- Then whether the planner WOULD use it for the search's shape (sequential scans off, as on a
-- table big enough for the index to win): reported in the record, not raised, because a plan is
-- the planner's choice on the day, not a fault in this file.
do $check$
declare
  v_want  text[][] := array[
    ['sms_messages_body_trgm',           'sms_messages',     'body'],
    ['phone_voicemails_transcript_trgm', 'phone_voicemails', 'transcript'],
    ['crm_contacts_name_trgm',           'crm_contacts',     'name']];
  i       int;
  v_ok    boolean;
  v_line  text;
  v_plan  text;
  v_uses  text[] := '{}';
begin
  for i in 1 .. array_length(v_want, 1) loop
    select exists (
      select 1
        from pg_catalog.pg_index x
        join pg_catalog.pg_class ic on ic.oid = x.indexrelid
        join pg_catalog.pg_class tc on tc.oid = x.indrelid
        join pg_catalog.pg_namespace tn on tn.oid = tc.relnamespace
        join pg_catalog.pg_am am on am.oid = ic.relam
        join pg_catalog.pg_attribute a on a.attrelid = tc.oid and a.attnum = x.indkey[0]
        join pg_catalog.pg_opclass oc on oc.oid = x.indclass[0]
       where ic.relname = v_want[i][1] and tn.nspname = 'public' and tc.relname = v_want[i][2]
         and x.indnatts = 1 and a.attname = v_want[i][3]
         and am.amname = 'gin' and oc.opcname = 'gin_trgm_ops'
         and x.indisvalid and x.indpred is null
    ) into v_ok;
    if not v_ok then
      raise exception '304: % should be a valid GIN (gin_trgm_ops) index on public.%(%)', v_want[i][1], v_want[i][2], v_want[i][3];
    end if;
  end loop;

  perform set_config('enable_seqscan', 'off', true);
  for i in 1 .. array_length(v_want, 1) loop
    v_plan := '';
    for v_line in execute format('explain select 1 from public.%I where %I ilike %L', v_want[i][2], v_want[i][3], '%m304 probe%') loop
      v_plan := v_plan || v_line || E'\n';
    end loop;
    if position(v_want[i][1] in v_plan) > 0 then v_uses := v_uses || v_want[i][1]; end if;
  end loop;
  perform set_config('enable_seqscan', 'on', true);
  perform set_config('ss.m304_planner_uses', array_to_string(v_uses, ','), true);
  raise notice '304: checks hold';
end
$check$;

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- PASS: indexes 'crm_contacts_name_trgm,phone_voicemails_transcript_trgm,sms_messages_body_trgm',
-- trgm_schema 'extensions' (or wherever pg_trgm already was), and planner_uses naming the same
-- three (fewer is not a failure; see the checks).
select
  '304' as migration,
  (select string_agg(ic.relname, ',' order by ic.relname)
     from pg_catalog.pg_index x
     join pg_catalog.pg_class ic on ic.oid = x.indexrelid
     join pg_catalog.pg_opclass oc on oc.oid = x.indclass[0]
    where ic.relname in ('sms_messages_body_trgm', 'phone_voicemails_transcript_trgm', 'crm_contacts_name_trgm')
      and oc.opcname = 'gin_trgm_ops' and x.indisvalid) as indexes,
  (select n.nspname from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm')::text as trgm_schema,
  current_setting('ss.m304_planner_uses', true) as planner_uses;

commit;
