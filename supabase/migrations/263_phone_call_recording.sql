-- 263_phone_call_recording.sql — My Synergy Phone records calls (when the business turns it on),
--                               with a transcript and a short summary of each recorded call.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Call recording, transcripts and summaries for My Synergy Phone. The build plan is
-- B2-recording-design.md (vault _Extras), and its sections 2, 5 and 8 are this file. In short:
--   * one dual-channel recording per call, on the CUSTOMER's leg (phone_calls.twilio_call_sid),
--     started by the phone-api Worker through Twilio's REST API when someone answers. That leg is
--     the only one that lasts through hold, transfers and a device switch, so one recording
--     covers the whole call, and its two channels say who spoke (the customer, or the team);
--   * an announcement before every recorded call ("This call will be recorded."), inbound before
--     the ring and outbound as the whisper the customer hears when they pick up;
--   * a transcript from Cloudflare Workers AI (Deepgram nova-3) run by the Worker's minute cron,
--     and a 2-4 sentence summary with action items from Claude, written by the new edge function
--     phone-call-summary (ANTHROPIC_API_KEY lives in Supabase secrets only);
--   * the audio stays at Twilio and is streamed by the Worker, like voicemail; the daily job
--     deletes it after the business's retention period, taking the transcript with it and
--     keeping the summary.
--
-- ── OFF AT THREE LEVELS, AND THIS FILE ONLY ADDS THE THIRD ───────────────────────────────
--   1. the Worker's env rail CALL_RECORDING must be exactly "on" (ships "off");
--   2. per business, client_settings.phone_record_calls (default FALSE, PART 1). Only the business
--      owner can turn it on, in Settings › Phone (portal-settings phone_recording_save);
--   3. per call, phone_calls.recording_armed (default FALSE, PART 1): written TRUE only when the
--      TwiML that call ran carried the announcement. Recording can only start on an armed call,
--      so turning the setting on mid-call can never record a call that did not hear the notice.
-- Nothing records the day this is applied: every business is off, and so is the Worker.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   client_settings: the recording settings (7 columns, two CHECKs NOT VALID then
--            validated); phone_calls.recording_armed
--   PART 2   phone_call_recordings: one row per recorded call, the transcript and summary queue
--   PART 3   lock-down: RLS on, zero policies, browser roles revoked, service_role granted
--   PART 4   phone_realtime_notify() re-issued (the LIVE body, 261's) with a recordings branch,
--            and two AFTER triggers on phone_call_recordings
--   PART 5   phone_recordings_claim, phone_recording_summary_claim, phone_recordings_expired
--            (service_role only)
--   PART 6   phone_route_for_number and phone_caller_context re-issued: each also returns
--            `recording` {on, notice, notice_text, transcribe}
--   PART 7   meters: usage_charges.source gains recording | transcription,
--            usage_charges_enqueue re-issued with them, two usage_prices rows INACTIVE and
--            INVISIBLE (call_recording, call_transcription), and phone_usage_armed re-issued
--            so a pilot tenant is armed for the four call and text meters only
--   PART 8   apply-time assertions (they RAISE and abort the transaction)
--   PART 9   a behavioural probe on synthetic rows, rolled back, leaving nothing
--   after commit: recording the row, verification, and the full rollback, as comments
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- The plan calls this 262. 262 is taken by another session's email work (email opens), so this
-- is 263. Before applying, check the live ledger and origin/beta (the claims race, 261's note):
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
-- must not already show 263. The live ledger read 261 on 2026-10-04 when this was written.
--
-- ── RE-ISSUED BODIES ARE THE LIVE ONES ───────────────────────────────────────────────────
-- Six functions are re-issued here. Each was read from the live database (pg_get_functiondef,
-- 2026-10-04) and compared, whitespace and comments aside, with its newest file: all six were
-- identical (no live drift):
--   phone_route_for_number, phone_caller_context   254 PART 6
--   phone_realtime_notify                          261 PART 2
--   usage_charges_enqueue                          259 PART 6
--   phone_usage_armed                              259 PART 7
-- If this is applied after something else re-issued one of them, re-read the live body and
-- carry the edits below onto it; do not apply this copy over a newer one.
-- The edits, and nothing else:
--   phone_route_for_number   reads the four recording columns beside phone_status and returns
--                            them as `recording`
--   phone_caller_context     the same `recording` key, from the same left join
--   phone_realtime_notify    one branch for phone_call_recordings, and the payload's table, op
--                            and id may be overridden by a branch (only that one does)
--   usage_charges_enqueue    two more union branches
--   phone_usage_armed        the pilot clause names the four call and text meters (259's), so
--                            a pilot never arms call_recording or call_transcription; those
--                            two charge only once their row is active
--
-- ── CHOICES (decided for Ahsan 2026-10-04; Carolyn can change the settings later) ────────
--   1. Defaults: recording OFF; the announcement ON, and locked on (phone_recording_notice is
--      kept for later; the Worker arms a call only while it is true, and the settings action
--      refuses to turn it off); transcripts ON (they only matter while recording is on);
--      retention 365 days (voicemail's), one of 30 / 90 / 180 / 365 / 730.
--   2. The wording is NULL = the standard sentence ("This call will be recorded.", or "... and
--      transcribed." when transcripts are on). A business's own sentence is 10 to 300
--      characters, counted after trimming, and must say the call is recorded (portal-settings
--      checks that; the CHECK here is the length backstop).
--   3. Who may change it: the business owner only (role 'owner'), with phone edit. That rule is
--      portal-settings'; the database has no browser door to these columns at all (client_settings
--      is service-role only, checked live 2026-10-04, and PART 8 asserts it for the new columns).
--      phone_recording_updated_at / _by say who last changed it, for any later legal question.
--   4. One row per call (call_id UNIQUE). The Worker's start is a claim: insert ... on conflict do
--      nothing, so a duplicate answer callback, or a cold-transfer teammate answering, never
--      starts a second recording.
--   5. The transcript is capped at 100,000 characters (about 3 hours of talk) and the summary at
--      1,200. transcript_json is the utterances (who, when, what); the Worker caps it too.
--   6. When the audio is deleted (retention), transcript and transcript_json go with it and the
--      summary stays. deleted_at says so; the row is kept, so the call still shows it was recorded.
--   7. The queue: transcript_status / summary_status are off | pending | working | done | failed.
--      attempts / next_try_at drive the transcript (the Worker's cron), summary_attempts /
--      summary_next_at the summary (the cron asks the edge function, and asks again after 2
--      minutes while it is still pending). lease_until is shared: a row is only ever in one of the
--      two stages at a time (the summary starts after the transcript is done).
--   8. A live update for a recording is told AS ITS CALL: the existing `call` event, table
--      phone_calls, the call's id, to the call's people (PART 4). The apps already re-read the
--      call on that, and GET /calls is where a recording shows. Only a change the apps can see
--      broadcasts (status, transcript_status, summary_status, deleted_at): the cron's lease and
--      attempt writes do not, nor a claim or back-off between pending and working (both pending
--      to the apps).
--   9. Meters: recordings and transcripts are charged per recording, cost-plus, like calls (259),
--      INACTIVE and INVISIBLE until Carolyn prices and arms them; until then the Worker records
--      shadow rows (what they cost us) from day one. A pilot of call and text billing does not
--      arm them (phone_usage_armed, PART 7): they charge only once their own row is active.
--      source_id is phone_call_recordings.id for both; the unique (source, source_id) keeps
--      them apart.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Seven client_settings columns and one phone_calls
-- column, all with constant defaults (no table rewrite); a new table nobody reads until the
-- Worker ships; two RPCs that return one more key (the Worker ignores keys it does not know,
-- and the live Worker parses neither); a trigger function that behaves exactly as before for
-- the five tables it already serves; an enqueue that queues exactly what it queued before plus
-- rows from a table that is empty; an armed check that answers as before for the four call and
-- text meters (and nothing is armed or piloted today: no markup, no armed_at, read 2026-10-04). The apply waits at most 5 s for a lock, so it gives up rather
-- than hold calls behind it; retry it.
--
-- ⚠️ WRITE ORDER: THIS FILE FIRST. The phone-api Worker with recording code selects
-- phone_calls.recording_armed on every call read and embeds phone_call_recordings in GET /calls,
-- so it must not be deployed before this lands (GET /calls and every call webhook would fail).
-- The same holds for the edge function phone-call-summary. The notify at the end makes PostgREST
-- reload its schema cache at commit.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Deploy a phone-api Worker without recording code FIRST (see WRITE ORDER), and delete the
-- recordings at Twilio first if they must not outlive the rows (retention would have done it).
-- Dropping the table deletes every transcript and summary.
--   begin;
--   drop trigger if exists phone_call_recordings_realtime_ins on public.phone_call_recordings;
--   drop trigger if exists phone_call_recordings_realtime_upd on public.phone_call_recordings;
--   -- Optional: re-run 261 PART 2 (phone_realtime_notify), 254 PART 6 (the two RPCs) and
--   -- 259 PART 6 (usage_charges_enqueue). With the table gone the new branches never run, but
--   -- the enqueue and the notify name the table, so re-run those two BEFORE dropping it.
--   -- Leave phone_usage_armed as 263 wrote it: for the four call and text meters (the only
--   -- ones anything asks it about once the two rows below are deleted) it answers as 259's.
--   drop function if exists public.phone_recordings_claim(integer, integer);
--   drop function if exists public.phone_recording_summary_claim(uuid, integer);
--   drop function if exists public.phone_recordings_expired(timestamptz, integer);
--   delete from public.usage_charges where source in ('recording', 'transcription');
--   alter table public.usage_charges drop constraint if exists usage_charges_source_check;
--   alter table public.usage_charges add constraint usage_charges_source_check check (source in ('call', 'sms'));
--   delete from public.usage_prices where kind in ('call_recording', 'call_transcription');
--   drop table if exists public.phone_call_recordings;
--   alter table public.phone_calls drop column if exists recording_armed;
--   alter table public.client_settings
--     drop constraint if exists client_settings_phone_recording_notice_text_chk,
--     drop constraint if exists client_settings_phone_recording_retention_chk,
--     drop column if exists phone_record_calls,
--     drop column if exists phone_recording_notice,
--     drop column if exists phone_recording_notice_text,
--     drop column if exists phone_transcribe_calls,
--     drop column if exists phone_recording_retention_days,
--     drop column if exists phone_recording_updated_at,
--     drop column if exists phone_recording_updated_by;
--   delete from supabase_migrations.schema_migrations where version = '263';
--   notify pgrst, 'reload schema';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the settings, per business; and the per-call arm
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.client_settings
  add column if not exists phone_record_calls             boolean not null default false,
  add column if not exists phone_recording_notice         boolean not null default true,
  add column if not exists phone_recording_notice_text    text,
  add column if not exists phone_transcribe_calls         boolean not null default true,
  add column if not exists phone_recording_retention_days integer not null default 365,
  add column if not exists phone_recording_updated_at     timestamptz,
  add column if not exists phone_recording_updated_by     uuid;

-- NOT VALID then VALIDATE (261's pattern; every existing row is NULL / the default, so the
-- validation is a scan that cannot fail). A re-apply passes straight through.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'client_settings_phone_recording_notice_text_chk'
                    and conrelid = 'public.client_settings'::regclass) then
    alter table public.client_settings
      add constraint client_settings_phone_recording_notice_text_chk
      check (phone_recording_notice_text is null
             or char_length(btrim(phone_recording_notice_text)) between 10 and 300) not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'client_settings_phone_recording_retention_chk'
                    and conrelid = 'public.client_settings'::regclass) then
    alter table public.client_settings
      add constraint client_settings_phone_recording_retention_chk
      check (phone_recording_retention_days in (30, 90, 180, 365, 730)) not valid;
  end if;
end $$;

alter table public.client_settings validate constraint client_settings_phone_recording_notice_text_chk;
alter table public.client_settings validate constraint client_settings_phone_recording_retention_chk;

comment on column public.client_settings.phone_record_calls is
  'Migration 263: record this business''s calls (My Synergy Phone). Default false. Only the owner turns it on (portal-settings phone_recording_save). Calls also need the phone-api Worker''s CALL_RECORDING = "on", and a call records only if its announcement played (phone_calls.recording_armed).';
comment on column public.client_settings.phone_recording_notice is
  'Migration 263: play the recording announcement. Default true and LOCKED ON for now: the Worker arms a call only while this is true, and the settings action refuses false. Kept for a later decision.';
comment on column public.client_settings.phone_recording_notice_text is
  'Migration 263: the business''s own announcement sentence, 10 to 300 characters after trimming. NULL = the standard sentence ("This call will be recorded.", or "This call will be recorded and transcribed." while transcripts are on).';
comment on column public.client_settings.phone_transcribe_calls is
  'Migration 263: transcribe and summarise recorded calls. Default true; only matters while phone_record_calls is on, and only while the Worker''s CALL_TRANSCRIBE is "on".';
comment on column public.client_settings.phone_recording_retention_days is
  'Migration 263: days a call recording is kept at Twilio before the Worker''s daily job deletes it (with its transcript; the summary stays). One of 30, 90, 180, 365 (default, as voicemail), 730.';
comment on column public.client_settings.phone_recording_updated_at is
  'Migration 263: when the recording settings were last changed (portal-settings phone_recording_save).';
comment on column public.client_settings.phone_recording_updated_by is
  'Migration 263: the auth user who last changed the recording settings: always the business owner. Kept for legal questions.';

alter table public.phone_calls
  add column if not exists recording_armed boolean not null default false;

comment on column public.phone_calls.recording_armed is
  'Migration 263: the TwiML this call ran carried the recording announcement, so it may be recorded. Written once, by the phone-api Worker when the call starts; recording only ever starts on an armed call. Never true for an emergency call or the 911 callback window.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — phone_call_recordings: one row per recorded call
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- status          starting   the Worker has claimed the call and is asking Twilio to record
--                 recording  Twilio is recording (or paused → paused, while the customer is on hold)
--                 completed  Twilio's completed callback (or the sweep backstop): audio is ready
--                 failed     the start was refused, or Twilio said so
--                 absent     Twilio heard no audio
-- channel_map     which channel is whom, e.g. {"0":"customer","1":"team"} (the Worker's mapping,
--                 kept per row so a later correction does not relabel old transcripts)
-- notice_text     the sentence the announcement used, as it was when the recording started
create table if not exists public.phone_call_recordings (
  id                uuid primary key default gen_random_uuid(),
  call_id           uuid not null unique references public.phone_calls(id) on delete cascade,
  client_id         text not null,
  recording_sid     text unique,
  status            text not null default 'starting'
    check (status in ('starting', 'recording', 'paused', 'completed', 'failed', 'absent')),
  channels          smallint check (channels is null or channels between 1 and 2),
  channel_map       jsonb,
  duration_s        integer check (duration_s is null or duration_s >= 0),
  notice_text       text check (notice_text is null or char_length(notice_text) <= 300),
  started_at        timestamptz,
  completed_at      timestamptz,
  transcript_status text not null default 'off'
    check (transcript_status in ('off', 'pending', 'working', 'done', 'failed')),
  transcript        text check (transcript is null or char_length(transcript) <= 100000),
  transcript_json   jsonb,
  summary_status    text not null default 'off'
    check (summary_status in ('off', 'pending', 'working', 'done', 'failed')),
  summary           text check (summary is null or char_length(summary) <= 1200),
  stt_cost_micros   bigint check (stt_cost_micros is null or stt_cost_micros >= 0),
  llm_cost_micros   bigint check (llm_cost_micros is null or llm_cost_micros >= 0),
  attempts          integer not null default 0 check (attempts >= 0),
  next_try_at       timestamptz,
  summary_attempts  integer not null default 0 check (summary_attempts >= 0),
  summary_next_at   timestamptz,
  lease_until       timestamptz,
  last_error        text check (last_error is null or char_length(last_error) <= 500),
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The transcript queue (phone_recordings_claim) and the summary queue (the Worker's re-ask).
create index if not exists phone_call_recordings_transcribe_due_idx
  on public.phone_call_recordings (transcript_status, next_try_at)
  where transcript_status in ('pending', 'working');
create index if not exists phone_call_recordings_summary_due_idx
  on public.phone_call_recordings (summary_status, summary_next_at)
  where summary_status in ('pending', 'working');
-- A business's recordings, newest first (reports, retention).
create index if not exists phone_call_recordings_client_completed_idx
  on public.phone_call_recordings (client_id, completed_at desc);
-- The sweep's backstop: recordings whose completed callback never came. Tiny by nature.
create index if not exists phone_call_recordings_live_idx
  on public.phone_call_recordings (created_at)
  where status in ('starting', 'recording', 'paused');
-- usage_charges_enqueue's two reads (PART 7), which filter on a time column first, like 259's.
create index if not exists phone_call_recordings_completed_idx
  on public.phone_call_recordings (completed_at);
create index if not exists phone_call_recordings_transcribed_idx
  on public.phone_call_recordings (updated_at)
  where transcript_status = 'done';

drop trigger if exists phone_call_recordings_set_updated_at on public.phone_call_recordings;
create trigger phone_call_recordings_set_updated_at
  before update on public.phone_call_recordings
  for each row execute function public.set_updated_at();

comment on table public.phone_call_recordings is
  'Migration 263: one recording per call (My Synergy Phone), dual-channel, on the customer''s leg, started by the phone-api Worker when someone answers. The audio stays at Twilio (recording_sid) and is streamed by the Worker. Also the queue for the transcript (Workers AI nova-3, the Worker''s cron) and the summary (Claude, the phone-call-summary edge function). Transcripts and summaries are customer conversations: service-role only, never logged. deleted_at = deleted at Twilio by retention; the transcript goes with the audio, the summary stays.';
comment on column public.phone_call_recordings.transcript is
  'Migration 263: the speaker-labelled transcript ("Customer: ..." / "Team: ..." lines), up to 100,000 characters. NULL once the audio is deleted. Never written to a log, phone_call_events or app_errors.';
comment on column public.phone_call_recordings.summary is
  'Migration 263: 2-4 sentences and the action items, up to 1,200 characters, from the phone-call-summary edge function. Kept when the audio and transcript are deleted.';
comment on column public.phone_call_recordings.stt_cost_micros is
  'Migration 263: what the transcript cost us (minutes × the nova-3 rate, an estimate), in micros. Server-only, like usage_charges.cost_micros.';
comment on column public.phone_call_recordings.llm_cost_micros is
  'Migration 263: what the summary cost us (Claude tokens × the list price, an estimate), in micros. Server-only.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — RLS on, zero policies, the browser roles revoked (254 PART 3's posture)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Default privileges hand every NEW table to anon AND authenticated. This one holds customer
-- conversations, so it is the service role's alone: the apps read through the Worker, the portal
-- through portal-settings. PART 8 asserts every grant.
alter table public.phone_call_recordings enable row level security;
revoke all on public.phone_call_recordings from public;
revoke all on public.phone_call_recordings from anon, authenticated;
grant select, insert, update, delete on public.phone_call_recordings to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — phone_realtime_notify: the live body (261's), plus recordings
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Copied from the live pg_get_functiondef (2026-10-04, identical to 261 PART 2's text). The edits
-- are exactly: three variables (v_table, v_op, v_id), the phone_call_recordings branch, the
-- payload reading those three when a branch set them, and the function comment. Everything 254
-- and 261 promised still holds and is not re-explained: ids-only payloads on private topics,
-- nothing for a tenant whose phone_status is not 'on', and an exception block that turns any
-- failure into a WARNING so a broadcast can never fail the write that fired it.
create or replace function public.phone_realtime_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row       jsonb;
  v_old       jsonb;
  v_client_id text;
  v_status    text;
  v_event     text;
  v_contact   jsonb;
  v_snap      jsonb;
  v_snaps     jsonb[] := '{}';
  v_ids       uuid[]  := '{}';
  v_owner     uuid;
  v_users     uuid[];
  v_payload   jsonb;
  v_uid       uuid;
  -- 263: what the payload names, when a branch tells it as another row (a recording as its call).
  v_table     text;
  v_op        text;
  v_id        jsonb;
begin
  begin
    if tg_op = 'DELETE' then
      v_row := to_jsonb(old);
    else
      v_row := to_jsonb(new);
      if tg_op = 'UPDATE' then
        v_old := to_jsonb(old);
      end if;
    end if;

    v_client_id := v_row ->> 'client_id';
    if v_client_id is null then
      return null;
    end if;

    -- DEVIATION 4: nothing is broadcast for a tenant that has not been switched on.
    select cs.phone_status into v_status
      from public.client_settings cs
     where cs.client_id = v_client_id;
    if v_status is distinct from 'on' then
      return null;
    end if;

    -- Which rows say who this belongs to. A voicemail has no people of its own: it belongs
    -- to its call's people (plan §7), and its contact is the call's.
    if tg_table_name = 'phone_calls' then
      v_event   := 'call';
      v_contact := v_row -> 'contact_id';
      v_snaps   := array[v_row];
      if v_old is not null then v_snaps := v_snaps || v_old; end if;
    elsif tg_table_name = 'phone_voicemails' then
      v_event := 'voicemail';
      select to_jsonb(c) into v_snap
        from public.phone_calls c
       where c.id = (v_row ->> 'call_id')::uuid;
      if v_snap is not null then
        v_contact := v_snap -> 'contact_id';
        v_snaps   := array[v_snap];
      end if;
    elsif tg_table_name = 'phone_call_recordings' then
      -- 263. A recording shows on its call (GET /calls), so it is told AS the call: the existing
      -- `call` event, table phone_calls, the call's id, op UPDATE, to the call's people. The
      -- apps already re-read the call on exactly that. A call that is gone tells nobody. The
      -- call row is read within this tenant only, like the owner lookup below.
      select to_jsonb(c) into v_snap
        from public.phone_calls c
       where c.id = (v_row ->> 'call_id')::uuid
         and c.client_id = v_client_id;
      if v_snap is null then
        return null;
      end if;
      v_event   := 'call';
      v_table   := 'phone_calls';
      v_op      := 'UPDATE';
      v_id      := v_snap -> 'id';
      v_contact := v_snap -> 'contact_id';
      v_snaps   := array[v_snap];
    elsif tg_table_name = 'sms_messages' then
      v_event   := 'sms';
      v_contact := v_row -> 'contact_id';
      v_snaps   := array[v_row];
      if v_old is not null then v_snaps := v_snaps || v_old; end if;
    elsif tg_table_name in ('email_sends', 'email_inbound') then
      -- 261. A sign-in code is never part of a conversation (261 choice 1).
      if v_row ->> 'kind' = 'login_code' then
        return null;
      end if;
      v_event   := 'email';
      -- The row's own contact, else the contact of the design it is about: a quote, invoice or
      -- receipt carries only short_code. Within this tenant only, like the owner lookup below.
      v_contact := v_row -> 'contact_id';
      if v_row ->> 'contact_id' is null and v_row ->> 'short_code' is not null then
        select to_jsonb(d.contact_id) into v_contact
          from public.designs d
         where d.client_id = v_client_id
           and d.short_code = v_row ->> 'short_code';
      end if;
      -- No contact, no event: the phone shows email only inside a contact's conversation.
      if v_contact is null or jsonb_typeof(v_contact) = 'null' then
        return null;
      end if;
      -- The resolved contact rides on the snapshot, so the loop below tells its owner.
      v_snaps := array[v_row || jsonb_build_object('contact_id', v_contact)];
      if v_old is not null then v_snaps := v_snaps || v_old; end if;
    else
      return null;
    end if;

    -- The people. Keys a table does not have read as NULL and fall out below, which is what
    -- lets one loop serve both a call (placed_by, answered_by, transferred_from,
    -- rang_user_ids) and a text or an email (sent_by).
    foreach v_snap in array v_snaps loop
      v_ids := v_ids || array[
        (v_snap ->> 'placed_by')::uuid,
        (v_snap ->> 'answered_by')::uuid,
        (v_snap ->> 'transferred_from')::uuid,
        (v_snap ->> 'sent_by')::uuid
      ];
      if jsonb_typeof(v_snap -> 'rang_user_ids') = 'array' then
        v_ids := v_ids || array(select x::uuid
                                  from jsonb_array_elements_text(v_snap -> 'rang_user_ids') as r(x));
      end if;
      -- The contact's owner, within this tenant only: a mis-linked contact id must not tell
      -- another builder's staff that anything happened.
      if (v_snap ->> 'contact_id') is not null then
        select c.owner_user_id into v_owner
          from public.crm_contacts c
         where c.id = (v_snap ->> 'contact_id')::uuid
           and c.client_id = v_client_id;
        v_ids := v_ids || v_owner;
      end if;
    end loop;

    select coalesce(array_agg(distinct u), '{}'::uuid[]) into v_users
      from unnest(v_ids) as u
     where u is not null;

    -- IDS ONLY. Broadcast from the database skips table RLS, so nothing else rides along.
    v_payload := jsonb_build_object(
      'table',      coalesce(v_table, tg_table_name),
      'op',         coalesce(v_op, tg_op),
      'id',         coalesce(v_id, v_row -> 'id'),
      'contact_id', v_contact
    );

    perform realtime.send(v_payload, v_event, 'phone:' || v_client_id, true);
    foreach v_uid in array v_users loop
      perform realtime.send(v_payload, v_event, 'phone:user:' || v_uid::text, true);
    end loop;
  exception
    when others then
      raise warning 'phone_realtime_notify(%): % (%)', tg_table_name, sqlerrm, sqlstate;
  end;
  return null;  -- AFTER trigger; the return value is ignored
end
$fn$;

comment on function public.phone_realtime_notify() is
  'SSS Phone (migrations 254, 261, 263): AFTER trigger on phone_calls, phone_voicemails, sms_messages, email_sends, email_inbound and phone_call_recordings. Sends {table, op, id, contact_id} with realtime.send(..., private => true) on phone:<client_id> and on phone:user:<id> for each of the row''s people, only while the tenant''s phone_status is on. An email''s contact is its own contact_id, else its design''s; an email with no contact, and a login code, send nothing. A recording is told as its call (event call, table phone_calls, the call''s id). Never fails the write: every error becomes a WARNING.';

revoke execute on function public.phone_realtime_notify() from public, anon, authenticated;

-- Two triggers, because a WHEN clause that reads OLD cannot sit on an INSERT trigger. An update
-- broadcasts only when something the apps show changed (choice 8): the cron's lease, attempt and
-- next-try writes stay quiet, and so do a claim (pending to working) and a back-off (working to
-- pending), which the apps both read as pending; every team device would re-read GET /calls on
-- each. No DELETE: a recording row goes only with its call (cascade).
drop trigger if exists phone_call_recordings_realtime_ins on public.phone_call_recordings;
create trigger phone_call_recordings_realtime_ins
  after insert on public.phone_call_recordings
  for each row execute function public.phone_realtime_notify();

drop trigger if exists phone_call_recordings_realtime_upd on public.phone_call_recordings;
create trigger phone_call_recordings_realtime_upd
  after update on public.phone_call_recordings
  for each row
  when (old.status            is distinct from new.status
     or (old.transcript_status is distinct from new.transcript_status
         and not (old.transcript_status in ('pending', 'working') and new.transcript_status in ('pending', 'working')))
     or (old.summary_status    is distinct from new.summary_status
         and not (old.summary_status in ('pending', 'working') and new.summary_status in ('pending', 'working')))
     or old.deleted_at        is distinct from new.deleted_at)
  execute function public.phone_realtime_notify();

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — the queue's three functions. SECURITY DEFINER, search_path '', service_role only.
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── phone_recordings_claim: lease the next recordings to transcribe ─────────────────────
-- usage_charges_claim's shape (259): SKIP LOCKED, so two overlapping cron runs take different
-- rows; the lease keeps a row from being taken twice once the claim has committed; attempts counts
-- claims, so the Worker gives up on a row that keeps failing. Only a completed recording whose
-- audio still exists is due. Its transcript_status becomes 'working' (a lapsed 'working' lease is
-- due again: the run that held it died).
create or replace function public.phone_recordings_claim(p_limit integer, p_lease_s integer)
returns setof public.phone_call_recordings
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'phone_recordings_claim: p_limit must be 1..50 (got %)', p_limit;
  end if;
  if p_lease_s is null or p_lease_s < 30 or p_lease_s > 3600 then
    raise exception 'phone_recordings_claim: p_lease_s must be 30..3600 (got %)', p_lease_s;
  end if;

  return query
    with picked as (
      select r.id
        from public.phone_call_recordings r
       where r.transcript_status in ('pending', 'working')
         and r.status = 'completed'
         and r.deleted_at is null
         and r.recording_sid is not null
         and coalesce(r.next_try_at, r.created_at) <= pg_catalog.now()
         and (r.lease_until is null or r.lease_until < pg_catalog.now())
       order by coalesce(r.next_try_at, r.created_at), r.created_at
       limit p_limit
         for update skip locked
    )
    update public.phone_call_recordings r
       set transcript_status = 'working',
           lease_until       = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_s),
           attempts          = r.attempts + 1
      from picked
     where r.id = picked.id
    returning r.*;
end
$fn$;

comment on function public.phone_recordings_claim(integer, integer) is
  'Migration 263. Leases up to p_limit completed recordings due for a transcript (transcript_status pending, or working with a lapsed lease; next_try_at passed; audio not deleted) for p_lease_s seconds, FOR UPDATE SKIP LOCKED; transcript_status working, attempts + 1. Returns the leased rows. Service-role only (phone-api cron/transcribe.ts).';

revoke execute on function public.phone_recordings_claim(integer, integer) from public, anon, authenticated;
grant  execute on function public.phone_recordings_claim(integer, integer) to service_role;

-- ── phone_recording_summary_claim: one recording, for the summary ───────────────────────
-- The edge function's claim, idempotent: a repeated ask (the Worker asks again after 2 minutes
-- while a summary is pending) finds the row already working and gets NULL, so Claude is asked
-- once. A lapsed lease is claimable again (the function that held it died). Returns what the
-- function needs and nothing more, as one object; NULL when there is nothing to do.
create or replace function public.phone_recording_summary_claim(p_id uuid, p_lease_s integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_out jsonb;
begin
  if p_lease_s is null or p_lease_s < 30 or p_lease_s > 900 then
    raise exception 'phone_recording_summary_claim: p_lease_s must be 30..900 (got %)', p_lease_s;
  end if;
  if p_id is null then
    return null;
  end if;

  update public.phone_call_recordings r
     set summary_status   = 'working',
         lease_until      = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_s),
         summary_attempts = r.summary_attempts + 1
   where r.id = p_id
     and r.transcript_status = 'done'
     and r.transcript is not null
     and r.deleted_at is null
     and (r.summary_status = 'pending'
          or (r.summary_status = 'working' and (r.lease_until is null or r.lease_until < pg_catalog.now())))
  returning jsonb_build_object(
              'id',               r.id,
              'client_id',        r.client_id,
              'transcript',       r.transcript,
              'summary_attempts', r.summary_attempts,
              'duration_s',       r.duration_s,
              'direction',        (select c.direction from public.phone_calls c where c.id = r.call_id))
    into v_out;
  return v_out;
end
$fn$;

comment on function public.phone_recording_summary_claim(uuid, integer) is
  'Migration 263. Claims one recording for its summary: summary_status pending (or working with a lapsed lease) → working, lease p_lease_s seconds, summary_attempts + 1, only while its transcript is done and its audio not deleted. Returns {id, client_id, transcript, summary_attempts, duration_s, direction}, or NULL when there is nothing to claim. Service-role only (the phone-call-summary edge function).';

revoke execute on function public.phone_recording_summary_claim(uuid, integer) from public, anon, authenticated;
grant  execute on function public.phone_recording_summary_claim(uuid, integer) to service_role;

-- ── phone_recordings_expired: what the daily retention job deletes ──────────────────────
-- Read-only. Each business's own retention (client_settings.phone_recording_retention_days, 365
-- without a row), counted from when the recording ended (else started, else the row). A recording
-- still live is never returned unless its row is over a day older than its retention: no call
-- lasts that long, so it is a row whose callbacks were lost. Oldest first.
create or replace function public.phone_recordings_expired(p_now timestamptz, p_limit integer)
returns table (id uuid, call_id uuid, client_id text, recording_sid text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select r.id, r.call_id, r.client_id, r.recording_sid
    from public.phone_call_recordings r
    left join public.client_settings cs on cs.client_id = r.client_id
   where r.deleted_at is null
     and coalesce(r.completed_at, r.started_at, r.created_at)
         < p_now - pg_catalog.make_interval(days => coalesce(cs.phone_recording_retention_days, 365))
     and (r.status in ('completed', 'failed', 'absent')
          or r.created_at < p_now - pg_catalog.make_interval(days => coalesce(cs.phone_recording_retention_days, 365) + 1))
   order by coalesce(r.completed_at, r.started_at, r.created_at)
   limit greatest(0, least(coalesce(p_limit, 0), 1000));
$fn$;

comment on function public.phone_recordings_expired(timestamptz, integer) is
  'Migration 263. The call recordings past their business''s retention (client_settings.phone_recording_retention_days, 365 by default) at p_now and not deleted yet, oldest first, at most p_limit (≤ 1000): {id, call_id, client_id, recording_sid}. A live recording only once its row is a day past retention. Read-only. Service-role only (phone-api cron/retention.ts).';

revoke execute on function public.phone_recordings_expired(timestamptz, integer) from public, anon, authenticated;
grant  execute on function public.phone_recordings_expired(timestamptz, integer) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 6 — the Worker's two RPCs learn `recording`
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Both are 254 PART 6's text (verified identical to live, see the header) with the recording
-- columns read from the client_settings row each already reads, returned as
--   recording: {on, notice, notice_text, transcribe}
-- `on` false and the rest at their defaults when the business has no settings row. The Worker
-- decides "armed" from this plus its own env rail; the database never says a call is recorded.

-- ── phone_route_for_number: everything /voice/inbound needs, in one call ────────────────
create or replace function public.phone_route_for_number(p_e164 text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_num       public.sms_numbers%rowtype;
  v_route     public.phone_routes%rowtype;
  v_has_route boolean;
  v_status    text;
  v_business  text;
  v_members   jsonb;
  v_emergency uuid;
  -- 263: the business's recording settings.
  v_rec_on     boolean;
  v_rec_notice boolean;
  v_rec_text   text;
  v_rec_trans  boolean;
begin
  -- The live number. sms_numbers_live_unique (165) makes this at most one row.
  select n.* into v_num
    from public.sms_numbers n
   where n.phone_number = p_e164
     and n.released_at is null
   limit 1;
  if not found then
    return null;
  end if;

  select cs.phone_status, cs.business_name,
         cs.phone_record_calls, cs.phone_recording_notice, cs.phone_recording_notice_text, cs.phone_transcribe_calls
    into v_status, v_business,
         v_rec_on, v_rec_notice, v_rec_text, v_rec_trans
    from public.client_settings cs
   where cs.client_id = v_num.client_id;

  -- A route filed under a different tenant than the number's owner is ignored rather than
  -- believed: ringing another builder's staff is the one thing this must never do.
  select r.* into v_route
    from public.phone_routes r
   where r.number_id = v_num.id
     and r.client_id = v_num.client_id;
  v_has_route := found;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id',         m.user_id,
           'identity',        'u_' || replace(m.user_id::text, '-', '') || '_g'
                                   || coalesce(s.device_generation, 1)::text,
           'dnd',             coalesce(s.dnd, false)
                                and (s.dnd_until is null or s.dnd_until > now()),
           'busy',            exists (
                                select 1 from public.phone_calls c
                                 where c.status in ('ringing', 'in_progress')
                                   and c.answered_by = m.user_id
                                   and c.started_at > now() - case when c.status = 'ringing'
                                                                   then interval '10 minutes'
                                                                   else interval '4 hours' end)
                              or exists (
                                -- DEVIATION 10: the person who placed a call stops being on
                                -- it the moment they hand it on. A transfer writes
                                -- transferred_from, so a placed call counts only while that
                                -- is still NULL (the Worker's own rule in routes/calls.ts,
                                -- `!call.transferred_from`). Stricter than "is distinct from
                                -- this person": a second hop moves transferred_from to the
                                -- teammate, and the placer must not turn busy again.
                                select 1 from public.phone_calls c
                                 where c.status in ('ringing', 'in_progress')
                                   and c.placed_by = m.user_id
                                   and c.transferred_from is null
                                   and c.started_at > now() - case when c.status = 'ringing'
                                                                   then interval '10 minutes'
                                                                   else interval '4 hours' end)
                              or exists (
                                -- DEVIATION 13: the Worker's THIRD clause (conference.ts
                                -- onTheCall). During a warm transfer the call sits in its
                                -- conference (transfer_state = 'conference') with answered_by
                                -- moved to the teammate and transferred_from = the person who
                                -- handed it on, who may still be in the room consulting. They
                                -- are on the call until the conference ends, so a new inbound
                                -- call must not ring them in the middle of it.
                                select 1 from public.phone_calls c
                                 where c.status in ('ringing', 'in_progress')
                                   and c.transfer_state = 'conference'
                                   and c.transferred_from = m.user_id
                                   and c.started_at > now() - case when c.status = 'ringing'
                                                                   then interval '10 minutes'
                                                                   else interval '4 hours' end),
           'has_access',      cu.user_id is not null
                                and public.area_level_for(cu.role, cu.title, cu.access, 'phone') <> 'none',
           'full_name',       cu.full_name,
           'forward_to_cell', s.forward_to_cell
         ) order by m.ord), '[]'::jsonb)
    into v_members
    from (
      -- First position wins for a repeated id; NULLs are skipped (the CHECK forbids them, but
      -- this is the read the call path depends on).
      select u.user_id, min(u.ord) as ord
        from unnest(case when v_has_route then v_route.members else '{}'::uuid[] end)
             with ordinality as u(user_id, ord)
       where u.user_id is not null
       group by u.user_id
    ) m
    left join public.phone_user_settings s on s.user_id = m.user_id
    left join public.client_users cu
           on cu.user_id = m.user_id
          and cu.client_id = v_num.client_id;

  -- The dispatcher's callback (plan §14): within 60 minutes of a 911 call from this number,
  -- the Worker rings only the person who dialed it, ignoring DND and busy.
  select c.placed_by into v_emergency
    from public.phone_calls c
   where c.number_id = v_num.id
     and c.is_emergency
     and c.direction = 'out'
     and c.placed_by is not null
     and c.started_at > now() - interval '60 minutes'
   order by c.started_at desc
   limit 1;

  return jsonb_build_object(
    'client_id',             v_num.client_id,
    'number_id',             v_num.id,
    'phone_status',          coalesce(v_status, 'off'),
    'route',                 case when v_has_route then to_jsonb(v_route) end,
    'members',               v_members,
    'business_name',         v_business,
    'recent_emergency_user', v_emergency,
    'recording',             jsonb_build_object(
                               'on',          coalesce(v_rec_on, false),
                               'notice',      coalesce(v_rec_notice, true),
                               'notice_text', v_rec_text,
                               'transcribe',  coalesce(v_rec_trans, true))
  );
end
$fn$;

comment on function public.phone_route_for_number(text) is
  'SSS Phone (migrations 254, 263): the one database call behind /voice/inbound. Returns {client_id, number_id, phone_status, route, members:[{user_id, identity, dnd, busy, has_access, full_name, forward_to_cell}], business_name, recent_emergency_user, recording:{on, notice, notice_text, transcribe}} for a live number, NULL otherwise. Uncached by design. service_role only.';

revoke execute on function public.phone_route_for_number(text) from public, anon, authenticated;
grant  execute on function public.phone_route_for_number(text) to service_role;

-- ── phone_caller_context: who is this signed-in person, for /token and /voice/outbound ──
create or replace function public.phone_caller_context(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
           'client_id',         cu.client_id,
           'phone_status',      coalesce(cs.phone_status, 'off'),
           'phone_level',       public.area_level_for(cu.role, cu.title, cu.access, 'phone'),
           'contacts_level',    public.area_level_for(cu.role, cu.title, cu.access, 'contacts'),
           'own_contacts_only', public.area_level_for(cu.role, cu.title, cu.access, 'contacts') = 'own',
           'device_generation', coalesce(s.device_generation, 1),
           'number',            (select jsonb_build_object(
                                          'id',                  n.id,
                                          'e164',                n.phone_number,
                                          'voice_enabled',       n.voice_enabled,
                                          'registration_status', n.registration_status)
                                   from public.sms_numbers n
                                  where n.client_id = cu.client_id
                                    and n.released_at is null
                                  order by (n.phone_number = cs.sms_number) desc nulls last,
                                           n.purchased_at desc
                                  limit 1),
           'full_name',         cu.full_name,
           'recording',         jsonb_build_object(
                                  'on',          coalesce(cs.phone_record_calls, false),
                                  'notice',      coalesce(cs.phone_recording_notice, true),
                                  'notice_text', cs.phone_recording_notice_text,
                                  'transcribe',  coalesce(cs.phone_transcribe_calls, true))
         )
    from public.client_users cu
    left join public.client_settings cs on cs.client_id = cu.client_id
    left join public.phone_user_settings s on s.user_id = cu.user_id
   where cu.user_id = p_user_id
   limit 1;
$fn$;

comment on function public.phone_caller_context(uuid) is
  'SSS Phone (migrations 254, 263): one uncached read of a signed-in person for /token and every /voice/outbound: {client_id, phone_status, phone_level, contacts_level, own_contacts_only, device_generation, number, full_name, recording:{on, notice, notice_text, transcribe}}. NULL when the user is on no team. service_role only.';

revoke execute on function public.phone_caller_context(uuid) from public, anon, authenticated;
grant  execute on function public.phone_caller_context(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 7 — the meters: recordings and transcripts are charged like calls, once armed
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- usage_charges.source widens. Every existing row is call or sms, so the re-validation is a scan
-- that cannot fail. The constraint name is the one Postgres gave 259's inline CHECK (checked live).
alter table public.usage_charges drop constraint if exists usage_charges_source_check;
alter table public.usage_charges
  add constraint usage_charges_source_check
  check (source in ('call', 'sms', 'recording', 'transcription'));

comment on column public.usage_charges.source is
  'Migrations 259, 263: call (phone_calls.id) | sms (sms_messages.id) | recording | transcription (both phone_call_recordings.id). The unique (source, source_id) keeps a recording''s two charges apart.';

-- ── usage_charges_enqueue: 259's body plus two branches ─────────────────────────────────
-- Copied from the live pg_get_functiondef (2026-10-04, identical to 259 PART 6's text); the only
-- edit is the two union branches and the comment. A recording is queued once Twilio has it
-- (status completed); its transcript once the transcript is done AND the summary has settled
-- (done, failed, or off), because the charge is the two together. Both carry the call's
-- direction and started_at, so armed_at is compared with when the CALL happened, as for calls.
create or replace function public.usage_charges_enqueue(p_since timestamptz, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
begin
  if p_since is null then
    raise exception 'usage_charges_enqueue: p_since is required';
  end if;
  if p_limit is null or p_limit < 0 or p_limit > 5000 then
    raise exception 'usage_charges_enqueue: p_limit must be 0..5000 (got %)', p_limit;
  end if;

  insert into public.usage_charges (source, source_id, client_id, direction, occurred_at)
  select s.source, s.source_id, s.client_id, s.direction, s.occurred_at
    from (
      select 'call'::text as source, c.id as source_id, c.client_id, c.direction,
             c.started_at as occurred_at, c.ended_at as ready_at
        from public.phone_calls c
       where c.ended_at >= p_since
         and c.status in ('completed', 'missed', 'voicemail', 'no_answer', 'busy', 'failed')
         and not exists (select 1 from public.usage_charges u
                          where u.source = 'call' and u.source_id = c.id)
      union all
      select 'sms'::text, m.id, m.client_id, m.direction, m.created_at, m.created_at
        from public.sms_messages m
       where m.created_at >= p_since
         and m.provider_sid is not null and m.provider_sid <> ''
         and ((m.direction = 'out' and m.status in ('sent', 'delivered', 'undelivered', 'failed'))
              or (m.direction = 'in' and m.status = 'received'))
         and not exists (select 1 from public.usage_charges u
                          where u.source = 'sms' and u.source_id = m.id)
      union all
      -- 263: a call recording Twilio has finished.
      select 'recording'::text, r.id, r.client_id, c.direction, c.started_at, r.completed_at
        from public.phone_call_recordings r
        join public.phone_calls c on c.id = r.call_id
       where r.completed_at >= p_since
         and r.status = 'completed'
         and not exists (select 1 from public.usage_charges u
                          where u.source = 'recording' and u.source_id = r.id)
      union all
      -- 263: its transcript and summary, once both have settled. Ready when it last changed,
      -- which is never before the recording completed (either time inside the window counts).
      select 'transcription'::text, r.id, r.client_id, c.direction, c.started_at,
             greatest(r.completed_at, r.updated_at)
        from public.phone_call_recordings r
        join public.phone_calls c on c.id = r.call_id
       where (r.updated_at >= p_since or r.completed_at >= p_since)
         and r.transcript_status = 'done'
         and r.summary_status in ('done', 'failed', 'off')
         and not exists (select 1 from public.usage_charges u
                          where u.source = 'transcription' and u.source_id = r.id)
    ) s
   order by s.ready_at, s.source, s.source_id
   limit p_limit
  on conflict (source, source_id) do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.usage_charges_enqueue(timestamptz, integer) is
  'Migrations 259, 263. Queues finished calls (ended_at >= p_since), texts with a Twilio SID (created_at >= p_since), completed call recordings (completed_at >= p_since) and settled transcripts (transcript done, summary done/failed/off; updated_at or completed_at >= p_since) into usage_charges, oldest first, at most p_limit, skipping ones already queued. Returns the number queued. Service-role only (phone-api cron/usageCharge.ts).';

revoke execute on function public.usage_charges_enqueue(timestamptz, integer) from public, anon, authenticated;
grant  execute on function public.usage_charges_enqueue(timestamptz, integer) to service_role;

-- ── The two meters, INACTIVE and INVISIBLE (259 PART 2's rows' posture) ─────────────────
-- cost_plus: price_cents is unused; the charge is our cost times phone_billing_settings.markup.
-- phone_usage_armed (re-issued just below) arms these two on `active` ONLY: a pilot covers calls
-- and texts, never them. So until Carolyn prices and activates them every recording and
-- transcript settles as a shadow row with its cost, pilot tenant or not. To arm, later:
--   update public.usage_prices set active = true where kind in ('call_recording', 'call_transcription');
-- (and the 259 ARMING notes for the markup and armed_at, which these share with calls).
insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note, pricing)
values
  ('call_recording',     'Call recording',                 'minute', 0, false, false, 44,
   'Migration 263. Call recording, cost_plus: each recording is charged its Twilio recording price (an estimate of $0.0025 per minute until Twilio prices it) times phone_billing_settings.markup. price_cents is unused. Charged per recording by the phone-api Worker; storage is not metered.', 'cost_plus'),
  ('call_transcription', 'Call transcripts and summaries', 'minute', 0, false, false, 45,
   'Migration 263. A recorded call''s transcript (Workers AI nova-3, estimated per minute) and summary (Claude, estimated from its tokens), cost_plus: charged as one line per recording, the two costs times phone_billing_settings.markup. price_cents is unused. Charged per recording by the phone-api Worker.', 'cost_plus')
on conflict (kind) do nothing;

-- ── phone_usage_armed: the pilot list covers the four call and text meters only ─────────
-- 259's body (the live one, read 2026-10-04) armed ANY meter with a usage_prices row for a pilot
-- tenant. That would arm the two rows above the day Carolyn pilots call and text billing (259's
-- ARMING step 2): every recorded call of that builder would debit a recording line and a
-- transcript line nobody priced and the price list does not show. The one edit: the pilot clause
-- names 259's four meters; every other meter needs `active`. Nothing changes for those four, so
-- wallet_usage_gate and _shared/usageGate.ts behave exactly as before. Still THE ONE DEFINITION
-- of armed (259); phoneBillingAdmin.ts mirrors it.
create or replace function public.phone_usage_armed(p_client_id text, p_meter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((
    select s.markup is not null
       and s.armed_at is not null
       and (coalesce(up.active, false)
            or (p_meter = any (array['voice_minute', 'voice_minute_in', 'sms_segment', 'sms_in'])
                and coalesce(p_client_id = any (s.pilot_client_ids), false)))
      from public.phone_billing_settings s
      join public.usage_prices up on up.kind = p_meter
     where s.id
  ), false);
$fn$;

comment on function public.phone_usage_armed(text, text) is
  'Migrations 259, 263. true when phone_billing_settings has a markup and armed_at, the usage_prices row p_meter exists, and it is active, or p_meter is one of the four call and text meters (voice_minute, voice_minute_in, sms_segment, sms_in) and p_client_id is in pilot_client_ids. A pilot never arms another meter (call_recording, call_transcription). The env rail PHONE_USAGE_METERS is checked by the caller. Service-role only.';

revoke execute on function public.phone_usage_armed(text, text) from public, anon, authenticated;
grant  execute on function public.phone_usage_armed(text, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 8 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_col  text;
  v_type text;
  v_null boolean;
  v_def  text;
  v_role text;
  v_priv text;
  v_fn   text;
  v_t    constant text := 'public.phone_call_recordings';
  v_ntf  constant text := 'public.phone_realtime_notify()';
begin
  -- ── PART 1: the seven settings columns, typed, with their defaults ──
  for v_col, v_type, v_null, v_def in
    select * from (values
      ('phone_record_calls',             'boolean',                  true,  'false'),
      ('phone_recording_notice',         'boolean',                  true,  'true'),
      ('phone_recording_notice_text',    'text',                     false, null),
      ('phone_transcribe_calls',         'boolean',                  true,  'true'),
      ('phone_recording_retention_days', 'integer',                  true,  '365'),
      ('phone_recording_updated_at',     'timestamp with time zone', false, null),
      ('phone_recording_updated_by',     'uuid',                     false, null)
    ) as t(c, ty, nn, d)
  loop
    if not exists (select 1 from pg_catalog.pg_attribute a
                    left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
                    where a.attrelid = 'public.client_settings'::regclass and a.attname = v_col
                      and not a.attisdropped
                      and pg_catalog.format_type(a.atttypid, a.atttypmod) = v_type
                      and a.attnotnull = v_null
                      and pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) is not distinct from v_def) then
      raise exception '263: client_settings.% is missing, not %, or has the wrong NOT NULL / default', v_col, v_type;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_constraint
       where conrelid = 'public.client_settings'::regclass and contype = 'c' and convalidated
         and conname in ('client_settings_phone_recording_notice_text_chk', 'client_settings_phone_recording_retention_chk')) <> 2 then
    raise exception '263: a recording CHECK on client_settings is missing or not validated';
  end if;
  -- client_settings is service-role only (choice 3). Asserted for the new columns, so a browser
  -- grant added since cannot quietly expose who turned recording on.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_col in array array['phone_record_calls', 'phone_recording_notice', 'phone_recording_notice_text',
                                 'phone_transcribe_calls', 'phone_recording_retention_days',
                                 'phone_recording_updated_at', 'phone_recording_updated_by'] loop
      if has_column_privilege(v_role, 'public.client_settings', v_col, 'SELECT')
         or has_column_privilege(v_role, 'public.client_settings', v_col, 'UPDATE') then
        raise exception '263: % can read or write client_settings.% from the browser', v_role, v_col;
      end if;
    end loop;
  end loop;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
                  where a.attrelid = 'public.phone_calls'::regclass and a.attname = 'recording_armed'
                    and not a.attisdropped and a.atttypid = 'boolean'::regtype and a.attnotnull
                    and pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) = 'false') then
    raise exception '263: phone_calls.recording_armed is missing, or not boolean NOT NULL DEFAULT false';
  end if;

  -- ── PART 2/3: the table, locked down ──
  if to_regclass(v_t) is null then
    raise exception '263: phone_call_recordings is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_t::regclass) then
    raise exception '263: RLS is off on phone_call_recordings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = v_t::regclass) then
    raise exception '263: phone_call_recordings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, v_t, v_priv) then
        raise exception '263: % holds % on phone_call_recordings — call transcripts would be readable from the browser', v_role, v_priv;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', v_t, v_priv) then
      raise exception '263: service_role lacks % on phone_call_recordings', v_priv;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = v_t::regclass and contype = 'u'
                    and conkey = array[(select attnum from pg_catalog.pg_attribute
                                         where attrelid = v_t::regclass and attname = 'call_id')]::int2[]) then
    raise exception '263: phone_call_recordings.call_id is not UNIQUE (choice 4: one recording per call)';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = v_t::regclass and contype = 'f' and confrelid = 'public.phone_calls'::regclass
                    and confdeltype = 'c') then
    raise exception '263: phone_call_recordings.call_id does not reference phone_calls ON DELETE CASCADE';
  end if;

  -- ── PART 4: the notify, still a definer nobody may call, with the recordings branch; the
  --    triggers fire exactly when PART 4 says. tgtype bits: 1 row, 2 before, 4 insert,
  --    8 delete, 16 update. ──
  if has_function_privilege('anon', v_ntf, 'EXECUTE') or has_function_privilege('authenticated', v_ntf, 'EXECUTE') then
    raise exception '263: phone_realtime_notify is callable from the browser';
  end if;
  if not (select p.prosecdef and p.proconfig @> array['search_path=""']
            from pg_catalog.pg_proc p where p.oid = v_ntf::regprocedure) then
    raise exception '263: phone_realtime_notify lost SECURITY DEFINER or its empty search_path';
  end if;
  if position('''phone_call_recordings''' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = v_ntf::regprocedure)) = 0
     or position('''email_inbound''' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = v_ntf::regprocedure)) = 0 then
    raise exception '263: phone_realtime_notify lacks the recordings branch, or lost 261''s email branch';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'phone_call_recordings_realtime_ins' and t.tgrelid = v_t::regclass
                    and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = v_ntf::regprocedure
                    and t.tgtype = 1 + 4 and t.tgqual is null) then
    raise exception '263: phone_call_recordings_realtime_ins is missing, disabled, or not AFTER INSERT FOR EACH ROW';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'phone_call_recordings_realtime_upd' and t.tgrelid = v_t::regclass
                    and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = v_ntf::regprocedure
                    and t.tgtype = 1 + 16 and t.tgqual is not null) then
    raise exception '263: phone_call_recordings_realtime_upd is missing, disabled, not AFTER UPDATE FOR EACH ROW, or has no WHEN';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgname = 'phone_call_recordings_set_updated_at' and t.tgrelid = v_t::regclass
                    and not t.tgisinternal and t.tgenabled = 'O' and t.tgtype = 1 + 2 + 16) then
    raise exception '263: phone_call_recordings_set_updated_at is missing or not BEFORE UPDATE FOR EACH ROW';
  end if;
  -- 254's and 261's five broadcast triggers are untouched.
  if (select count(*) from pg_catalog.pg_trigger t
       where not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = v_ntf::regprocedure
         and t.tgrelid in ('public.phone_calls'::regclass, 'public.phone_voicemails'::regclass,
                           'public.sms_messages'::regclass, 'public.email_sends'::regclass,
                           'public.email_inbound'::regclass)) <> 5 then
    raise exception '263: the five existing broadcast triggers are not all in place';
  end if;

  -- ── PART 5 and 6: every function the service role's alone, and a definer where it writes ──
  foreach v_fn in array array['public.phone_recordings_claim(integer, integer)',
                              'public.phone_recording_summary_claim(uuid, integer)',
                              'public.phone_recordings_expired(timestamptz, integer)',
                              'public.phone_route_for_number(text)',
                              'public.phone_caller_context(uuid)',
                              'public.usage_charges_enqueue(timestamptz, integer)'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '263: % is callable from the browser', v_fn;
    end if;
    if exists (select 1 from pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = v_fn::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception '263: % is still executable by PUBLIC', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '263: service_role cannot call %', v_fn;
    end if;
    if not (select p.proconfig @> array['search_path=""'] from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception '263: % lost its empty search_path', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['public.phone_recordings_claim(integer, integer)',
                              'public.phone_recording_summary_claim(uuid, integer)',
                              'public.phone_recordings_expired(timestamptz, integer)',
                              'public.usage_charges_enqueue(timestamptz, integer)'] loop
    if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception '263: % is not SECURITY DEFINER', v_fn;
    end if;
  end loop;
  -- Both RPCs return `recording`, and nothing else in them moved (a token of each of 254's rules).
  if position('''recording''' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.phone_route_for_number(text)'::regprocedure)) = 0
     or position('recent_emergency_user' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.phone_route_for_number(text)'::regprocedure)) = 0
     or position('transfer_state = ''conference''' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.phone_route_for_number(text)'::regprocedure)) = 0 then
    raise exception '263: phone_route_for_number does not return recording, or lost a 254 rule';
  end if;
  if position('''recording''' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.phone_caller_context(uuid)'::regprocedure)) = 0
     or position('device_generation' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.phone_caller_context(uuid)'::regprocedure)) = 0 then
    raise exception '263: phone_caller_context does not return recording, or lost a 254 key';
  end if;

  -- ── PART 7: the source check takes the four sources; the enqueue reads recordings; the two
  --    meters exist, OFF and hidden; the pilot list arms only the four call and text meters
  --    (PART 9 checks the answers) ──
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.usage_charges'::regclass and conname = 'usage_charges_source_check'
                    and convalidated
                    and pg_catalog.pg_get_constraintdef(oid) like '%''recording''%'
                    and pg_catalog.pg_get_constraintdef(oid) like '%''transcription''%'
                    and pg_catalog.pg_get_constraintdef(oid) like '%''call''%'
                    and pg_catalog.pg_get_constraintdef(oid) like '%''sms''%') then
    raise exception '263: usage_charges_source_check does not take call, sms, recording and transcription';
  end if;
  if position('phone_call_recordings' in (select p.prosrc from pg_catalog.pg_proc p
                                           where p.oid = 'public.usage_charges_enqueue(timestamptz, integer)'::regprocedure)) = 0 then
    raise exception '263: usage_charges_enqueue does not queue recordings';
  end if;
  if (select count(*) from public.usage_prices
       where kind in ('call_recording', 'call_transcription') and pricing = 'cost_plus' and unit_label = 'minute') <> 2 then
    raise exception '263: the call_recording / call_transcription meters are missing, not cost_plus, or not per minute';
  end if;
  if position('''sms_in''' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.phone_usage_armed(text, text)'::regprocedure)) = 0
     or position('pilot_client_ids' in (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.phone_usage_armed(text, text)'::regprocedure)) = 0
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = 'public.phone_usage_armed(text, text)'::regprocedure)
     or pg_catalog.has_function_privilege('authenticated', 'public.phone_usage_armed(text, text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.phone_usage_armed(text, text)', 'EXECUTE') then
    raise exception '263: phone_usage_armed does not limit the pilot list to the four call and text meters, or is not service-role only';
  end if;
  if exists (select 1 from public.usage_prices where kind in ('call_recording', 'call_transcription') and (active or visible)) then
    -- Only on a FIRST apply: a re-apply after Carolyn armed them keeps her rows (on conflict do
    -- nothing) and must not abort. Armed means a markup and armed_at too (259), so check that.
    if not exists (select 1 from public.phone_billing_settings s where s.id and s.armed_at is not null) then
      raise exception '263: a recording meter is active or visible while nothing is armed';
    end if;
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 9 — behavioural probe. Synthetic rows, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 254's and 261's pattern: exercise what matters, then raise ROLLBACK_PROBE so every write in the
-- inner block vanishes (realtime.messages rows included: Realtime streams only COMMITTED rows, so
-- no phone ever hears of them). The tenant is obviously fake.
--
-- Isolated from live rows on purpose: the synthetic call and its recordings are dated a day in
-- the FUTURE, and the enqueue is asked only for rows after that, so it can never queue (or lock)
-- a real call, text or recording; the synthetic recording's next_try_at is in 2000, so the claim
-- (oldest first, limit 1) takes it before anything real.
do $probe$
declare
  k_cid     constant text := 'phone-recording-probe-263';
  k_future  constant timestamptz := now() + interval '2 days';
  v_call    uuid;
  v_rec     uuid;
  v_old     uuid;
  v_got     jsonb;
  v_n       integer;
  v_ids     uuid[];
  v_srcs    text[];
  v_live    boolean;
  v_refused boolean;
begin
  begin
    insert into public.client_settings (client_id, phone_status, business_name, phone_record_calls)
    values (k_cid, 'on', 'Probe Sheds', true);

    -- ── 1. The settings CHECKs refuse what they must ──
    -- Nine characters once trimmed: one short of the floor.
    v_refused := false;
    begin
      update public.client_settings set phone_recording_notice_text = '  Recorded.  ' where client_id = k_cid;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '263 probe: a 9-character announcement was accepted'; end if;
    v_refused := false;
    begin
      update public.client_settings set phone_recording_notice_text = repeat('r', 301) where client_id = k_cid;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '263 probe: a 301-character announcement was accepted'; end if;
    v_refused := false;
    begin
      update public.client_settings set phone_recording_retention_days = 45 where client_id = k_cid;
    exception when check_violation then v_refused := true;
    end;
    if not v_refused then raise exception '263 probe: a 45-day retention was accepted'; end if;
    update public.client_settings
       set phone_recording_notice_text = 'This call is recorded for quality.', phone_recording_retention_days = 30
     where client_id = k_cid;

    insert into public.phone_calls (client_id, direction, from_e164, to_e164, status, started_at, ended_at, recording_armed)
    values (k_cid, 'in', '+15555550142', '+15555550100', 'completed', k_future, k_future + interval '5 minutes', true)
    returning id into v_call;

    -- ── 2. One recording per call ──
    insert into public.phone_call_recordings (call_id, client_id, recording_sid, status, completed_at, duration_s,
                                              transcript_status, next_try_at)
    values (v_call, k_cid, 'RE-probe-263-a', 'completed', k_future + interval '5 minutes', 300,
            'pending', '2000-01-01')
    returning id into v_rec;
    insert into public.phone_call_recordings (call_id, client_id, status)
    values (v_call, k_cid, 'starting')
    on conflict (call_id) do nothing;
    if (select count(*) from public.phone_call_recordings where call_id = v_call) <> 1 then
      raise exception '263 probe: a second start on the same call made a second recording';
    end if;

    -- ── 3. The transcript claim takes it once, and a live lease keeps it ──
    select array_agg(r.id) into v_ids from public.phone_recordings_claim(1, 300) r;
    if v_ids is distinct from array[v_rec] then
      raise exception '263 probe: phone_recordings_claim took % instead of the due probe row', v_ids;
    end if;
    if (select transcript_status <> 'working' or attempts <> 1 or lease_until <= now()
          from public.phone_call_recordings where id = v_rec) then
      raise exception '263 probe: the claim did not mark the row working, count the attempt, and lease it';
    end if;
    if exists (select 1 from public.phone_recordings_claim(1, 300) r where r.id = v_rec) then
      raise exception '263 probe: a leased row was claimed twice';
    end if;

    -- ── 4. The summary claim: once, never twice, again after the lease lapses ──
    update public.phone_call_recordings
       set transcript_status = 'done', transcript = 'Customer: Probe.', summary_status = 'pending', lease_until = null
     where id = v_rec;
    v_got := public.phone_recording_summary_claim(v_rec, 90);
    if v_got is null or v_got ->> 'transcript' <> 'Customer: Probe.' or v_got ->> 'direction' <> 'in'
       or (v_got ->> 'summary_attempts')::int <> 1 or v_got ->> 'client_id' <> k_cid then
      raise exception '263 probe: the summary claim returned %', v_got;
    end if;
    if public.phone_recording_summary_claim(v_rec, 90) is not null then
      raise exception '263 probe: a summary was claimed twice (Claude would be asked twice)';
    end if;
    update public.phone_call_recordings set lease_until = now() - interval '1 second' where id = v_rec;
    if public.phone_recording_summary_claim(v_rec, 90) is null then
      raise exception '263 probe: a lapsed summary lease could not be claimed again';
    end if;
    update public.phone_call_recordings set summary_status = 'done', summary = 'Probe summary.', lease_until = null where id = v_rec;

    -- ── 5. The enqueue queues the call, its recording and its transcript, and nothing real ──
    v_n := public.usage_charges_enqueue(k_future - interval '1 hour', 100);
    select array_agg(u.source order by u.source) into v_srcs
      from public.usage_charges u where u.client_id = k_cid;
    if v_n <> 3 or v_srcs is distinct from array['call', 'recording', 'transcription'] then
      raise exception '263 probe: the enqueue queued % row(s): %', v_n, v_srcs;
    end if;
    if exists (select 1 from public.usage_charges u where u.source in ('recording', 'transcription')
                and u.client_id = k_cid and (u.source_id <> v_rec or u.direction <> 'in' or u.occurred_at <> k_future)) then
      raise exception '263 probe: a recording charge does not carry the recording id, the call''s direction and its start';
    end if;
    if public.usage_charges_enqueue(k_future - interval '1 hour', 100) <> 0 then
      raise exception '263 probe: a second enqueue queued the same rows again';
    end if;

    -- ── 6. Retention: this business keeps 30 days; a 40-day-old recording is due, a fresh one not ──
    insert into public.phone_calls (client_id, direction, from_e164, to_e164, status, started_at, ended_at)
    values (k_cid, 'out', '+15555550100', '+15555550143', 'completed', now() - interval '40 days', now() - interval '40 days')
    returning id into v_call;
    insert into public.phone_call_recordings (call_id, client_id, recording_sid, status, completed_at)
    values (v_call, k_cid, 'RE-probe-263-b', 'completed', now() - interval '40 days')
    returning id into v_old;
    select array_agg(e.id) into v_ids from public.phone_recordings_expired(now(), 1000) e where e.client_id = k_cid;
    if v_ids is distinct from array[v_old] then
      raise exception '263 probe: retention listed % instead of only the 40-day-old recording', v_ids;
    end if;

    -- ── 7. Broadcasts: a recording is told as its call; the cron's quiet writes tell nobody ──
    perform realtime.send(jsonb_build_object('probe', 263), 'probe', 'phone:' || k_cid || ':sentinel', true);
    v_live := exists (select 1 from realtime.messages m where m.topic = 'phone:' || k_cid || ':sentinel');
    if not v_live then
      raise notice '263 probe: realtime.messages took nothing (no partition for today?), so the broadcast checks were skipped. Every write above still succeeded.';
    else
      -- Counted rather than cleared: everything here rolls back with the probe anyway. The
      -- recording's insert above was told already; its status change must add exactly one more.
      select count(*) into v_n from realtime.messages m
       where m.topic = 'phone:' || k_cid and m.event = 'call' and m.payload ->> 'id' = v_call::text
         and m.payload ->> 'op' = 'UPDATE';
      update public.phone_call_recordings set status = 'recording' where id = v_old;
      if (select count(*) from realtime.messages m
           where m.topic = 'phone:' || k_cid and m.event = 'call' and m.private
             and m.payload ->> 'table' = 'phone_calls' and m.payload ->> 'op' = 'UPDATE'
             and m.payload ->> 'id' = v_call::text
             and (select array_agg(k order by k) from jsonb_object_keys(m.payload) as k) = array['contact_id','id','op','table']) <> v_n + 1 then
        raise exception '263 probe: a recording status change was not told as its call (once, ids only, private)';
      end if;
      select count(*) into v_n from realtime.messages m where m.topic like 'phone:' || k_cid || '%';
      update public.phone_call_recordings set lease_until = now() + interval '1 minute', attempts = attempts + 1,
                                              next_try_at = now() where id = v_old;
      if (select count(*) from realtime.messages m where m.topic like 'phone:' || k_cid || '%') <> v_n then
        raise exception '263 probe: a lease / attempt write broadcast (every cron run would refresh every phone)';
      end if;
      update public.phone_call_recordings set transcript_status = 'pending' where id = v_old;
      select count(*) into v_n from realtime.messages m where m.topic like 'phone:' || k_cid || '%';
      update public.phone_call_recordings set transcript_status = 'working' where id = v_old;
      update public.phone_call_recordings set transcript_status = 'pending' where id = v_old;
      if (select count(*) from realtime.messages m where m.topic like 'phone:' || k_cid || '%') <> v_n then
        raise exception '263 probe: a claim (pending to working) or a back-off (working to pending) broadcast; the apps read both as pending';
      end if;
      raise notice '263 probe: a recording is told as its call, ids only; the queue''s own writes tell nobody';
    end if;

    -- ── 8. A pilot of call and text billing arms calls, never an inactive recording meter ──
    -- 259's ARMING step 2 on the synthetic tenant: a markup, armed_at, and the tenant on the pilot
    -- list. Call minutes are armed for it; the two recording meters, while inactive, are not.
    update public.phone_billing_settings
       set markup = 2, armed_at = now(), pilot_client_ids = array_append(pilot_client_ids, k_cid)
     where id;
    if not found then
      raise notice '263 probe: phone_billing_settings has no row, so the pilot check was skipped';
    else
      if not public.phone_usage_armed(k_cid, 'voice_minute') then
        raise exception '263 probe: a pilot tenant is not armed for call minutes';
      end if;
      if exists (select 1 from public.usage_prices up
                  where up.kind in ('call_recording', 'call_transcription') and not up.active
                    and public.phone_usage_armed(k_cid, up.kind)) then
        raise exception '263 probe: a pilot tenant is armed for an inactive recording meter (it would be charged for a meter nobody priced)';
      end if;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '263 probe: one recording per call; the transcript and summary claims take a row once and again only after the lease; the enqueue queues recordings and transcripts with the call''s direction; retention follows the business''s days; a pilot arms calls, not recordings; nothing was kept';
      else
        raise;
      end if;
  end;

  if exists (select 1 from public.client_settings s where s.client_id = k_cid)
     or exists (select 1 from public.phone_calls c where c.client_id = k_cid)
     or exists (select 1 from public.phone_call_recordings r where r.client_id = k_cid)
     or exists (select 1 from public.usage_charges u where u.client_id = k_cid)
     or exists (select 1 from public.phone_billing_settings s where k_cid = any (s.pilot_client_ids)) then
    raise exception '263 probe: synthetic rows were left behind';
  end if;
end
$probe$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('263', '263_phone_call_recording');
-- B. Everything is off and empty:
--      select count(*) filter (where phone_record_calls) recording_on, count(*) from public.client_settings;   -- 0, n
--      select count(*) from public.phone_call_recordings;                                                    -- 0
--      select kind, active, visible, pricing from public.usage_prices where kind like 'call_%';              -- both false, false, cost_plus
-- C. The RPCs carry the new key (any live number and team member):
--      select public.phone_route_for_number('<a live number>') -> 'recording';   -- {"on": false, "notice": true, ...}
-- D. Then deploy phone-call-summary and the phone-api Worker (CALL_RECORDING / CALL_TRANSCRIBE
--    still "off"). Nothing records until both rails are "on" AND an owner turns it on.
