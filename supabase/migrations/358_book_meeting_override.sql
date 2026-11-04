-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 358 — book_meeting(): a signed-in host may book a time the calendar would not offer
--
-- Carolyn 2026-11-04: "I need the signed in user to be able to override the time slots and
-- pick the specific time he wants even if it doesnt meet the rules of the calendar."
--
-- The calendar's RULES — working hours, days off, the lead time, the slot increment, and
-- whether the host is currently ACCEPTING bookings at all — exist to shape what a CUSTOMER
-- is offered on the public page. They were never meant to stop the person whose calendar it
-- is from writing "Saturday, 7pm, this once" into their own diary.
--
-- Everything above `accepting` is enforced in the availability engine, not here, so the
-- override needed exactly one thing from this function: stop refusing an AWAY host. The
-- 16-argument form is DROPPED rather than left beside this one — two definitions of the one
-- write path is precisely the drift this module is built to avoid, and PostgREST would have
-- to choose between them on every call.
--
-- ⛔ WHAT THE OVERRIDE DOES NOT DO: the advisory lock and the buffered overlap re-check
-- below are untouched and apply to an override exactly as they do to a customer. A time
-- that collides with another booked meeting is not a rule being bent, it is the same host
-- in two places, and the whole module rests on that being impossible. The caller still gets
-- "that time was just taken".
-- ─────────────────────────────────────────────────────────────────────────────────────────

create or replace function public.book_meeting(
  p_client_id   text,
  p_host_id     uuid,
  p_type_id     uuid,
  p_starts_at   timestamptz,
  p_ends_at     timestamptz,
  p_time_zone   text,
  p_name        text,
  p_email       text,
  p_phone       text,
  p_notes       text,
  p_source      text,
  p_contact_id  uuid default null,
  p_short_code  text default null,
  p_created_by  uuid default null,
  p_buffer_before_minutes integer default 0,
  p_buffer_after_minutes  integer default 0,
  p_override    boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_host_user uuid;
  v_from      timestamptz;
  v_to        timestamptz;
  v_id        uuid;
  v_token     text;
  v_conf_provider text;
  v_conf_url      text;
  v_conf_note     text;
begin
  -- `active` still holds for an override: an inactive host row is a person who no longer
  -- takes meetings on this account at all, which is not a calendar rule.
  select user_id into v_host_user
    from public.meeting_hosts
   where id = p_host_id and client_id = p_client_id and active
     and (accepting or coalesce(p_override, false));
  if v_host_user is null then
    return null;  -- unknown host, wrong tenant, or not accepting: the caller says so.
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(v_host_user::text, 0));

  v_from := p_starts_at - make_interval(mins => p_buffer_before_minutes);
  v_to   := p_ends_at   + make_interval(mins => p_buffer_after_minutes);

  if exists (
    select 1
      from public.meetings m
      join public.meeting_types t on t.id = m.type_id
     where m.host_user_id = v_host_user
       and m.status = 'booked'
       and tstzrange(m.starts_at - make_interval(mins => t.buffer_before_minutes),
                     m.ends_at   + make_interval(mins => t.buffer_after_minutes), '[)')
           && tstzrange(v_from, v_to, '[)')
  ) then
    return null;  -- taken while they were typing.
  end if;

  select conference_provider, conference_url, conference_note
    into v_conf_provider, v_conf_url, v_conf_note
    from public.meeting_types
   where id = p_type_id and client_id = p_client_id;

  insert into public.meetings (
    client_id, host_id, host_user_id, type_id, contact_id, short_code,
    starts_at, ends_at, booked_time_zone,
    customer_name, customer_email, customer_phone, customer_notes,
    source, created_by,
    conference_provider, conference_url, conference_note
  ) values (
    p_client_id, p_host_id, v_host_user, p_type_id, p_contact_id, p_short_code,
    p_starts_at, p_ends_at, p_time_zone,
    p_name, p_email, p_phone, p_notes,
    p_source, p_created_by,
    coalesce(v_conf_provider, 'none'), v_conf_url, v_conf_note
  )
  returning id, cancel_token into v_id, v_token;

  return jsonb_build_object(
    'id', v_id,
    'cancelToken', v_token,
    'conferenceProvider', coalesce(v_conf_provider, 'none'),
    'conferenceUrl', v_conf_url
  );
end;
$fn$;

revoke execute on function public.book_meeting(text, uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, text, uuid, text, uuid, integer, integer, boolean) from public, anon, authenticated;

-- The 16-argument form from 329. Dropped AFTER the new one exists, so there is no moment
-- with no book_meeting at all.
drop function if exists public.book_meeting(text, uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, text, uuid, text, uuid, integer, integer);

comment on function public.book_meeting is
  'Meetings (326; video details 329; p_override 358): the ONLY path that creates a meeting. Takes a per-host advisory lock, re-checks overlap with buffers inside the transaction, copies the type''s video room link onto the booking, then inserts. p_override lets a signed-in host book on their own calendar while they are marked away; it does NOT relax the overlap check. Returns null when the slot is gone. Service-role only.';
