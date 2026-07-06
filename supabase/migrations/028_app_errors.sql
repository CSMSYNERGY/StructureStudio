-- 028_app_errors: central client/app error log + an anon-callable capability RPC so the
-- browser apps (designer, portal, admin) can report errors/bugs, and the operator can
-- review + fix them. HAND-APPLY only (recorded in supabase_migrations as version 028).
--
-- Read path: service role only (edge functions / operator via MCP). Write path: the
-- SECURITY DEFINER log_error RPC (browser, anon) or the service role (edge functions).

create table if not exists public.app_errors (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  client_id   text,
  source      text not null,           -- e.g. 'designer', 'portal', 'admin', 'edge:submit-estimate'
  severity    text not null default 'error',
  code        text,                    -- HTTP status / GHL code / app code, if any
  message     text,
  url         text,                    -- page URL where it happened
  user_agent  text,
  context     jsonb,                   -- arbitrary extra detail (stack, action, ids, …)
  resolved    boolean not null default false
);
create index if not exists app_errors_created_idx    on public.app_errors (created_at desc);
create index if not exists app_errors_client_idx     on public.app_errors (client_id);
create index if not exists app_errors_unresolved_idx on public.app_errors (resolved, created_at desc);

-- Locked down like client_settings: RLS on, NO anon/authenticated policies. Writes happen
-- only through log_error (SECURITY DEFINER) or the service role; reads are service-role only.
alter table public.app_errors enable row level security;
revoke all on public.app_errors from anon, authenticated;

-- Append-only error logging capability. Caps field lengths to bound abuse and pulls the
-- user-agent server-side from the PostgREST request headers.
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
  v_ua text;
begin
  begin
    v_ua := current_setting('request.headers', true)::json ->> 'user-agent';
  exception when others then
    v_ua := null;
  end;
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

revoke all on function public.log_error(text,text,text,text,text,jsonb) from public;
grant execute on function public.log_error(text,text,text,text,text,jsonb) to anon, authenticated;
