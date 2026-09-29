-- 256_sss_phone_push_webhook.sql — SSS Phone text alerts: a new INBOUND text on a tenant whose
-- phone is on asks the phone-api Worker (/push/text) to push it to the owners' phones.
--
-- ⛔ APPLY BY HAND (`supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`.
--
-- WHY: the mobile app is closed most of the time, so Realtime can't reach it. The Worker sends
-- the FCM/APNs alert (workers/phone-api/src/routes/push.ts, which expects Supabase's database-
-- webhook body: {type:'INSERT', table:'sms_messages', schema, record}). This file is the
-- webhook, written as a plain trigger so it lives in the repo instead of the dashboard.
--
-- SECRET: the x-push-secret value is NOT in this public file. It lives in Supabase Vault under
-- the name 'sss_phone_push_secret' and is created out of band, once:
--   select vault.create_secret('<PUSH_WEBHOOK_SECRET>', 'sss_phone_push_secret',
--                              'x-push-secret for phone-api /push/text');
-- Until that row exists, the trigger sends nothing (and raises nothing).
--
-- SAFETY: pg_net queues the request and returns at once, so a text's INSERT never waits on
-- the network; any error inside the trigger is swallowed (WARNING only), so an alert can never
-- block or roll back a customer's text. Tenants with phone_status <> 'on' send nothing.
--
-- SIDE EFFECTS OF `create extension pg_net` (review 2026-09-29): Supabase's issue_pg_net_access
-- event trigger creates the role supabase_functions_admin (LOGIN, no password) and grants USAGE on
-- schema net to anon/authenticated/service_role. net.http_post is SECURITY DEFINER, and the queue
-- and response tables hold the x-push-secret header and text bodies for about 6 hours. So:
--   * `net` must NEVER be added to the API's exposed schemas (today: public, graphql_public);
--   * net's tables (http_request_queue, _http_response) are owned by supabase_admin and granted
--     ALL to PUBLIC by the extension itself (measured 2026-09-29: relacl `=arwdDxtm/supabase_admin`);
--     postgres cannot revoke that. This is the same posture as Supabase's own Database Webhooks.
--     What keeps it safe: `net` is not an exposed API schema (a browser can't query it), a queued
--     request (the only row carrying x-push-secret) lives there until pg_net sends it, well under a
--     second, and _http_response keeps only the Worker's reply (a 204), never our request headers.
-- Do NOT also create a Dashboard "Database Webhook" for sms_messages → /push/text: this trigger IS
-- that webhook, and a second one doubles every alert (and stores the secret in plain text).
--
-- LOCKS: the apply waits at most 3 s for sms_messages (lock_timeout), so it can never queue
-- customers' inserts behind it; the trigger function carries its own 1 s lock_timeout so any lock
-- wait inside it becomes a caught 55P03 long before the callers' 8 s statement_timeout (57014,
-- which `when others` cannot catch).
--
-- ROLLBACK:  drop trigger if exists phone_push_text on public.sms_messages;
--            drop function if exists public.phone_push_text_notify();
--            (leave pg_net installed; other features may use it later)

begin;

set local lock_timeout = '3s';

create extension if not exists pg_net with schema extensions;

create or replace function public.phone_push_text_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set lock_timeout = '1s'
as $$
declare
  v_secret text;
begin
  if new.direction is distinct from 'in' then
    return new;
  end if;
  if not exists (
    select 1 from public.client_settings cs
     where cs.client_id = new.client_id and cs.phone_status = 'on'
  ) then
    return new;
  end if;

  select ds.decrypted_secret into v_secret
    from vault.decrypted_secrets ds
   where ds.name = 'sss_phone_push_secret'
   limit 1;
  if v_secret is null or v_secret = '' then
    return new;
  end if;

  perform net.http_post(
    url := 'https://phone.structurestudiosuite.com/push/text',
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'sms_messages',
      'schema', 'public',
      'record', to_jsonb(new)
    ),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-push-secret', v_secret
    ),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  raise warning 'phone_push_text_notify: % (%)', sqlerrm, sqlstate;
  return new;
end;
$$;

comment on function public.phone_push_text_notify() is
  'SSS Phone: posts a new inbound sms_messages row to phone-api /push/text (secret from Vault). Never blocks or fails the insert.';

revoke all on function public.phone_push_text_notify() from public, anon, authenticated;

drop trigger if exists phone_push_text on public.sms_messages;
create trigger phone_push_text
  after insert on public.sms_messages
  for each row execute function public.phone_push_text_notify();

-- Apply-time checks.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception '256: pg_net is not installed';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgname = 'phone_push_text' and t.tgrelid = 'public.sms_messages'::regclass and not t.tgisinternal
  ) then
    raise exception '256: trigger phone_push_text missing';
  end if;
  if has_function_privilege('anon', 'public.phone_push_text_notify()', 'execute')
     or has_function_privilege('authenticated', 'public.phone_push_text_notify()', 'execute') then
    raise exception '256: browser roles can execute phone_push_text_notify';
  end if;
end $$;

commit;
