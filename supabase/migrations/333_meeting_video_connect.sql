-- 333_meeting_video_connect.sql — a fresh Zoom meeting per booking (MEETINGS_SCOPE.md, route B).
-- Follows 332 (crm_field_types_money). Spec and Carolyn's decisions in MEETINGS_SCOPE.md → "Video meetings".
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('333', '333_meeting_video_connect') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/333_meeting_video_connect.sql | npx supabase db query --linked -o csv
--
-- ── NUMBERING ───────────────────────────────────────────────────────────────────────────
-- Written as 332 off the ledger (highest 331). Another workspace recorded
-- 332_crm_field_types_money minutes later, while this was being applied, so this file was
-- renumbered to 333 and recorded as 333. The SQL ran once, unchanged.
--
-- ── WHAT CAROLYN DECIDED (2026-10-23) ───────────────────────────────────────────────────
--   * Each TEAM MEMBER connects their own account; a meeting is created in the host's account.
--   * A link that cannot be made does NOT stop the booking. The type's standing room link
--     (route A, copied onto the booking by book_meeting() in 329) is the fallback; with no
--     room link the customer is told a link will follow, and the host gets a "Make the link"
--     retry in the portal.
--   * Zoom first. Google Meet and Teams come later on the same columns (they ride the
--     Google / Microsoft calendar connections), which is why the CHECKs below already name them.
--
-- ── WHY book_meeting() IS NOT TOUCHED ───────────────────────────────────────────────────
-- Creating a Zoom meeting is a network call and book_meeting() holds an advisory lock, so it
-- cannot happen inside it (329's header says so). What 329 already copies, the room link, is
-- exactly the fallback Carolyn chose, so the booking is never without its best available link
-- at any instant: the edge function swaps the generated link in afterwards, or leaves the
-- room link where it is and marks the row 'fallback'.

begin;

-- ── 1. How a meeting type gets its link ──────────────────────────────────────────────────
-- 'room'     — route A: the standing link pasted on the type (328). Unchanged default, so
--              every existing type keeps behaving exactly as it does today.
-- 'generate' — route B: a new meeting in the host's own connected account, per booking.
alter table public.meeting_types
  add column conference_mode text not null default 'room'
    check (conference_mode in ('room', 'generate'));
-- Generating only means something for a provider that can generate. 'other' and 'none' have
-- no API to call, and a 'generate' type with nothing to call would book meetings that wait
-- forever for a link.
alter table public.meeting_types
  add constraint meeting_types_generate_needs_provider
    check (conference_mode = 'room' or conference_provider in ('zoom', 'google_meet', 'teams'));

comment on column public.meeting_types.conference_mode is
  'Meetings (333): ''room'' = copy the standing conference_url onto each booking (route A). ''generate'' = create a fresh meeting in the HOST''s own connected account per booking (route B); conference_url, if set, is then the fallback used when that cannot be made.';

-- ── 2. What happened for one booking ─────────────────────────────────────────────────────
-- Null on every booking that never asked for a generated link (route A, or no video).
--   pending   — claimed by a request that is talking to the provider right now
--   generated — the link on the row is the provider's, and conference_external_id is its id
--   fallback  — could not be made; the type's room link is on the row instead
--   failed    — could not be made and there was no room link: the customer was told a link
--               will follow, and the portal offers "Make the link"
alter table public.meetings
  add column conference_status text
    check (conference_status is null or conference_status in ('pending', 'generated', 'fallback', 'failed')),
  -- A short machine code ('not_connected', 'needs_reconnect', 'provider_error', …), never a
  -- provider's response body: this reaches the portal, and a third party's text is not ours
  -- to show (the portal-settings dbFail rule).
  add column conference_error text
    check (conference_error is null or char_length(conference_error) <= 60),
  -- When 'pending' was claimed. A request that dies mid-call leaves 'pending' behind; after
  -- a couple of minutes it may be claimed again rather than blocking the retry for ever.
  add column conference_attempted_at timestamptz;

comment on column public.meetings.conference_status is
  'Meetings (333): route B only. pending / generated / fallback (type''s room link used) / failed (no link; customer told one will follow). Null when the booking never asked for a generated link.';

-- ── 3. Who the connection belongs to ─────────────────────────────────────────────────────
-- Shown to the host as "Connected as jane@acme.com" so they can tell which of their Zoom
-- accounts it is. external_account_id is the provider's user id: Zoom's deauthorisation
-- notice names the user by it, and nothing else on the row would let us find them.
alter table public.meeting_connections
  add column account_email text check (account_email is null or char_length(account_email) <= 254),
  add column account_name text check (account_name is null or char_length(account_name) <= 120),
  add column external_account_id text check (external_account_id is null or char_length(external_account_id) <= 120),
  add column last_error text check (last_error is null or char_length(last_error) <= 60);
create index meeting_connections_external on public.meeting_connections (provider, external_account_id)
  where external_account_id is not null;

-- ── 4. OAuth round-trip state ────────────────────────────────────────────────────────────
-- One row per "Connect Zoom" click, burned on first use by the callback. QuickBooks keeps its
-- nonce on client_settings because it is one connection per TENANT; these are one per PERSON,
-- so they get a table. SERVICE-ROLE ONLY: zero policies, the meeting_connections posture —
-- the row names whose account the next token will be filed under.
create table public.meeting_oauth_states (
  state       text primary key check (char_length(state) between 32 and 128),
  client_id   text not null,
  host_id     uuid not null references public.meeting_hosts(id) on delete cascade,
  user_id     uuid not null,
  provider    text not null check (provider in ('google', 'microsoft', 'zoom')),
  -- The portal host to land back on, already checked against the allow-list by the function
  -- that issued it. Re-checked by the callback anyway.
  return_host text not null check (char_length(return_host) <= 120),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
alter table public.meeting_oauth_states enable row level security;
revoke all on public.meeting_oauth_states from anon, authenticated;
comment on table public.meeting_oauth_states is
  'Meetings (333): one-shot OAuth state for a person connecting Zoom / Google / Microsoft. SERVICE-ROLE ONLY (RLS on, zero policies). Burned by meetings-oauth-callback on first use; 10-minute expiry.';

-- ── 5. Proof, read-only, inside the transaction ──────────────────────────────────────────
do $proof$
declare
  v_client text;
  v_type uuid;
  v_ok boolean := false;
begin
  -- Nothing changed for existing types.
  if exists (select 1 from public.meeting_types where conference_mode <> 'room') then
    raise exception 'an existing type came out as something other than room';
  end if;

  select client_id into v_client from public.client_configs limit 1;
  if v_client is null then raise notice 'mode proof skipped: no tenants'; return; end if;

  insert into public.meeting_types (client_id, name, slug, location_kind, conference_provider, conference_mode)
  values (v_client, 'ZZ Generate Proof', 'zz-generate-proof', 'video', 'zoom', 'generate')
  returning id into v_type;

  -- 'generate' with no provider that can generate must be refused.
  begin
    update public.meeting_types set conference_provider = 'other' where id = v_type;
    raise exception 'generate accepted provider other';
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then raise exception 'generate check did not fire'; end if;

  delete from public.meeting_types where id = v_type;
  raise notice 'mode proof passed: zoom generate accepted, other refused';
end
$proof$;

select 'policies on meeting_oauth_states (must be 0)' as check,
       (select count(*) from pg_policies where tablename = 'meeting_oauth_states') as n;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — verify read-only:
--   select column_name from information_schema.columns where table_name = 'meetings'
--    and column_name like 'conference_%';   -- 7 rows
--   select count(*) from pg_policies where tablename = 'meeting_oauth_states';   -- 0
--   select has_table_privilege('authenticated', 'public.meeting_oauth_states', 'select');   -- f
-- ═════════════════════════════════════════════════════════════════════════════════════════
