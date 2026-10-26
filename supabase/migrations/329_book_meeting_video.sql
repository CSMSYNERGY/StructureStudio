-- 329_book_meeting_video.sql — book_meeting() copies the meeting type's video details onto
-- the booking it creates. Follows 328_meeting_video.sql.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('329', '329_book_meeting_video') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/329_book_meeting_video.sql | npx supabase db query --linked -o csv
--
-- ── NUMBERING ───────────────────────────────────────────────────────────────────────────
-- 329, read off the LEDGER immediately before writing this and to be re-checked immediately
-- before recording it. See 326's header for what happens otherwise.
--
-- ── WHY THIS IS A MIGRATION AND NOT TWO LINES IN AN EDGE FUNCTION ───────────────────────
-- 326 made book_meeting() the ONE path that creates a meeting, and said why in as many words:
-- it is the only reason the double-book guarantee holds. The join link has to be set on the
-- same write.
--
-- The alternative — let book-public and portal-meetings each UPDATE the row afterwards — puts
-- the link outside the transaction that created the booking. A failure between the two leaves
-- a confirmed VIDEO meeting with no way to join it, and the customer's confirmation has
-- already gone. Two callers would also be two copies of "which fields come from the type",
-- which is exactly the drift this function exists to prevent.
--
-- Nothing about the signature changes, so no caller is touched: the values come from the type
-- row the function already has to read.

begin;

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
  p_buffer_after_minutes  integer default 0
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
  -- 329: the type's video details, copied onto the booking.
  v_conf_provider text;
  v_conf_url      text;
  v_conf_note     text;
begin
  select user_id into v_host_user
    from public.meeting_hosts
   where id = p_host_id and client_id = p_client_id and active and accepting;
  if v_host_user is null then
    return null;  -- unknown host, wrong tenant, or not accepting: the caller says so.
  end if;

  -- Serialise bookings for THIS host only. hashtextextended keeps the whole uuid in play;
  -- a collision between two different hosts costs a little waiting and nothing else.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(v_host_user::text, 0));

  -- The window the new meeting actually occupies, buffers included. An existing meeting is
  -- widened by ITS OWN type's buffers on the other side of the comparison.
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

  -- ── 329: the video details ─────────────────────────────────────────────────────────────
  -- ROUTE A, the standing room link the builder pasted once. Read inside the same
  -- transaction as the insert, so a booking can never be confirmed without the link its type
  -- says it should carry.
  --
  -- ROUTE B (a fresh link per booking, minted through the provider's API) cannot happen here
  -- — it is a network call, and this function holds an advisory lock. The caller mints it
  -- AFTER this returns and updates the row; `conference_provider` is already set by then, so
  -- a caller can tell a booking that is WAITING for a generated link ('zoom' with a null url)
  -- from one that never wanted one ('none').
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

  -- `conferenceProvider` rides back so the caller knows whether to go and mint a link
  -- (route B) without a second read.
  return jsonb_build_object(
    'id', v_id,
    'cancelToken', v_token,
    'conferenceProvider', coalesce(v_conf_provider, 'none'),
    'conferenceUrl', v_conf_url
  );
end;
$fn$;
revoke execute on function public.book_meeting(text, uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, text, uuid, text, uuid, integer, integer) from public, anon, authenticated;
comment on function public.book_meeting is
  'Meetings (326, video details added by 329): the ONLY path that creates a meeting. Takes a per-host advisory lock, re-checks overlap with buffers inside the transaction, copies the type''s video room link onto the booking, then inserts. Returns null when the slot is gone. Service-role only.';

-- ── Proof, read-only, inside the transaction ─────────────────────────────────────────────
-- A booking of a video type must come out carrying that type's link. Asserted rather than
-- assumed, because the failure is a confirmed video meeting nobody can join.
do $proof$
declare
  v_client text;
  v_host uuid;
  v_type uuid;
  v_res jsonb;
  v_url text;
begin
  select client_id into v_client from public.client_configs limit 1;
  if v_client is null then raise notice 'book proof skipped: no tenants'; return; end if;

  insert into public.meeting_hosts (client_id, user_id, slug, public_name, weekly_hours)
  values (v_client, '00000000-0000-0000-0000-000000000000', 'zz-video-book', 'Video Proof', '{}'::jsonb)
  returning id into v_host;
  insert into public.meeting_types (client_id, name, slug, location_kind, conference_provider, conference_url, conference_note)
  values (v_client, 'ZZ Video Book', 'zz-video-book', 'video', 'zoom',
          'https://zoom.us/j/9876543210', 'Passcode 4120')
  returning id into v_type;

  v_res := public.book_meeting(v_client, v_host, v_type,
                               now() + interval '40 days', now() + interval '40 days' + interval '30 minutes',
                               'UTC', 'Video Proof', 'video-proof@example.com', null, null, 'portal');
  if v_res is null then raise exception 'book_meeting refused the proof booking'; end if;

  select conference_url into v_url from public.meetings where id = (v_res->>'id')::uuid;
  if v_url is distinct from 'https://zoom.us/j/9876543210' then
    raise exception 'the booking did not carry the type''s room link (got %)', coalesce(v_url, 'NULL');
  end if;
  if v_res->>'conferenceProvider' is distinct from 'zoom' then
    raise exception 'book_meeting did not report the provider back to the caller';
  end if;

  delete from public.meetings where id = (v_res->>'id')::uuid;
  delete from public.meeting_types where id = v_type;
  delete from public.meeting_hosts where id = v_host;
  raise notice 'book proof passed: the room link and the provider both reached the booking';
end
$proof$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — verify read-only:
--   select position('conference_provider' in pg_get_functiondef(
--     'public.book_meeting(text,uuid,uuid,timestamptz,timestamptz,text,text,text,text,text,text,uuid,text,uuid,integer,integer)'::regprocedure)) > 0;  -- true
-- ═════════════════════════════════════════════════════════════════════════════════════════
