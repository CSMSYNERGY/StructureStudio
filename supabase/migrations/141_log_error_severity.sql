-- 141 — Refusals stop being logged as errors.
--
-- WHY: app_errors mixed two different things under one severity. A genuine fault
-- ("Couldn't check change orders" — something threw) sat beside the product working
-- correctly ("send the invoice first", "that width isn't valid", "you need an owner
-- for that"). On 2026-08-27 a triage of 68 unresolved rows found ZERO open defects:
-- almost all of it was refusals. A queue that is mostly noise gets ignored, which is
-- the actual risk — the one row in it that mattered would be missed.
--
-- WHY SEVERITY AND NOT SILENCE: refusals are still worth recording, because a refusal
-- that fires CONSTANTLY is a bug wearing a refusal's clothes. "Driver not found." read
-- like a validation message and was in fact a client sending driver_profiles.user_id
-- where the server matches on .id — driver reassignment failed 100% of the time for
-- twelve days. Dropping refusals on the floor would have thrown that away. They are
-- demoted, not deleted: the row keeps its full context and stops shouting.
--
-- ⚠️ DROP-then-CREATE, deliberately, and it must stay that way. Adding p_severity to
-- the existing function creates an OVERLOAD rather than replacing it, and a 6-argument
-- named call would then match both signatures — PostgREST would get "function is not
-- unique" and EVERY log call from the browser would fail. Silently: ssLogError swallows
-- its own errors by design, so logging would simply stop and nothing would say so.
-- The old signature is therefore removed in the same transaction, and the grants are
-- restored below because DROP takes them with it.
--
-- Apply by hand (SQL editor / MCP / `supabase db query --linked`) and record as 141.
-- NEVER `supabase db push` — see the migration ledger note on 126.

drop function if exists public.log_error(text, text, text, text, text, jsonb);

create or replace function public.log_error(
  p_source    text,
  p_message   text,
  p_code      text  default null,
  p_client_id text  default null,
  p_url       text  default null,
  p_context   jsonb default null,
  p_severity  text  default 'error'
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ua     text;
  v_client text;
  v_recent int;
  v_sev    text;
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

  -- Whitelisted, and anything unrecognised becomes 'error'. The caller is a browser and
  -- can send whatever it likes, so an unknown value must fail LOUD rather than quiet:
  -- a typo that silently demoted real faults to 'info' would hide exactly what this
  -- table exists to surface.
  v_sev := lower(nullif(btrim(coalesce(p_severity, '')), ''));
  if v_sev is null or v_sev not in ('error', 'warn', 'info') then
    v_sev := 'error';
  end if;

  select count(*) into v_recent
  from public.app_errors
  where created_at > now() - interval '1 minute';
  if v_recent >= 1000 then
    return;
  end if;

  if p_context is not null and pg_column_size(p_context) > 8192 then
    p_context := jsonb_build_object('_truncated', true, 'bytes', pg_column_size(p_context));
  end if;

  insert into public.app_errors (client_id, source, severity, code, message, url, user_agent, context)
  values (
    v_client,
    left(coalesce(nullif(p_source, ''), 'unknown'), 100),
    v_sev,
    nullif(left(p_code, 100), ''),
    left(p_message, 4000),
    nullif(left(p_url, 600), ''),
    nullif(left(v_ua, 400), ''),
    p_context
  );
end;
$fn$;

-- DROP took the old grants with it; restore exactly what was live (anon EXECUTE is
-- load-bearing — the portal logs with the anon key, before anyone signs in).
revoke all on function public.log_error(text, text, text, text, text, jsonb, text) from public;
grant execute on function public.log_error(text, text, text, text, text, jsonb, text) to anon, authenticated;
