-- 328_meeting_video.sql — video meetings: Zoom, Google Meet and Teams links on a booking.
-- Follows 327_meeting_mail.sql; spec in MEETINGS_SCOPE.md.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('328', '328_meeting_video') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/328_meeting_video.sql | npx supabase db query --linked -o csv
--
-- ── NUMBERING ───────────────────────────────────────────────────────────────────────────
-- 328, read off the LEDGER immediately before writing this, to be re-checked immediately
-- before recording it. 326 was renumbered from 325 mid-build when another workspace's
-- migration landed in between; see its header. `ls` is not an answer to this question.
--
-- ── WHY (Carolyn 2026-10-22) ────────────────────────────────────────────────────────────
-- "We need to be able to connect zoom, hangouts & teams to generate video meeting links for
-- video meetings."
--
-- ── THE TWO HALVES, AND WHY ONLY ONE IS HERE ────────────────────────────────────────────
-- A video meeting needs a link, and there are two completely different ways to get one:
--
--   A. A ROOM LINK the builder already has. Zoom, Meet and Teams all give every account a
--      permanent personal room ("zoom.us/j/1234567890"), and a small business very often
--      runs every call through it. Nothing has to be connected for this: they paste it once
--      and every booking of that type carries it. **That is what this migration delivers**,
--      and it works the moment it is applied.
--
--   B. A FRESH LINK PER BOOKING, generated through the provider's API. This needs an OAuth
--      app per provider, and those are Carolyn's to create — so the columns are laid out for
--      it here (`meetings.conference_*` is per BOOKING, not per type) and the generation
--      itself is a later phase. Nothing in the product pretends otherwise: the Settings UI
--      says what is connected and what is not, rather than offering a dead button.
--
-- ⚠️ AND THE PART WORTH KNOWING BEFORE PLANNING B: **Meet and Teams need no integration of
-- their own.** A Google Meet link is what Google's calendar API hands back when you create
-- the event with conferenceData; a Teams link is what Microsoft Graph hands back the same
-- way. So they ride the two calendar connectors phases 3-4 already need. Only ZOOM is a
-- genuinely separate OAuth app. Three apps, not five.

begin;

-- ── 1. What a meeting type offers ────────────────────────────────────────────────────────
-- `location_kind = 'video'` already said "this is a video call" (326). It did not say WHOSE
-- video, or where the link comes from — `location_detail` was free text, so a builder's only
-- option was to type "we'll send a link" and then remember to.
alter table public.meeting_types
  -- Which provider this type uses. 'none' is the default and is NOT the same as a null
  -- location_kind: a type can be a video call whose link the builder sends by hand.
  add column conference_provider text not null default 'none'
    check (conference_provider in ('none', 'zoom', 'google_meet', 'teams', 'other')),
  -- ROUTE A: the standing room link, used for every booking of this type. Must be https and
  -- is shown to customers, so it is length-capped and scheme-checked like every other URL
  -- that reaches a customer's screen (the `terms_url` shape from 310).
  add column conference_url text
    check (conference_url is null or (conference_url ~ '^https://' and char_length(conference_url) <= 500)),
  -- Anything the customer needs beyond the link: a passcode, a dial-in, "use the web client".
  -- Deliberately separate from location_detail, which is the PLACE; this is how to get in.
  add column conference_note text check (conference_note is null or char_length(conference_note) <= 300);

comment on column public.meeting_types.conference_provider is
  'Meetings (328): which video provider a booking of this type uses. ''none'' means the builder sends a link themselves. Meet and Teams links come from the calendar connectors (phases 3-4); only Zoom needs an OAuth app of its own.';
comment on column public.meeting_types.conference_url is
  'Meetings (328): ROUTE A — the builder''s standing room link, copied onto every booking of this type. Route B (a fresh link per booking, via the provider''s API) fills meetings.conference_url instead.';

-- ── 2. What one booking actually got ─────────────────────────────────────────────────────
-- ⚠️ PER BOOKING, NOT PER TYPE, and that is the whole point of duplicating the column. A
-- meeting carries the link it was MADE with: a builder who changes their room link next month
-- must not silently move a meeting that was already confirmed with the old one, and a per-
-- booking link (route B) has nowhere else to live. It is also what the confirmation email
-- said, which is the same reason `booked_time_zone` is kept.
alter table public.meetings
  add column conference_provider text
    check (conference_provider is null or conference_provider in ('none', 'zoom', 'google_meet', 'teams', 'other')),
  add column conference_url text
    check (conference_url is null or (conference_url ~ '^https://' and char_length(conference_url) <= 500)),
  add column conference_note text check (conference_note is null or char_length(conference_note) <= 300),
  -- The provider's own id for the meeting it created (route B), so a cancellation can delete
  -- it there instead of leaving a dead room behind. Null for route A — a standing room is not
  -- ours to delete.
  add column conference_external_id text check (conference_external_id is null or char_length(conference_external_id) <= 200);

comment on column public.meetings.conference_url is
  'Meetings (328): the join link THIS booking was made with. Copied from the type (route A) or minted per booking (route B). Kept on the row rather than read back off the type, so changing the type''s room link never moves a meeting that is already confirmed.';

-- ── 3. Zoom joins the connection table ───────────────────────────────────────────────────
-- `meeting_connections` (326) already holds one row per host per provider with a refresh
-- token, service-role only, zero RLS policies. Zoom is the same shape, so it goes here rather
-- than into a table of its own: one place where a token to somebody's account can live, one
-- posture to get right.
alter table public.meeting_connections drop constraint if exists meeting_connections_provider_check;
alter table public.meeting_connections add constraint meeting_connections_provider_check
  check (provider in ('google', 'microsoft', 'zoom'));

-- ── 4. Proof, read-only, inside the transaction ──────────────────────────────────────────
select 'a room link is accepted; a non-https one is not' as check,
       (select count(*) from public.meeting_types) as types_untouched;

do $proof$
declare
  v_client text;
  v_type uuid;
  v_ok boolean := false;
begin
  select client_id into v_client from public.client_configs limit 1;
  if v_client is null then raise notice 'url proof skipped: no tenants'; return; end if;

  insert into public.meeting_types (client_id, name, slug, location_kind, conference_provider, conference_url)
  values (v_client, 'ZZ Video Proof', 'zz-video-proof', 'video', 'zoom', 'https://zoom.us/j/1234567890')
  returning id into v_type;

  -- A link that is not https must be refused: this column lands in an href in a customer's
  -- email, and `javascript:` or a bare host is exactly what must never get there.
  begin
    update public.meeting_types set conference_url = 'javascript:alert(1)' where id = v_type;
    raise exception 'conference_url accepted a non-https value';
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then raise exception 'conference_url check did not fire'; end if;

  delete from public.meeting_types where id = v_type;
  raise notice 'url proof passed: https accepted, javascript: refused';
end
$proof$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — verify read-only:
--   select column_name from information_schema.columns where table_name = 'meeting_types'
--    and column_name like 'conference%';   -- 3 rows
--   select column_name from information_schema.columns where table_name = 'meetings'
--    and column_name like 'conference%';   -- 4 rows
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'meeting_connections_provider_check';   -- must list zoom
-- ═════════════════════════════════════════════════════════════════════════════════════════
