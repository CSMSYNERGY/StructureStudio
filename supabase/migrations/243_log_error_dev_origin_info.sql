-- 243 — A page that is not running on a real host of ours cannot file an ERROR row.
--
-- WHY: every page and compiled bundle logs through public.log_error with the anon key (the three
-- boot guards, ssLogError in portal/01-core.jsx, index.mount.jsx and admin.app.jsx), and until now
-- the function never looked at WHERE the page was. So a copy of our pages running anywhere wrote
-- severity 'error' rows into the one app_errors table that beta and production share:
--   * a desktop app's file preview rendering the raw source of portal.html / index.html as a
--     data: document, where the root-relative /vendor/ scripts cannot resolve, so the guard
--     reported boot_deps_missing (byte-for-byte: the stored url IS "data:text/html;charset=utf-8,"
--     plus the encoded file, cut at 600);
--   * a dev harness on a loopback port throwing while it was still being written.
-- 276 rows of that class were resolved by hand between 2026-07-01 and 2026-09-06, and at least one
-- data: row was mis-resolved as "a real asset-load failure". That misreading is the actual risk: a
-- queue that is mostly noise gets skimmed, and the row in it that matters gets missed.
--
-- THE RULE. Every real page is served over http(s) from a public host (app., beta., tenant
-- subdomains, custom domains, and iframes of those) and sends p_url = location.href. So a row whose
-- url is NOT http(s) (data:, file:, blob:, about:) or whose host is loopback (localhost, 127.x.x.x,
-- [::1]) cannot be a production fault. It is DEMOTED to 'info' and MARKED with
-- context._demoted = 'non_production_url'.
--
-- DEMOTED AND KEPT, NEVER DROPPED — same reasoning as 141. A local verification of the boot guard
-- (earlier audits deliberately induced localhost boot rows to prove it reports) must still land
-- somewhere it can be read; it just stops shouting in the error queue.
--
-- WHY THE MARKER. CLAUDE.md's repetition check reads the info rows ("a refusal that fires
-- constantly is a bug") with a > 20 threshold, and one July burst of data: designer rows alone
-- would have tripped it. The check excludes context->>'_demoted'. So the marker is always a
-- top-level key: a non-object context is wrapped under "_context", and the 8192-byte cap keeps
-- the marker when it replaces an oversized context.
--
-- NOT AFFECTED:
--   * Real pages: https, public host — severity exactly as before, including a caller's own
--     p_severity 'info'. A null or empty p_url is left alone (the only DB caller, save_design,
--     passes null).
--   * Edge functions never call this: _shared/logError.ts inserts into app_errors directly.
--   * An e2e run against beta has an https beta URL, so it is NOT demoted here. The e2e suite
--     answers log_error locally instead (tests/e2e/helpers.mjs, guardLogError).
--   * Production's older frontend (origin/main) calls with the same named 7 arguments.
--
-- ⚠️ CREATE OR REPLACE with the IDENTICAL signature and parameter names, deliberately. NEVER DROP
-- this function and never add a parameter: an overload makes PostgREST answer "function is not
-- unique", and every browser log call then fails SILENTLY because ssLogError swallows its own
-- errors (see 141's header). CREATE OR REPLACE keeps the owner and the grants; they are restated
-- below anyway so the file alone says what anon may do.
--
-- Written from the LIVE definition read on 2026-09-17: its body matched 141 byte-for-byte after LF
-- normalisation (md5 1324842bfcb376206d8dcfa8f94abf85), exactly 1 overload, anon and authenticated
-- EXECUTE. The only changes are v_demoted, the demotion block, and the cap keeping the marker.
--
-- Apply by hand (never `supabase db push`), in ONE transaction together with the ledger row
-- (insert into supabase_migrations.schema_migrations (version, name) values ('243',
-- '243_log_error_dev_origin_info') returning version, name). This file starts with a comment, so
-- pass the statements rather than the file inline. If 243 is taken by then, renumber.
-- Read it back: select position('non_production_url' in pg_get_functiondef(
--   'public.log_error(text,text,text,text,text,jsonb,text)'::regprocedure)) > 0;
--
-- Rollback: re-run 141 (its DROP names the old 6-argument signature, which no longer exists, so
-- it is a no-op, and its CREATE OR REPLACE restores this body without the demotion).

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
  v_demoted boolean := false;  -- (243) set by the non-production-URL block below
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

  -- (243) A page that is not on a real host of ours cannot be a production fault: a data: or
  -- file: preview of our HTML, or a dev server on a loopback address. Every real page is
  -- http(s) on a public host. Such a row is DEMOTED to info and MARKED, and it is still
  -- inserted below with its full context: demoted and kept, never dropped. The marker is a
  -- top-level key so the info repetition check can exclude these rows.
  if nullif(p_url, '') is not null
     and (p_url !~* '^https?://'
          or p_url ~* '^https?://(localhost|127(\.[0-9]{1,3}){3}|\[::1\])(:[0-9]+)?([/?#]|$)') then
    v_sev := 'info';
    v_demoted := true;
    p_context := case
                   when p_context is null then '{}'::jsonb
                   when jsonb_typeof(p_context) = 'object' then p_context
                   else jsonb_build_object('_context', p_context)
                 end
                 || jsonb_build_object('_demoted', 'non_production_url');
  end if;

  select count(*) into v_recent
  from public.app_errors
  where created_at > now() - interval '1 minute';
  if v_recent >= 1000 then
    return;
  end if;

  if p_context is not null and pg_column_size(p_context) > 8192 then
    p_context := jsonb_build_object('_truncated', true, 'bytes', pg_column_size(p_context))
                 || case when v_demoted then jsonb_build_object('_demoted', 'non_production_url')
                         else '{}'::jsonb end;
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

-- CREATE OR REPLACE kept these; restated so the file is the whole truth (anon EXECUTE is
-- load-bearing — the pages log with the anon key, before anyone signs in).
revoke all on function public.log_error(text, text, text, text, text, jsonb, text) from public;
grant execute on function public.log_error(text, text, text, text, text, jsonb, text) to anon, authenticated;
