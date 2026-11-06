-- 318_designs_contact_company.sql — a quote to a business fills the CRM contact's company.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Run this file with `supabase db query --linked
--    --file` (it is over 30 KB, past the inline limit), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('318', '318_designs_contact_company') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;. THE RECORD at the end is
--    what the apply shows; no row printed means the file did not run. To see the same row and
--    change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-10-21: 317 is the newest, and several planned changes want 318 (the transom,
-- client deletion, tax tracking). Take the next free number at apply time, renaming this file, its
-- test (tests/sql/migration318.test.cjs) and every '318' below; record the ledger row with
-- `returning`: no row back means the number was taken.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Junior Barns (portal feedback, 2026-10-14): "We need a field for a business or organization
-- name in addition to the main point of contact ... Bear River Band communications all say
-- "Hi Bear" which is embarrassing because I am working with a guy named Thomas". Carolyn, 10-19:
-- "quote to a business entity. Yes, we need to add this." The designer now asks for an optional
-- Company / organization beside the person's Name and keeps it in the quote's snapshot as
-- designs.contact.company. The CRM has held a company since 301 (crm_contacts.company, editable
-- since 308), but save_design only ever hands crm_ensure_contact a name, phone and email, so a
-- company typed on a quote never reached the contact it files under.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1 — designs → crm_contacts.company. crm_fill_contact_company(tenant, contact, snapshot)
--     sets the contact's company from the snapshot's, ONLY where the contact has none (blank or
--     null), only on that tenant's own live contact, one line, 200 characters (crm_create_lead's
--     cap), and logs one crm_field_changes 'company' row (old empty, changed_by null: the
--     system did it, from the estimate). It never overwrites: a company someone fixed in ✎ Edit
--     wins over every later quote. An AFTER INSERT OR UPDATE OF contact_id, contact trigger on
--     designs calls it, skipping an update where neither column really moved (so a company
--     cleared by hand is not put back by the next unrelated save). save_design is NOT redefined.
--     A failure inside never fails the design write; it lands in app_errors (302's pattern).
--   PART 2 — the GoHighLevel import gains the company. crm_import_ghl_contacts is 282's body
--     BYTE FOR BYTE (md5 3829a6aa… checked against live below, and a drifted live copy refuses
--     the file) plus three splices marked "318": a `company` key on a row is read like the name
--     and fills a blank company, never a set one, on the contact the row matched without a
--     conflict. _shared/ghlContactImport.ts sends it (companyName), and no longer puts the
--     company into the NAME of a contact who has no first or last name in GoHighLevel.
--   No table, no column, no data change.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Production's designer sends no company, so no design snapshot it writes carries one and the
-- trigger does nothing for it. The live portal-settings sends no `company` key to the import, so
-- PART 2 changes nothing until the new one is deployed. Both functions are service-role only.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
--   1. This file.
--   2. The edge functions (portal-settings first for the import; submit-estimate and the rest
--      read designs.contact.company and are no-ops without it).
--   3. The beta designer (the Company / organization box).
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- In one transaction:
--   drop trigger if exists designs_fill_contact_company on public.designs;
--   drop function if exists public.designs_fill_contact_company();
--   drop function if exists public.crm_fill_contact_company(text, uuid, jsonb);
--   -- re-run 282's create or replace of crm_import_ghl_contacts (its PART 2) verbatim, with its
--   -- comment, revoke and grant
--   notify pgrst, 'reload schema';
--   delete from supabase_migrations.schema_migrations where version = '318';
-- Companies already filled stay, with their 'company' changelog rows: they are what was typed.

begin;

set local lock_timeout = '5s';

do $pre$
declare
  v_md5 text;
begin
  if to_regclass('public.crm_contacts') is null or to_regclass('public.crm_field_changes') is null
     or to_regclass('public.designs') is null or to_regclass('public.app_errors') is null then
    raise exception '318: crm_contacts / crm_field_changes / designs / app_errors are missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'crm_contacts' and column_name = 'company') then
    raise exception '318: crm_contacts.company is missing (migration 301 not applied?)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'designs' and column_name = 'contact_id') then
    raise exception '318: designs.contact_id is missing (migration 130 not applied?)';
  end if;
  -- Carriage returns out first: a CRLF checkout applies the same body with CRs in it.
  select md5(replace(p.prosrc, chr(13), '')) into v_md5
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.oid = to_regprocedure('public.crm_import_ghl_contacts(text, jsonb, boolean)');
  if v_md5 is null then
    raise exception '318: crm_import_ghl_contacts is missing (migration 282 not applied?)';
  end if;
  -- 282's body as committed (and as live on 2026-10-21), or this file's own (a re-apply).
  if v_md5 not in ('3829a6aa3051bcfca029d9eaf80c4212', 'ac171e6d7bb13ef865e95b0c6ace2443') then
    raise exception '318: live crm_import_ghl_contacts has drifted from 282 (md5 %) -- splice by hand', v_md5;
  end if;
end
$pre$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — a design's company fills its contact's blank one
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- True when it filled the company. p_contact is the design's snapshot (designs.contact); only a
-- non-blank STRING `company` counts, the way _shared/customerNaming.ts companyOf reads it.
create or replace function public.crm_fill_contact_company(p_client_id text, p_contact_id uuid, p_contact jsonb)
returns boolean
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_company text;
begin
  if p_contact_id is null or p_client_id is null or jsonb_typeof(p_contact) is distinct from 'object'
     or jsonb_typeof(p_contact->'company') is distinct from 'string' then
    return false;
  end if;
  v_company := left(nullif(btrim(regexp_replace(p_contact->>'company', '[[:space:]]+', ' ', 'g')), ''), 200);
  if v_company is null then
    return false;
  end if;
  -- Only a blank one, on this tenant's own live contact. Never an overwrite.
  update public.crm_contacts c
     set company = v_company, updated_at = now()
   where c.id = p_contact_id
     and c.client_id = p_client_id
     and c.merged_into is null
     and coalesce(btrim(c.company), '') = '';
  if not found then
    return false;
  end if;
  insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
  values (p_client_id, p_contact_id, 'company', null, v_company, null);
  return true;
end
$fn$;

comment on function public.crm_fill_contact_company(text, uuid, jsonb) is
  'Quote to a business entity (318): fills crm_contacts.company from a design snapshot''s company, only where the contact has none, on the tenant''s own live contact, 200 characters, with a crm_field_changes ''company'' row. Never overwrites. Called by the designs_fill_contact_company trigger. service_role only.';

revoke execute on function public.crm_fill_contact_company(text, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_fill_contact_company(text, uuid, jsonb) to service_role;

create or replace function public.designs_fill_contact_company()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  if new.contact_id is null then
    return null;
  end if;
  -- An UPDATE naming the columns without moving them (save_design's upsert always sets contact)
  -- changes nothing here, so a company cleared on the contact by hand stays cleared.
  if tg_op = 'UPDATE' and old.contact_id is not distinct from new.contact_id
     and old.contact is not distinct from new.contact then
    return null;
  end if;
  begin
    perform public.crm_fill_contact_company(new.client_id, new.contact_id, new.contact);
  exception when others then
    -- ⛔ Never fail the design write.
    begin
      insert into public.app_errors (client_id, source, severity, code, message, context)
      values (new.client_id, 'db:designs_fill_contact_company', 'error', 'crm_company_fill_failed',
              'designs_fill_contact_company: ' || sqlerrm,
              jsonb_build_object('sqlstate', sqlstate, 'short_code', new.short_code, 'op', tg_op));
    exception when others then null;
    end;
  end;
  return null;
end
$fn$;

revoke execute on function public.designs_fill_contact_company() from public, anon, authenticated;

drop trigger if exists designs_fill_contact_company on public.designs;
create trigger designs_fill_contact_company
  after insert or update of contact_id, contact on public.designs
  for each row execute function public.designs_fill_contact_company();

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — the GoHighLevel import fills a blank company (282's function, three splices)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- p_rows: a JSON array of {name, company, phone, email, tags: [text], added_at: ISO text,
-- sms_dnd: boolean}, every key optional. Answers exactly 282's counts.
create or replace function public.crm_import_ghl_contacts(
  p_client_id text, p_rows jsonb, p_dry_run boolean default true
) returns jsonb
language plpgsql security definer set search_path to ''
as $fn$
declare
  v_dry       boolean := coalesce(p_dry_run, true);
  v_row       jsonb;
  v_name      text;
  v_phone     text;
  v_email     text;
  v_key       text;
  v_email_key text;
  v_tags      text[];
  v_added     timestamptz;
  v_id        uuid;
  v_new       boolean;
  v_known     uuid[];
  v_dnd       boolean;
  v_sent_email text;
  v_conflict  boolean;
  v_company   text;      -- 318
  v_co_conflict boolean; -- 318
  n_created     integer := 0;
  n_matched     integer := 0;
  n_no_identity integer := 0;
  n_conflicts   integer := 0;
  n_labelled    integer := 0;
  n_opted_out   integer := 0;
  n_split       integer := 0;
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'crm_import_ghl_contacts: no tenant' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'crm_import_ghl_contacts: p_rows must be a JSON array' using errcode = '22023';
  end if;
  -- portal-settings sends 100 (GoHighLevel's page). A bound, so one call cannot hold the resolver's
  -- locks for an unbounded time.
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'crm_import_ghl_contacts: at most 500 rows per call, got %', jsonb_array_length(p_rows)
      using errcode = '22023';
  end if;

  -- Rows that already carry this transaction's timestamp are not this call's to count as new (see
  -- the header's SOURCE rule). One read per call, not per row.
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_known
    from public.crm_contacts c where c.client_id = p_client_id and c.created_at = now();

  -- THE DRY RUN'S SAVEPOINT. Everything below runs for real; a dry run then raises S2820, which only
  -- this block catches, and every write inside it is undone. Plain variables survive the rollback,
  -- which is how the counts get out.
  begin
    for v_row in select e.value from jsonb_array_elements(p_rows) as e(value) loop
      if jsonb_typeof(v_row) is distinct from 'object' then
        n_no_identity := n_no_identity + 1;
        continue;
      end if;
      v_name  := nullif(btrim(coalesce(v_row->>'name', '')), '');
      v_phone := nullif(btrim(coalesce(v_row->>'phone', '')), '');
      v_email := nullif(btrim(coalesce(v_row->>'email', '')), '');
      -- THE COMPANY (318): a string or nothing, one line, 200 characters (crm_create_lead's cap).
      v_company := case when jsonb_typeof(v_row->'company') = 'string'
        then left(nullif(btrim(regexp_replace(v_row->>'company', '[[:space:]]+', ' ', 'g')), ''), 200) end;
      v_key       := public.crm_phone_key(v_phone);
      v_email_key := lower(v_email);
      -- The JSON true and nothing else: a string, a number or junk is not a do-not-disturb, and a
      -- `::boolean` cast would throw on junk and fail the page.
      v_dnd       := coalesce(v_row->'sms_dnd' = 'true'::jsonb, false);

      -- crm_ensure_contact's own first rule, asked first so a row with nothing to match on does not
      -- take the resolver's lock. Same test: crm_phone_key, and a non-blank email.
      if v_key is null and v_email is null then
        n_no_identity := n_no_identity + 1;
        continue;
      end if;

      -- DO NOT TEXT (see the header): the opt-out belongs to the phone, so it is recorded before the
      -- resolver and stays whatever happens to the contact (even a row skipped as a conflict below).
      if v_key is not null and v_dnd then
        insert into public.sms_opt_outs (client_id, phone_digits, reason, note)
          values (p_client_id, v_key, 'import', 'GoHighLevel do-not-disturb')
          on conflict (client_id, phone_digits) do nothing;
        if found then
          n_opted_out := n_opted_out + 1;
        end if;
      end if;

      -- Tags: strings only, trimmed, blank ones dropped, at most 60 characters, first 25 in order.
      select coalesce(array_agg(s.t order by s.o), '{}'::text[]) into v_tags
        from (select left(btrim(e.value #>> '{}'), 60) as t, min(e.ord) as o
                from jsonb_array_elements(
                       case when jsonb_typeof(v_row->'tags') = 'array' then v_row->'tags' else '[]'::jsonb end
                     ) with ordinality as e(value, ord)
               where jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> ''
               group by 1
               order by 2
               limit 25) s;

      -- GoHighLevel's "date added". Anything unreadable, before 2000 or in the future is ignored.
      v_added := null;
      if jsonb_typeof(v_row->'added_at') = 'string' then
        begin
          v_added := (v_row->>'added_at')::timestamptz;
        exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
          v_added := null;
        end;
        if v_added < timestamptz '2000-01-01 00:00:00+00' or v_added > now() then
          v_added := null;
        end if;
      end if;

      -- The resolver, with NO name (see the header: names fill a blank, below). Only a
      -- unique_violation is absorbed (see the header), per row, so one racing number costs that row
      -- and not the page. Inside it, the one check the resolver cannot make (see the header: an
      -- email another live contact already holds): when the call put the row's email on the phone's
      -- contact while another live contact on the tenant holds it, S2822 undoes that call alone and
      -- the phone is resolved by itself. `v_sent_email` is the email the resolver was finally given.
      v_sent_email := v_email_key;
      begin
        begin
          v_id := public.crm_ensure_contact(p_client_id, null, v_phone, v_email);
          if v_key is not null and v_email_key is not null
             and exists (select 1 from public.crm_contacts c where c.id = v_id and c.email_lower = v_email_key)
             and exists (select 1 from public.crm_contacts c
                          where c.client_id = p_client_id and c.merged_into is null
                            and c.email_lower = v_email_key and c.id <> v_id) then
            raise exception using errcode = 'S2822', message = 'crm_import_ghl_contacts: email belongs to another contact';
          end if;
        exception when sqlstate 'S2822' then
          v_id := public.crm_ensure_contact(p_client_id, null, v_phone, null);
          v_sent_email := null;
          n_split := n_split + 1;
        end;
      exception when unique_violation then
        n_conflicts := n_conflicts + 1;
        continue;
      end;
      if v_id is null then
        n_no_identity := n_no_identity + 1;
        continue;
      end if;

      -- DO NOT TEXT on the contact too, but only when the do-not-disturb phone is the contact's own:
      -- a second person's number must not block the contact's main one.
      if v_key is not null and v_dnd then
        update public.crm_contacts set sms_opt_out_at = now()
         where id = v_id and phone_digits = v_key and sms_opt_out_at is null;
      end if;

      select c.created_at = now() into v_new from public.crm_contacts c where c.id = v_id;
      if coalesce(v_new, false) and not (v_id = any(v_known)) then
        n_created := n_created + 1;
        v_known := v_known || v_id;
        -- The resolver inserts with the column default ('design'). Only a row this call made is
        -- relabelled, and only from that default.
        update public.crm_contacts set source = 'ghl_import' where id = v_id and source = 'design';
      else
        n_matched := n_matched + 1;
      end if;

      -- The name, only where there is none: on the contact when the row matched it without a
      -- conflict, and on a second person the resolver recorded for one of this row's channels (it
      -- was given no name to put there). A conflict is what 191 calls one: a channel the row sent
      -- that the contact holds differently, which the resolver left as it was. With no conflict the
      -- resolver has just written the row's phone and email onto the contact, so they agree.
      if v_name is not null then
        select (v_key is not null and coalesce(c.phone_digits, '') <> v_key)
            or (v_sent_email is not null and coalesce(c.email_lower, '') <> v_sent_email)
          into v_conflict
          from public.crm_contacts c where c.id = v_id;
        if not coalesce(v_conflict, false) then
          update public.crm_contacts set name = v_name where id = v_id and coalesce(btrim(name), '') = '';
        end if;
        update public.crm_contact_people p set name = v_name
         where p.contact_id = v_id and coalesce(btrim(p.name), '') = ''
           and ((v_key is not null and p.phone_digits = v_key) or (v_sent_email is not null and p.email_lower = v_sent_email));
      end if;

      -- THE COMPANY (318), by the name's rule: only where the contact has none, and only when the
      -- row matched it without a conflict. Its own conflict test, because v_conflict above is only
      -- worked out for a row that carries a name.
      if v_company is not null then
        select (v_key is not null and coalesce(c.phone_digits, '') <> v_key)
            or (v_sent_email is not null and coalesce(c.email_lower, '') <> v_sent_email)
          into v_co_conflict
          from public.crm_contacts c where c.id = v_id;
        if not coalesce(v_co_conflict, false) then
          update public.crm_contacts set company = v_company where id = v_id and coalesce(btrim(company), '') = '';
        end if;
      end if;

      if cardinality(v_tags) > 0 then
        update public.crm_contacts c
           set labels = (select coalesce(array_agg(distinct u.l), '{}'::text[])
                           from unnest(c.labels || v_tags) as u(l))
         where c.id = v_id and not (c.labels @> v_tags);
        if found then
          n_labelled := n_labelled + 1;
        end if;
      end if;

      if v_added is not null then
        update public.crm_contacts set first_seen_at = v_added where id = v_id and first_seen_at > v_added;
      end if;
    end loop;

    if v_dry then
      raise exception using errcode = 'S2820', message = 'crm_import_ghl_contacts: dry run rolled back';
    end if;
  exception when sqlstate 'S2820' then
    null;
  end;

  return jsonb_build_object(
    'dry_run', v_dry,
    'rows', jsonb_array_length(p_rows),
    'created', n_created,
    'matched', n_matched,
    'no_identity', n_no_identity,
    'conflicts', n_conflicts,
    'labelled', n_labelled,
    'opted_out', n_opted_out,
    'split', n_split
  );
end $fn$;

comment on function public.crm_import_ghl_contacts(text, jsonb, boolean) is
  'GoHighLevel contact import (migration 282; company since 318): one page of {name, company, phone, email, tags, added_at, sms_dnd} rows through '
  'crm_ensure_contact. New contacts get source ghl_import, a name and a company only fill a blank (never rename), an email another '
  'live contact holds is left with it, tags are added to labels, an earlier GoHighLevel date added moves first_seen_at '
  'back, a do-not-disturb phone goes into sms_opt_outs (reason import). p_dry_run (default true) runs the page and rolls '
  'it back. Returns counts only. Called by portal-settings crm_import_ghl_contacts. service_role only.';

revoke execute on function public.crm_import_ghl_contacts(text, jsonb, boolean) from public, anon, authenticated;
grant  execute on function public.crm_import_ghl_contacts(text, jsonb, boolean) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- CHECKS: raise (and so roll the whole file back) rather than commit a surprise
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_fill  constant text := 'public.crm_fill_contact_company(text, uuid, jsonb)';
  v_imp   constant text := 'public.crm_import_ghl_contacts(text, jsonb, boolean)';
  v_t     constant text := '__m318_rehearsal__';
  v_o     constant text := '__m318_other__';
  v_role  text;
  v_def   text;
  v_c1    uuid;
  v_c2    uuid;
  v_c3    uuid;
  v_c4    uuid;
  v_junk  jsonb;
  v_r     jsonb;
  v_out   text;
  v_ok    boolean;
  v_ok2   boolean;
begin
  -- ── The trigger, on the two columns that say whose company it is ──
  select pg_get_triggerdef(t.oid) into v_def from pg_catalog.pg_trigger t
   where t.tgrelid = 'public.designs'::regclass and t.tgname = 'designs_fill_contact_company' and not t.tgisinternal;
  if v_def is null or v_def not like '%AFTER INSERT OR UPDATE OF contact_id, contact ON public.designs FOR EACH ROW EXECUTE FUNCTION designs_fill_contact_company()%' then
    raise exception '318: the designs trigger is missing or wrong (%)', coalesce(v_def, 'none');
  end if;

  -- ── Both functions SECURITY DEFINER and service_role only ──
  if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fill::regprocedure)
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_imp::regprocedure) then
    raise exception '318: a function is not SECURITY DEFINER';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_role, v_fill, 'execute') then
      raise exception '318: % can execute crm_fill_contact_company', v_role;
    end if;
    if has_function_privilege(v_role, v_imp, 'execute') then
      raise exception '318: % can execute crm_import_ghl_contacts', v_role;
    end if;
  end loop;
  if not has_function_privilege('service_role', v_fill, 'execute') or not has_function_privilege('service_role', v_imp, 'execute') then
    raise exception '318: service_role cannot execute the functions';
  end if;

  -- ── The import is 282's function plus the 318 splices, and nothing else ──
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'crm_import_ghl_contacts') <> 1 then
    raise exception '318: expected exactly 1 crm_import_ghl_contacts';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_catalog.pg_proc p where p.oid = v_imp::regprocedure) <> 'ac171e6d7bb13ef865e95b0c6ace2443' then
    raise exception '318: crm_import_ghl_contacts is not the body this file carries';
  end if;

  -- ── The rehearsal, on made-up tenants; a sub-block's own exception rolls all of it back ──
  if exists (select 1 from public.crm_contacts where client_id in (v_t, v_o)) then
    raise exception '318: contacts on % / % already exist; the rehearsal will not touch them', v_t, v_o;
  end if;
  begin
    insert into public.crm_contacts (client_id, name, company, phone, phone_digits, email, source)
    values (v_t, 'Pat Rehearsal', null, '(555) 010-3180', public.crm_phone_key('(555) 010-3180'), 'pat.m318@example.invalid', 'manual')
    returning id into v_c1;
    insert into public.crm_contacts (client_id, name, company, phone, phone_digits, email, source)
    values (v_t, 'Kept Rehearsal', 'Kept Farm', '(555) 010-3182', public.crm_phone_key('(555) 010-3182'), null, 'manual')
    returning id into v_c2;
    insert into public.crm_contacts (client_id, name, company, phone, phone_digits, email, source)
    values (v_o, 'Other Rehearsal', null, '(555) 010-3183', public.crm_phone_key('(555) 010-3183'), null, 'manual')
    returning id into v_c3;
    insert into public.crm_contacts (client_id, name, company, phone, phone_digits, email, source)
    values (v_t, 'Blank Rehearsal', '  ', '(555) 010-3187', public.crm_phone_key('(555) 010-3187'), null, 'manual')
    returning id into v_c4;

    -- A blank company is filled, one clean line, and logged. Each call is its own statement: a
    -- check in the same expression reads the row from before the call (one statement, one snapshot).
    v_ok := public.crm_fill_contact_company(v_t, v_c1, jsonb_build_object('company', E'  Rehearsal \n  Farm ', 'name', 'Pat Rehearsal'));
    if not v_ok or (select company from public.crm_contacts where id = v_c1) is distinct from 'Rehearsal Farm' then
      raise exception '318: a blank company was not filled (%)', (select company from public.crm_contacts where id = v_c1);
    end if;
    if (select count(*) from public.crm_field_changes
         where contact_id = v_c1 and client_id = v_t and field = 'company' and old_value is null and new_value = 'Rehearsal Farm' and changed_by is null) <> 1 then
      raise exception '318: the fill was not logged';
    end if;
    -- Never an overwrite: the one just filled, and one that was set from the start.
    v_ok := public.crm_fill_contact_company(v_t, v_c1, '{"company": "Other Farm"}');
    v_ok2 := public.crm_fill_contact_company(v_t, v_c2, '{"company": "Other Farm"}');
    if v_ok or v_ok2
       or (select company from public.crm_contacts where id = v_c1) is distinct from 'Rehearsal Farm'
       or (select company from public.crm_contacts where id = v_c2) is distinct from 'Kept Farm' then
      raise exception '318: a company already on the contact was overwritten';
    end if;
    -- Another tenant's contact, named by a design on this one.
    v_ok := public.crm_fill_contact_company(v_t, v_c3, '{"company": "Stolen Farm"}');
    if v_ok or (select company from public.crm_contacts where id = v_c3) is not null then
      raise exception '318: another tenant''s contact was filled';
    end if;
    -- Nothing that is not a non-blank string is a company.
    foreach v_junk in array array['{}'::jsonb, '{"company": ""}', '{"company": "   "}', '{"company": 7}', '"Farm"', 'null'] loop
      if public.crm_fill_contact_company(v_t, v_c4, v_junk) then
        raise exception '318: % filled a company', v_junk;
      end if;
    end loop;
    if public.crm_fill_contact_company(v_t, null, '{"company": "No Contact"}') then
      raise exception '318: a design with no contact filled a company';
    end if;
    -- A blank of spaces counts as blank; 200 characters at most.
    perform public.crm_fill_contact_company(v_t, v_c4, jsonb_build_object('company', repeat('y', 240)));
    if (select length(company) from public.crm_contacts where id = v_c4) is distinct from 200 then
      raise exception '318: a 240-character company was stored at % characters', (select length(company) from public.crm_contacts where id = v_c4);
    end if;

    -- The import: a new contact takes its company, a set one is kept, a blank is no company.
    v_r := public.crm_import_ghl_contacts(v_t, '[
      {"name": "Robin Rehearsal", "phone": "(555) 010-3184", "company": "Import Farm"},
      {"phone": "(555) 010-3182", "company": "Not Kept Farm"},
      {"name": "Sam Rehearsal", "phone": "(555) 010-3185", "company": "   "}
    ]'::jsonb, false);
    if (select company from public.crm_contacts where client_id = v_t and phone_digits = '5550103184') is distinct from 'Import Farm' then
      raise exception '318: the import did not fill the company';
    end if;
    if (select company from public.crm_contacts where id = v_c2) is distinct from 'Kept Farm' then
      raise exception '318: the import overwrote a company';
    end if;
    if (select company from public.crm_contacts where client_id = v_t and phone_digits = '5550103185') is not null then
      raise exception '318: the import stored a blank company';
    end if;
    if (v_r->>'created') is distinct from '2' or (v_r->>'matched') is distinct from '1' then
      raise exception '318: the import counts moved (%)', v_r;
    end if;
    -- A dry run keeps nothing.
    perform public.crm_import_ghl_contacts(v_t, '[{"phone": "(555) 010-3186", "company": "Dry Farm"}]'::jsonb, true);
    if exists (select 1 from public.crm_contacts where client_id = v_t and phone_digits = '5550103186') then
      raise exception '318: a dry run kept a row';
    end if;

    raise exception using errcode = 'S3180', message = 'filled a blank and logged it, kept two set companies, refused another tenant and six non-companies, capped at 200; the import filled one, kept one, skipped a blank; a dry run kept nothing';
  exception when sqlstate 'S3180' then
    v_out := sqlerrm;
  end;
  if exists (select 1 from public.crm_contacts where client_id in (v_t, v_o)) then
    raise exception '318: the rehearsal contacts were not rolled back';
  end if;
  perform set_config('ss.m318_rehearsal', v_out, true);
  raise notice '318: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. Expected:
--   trigger 'AFTER INSERT OR UPDATE OF contact_id, contact', import_md5 'ac171e6d7bb13ef865e95b0c6ace2443',
--   rehearsal 'filled a blank and logged it, … a dry run kept nothing'
select
  '318' as migration,
  (select substring(pg_get_triggerdef(t.oid) from 'AFTER [A-Z ,_a-z]+ ON') from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.designs'::regclass and t.tgname = 'designs_fill_contact_company') as trigger,
  (select md5(replace(p.prosrc, chr(13), '')) from pg_catalog.pg_proc p
    where p.oid = to_regprocedure('public.crm_import_ghl_contacts(text, jsonb, boolean)')) as import_md5,
  current_setting('ss.m318_rehearsal', true) as rehearsal;

commit;
