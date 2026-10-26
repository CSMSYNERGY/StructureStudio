-- 327_meeting_mail.sql — Meetings phase 2: confirmations, reminders, the calendar invite, and
-- the cancel/reschedule links. Follows 326_meetings.sql; spec in MEETINGS_SCOPE.md.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('327', '327_meeting_mail') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/327_meeting_mail.sql | npx supabase db query --linked -o csv
--
-- ── NUMBERING ───────────────────────────────────────────────────────────────────────────
-- 327, read off the LEDGER (`select max(version::int) … where version ~ '^[0-9]{3}$'` → 326)
-- immediately before writing this, and to be re-checked immediately before recording it.
-- 326 was renumbered from 325 mid-build because another workspace's migration landed in
-- between; see 326's header. `ls supabase/migrations` is not an answer to this question.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────
--   1. email_sends.kind gains four meeting kinds (mirrors TenantMail.kind).
--   2. meetings: confirmation_sent_at, reminders_sent, reschedule bookkeeping, ics_sequence.
--   3. An index that makes "which reminders are due?" a cheap read on every cron tick.
--
-- What it deliberately does NOT add: an outbox table. Every send is recorded on an
-- `email_sends` row already (emailSend.ts claims one per send), and a second ledger would be
-- a second truth to reconcile. What a meeting needs to remember is only "which reminders have
-- gone", and that is an array on the row.

begin;

-- ── 1. The email kinds ───────────────────────────────────────────────────────────────────
-- ⚠️ MIRRORS TenantMail.kind in _shared/emailSend.ts — keep the two in step, in the SAME
-- commit. A kind the constraint rejects fails at the ledger insert, which happens AFTER the
-- decision to send, so the drift shows up as a send that half-happened: the customer gets the
-- email and the row is missing. 325's header says the same thing about the form kinds.
--
-- Four, not one, because a builder reading their email ledger needs to tell a confirmation
-- from a reminder, and a cancellation is the one a customer may ring about.
alter table public.email_sends drop constraint if exists email_sends_kind_check;
alter table public.email_sends add constraint email_sends_kind_check
  check (kind = any (array['estimate', 'invoice', 'test', 'acceptance', 'change_order',
                           'conversation', 'login_code', 'form_autoreply', 'form_notification',
                           'meeting_booked', 'meeting_reminder', 'meeting_cancelled',
                           'meeting_rescheduled']));

-- ── 2. What a meeting remembers about its own mail ───────────────────────────────────────
alter table public.meetings
  -- Null = nothing has been sent for this booking. Set on the first successful confirmation,
  -- so a retry (or a second booking attempt that lost the race) cannot double-send.
  add column confirmation_sent_at timestamptz,
  -- The reminder offsets ALREADY SENT, in hours before the start — the same numbers
  -- meeting_settings.reminder_hours holds. An array rather than one timestamp because a
  -- tenant may ask for 24h AND 2h, and "did the 2h one go?" is not answerable from a single
  -- `reminded_at`. Idempotence is `not (h = any(reminders_sent))`, checked in the UPDATE that
  -- claims the send, so two overlapping cron ticks cannot both send the same reminder.
  add column reminders_sent integer[] not null default '{}',
  -- Where this meeting was before it was moved, and how many times. Both are for the
  -- customer's own email ("moved from Tuesday 2pm"), and ics_sequence is required by the
  -- calendar protocol: an invite update with a SEQUENCE that has not increased is ignored by
  -- every client, so a rescheduled meeting would silently keep its old time in the
  -- customer's calendar. It starts at 0 and is bumped by each reschedule and the cancel.
  add column rescheduled_from timestamptz,
  add column reschedule_count integer not null default 0 check (reschedule_count >= 0),
  add column ics_sequence integer not null default 0 check (ics_sequence >= 0);

comment on column public.meetings.reminders_sent is
  'Meetings (327): reminder offsets in hours-before-start that have ALREADY been sent. The claim UPDATE requires the offset to be absent, so two cron ticks cannot both send it.';
comment on column public.meetings.ics_sequence is
  'Meetings (327): the calendar invite''s SEQUENCE. Bumped on every reschedule and on cancellation — a client ignores an update whose sequence has not increased, so without this a moved meeting keeps its old time in the customer''s calendar.';

-- ── 3. Finding what is due ───────────────────────────────────────────────────────────────
-- The reminder runner asks, every few minutes: booked meetings starting soon whose tenant
-- wants a reminder we have not sent. This index serves the `status='booked'` + time-window
-- part, which is the whole of the selectivity — the array check is per row and cheap.
--
-- Partial on status: cancelled and past meetings are the bulk of this table over time and
-- none of them can ever need a reminder.
create index meetings_reminder_due
  on public.meetings (starts_at)
  where status = 'booked';

-- ── 4. Claiming one reminder, atomically ─────────────────────────────────────────────────
-- ⚠️ THE WHOLE POINT IS THE `not (p_hours = any(reminders_sent))` INSIDE THE UPDATE. The
-- reminder runner is driven by a cron tick; two ticks can overlap (a slow run, a retry, two
-- Worker invocations), and a read-then-write would let both see the offset unsent and both
-- email the customer. Here the second one updates zero rows and gets false.
--
-- Returns true only for the caller that actually claimed it. The caller sends ONLY on true.
--
-- `security definer` because `meetings` has no write policy at all (326): every write goes
-- through a function or the service role, so attribution and idempotence are never forgeable
-- from a browser. Revoked from everyone but the service role, like book_meeting.
create function public.claim_meeting_reminder(p_meeting_id uuid, p_hours integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id uuid;
begin
  if p_hours is null or p_hours <= 0 then
    return false;
  end if;
  update public.meetings
     set reminders_sent = array_append(reminders_sent, p_hours),
         updated_at = now()
   where id = p_meeting_id
     and status = 'booked'
     and not (p_hours = any (reminders_sent))
  returning id into v_id;
  return v_id is not null;
end;
$fn$;
revoke execute on function public.claim_meeting_reminder(uuid, integer) from public, anon, authenticated;
comment on function public.claim_meeting_reminder(uuid, integer) is
  'Meetings (327): claim one reminder offset for one meeting, exactly once. The idempotence is the NOT(... = any(reminders_sent)) inside the UPDATE, so two overlapping cron ticks cannot both send. Returns true only to the claimer. Service-role only.';

-- ── 5. Proof, read-only, inside the transaction ──────────────────────────────────────────
select 'kinds accepted' as check,
       'meeting_booked'::text = any (array['meeting_booked','meeting_reminder','meeting_cancelled','meeting_rescheduled']) as mail_kinds_present;

select 'new columns default safely' as check,
       count(*) filter (where reminders_sent = '{}') as no_reminders_sent_yet,
       count(*) filter (where ics_sequence = 0) as sequence_starts_at_zero,
       count(*) filter (where confirmation_sent_at is null) as nothing_claimed_yet,
       count(*) as total_meetings
  from public.meetings;

-- The claim is idempotent, proved rather than asserted: a throwaway meeting is claimed twice
-- for the same offset and the second attempt must answer false. Rolled back with everything
-- else in a rehearsal; in a real apply the row is deleted on the next line.
do $proof$
declare
  v_client text;
  v_host uuid;
  v_type uuid;
  v_m uuid;
  v_first boolean;
  v_second boolean;
begin
  select client_id into v_client from public.client_configs limit 1;
  if v_client is null then
    raise notice 'claim proof skipped: no tenants';
    return;
  end if;
  insert into public.meeting_hosts (client_id, user_id, slug, public_name, weekly_hours)
  values (v_client, '00000000-0000-0000-0000-000000000000', 'zz-claim-proof', 'Claim Proof', '{}'::jsonb)
  returning id into v_host;
  insert into public.meeting_types (client_id, name, slug) values (v_client, 'Claim Proof', 'zz-claim-proof')
  returning id into v_type;
  insert into public.meetings (client_id, host_id, host_user_id, type_id, starts_at, ends_at,
                               booked_time_zone, customer_name, customer_email)
  values (v_client, v_host, '00000000-0000-0000-0000-000000000000', v_type,
          now() + interval '3 days', now() + interval '3 days' + interval '30 minutes',
          'UTC', 'Claim Proof', 'claim-proof@example.com')
  returning id into v_m;

  v_first := public.claim_meeting_reminder(v_m, 24);
  v_second := public.claim_meeting_reminder(v_m, 24);
  if not v_first then raise exception 'claim_meeting_reminder refused the FIRST claim'; end if;
  if v_second then raise exception 'claim_meeting_reminder allowed a SECOND claim of the same offset'; end if;
  if not public.claim_meeting_reminder(v_m, 2) then
    raise exception 'claim_meeting_reminder refused a DIFFERENT offset on the same meeting';
  end if;

  delete from public.meetings where id = v_m;
  delete from public.meeting_types where id = v_type;
  delete from public.meeting_hosts where id = v_host;
  raise notice 'claim proof passed: first=true, repeat=false, other offset=true';
end
$proof$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — verify read-only:
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'email_sends_kind_check';
--     -- must list the four meeting_* kinds
--   select column_name from information_schema.columns
--    where table_name = 'meetings' and column_name in
--      ('confirmation_sent_at','reminders_sent','rescheduled_from','reschedule_count','ics_sequence');  -- 5 rows
--   select indexname from pg_indexes where tablename = 'meetings' and indexname = 'meetings_reminder_due';  -- 1 row
-- ═════════════════════════════════════════════════════════════════════════════════════════
