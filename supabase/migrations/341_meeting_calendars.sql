-- 341_meeting_calendars.sql — Google and Outlook calendar connections, with Meet and Teams links.
-- MEETINGS_SCOPE.md phases 3 and 4. Follows 340 on the ledger.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('341', '341_meeting_calendars') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/341_meeting_calendars.sql | npx supabase db query --linked -o csv
--
-- ── NUMBERING ───────────────────────────────────────────────────────────────────────────
-- 341, read off the LEDGER (highest 340) immediately before writing. Re-check immediately
-- before recording: 333 had to be renumbered when another workspace took 332 mid-apply.
--
-- ── CAROLYN'S DECISIONS (2026-10-26) ────────────────────────────────────────────────────
--   * Each host connects their own Google and/or Outlook; the primary calendar always blocks
--     booking times, and they may tick other calendars to block times too.
--   * EVERY booking goes on the host's calendar (in person, phone and video).
--   * The CUSTOMER IS A GUEST on that event, so Google/Microsoft send the one calendar invite
--     and the host sees Accept / Decline there. Our branded confirmation still goes, without
--     a .ics attached. With no calendar connected, today's email-with-.ics is unchanged.
--   * Meet and Teams links come from creating that event; there is no separate app.

begin;

-- ── 1. A connection's calendar choices ───────────────────────────────────────────────────
alter table public.meeting_connections
  -- Extra calendars that block booking times, beside the primary (which always does). Ids as
  -- the provider gives them; capped so a crafted list cannot balloon a sync run.
  add column busy_calendar_ids text[] not null default '{}'
    check (cardinality(busy_calendar_ids) <= 20),
  -- Which of this connection's calendars new bookings are written to. Null = the primary.
  add column write_calendar_id text check (write_calendar_id is null or char_length(write_calendar_id) <= 300);

-- ── 2. Where a host's bookings go when both are connected ────────────────────────────────
alter table public.meeting_hosts
  add column calendar_provider text check (calendar_provider is null or calendar_provider in ('google', 'microsoft'));
comment on column public.meeting_hosts.calendar_provider is
  'Meetings (341): which connected calendar new bookings are written to. Null = whichever one is connected. A Meet booking always goes to Google and a Teams booking to Microsoft, because the link comes from that event.';

-- ── 3. What happened for one booking ─────────────────────────────────────────────────────
-- external_event_id / external_provider already exist (326) and nothing has written them.
alter table public.meetings
  add column external_calendar_id text check (external_calendar_id is null or char_length(external_calendar_id) <= 300),
  -- TRUE only when the provider's event carries the customer as a guest, i.e. Google/Microsoft
  -- sent them the calendar invite. Our emails then go WITHOUT a .ics, so nobody gets two.
  add column calendar_invited boolean not null default false,
  --   pending  — claimed by a request talking to the provider right now
  --   created  — the event exists; external_event_id is its id
  --   failed   — could not be made; our email carries the .ics as it always did
  --   skipped  — the host has no calendar connected (the permanent, supported state)
  add column calendar_status text
    check (calendar_status is null or calendar_status in ('pending', 'created', 'failed', 'skipped')),
  add column calendar_error text check (calendar_error is null or char_length(calendar_error) <= 60),
  add column calendar_attempted_at timestamptz;

comment on column public.meetings.calendar_invited is
  'Meetings (341): the host''s Google/Outlook event lists the customer as a guest, so the provider sent the calendar invite. Confirmation, move and cancel emails then carry no .ics.';

-- ── 4. Proof, read-only, inside the transaction ──────────────────────────────────────────
do $proof$
begin
  if exists (select 1 from public.meetings where calendar_invited) then
    raise exception 'an existing meeting came out invited';
  end if;
  if exists (select 1 from public.meeting_hosts where calendar_provider is not null) then
    raise exception 'an existing host came out with a calendar provider';
  end if;
  raise notice 'calendar proof passed: nothing existing changed meaning';
end
$proof$;

select 'meetings with an external event before this migration (must be 0)' as check,
       (select count(*) from public.meetings where external_event_id is not null) as n;

commit;

-- AFTER APPLYING — verify read-only:
--   select column_name from information_schema.columns where table_name = 'meetings'
--    and column_name like 'calendar_%';   -- 4 rows
--   select column_name from information_schema.columns where table_name = 'meeting_connections'
--    and column_name in ('busy_calendar_ids', 'write_calendar_id');   -- 2 rows
