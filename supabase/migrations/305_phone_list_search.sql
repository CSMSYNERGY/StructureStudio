-- 305_phone_list_search.sql — the phone apps' searches keep what people type out of every URL:
--                             one service-role function the phone-api Worker calls by POST rpc.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('305', '305_phone_list_search') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run. To see the same row and
--    change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--    ⚠️ APPLY THIS BEFORE DEPLOYING THE phone-api WORKER THAT CALLS IT. That Worker reads every
--    search through this function and nothing else: without it POST /threads/search, POST
--    /calls/search and GET /search (the keypad's and New message's contact search) answer 500.
--    The Worker deployed before it never calls this, so applying it first changes nothing.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Written 2026-10-13 on ss/c1012-integration, after 303 and 304 of the same branch (neither was
-- applied that day, and this file needs neither: 304's indexes only make it quicker). Take the
-- next free number from the live ledger, renaming this file, its test
-- (tests/sql/migration305.test.cjs) and every '305' below.
--
-- ── WHY (Limited Use, decided 2026-10-13) ────────────────────────────────────────────────
-- The Worker's list search (POST /threads/search, POST /calls/search) and its contact search
-- (GET /search) read with PostgREST GETs: `body=ilike.*lean-to*`, `crm_contacts.name=ilike.*jo*`,
-- `from_e164=like.*5550142*`. A GET's filters ride in its URL, and Supabase's API request logs
-- keep every URL, so what someone typed into a search box (words from their customers' texts,
-- names, numbers) landed in a log. The privacy-safe option, chosen over documenting it: the
-- Worker asks this function by POST rpc instead, so the term, its digits and the numbers a
-- search matched travel in the request BODY, which those logs don't keep. A search's URLs carry
-- only the tenant and row ids from here on (the contacts and calls it found, read back by id).
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
-- public.phone_list_search(...) → jsonb, always a JSON array, newest first. One p_kind per read
-- the Worker used to make with a GET, each EXACTLY that read (same table, filters, order and
-- limit), except as listed under "Differences" below:
--   'texts'            POST /threads/search's matching texts: sms_messages whose body holds
--                      p_term, or (p_digits) whose CUSTOMER number holds p_digits (from_number of
--                      a text in, to_number of a text out). p_limit newest.
--                      → {id, contact_id, direction, body, created_at, from_number, to_number}
--   'contacts'         its matching contacts: crm_contacts not merged away whose name holds
--                      p_term, or whose phone_digits hold p_digits, or (a typed country code)
--                      start with p_digits less its leading 1. p_limit most recently updated. → {id}
--   'conversations'    its walk over what it found: the texts of the contacts in p_ids, and of the
--                      unknown numbers in p_numbers (no contact, the number on either side), below
--                      p_before and/or at or after p_after. p_limit newest.
--                      → {id, contact_id, direction, body, status, created_at, from_number, to_number, sent_by}
--   'calls'            POST /calls/search, its reads in one: phone_calls matching by the
--                      contact's name (only with p_customers), the customer's number (p_digits:
--                      from_e164 of a call in, to_e164 of a call out) or the transcript of a
--                      voicemail that isn't deleted; with p_voicemail only calls that have such a
--                      voicemail; with p_user_id only that person's My calls, as GET /calls reads
--                      My (placed, answered, handed on or rung for; or, with p_customers,
--                      missed / voicemail / ringing on a customer they own); below p_before.
--                      p_limit newest. → {id, started_at}
--   'directory'        GET /search: crm_contacts not merged away whose name holds p_term or whose
--                      phone_digits hold p_digits. p_limit most recently updated.
--   'directory_email'  GET /search&email=1's second read: whose email_lower holds p_term.
--                      both → {id, name, phone, phone_digits, email}
-- Differences from the GETs, all on purpose:
--   * The term is matched as itself: `%`, `_` and `\` are escaped (with PostgREST `_` was any one
--     character). Under 2 characters, or none, matches nothing by words (never "everything").
--   * Every row is p_client_id's, joins included: a call's contact and voicemail must be the same
--     tenant's too (PostgREST joined them by key alone).
--   * Ties in time are broken by id, so a page comes back in the same order every time.
-- The SQL of each call is put together from fixed pieces only (the branches that call uses), and
-- every value goes in as a parameter (EXECUTE ... USING): nothing anyone typed is ever part of the
-- SQL text. EXECUTE also plans each call with its values, so 304's trigram indexes serve `ilike`
-- as they served PostgREST's.
-- What a person may see (the contacts row scope, the phone level, unknown numbers, My) is still
-- decided by the Worker after this answers (visibleContactIds, scopeCalls, isMineCall), as before:
-- this function only finds candidates, inside one tenant.
--
-- SECURITY DEFINER with an empty search_path (every name qualified). EXECUTE for service_role
-- ONLY: Postgres grants EXECUTE on a new function to PUBLIC, and Supabase's default privileges
-- grant it to anon and authenticated, so all three are revoked. A browser session can never call
-- it; the Worker calls it with the service key.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- One new function and its grants: no table, column, row, index or policy changes, and nothing
-- calls it until the Worker that does is deployed. No lock beyond the catalog's.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
-- Roll the phone-api Worker back to a build that doesn't call it FIRST (otherwise every search,
-- and the keypad's contact search, fails). Then:
-- REVERSE-SQL-BEGIN
-- drop function if exists public.phone_list_search(text, text, text, text, timestamptz, timestamptz, integer, boolean, uuid, boolean, uuid[], text[]);
-- delete from supabase_migrations.schema_migrations where version = '305';
-- notify pgrst, 'reload schema';
-- REVERSE-SQL-END

begin;

set local lock_timeout = '5s';

-- Every column the function reads, on the tables it reads. plpgsql never checks a dynamic query
-- until it runs, so a missing one would otherwise surface as a failed search, not a failed apply.
do $pre$
declare
  v_need text[][] := array[
    ['sms_messages',     'id'], ['sms_messages', 'client_id'], ['sms_messages', 'contact_id'], ['sms_messages', 'direction'],
    ['sms_messages',     'body'], ['sms_messages', 'status'], ['sms_messages', 'created_at'], ['sms_messages', 'from_number'],
    ['sms_messages',     'to_number'], ['sms_messages', 'sent_by'],
    ['crm_contacts',     'id'], ['crm_contacts', 'client_id'], ['crm_contacts', 'name'], ['crm_contacts', 'phone'],
    ['crm_contacts',     'phone_digits'], ['crm_contacts', 'email'], ['crm_contacts', 'email_lower'], ['crm_contacts', 'merged_into'],
    ['crm_contacts',     'owner_user_id'], ['crm_contacts', 'updated_at'],
    ['phone_calls',      'id'], ['phone_calls', 'client_id'], ['phone_calls', 'contact_id'], ['phone_calls', 'direction'],
    ['phone_calls',      'from_e164'], ['phone_calls', 'to_e164'], ['phone_calls', 'started_at'], ['phone_calls', 'status'],
    ['phone_calls',      'placed_by'], ['phone_calls', 'answered_by'], ['phone_calls', 'transferred_from'], ['phone_calls', 'rang_user_ids'],
    ['phone_voicemails', 'id'], ['phone_voicemails', 'call_id'], ['phone_voicemails', 'client_id'], ['phone_voicemails', 'transcript'],
    ['phone_voicemails', 'deleted_at']];
  i int;
begin
  for i in 1 .. array_length(v_need, 1) loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = v_need[i][1] and c.column_name = v_need[i][2]) then
      raise exception '305: public.%.% is missing (migrations 130, 150 and 254 not applied?)', v_need[i][1], v_need[i][2];
    end if;
  end loop;
end
$pre$;

create or replace function public.phone_list_search(
  p_client_id text,
  p_kind      text,
  p_term      text        default null,
  p_digits    text        default null,
  p_before    timestamptz default null,
  p_after     timestamptz default null,
  p_limit     integer     default 50,
  p_voicemail boolean     default false,
  p_user_id   uuid        default null,
  p_customers boolean     default true,
  p_ids       uuid[]      default null,
  p_numbers   text[]      default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  -- The backslash: LIKE's escape character (Postgres's default; patterns below rely on it).
  v_bs     constant text := chr(92);
  v_term   text := btrim(coalesce(p_term, ''));
  v_digits text := case when p_digits ~ '^[0-9]{3,60}$' then p_digits end;
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_ids    uuid[] := array(select distinct x from unnest(coalesce(p_ids, '{}'::uuid[])) x where x is not null);
  v_nums   text[] := array(select distinct x from unnest(coalesce(p_numbers, '{}'::text[])) x where coalesce(x, '') <> '');
  v_like   text;   -- $2: the term, escaped, anywhere in the text
  v_dlike  text;   -- $3: the digits anywhere in a number
  v_cclike text;   -- $5: the digits less a typed country code, at the start of ten digits
  v_or     text[] := '{}';
  v_where  text := '';
  v_sql    text;
  v_out    jsonb;
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'phone_list_search: a tenant is required' using errcode = '22004';
  end if;
  if char_length(v_term) >= 2 then
    v_like := '%' || replace(replace(replace(left(v_term, 60), v_bs, v_bs || v_bs), '%', v_bs || '%'), '_', v_bs || '_') || '%';
  end if;
  if v_digits is not null then
    v_dlike := '%' || v_digits || '%';
    if left(v_digits, 1) = '1' then v_cclike := substr(v_digits, 2) || '%'; end if;
  end if;

  if p_kind = 'texts' then
    if v_like is not null then v_or := array_append(v_or, 'm.body ilike $2'); end if;
    if v_dlike is not null then
      v_or := array_append(v_or, $q$(m.direction = 'in' and m.from_number like $3)$q$);
      v_or := array_append(v_or, $q$(m.direction = 'out' and m.to_number like $3)$q$);
    end if;
    v_sql := $q$
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'contact_id', t.contact_id, 'direction', t.direction,
               'body', t.body, 'created_at', t.created_at, 'from_number', t.from_number, 'to_number', t.to_number)
               order by t.created_at desc, t.id desc), '[]'::jsonb)
        from (select m.id, m.contact_id, m.direction, m.body, m.created_at, m.from_number, m.to_number
                from public.sms_messages m
               where m.client_id = $1 and (%s)%s
               order by m.created_at desc, m.id desc
               limit $4) t$q$;

  elsif p_kind = 'contacts' then
    if v_like is not null then v_or := array_append(v_or, 'k.name ilike $2'); end if;
    if v_dlike is not null then v_or := array_append(v_or, 'k.phone_digits like $3'); end if;
    if v_cclike is not null then v_or := array_append(v_or, 'k.phone_digits like $5'); end if;
    v_sql := $q$
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id) order by t.updated_at desc, t.id desc), '[]'::jsonb)
        from (select k.id, k.updated_at
                from public.crm_contacts k
               where k.client_id = $1 and k.merged_into is null and (%s)%s
               order by k.updated_at desc, k.id desc
               limit $4) t$q$;

  elsif p_kind = 'conversations' then
    if cardinality(v_ids) > 0 then v_or := array_append(v_or, 'm.contact_id = any($6)'); end if;
    if cardinality(v_nums) > 0 then
      v_or := array_append(v_or, '(m.contact_id is null and (m.from_number = any($7) or m.to_number = any($7)))');
    end if;
    if p_before is not null then v_where := v_where || ' and m.created_at < $8'; end if;
    if p_after is not null then v_where := v_where || ' and m.created_at >= $9'; end if;
    v_sql := $q$
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'contact_id', t.contact_id, 'direction', t.direction,
               'body', t.body, 'status', t.status, 'created_at', t.created_at, 'from_number', t.from_number,
               'to_number', t.to_number, 'sent_by', t.sent_by)
               order by t.created_at desc, t.id desc), '[]'::jsonb)
        from (select m.id, m.contact_id, m.direction, m.body, m.status, m.created_at, m.from_number, m.to_number, m.sent_by
                from public.sms_messages m
               where m.client_id = $1 and (%s)%s
               order by m.created_at desc, m.id desc
               limit $4) t$q$;

  elsif p_kind = 'calls' then
    if v_like is not null and coalesce(p_customers, false) then v_or := array_append(v_or, 'k.name ilike $2'); end if;
    if v_dlike is not null then
      v_or := array_append(v_or, $q$(c.direction = 'in' and c.from_e164 like $3)$q$);
      v_or := array_append(v_or, $q$(c.direction = 'out' and c.to_e164 like $3)$q$);
    end if;
    if v_like is not null then v_or := array_append(v_or, 'v.transcript ilike $2'); end if;
    if coalesce(p_voicemail, false) then v_where := v_where || ' and v.id is not null'; end if;
    if p_before is not null then v_where := v_where || ' and c.started_at < $8'; end if;
    if p_user_id is not null then
      v_where := v_where || ' and (c.placed_by = $10 or c.answered_by = $10 or c.transferred_from = $10 or c.rang_user_ids @> array[$10]'
        || case when coalesce(p_customers, false)
                then $q$ or (k.owner_user_id = $10 and c.status in ('missed', 'voicemail', 'ringing'))$q$ else '' end
        || ')';
    end if;
    v_sql := $q$
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'started_at', t.started_at)
               order by t.started_at desc, t.id desc), '[]'::jsonb)
        from (select c.id, c.started_at
                from public.phone_calls c
                left join public.crm_contacts k on k.id = c.contact_id and k.client_id = c.client_id
                left join public.phone_voicemails v on v.call_id = c.id and v.client_id = c.client_id and v.deleted_at is null
               where c.client_id = $1 and (%s)%s
               order by c.started_at desc, c.id desc
               limit $4) t$q$;

  elsif p_kind in ('directory', 'directory_email') then
    if p_kind = 'directory' then
      if v_like is not null then v_or := array_append(v_or, 'k.name ilike $2'); end if;
      if v_dlike is not null then v_or := array_append(v_or, 'k.phone_digits like $3'); end if;
    elsif v_like is not null then
      v_or := array_append(v_or, 'k.email_lower ilike $2');
    end if;
    v_sql := $q$
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'phone', t.phone,
               'phone_digits', t.phone_digits, 'email', t.email)
               order by t.updated_at desc, t.id desc), '[]'::jsonb)
        from (select k.id, k.name, k.phone, k.phone_digits, k.email, k.updated_at
                from public.crm_contacts k
               where k.client_id = $1 and k.merged_into is null and (%s)%s
               order by k.updated_at desc, k.id desc
               limit $4) t$q$;

  else
    raise exception 'phone_list_search: unknown kind %', coalesce(p_kind, '(none)') using errcode = '22023';
  end if;

  -- Nothing to match by: nothing found (never every row of the tenant).
  if cardinality(v_or) = 0 then
    return '[]'::jsonb;
  end if;
  execute format(v_sql, array_to_string(v_or, ' or '), v_where)
     into v_out
    using p_client_id, v_like, v_dlike, v_limit, v_cclike, v_ids, v_nums, p_before, p_after, p_user_id;
  return coalesce(v_out, '[]'::jsonb);
end
$fn$;

comment on function public.phone_list_search(text, text, text, text, timestamptz, timestamptz, integer, boolean, uuid, boolean, uuid[], text[]) is
  'Migration 305: the phone-api Worker''s searches (POST /threads/search, POST /calls/search, GET /search), called by POST rpc so what people type never rides in a URL (Supabase''s API logs keep URLs). Finds candidates inside one tenant; the Worker applies the contacts scope and the phone level after. service_role only.';

revoke all on function public.phone_list_search(text, text, text, text, timestamptz, timestamptz, integer, boolean, uuid, boolean, uuid[], text[]) from public, anon, authenticated;
grant execute on function public.phone_list_search(text, text, text, text, timestamptz, timestamptz, integer, boolean, uuid, boolean, uuid[], text[]) to service_role;

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
-- The function: security definer, empty search_path, executable by service_role and by nobody
-- else. Then every kind and every branch run once for a made-up tenant with no rows ('m305-probe'),
-- which parses each query against the live columns and must find nothing; a blank tenant and an
-- unknown kind are refused. No row of any table is written.
do $check$
declare
  v_fn    regprocedure := 'public.phone_list_search(text, text, text, text, timestamptz, timestamptz, integer, boolean, uuid, boolean, uuid[], text[])'::regprocedure;
  v_role  text;
  v_probe constant text := 'm305-probe';
  v_some  constant uuid := '00000000-0000-4000-8000-000000000305';
  v_n     int := 0;
  v_got   jsonb;
  v_case  record;
begin
  if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn) then
    raise exception '305: phone_list_search should be SECURITY DEFINER';
  end if;
  if not coalesce((select 'search_path=""' = any(p.proconfig) from pg_catalog.pg_proc p where p.oid = v_fn), false) then
    raise exception '305: phone_list_search should run with an empty search_path';
  end if;
  foreach v_role in array array['public', 'anon', 'authenticated'] loop
    if pg_catalog.has_function_privilege(v_role, v_fn, 'execute') then
      raise exception '305: % can execute phone_list_search (it is service_role only)', v_role;
    end if;
  end loop;
  if not pg_catalog.has_function_privilege('service_role', v_fn, 'execute') then
    raise exception '305: service_role cannot execute phone_list_search';
  end if;

  for v_case in
    select * from (values
      ('texts',           'm305 probe', '15550305', null::timestamptz, null::timestamptz, false, null::uuid, null::uuid[], null::text[]),
      ('contacts',        'm305 probe', '15550305', null, null, false, null, null, null),
      ('conversations',   null,         null,       now(), now() - interval '1 day', false, null, array[v_some], array['+15555550305']),
      ('calls',           'm305 probe', '15550305', now(), null, true, v_some, null, null),
      ('calls',           'm305 probe', null,       null,  null, false, null, null, null),
      ('directory',       'm305 probe', '5550305',  null,  null, false, null, null, null),
      ('directory_email', 'm305@probe', null,       null,  null, false, null, null, null)
    ) as x(kind, term, digits, before_at, after_at, voicemail, user_id, ids, nums)
  loop
    v_got := public.phone_list_search(v_probe, v_case.kind, v_case.term, v_case.digits, v_case.before_at, v_case.after_at,
                                      50, v_case.voicemail, v_case.user_id, true, v_case.ids, v_case.nums);
    if v_got is distinct from '[]'::jsonb then
      raise exception '305: the probe tenant found something for kind % (%)', v_case.kind, left(v_got::text, 80);
    end if;
    v_n := v_n + 1;
  end loop;

  begin
    perform public.phone_list_search(' ', 'texts', 'm305 probe');
    raise exception '305: a blank tenant was not refused';
  exception when sqlstate '22004' then null;
  end;
  begin
    perform public.phone_list_search(v_probe, 'everything', 'm305 probe');
    raise exception '305: an unknown kind was not refused';
  exception when sqlstate '22023' then null;
  end;

  perform set_config('ss.m305_probes', v_n::text, true);
  raise notice '305: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- PASS: security_definer true, empty_search_path true, public / anon / authenticated execute all
-- false, service_role_execute true, probes 7.
select
  '305' as migration,
  p.oid::regprocedure::text as function,
  p.prosecdef as security_definer,
  coalesce('search_path=""' = any(p.proconfig), false) as empty_search_path,
  pg_catalog.has_function_privilege('public', p.oid, 'execute') as public_execute,
  pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon_execute,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
  pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_role_execute,
  current_setting('ss.m305_probes', true) as probes
from pg_catalog.pg_proc p
where p.oid = 'public.phone_list_search(text, text, text, text, timestamptz, timestamptz, integer, boolean, uuid, boolean, uuid[], text[])'::regprocedure;

commit;
