-- 321_tenant_purge.sql — deleting a builder removes all of their data in ONE transaction, except
-- the records kept on purpose, and their id can never be used again (Track G part 2, 2026-10-21).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE the admin-catalog deploy that calls it (the new
--    delete_client asks tenant_purge for a dry run first and refuses, with nothing deleted, while the
--    function is missing). Run it with `supabase db query --linked --file 321_tenant_purge.sql`, then
--    record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('321', '321_tenant_purge') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints only the last statement's rows: THE RECORD
--    at the end is what the apply shows. No row printed means the file did not run. To see the same
--    row and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-21: 320 is the newest. Take the next free number at apply time, renaming this
-- file, its test (tests/sql/migration321.test.cjs) and every '321' below; record the ledger row with
-- `returning`: no row back means the number was taken.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn's board item "delete_client leaves 7 per-tenant tables behind, including crm_contacts"
-- (10-19, due 10-31). 105 public tables carry client_id and none has a foreign key to the tenant row,
-- so a builder's rows went only if delete_client named their table, one PostgREST delete at a time
-- with no transaction. Part 1 (10-21) gave every table a fate in _shared/tenantTables.ts and made the
-- delete report what it left. Ahsan's retention answers (10-21): customer data is EXPORTED, THEN
-- DELETED; money and signed records are KEPT FOREVER; SMS consent and opt-out logs are kept; a
-- deleted builder's id is blocked FOREVER (the kept rows still carry it, so a new builder on that id
-- would see them through RLS); nothing on our parent Twilio account is released automatically.
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   PART 1   public.deleted_clients: one row per deleted builder id (when, by whom, what was kept and
--            what was purged). create_client refuses an id that is here. Service role reads it; only
--            tenant_purge writes it. No browser role can touch it.
--   PART 2   public.tenant_purge(p_client_id, p_keep, p_actor, p_dry_run) returns jsonb. SECURITY
--            DEFINER, service role only. Deletes the builder's rows from EVERY public table with a
--            client_id column except the ones named in p_keep (deny by default: a table nobody
--            classified is purged, not kept; preflight's coverage test stops that from happening by
--            accident). One transaction: a delete a foreign key refuses is undone by its own
--            savepoint and tried again on the next pass; if a whole pass gets nowhere, the function
--            raises and NOTHING is deleted. Writes the tombstone in the same transaction.
--            p_dry_run = true counts what it would delete and keep, and deletes nothing.
--            Refuses: an id that is not a builder id, CSM Synergy's own two accounts
--            (structure-studio, support-demo), an empty keep list, and a kept name that is not a
--            tenant table here (a typo or a rename would otherwise purge the real table).
--   PART 3   the tenant-exports bucket (private, zip only, no policies: service role only). The new
--            delete_client writes the builder's customer data there as one ZIP BEFORE anything is
--            deleted, and hands the operator a signed link.
--   PART 4   apply-time assertions (they RAISE and abort the transaction).
--   THE RECORD
--
-- ROLLBACK (after admin-catalog is reverted to a version that does not call tenant_purge):
--   drop function if exists public.tenant_purge(text, text[], text, boolean);
--   drop table if exists public.deleted_clients;     -- the tombstones: copy them out first
--   and the bucket from the dashboard, once it is empty.

begin;

set local lock_timeout = '5s';

-- ── PART 1 ─ the tombstone ──────────────────────────────────────────────────────────────────
create table if not exists public.deleted_clients (
  client_id  text primary key check (client_id ~ '^[a-z0-9][a-z0-9-]*$'),
  deleted_at timestamptz not null default now(),
  deleted_by text,
  -- Rows kept on purpose, by table ({"orders": 2}); rows purged, by table. Counts only.
  kept       jsonb not null default '{}'::jsonb,
  purged     jsonb not null default '{}'::jsonb
);
alter table public.deleted_clients enable row level security;
revoke all on table public.deleted_clients from public, anon, authenticated;
grant select on table public.deleted_clients to service_role;

-- ── PART 2 ─ the purge ──────────────────────────────────────────────────────────────────────
create or replace function public.tenant_purge(
  p_client_id text,
  p_keep      text[],
  p_actor     text default null,
  p_dry_run   boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- CSM Synergy's own accounts. Never purged, whoever asks.
  v_protected constant text[] := array['structure-studio', 'support-demo'];
  v_tables   text[];
  v_bad      text[];
  v_left     text[];
  v_blocked  text[];
  v_purged   jsonb := '{}'::jsonb;
  v_kept     jsonb := '{}'::jsonb;
  v_t        text;
  v_n        bigint;
  v_pass     int := 0;
  v_progress boolean;
begin
  if p_client_id is null or p_client_id !~ '^[a-z0-9][a-z0-9-]*$' then
    raise exception 'tenant_purge: "%" is not a builder id', coalesce(p_client_id, 'null') using errcode = '22023';
  end if;
  if p_client_id = any (v_protected) then
    raise exception 'tenant_purge: % is one of CSM Synergy''s own accounts and is never purged', p_client_id using errcode = '42501';
  end if;
  if p_keep is null or cardinality(p_keep) = 0 then
    raise exception 'tenant_purge: the keep list is empty; refusing to purge every table' using errcode = '22023';
  end if;

  -- Every public base table with a client_id column, read from the catalog at call time.
  select coalesce(array_agg(c.relname::text order by c.relname::text), '{}') into v_tables
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'client_id' and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'public' and c.relkind in ('r', 'p');

  -- A kept name that is not a tenant table here is a typo or a rename, and the real table would be
  -- purged under its new name. Refuse.
  select coalesce(array_agg(k order by k), '{}') into v_bad
    from unnest(p_keep) k where k is null or k <> all (v_tables);
  if cardinality(v_bad) > 0 then
    raise exception 'tenant_purge: kept table(s) % are not tenant tables in this database; refusing', v_bad using errcode = '22023';
  end if;

  foreach v_t in array p_keep loop
    execute format('select count(*) from public.%I where client_id = $1', v_t) into v_n using p_client_id;
    if v_n > 0 then v_kept := v_kept || jsonb_build_object(v_t, v_n); end if;
  end loop;

  -- The tombstone is never purged, whatever the keep list says.
  v_left := array(select t from unnest(v_tables) t where t <> all (p_keep) and t <> 'deleted_clients' order by t);

  if p_dry_run then
    foreach v_t in array v_left loop
      execute format('select count(*) from public.%I where client_id = $1', v_t) into v_n using p_client_id;
      if v_n > 0 then v_purged := v_purged || jsonb_build_object(v_t, v_n); end if;
    end loop;
    return jsonb_build_object(
      'dryRun', true, 'clientId', p_client_id, 'purge', v_purged, 'kept', v_kept,
      'tombstoned', exists (select 1 from public.deleted_clients d where d.client_id = p_client_id));
  end if;

  -- Passes. A delete that a foreign key refuses (a NO ACTION or RESTRICT reference from a row not
  -- deleted yet, or a SET NULL that would empty a NOT NULL column) is undone by its own savepoint
  -- and tried again on the next pass, once the referencing rows are gone. A pass that deletes from
  -- no table at all means a reference that never goes away (from a KEPT table, or a cycle): the
  -- whole purge raises, and nothing is deleted.
  loop
    v_pass := v_pass + 1;
    v_progress := false;
    v_blocked := '{}';
    foreach v_t in array v_left loop
      begin
        execute format('delete from public.%I where client_id = $1', v_t) using p_client_id;
        get diagnostics v_n = row_count;
        if v_n > 0 then
          v_purged := v_purged || jsonb_build_object(v_t, coalesce((v_purged ->> v_t)::bigint, 0) + v_n);
        end if;
        v_progress := true;
      exception when foreign_key_violation or restrict_violation or not_null_violation then
        v_blocked := v_blocked || v_t;
      end;
    end loop;
    v_left := v_blocked;
    exit when cardinality(v_left) = 0;
    if not v_progress or v_pass >= 25 then
      raise exception 'tenant_purge: % was not purged (nothing deleted): still referenced from %', p_client_id, v_left
        using errcode = '23503';
    end if;
  end loop;

  insert into public.deleted_clients as d (client_id, deleted_by, kept, purged)
  values (p_client_id, left(p_actor, 200), v_kept, v_purged)
  on conflict (client_id) do update
    set deleted_at = now(), deleted_by = excluded.deleted_by, kept = excluded.kept,
        purged = d.purged || excluded.purged;

  return jsonb_build_object('dryRun', false, 'clientId', p_client_id, 'purged', v_purged, 'kept', v_kept, 'passes', v_pass);
end
$fn$;

revoke all on function public.tenant_purge(text, text[], text, boolean) from public, anon, authenticated;
grant execute on function public.tenant_purge(text, text[], text, boolean) to service_role;

-- ── PART 3 ─ where the export goes ──────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-exports', 'tenant-exports', false, 104857600, array['application/zip'])
on conflict (id) do update
  set public = false, file_size_limit = 104857600, allowed_mime_types = array['application/zip'];

-- ── PART 4 ─ apply-time assertions ──────────────────────────────────────────────────────────
do $check$
declare
  v_r jsonb;
begin
  if not exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'deleted_clients' and c.relrowsecurity) then
    raise exception '321: public.deleted_clients is missing or has RLS off';
  end if;
  if has_table_privilege('anon', 'public.deleted_clients', 'select')
     or has_table_privilege('authenticated', 'public.deleted_clients', 'select')
     or has_table_privilege('authenticated', 'public.deleted_clients', 'insert') then
    raise exception '321: a browser role can read or write deleted_clients';
  end if;
  if not has_table_privilege('service_role', 'public.deleted_clients', 'select') then
    raise exception '321: service_role cannot read deleted_clients (create_client checks it)';
  end if;
  if has_function_privilege('anon', 'public.tenant_purge(text, text[], text, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.tenant_purge(text, text[], text, boolean)', 'execute') then
    raise exception '321: a browser role can execute tenant_purge';
  end if;
  if not has_function_privilege('service_role', 'public.tenant_purge(text, text[], text, boolean)', 'execute') then
    raise exception '321: service_role cannot execute tenant_purge';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'public.tenant_purge(text, text[], text, boolean)'::regprocedure
                  and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=%') then
    raise exception '321: tenant_purge is not SECURITY DEFINER with a fixed search_path';
  end if;
  if not exists (select 1 from storage.buckets where id = 'tenant-exports' and not public) then
    raise exception '321: the tenant-exports bucket is missing or public';
  end if;

  -- The function itself, inside this transaction: a dry run of an id nobody has finds nothing,
  -- and the refusals refuse.
  v_r := public.tenant_purge('zz-apply-check-321', array['orders', 'payments'], 'apply-check', true);
  if v_r -> 'purge' <> '{}'::jsonb or v_r -> 'kept' <> '{}'::jsonb or (v_r ->> 'dryRun')::boolean is not true then
    raise exception '321: a dry run of an unused id found rows: %', v_r;
  end if;
  begin
    perform public.tenant_purge('structure-studio', array['orders'], 'apply-check', true);
    raise exception '321: tenant_purge did not refuse structure-studio';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.tenant_purge('zz-apply-check-321', array['not_a_tenant_table'], 'apply-check', true);
    raise exception '321: tenant_purge accepted a kept name that is not a tenant table';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.tenant_purge('zz-apply-check-321', array[]::text[], 'apply-check', true);
    raise exception '321: tenant_purge accepted an empty keep list';
  exception when invalid_parameter_value then null;
  end;
  raise notice '321: tenant_purge, deleted_clients and tenant-exports in place';
end
$check$;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect on a first apply: true, 0, true, true, <number of public tables with client_id>.
-- ═════════════════════════════════════════════════════════════════════════════════════════
select to_regclass('public.deleted_clients') is not null as tombstone_ready,
       (select count(*) from public.deleted_clients) as tombstones,
       to_regprocedure('public.tenant_purge(text, text[], text, boolean)') is not null as purge_ready,
       exists (select 1 from storage.buckets where id = 'tenant-exports' and not public) as export_bucket_private,
       (select count(*) from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and c.column_name = 'client_id' and t.table_type = 'BASE TABLE') as tenant_tables;

commit;
