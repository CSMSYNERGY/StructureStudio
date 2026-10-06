-- 287_phone_record_calls_default_on.sql — every builder starts with call recording ON.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('287', '287_phone_record_calls_default_on') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-06 (answers 7 and 8 to the questions of 10-04): call recording is ON by default
-- for builders, callers hear "This call may be recorded.", and recordings are kept one year, the
-- same as voicemail. Transcripts and summaries stay a separate decision, and stay off.
-- 263 shipped the opposite default (recording off until the owner turns it on, its choice 1), so
-- today every business is off: 5 client_settings rows, 0 with phone_record_calls, 0 that an owner
-- has ever saved (phone_recording_updated_at set on none), read 2026-10-07.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * The column's DEFAULT becomes true, so a builder whose settings row is created from now on
--     starts on. Every live writer upserts NAMED columns (280's reasoning), and the only one that
--     names phone_record_calls is the owner's own save (portal-settings phone_recording_save).
--   * Rows NO OWNER HAS EVER SAVED are turned on: phone_record_calls false and
--     phone_recording_updated_at NULL. Today that is 5 of 5. Their updated_at / updated_by stay
--     NULL, so NULL keeps meaning "never an owner's choice: on by the platform default, Carolyn's
--     decision of 2026-10-06". An owner who turns it off later is stamped by that save and is never
--     overwritten, by a re-apply of this file or anything else here.
--   * The two column comments say so, and the standard sentence is now "This call may be
--     recorded." ("... and transcribed." only while transcripts really run). The sentence itself
--     lives in code (phone-api src/recording.ts and portal-settings phone.ts), not in a column.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * NOTHING IS RECORDED BECAUSE OF IT. A call is armed only while the phone-api Worker's
--     CALL_RECORDING rail is exactly "on" (src/recording.ts armedFor), and the rail stays off
--     until the updated privacy policy and store disclosures are published (workers/phone-api
--     SETUP.md 7d). Until then the one business with calling on sees "On, not started yet" on its
--     Settings › Phone card, on beta and production alike (they share this database).
--   * Does not re-issue phone_route_for_number or phone_caller_context (newest: 266). Their
--     coalesce(cs.phone_record_calls, false) for a tenant with NO settings row stays fail-closed;
--     such a tenant has phone_status 'off' anyway, so it has no calls to record.
--   * Does not touch the announcement (locked on), phone_transcribe_calls (default true, as 263
--     left it; transcripts stay off on the Worker's CALL_TRANSCRIBE rail), retention (365 by
--     default and on all 5 rows already), the owner-only rule, any grant, or the meters
--     (call_recording stays inactive: we absorb about $0.0025 a recorded minute).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, so the default and the backfill are live for both the
-- moment this commits. ALTER COLUMN ... SET DEFAULT is a catalog change (no rewrite, no scan) that
-- takes a brief ACCESS EXCLUSIVE lock on client_settings, which every quote and every Settings read
-- touches; the UPDATE rewrites at most every row (5 today). lock_timeout makes a hung apply give up
-- instead of queueing quotes behind it; retry it. The table has no trigger (read 2026-10-07).
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-07: 282, 280, 278 are the newest; 281 is unapplied on purpose. 283 to 286 are
-- held by the sibling batches of the same answers (numbering, serials, siding, contacts view-only),
-- so this is 287. Confirm at apply time, and record the ledger row with `returning`: no row back
-- means 287 was taken, so rename.
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- Any time before the rail goes on; it is inert until then. The full order (this file, the
-- portal-settings deploy with the new wording, the portal card, then, only once the disclosures are
-- published and Ahsan says go, the Worker with CALL_RECORDING "on" and the function secret) is
-- workers/phone-api SETUP.md 7d.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Turn the rail off FIRST (SETUP.md 7d, kill switch): with it on, this puts every business no owner
-- has saved back to unrecorded from its next call. Rows an owner saved keep their choice. Before
-- keeping a row stamped on after 287, read its admin_audit phone_recording_on detail: a save that
-- changed only the retention or the wording also stamps on (the card asks "Record calls?" first).
--   alter table public.client_settings alter column phone_record_calls set default false;
--   update public.client_settings set phone_record_calls = false where phone_record_calls and phone_recording_updated_at is null;
--   comment on column public.client_settings.phone_record_calls is 'Migration 263: record this business''s calls (My Synergy Phone). Default false. Only the owner turns it on (portal-settings phone_recording_save). Calls also need the phone-api Worker''s CALL_RECORDING = "on", and a call records only if its announcement played (phone_calls.recording_armed).';
--   comment on column public.client_settings.phone_recording_notice_text is 'Migration 263: the business''s own announcement sentence, 10 to 300 characters after trimming. NULL = the standard sentence ("This call will be recorded.", or "This call will be recorded and transcribed." while transcripts are on).';
--   delete from supabase_migrations.schema_migrations where version = '287';
-- The comments are 263's, word for word. The standard sentence is in code: rolling this back does
-- not change what callers hear (that is the portal-settings and Worker deploys).

begin;

-- The ALTER takes ACCESS EXCLUSIVE on client_settings (brief: a catalog change). A hung apply must
-- give up rather than sit in front of every quote's settings read.
set local lock_timeout = '5s';

-- Every row BEFORE anything here runs, so the checks can prove which rows moved and that nothing
-- else did.
create temp table m287_before on commit drop as
  select client_id, phone_record_calls, phone_recording_notice, phone_recording_notice_text,
         phone_transcribe_calls, phone_recording_retention_days, phone_recording_updated_at,
         phone_recording_updated_by
    from public.client_settings;

-- ── THE CHANGE ───────────────────────────────────────────────────────────────────────────
alter table public.client_settings
  alter column phone_record_calls set default true;

-- Only rows no owner has ever saved. An owner's off (stamped by phone_recording_save) stays off.
update public.client_settings
   set phone_record_calls = true
 where phone_record_calls = false
   and phone_recording_updated_at is null;

comment on column public.client_settings.phone_record_calls is
  'Record this business''s calls (My Synergy Phone). Default TRUE since migration 287 (Carolyn, '
  '2026-10-06: on by default for builders); 287 also turned on every row no owner had saved, and '
  'phone_recording_updated_at NULL still means "never an owner''s choice: on by the platform '
  'default". Only the owner turns it off (portal-settings phone_recording_save, which stamps who and '
  'when). Calls also need the phone-api Worker''s CALL_RECORDING = "on", and a call records only if '
  'its announcement played (phone_calls.recording_armed).';
comment on column public.client_settings.phone_recording_notice_text is
  'The business''s own announcement sentence, 10 to 300 characters after trimming (migration 263). '
  'NULL = the standard sentence, since migration 287 "This call may be recorded." (or "This call '
  'may be recorded and transcribed." while transcripts are on and really run); before 287 it said '
  '"will be recorded".';

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_col    record;
  v_moved  text;
  v_left   text;
  v_role   text;
  v_priv   text;
  v_c      text;
  v_def    text;
  v_probe  constant text := '__m287_rehearsal__';
  v_new    boolean;
  v_newat  timestamptz;
  v_newnt  boolean;
  v_newday integer;
  v_cols   constant text[] := array['phone_record_calls', 'phone_recording_notice', 'phone_recording_notice_text',
                                    'phone_transcribe_calls', 'phone_recording_retention_days',
                                    'phone_recording_updated_at', 'phone_recording_updated_by'];
begin
  -- ── The column: boolean, NOT NULL, default true ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'phone_record_calls';
  if v_col.data_type is null then
    raise exception '287: client_settings.phone_record_calls is missing (migration 263 not applied?)';
  end if;
  if v_col.data_type <> 'boolean' or v_col.is_nullable <> 'NO' or v_col.column_default is distinct from 'true' then
    raise exception '287: client_settings.phone_record_calls should be boolean NOT NULL DEFAULT true, is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── No business left off that no owner chose off ──
  select string_agg(client_id, ', ' order by client_id) into v_left
    from public.client_settings
   where phone_record_calls = false and phone_recording_updated_at is null;
  if v_left is not null then
    raise exception '287: these rows are still off with no owner''s choice behind it: %', v_left;
  end if;

  -- ── Exactly the unsaved rows moved, and only their switch: an owner's choice, the wording,
  --    transcripts, retention and who-and-when are all exactly as they were ──
  select string_agg(b.client_id, ', ' order by b.client_id) into v_moved
    from m287_before b
    left join public.client_settings cs on cs.client_id = b.client_id
   where cs.client_id is null
      or (cs.phone_recording_notice, cs.phone_recording_notice_text, cs.phone_transcribe_calls,
          cs.phone_recording_retention_days, cs.phone_recording_updated_at, cs.phone_recording_updated_by)
         is distinct from
         (b.phone_recording_notice, b.phone_recording_notice_text, b.phone_transcribe_calls,
          b.phone_recording_retention_days, b.phone_recording_updated_at, b.phone_recording_updated_by)
      or (b.phone_recording_updated_at is not null and cs.phone_record_calls is distinct from b.phone_record_calls)
      or (b.phone_recording_updated_at is null and cs.phone_record_calls is distinct from true);
  if v_moved is not null then
    raise exception '287: these client_settings rows changed in a way this file does not promise: %', v_moved;
  end if;
  if (select count(*) from m287_before) <> (select count(*) from public.client_settings) then
    raise exception '287: the row count moved during the apply — run it again';
  end if;

  -- ── The rest of 263's settings, untouched: the announcement locked on, transcripts' and
  --    retention's defaults, and retention's CHECK (one year is the default, as voicemail) ──
  for v_c, v_def in select * from (values
      ('phone_recording_notice', 'true'), ('phone_transcribe_calls', 'true'), ('phone_recording_retention_days', '365')) t(c, d)
  loop
    if (select c.column_default from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = v_c) is distinct from v_def then
      raise exception '287: client_settings.% no longer defaults to % (263)', v_c, v_def;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.client_settings'::regclass and conname = 'client_settings_phone_recording_retention_chk'
                    and contype = 'c' and convalidated
                    and replace(pg_catalog.pg_get_constraintdef(oid), ' ', '') like '%ARRAY[30,90,180,365,730]%') then
    raise exception '287: client_settings_phone_recording_retention_chk is missing, not validated, or no longer 30/90/180/365/730';
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles (263 PART 8's
  --    loop, over the seven recording columns) ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '287: RLS is off on client_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '287: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_c in array v_cols loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
        if has_column_privilege(v_role, 'public.client_settings', v_c, v_priv) then
          raise exception '287: % holds % on client_settings.%', v_role, v_priv, v_c;
        end if;
      end loop;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.client_settings', 'phone_record_calls', v_priv) then
      raise exception '287: service_role lacks % on client_settings.phone_record_calls — the owner''s save would fail', v_priv;
    end if;
  end loop;

  -- ── The rehearsal: a brand-new row, the way a first save creates one, and roll it back ──
  -- A sub-block whose own exception is its rollback: the insert is undone and only the answers
  -- (plain variables) survive it. Only client_id is named, so every other column takes its default.
  if exists (select 1 from public.client_settings where client_id = v_probe) then
    raise exception '287: a client_settings row named % already exists; the rehearsal will not touch it', v_probe;
  end if;
  begin
    insert into public.client_settings (client_id) values (v_probe)
      returning phone_record_calls, phone_recording_updated_at, phone_recording_notice, phone_recording_retention_days
           into v_new, v_newat, v_newnt, v_newday;
    raise exception using errcode = 'S2870', message = '287: rehearsal rolled back';
  exception when sqlstate 'S2870' then
    null;
  end;
  if v_new is distinct from true or v_newat is not null then
    raise exception '287: a new client_settings row starts with phone_record_calls = % (updated_at %), expected true and never an owner''s choice',
      coalesce(v_new::text, 'null'), coalesce(v_newat::text, 'null');
  end if;
  if v_newnt is distinct from true or v_newday is distinct from 365 then
    raise exception '287: a new client_settings row starts with the announcement % and % days, expected on and 365',
      coalesce(v_newnt::text, 'null'), coalesce(v_newday::text, 'null');
  end if;
  if exists (select 1 from public.client_settings where client_id = v_probe) then
    raise exception '287: the rehearsal row % was not rolled back', v_probe;
  end if;
  perform set_config('ss.m287_new_row', v_new::text, true);

  raise notice '287: checks hold; phone_record_calls defaults to true; % row(s) turned on, % owner choice(s) kept',
    (select count(*) from m287_before where not phone_record_calls and phone_recording_updated_at is null),
    (select count(*) from m287_before where phone_recording_updated_at is not null);
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. Expected on 2026-10-07:
--   phone_record_calls_default 'true', rows_total 5, rows_on 5, rows_turned_on 5,
--   owner_choices_kept 0, new_row_starts 'true'
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '287' as migration,
  (select c.column_default from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'phone_record_calls') as phone_record_calls_default,
  (select count(*) from public.client_settings)::int as rows_total,
  (select count(*) from public.client_settings where phone_record_calls)::int as rows_on,
  (select count(*) from m287_before b join public.client_settings cs on cs.client_id = b.client_id
    where cs.phone_record_calls and not b.phone_record_calls)::int as rows_turned_on,
  (select count(*) from public.client_settings where phone_recording_updated_at is not null)::int as owner_choices_kept,
  current_setting('ss.m287_new_row', true) as new_row_starts;

commit;

-- After this: every builder who never chose is set to be recorded, and every new builder starts so,
-- but nobody is recorded until the Worker's CALL_RECORDING rail goes on (SETUP.md 7d).
