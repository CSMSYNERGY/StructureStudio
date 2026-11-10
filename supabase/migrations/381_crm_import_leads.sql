-- 381_crm_import_leads.sql — a spreadsheet of leads comes into the built-in CRM: each row a contact,
-- and a deal on the pipeline the builder picked, dry run first, never twice.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Run this file as ONE statement batch (stdin to
--    `supabase db query --linked`, or the Supabase connector's execute_sql; NOT `--file`, see 270's
--    header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('381', '381_crm_import_leads') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, run it with the last `commit;` swapped for `rollback;`.
--
-- ⛔ APPLYING THIS IMPORTS NOTHING. It adds two functions nobody calls yet. The import is
--    portal-settings' crm_import_leads (contacts:edit, the Customer Hub subscription, a dry run
--    unless the request says `dryRun: false`), driven by the Import button on the Contacts hub.
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- Live ledger 2026-11-10: 370 and 374-380 are applied, so this takes 381 (max of the ledger and this
-- folder, plus one; 371-373 are a gap someone else may hold). Re-read both at apply time and take
-- the next free number, renaming this file, its test (tests/sql/migration381.test.cjs) and every
-- '381' below; record the ledger row with `returning`: no row back means the number was taken.
--   select max(version) from supabase_migrations.schema_migrations where version ~ '^\d{3}$';
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-11-06: "We need to have a way to import leads into Structure Studio." Two lists on
-- day one: her reps' cold-call lists of shed manufacturers (a company, often no person), and a
-- builder's customer list exported from GoHighLevel or another CRM. 301 named "CSV import" as a lead
-- source in October and reserved this shape (crm_create_lead's 'import' source, IMPORT_PAGE_MAX);
-- number 306 was held for it on a branch that never landed. crm_create_lead itself cannot be the
-- import: with p_on_match 'attach' it still inserts a deal every time it is given a stage, so a
-- re-run would put every lead on the board twice.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1   public.crm_import_leads_text(value, cap): one JSON value as a trimmed one-line string,
--            or null. A helper so the importer reads twelve fields the same way.
--   PART 2   public.crm_import_leads(client, rows, opts, actor, dry_run): one page (at most 200 rows;
--            portal-settings sends IMPORT_PAGE_MAX) in ONE call, a few indexed statements a row,
--            far inside the 8 s statement_timeout PostgREST runs every call under.
--   PART 3   checks, and a rehearsal on a made-up tenant that is rolled back.
--
-- ── THE RULES THE FUNCTION KEEPS ─────────────────────────────────────────────────────────
--   * MATCHING is crm_ensure_contact's (191), lifted inline: phone key, then email, each checking
--     the contact and then its second people, live contacts only, oldest first, under 191's
--     advisory lock for that identity. Inline rather than a call because the resolver renames (the
--     newest name wins) and takes no company, address, owner, tags or custom fields; 282 had to work
--     around both.
--   * A ROW NEEDS A WAY TO REACH THEM (a phone of 7+ digits or an email) — `no_identity` — and a
--     name or a company unless it matched someone — `no_name`. Both are refusals: nothing written.
--   * A MATCH THE IMPORTER CANNOT SEE IS LEFT ALONE. With opts.viewer set (portal-settings sets it
--     for someone limited to their own customers), a matched contact that crm_visible_contact_ids
--     (193) does not return is refused as `not_yours` and nothing about it is written. An unassigned
--     contact is everybody's (193's rule), so it is not refused.
--   * opts.on_match 'skip': a matched contact is counted (`matched_skipped`) and left exactly as it
--     is, no deal either. 'attach' (the default) enriches it:
--   * ENRICH, NEVER OVERWRITE. On a match: name, company and address fill a BLANK, and only when the
--     row agrees with the contact (no conflicting channel, 191's rule: a different phone or email
--     means a second person, whose name is not the contact's). A phone or email fills a blank only
--     when no other live contact on the tenant holds it (301's rule). Tags are added (a union).
--     first_seen_at moves back to the row's date added, never forward. Custom fields fill blanks.
--     The owner and the source are never changed.
--   * A SECOND CHANNEL: a matched contact whose stored phone (or email) differs from the row's gets
--     the row's as a second person (crm_contact_people, source 'import', the row's name), unless
--     one of its people already holds it. Counted as `people_added`.
--   * A NEW CONTACT: source 'import'; owner opts.force_owner, else the row's owner, else
--     opts.default_owner, each only if they are on this tenant's team; the owner logged in
--     crm_field_changes as 301 logs one.
--   * DEALS: on opts.pipeline only, at the row's stage, else opts.default_stage, else none. A row
--     naming a stage that is not a live stage of that pipeline is refused (`stage_missing`: it was
--     removed after the preview) before anything is written. ONE CARD PER PERSON PER PIPELINE: a
--     contact with any deal on that pipeline that is not archived — LOST INCLUDED — gets no second
--     one (`already_in_pipeline`), so a re-run never resurrects a lead a rep marked lost; Reopen on
--     the card is how that is done. A new deal: source 'import', created_by the actor, its first
--     stage-change row, its status from 354's trigger, deal custom fields.
--   * NOTES: a row's note is one crm_notes row, unless that contact already has a live note with
--     exactly that text.
--   * DO NOT TEXT: do_not_text (JSON true only) puts the phone in sms_opt_outs (reason 'import'), and
--     sets the contact's sms_opt_out_at when it is the contact's own phone (282's rule).
--   * Only unique_violation is absorbed, per row (`conflict`: two writers racing for one new number),
--     and that row's writes are undone; a re-run picks it up. Anything else fails the page.
--   * DRY RUN (the default) runs the page for real inside a block that is then rolled back, so the
--     counts are the real path's and nothing is kept. Exact within a page; the dialog merges one
--     person's repeated rows before paging, so it is exact across pages too.
--   * NUMBERS AND ROW NUMBERS ONLY. The answer is counts plus `refused`: [{row, code}]. No raise and
--     no answer carries a name, a number or an address.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * No consent: an imported contact has no texting permission until they give it.
--   * No GoHighLevel. The live pull (crm_import_ghl_contacts, 282) stays staff-only and our own
--     account only; a builder exports a CSV. Nothing here pushes anywhere either; a builder's
--     Automations may, through the rules a new contact queues (365).
--   * No undo. An import's rows carry source 'import' and their creation time, which is how to find
--     them; taking them back out is a decision about live records, not a schema step.
--   * Additional phones and emails columns, opportunities, message history.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Additive: two new functions and their grants. No table,
-- column, constraint or index changes, no lock on anything: 'import' is already a source contacts
-- (325), deals (325) and second people (190) accept. Both functions are service-role only
-- (Supabase's default privileges would hand them to anon; revoked from public too). The rehearsal
-- writes on a made-up tenant and is rolled back.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- This file FIRST, then portal-settings with crm_import_leads. Deployed ahead of this file the
-- action answers "isn't installed on this server yet" and writes nothing. Then the portal.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   drop function if exists public.crm_import_leads(text, jsonb, jsonb, uuid, boolean);
--   drop function if exists public.crm_import_leads_text(jsonb, integer);
--   delete from supabase_migrations.schema_migrations where version = '381';
-- Every contact, deal and note an import brought in stays: find them with
-- `select count(*) from crm_contacts where source = 'import'` and decide with a human.

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — one JSON value as text
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A string or a number (a phone typed as a number in Excel), whitespace collapsed, trimmed, capped;
-- null for anything else or blank.
create or replace function public.crm_import_leads_text(p_value jsonb, p_cap integer)
returns text
language sql
immutable
set search_path to ''
as $fn$
  select case when jsonb_typeof(p_value) in ('string', 'number')
    then left(nullif(btrim(regexp_replace(p_value #>> '{}', '[[:space:]]+', ' ', 'g')), ''), greatest(p_cap, 1))
  end;
$fn$;
revoke execute on function public.crm_import_leads_text(jsonb, integer) from public, anon, authenticated;
grant  execute on function public.crm_import_leads_text(jsonb, integer) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — one page of leads
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- p_rows: [{row, name, company, phone, email, street, city, state, zip, labels: [text], owner: uuid,
--   note, stage: uuid, title, value_cents, expected_close_date: yyyy-mm-dd, added_at: yyyy-mm-dd,
--   do_not_text: true, contact_custom: {}, deal_custom: {}}], every key but row optional.
-- p_opts: {pipeline, default_stage, on_match: attach|skip, default_owner, force_owner, viewer}.
create or replace function public.crm_import_leads(
  p_client_id text,
  p_rows      jsonb,
  p_opts      jsonb default '{}'::jsonb,
  p_actor     uuid default null,
  p_dry_run   boolean default true
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c_email constant text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  v_dry      boolean := coalesce(p_dry_run, true);
  v_opts     jsonb := coalesce(p_opts, '{}'::jsonb);
  v_pipeline uuid;
  v_default_stage uuid;
  v_on_match text;
  v_default_owner uuid;
  v_force_owner uuid;
  v_viewer   uuid;
  v_t        text;
  v_row      jsonb;
  v_rowno    integer;
  v_name     text;
  v_company  text;
  v_phone    text;
  v_digits   text;
  v_email    text;
  v_email_key text;
  v_street   text;
  v_city     text;
  v_state    text;
  v_zip      text;
  v_note     text;
  v_title    text;
  v_labels   text[];
  v_owner    uuid;
  v_stage    uuid;
  v_deal_stage uuid;
  v_value    bigint;
  v_close    date;
  v_added    timestamptz;
  v_dnd      boolean;
  v_ccustom  jsonb;
  v_dcustom  jsonb;
  v_patch    jsonb;
  v_key      text;
  v_val      jsonb;
  v_id       uuid;
  v_deal     uuid;
  v_old      public.crm_contacts%rowtype;
  v_phone_conflict boolean;
  v_email_conflict boolean;
  v_agrees   boolean;
  v_new_phone text;
  v_new_digits text;
  v_new_email text;
  v_ordinal  integer;
  -- This row's counts, added to the page's only when the row's writes stand (a unique_violation
  -- undoes them, and its counts must go with them).
  r_created boolean; r_matched boolean; r_deal boolean; r_already boolean; r_note boolean;
  r_labelled boolean; r_person boolean;
  n_created    integer := 0;
  n_matched    integer := 0;
  n_skipped    integer := 0;
  n_deals      integer := 0;
  n_already    integer := 0;
  n_not_yours  integer := 0;
  n_no_identity integer := 0;
  n_no_name    integer := 0;
  n_conflicts  integer := 0;
  n_notes      integer := 0;
  n_labelled   integer := 0;
  n_people     integer := 0;
  n_opted_out  integer := 0;
  v_refused    jsonb := '[]'::jsonb;
begin
  -- ── The page and its options. Fixed sentences: portal-settings maps them, and none carries a value.
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'crm_import_leads: no tenant' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'crm_import_leads: p_rows must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'crm_import_leads: at most 200 rows per call' using errcode = '22023';
  end if;
  if jsonb_typeof(v_opts) is distinct from 'object' then
    raise exception 'crm_import_leads: p_opts must be a JSON object' using errcode = '22023';
  end if;

  v_t := nullif(btrim(coalesce(v_opts->>'pipeline', '')), '');
  if v_t is not null then
    if v_t !~ c_uuid then raise exception 'pipeline not found' using errcode = 'no_data_found'; end if;
    select p.id into v_pipeline from public.crm_pipelines p
     where p.id = v_t::uuid and p.client_id = p_client_id and p.archived_at is null;
    if v_pipeline is null then raise exception 'pipeline not found' using errcode = 'no_data_found'; end if;
  end if;
  v_t := nullif(btrim(coalesce(v_opts->>'default_stage', '')), '');
  if v_t is not null then
    if v_pipeline is null or v_t !~ c_uuid then raise exception 'stage not found' using errcode = 'no_data_found'; end if;
    select s.id into v_default_stage from public.crm_pipeline_stages s
     where s.id = v_t::uuid and s.pipeline_id = v_pipeline and s.client_id = p_client_id and s.archived_at is null;
    if v_default_stage is null then raise exception 'stage not found' using errcode = 'no_data_found'; end if;
  end if;
  v_on_match := coalesce(nullif(btrim(coalesce(v_opts->>'on_match', '')), ''), 'attach');
  if v_on_match not in ('attach', 'skip') then
    raise exception 'crm_import_leads: on_match must be attach or skip' using errcode = '22023';
  end if;
  v_t := nullif(btrim(coalesce(v_opts->>'default_owner', '')), '');
  if v_t is not null then
    if v_t !~ c_uuid or not exists (select 1 from public.client_users u where u.user_id = v_t::uuid and u.client_id = p_client_id) then
      raise exception 'owner is not on this team' using errcode = 'foreign_key_violation';
    end if;
    v_default_owner := v_t::uuid;
  end if;
  v_t := nullif(btrim(coalesce(v_opts->>'force_owner', '')), '');
  if v_t is not null then
    if v_t !~ c_uuid or not exists (select 1 from public.client_users u where u.user_id = v_t::uuid and u.client_id = p_client_id) then
      raise exception 'owner is not on this team' using errcode = 'foreign_key_violation';
    end if;
    v_force_owner := v_t::uuid;
  end if;
  v_t := nullif(btrim(coalesce(v_opts->>'viewer', '')), '');
  if v_t is not null then
    if v_t !~ c_uuid then raise exception 'crm_import_leads: viewer must be a user id' using errcode = '22023'; end if;
    v_viewer := v_t::uuid;
  end if;

  -- THE DRY RUN'S SAVEPOINT (282's): everything below runs for real; a dry run then raises S3810,
  -- which only this block catches, and every write inside it is undone. Plain variables survive the
  -- rollback, which is how the counts get out.
  begin
    for v_row in select e.value from jsonb_array_elements(p_rows) as e(value) loop
      v_rowno := case when jsonb_typeof(v_row) = 'object' and (v_row->>'row') ~ '^[0-9]{1,7}$' then (v_row->>'row')::integer end;
      if jsonb_typeof(v_row) is distinct from 'object' then
        n_no_identity := n_no_identity + 1;
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('row', v_rowno, 'code', 'no_identity'));
        continue;
      end if;

      v_name    := public.crm_import_leads_text(v_row->'name', 200);
      v_company := public.crm_import_leads_text(v_row->'company', 200);
      v_phone   := public.crm_import_leads_text(v_row->'phone', 40);
      v_digits  := public.crm_phone_key(v_phone);
      if v_digits is not null and length(v_digits) < 7 then v_digits := null; v_phone := null; end if;
      v_email   := public.crm_import_leads_text(v_row->'email', 320);
      if v_email is not null and v_email !~ c_email then v_email := null; end if;
      v_email_key := lower(v_email);
      v_street  := public.crm_import_leads_text(v_row->'street', 200);
      v_city    := public.crm_import_leads_text(v_row->'city', 100);
      v_state   := public.crm_import_leads_text(v_row->'state', 100);
      v_zip     := public.crm_import_leads_text(v_row->'zip', 20);
      v_title   := public.crm_import_leads_text(v_row->'title', 200);
      v_note    := case when jsonb_typeof(v_row->'note') = 'string'
                     then left(nullif(btrim(replace(v_row->>'note', E'\r\n', E'\n')), ''), 8000) end;
      v_dnd     := coalesce(v_row->'do_not_text' = 'true'::jsonb, false);
      v_value   := case when jsonb_typeof(v_row->'value_cents') = 'number' and (v_row->>'value_cents') ~ '^[0-9]{1,15}$'
                     then (v_row->>'value_cents')::bigint end;
      v_close := null;
      if (v_row->>'expected_close_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        begin v_close := (v_row->>'expected_close_date')::date;
        exception when invalid_datetime_format or datetime_field_overflow then v_close := null; end;
      end if;
      v_added := null;
      if (v_row->>'added_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
        -- A bare day is that day at midnight UTC, whatever the server's time zone says.
        begin v_added := case when (v_row->>'added_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                              then ((v_row->>'added_at') || 'T00:00:00Z')::timestamptz
                              else (v_row->>'added_at')::timestamptz end;
        exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then v_added := null; end;
        if v_added < timestamptz '2000-01-01 00:00:00+00' or v_added > now() then v_added := null; end if;
      end if;
      -- Tags (282's rule): strings only, trimmed, blank ones dropped, 60 characters, the first 25.
      select coalesce(array_agg(s.t order by s.o), '{}'::text[]) into v_labels
        from (select left(btrim(e.value #>> '{}'), 60) as t, min(e.ord) as o
                from jsonb_array_elements(
                       case when jsonb_typeof(v_row->'labels') = 'array' then v_row->'labels' else '[]'::jsonb end
                     ) with ordinality as e(value, ord)
               where jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> ''
               group by 1 order by 2 limit 25) s;
      v_ccustom := case when jsonb_typeof(v_row->'contact_custom') = 'object' then v_row->'contact_custom' else '{}'::jsonb end;
      v_dcustom := case when jsonb_typeof(v_row->'deal_custom') = 'object' then v_row->'deal_custom' else '{}'::jsonb end;
      -- The row's owner counts only when they are on this team; otherwise the default applies.
      v_owner := null;
      if (v_row->>'owner') ~ c_uuid and exists (select 1 from public.client_users u
                                                where u.user_id = (v_row->>'owner')::uuid and u.client_id = p_client_id) then
        v_owner := (v_row->>'owner')::uuid;
      end if;

      -- A stage the row names must be a live stage of this pipeline. Checked before anything is
      -- written, so a stage removed since the preview costs the row and writes nothing.
      v_stage := null;
      if v_pipeline is not null and nullif(btrim(coalesce(v_row->>'stage', '')), '') is not null then
        if (v_row->>'stage') ~ c_uuid then
          select s.id into v_stage from public.crm_pipeline_stages s
           where s.id = (v_row->>'stage')::uuid and s.pipeline_id = v_pipeline
             and s.client_id = p_client_id and s.archived_at is null;
        end if;
        if v_stage is null then
          v_refused := v_refused || jsonb_build_array(jsonb_build_object('row', v_rowno, 'code', 'stage_missing'));
          continue;
        end if;
      end if;
      v_deal_stage := case when v_pipeline is null then null else coalesce(v_stage, v_default_stage) end;

      if v_digits is null and v_email_key is null then
        n_no_identity := n_no_identity + 1;
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('row', v_rowno, 'code', 'no_identity'));
        continue;
      end if;

      -- 191's lock for this identity, so a design saving the same person waits for this row.
      perform pg_advisory_xact_lock(hashtext('ss_crm_contact:' || p_client_id || ':' || coalesce(v_digits, v_email_key)));

      -- ── MATCHING: 191's four lookups, in 191's order ──
      v_id := null;
      if v_digits is not null then
        select c.id into v_id from public.crm_contacts c
         where c.client_id = p_client_id and c.phone_digits = v_digits and c.merged_into is null
         order by c.first_seen_at, c.id limit 1;
      end if;
      if v_id is null and v_digits is not null then
        select p.contact_id into v_id
          from public.crm_contact_people p join public.crm_contacts c on c.id = p.contact_id
         where p.client_id = p_client_id and p.phone_digits = v_digits
           and c.client_id = p_client_id and c.merged_into is null
         order by p.created_at, p.id limit 1;
      end if;
      if v_id is null and v_email_key is not null then
        select c.id into v_id from public.crm_contacts c
         where c.client_id = p_client_id and c.email_lower = v_email_key and c.merged_into is null
         order by c.first_seen_at, c.id limit 1;
      end if;
      if v_id is null and v_email_key is not null then
        select p.contact_id into v_id
          from public.crm_contact_people p join public.crm_contacts c on c.id = p.contact_id
         where p.client_id = p_client_id and p.email_lower = v_email_key
           and c.client_id = p_client_id and c.merged_into is null
         order by p.created_at, p.id limit 1;
      end if;

      if v_id is null and v_name is null and v_company is null then
        n_no_name := n_no_name + 1;
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('row', v_rowno, 'code', 'no_name'));
        continue;
      end if;
      if v_id is not null and v_viewer is not null
         and not (v_id = any(public.crm_visible_contact_ids(p_client_id, v_viewer, array[v_id]))) then
        n_not_yours := n_not_yours + 1;
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('row', v_rowno, 'code', 'not_yours'));
        continue;
      end if;

      -- DO NOT TEXT belongs to the phone, so it is recorded whatever happens to the contact below.
      if v_digits is not null and v_dnd then
        insert into public.sms_opt_outs (client_id, phone_digits, reason, note)
          values (p_client_id, v_digits, 'import', 'Imported as do not text')
          on conflict (client_id, phone_digits) do nothing;
        if found then n_opted_out := n_opted_out + 1; end if;
      end if;

      if v_id is not null and v_on_match = 'skip' then
        n_skipped := n_skipped + 1;
        continue;
      end if;

      r_created := false; r_matched := false; r_deal := false; r_already := false; r_note := false;
      r_labelled := false; r_person := false;
      begin
        if v_id is null then
          v_owner := coalesce(v_force_owner, v_owner, v_default_owner);
          insert into public.crm_contacts (client_id, name, company, phone, phone_digits, email,
                                           street, city, state, zip, owner_user_id, labels, source, first_seen_at)
          values (p_client_id, v_name, v_company, v_phone, v_digits, v_email,
                  v_street, v_city, v_state, v_zip, v_owner, v_labels, 'import', coalesce(v_added, now()))
          returning id into v_id;
          r_created := true;
          r_labelled := cardinality(v_labels) > 0;
          if v_owner is not null then
            insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
            values (p_client_id, v_id, 'owner', null, v_owner::text, p_actor);
          end if;
          -- Custom values: single values only (crm_set_custom refuses a list and would fail the page).
          v_patch := '{}'::jsonb;
          for v_key, v_val in select * from jsonb_each(v_ccustom) loop
            if jsonb_typeof(v_val) in ('string', 'number', 'boolean') then v_patch := v_patch || jsonb_build_object(v_key, v_val); end if;
          end loop;
          if v_patch <> '{}'::jsonb then perform public.crm_set_custom(p_client_id, 'contact', v_id, v_patch, p_actor); end if;
        else
          r_matched := true;
          select * into v_old from public.crm_contacts where id = v_id;
          v_phone_conflict := v_digits is not null and coalesce(v_old.phone_digits, '') <> '' and v_old.phone_digits <> v_digits;
          v_email_conflict := v_email_key is not null and coalesce(v_old.email_lower, '') <> '' and v_old.email_lower <> v_email_key;
          v_agrees := not (v_phone_conflict or v_email_conflict);
          -- A channel fills a blank only when no other live contact here holds it.
          v_new_phone := v_old.phone; v_new_digits := v_old.phone_digits; v_new_email := v_old.email;
          if coalesce(v_old.phone_digits, '') = '' and v_digits is not null
             and not exists (select 1 from public.crm_contacts o where o.client_id = p_client_id
                              and o.phone_digits = v_digits and o.merged_into is null and o.id <> v_id) then
            v_new_phone := v_phone; v_new_digits := v_digits;
          end if;
          if coalesce(btrim(v_old.email), '') = '' and v_email is not null
             and not exists (select 1 from public.crm_contacts o where o.client_id = p_client_id
                              and o.email_lower = v_email_key and o.merged_into is null and o.id <> v_id) then
            v_new_email := v_email;
          end if;
          update public.crm_contacts c set
            name    = case when v_agrees and coalesce(btrim(c.name), '') = '' then coalesce(v_name, c.name) else c.name end,
            company = case when v_agrees and coalesce(btrim(c.company), '') = '' then coalesce(v_company, c.company) else c.company end,
            street  = case when v_agrees and coalesce(btrim(c.street), '') = '' then coalesce(v_street, c.street) else c.street end,
            city    = case when v_agrees and coalesce(btrim(c.city), '') = '' then coalesce(v_city, c.city) else c.city end,
            state   = case when v_agrees and coalesce(btrim(c.state), '') = '' then coalesce(v_state, c.state) else c.state end,
            zip     = case when v_agrees and coalesce(btrim(c.zip), '') = '' then coalesce(v_zip, c.zip) else c.zip end,
            phone = v_new_phone, phone_digits = v_new_digits, email = v_new_email,
            updated_at = now()
          where c.id = v_id
            and (c.phone, c.phone_digits, c.email) is distinct from (v_new_phone, v_new_digits, v_new_email)
             or c.id = v_id and v_agrees and (
                  (coalesce(btrim(c.name), '') = '' and v_name is not null)
               or (coalesce(btrim(c.company), '') = '' and v_company is not null)
               or (coalesce(btrim(c.street), '') = '' and v_street is not null)
               or (coalesce(btrim(c.city), '') = '' and v_city is not null)
               or (coalesce(btrim(c.state), '') = '' and v_state is not null)
               or (coalesce(btrim(c.zip), '') = '' and v_zip is not null));

          if cardinality(v_labels) > 0 then
            update public.crm_contacts c
               set labels = (select coalesce(array_agg(distinct u.l), '{}'::text[]) from unnest(c.labels || v_labels) as u(l))
             where c.id = v_id and not (c.labels @> v_labels);
            r_labelled := found;
          end if;
          if v_added is not null then
            update public.crm_contacts set first_seen_at = v_added where id = v_id and first_seen_at > v_added;
          end if;
          -- Custom values fill blanks only.
          v_patch := '{}'::jsonb;
          for v_key, v_val in select * from jsonb_each(v_ccustom) loop
            if jsonb_typeof(v_val) in ('string', 'number', 'boolean')
               and coalesce(jsonb_typeof(v_old.custom->v_key), 'null') = 'null' then
              v_patch := v_patch || jsonb_build_object(v_key, v_val);
            end if;
          end loop;
          if v_patch <> '{}'::jsonb then perform public.crm_set_custom(p_client_id, 'contact', v_id, v_patch, p_actor); end if;

          -- THE SECOND CHANNEL (191's): a phone or email the contact holds differently goes on a
          -- second person, unless one of its people already holds it.
          if v_phone_conflict or v_email_conflict then
            if not exists (select 1 from public.crm_contact_people p where p.contact_id = v_id
                            and ((v_phone_conflict and p.phone_digits = v_digits)
                              or (v_email_conflict and p.email_lower = v_email_key))) then
              select coalesce(max(p.ordinal), 1) + 1 into v_ordinal from public.crm_contact_people p where p.contact_id = v_id;
              begin
                insert into public.crm_contact_people (client_id, contact_id, ordinal, name, phone, email, source)
                values (p_client_id, v_id, coalesce(v_ordinal, 2), v_name,
                        case when v_phone_conflict then v_phone end,
                        case when v_email_conflict then v_email end, 'import');
                r_person := true;
              exception when unique_violation then
                null;  -- 191's one arrangement the per-contact indexes refuse: both values are on the record already.
              end;
            end if;
          end if;
        end if;

        if v_digits is not null and v_dnd then
          update public.crm_contacts set sms_opt_out_at = now()
           where id = v_id and phone_digits = v_digits and sms_opt_out_at is null;
        end if;

        if v_note is not null and not exists (select 1 from public.crm_notes n
                                               where n.contact_id = v_id and n.deleted_at is null and n.body = v_note) then
          insert into public.crm_notes (client_id, contact_id, body, created_by) values (p_client_id, v_id, v_note, p_actor);
          r_note := true;
        end if;

        if v_deal_stage is not null then
          if exists (select 1 from public.crm_deals d where d.contact_id = v_id and d.pipeline_id = v_pipeline
                        and d.client_id = p_client_id and d.archived_at is null) then
            r_already := true;
          else
            insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, value_cents,
                                          expected_close_date, source, created_by)
            values (p_client_id, v_pipeline, v_deal_stage, v_id, v_title, v_value, v_close, 'import', p_actor)
            returning id into v_deal;
            insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by)
            values (p_client_id, v_deal, null, v_deal_stage, p_actor);
            v_patch := '{}'::jsonb;
            for v_key, v_val in select * from jsonb_each(v_dcustom) loop
              if jsonb_typeof(v_val) in ('string', 'number', 'boolean') then v_patch := v_patch || jsonb_build_object(v_key, v_val); end if;
            end loop;
            if v_patch <> '{}'::jsonb then perform public.crm_set_custom(p_client_id, 'deal', v_deal, v_patch, p_actor); end if;
            r_deal := true;
          end if;
        end if;
      exception when unique_violation then
        n_conflicts := n_conflicts + 1;
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('row', v_rowno, 'code', 'conflict'));
        continue;
      end;

      if r_created then n_created := n_created + 1; end if;
      if r_matched then n_matched := n_matched + 1; end if;
      if r_deal then n_deals := n_deals + 1; end if;
      if r_already then n_already := n_already + 1; end if;
      if r_note then n_notes := n_notes + 1; end if;
      if r_labelled then n_labelled := n_labelled + 1; end if;
      if r_person then n_people := n_people + 1; end if;
    end loop;

    if v_dry then
      raise exception using errcode = 'S3810', message = 'crm_import_leads: dry run rolled back';
    end if;
  exception when sqlstate 'S3810' then
    null;
  end;

  return jsonb_build_object(
    'dry_run', v_dry,
    'rows', jsonb_array_length(p_rows),
    'contacts_created', n_created,
    'contacts_matched', n_matched,
    'matched_skipped', n_skipped,
    'deals_created', n_deals,
    'already_in_pipeline', n_already,
    'not_yours', n_not_yours,
    'no_identity', n_no_identity,
    'no_name', n_no_name,
    'conflicts', n_conflicts,
    'notes_added', n_notes,
    'labelled', n_labelled,
    'people_added', n_people,
    'opted_out', n_opted_out,
    'refused', v_refused
  );
end $fn$;

comment on function public.crm_import_leads(text, jsonb, jsonb, uuid, boolean) is
  'Spreadsheet lead import (migration 381): one page (<=200) of rows into contacts and, on p_opts.pipeline, one deal per '
  'person per pipeline (lost included). Matching is crm_ensure_contact''s (phone, then email, people too); a match fills '
  'blanks only and never changes owner or source; p_opts.viewer refuses a match that user cannot see. p_dry_run (default '
  'true) runs the page and rolls it back. Returns counts and refused [{row, code}] only. Called by portal-settings '
  'crm_import_leads. service_role only.';

revoke execute on function public.crm_import_leads(text, jsonb, jsonb, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.crm_import_leads(text, jsonb, jsonb, uuid, boolean) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — checks, and a rehearsal that is rolled back. Raise, and so roll the whole file back,
-- rather than commit a surprise.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_role    text;
  v_fn      text;
  v_probe   constant text := '__m381_rehearsal__';
  v_pipe    uuid;
  v_s1      uuid;
  v_s2      uuid;
  v_other   uuid := gen_random_uuid();
  v_old     uuid;
  v_theirs  uuid;
  v_page    jsonb;
  v_opts    jsonb;
  v_dry     jsonb;
  v_real    jsonb;
  v_again   jsonb;
  v_skip    jsonb;
  v_extra   jsonb;
  v_err     text;
  v_c       public.crm_contacts%rowtype;
  v_left    integer;
  v_summary text;
begin
  -- ── The functions: definer, pinned search_path, service role only ──
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.crm_import_leads(text, jsonb, jsonb, uuid, boolean)'::regprocedure
       and p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'::text[]))
  ) then
    raise exception '381: crm_import_leads is not SECURITY DEFINER with an empty search_path';
  end if;
  foreach v_fn in array array['public.crm_import_leads(text, jsonb, jsonb, uuid, boolean)', 'public.crm_import_leads_text(jsonb, integer)'] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception '381: % can execute %', v_role, v_fn;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '381: service_role cannot execute % — portal-settings would fail', v_fn;
    end if;
  end loop;

  -- ── The rehearsal, on a made-up tenant, rolled back ──
  begin
    insert into public.crm_pipelines (client_id, name) values (v_probe, 'Rehearsal Pipeline') returning id into v_pipe;
    insert into public.crm_pipeline_stages (client_id, pipeline_id, name, position) values (v_probe, v_pipe, 'First', 1024) returning id into v_s1;
    insert into public.crm_pipeline_stages (client_id, pipeline_id, name, position) values (v_probe, v_pipe, 'Second', 2048) returning id into v_s2;
    -- Someone already here, unassigned, known by phone; and someone assigned to another person.
    insert into public.crm_contacts (client_id, name, phone, phone_digits, source)
      values (v_probe, 'Old Customer', '(555) 010-0101', '5550100101', 'design') returning id into v_old;
    insert into public.crm_contacts (client_id, name, phone, phone_digits, source, owner_user_id)
      values (v_probe, 'Theirs', '555-010-0109', '5550100109', 'design', v_other) returning id into v_theirs;

    v_page := jsonb_build_array(
      jsonb_build_object('row', 2, 'name', 'Rehearsal One', 'company', 'One Sheds', 'phone', '+1 (555) 010-0001',
                         'labels', jsonb_build_array('hot'), 'note', 'Called once', 'title', 'Shed', 'value_cents', 250000),
      jsonb_build_object('row', 3, 'company', 'Two Barns', 'email', 'two@rehearsal.invalid', 'stage', v_s2::text),
      jsonb_build_object('row', 4, 'name', 'Nobody'),
      jsonb_build_object('row', 5, 'name', 'New Name', 'phone', '555-010-0101', 'email', 'old@rehearsal.invalid', 'street', '1 Main St'),
      jsonb_build_object('row', 6, 'name', 'Theirs Again', 'phone', '5550100109'),
      jsonb_build_object('row', 7, 'phone', '5550100001', 'email', 'one@rehearsal.invalid'),
      jsonb_build_object('row', 8, 'email', 'nameless@rehearsal.invalid'),
      jsonb_build_object('row', 9, 'name', 'Bad Stage', 'phone', '5550100002', 'stage', gen_random_uuid()::text));
    -- viewer: someone who owns nothing, as an own-scoped importer would be.
    v_opts := jsonb_build_object('pipeline', v_pipe, 'default_stage', v_s1, 'viewer', gen_random_uuid());

    v_dry := public.crm_import_leads(v_probe, v_page, v_opts, null, true);
    select count(*) into v_left from public.crm_contacts where client_id = v_probe;
    if v_left <> 2 or (select count(*) from public.crm_deals where client_id = v_probe) <> 0 then
      raise exception '381: the dry run kept rows (% contacts)', v_left;
    end if;
    v_real := public.crm_import_leads(v_probe, v_page, v_opts, null, false);
    if (v_dry - 'dry_run') <> (v_real - 'dry_run') then
      raise exception '381: the dry run answered differently from the real run';
    end if;
    if (v_real->>'contacts_created')::int <> 2 or (v_real->>'contacts_matched')::int <> 2
       or (v_real->>'deals_created')::int <> 3 or (v_real->>'already_in_pipeline')::int <> 1
       or (v_real->>'not_yours')::int <> 1 or (v_real->>'no_identity')::int <> 1 or (v_real->>'no_name')::int <> 1
       or (v_real->>'notes_added')::int <> 1 or (v_real->>'labelled')::int <> 1
       or jsonb_array_length(v_real->'refused') <> 4 then
      raise exception '381: the real run counted wrong';
    end if;
    select * into v_c from public.crm_contacts where client_id = v_probe and phone_digits = '5550100001';
    if v_c.source <> 'import' or v_c.labels <> array['hot'] or v_c.email_lower <> 'one@rehearsal.invalid' or v_c.company <> 'One Sheds' then
      raise exception '381: a new contact was not written as the row said';
    end if;
    if not exists (select 1 from public.crm_deals d where d.contact_id = v_c.id and d.stage_id = v_s1 and d.value_cents = 250000
                    and d.source = 'import' and d.status_id is not null)
       or not exists (select 1 from public.crm_deal_stage_changes x join public.crm_deals d on d.id = x.deal_id
                       where d.contact_id = v_c.id and x.to_stage = v_s1 and x.from_stage is null) then
      raise exception '381: a new deal, its status or its first stage change is missing';
    end if;
    if not exists (select 1 from public.crm_deals d join public.crm_contacts c on c.id = d.contact_id
                    where c.client_id = v_probe and c.company = 'Two Barns' and d.stage_id = v_s2) then
      raise exception '381: a row''s own stage was not used';
    end if;
    select * into v_c from public.crm_contacts where id = v_old;
    if v_c.name <> 'Old Customer' or v_c.email_lower <> 'old@rehearsal.invalid' or v_c.street <> '1 Main St' or v_c.source <> 'design' then
      raise exception '381: a match was renamed, not enriched, or relabelled';
    end if;
    -- now() is one instant in a transaction, so updated_at cannot show a write here; a deal would.
    if exists (select 1 from public.crm_deals where contact_id = v_theirs)
       or exists (select 1 from public.crm_contacts where id = v_theirs and (name <> 'Theirs' or email is not null)) then
      raise exception '381: someone else''s contact was written';
    end if;
    v_again := public.crm_import_leads(v_probe, v_page, v_opts, null, false);
    if (v_again->>'contacts_created')::int <> 0 or (v_again->>'deals_created')::int <> 0 or (v_again->>'notes_added')::int <> 0
       or (v_again->>'labelled')::int <> 0 or (v_again->>'already_in_pipeline')::int <> 4 then
      raise exception '381: a re-run of the same page wrote again';
    end if;
    v_skip := public.crm_import_leads(v_probe,
      jsonb_build_array(jsonb_build_object('row', 2, 'name', 'Skip Me', 'phone', '5550100101', 'zip', '99999')),
      jsonb_build_object('pipeline', v_pipe, 'default_stage', v_s1, 'on_match', 'skip'), null, false);
    if (v_skip->>'matched_skipped')::int <> 1 or exists (select 1 from public.crm_contacts where id = v_old and zip is not null) then
      raise exception '381: on_match skip wrote to a match';
    end if;
    v_extra := public.crm_import_leads(v_probe, jsonb_build_array(
      jsonb_build_object('row', 2, 'name', 'Second Phone', 'phone', '5550100777', 'email', 'one@rehearsal.invalid'),
      jsonb_build_object('row', 3, 'name', 'Opt Out', 'phone', '5550100555', 'do_not_text', true)),
      jsonb_build_object(), null, false);
    if (v_extra->>'people_added')::int <> 1 or (v_extra->>'opted_out')::int <> 1 or (v_extra->>'deals_created')::int <> 0
       or not exists (select 1 from public.crm_contacts where client_id = v_probe and phone_digits = '5550100555' and sms_opt_out_at is not null) then
      raise exception '381: a second phone, an opt-out or a contacts-only page went wrong';
    end if;
    begin
      perform public.crm_import_leads(v_probe, '[]'::jsonb, jsonb_build_object('pipeline', gen_random_uuid()), null, true);
    exception when no_data_found then v_err := 'refused';
    end;
    if v_err is distinct from 'refused' then
      raise exception '381: a pipeline that is not this tenant''s was accepted';
    end if;

    -- A plain variable: it survives the rollback below, where a setting made inside it would not.
    v_summary := format('real: %s new, %s matched, %s deals, %s already on it, %s refused; re-run: %s new, %s deals; '
                        'skip: %s left alone; second phone: %s; opted out: %s',
                        v_real->>'contacts_created', v_real->>'contacts_matched', v_real->>'deals_created',
                        v_real->>'already_in_pipeline', jsonb_array_length(v_real->'refused'),
                        v_again->>'contacts_created', v_again->>'deals_created', v_skip->>'matched_skipped',
                        v_extra->>'people_added', v_extra->>'opted_out');
    raise exception using errcode = 'S3811', message = '381: rehearsal rolled back';
  exception when sqlstate 'S3811' then
    null;
  end;
  select count(*) into v_left from public.crm_contacts where client_id = v_probe;
  if v_left <> 0 or exists (select 1 from public.crm_pipelines where client_id = v_probe)
     or exists (select 1 from public.sms_opt_outs where client_id = v_probe) then
    raise exception '381: the rehearsal left rows behind';
  end if;
  if v_summary is null then
    raise exception '381: the rehearsal did not run to its end';
  end if;
  perform set_config('ss.m381_rehearsal', v_summary, true);
  raise notice '381: checks hold';
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. PASS is:
--   migration '381', function_ready true, rehearsal 'real: 2 new, 2 matched, 3 deals, 1 already on it,
--   4 refused; re-run: 0 new, 0 deals; skip: 1 left alone; second phone: 1; opted out: 1'
select '381' as migration,
       to_regprocedure('public.crm_import_leads(text, jsonb, jsonb, uuid, boolean)') is not null
         and to_regprocedure('public.crm_import_leads_text(jsonb, integer)') is not null as function_ready,
       current_setting('ss.m381_rehearsal', true) as rehearsal;

commit;
