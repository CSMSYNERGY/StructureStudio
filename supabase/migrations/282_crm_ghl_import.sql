-- 282_crm_ghl_import.sql — CSM Synergy's own GoHighLevel contacts can come into the built-in CRM,
-- through the same resolver every design and lead already uses.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('282', '282_crm_ghl_import') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ⛔ APPLYING THIS IMPORTS NOTHING. It adds a source value and a function nobody calls yet. The
--    import itself is portal-settings' crm_import_ghl_contacts (operator-only, CSM Synergy's own
--    account only, a dry run unless the request says `dryRun: false`). The real run waits on
--    Carolyn's answers about which leads move and whether the website form keeps feeding GHL, and
--    on the portal's Contacts list (see ORDER).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-09-28 call: "continue building out the CRM part of it as well, because I also want
-- to use it for all of our leads in here." CSM Synergy's own leads are moving into the built-in
-- CRM. A contact list is needed whatever she decides about past texts, emails and pipeline stages,
-- so the contacts come first and nothing else does.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1   crm_contacts.source gains 'ghl_import'. 254 left the check as design | captured_lead |
--            manual | import | phone (pg_get_constraintdef, 2026-10-06). Its own value rather than
--            the generic 'import', so "what did the GoHighLevel move bring in" is one count and an
--            import from anywhere else later does not blur it.
--   PART 2   public.crm_import_ghl_contacts(client, rows, dry_run): one page of GoHighLevel contacts
--            (portal-settings sends 100) through public.crm_ensure_contact, one row at a time, in
--            ONE call. 100 resolver calls over PostgREST would be 100 round trips per page; this is one.
--            A page is a few hundred indexed statements, far inside the 8 s statement_timeout PostgREST
--            runs every call under (authenticator's; service_role sets none, pg_roles 2026-10-06).
--            GoHighLevel's texting do-not-disturb comes along as an opt-out (sms_opt_outs, 164).
--   PART 3   checks, and a rehearsal on a made-up tenant that is rolled back.
--
-- ── THE RULES THE FUNCTION KEEPS ─────────────────────────────────────────────────────────
--   * MATCHING IS crm_ensure_contact's, untouched (191, live body confirmed identical 2026-10-06):
--     phone first, then email, each checking the contact and then its second people; an empty value
--     never clears a stored one; a DIFFERENT phone or email on a matched contact is kept as a second
--     person rather than overwriting. No phone and no email: no row (and it is not even called).
--     That is the dedupe, and why a re-run creates nothing: every contact it brought in now matches.
--   * AN EMAIL ANOTHER LIVE CONTACT ALREADY HOLDS IS NEVER COPIED ONTO THE PHONE'S CONTACT. The
--     resolver matches the phone first, and a phone contact with no email takes the row's email as
--     enrichment. Its email index is unique only where there is no phone (130), so nothing would stop
--     two live contacts sharing one address, and GoHighLevel often holds one person two or three times
--     (email only, phone only, then both). So the resolver's call for a row with both is checked: if it
--     put the email on the phone's contact while another live contact on the tenant already holds it,
--     that one call is undone (a private SQLSTATE, S2822) and made again with the phone alone. The
--     email stays with the contact that had it, and the row is counted as `split`.
--   * NAMES FILL A BLANK, NEVER RENAME. The resolver's own rule is "the newest non-empty name wins",
--     which is right for a customer re-submitting a design and wrong for a list exported from the
--     system being left: GoHighLevel's copy is the OLDER one. So the resolver is called with no name,
--     and the name then goes only where there is none: on the contact when the row matched it without
--     a conflict, and on the second person the resolver recorded for one of the row's channels. When
--     the resolver recorded a second person, the name is that person's and never the contact's (191's
--     own rule: "with a conflict present we already know this is a second person"), so a nameless
--     contact is not named after someone who only shares an email with it. A phone or email that
--     matches is the same number or address, so the resolver may rewrite how it is written
--     ("+15550100101" for "(555) 010-0101"), as a design does; a different one is never written over
--     the stored one.
--   * DO NOT TEXT: a row GoHighLevel marks as not to be texted (`sms_dnd` JSON true, and nothing else:
--     the string "true" is not it) puts its phone in sms_opt_outs (reason 'import', 164 lists it),
--     whatever happens to the contact, and sets the contact's sms_opt_out_at when that phone is the
--     contact's own (not when it is a second person's). An opt-out already there is left as it is.
--     smsSend checks sms_opt_outs before any consent, and crm_record_consent refuses a contact with
--     sms_opt_out_at, so a grant made after the import (they text the business, staff record
--     permission) cannot re-subscribe them; only their own START does. GoHighLevel does not say when
--     they said stop, so a phone that already has a grant here is opted out too: replying START
--     undoes it. Counted as `opted_out` (new opt-outs only, so a re-run counts 0). A re-run after
--     someone has replied START here would put their opt-out back, so the real import is walked once,
--     carried on only with its own cursors.
--   * SOURCE: only a contact THIS call created gets 'ghl_import'. One that already existed (from a
--     design, a captured lead, a phone call) keeps its source; the import only enriches it. "Created
--     by this call" is `created_at = now()` (the resolver inserts with the column default, which is
--     this transaction's start) and not in the call's list of ids already known: the tenant's rows
--     that already carried this transaction's timestamp when the call began (none, when each call is
--     its own transaction as it is from portal-settings; the rehearsal below makes several calls in
--     one), plus every row the call has counted as new. So two GoHighLevel rows for one person in the
--     same page count once as new and once as matched, without a second copy of the resolver's
--     matching rules here.
--   * LABELS: GoHighLevel's tags are added to the contact's labels (a union; nothing is removed, and
--     a contact whose labels already hold every tag is not written). Trimmed, at most 25 per contact,
--     at most 60 characters each. portal-settings cleans them first; this repeats it so the function
--     is safe on its own.
--   * FIRST SEEN: a GoHighLevel "date added" earlier than the contact's first_seen_at moves it back
--     (130's backfill did the same with designs). Later dates never move it forward.
--   * A row the unique indexes refuse (two writers racing for one new number) is counted as a
--     conflict and skipped; only unique_violation is absorbed. A re-run picks it up. Anything else
--     (a missing table, a revoked grant, a broken constraint) fails the whole page, which portal-
--     settings reports as a fault, with nothing from that page kept.
--   * DRY RUN (the default): the page runs exactly as the real one would, inside a block that is then
--     rolled back, so the counts are the real path's counts and nothing is kept. Within a page that is
--     exact. Across pages it is an upper bound on "new": page 2 cannot see page 1's rolled-back rows,
--     so one person listed twice in GoHighLevel on two different pages counts as new twice (portal-
--     settings reports those repeats separately). The same goes for `opted_out` and `split`.
--   * COUNTS ONLY. The function returns numbers and never a name, a number or an address, and
--     neither it nor portal-settings logs a contact.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * No message history, emails, calls, opportunities or pipeline stages (Carolyn's question 2).
--   * No consent. An imported contact has no texting permission until they give it (the designer's
--     checkbox, or texting the business first): _shared/smsSend.ts refuses every text without a
--     positive sms_consent_log grant, and nothing here writes one. GoHighLevel's do-not-disturb is
--     the one texting fact that does come across, as an opt-out (THE RULES, DO NOT TEXT), because a
--     grant can be created after the import and only an opt-out outranks it.
--   * No owner. Imported contacts are unassigned, as a design's are (crm_ensure_contact assigns
--     nobody), so a person limited to their own customers does not see them until someone assigns
--     them. GoHighLevel's assigned user is not mapped to a StructureStudio person.
--   * No address and no custom fields. crm_ensure_contact takes a name, a phone and an email.
--   * A second channel the resolver records as a second person (crm_contact_people) is written with
--     that function's own source 'design'; changing it would mean re-issuing the resolver, which
--     every design save calls, for a label nothing reads.
--   * The portal's Contacts list is built from designs and captured leads, so an imported contact
--     with neither does not appear in it yet. It does appear in My Synergy Phone's contact search,
--     names an incoming call or text from that number, and opens as a record.
--   * GoHighLevel's tags are stored in crm_contacts.labels, which no portal screen shows yet.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. PART 1 re-validates the check over crm_contacts (89 rows
-- on 2026-10-06; every one already passes) under a brief ACCESS EXCLUSIVE lock, and save_design
-- touches crm_contacts on every design save, so lock_timeout makes a hung apply give up instead of
-- queueing quotes behind it. No trigger exists on crm_contacts. The function is new and service-role
-- only (Supabase's default privileges would hand it to anon; revoked from public too). Besides the
-- CRM it writes only sms_opt_outs (164: no check on `reason`, no trigger, 2026-10-06), and only for a
-- phone GoHighLevel marks do-not-disturb, when it is called; applying this file writes none.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-06: 280 is the newest applied; 281 is written and deliberately not applied.
-- 282 is held for batch B7 (this file). Confirm at apply time, and record the ledger row with
-- `returning`: no row back means 282 was taken, so rename.
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- This file FIRST, then portal-settings with crm_import_ghl_contacts. Deployed ahead of this file the
-- action answers "isn't installed on this server yet" and does nothing. Then an operator runs the dry
-- run (the default) on CSM Synergy's own account and reads the counts. The real run only after
-- Carolyn has said which leads move AND the portal's Contacts list shows contacts that have no design
-- or captured lead (today LeadsTable, 02-sales.jsx, reads only designs and captured_leads). If it has
-- to run before that ships, tell Carolyn first in plain words and wait for her go-ahead: imported
-- leads will be found through My Synergy Phone's search and caller ID, not the Contacts list, until
-- then; they come in unassigned, so someone limited to their own customers sees none of them until
-- they are assigned; and GoHighLevel's tags are kept but not shown anywhere yet. A real run starts
-- without a cursor (a dry run's is refused) and carries on with the cursors it answers itself.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   drop function if exists public.crm_import_ghl_contacts(text, jsonb, boolean);
--   update public.crm_contacts set source = 'import' where source = 'ghl_import';
--   alter table public.crm_contacts drop constraint if exists crm_contacts_source_check;
--   alter table public.crm_contacts add constraint crm_contacts_source_check check (source in ('design', 'captured_lead', 'manual', 'import', 'phone'));
--   delete from supabase_migrations.schema_migrations where version = '282';
-- The rollback keeps every contact an import brought in (relabelled 'import', the value 130 already
-- had for this). Taking an import back out is a decision about live customer records, not a schema
-- step: a contact may have gained a design, a note or a call since. Find them with
-- `select count(*) from crm_contacts where source = 'ghl_import'` and decide with a human. The
-- opt-outs an import recorded (sms_opt_outs reason 'import') stay too: they are people who asked
-- not to be texted, and only their own START lifts that.

begin;

-- PART 1 swaps a check on crm_contacts, which every design save writes through crm_ensure_contact.
-- A hung apply must give up rather than sit in front of them.
set local lock_timeout = '5s';

-- Every contact BEFORE anything here runs, so the checks can prove no existing row moved.
create temp table m282_before on commit drop as
  select id, client_id, source, labels, first_seen_at, updated_at, merged_into from public.crm_contacts;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — crm_contacts.source gains 'ghl_import'
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 254's five values, re-issued with the one new value (254 PART 9B did the same for 'phone').
alter table public.crm_contacts drop constraint if exists crm_contacts_source_check;
alter table public.crm_contacts
  add constraint crm_contacts_source_check
  check (source in ('design', 'captured_lead', 'manual', 'import', 'phone', 'ghl_import'));

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — one page of GoHighLevel contacts through the resolver
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- p_rows: a JSON array of {name, phone, email, tags: [text], added_at: ISO text, sms_dnd: boolean},
-- every key optional. Answers {dry_run, rows, created, matched, no_identity, conflicts, labelled,
-- opted_out, split}: numbers only.
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
  'GoHighLevel contact import (migration 282): one page of {name, phone, email, tags, added_at, sms_dnd} rows through '
  'crm_ensure_contact. New contacts get source ghl_import, a name only fills a blank (never renames), an email another '
  'live contact holds is left with it, tags are added to labels, an earlier GoHighLevel date added moves first_seen_at '
  'back, a do-not-disturb phone goes into sms_opt_outs (reason import). p_dry_run (default true) runs the page and rolls '
  'it back. Returns counts only. Called by portal-settings crm_import_ghl_contacts. service_role only.';

-- Callable only by portal-settings (service role). Supabase's default privileges grant every new
-- function to anon and authenticated, and PUBLIC holds execute by default, so all three are revoked.
revoke execute on function public.crm_import_ghl_contacts(text, jsonb, boolean) from public, anon, authenticated;
grant  execute on function public.crm_import_ghl_contacts(text, jsonb, boolean) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — checks, and a rehearsal that is rolled back. Raise, and so roll the whole file back,
-- rather than commit a surprise.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_src     text;
  v_role    text;
  v_moved   integer;
  v_probe   constant text := '__m282_rehearsal__';
  v_real    jsonb;
  v_dry     jsonb;
  v_again   jsonb;
  v_split   jsonb;
  v_one     public.crm_contacts%rowtype;
  v_two     public.crm_contacts%rowtype;
  v_three   public.crm_contacts%rowtype;
  v_sources text;
  v_left    integer;
  v_summary text;
begin
  -- ── The check: the new value, and all five old ones ──
  select pg_get_constraintdef(c.oid) into v_src from pg_catalog.pg_constraint c
   where c.conrelid = 'public.crm_contacts'::regclass and c.conname = 'crm_contacts_source_check';
  if v_src is null
     or position('''ghl_import''' in v_src) = 0
     or position('''design''' in v_src) = 0 or position('''captured_lead''' in v_src) = 0
     or position('''manual''' in v_src) = 0 or position('''import''' in v_src) = 0
     or position('''phone''' in v_src) = 0 then
    raise exception '282: crm_contacts_source_check is %', coalesce(v_src, 'missing');
  end if;

  -- ── The function: definer, pinned search_path, service role only ──
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.crm_import_ghl_contacts(text, jsonb, boolean)'::regprocedure
       and p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'::text[]))
  ) then
    raise exception '282: crm_import_ghl_contacts is not SECURITY DEFINER with an empty search_path';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_role, 'public.crm_import_ghl_contacts(text, jsonb, boolean)', 'EXECUTE') then
      raise exception '282: % can execute crm_import_ghl_contacts', v_role;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.crm_import_ghl_contacts(text, jsonb, boolean)', 'EXECUTE') then
    raise exception '282: service_role cannot execute crm_import_ghl_contacts — portal-settings would fail';
  end if;
  -- The resolver this leans on is still callable by the definer and still closed to the browser.
  if has_function_privilege('anon', 'public.crm_ensure_contact(text, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.crm_ensure_contact(text, text, text, text)', 'EXECUTE') then
    raise exception '282: crm_ensure_contact is open to a browser role';
  end if;

  -- ── No existing contact moved ──
  select count(*) into v_moved
    from m282_before b
    left join public.crm_contacts c on c.id = b.id
   where c.id is null
      or (c.client_id, c.source, c.labels, c.first_seen_at, c.updated_at, c.merged_into)
         is distinct from (b.client_id, b.source, b.labels, b.first_seen_at, b.updated_at, b.merged_into);
  if v_moved <> 0 or (select count(*) from m282_before) <> (select count(*) from public.crm_contacts) then
    raise exception '282: % existing contact(s) changed during the apply — run it again', v_moved;
  end if;

  -- ── The rehearsal, on a made-up tenant, rolled back ──
  if exists (select 1 from public.crm_contacts where client_id = v_probe)
     or exists (select 1 from public.sms_opt_outs where client_id = v_probe) then
    raise exception '282: contacts or opt-outs for % already exist; the rehearsal will not touch them', v_probe;
  end if;
  begin
    -- A dry run first: counts come back and nothing stays, the do-not-disturb opt-out included.
    v_dry := public.crm_import_ghl_contacts(v_probe, jsonb_build_array(
      jsonb_build_object('name', 'Rehearsal One', 'phone', '+1 (555) 010-0001', 'tags', jsonb_build_array('a'),
                         'sms_dnd', true)), true);
    if (v_dry->>'created')::int <> 1 or (v_dry->>'opted_out')::int <> 1 or (v_dry->>'dry_run')::boolean is distinct from true then
      raise exception '282: the dry run answered %', v_dry;
    end if;
    if exists (select 1 from public.crm_contacts where client_id = v_probe) then
      raise exception '282: the dry run left a contact behind';
    end if;
    if exists (select 1 from public.sms_opt_outs where client_id = v_probe) then
      raise exception '282: the dry run left an opt-out behind';
    end if;

    -- The real path: a new person GoHighLevel marks do-not-disturb, the same person again by phone
    -- with one more tag, a row with no phone and no email, and an email-only person GoHighLevel has
    -- known since 2020 (marked do-not-disturb too, with no phone to keep it on).
    v_real := public.crm_import_ghl_contacts(v_probe, jsonb_build_array(
      jsonb_build_object('name', 'Rehearsal One', 'phone', '+1 (555) 010-0001', 'email', 'one@rehearsal.invalid',
                         'tags', jsonb_build_array('ghl tag', '  Second  ', '', 7), 'sms_dnd', true),
      jsonb_build_object('phone', '555-010-0001', 'tags', jsonb_build_array('ghl tag', 'third')),
      jsonb_build_object('name', 'Nobody', 'tags', jsonb_build_array('x')),
      jsonb_build_object('email', 'two@rehearsal.invalid', 'added_at', '2020-01-02T03:04:05Z', 'sms_dnd', true)), false);
    if (v_real->>'created')::int <> 2 or (v_real->>'matched')::int <> 1 or (v_real->>'no_identity')::int <> 1
       or (v_real->>'conflicts')::int <> 0 or (v_real->>'labelled')::int <> 2 or (v_real->>'rows')::int <> 4
       or (v_real->>'opted_out')::int <> 1 or (v_real->>'split')::int <> 0 then
      raise exception '282: the rehearsal answered %', v_real;
    end if;
    select * into v_one from public.crm_contacts where client_id = v_probe and phone_digits = '5550100001';
    select * into v_two from public.crm_contacts where client_id = v_probe and email_lower = 'two@rehearsal.invalid';
    if v_one.id is null or v_two.id is null then
      raise exception '282: the rehearsal contacts were not created';
    end if;
    if v_one.source <> 'ghl_import' or v_two.source <> 'ghl_import' then
      raise exception '282: a new contact has source % / %, expected ghl_import', v_one.source, v_two.source;
    end if;
    if not (v_one.labels @> array['ghl tag', 'Second', 'third'] and v_one.labels <@ array['ghl tag', 'Second', 'third']) then
      raise exception '282: the labels came out as %', v_one.labels;
    end if;
    if v_one.email_lower is distinct from 'one@rehearsal.invalid' or v_one.name is distinct from 'Rehearsal One' then
      raise exception '282: the first contact lost its email or name';
    end if;
    if v_two.first_seen_at <> timestamptz '2020-01-02 03:04:05+00' then
      raise exception '282: first_seen_at is %, expected GoHighLevel''s date added', v_two.first_seen_at;
    end if;
    if (select o.reason from public.sms_opt_outs o where o.client_id = v_probe and o.phone_digits = '5550100001')
         is distinct from 'import'
       or v_one.sms_opt_out_at is null or v_two.sms_opt_out_at is not null
       or (select count(*) from public.sms_opt_outs where client_id = v_probe) <> 1 then
      raise exception '282: GoHighLevel''s do-not-disturb did not become the phone''s opt-out';
    end if;

    -- The same people again, one under another name: nothing new, nothing relabelled, nobody renamed.
    v_again := public.crm_import_ghl_contacts(v_probe, jsonb_build_array(
      jsonb_build_object('name', 'Renamed Person', 'phone', '+1 (555) 010-0001', 'email', 'one@rehearsal.invalid',
                         'tags', jsonb_build_array('ghl tag', 'Second'), 'sms_dnd', true),
      jsonb_build_object('email', 'two@rehearsal.invalid')), false);
    if (v_again->>'created')::int <> 0 or (v_again->>'matched')::int <> 2 or (v_again->>'labelled')::int <> 0
       or (v_again->>'opted_out')::int <> 0 then
      raise exception '282: a re-run answered %', v_again;
    end if;
    if (select count(*) from public.crm_contacts where client_id = v_probe) <> 2 then
      raise exception '282: a re-run created a contact';
    end if;
    if (select name from public.crm_contacts where id = v_one.id) is distinct from 'Rehearsal One' then
      raise exception '282: an import renamed a contact to %', (select name from public.crm_contacts where id = v_one.id);
    end if;

    -- An existing contact keeps its source: it is matched and enriched, never relabelled.
    update public.crm_contacts set source = 'captured_lead' where id = v_two.id;
    perform public.crm_import_ghl_contacts(v_probe, jsonb_build_array(
      jsonb_build_object('email', 'TWO@rehearsal.invalid', 'name', 'Rehearsal Two')), false);
    select source into v_sources from public.crm_contacts where id = v_two.id;
    if v_sources <> 'captured_lead' then
      raise exception '282: an existing contact''s source moved to %', v_sources;
    end if;

    -- One person GoHighLevel holds three times (email only, phone only, then both): the email stays
    -- with the contact that had it, never copied onto the phone's contact as well.
    v_split := public.crm_import_ghl_contacts(v_probe, jsonb_build_array(
      jsonb_build_object('email', 'three@rehearsal.invalid'),
      jsonb_build_object('phone', '555-010-0003'),
      jsonb_build_object('name', 'Rehearsal Three', 'phone', '+15550100003', 'email', 'three@rehearsal.invalid')), false);
    select * into v_three from public.crm_contacts where client_id = v_probe and phone_digits = '5550100003';
    if (v_split->>'created')::int <> 2 or (v_split->>'matched')::int <> 1 or (v_split->>'split')::int <> 1
       or v_three.id is null or v_three.email_lower is not null
       or (select count(*) from public.crm_contacts
            where client_id = v_probe and merged_into is null and email_lower = 'three@rehearsal.invalid') <> 1 then
      raise exception '282: an email two contacts would share answered %', v_split;
    end if;

    -- A nameless contact matched by its email, with a different phone: the phone is a second person
    -- (191), and the name is that person's, not the contact's.
    perform public.crm_import_ghl_contacts(v_probe, jsonb_build_array(
      jsonb_build_object('phone', '555-010-0004', 'email', 'four@rehearsal.invalid')), false);
    perform public.crm_import_ghl_contacts(v_probe, jsonb_build_array(
      jsonb_build_object('name', 'Second Person', 'phone', '555-010-0005', 'email', 'four@rehearsal.invalid')), false);
    if (select c.name from public.crm_contacts c where c.client_id = v_probe and c.phone_digits = '5550100004') is not null
       or (select p.name from public.crm_contact_people p
            join public.crm_contacts c on c.id = p.contact_id
           where c.client_id = v_probe and c.phone_digits = '5550100004' and p.phone_digits = '5550100005')
          is distinct from 'Second Person' then
      raise exception '282: a second person''s name went onto the contact, or not onto the person';
    end if;

    -- A plain variable: it survives the rollback below, where a setting made inside it would not.
    v_summary := format('dry run: %s new, %s opted out, kept 0; real: %s new, %s matched, %s no identity, %s labelled, '
                        '%s opted out; re-run: %s new, %s opted out; shared email: %s left with its contact',
                        v_dry->>'created', v_dry->>'opted_out', v_real->>'created', v_real->>'matched',
                        v_real->>'no_identity', v_real->>'labelled', v_real->>'opted_out', v_again->>'created',
                        v_again->>'opted_out', v_split->>'split');
    raise exception using errcode = 'S2821', message = '282: rehearsal rolled back';
  exception when sqlstate 'S2821' then
    null;
  end;
  select count(*) into v_left from public.crm_contacts where client_id = v_probe;
  if v_left <> 0 then
    raise exception '282: the rehearsal left % contact(s) behind', v_left;
  end if;
  select count(*) into v_left from public.sms_opt_outs where client_id = v_probe;
  if v_left <> 0 then
    raise exception '282: the rehearsal left % opt-out(s) behind', v_left;
  end if;
  if v_summary is null then
    raise exception '282: the rehearsal did not run to its end';
  end if;
  perform set_config('ss.m282_rehearsal', v_summary, true);

  raise notice '282: checks hold; % existing contact(s) unchanged', (select count(*) from m282_before);
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. PASS is these five, none of which drifts with live data:
--   source_check_has_ghl_import true, function_ready true, contacts_changed 0, ghl_import_rows 0,
--   rehearsal (one line) 'dry run: 1 new, 1 opted out, kept 0; real: 2 new, 1 matched, 1 no identity,
--     2 labelled, 1 opted out; re-run: 0 new, 0 opted out; shared email: 1 left with its contact'
-- Any of those different: roll back (see ROLLBACK above) before recording the ledger row.
-- contacts_checked and by_source are FOR INFORMATION ONLY, the live count at apply time (89, and
-- 'captured_lead 10, design 79', on 2026-10-06): every design saved or lead captured on any tenant
-- moves them, so a different number there is not a failure.
select
  '282' as migration,
  (select position('''ghl_import''' in pg_get_constraintdef(c.oid)) > 0 from pg_catalog.pg_constraint c
    where c.conrelid = 'public.crm_contacts'::regclass and c.conname = 'crm_contacts_source_check') as source_check_has_ghl_import,
  (has_function_privilege('service_role', 'public.crm_import_ghl_contacts(text, jsonb, boolean)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.crm_import_ghl_contacts(text, jsonb, boolean)', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.crm_import_ghl_contacts(text, jsonb, boolean)', 'EXECUTE')) as function_ready,
  (select count(*) from m282_before)::int as contacts_checked,
  (select count(*) from m282_before b join public.crm_contacts c on c.id = b.id
    where (c.source, c.labels, c.updated_at) is distinct from (b.source, b.labels, b.updated_at))::int as contacts_changed,
  (select string_agg(s.source || ' ' || s.n, ', ' order by s.source)
     from (select source, count(*) as n from public.crm_contacts group by source) s) as by_source,
  (select count(*) from public.crm_contacts where source = 'ghl_import')::int as ghl_import_rows,
  current_setting('ss.m282_rehearsal', true) as rehearsal;

commit;

-- After this: nothing has been imported. portal-settings' crm_import_ghl_contacts can now run a dry
-- run on CSM Synergy's own account, and the real import waits on Carolyn.
