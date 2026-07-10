-- 043_log_error_tenant_guard: harden the anon-callable log_error RPC against the two
-- abuse vectors from the main-branch audit (F7 + F10). HAND-APPLY only (record as version 043).
--
-- Context: log_error() is SECURITY DEFINER and GRANTed to anon so the browser apps can report
-- errors. app_errors itself is locked to service-role reads; the RPC is the only anon write path.
-- 028 created it; 029 added the 8 KB context cap. This migration keeps all of that and adds:
--
--   (F7) The caller-supplied p_client_id was trusted verbatim. Anon callers have no session to
--        derive a tenant from, so anyone with the public anon key could attribute fabricated
--        error rows to ANY tenant (or stuff arbitrary text into client_id). Fix: keep client_id
--        only when it names a real tenant (same check save_design uses: exists in client_configs);
--        otherwise log the error UNATTRIBUTED (client_id NULL) rather than rejecting it.
--
--   (F10) There was no rate/volume limit, so an unauthenticated loop could grow app_errors (and
--        its three indexes) without bound. Fix: a global insert-rate guard — once the table has
--        already taken many rows in the last minute, silently skip the insert (logging is
--        fire-and-forget; never raise, so a legit caller is never broken). This bounds anon-driven
--        growth to ~the cap per minute regardless of how the attacker varies source/client_id.
--        It intentionally does NOT prune history; see the operator note at the bottom.
--
-- Idempotent: pure CREATE OR REPLACE of the function; safe to run more than once. Rollback =
-- re-apply the 029 body.

create or replace function public.log_error(
  p_source    text,
  p_message   text,
  p_code      text default null,
  p_client_id text default null,
  p_url       text default null,
  p_context   jsonb default null
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ua     text;
  v_client text;
  v_recent int;
begin
  begin
    v_ua := current_setting('request.headers', true)::json ->> 'user-agent';
  exception when others then
    v_ua := null;
  end;

  -- (F7) Never trust caller-supplied client_id: keep it only if it names a real tenant.
  v_client := nullif(left(p_client_id, 100), '');
  if v_client is not null
     and not exists (select 1 from public.client_configs c where c.client_id = v_client) then
    v_client := null;  -- unknown/forged tenant → log unattributed instead of mis-attributing
  end if;

  -- (F10) Global anon-write rate guard. Uses the created_at desc index for a cheap 1-minute
  -- range count. 1000/min is far above any legitimate combined app error volume; a flood is
  -- capped at ~that rate instead of unbounded. Drop silently — do not raise.
  select count(*) into v_recent
  from public.app_errors
  where created_at > now() - interval '1 minute';
  if v_recent >= 1000 then
    return;
  end if;

  -- (029) bound the context jsonb.
  if p_context is not null and pg_column_size(p_context) > 8192 then
    p_context := jsonb_build_object('_truncated', true, 'bytes', pg_column_size(p_context));
  end if;

  insert into public.app_errors (client_id, source, severity, code, message, url, user_agent, context)
  values (
    v_client,
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

-- Grants are unchanged from 028 (anon + authenticated may execute); no need to re-run them,
-- but harmless if you do:
-- revoke all on function public.log_error(text,text,text,text,text,jsonb) from public;
-- grant execute on function public.log_error(text,text,text,text,text,jsonb) to anon, authenticated;

-- OPERATOR NOTE (retention): this caps the growth RATE, not total size. Add a periodic prune
-- (e.g. a pg_cron job) to keep the table bounded, for example:
--   delete from public.app_errors where created_at < now() - interval '90 days';
