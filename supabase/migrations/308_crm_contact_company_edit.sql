-- 308_crm_contact_company_edit.sql — the contact editor can change the COMPANY.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('308', '308_crm_contact_company_edit') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run. To see the same row and
--    change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-14: 307 is the newest. 306 is held by ss/c1012-csv-import
-- (306_crm_import_leads.sql), so this is 308. Neither needs the other. Take the next free number
-- at apply time, renaming this file, its test (tests/sql/migration308.test.cjs) and every '308'
-- below; record the ledger row with `returning`: no row back means the number was taken.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-14 call @11:08: "when you do add new lead, it asks for the company name, but
-- there's no … places … for me to edit that company name later, because I got the company name
-- wrong." crm_contacts.company arrived with the sales pipelines (301) and is written by
-- crm_create_lead (+ Add lead, Book a Demo, the import), but crm_update_contact, the ONE writer
-- behind the record page's ✎ Edit (143 → 166 → 188), was never taught it. So a company typed
-- wrong stayed wrong, on the board card it heads, for good.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * crm_update_contact gains p_company, APPENDED LAST with a default (166/188's append-only
--     rule): DROP the 15-argument function, CREATE the 16-argument one. Its body is 188's,
--     byte for byte as live on 2026-10-14 (pg_get_functiondef diffed against 188), plus the
--     company: the same three-state contract (NULL leave alone, '' or spaces clear, a value
--     set), 200 characters (crm_create_lead's cap), and one crm_field_changes row under
--     field = 'company' when it really moves. The record's Changelog already renders any field
--     name ("Company changed · "Wrong Barns" → "Right Barns""), so no feed change is needed.
--   * Nothing else. No column, no data change.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Exactly 188's swap: one drop, one create, in one transaction, so there is never a moment
-- with no crm_update_contact or with two (two would make every named call ambiguous: a 500 on
-- save). The live portal-settings calls it by NAME with 15 arguments; those calls resolve to
-- the new function through p_company's default. The new portal-settings sends p_company only
-- when the browser sent a company, so it is also safe against a database WITHOUT this file.
-- Production's portal never sends a company, so production behaves exactly as before.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
--   1. This file.
--   2. portal-settings (crm_save_contact accepts `company`).
--   3. The beta portal (the Company input on both contact editors).
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Roll portal-settings back first (or the browser's company edits answer "save that contact"
-- failures). Then, in one transaction:
--   drop function if exists public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text, text);
--   -- re-create 188's 15-argument version verbatim, with its revoke/grant
--   notify pgrst, 'reload schema';
--   delete from supabase_migrations.schema_migrations where version = '308';
-- The 'company' rows in crm_field_changes stay: they are the record that it happened.

begin;

set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.crm_contacts') is null or to_regclass('public.crm_field_changes') is null then
    raise exception '308: crm_contacts / crm_field_changes are missing (migrations 130 and 143 not applied?)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'crm_contacts' and column_name = 'company') then
    raise exception '308: crm_contacts.company is missing (migration 301 not applied?)';
  end if;
  if to_regprocedure('public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text)') is null
     and to_regprocedure('public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text, text)') is null then
    raise exception '308: no crm_update_contact to extend (migration 188 not applied?)';
  end if;
end
$pre$;

-- ── THE CHANGE ───────────────────────────────────────────────────────────────────────────
drop function if exists public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text);

create or replace function public.crm_update_contact(
  p_client_id text,
  p_id uuid,
  p_name text default null,
  p_phone text default null,
  p_email text default null,
  p_actor uuid default null,
  p_street text default null,
  p_city text default null,
  p_state text default null,
  p_zip text default null,
  p_owner text default null,
  p_billing_street text default null,
  p_billing_city text default null,
  p_billing_state text default null,
  p_billing_zip text default null,
  p_company text default null
) returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_old    public.crm_contacts%rowtype;
  v_name   text;
  v_phone  text;
  v_email  text;
  v_digits text;
  v_street text;
  v_city   text;
  v_state  text;
  v_zip    text;
  v_owner_txt text;
  v_owner  uuid;
  v_bstreet text;
  v_bcity   text;
  v_bstate  text;
  v_bzip    text;
  v_company text;
  v_n      integer := 0;
begin
  select * into v_old from public.crm_contacts
   where id = p_id and client_id = p_client_id;
  if not found then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;

  -- btrim so a field of spaces reads as "cleared" rather than as a value made of spaces.
  v_name   := case when p_name   is null then v_old.name   else nullif(btrim(p_name), '')   end;
  v_phone  := case when p_phone  is null then v_old.phone  else nullif(btrim(p_phone), '')  end;
  v_email  := case when p_email  is null then v_old.email  else nullif(btrim(p_email), '')  end;
  v_street := case when p_street is null then v_old.street else nullif(btrim(p_street), '') end;
  v_city   := case when p_city   is null then v_old.city   else nullif(btrim(p_city), '')   end;
  v_state  := case when p_state  is null then v_old.state  else nullif(btrim(p_state), '')  end;
  v_zip    := case when p_zip    is null then v_old.zip    else nullif(btrim(p_zip), '')    end;
  v_bstreet := case when p_billing_street is null then v_old.billing_street else nullif(btrim(p_billing_street), '') end;
  v_bcity   := case when p_billing_city   is null then v_old.billing_city   else nullif(btrim(p_billing_city), '')   end;
  v_bstate  := case when p_billing_state  is null then v_old.billing_state  else nullif(btrim(p_billing_state), '')  end;
  v_bzip    := case when p_billing_zip    is null then v_old.billing_zip    else nullif(btrim(p_billing_zip), '')    end;
  -- THE COMPANY (308). 200 characters, the cap crm_create_lead puts on the same column, so an
  -- edit can never store what + Add lead would have cut.
  v_company := case when p_company is null then v_old.company else left(nullif(btrim(p_company), ''), 200) end;
  v_digits := public.crm_phone_key(v_phone);

  -- THE OWNER. '' unassigns; anything else must parse as a uuid AND name somebody on THIS
  -- tenant's team.
  --
  -- ⚠️ THE MEMBERSHIP CHECK IS NOT TIDINESS. Carolyn's rule is that assignment is what makes
  -- a record visible at all -- "if they are not assigned to or following that customer, they
  -- can't see anything of it" -- so owner_user_id is on its way to being an access input,
  -- not a label. A uuid belonging to another tenant, stored here by a typo, would be a
  -- permission handed to a stranger with nothing anywhere to notice. client_users' primary
  -- key is user_id, so this costs one index lookup.
  if p_owner is null then
    v_owner := v_old.owner_user_id;
  else
    v_owner_txt := nullif(btrim(p_owner), '');
    if v_owner_txt is null then
      v_owner := null;                          -- deliberate unassign
    else
      begin
        v_owner := v_owner_txt::uuid;
      exception when others then
        raise exception 'owner must be a user id' using errcode = 'invalid_text_representation';
      end;
      if not exists (select 1 from public.client_users cu
                      where cu.user_id = v_owner and cu.client_id = p_client_id) then
        raise exception 'owner is not on this team' using errcode = 'foreign_key_violation';
      end if;
    end if;
  end if;

  -- One row per field that genuinely moved. `is distinct from` rather than `<>` so a change
  -- to or from NULL counts -- clearing an email is exactly the kind of edit somebody will
  -- later want to explain.
  if v_name is distinct from v_old.name then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'name', v_old.name, v_name, p_actor);
    v_n := v_n + 1;
  end if;
  if v_phone is distinct from v_old.phone then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'phone', v_old.phone, v_phone, p_actor);
    v_n := v_n + 1;
  end if;
  if v_email is distinct from v_old.email then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'email', v_old.email, v_email, p_actor);
    v_n := v_n + 1;
  end if;
  -- The address fields log exactly like the first three. A delivery going to the wrong
  -- street because somebody quietly corrected it is precisely the edit a changelog is for.
  if v_street is distinct from v_old.street then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'street', v_old.street, v_street, p_actor);
    v_n := v_n + 1;
  end if;
  if v_city is distinct from v_old.city then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'city', v_old.city, v_city, p_actor);
    v_n := v_n + 1;
  end if;
  if v_state is distinct from v_old.state then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'state', v_old.state, v_state, p_actor);
    v_n := v_n + 1;
  end if;
  if v_zip is distinct from v_old.zip then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'zip', v_old.zip, v_zip, p_actor);
    v_n := v_n + 1;
  end if;
  -- BILLING. Four more of the same, under their own field names so the changelog can say
  -- WHICH address moved -- "Street changed" on a record carrying two of them is not an answer.
  if v_bstreet is distinct from v_old.billing_street then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'billing_street', v_old.billing_street, v_bstreet, p_actor);
    v_n := v_n + 1;
  end if;
  if v_bcity is distinct from v_old.billing_city then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'billing_city', v_old.billing_city, v_bcity, p_actor);
    v_n := v_n + 1;
  end if;
  if v_bstate is distinct from v_old.billing_state then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'billing_state', v_old.billing_state, v_bstate, p_actor);
    v_n := v_n + 1;
  end if;
  if v_bzip is distinct from v_old.billing_zip then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'billing_zip', v_old.billing_zip, v_bzip, p_actor);
    v_n := v_n + 1;
  end if;
  -- THE COMPANY (308), logged like every other field: the board card is headed by it, so a
  -- card that changed its name overnight should be able to say who renamed it.
  if v_company is distinct from v_old.company then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'company', v_old.company, v_company, p_actor);
    v_n := v_n + 1;
  end if;
  -- THE OWNER CHANGE — the event _shared/crmFeed.ts has been owed since 2026-08-26.
  -- Stored as the two uuids; crmFeed resolves them to names against client_users, because
  -- "0f3c... -> 8a12..." answers none of the questions somebody opens a changelog to ask.
  if v_owner is distinct from v_old.owner_user_id then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'owner', v_old.owner_user_id::text, v_owner::text, p_actor);
    v_n := v_n + 1;
  end if;

  if v_n = 0 then
    return 0;                                  -- nothing moved; do not bump updated_at
  end if;

  update public.crm_contacts
     set name = v_name,
         phone = v_phone,
         phone_digits = v_digits,
         email = v_email,
         street = v_street,
         city = v_city,
         state = v_state,
         zip = v_zip,
         owner_user_id = v_owner,
         billing_street = v_bstreet,
         billing_city = v_bcity,
         billing_state = v_bstate,
         billing_zip = v_bzip,
         company = v_company,
         updated_at = now()
   where id = p_id and client_id = p_client_id;

  return v_n;
end
$function$;

-- Same posture as every other SECURITY DEFINER function here: revoke from PUBLIC as well as
-- from the roles, because the PUBLIC grant survives revoking anon/authenticated and this one
-- writes another tenant's contacts if handed their client_id.
revoke execute on function public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

comment on function public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text, text) is
  'The contact editor''s one writer (143, 166, 188, 308): name, phone (phone_digits rederived), email, delivery and billing address, owner (team-checked) and company. NULL leaves a field alone, '''' clears it; one crm_field_changes row per field that moved. service_role only (portal-settings crm_save_contact).';

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_sig constant text := 'public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text, text)';
  v_t   constant text := '__m308_rehearsal__';
  v_role text;
  v_id  uuid;
  v_n   int;
  v_c   public.crm_contacts%rowtype;
  v_out text;
begin
  -- ── Exactly ONE crm_update_contact. Two would make every named call ambiguous (a 500 on
  --    save, not a warning): 166's whole reason for dropping first. ──
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'crm_update_contact') <> 1 then
    raise exception '308: expected exactly 1 crm_update_contact, found %',
      (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'crm_update_contact');
  end if;
  if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_sig::regprocedure) then
    raise exception '308: crm_update_contact is not SECURITY DEFINER';
  end if;

  -- ── service_role only ──
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_role, v_sig, 'execute') then
      raise exception '308: % can execute crm_update_contact', v_role;
    end if;
  end loop;
  if not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception '308: service_role cannot execute crm_update_contact — every contact save would fail';
  end if;

  -- ── The rehearsal, on a made-up tenant; a sub-block's own exception rolls all of it back ──
  if exists (select 1 from public.crm_contacts where client_id = v_t) then
    raise exception '308: contacts on % already exist; the rehearsal will not touch them', v_t;
  end if;
  begin
    insert into public.crm_contacts (client_id, name, company, phone, phone_digits, email, source)
    values (v_t, 'Pat Rehearsal', 'Wrong Barns', '(555) 010-3080', public.crm_phone_key('(555) 010-3080'), 'pat.m308@example.invalid', 'manual')
    returning id into v_id;

    -- The fix itself: only the company moves, and it is logged.
    v_n := public.crm_update_contact(p_client_id => v_t, p_id => v_id, p_company => '  Right Barns ');
    select * into v_c from public.crm_contacts where id = v_id;
    if v_n <> 1 or v_c.company is distinct from 'Right Barns' then
      raise exception '308: the company did not change (% fields, company %)', v_n, v_c.company;
    end if;
    if v_c.name <> 'Pat Rehearsal' or v_c.phone_digits <> '5550103080' or v_c.email <> 'pat.m308@example.invalid' then
      raise exception '308: changing the company moved another field';
    end if;
    if (select count(*) from public.crm_field_changes
         where contact_id = v_id and field = 'company' and old_value = 'Wrong Barns' and new_value = 'Right Barns') <> 1 then
      raise exception '308: the company change was not logged';
    end if;

    -- NULL leaves it alone: a save that only renames the person keeps the company.
    v_n := public.crm_update_contact(p_client_id => v_t, p_id => v_id, p_name => 'Pat R');
    if v_n <> 1 or (select company from public.crm_contacts where id = v_id) is distinct from 'Right Barns' then
      raise exception '308: a save without a company changed it';
    end if;

    -- The same value again is not a change: nothing logged, nothing bumped.
    v_n := public.crm_update_contact(p_client_id => v_t, p_id => v_id, p_company => 'Right Barns');
    if v_n <> 0 then raise exception '308: re-saving the same company counted % change(s)', v_n; end if;

    -- 188's 15-argument named call (the live portal-settings') still resolves.
    v_n := public.crm_update_contact(p_client_id => v_t, p_id => v_id, p_name => null, p_phone => null,
      p_email => null, p_actor => null, p_street => '1 Rehearsal Rd', p_city => null, p_state => null,
      p_zip => null, p_owner => null, p_billing_street => null, p_billing_city => null,
      p_billing_state => null, p_billing_zip => null);
    if v_n <> 1 or (select company from public.crm_contacts where id = v_id) is distinct from 'Right Barns' then
      raise exception '308: the 15-argument call did not save, or touched the company';
    end if;

    -- Spaces clear it, and the clear is logged too.
    v_n := public.crm_update_contact(p_client_id => v_t, p_id => v_id, p_company => '   ');
    if v_n <> 1 or (select company from public.crm_contacts where id = v_id) is not null then
      raise exception '308: spaces did not clear the company';
    end if;
    if (select count(*) from public.crm_field_changes
         where contact_id = v_id and field = 'company' and old_value = 'Right Barns' and new_value is null) <> 1 then
      raise exception '308: clearing the company was not logged';
    end if;

    -- 200 characters at most, crm_create_lead's cap.
    v_n := public.crm_update_contact(p_client_id => v_t, p_id => v_id, p_company => repeat('x', 250));
    if length((select company from public.crm_contacts where id = v_id)) <> 200 then
      raise exception '308: a 250-character company was stored at % characters', length((select company from public.crm_contacts where id = v_id));
    end if;

    -- Another tenant's contact is "not found", never written.
    begin
      perform public.crm_update_contact(p_client_id => '__m308_other__', p_id => v_id, p_company => 'Stolen Barns');
      raise exception '308: another tenant renamed this contact''s company';
    exception when no_data_found then null;
    end;

    raise exception using errcode = 'S3080', message = 'company set, kept, re-saved, kept by a 15-argument call, cleared, capped at 200; another tenant refused';
  exception when sqlstate 'S3080' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.crm_contacts where client_id = v_t) then
    raise exception '308: the rehearsal contact was not rolled back';
  end if;
  perform set_config('ss.m308_rehearsal', v_out, true);
  raise notice '308: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. Expected:
--   signature 'crm_update_contact(text,uuid,text,text,text,uuid,text,text,text,text,text,text,text,text,text,text)',
--   overloads 1,
--   rehearsal 'company set, kept, re-saved, kept by a 15-argument call, cleared, capped at 200; another tenant refused'
select
  '308' as migration,
  (select string_agg(p.oid::regprocedure::text, '; ') from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'crm_update_contact') as signature,
  (select count(*)::int from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'crm_update_contact') as overloads,
  current_setting('ss.m308_rehearsal', true) as rehearsal;

commit;
