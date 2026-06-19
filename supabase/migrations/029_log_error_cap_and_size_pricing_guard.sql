-- 029: hardening + integrity, from the full-app audit. HAND-APPLY (recorded as version 029).
--   (a) Cap the anon-callable log_error context jsonb (storage-abuse guard).
--   (b) Idempotent depth_ft → length_ft rename so a from-scratch replay matches live
--       (the rename was originally done live via the dashboard, never encoded in a migration).
--   (c) Enforce the NULL-base-price contract (base_price IS NULL ⇒ not active/offered) on all
--       future writes via a trigger, instead of relying on one-time UPDATEs + app logic.

-- (a) ---------------------------------------------------------------------------------------
create or replace function public.log_error(
  p_source text, p_message text, p_code text default null,
  p_client_id text default null, p_url text default null, p_context jsonb default null
) returns void language plpgsql security definer set search_path = '' as $fn$
declare v_ua text;
begin
  begin v_ua := current_setting('request.headers', true)::json ->> 'user-agent';
  exception when others then v_ua := null; end;
  if p_context is not null and pg_column_size(p_context) > 8192 then
    p_context := jsonb_build_object('_truncated', true, 'bytes', pg_column_size(p_context));
  end if;
  insert into public.app_errors (client_id, source, severity, code, message, url, user_agent, context)
  values (
    nullif(left(p_client_id, 100), ''),
    left(coalesce(nullif(p_source, ''), 'unknown'), 100),
    'error',
    nullif(left(p_code, 100), ''),
    left(p_message, 4000),
    nullif(left(p_url, 600), ''),
    nullif(left(v_ua, 400), ''),
    p_context
  );
end;
$fn$;

-- (b) ---------------------------------------------------------------------------------------
do $do$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='building_sizes' and column_name='depth_ft')
     and not exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='building_sizes' and column_name='length_ft')
  then execute 'alter table public.building_sizes rename column depth_ft to length_ft'; end if;
end $do$;

-- (c) ---------------------------------------------------------------------------------------
create or replace function public.enforce_size_pricing() returns trigger language plpgsql set search_path = '' as $ef$
begin
  if new.base_price is null then new.active := false; end if;  -- unpriced sizes are never offered
  return new;
end;
$ef$;
drop trigger if exists building_sizes_enforce_pricing on public.building_sizes;
create trigger building_sizes_enforce_pricing
  before insert or update on public.building_sizes
  for each row execute function public.enforce_size_pricing();
