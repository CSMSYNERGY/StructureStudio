-- 326_meetings.sql — Meetings: per-person booking pages, availability, and the one anon
-- read/write path that serves them. Phase 1 of MEETINGS_SCOPE.md.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('326', '326_meetings') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/326_meetings.sql | npx supabase db query --linked -o csv
--
-- ── NUMBERING ───────────────────────────────────────────────────────────────────────────
-- 326, and the number was CHECKED rather than inferred — TWICE, because the first answer went stale. This clone's migrations stop at 315,
-- but `list_migrations` on the live project returns rows through **324**
-- (316_full_building_serials … 324_window_panes) — ten migrations this clone had never seen.
-- Reading the next number off a directory listing would have collided with nine of them.
--
-- ⚠️ AND THEN 325 WENT TOO, MID-BUILD. The ledger said 324 was the highest when this file was
-- written; by the time it was applied, `325_lead_forms` had landed from another workspace and
-- the ledger insert failed on a duplicate key. The DDL above had already run, so the rename to
-- 326 was a rename, not a re-apply. Before renumbering, the live `area_level_for` was checked
-- for an area this file's re-issue might have create-or-replace'd back out — the exact silent
-- loss CLAUDE.md records for 218-vs-193 — and none of 316-325 touches that function, so
-- nothing was lost. **Take the next free number from the LEDGER at apply time, never from
-- `ls`, and re-check it immediately before you record it.**
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-22: a Calendly-style way for builders and their people to set meetings
-- with customers. The slot has been reserved in the product since 2026-08-26, when she had
-- the "meeting" and "lunch" chips taken off the Activity composer — "I don't want meeting in
-- there, we have a meeting scheduler" — leaving a greyed CRM tab at 02-sales.jsx:2618 and
-- this rule, which the whole feature exists to honour:
--
--     two ways to book the same thing is how a calendar drifts out of sync with itself.
--
-- So a meeting is created by BOOKING and by nothing else — publicly on /book, or by a rep on
-- the contact record, which takes the same path. The old activity kinds stay accepted
-- server-side (migration 131's CHECK, portal-settings' KINDS, crmFeed's labelActivity) so
-- rows already logged still render; nothing new writes them.
--
-- Her three decisions, 2026-10-22: per-person links (a team pool is phase 5); Google AND
-- Outlook two-way sync (phases 3-4 — this migration lays the two tables they fill and
-- nothing else); sold inside the existing `crm` entitlement, so NO billing_plans row.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────
--   1. meeting_hosts        — one row per bookable person. weekly_hours + time_zone.
--   2. meeting_types        — tenant-level: duration, location, buffers, notice.
--   3. meeting_host_types   — which host offers which type.
--   4. meeting_overrides    — one date for one host: blocked, or replacement hours.
--   5. meetings             — the bookings.
--   6. meeting_connections  — Google/Outlook tokens. SERVICE-ROLE ONLY, zero policies.
--   7. meeting_busy         — cached external busy blocks. Service-role only. EMPTY until
--                             phase 3; availability already subtracts it.
--   8. meeting_settings     — per tenant: on/off, page copy, confirmation + reminders.
--   9. get_public_booking() — the one anon read. SECURITY DEFINER, like get_public_shop.
--  10. book_meeting()       — the one booking write, atomic per host (see PART 6).
--  11. area_level_for()     — re-issued with the new `meetings` area (PART 12).

begin;

-- ── 1. Hosts ─────────────────────────────────────────────────────────────────────────────
-- weekly_hours reuses the EXACT shape phone_user_settings.ring_hours already uses
-- (migration 264): {"mon":[["08:00","12:00"],["13:00","17:00"]], …}, read in `time_zone`.
-- Same shape, same validation, so "my weekly hours" means one thing in this product and not
-- two. A missing or empty day = not available; there is no separate "day off" flag.
--
-- ⚠️ time_zone is NOT decoration. Every rule in this feature is local wall-clock plus a named
-- zone, and every stored instant is timestamptz. A host whose Tuesday runs 08:00-17:00 works
-- those hours on both sides of a DST change, which means the UTC offsets of their slots
-- differ across it. Compute in the zone; store the instant.
create table public.meeting_hosts (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  user_id      uuid not null,
  -- What appears in the URL: /book?client=<client_id>&with=<slug>. DNS-safe, lower case.
  slug         text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  public_name  text not null check (char_length(public_name) between 1 and 80),
  public_title text check (public_title is null or char_length(public_title) <= 80),
  -- Must live in the PUBLIC `branding` bucket — it lands in an <img src> on a public page.
  -- portal-meetings mints the path; nothing else may write this column.
  photo_url    text check (photo_url is null or (photo_url ~ '^https://' and char_length(photo_url) <= 500)),
  time_zone    text not null default 'America/Chicago' check (char_length(time_zone) between 1 and 64),
  weekly_hours jsonb not null default '{}'::jsonb,
  -- "I'm away" — the page still loads and says so, rather than 404ing a link on a signature.
  accepting    boolean not null default true,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint meeting_hosts_slug_unique unique (client_id, slug),
  constraint meeting_hosts_user_unique unique (client_id, user_id)
);
comment on table public.meeting_hosts is
  'Meetings (326): one row per bookable person. slug is the public URL segment; weekly_hours uses phone_user_settings.ring_hours'' shape, read in time_zone. Every write goes through portal-meetings.';

-- ── 2. Meeting types ─────────────────────────────────────────────────────────────────────
-- Tenant-level, because a builder decides what a "Lot walkthrough" is; each person then opts
-- into the ones they take (table 3). location_kind drives what the public page prints and
-- what the confirmation says, so it is a CHECK rather than free text.
create table public.meeting_types (
  id                    uuid primary key default gen_random_uuid(),
  client_id             text not null,
  name                  text not null check (char_length(name) between 1 and 80),
  slug                  text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  description           text check (description is null or char_length(description) <= 2000),
  duration_minutes      integer not null default 30 check (duration_minutes between 5 and 480),
  location_kind         text not null default 'in_person'
                          check (location_kind in ('in_person','phone','video','custom')),
  location_detail       text check (location_detail is null or char_length(location_detail) <= 300),
  -- Travel and write-up time. Availability widens a booked meeting by these before
  -- subtracting it, so back-to-back lot walkthroughs cannot be booked over a drive.
  buffer_before_minutes integer not null default 0 check (buffer_before_minutes between 0 and 240),
  buffer_after_minutes  integer not null default 0 check (buffer_after_minutes between 0 and 240),
  -- "Don't let anyone book me in the next two hours."
  min_notice_hours      integer not null default 2 check (min_notice_hours between 0 and 720),
  max_days_ahead        integer not null default 60 check (max_days_ahead between 1 and 365),
  -- The grid the slots land on. 15 means 9:00, 9:15, 9:30 … regardless of duration.
  slot_interval_minutes integer not null default 15 check (slot_interval_minutes between 5 and 120),
  color                 text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint meeting_types_slug_unique unique (client_id, slug)
);
comment on table public.meeting_types is
  'Meetings (326): what can be booked, per tenant. Durations, buffers and notice windows feed the availability engine in _shared/meetingAvailability.ts.';

-- ── 3. Who offers what ───────────────────────────────────────────────────────────────────
create table public.meeting_host_types (
  host_id uuid not null references public.meeting_hosts(id) on delete cascade,
  type_id uuid not null references public.meeting_types(id) on delete cascade,
  primary key (host_id, type_id)
);
comment on table public.meeting_host_types is
  'Meetings (326): a host opts into the tenant''s meeting types. No row = they do not take that kind of meeting.';

-- ── 4. Date overrides ────────────────────────────────────────────────────────────────────
-- One calendar day for one host. `blocked` wins outright (a holiday); otherwise `hours`
-- REPLACES that weekday's weekly_hours for that date — it is not merged, because "I work
-- 10-2 on the Friday before Christmas" has to be able to shrink the day, not only extend it.
--
-- ⚠️ `on_date` is a DATE, a calendar day in the host's zone, NOT an instant. See the
-- warning at portal/01-core.jsx:2177 — new Date("2026-11-20") is UTC midnight, which is the
-- previous evening for every US tenant.
create table public.meeting_overrides (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  host_id    uuid not null references public.meeting_hosts(id) on delete cascade,
  on_date    date not null,
  blocked    boolean not null default true,
  hours      jsonb not null default '[]'::jsonb,
  note       text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  constraint meeting_overrides_one_per_day unique (host_id, on_date)
);
comment on table public.meeting_overrides is
  'Meetings (326): one date for one host. blocked = no slots; otherwise hours REPLACES that day''s weekly_hours (never merges). on_date is a calendar day in the host''s time_zone.';

-- ── 5. The bookings ──────────────────────────────────────────────────────────────────────
-- booked_time_zone is the zone the CUSTOMER was looking at when they booked. It is kept
-- deliberately: it is what their confirmation email said, and a later "we agreed 1pm" is
-- settled by what they were shown, not by what the host's zone would render today.
create table public.meetings (
  id                uuid primary key default gen_random_uuid(),
  client_id         text not null,
  host_id           uuid not null references public.meeting_hosts(id) on delete restrict,
  host_user_id      uuid not null,
  type_id           uuid not null references public.meeting_types(id) on delete restrict,
  -- The CRM contact. Nullable only for the window between insert and crm_ensure_contact
  -- landing; book_meeting fills it on the same call.
  contact_id        uuid,
  -- The deal this is about, when a rep booked it from a record that had one picked.
  short_code        text,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  booked_time_zone  text not null,
  status            text not null default 'booked'
                      check (status in ('booked','cancelled','completed','no_show')),
  customer_name     text not null check (char_length(customer_name) between 1 and 120),
  customer_email    text check (customer_email is null or char_length(customer_email) <= 254),
  customer_phone    text check (customer_phone is null or char_length(customer_phone) <= 32),
  customer_notes    text check (customer_notes is null or char_length(customer_notes) <= 2000),
  internal_notes    text check (internal_notes is null or char_length(internal_notes) <= 2000),
  -- The capability that lets a customer cancel or reschedule from an email with no login.
  -- Unguessable, like a design's short_code; the link IS the authentication.
  cancel_token      text not null default encode(extensions.gen_random_bytes(18), 'hex'),
  source            text not null default 'public' check (source in ('public','portal','embed')),
  created_by        uuid,
  cancelled_by      uuid,
  cancelled_at      timestamptz,
  cancel_reason     text check (cancel_reason is null or char_length(cancel_reason) <= 500),
  -- Phases 3-4 write the event id back here so a later cancel can remove it from the
  -- host's own Google/Outlook calendar instead of leaving a ghost.
  external_event_id text,
  external_provider text check (external_provider is null or external_provider in ('google','microsoft')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint meetings_ends_after_starts check (ends_at > starts_at),
  constraint meetings_cancel_token_unique unique (cancel_token),
  -- A customer with neither an email nor a phone cannot be confirmed, reminded or found
  -- again. Refuse at the column level rather than discovering it at send time.
  constraint meetings_reachable check (customer_email is not null or customer_phone is not null)
);
comment on table public.meetings is
  'Meetings (326): the bookings. Created ONLY by book_meeting() — see its comment for why that is the single write path. booked_time_zone is what the customer saw, kept on purpose.';

-- HALF of the double-book guard. It stops the realistic race outright: two people loading
-- the same slot list and clicking the same time. It cannot see a PARTIAL overlap (a 60-min
-- type starting 30 minutes into a booked 30-min one), which is what the advisory lock in
-- book_meeting() is for. Both are needed; neither is sufficient.
create unique index meetings_no_double_book
  on public.meetings (host_user_id, starts_at)
  where status = 'booked';

create index meetings_client_starts on public.meetings (client_id, starts_at desc);
create index meetings_host_window   on public.meetings (host_user_id, starts_at) where status = 'booked';
create index meetings_contact       on public.meetings (contact_id) where contact_id is not null;

-- ── 6. External calendar connections (phases 3-4) ────────────────────────────────────────
-- ⛔ SERVICE-ROLE ONLY: RLS on, ZERO policies, explicit revokes — the commission_members /
-- driver_profiles posture. A refresh token here is a standing key to a named person's entire
-- calendar. It must never be readable from a browser, including the owner's own.
create table public.meeting_connections (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  host_id        uuid not null references public.meeting_hosts(id) on delete cascade,
  user_id        uuid not null,
  provider       text not null check (provider in ('google','microsoft')),
  calendar_id    text,
  -- Written and read ONLY by the oauth callback and the sync job, both service-role.
  refresh_token  text,
  access_token   text,
  token_expires  timestamptz,
  sync_token     text,
  last_synced_at timestamptz,
  status         text not null default 'connected'
                   check (status in ('connected','needs_reauth','revoked')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint meeting_connections_one_per_provider unique (host_id, provider)
);
comment on table public.meeting_connections is
  'Meetings (326): Google/Outlook tokens, one row per host per provider. SERVICE-ROLE ONLY (RLS on, zero policies) — a refresh token is a standing key to someone''s calendar. Portal reads status through portal-meetings, never this table.';

-- ── 7. Cached external busy blocks ───────────────────────────────────────────────────────
-- ⚠️ Availability reads THIS TABLE and never a live Google/Microsoft API call. A public page
-- view must not fan out to a third party: it would put their rate limit and their uptime in
-- front of a builder's booking page. The sync job fills it; phase 1 leaves it empty, and an
-- empty table subtracts nothing, which is exactly the "not connected" behaviour.
--
-- Times only. No titles, no attendees, no event bodies — we do not need them, and a row here
-- is somebody's private calendar.
create table public.meeting_busy (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  host_id     uuid not null references public.meeting_hosts(id) on delete cascade,
  user_id     uuid not null,
  provider    text not null check (provider in ('google','microsoft')),
  external_id text not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  synced_at   timestamptz not null default now(),
  constraint meeting_busy_ends_after_starts check (ends_at > starts_at),
  constraint meeting_busy_unique unique (host_id, provider, external_id)
);
create index meeting_busy_window on public.meeting_busy (host_id, starts_at);
comment on table public.meeting_busy is
  'Meetings (326): cached busy blocks from a host''s connected calendar. TIMES ONLY, never titles or attendees. Availability subtracts these; an empty table means nothing is subtracted, which is the correct "no calendar connected" behaviour.';

-- ── 8. Per-tenant settings ───────────────────────────────────────────────────────────────
create table public.meeting_settings (
  client_id            text primary key,
  enabled              boolean not null default false,
  heading              text check (heading is null or char_length(heading) <= 120),
  intro                text check (intro is null or char_length(intro) <= 1000),
  send_confirmation    boolean not null default true,
  -- Hours before the meeting. Empty = no reminder. Email only in phase 2 — an SMS reminder
  -- goes through portal-sms' registration, consent and STOP rules and is a separate decision.
  reminder_hours       integer[] not null default '{24}',
  -- A booking creates/updates a CRM contact. On by default: a meeting with somebody who is
  -- not in the CRM is a lead nobody follows up.
  create_contact       boolean not null default true,
  updated_at           timestamptz not null default now()
);
comment on table public.meeting_settings is
  'Meetings (326): per-tenant switches for the booking pages. reminder_hours is email only in phase 1-2; SMS reminders need the portal-sms consent rules and are a separate decision.';

-- ── 9. RLS ───────────────────────────────────────────────────────────────────────────────
-- The migration-054 posture throughout: SELECT to `authenticated` scoped to
-- current_client_id(), ZERO write policies, explicit revokes. Every write goes through
-- portal-meetings or book-public (service role) because attribution — who booked it, who
-- cancelled it — is derived server-side and must not be forgeable from a browser.
alter table public.meeting_hosts       enable row level security;
alter table public.meeting_types       enable row level security;
alter table public.meeting_host_types  enable row level security;
alter table public.meeting_overrides   enable row level security;
alter table public.meetings            enable row level security;
alter table public.meeting_settings    enable row level security;

create policy meeting_hosts_owner_select on public.meeting_hosts
  for select to authenticated using (client_id = public.current_client_id());
create policy meeting_types_owner_select on public.meeting_types
  for select to authenticated using (client_id = public.current_client_id());
create policy meeting_overrides_owner_select on public.meeting_overrides
  for select to authenticated using (client_id = public.current_client_id());
create policy meetings_owner_select on public.meetings
  for select to authenticated using (client_id = public.current_client_id());
create policy meeting_settings_owner_select on public.meeting_settings
  for select to authenticated using (client_id = public.current_client_id());
-- The join table carries no client_id of its own; scope it through its host.
create policy meeting_host_types_owner_select on public.meeting_host_types
  for select to authenticated using (
    exists (select 1 from public.meeting_hosts h
             where h.id = meeting_host_types.host_id
               and h.client_id = public.current_client_id())
  );

-- ⛔ The two private tables: RLS on, NO policies at all, and the grants taken away so a
-- future `grant select on all tables` cannot quietly open them.
alter table public.meeting_connections enable row level security;
alter table public.meeting_busy        enable row level security;
revoke all on public.meeting_connections from anon, authenticated;
revoke all on public.meeting_busy        from anon, authenticated;

-- ── 10. The one anon read ────────────────────────────────────────────────────────────────
-- Modelled on get_public_shop (310). It returns ONLY what a public page may show.
-- NEVER: user_id, the host's real email or phone, contact rows, or anything about other
-- bookings beyond the times the availability call reports as taken.
-- Branding comes from client_configs' FLAT COLUMNS (company_name, tagline, logo_url,
-- header_bg, accent_color), exactly as get_public_shop reads them. ⚠️ There is no
-- `client_configs.config` jsonb to read a branding blob out of — migration 020 dropped that
-- column. A first draft of this function read `c.config->'branding'`, which is the same
-- mistake the 3D calibration path made (see CLAUDE.md: "do not reintroduce a config-blob
-- path"); the rehearsal run caught it as a 42703 before it reached anybody.
--
-- The `{ok:false, reason:'not_found'}` shape is get_public_shop's, not an invention: the
-- public pages already know how to render it, and a missing tenant, a tenant with Meetings
-- switched off and an unknown host slug must be INDISTINGUISHABLE from outside. A null for
-- one and a payload for another would let anyone holding the anon key enumerate which
-- builders have the feature and which people work there.
create function public.get_public_booking(p_client_id text, p_host_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_cfg   record;
  v_set   public.meeting_settings;
  v_host  public.meeting_hosts;
  v_types jsonb;
begin
  if p_client_id is null or p_client_id !~ '^[a-z0-9-]{1,64}$' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p_host_slug is null or p_host_slug !~ '^[a-z0-9-]{1,40}$' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_set from public.meeting_settings where client_id = p_client_id;
  if not found or not v_set.enabled then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select company_name, tagline, logo_url, header_bg, accent_color into v_cfg
    from public.client_configs where client_id = p_client_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_host from public.meeting_hosts
   where client_id = p_client_id and slug = p_host_slug and active;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'slug',            t.slug,
           'name',            t.name,
           'description',     t.description,
           'durationMinutes', t.duration_minutes,
           'locationKind',    t.location_kind,
           'locationDetail',  t.location_detail,
           'color',           t.color
         ) order by t.name), '[]'::jsonb) into v_types
    from public.meeting_types t
    join public.meeting_host_types ht on ht.type_id = t.id and ht.host_id = v_host.id
   where t.client_id = p_client_id and t.active;

  return jsonb_build_object(
    'ok',       true,
    'clientId', p_client_id,
    'business', jsonb_build_object(
                  'name',     coalesce(v_cfg.company_name, p_client_id),
                  'tagline',  v_cfg.tagline,
                  'logoUrl',  v_cfg.logo_url,
                  'headerBg', v_cfg.header_bg,
                  'accent',   v_cfg.accent_color
                ),
    'page',     jsonb_build_object('heading', v_set.heading, 'intro', v_set.intro),
    'host',     jsonb_build_object(
                  'slug',      v_host.slug,
                  'name',      v_host.public_name,
                  'title',     v_host.public_title,
                  'photoUrl',  v_host.photo_url,
                  'timeZone',  v_host.time_zone,
                  'accepting', v_host.accepting
                ),
    'types',    v_types
  );
end;
$fn$;
revoke execute on function public.get_public_booking(text, text) from public;
grant execute on function public.get_public_booking(text, text) to anon, authenticated;
comment on function public.get_public_booking(text, text) is
  'Meetings (326): the ONE anon read behind /book. Returns branding, the host''s public card and the types they offer — never user_id, contacts, or other people''s bookings. Answers {ok:false, reason:not_found} for a missing tenant, a tenant with Meetings switched off AND an unknown host, indistinguishably, so nobody can enumerate which builders have the feature or who works there.';

-- ── 11. The one booking write ────────────────────────────────────────────────────────────
-- ⚠️ EVERY booking goes through here — the public page, the embed, and a rep on the contact
-- record. That is not tidiness: it is the only reason the double-book guarantee holds, and it
-- is the database half of "two ways to book the same thing is how a calendar drifts out of
-- sync with itself".
--
-- THE RACE, and why it takes two mechanisms. The slot list a customer sees is a snapshot;
-- two people can hold the same one. The unique index above catches the common case (same
-- host, same start). It cannot catch a PARTIAL overlap — a 60-minute consultation starting
-- half an hour into a booked 30-minute walkthrough is a different `starts_at`, so the index
-- is blind to it, and the `not exists` check below runs at READ COMMITTED where two
-- concurrent transactions can both see an empty result and both insert.
--
-- `pg_advisory_xact_lock` on the host closes it: bookings for one person serialise, bookings
-- for different people do not block each other at all, and the lock is released by COMMIT or
-- ROLLBACK with nothing to clean up. btree_gist would have given an exclusion constraint
-- instead, which is the textbook answer — it is NOT installed on this project and installing
-- an extension on the database that serves production for one feature is a bigger decision
-- than this needs.
--
-- Returns the new row's id and cancel_token, or null when the slot went while the customer
-- was typing — the caller turns that into "that time was just taken", never a second meeting.
create function public.book_meeting(
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

  insert into public.meetings (
    client_id, host_id, host_user_id, type_id, contact_id, short_code,
    starts_at, ends_at, booked_time_zone,
    customer_name, customer_email, customer_phone, customer_notes,
    source, created_by
  ) values (
    p_client_id, p_host_id, v_host_user, p_type_id, p_contact_id, p_short_code,
    p_starts_at, p_ends_at, p_time_zone,
    p_name, p_email, p_phone, p_notes,
    p_source, p_created_by
  )
  returning id, cancel_token into v_id, v_token;

  return jsonb_build_object('id', v_id, 'cancelToken', v_token);
end;
$fn$;
revoke execute on function public.book_meeting(text, uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, text, uuid, text, uuid, integer, integer) from public, anon, authenticated;
comment on function public.book_meeting is
  'Meetings (326): the ONLY path that creates a meeting. Takes a per-host advisory lock, re-checks overlap with buffers inside the transaction, then inserts. Returns null when the slot is gone. Service-role only — book-public and portal-meetings call it.';

-- ── 12. The access mirror ────────────────────────────────────────────────────────────────
-- ⛔ area_level_for() is the SQL copy of effectiveAccess() in _shared/access.ts, and the two
-- have drifted silently twice (change_orders in 2026-09, the sales_rep orders level the same
-- week). scripts/preflight.mjs checkAreaMirror() compares the area key set and each area's
-- level vocabulary in both directions and refuses a push that adds an area to one side only.
--
-- ⚠️ The definition re-issued below was taken from 286_contacts_own_view.sql — the migration
-- that most recently DEFINES this function, which is not the one with the highest number —
-- after confirming with pg_get_functiondef() that the live function matches it. It was
-- transformed by exact-match string replacement, every anchor asserted to fire exactly once,
-- rather than retyped. Only the `meetings` additions differ from 286.

create or replace function public.area_level_for(
  p_role   text,
  p_title  text,
  p_access jsonb,
  p_area   text
) returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  -- ── AREAS ── mirror of `AREAS` in _shared/access.ts. `levels` is the vocabulary for THAT
  -- row: commissions, contacts, phone and change_order_approve are deliberately not the
  -- universal none/view/edit triplet, which is why the level check below reads the array
  -- instead of assuming three.
  --
  -- `internalOnly` is NOT mirrored, on purpose. It governs which switches accessMetadata()
  -- ships to a browser — a presentation rule with no bearing on how a stored map resolves —
  -- and mirroring it here would invite a future reader to treat it as the tenancy check,
  -- which it is not.
  -- 286: contacts gained own_view (own customers, view only), narrowest first after none.
  -- 326: meetings. 'own' = my calendar and my bookings; 'view' = the team's; 'edit' = manage
  --      anyone's and edit the tenant's meeting types. ownWrites in access.ts, so 'own' WRITES
  --      (your own hours are yours to set) — the same shape contacts:'own' has.
  k_areas constant jsonb := $j$
  {
    "designer":              {"levels": ["none","view","edit"]},
    "price_override":        {"levels": ["none","edit"]},
    "designs":               {"levels": ["none","view","edit"]},
    "contacts":              {"levels": ["none","own_view","own","view","edit"]},
    "inventory":             {"levels": ["none","view","edit"]},
    "orders":                {"levels": ["none","view","edit"]},
    "change_orders":         {"levels": ["none","view","edit"]},
    "change_order_approve":  {"levels": ["none","edit"]},
    "build_schedule":        {"levels": ["none","view","edit"]},
    "delivery_schedule":     {"levels": ["none","view","edit"]},
    "repairs":               {"levels": ["none","view","edit"]},
    "commissions":           {"levels": ["none","own","edit"]},
    "reports":               {"levels": ["none","view","edit"]},
    "meetings":              {"levels": ["none","own","view","edit"]},
    "phone":                 {"levels": ["none","own","view","edit"]},
    "projects":              {"levels": ["none","view","edit"]},
    "settings_structures":   {"levels": ["none","view","edit"]},
    "settings_options":      {"levels": ["none","view","edit"]},
    "settings_branding":     {"levels": ["none","view","edit"]},
    "settings_crm":          {"levels": ["none","view","edit"]},
    "settings_quickbooks":   {"levels": ["none","view","edit"]},
    "settings_email":        {"levels": ["none","view","edit"]},
    "settings_team":         {"levels": ["none","view","edit"], "byTitleOnly": true},
    "settings_billing":      {"levels": ["none","view","edit"], "ownerGranted": true}
  }
  $j$::jsonb;

  -- ── PRESETS ── mirror of `PRESETS`. A title's default switches; anything a preset OMITS
  -- resolves to 'none', which is what makes tomorrow's new area safe to add.
  --
  -- ⚠️ THE CELLS 254 ADDED: phone. owner and admin edit; office_staff and sales_manager view;
  -- sales_rep and dealer own. scheduler, crew_leader, crew_member and driver OMIT it and
  -- therefore deny it. No other cell moved.
  k_presets constant jsonb := $j$
  {
    "owner": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "price_override":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","meetings":"edit","phone":"edit","projects":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"edit"
    },
    "admin": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "price_override":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","meetings":"edit","phone":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"none"
    },
    "sales_rep": {
      "designer":"edit","designs":"edit","contacts":"edit","phone":"own",
      "inventory":"view","orders":"edit","commissions":"own","meetings":"own"
    },
    "office_staff": {
      "designer":"edit",
      "designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit",
      "build_schedule":"view","delivery_schedule":"view","repairs":"view","reports":"view","meetings":"edit",
      "phone":"view",
      "settings_branding":"edit","settings_quickbooks":"edit"
    },
    "sales_manager": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"view",
      "orders":"edit","change_orders":"edit","commissions":"edit","reports":"edit","meetings":"edit",
      "phone":"view"
    },
    "dealer": {
      "designer":"edit","designs":"edit","contacts":"own",
      "inventory":"view","orders":"edit","commissions":"own","phone":"own","meetings":"own"
    },
    "scheduler": {
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit",
      "designs":"view","contacts":"view","inventory":"view","orders":"view"
    },
    "crew_leader": {
      "build_schedule":"edit","repairs":"edit",
      "designs":"view","inventory":"view","orders":"view"
    },
    "crew_member": {
      "build_schedule":"view","repairs":"view"
    },
    "driver": {
      "delivery_schedule":"edit",
      "inventory":"view","orders":"view"
    }
  }
  $j$::jsonb;

  v_area     jsonb;
  v_title    text;
  v_level    text;
  v_override text;
begin
  -- UNKNOWN AREA -> 'none'. Mirrored from 154 rather than quietly improved, because the two
  -- must agree; see that migration's note on why failing open here was rejected.
  v_area := k_areas -> p_area;
  if v_area is null then
    return 'none';
  end if;

  -- OWNERS ABSOLUTE. An owner's stored map is never consulted, so a hostile, corrupted or
  -- hand-edited access blob can never lock an owner out of their own business.
  --
  -- ⚠️ THIS LINE IS WHY NOTHING BELOW RE-CHECKS THE ROLE. crm_contact_scope() asks this
  -- function for the contacts level and compares it to 'own'; an owner can never produce
  -- that string, so owners are absolute in the RLS layer for free — by construction rather
  -- than by a second test somebody could forget to copy into the next policy.
  --
  -- It also returns the literal 'edit', which is exactly why change_order_approve is a
  -- two-level area topping out at 'edit' and not a third level named 'approve' — see the
  -- header.
  if p_role = 'owner' then
    return 'edit';
  end if;

  -- normTitle(): anything that is not one of the TEN known titles is a sales_rep.
  v_title := case
               when p_title in ('owner','admin','office_staff','sales_manager','sales_rep',
                               'dealer','scheduler','crew_leader','crew_member','driver')
                 then p_title
               else 'sales_rep'
             end;

  -- `out[k] = base[k] ?? "none"`.
  v_level := coalesce(k_presets -> v_title ->> p_area, 'none');

  -- The stored deviations, layered on top — the same three skips, in the same order as the
  -- TypeScript loop.
  if p_access is not null and jsonb_typeof(p_access) = 'object' then
    v_override := p_access ->> p_area;
    if v_override is not null
       and not (coalesce((v_area ->> 'ownerGranted')::boolean, false) and v_title <> 'admin')
       and not coalesce((v_area ->> 'byTitleOnly')::boolean, false)
       and exists (select 1 from jsonb_array_elements_text(v_area -> 'levels') as lv(l)
                    where lv.l = v_override)
    then
      v_level := v_override;
    end if;
  end if;

  return v_level;
end
$fn$;

-- ── 13. Proof, read-only, inside the transaction ─────────────────────────────────────────
-- A rehearsal run (commit -> rollback) prints these and changes nothing.
select 'meetings area resolves' as check,
       public.area_level_for('user', 'sales_rep',    '{}'::jsonb, 'meetings') as sales_rep,   -- own
       public.area_level_for('user', 'dealer',       '{}'::jsonb, 'meetings') as dealer,      -- own
       public.area_level_for('user', 'office_staff', '{}'::jsonb, 'meetings') as office,      -- edit
       public.area_level_for('user', 'owner',        '{}'::jsonb, 'meetings') as owner,       -- edit
       public.area_level_for('user', 'driver',       '{}'::jsonb, 'meetings') as driver,      -- none
       public.area_level_for('user', 'crew_member',  '{}'::jsonb, 'meetings') as crew;        -- none

select 'no other area moved' as check,
       public.area_level_for('user', 'sales_rep', '{}'::jsonb, 'contacts')  as rep_contacts,  -- edit
       public.area_level_for('user', 'dealer',    '{}'::jsonb, 'contacts')  as dealer_contacts, -- own
       public.area_level_for('user', 'scheduler', '{}'::jsonb, 'repairs')   as sched_repairs,  -- edit
       public.area_level_for('user', 'admin',     '{}'::jsonb, 'settings_billing') as admin_billing; -- none

select 'an override still wins' as check,
       public.area_level_for('user', 'driver', '{"meetings":"own"}'::jsonb, 'meetings') as granted, -- own
       public.area_level_for('user', 'owner',  '{"meetings":"none"}'::jsonb, 'meetings') as owner_cannot_be_reduced; -- edit

select 'booking page is dark until switched on' as check,
       public.get_public_booking('structure-studio', 'nobody')->>'reason' as no_host,        -- not_found
       public.get_public_booking('no-such-tenant', 'nobody')->>'reason'   as no_tenant,      -- not_found
       public.get_public_booking('structure-studio', 'Nope!')->>'reason'  as bad_slug;       -- not_found

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — verify read-only:
--   select public.area_level_for('user','sales_rep','{}','meetings');   -- own
--   select position('"meetings"' in pg_get_functiondef('public.area_level_for(text,text,jsonb,text)'::regprocedure)) > 0;  -- true
--   select count(*) from public.meeting_hosts;   -- 0, nothing is seeded
--   -- and from a browser console holding ONLY the anon key, all three must return no rows:
--   --   from("meeting_connections").select("*")   -> permission denied
--   --   from("meeting_busy").select("*")          -> permission denied
--   --   from("meetings").select("*")              -> 0 rows (RLS, not an error)
-- ═════════════════════════════════════════════════════════════════════════════════════════
