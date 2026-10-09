-- 297_phone_number_requests.sql — "Bring your number": a builder's request to move numbers they
--                                  already have into Structure Studio (Workstream 2, phase 8).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('297', '297_phone_number_requests') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run. To see the same row and
--    change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Written 2026-10-09 after 296 of the same branch. Take the next free number from the live ledger,
-- renaming this file, its test (tests/sql/migration297.test.cjs) and every '297' below.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-08: most new builders will bring a number they already have. Moving one is an
-- operator's job for now (workers/phone-api/PORTING.md: a GoHighLevel LC Phone number is a
-- HighLevel ticket; a carrier number is a Twilio Port In request made in the Twilio Console). The
-- builder asks on the Phone tab ("Bring your number", portal-settings phone_port_request), and
-- the request lands here. THE ROW IS THE OPERATOR'S NOTIFICATION: status 'new' until an operator
-- takes it; the operator console lists every open one (admin-catalog number_requests_list) and
-- moves it on (number_request_set); phone_adopt_number marks it done when the number lands.
--
-- ⚠️ NO SECRETS, BY DESIGN. A port needs the line's account number (and, for a mobile number, its
-- PIN), a recent bill and a signed LOA. NONE of that is collected here or anywhere in our code: the
-- operator types them into Twilio's Console, the bill is uploaded there, and Twilio emails the LOA
-- to the person named here. So this table holds only: the numbers, the current carrier, whether it
-- is a GoHighLevel number, who may authorise the move (name, email), and when it may move. The
-- free-text columns refuse what looks like an account number or a PIN, the same rule as
-- portal-settings numberRequests.ts looksSecret (review 2026-10-09: a bare [0-9]{5,} let "PIN 4829"
-- and "acct 287-123-456" through):
--   * five or more digits joined only by spaces, dots, slashes or dashes ("1234-5678-9012");
--   * any digit within six characters after the word pin, passcode, pass code, password, acct,
--     account, ssn or security code, or after it and "no", "num" or "number" ("PIN 4829",
--     "acct #12", "account no. 4");
--   * in cutover_window only, dates and times are taken out first ("after 10/20/2026, 9am-5pm").
--
--   id                uuid
--   client_id         the builder (plain text, NO foreign key: admin-catalog delete_client deletes
--                     client_configs last, and deletes these rows itself before)
--   numbers           text[], 1-10 US numbers in E.164 (+1NXXNXXXXXX), no NULL element
--   current_carrier   1-80 characters
--   is_lc_phone       true = a GoHighLevel LC Phone number (a HighLevel ticket, not a port);
--                     false = a carrier; NULL = the builder is not sure
--   contact_name      2-120 characters: who signs the LOA / approves the move
--   contact_email     where Twilio (or HighLevel) reaches them
--   cutover_window    0-200 characters, e.g. "weekday evenings after the 20th"
--   status            new | in_progress | done | cancelled
--   requested_by      the signed-in user who asked (auth uid; no FK, the account may go)
--   handled_by, handled_at   the operator who last moved it on, and when
--   created_at, updated_at
--
-- Service role only: RLS enabled (NOT forced: 154/188/193's rule), no policies, every privilege
-- revoked from public, anon and authenticated. The builder reads their own requests through
-- portal-settings, the operator through admin-catalog.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- A new table nothing reads until portal-settings and admin-catalog are deployed with it; both
-- read it error-tolerantly, so either can deploy before this migration (the card then says
-- requests aren't available yet).
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Export open requests first (they are builders' asks nobody has answered):
--   select * from public.phone_number_requests where status in ('new', 'in_progress');
--   drop table if exists public.phone_number_requests;
--   delete from supabase_migrations.schema_migrations where version = '297';

begin;

set local lock_timeout = '5s';

create table if not exists public.phone_number_requests (
  id              uuid primary key default gen_random_uuid(),
  client_id       text not null,
  numbers         text[] not null,
  current_carrier text not null,
  is_lc_phone     boolean,
  contact_name    text not null,
  contact_email   text not null,
  cutover_window  text,
  status          text not null default 'new',
  requested_by    uuid,
  handled_by      uuid,
  handled_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint phone_number_requests_client_id_chk check (client_id ~ '^[a-z0-9][a-z0-9-]*$'),
  -- array_to_string skips NULL elements, so a NULL is refused on its own (array_position finds it).
  constraint phone_number_requests_numbers_chk check (
    cardinality(numbers) between 1 and 10
    and array_position(numbers, null) is null
    and array_to_string(numbers, ',') ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}(,\+1[2-9][0-9]{2}[2-9][0-9]{6})*$'),
  constraint phone_number_requests_carrier_chk check (char_length(btrim(current_carrier)) between 1 and 80
    and current_carrier !~ '[0-9]([[:space:]./-]*[0-9]){4,}'
    and current_carrier !~* '\m(pin|passcode|pass[[:space:]]*code|password|acct|account|ssn|security[[:space:]]*code)\M([[:space:]]*(no|num|number)\M)?[^[:alnum:]]{0,6}[0-9]'),
  constraint phone_number_requests_contact_name_chk check (char_length(btrim(contact_name)) between 2 and 120
    and contact_name !~ '[0-9]([[:space:]./-]*[0-9]){4,}'
    and contact_name !~* '\m(pin|passcode|pass[[:space:]]*code|password|acct|account|ssn|security[[:space:]]*code)\M([[:space:]]*(no|num|number)\M)?[^[:alnum:]]{0,6}[0-9]'),
  constraint phone_number_requests_contact_email_chk check (char_length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- The timing note: its dates and times out first (ISO dates; 10/20 and 10/20/2026, also with dots
  -- or dashes; 9am, 9:30 pm; 17:00; years 1900-2099), then the digit rule; the word rule on all of it.
  constraint phone_number_requests_window_chk check (cutover_window is null or (char_length(cutover_window) <= 200
    and regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(cutover_window,
          '\m[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}\M', ' ', 'g'),
          '\m[0-9]{1,2}[/.-][0-9]{1,2}([/.-][0-9]{2,4})?\M', ' ', 'g'),
          '\m[0-9]{1,2}(:[0-9]{2})?[[:space:]]*(am|pm|a\.m\.|p\.m\.)', ' ', 'gi'),
          '\m[0-9]{1,2}:[0-9]{2}\M', ' ', 'g'),
          '\m(19|20)[0-9]{2}\M', ' ', 'g') !~ '[0-9]([[:space:]./-]*[0-9]){4,}'
    and cutover_window !~* '\m(pin|passcode|pass[[:space:]]*code|password|acct|account|ssn|security[[:space:]]*code)\M([[:space:]]*(no|num|number)\M)?[^[:alnum:]]{0,6}[0-9]')),
  constraint phone_number_requests_status_chk check (status in ('new', 'in_progress', 'done', 'cancelled'))
);

create index if not exists phone_number_requests_open_idx
  on public.phone_number_requests (created_at desc) where status in ('new', 'in_progress');
create index if not exists phone_number_requests_client_idx
  on public.phone_number_requests (client_id, created_at desc);

comment on table public.phone_number_requests is
  'Migration 297. A builder''s request to move numbers they already have into Structure Studio ("Bring your number", portal-settings phone_port_request). The row is the operator''s notification (status new until taken; admin-catalog lists the open ones). Holds NO PIN, account number, bill or LOA: those go into Twilio''s Console only (workers/phone-api/PORTING.md). Service role only.';

-- Enabled, NOT forced; no policies; nothing for the browser roles.
alter table public.phone_number_requests enable row level security;
alter table public.phone_number_requests no force row level security;
revoke all on public.phone_number_requests from public;
revoke all on public.phone_number_requests from anon, authenticated;
grant select, insert, update, delete on public.phone_number_requests to service_role;

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_role text;
  v_priv text;
  v_out  text;
  v_bad  text;
  v_refused int := 0;
begin
  if not (select c.relrowsecurity and not c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = 'public.phone_number_requests'::regclass) then
    raise exception '297: RLS must be enabled and NOT forced on phone_number_requests';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.phone_number_requests'::regclass) then
    raise exception '297: phone_number_requests has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'public.phone_number_requests', v_priv) then
        raise exception '297: % holds % on phone_number_requests', v_role, v_priv;
      end if;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege(v_role, 'public.phone_number_requests', v_priv) then
        raise exception '297: % holds column-level % on phone_number_requests', v_role, v_priv;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', 'public.phone_number_requests', v_priv) then
      raise exception '297: service_role lacks % on phone_number_requests', v_priv;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_constraint c where c.contype = 'f'
              and (c.conrelid = 'public.phone_number_requests'::regclass or c.confrelid = 'public.phone_number_requests'::regclass)) then
    raise exception '297: phone_number_requests must have no foreign key (delete_client deletes client_configs last)';
  end if;

  -- ── The rehearsal: what the code writes is taken, what must never be stored is refused ──
  begin
    insert into public.phone_number_requests (client_id, numbers, current_carrier, is_lc_phone, contact_name, contact_email, cutover_window)
      values ('m297-probe', array['+15555550123', '+15555550124'], 'GoHighLevel (LC Phone)', true, 'Pat Example', 'pat@example.test', 'Weekday evenings after the 20th');
    foreach v_bad in array array[
      'numbers = array[]::text[]',
      'numbers = array[''5555550123'']',
      'numbers = array[''+18005550123'', ''+1555'']',
      'numbers = array[''+15555550123'', null]',
      'current_carrier = ''Verizon acct 123456789''',
      'current_carrier = ''Verizon 1234-5678-9012''',
      'contact_name = ''Pat 1234567''',
      'contact_name = ''Pat 48 29 13''',
      'contact_email = ''not-an-email''',
      'cutover_window = ''PIN 482913''',
      'cutover_window = ''PIN 4829''',
      'cutover_window = ''acct 287-123-456''',
      'status = ''approved'''
    ] loop
      begin
        execute format('update public.phone_number_requests set %s where client_id = %L', v_bad, 'm297-probe');
      exception when check_violation then
        v_refused := v_refused + 1;
      end;
    end loop;
    if v_refused <> 13 then
      raise exception '297: the rehearsal expected 13 refusals, got %', v_refused;
    end if;
    -- Dates and times in the timing note are not a secret.
    update public.phone_number_requests set cutover_window = 'after 10/20/2026, 9am-5pm, or 2026-10-27 at 17:00' where client_id = 'm297-probe';
    update public.phone_number_requests set status = 'in_progress', handled_at = now() where client_id = 'm297-probe';
    raise exception using errcode = 'S2970', message = 'a request stored; empty, non-E.164 and malformed numbers, digit runs and a bad status refused';
  exception when sqlstate 'S2970' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.phone_number_requests where client_id = 'm297-probe') then
    raise exception '297: the rehearsal left a row behind';
  end if;
  perform set_config('ss.m297_rehearsal', v_out, true);
  raise notice '297: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- PASS: table_ready true, rows 0 (or what an earlier apply left), rehearsal 'a request stored;
-- empty, non-E.164 and malformed numbers, digit runs and a bad status refused'.
select
  '297' as migration,
  ((select c.relrowsecurity and not c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = 'public.phone_number_requests'::regclass)
     and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.phone_number_requests'::regclass)
     and not has_table_privilege('anon', 'public.phone_number_requests', 'SELECT')
     and not has_table_privilege('authenticated', 'public.phone_number_requests', 'SELECT')
     and has_table_privilege('service_role', 'public.phone_number_requests', 'INSERT')) as table_ready,
  (select count(*) from public.phone_number_requests)::int as rows,
  current_setting('ss.m297_rehearsal', true) as rehearsal;

commit;
