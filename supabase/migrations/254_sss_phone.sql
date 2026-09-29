-- 254_sss_phone.sql — SSS Phone: the call tables, the `phone` access area, the two Worker
--                     RPCs, and ids-only live updates on private Realtime channels.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- The product asks for a phone that is "standalone, but totally connected with Structure
-- Studio": a Chrome extension and a phone app that make and take the builder's calls and
-- texts, with the reporting inside Structure Studio. The product plan is
-- _Extras/Structure Studio Phone Plan 2026-09-28.md (vault), and the build contract every
-- component codes against is docs/SPEC.md in the SSS Phone repo, §2. This file is that
-- section. Names and shapes follow the SPEC; where this file goes further or reads it a
-- particular way, the DEVIATIONS block below says so.
--
-- ⚠️ THERE IS ONE SUPABASE PROJECT FOR BETA AND PRODUCTION. Everything here is live for every
-- tenant the moment it is applied. That is why it ships dark:
--   * client_settings.phone_status defaults to 'off' for every builder. The phone-api Worker
--     refuses /token, /voice/outbound and /voice/inbound for a tenant that is not 'on'.
--   * The six new tables are service-role only. No browser reads them; the apps read through
--     the Worker, the portal through portal-settings.
--   * The three new meters are seeded INACTIVE at price 0, like 169 and 179.
--   * The broadcast triggers send nothing for a tenant whose phone_status is not 'on'.
-- The one thing that changes for real people on apply is the access map: every client_users
-- row gains a resolved `phone` level (PART 0 previews it). Nobody can USE it until their
-- tenant is switched on and the Worker exists. PART 9B's CRM changes are additive: one more
-- allowed crm_contacts.source, a merge that also moves calls (there are none until a tenant is
-- switched on), and two new functions nothing calls until portal-settings ships its actions.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   client_settings.phone_status                     the per-tenant switch
--   PART 2   sms_numbers voice columns, sms_messages client_temp_id / sent_via / num_media
--   PART 3   phone_routes, phone_user_settings, phone_calls, phone_call_events,
--            phone_voicemails, phone_devices                    (RLS on, service-role only)
--   PART 4   area_level_for() re-issued with the `phone` area   (SQL twin of access.ts)
--   PART 5   phone_own_only(level)                              (SQL twin of ownPhoneOnly)
--   PART 6   phone_route_for_number(e164), phone_caller_context(user)   (service_role only)
--   PART 6B  phone_end_user_sessions(user)   "Sign out all devices"      (service_role only)
--   PART 7   phone_realtime_notify() + three AFTER triggers     (ids-only broadcasts)
--   PART 8   realtime.messages policies for the three topic families
--   PART 9   usage_prices: phone_line_monthly, voice_minute, voicemail_transcription (OFF)
--   PART 9B  crm_contacts.source gains 'phone'; crm_create_contact ("Save as contact", with
--            the re-link); crm_merge_contacts re-issued to carry phone_calls  (service_role)
--   PART 10  apply-time assertions (they RAISE and abort the transaction)
--   PART 11  a behavioural probe on synthetic rows, rolled back, leaving nothing
--   after commit: verification recipes and the full rollback, as comments
--
-- ── GRANTS: THIS PROJECT'S TRAP, HANDLED THE WAY 229 AND 244 HANDLE IT ───────────────────
-- Default privileges hand every NEW table to anon AND authenticated, and every new function
-- to PUBLIC. So each table below gets RLS enabled, zero policies, and
-- `revoke all ... from public` + `from anon, authenticated`, then an explicit
-- select/insert/update/delete grant to service_role (all asserted in PART 10). Each new
-- function gets
-- `revoke execute ... from public, anon, authenticated` and an explicit grant:
--   phone_route_for_number, phone_caller_context   service_role only (the Worker)
--   phone_end_user_sessions, crm_create_contact,   service_role only (portal-settings);
--   crm_merge_contacts                             SECURITY DEFINER, asserted as such
--   phone_own_only                                 authenticated + service_role (a PURE
--                                                  function the realtime policy calls as the
--                                                  signed-in user; it reads nothing)
--   phone_realtime_notify                          nobody. A trigger function is checked
--                                                  for EXECUTE when the trigger is created,
--                                                  not when it fires (219's
--                                                  change_orders_flag_build_job does the same).
--
-- ── THE ACCESS AREA ──────────────────────────────────────────────────────────────────────
-- Levels none | own | view | edit — the same vocabulary as `contacts`, so preflight's mirror
-- check (area keys, level vocabularies, title keys) keeps working unchanged.
--   own   make and take calls; your own calls and voicemails
--   view  also the team's calls, the team realtime channel, the Calls report
--   edit  also phone settings. Owners are always edit (area_level_for short-circuits them).
-- Presets (plan §7, kept as proposed on 2026-09-29): owner and admin edit; office_staff and
-- sales_manager view; sales_rep and dealer own; scheduler, crew_leader, crew_member, driver
-- omit it and so resolve 'none'. A NULL or unknown title is a sales_rep (normTitle), so it
-- resolves 'own' — the same fallback every other area already takes.
--
-- ⚠️ RANK SCORES 'own' AND 'view' THE SAME. canRead(phone) is therefore right for "may they
-- use the phone" and wrong for "may they see the team's calls". Every team check compares
-- the LITERAL level: ownPhoneOnly() in TypeScript, phone_own_only() here. Both fail closed —
-- anything that is not literally 'view' or 'edit' is "own only", 'none' included.
--
-- PART 4 is migration 219's area_level_for body, copied whole (219 was verified identical to
-- the live pg_get_functiondef on 2026-09-29 before this was written) with exactly two kinds
-- of edit: one k_areas row, and a `phone` cell in the admin, office_staff, sales_manager,
-- sales_rep, dealer and owner presets. MUST LAND IN THE SAME COMMIT as the AREAS/PRESETS
-- change in supabase/functions/_shared/access.ts. preflight compares keys and vocabularies;
-- the preset LEVELS are compared cell by cell by access.test.ts ("area_level_for's k_areas
-- and k_presets match AREAS and PRESETS exactly"), which reads this file, and PART 10 asserts
-- every phone preset by hand the way 212 and 219 do.
--
-- ── REALTIME: IDS ONLY, ON PRIVATE CHANNELS ──────────────────────────────────────────────
-- Broadcast from the database skips table RLS, so a broadcast must never carry anything a
-- receiver might not be allowed to see. Every payload is exactly
--   {table, op, id, contact_id}        op = INSERT | UPDATE | DELETE (TG_OP)
-- and the app re-reads the row through the Worker, which applies CONTACT_ROW_SCOPE. Events
-- are `call` (phone_calls), `voicemail` (phone_voicemails) and `sms` (sms_messages), all sent
-- with private = true, so a subscriber on a PUBLIC channel of the same name receives nothing.
--   phone:<client_id>             every event of the tenant. Readable when the reader's
--                                 current_client_id() matches and phone_own_only() is false
--                                 (literal view or edit).
--   phone:user:<user_id>          the events that are "mine" (plan §7): the call's placed_by,
--                                 answered_by, transferred_from and rang_user_ids, the text's
--                                 sent_by, and the contact's owner_user_id. On an UPDATE the
--                                 OLD row's people are told too, so a re-linked or transferred
--                                 row leaves the list it used to be in. A text with nobody on
--                                 it (an unassigned contact, an unknown number) goes to the
--                                 team topic only, per the SPEC. Readable by that auth.uid().
--   phone:presence:<client_id>    presence only (track + read), for anyone at own or higher.
--                                 No broadcast policy on it, so nobody can push call data
--                                 through the presence channel.
-- The topics are unambiguous because client ids are DNS-safe slugs (admin-catalog enforces
-- ^[a-z0-9][a-z0-9-]*$) and can never contain the ':' that separates `user:` or `presence:`.
--
-- ⚠️ realtime.send() SWALLOWS ITS OWN ERRORS (it RAISEs a WARNING and returns). On
-- 2026-09-29 realtime.messages had NO PARTITIONS on this project, because Realtime has never
-- been used here and the Realtime service creates the daily partitions itself. Until it has,
-- every broadcast is dropped with `WarnSendingBroadcastMessage: no partition of relation
-- "messages" found for row` and NOTHING fails. Check before relying on live updates:
--   select count(*) from pg_inherits where inhparent = 'realtime.messages'::regclass;  -- > 0
-- Do NOT create partitions by hand; the Realtime janitor owns their names and lifetimes.
-- PART 11 reports which case it found.
--
-- ── DEVIATIONS FROM docs/SPEC.md §2 (additive, or a reading the SPEC left open) ──────────
--   1. phone_devices' unique key is NULLS NOT DISTINCT. With the default, a NULL push_token
--      (every Chrome row, and a phone that refused notifications) never conflicts, so an
--      upsert on (user_id, platform, push_token) would add a row per sign-in forever.
--   2. `busy` in phone_route_for_number ignores a 'ringing' row older than 10 minutes and an
--      'in_progress' row older than 4 hours (Twilio's default call time limit). One lost
--      status callback would otherwise mark a person busy for good, and they would never be
--      rung again, with nothing anywhere saying why.
--   3. `dnd` in the member list is the EFFECTIVE value: dnd and (dnd_until is null or in the
--      future). A lapsed "until 1pm" does not keep someone off the ring list.
--   4. Broadcasts are sent only while the tenant's phone_status is 'on' (D9: off keeps
--      builders out until launch). No client can be subscribed for an 'off' tenant anyway,
--      because the Worker refuses /token for it.
--   5. transferred_from is one of a call's people on the user topic (the SPEC lists
--      placed_by, answered_by, rang_user_ids and the contact owner). The person who handed a
--      call on still has it in "My calls".
--   6. Extra CHECKs: forward_to and forward_to_cell must be E.164 (^\+[1-9][0-9]{6,14}$);
--      route members at most 10 (Twilio's <Dial> limit, plan §7) with no NULL entries;
--      business_hours a JSON object when set; device_generation >= 1.
--   7. Extra indexes beyond the SPEC's three on phone_calls: three partial indexes for the busy
--      check, one for the 911 callback window, one on client_call_sid; plus one each on
--      phone_call_events, phone_voicemails, phone_routes, phone_user_settings, phone_devices.
--   8. phone_route_for_number collapses a repeated member to its FIRST position, skips NULL
--      entries, and ignores a phone_routes row whose client_id is not the number's owner. It
--      returns NULL for an unknown or released number; phone_caller_context returns NULL for
--      a user who is on no team. Both are SECURITY INVOKER: they are service_role only, and
--      service_role already reads every table they touch.
--   9. The three meters are seeded at price_cents 0 (the sell price is the product owner's
--      call, and plan §17 names the meters without prices) and visible = true, exactly as
--      179 seeded the tax meters.
--  10. `busy`'s placed_by branch ignores a call once it has been transferred at all
--      (transferred_from is not NULL), not only one this person transferred: the Worker's own
--      "who is on this call" rule (routes/calls.ts), and the only reading that stays right on a
--      second hop, where transferred_from moves on to the teammate.
--  11. "Save as contact" is a SQL function (crm_create_contact) rather than an insert in
--      portal-settings, so the new row and the re-link of the number's earlier calls and texts
--      land together or not at all. It also writes the owner to crm_field_changes when one is
--      set, the way crm_update_contact does.
--  12. crm_contacts_source_check gains 'phone' (PART 9B): the plan's source "phone" was not an
--      allowed value (130 allows design | captured_lead | manual | import).
--  13. `busy` has the Worker's THIRD "on this call" clause too (workers/phone-api/src/
--      conference.ts onTheCall): during a warm transfer (transfer_state = 'conference') the
--      person who handed the call on (transferred_from) may still be in the conference,
--      consulting, so they are busy until it ends. Without it, SQL counted them free and new
--      inbound calls rang them mid-consult (review SSB-8).
--  14. "Save as contact" re-links only the rows nobody loses and nobody gains (review SSB-6):
--      a call moves onto the new contact only if every team member on it (placed_by,
--      answered_by, transferred_from, rang_user_ids) can still see it afterwards — the new
--      owner, or someone whose contacts level is view/edit — and, when the person saving is
--      limited to their own customers, only if they were on it themselves. Their texts move
--      only if they sent them. See crm_create_contact.
--
-- ── KNOWN, NOT CLOSED HERE ───────────────────────────────────────────────────────────────
--   * Contacts are never hard-deleted (192 merges by tombstone), so phone_calls' contact FK
--     below cannot block a delete. crm_merge_contacts carries phone_calls since PART 9B.
--   * "Save as contact" matches crm_contacts.phone_digits only. A number that lives on another
--     contact as a SECOND channel (crm_contact_people, 190) is not treated as a duplicate,
--     which is crm_save_contact's rule too.
--   * A user at phone 'own' gets no live event for a text nobody owns (unassigned contact or
--     unknown number): it rides the team topic, which 'own' may not read. That is the SPEC's
--     rule; they see it on the next Worker read.
--
-- ── PART 0 — blast radius. area_level_for is immutable, so this preview is exact. ───────
--   select cu.client_id, cu.role, cu.title,
--          public.area_level_for(cu.role, cu.title, cu.access, 'phone') as phone
--     from public.client_users cu order by 1, 3;
--   -- Before applying: every row 'none' (the area does not exist, unknown area -> 'none').
--   -- After: owners and admins 'edit'; office_staff and sales_manager 'view'; sales_rep,
--   --        dealer and NULL-title rows 'own'; scheduler, crew_leader, crew_member, driver
--   --        'none'. Nobody holds a stored {"phone": ...} override yet.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Panic button, no schema change:  update public.client_settings set phone_status = 'off';
-- That stops every broadcast, every token and every outbound call. ⚠️ IT DOES NOT SEND
-- CUSTOMERS' CALLS ANYWHERE USEFUL: a number already connected for calls (voice_enabled) still
-- points at the Worker, and the Worker answers a tenant that is off with "Sorry, this number
-- can't take calls right now" and hangs up, with no voicemail and no phone_calls row (review
-- SSB-2). For ONE builder, use the Phone tab's switch (portal-settings phone_status_set), which
-- also moves the number to the voicemail Bin; the Worker's recording sweep files those
-- messages. After the SQL panic button, the connected numbers are these, and each needs its
-- Voice URL pointed at the fallback Bin by hand (or phone_status_set off per tenant):
--   select client_id, phone_number from public.sms_numbers where voice_enabled and released_at is null;
-- The full removal is at the bottom of this file, after the commit, in the order it has to run.
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the per-tenant switch
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Same shape as sms_status (150): a status column on client_settings, which is service-role
-- only, so a tenant can neither read nor flip it. featureCheck.ts is for paid plan features,
-- not on/off switches. 'off' | 'on' only; the pilot tenant is switched on by hand.
alter table public.client_settings
  add column if not exists phone_status text not null default 'off';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'client_settings_phone_status_chk') then
    alter table public.client_settings
      add constraint client_settings_phone_status_chk
      check (phone_status in ('off', 'on'));
  end if;
end $$;

comment on column public.client_settings.phone_status is
  'SSS Phone switch (migration 254): off | on. Off by default for every builder. The phone-api Worker refuses tokens and calls for a tenant that is not on, and the phone broadcast triggers send nothing for it. Service-role only, like every column here.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — the existing number and message tables learn about calls
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ONE number per builder for calls and texts (plan D6): the sms_numbers row IS the phone
-- line. Calling never waits on text registration, which is why voice has its own flag
-- instead of reusing registration_status.
alter table public.sms_numbers
  add column if not exists voice_enabled         boolean not null default false,
  add column if not exists voice_configured_at   timestamptz,
  add column if not exists emergency_address_sid text;

comment on column public.sms_numbers.voice_enabled is
  'Migration 254: the number''s Twilio voice URL points at the phone-api Worker. Independent of registration_status — a number takes calls the day it is bought; texting waits for carrier registration.';
comment on column public.sms_numbers.emergency_address_sid is
  'Migration 254: Twilio Address SID (AD...) registered for 911 on this number, when 911 is supported (plan §14). NULL = none registered; the pilot blocks 911 in the dialer.';

-- The three columns sendTenantSms and sms-inbound start writing (plan §7). They need code
-- changes in shared modules, and changing smsSend.ts means redeploying EVERY importer.
alter table public.sms_messages
  add column if not exists client_temp_id text,
  add column if not exists sent_via       text,
  add column if not exists num_media      integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_messages_sent_via_chk') then
    alter table public.sms_messages
      add constraint sms_messages_sent_via_chk
      check (sent_via in ('portal', 'extension', 'mobile'));
  end if;
end $$;

comment on column public.sms_messages.client_temp_id is
  'Migration 254: the id the extension or phone app gave its optimistic bubble, so the confirmed row replaces it instead of showing twice. Written by the Worker after sendTenantSms returns (update by id).';
comment on column public.sms_messages.sent_via is
  'Migration 254: portal | extension | mobile for outbound texts a person sent. NULL for inbound and for automatic texts.';
comment on column public.sms_messages.num_media is
  'Migration 254: Twilio NumMedia on an inbound text. The body is stored; photos are not yet (release 2), so a nonzero count is what lets the app say a photo arrived.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the phone tables. Service-role only, every one.
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── phone_routes: who rings when this number is called. One row per number. ─────────────
-- `members` is the ordered list the OWNER assigned during setup ("owner sets up the phone
-- once, and the users assigned to that number get the calls automatically", decided
-- 2026-09-29). Only people with phone >= own should be assigned; the Worker re-checks every
-- call through phone_route_for_number's has_access rather than trusting the list.
create table if not exists public.phone_routes (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  number_id      uuid not null unique references public.sms_numbers(id) on delete cascade,
  mode           text not null default 'all_at_once' check (mode in ('all_at_once', 'in_order')),
  members        uuid[] not null default '{}',
  ring_seconds   integer not null default 20 check (ring_seconds between 5 and 60),
  no_answer      text not null default 'voicemail' check (no_answer in ('voicemail', 'forward')),
  forward_to     text,
  business_hours jsonb,
  time_zone      text not null default 'America/Chicago',
  after_hours    text not null default 'voicemail' check (after_hours in ('voicemail', 'forward')),
  greeting_url   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Twilio rings at most 10 nouns per <Dial>, and a NULL in the list would become a
  -- <Client> with no identity.
  constraint phone_routes_members_max      check (cardinality(members) <= 10),
  constraint phone_routes_members_no_nulls check (array_position(members, null) is null),
  constraint phone_routes_forward_to_e164  check (forward_to is null or forward_to ~ '^\+[1-9][0-9]{6,14}$'),
  constraint phone_routes_business_hours_object
    check (business_hours is null or jsonb_typeof(business_hours) = 'object')
);

create index if not exists phone_routes_client_idx on public.phone_routes (client_id);

drop trigger if exists phone_routes_set_updated_at on public.phone_routes;
create trigger phone_routes_set_updated_at
  before update on public.phone_routes
  for each row execute function public.set_updated_at();

comment on table public.phone_routes is
  'SSS Phone (migration 254): who rings when a builder''s number is called. One row per sms_numbers row. members = client_users.user_id, ordered, owner-assigned. business_hours = {"mon":[["08:00","17:00"]],...} in time_zone; NULL = always open. forward_to is E.164. Read by phone_route_for_number on every inbound call.';

-- ── phone_user_settings: per person ─────────────────────────────────────────────────────
-- device_generation is the `g<n>` in the Twilio identity u_<user_id hex>_g<n>. Bumping it
-- retires every device that person ever signed in on (removed staff, lost phone). No FK and
-- no cascade to client_users ON PURPOSE: if the row vanished with the person, re-adding them
-- would reset the generation to 1 and bring their old, retired devices back to life.
create table if not exists public.phone_user_settings (
  user_id           uuid primary key,
  client_id         text not null,
  dnd               boolean not null default false,
  dnd_until         timestamptz,
  forward_to_cell   text,
  device_generation integer not null default 1,
  updated_at        timestamptz not null default now(),
  constraint phone_user_settings_generation_positive check (device_generation >= 1),
  constraint phone_user_settings_cell_e164
    check (forward_to_cell is null or forward_to_cell ~ '^\+[1-9][0-9]{6,14}$')
);

create index if not exists phone_user_settings_client_idx on public.phone_user_settings (client_id);

drop trigger if exists phone_user_settings_set_updated_at on public.phone_user_settings;
create trigger phone_user_settings_set_updated_at
  before update on public.phone_user_settings
  for each row execute function public.set_updated_at();

comment on table public.phone_user_settings is
  'SSS Phone (migration 254): per-person Do Not Disturb, optional forward-to-cell (E.164) and device_generation (the g<n> in the Twilio identity; bump it to retire every old device). A person with no row is generation 1, not on DND, no forwarding. Kept when the person leaves the team, so re-adding them cannot revive retired devices.';

-- ── phone_calls: one row per call ───────────────────────────────────────────────────────
-- from_e164 / to_e164 carry NO format check, deliberately: an inbound caller can present
-- "Anonymous", "Restricted" or a short code, and a CHECK would make the call-log write fail
-- for exactly the calls a builder most wants to see.
create table if not exists public.phone_calls (
  id               uuid primary key default gen_random_uuid(),
  client_id        text not null,
  number_id        uuid references public.sms_numbers(id),
  contact_id       uuid references public.crm_contacts(id),
  direction        text not null check (direction in ('in', 'out')),
  from_e164        text not null,
  to_e164          text not null,
  twilio_call_sid  text unique,          -- the customer's (PSTN) leg
  client_call_sid  text,                 -- the app leg
  placed_by        uuid,
  answered_by      uuid,
  rang_user_ids    uuid[] not null default '{}',
  transferred_from uuid,
  transfer_state   text check (transfer_state in ('transferring', 'conference')),
  status           text not null default 'ringing'
    check (status in ('ringing', 'in_progress', 'completed', 'missed', 'voicemail', 'failed', 'busy', 'no_answer')),
  started_at       timestamptz not null default now(),
  answered_at      timestamptz,
  ended_at         timestamptz,
  duration_s       integer,
  cost_cents       integer,
  error_code       text,
  is_emergency     boolean not null default false
);

-- The SPEC's three list reads.
create index if not exists phone_calls_client_started_idx
  on public.phone_calls (client_id, started_at desc);
create index if not exists phone_calls_contact_started_idx
  on public.phone_calls (contact_id, started_at desc) where contact_id is not null;
create index if not exists phone_calls_number_started_idx
  on public.phone_calls (number_id, started_at desc);
-- phone_route_for_number's busy check runs on EVERY inbound call inside a 200 ms budget.
-- Live calls are a tiny slice of the table, so these stay small forever.
create index if not exists phone_calls_live_answered_idx
  on public.phone_calls (answered_by)
  where status in ('ringing', 'in_progress') and answered_by is not null;
create index if not exists phone_calls_live_placed_idx
  on public.phone_calls (placed_by)
  where status in ('ringing', 'in_progress') and placed_by is not null;
-- The third busy branch (DEVIATION 13): who handed a call on and may still be in its
-- conference. Only calls mid-warm-transfer match, so this is the smallest of the three.
create index if not exists phone_calls_live_conference_idx
  on public.phone_calls (transferred_from)
  where status in ('ringing', 'in_progress') and transfer_state = 'conference' and transferred_from is not null;
-- The 911 callback window (plan §14): "any inbound call within 60 minutes rings only the
-- person who dialed 911".
create index if not exists phone_calls_emergency_idx
  on public.phone_calls (number_id, started_at desc)
  where is_emergency and direction = 'out';
-- Status callbacks for the app leg arrive keyed on the app leg's CallSid.
create index if not exists phone_calls_client_call_sid_idx
  on public.phone_calls (client_call_sid) where client_call_sid is not null;

comment on table public.phone_calls is
  'SSS Phone (migration 254): one row per call, written by the phone-api Worker. twilio_call_sid = the customer''s leg, client_call_sid = the app leg. rang_user_ids = everyone the call rang (a missed call counts against each). A call is "mine" if I placed, answered or handed it on; a missed call belongs to the contact''s owner, else to everyone it rang (plan §7). from_e164/to_e164 are unchecked on purpose: callers can present Anonymous.';

-- ── phone_call_events: a millisecond timeline per call (debugging and latency) ──────────
create table if not exists public.phone_call_events (
  id      bigint generated always as identity primary key,
  call_id uuid not null references public.phone_calls(id) on delete cascade,
  type    text not null,
  at      timestamptz not null default clock_timestamp(),
  data    jsonb
);

create index if not exists phone_call_events_call_idx on public.phone_call_events (call_id, at);

comment on table public.phone_call_events is
  'SSS Phone (migration 254): timing marks per call — click, connect, twiml_served, ringing, answered, transfer, ended — at clock_timestamp() precision (now() would stamp every mark in one transaction identically). data is free-form and must never hold a token or a signature.';

-- ── phone_voicemails ────────────────────────────────────────────────────────────────────
create table if not exists public.phone_voicemails (
  id            uuid primary key default gen_random_uuid(),
  call_id       uuid not null unique references public.phone_calls(id) on delete cascade,
  client_id     text not null,
  recording_sid text unique,
  duration_s    integer,
  transcript    text,
  listened_at   timestamptz,
  listened_by   uuid,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists phone_voicemails_client_created_idx
  on public.phone_voicemails (client_id, created_at desc);

comment on table public.phone_voicemails is
  'SSS Phone (migration 254): one voicemail per call. recording_sid is Twilio''s (RE...); the audio stays at Twilio and is streamed by the Worker, never stored here. deleted_at = deleted at Twilio (retention 12 months by default, plan §7).';

-- ── phone_devices: the apps' normal push tokens (text alerts) ───────────────────────────
-- NOT the VoIP token: Twilio holds that one itself. See DEVIATION 1 for NULLS NOT DISTINCT.
create table if not exists public.phone_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  client_id    text not null,
  platform     text not null check (platform in ('chrome', 'ios', 'android')),
  build_type   text not null default 'prod' check (build_type in ('dev', 'prod')),
  push_token   text,
  push_kind    text check (push_kind in ('fcm', 'apns')),
  app_version  text,
  last_seen_at timestamptz not null default now(),
  constraint phone_devices_user_platform_token_key unique nulls not distinct (user_id, platform, push_token)
);

create index if not exists phone_devices_client_idx on public.phone_devices (client_id);

comment on table public.phone_devices is
  'SSS Phone (migration 254): each signed-in extension or phone app, with its normal notification token (FCM on Android, APNs on iPhone) for text alerts. The VoIP token for calls is held by Twilio, not here. Unique NULLS NOT DISTINCT on (user_id, platform, push_token), so a device with no token upserts one row instead of adding one per sign-in.';

-- ── RLS on, zero policies, and the PUBLIC grant revoked — 229/244's posture ─────────────
alter table public.phone_routes        enable row level security;
alter table public.phone_user_settings enable row level security;
alter table public.phone_calls         enable row level security;
alter table public.phone_call_events   enable row level security;
alter table public.phone_voicemails    enable row level security;
alter table public.phone_devices       enable row level security;

revoke all on public.phone_routes        from public;
revoke all on public.phone_user_settings from public;
revoke all on public.phone_calls         from public;
revoke all on public.phone_call_events   from public;
revoke all on public.phone_voicemails    from public;
revoke all on public.phone_devices       from public;
revoke all on public.phone_routes        from anon, authenticated;
revoke all on public.phone_user_settings from anon, authenticated;
revoke all on public.phone_calls         from anon, authenticated;
revoke all on public.phone_call_events   from anon, authenticated;
revoke all on public.phone_voicemails    from anon, authenticated;
revoke all on public.phone_devices       from anon, authenticated;
-- The Worker and portal-settings write these as service_role. The default privileges already
-- give it this; stating it means the file does not depend on which role applies it.
grant select, insert, update, delete on public.phone_routes        to service_role;
grant select, insert, update, delete on public.phone_user_settings to service_role;
grant select, insert, update, delete on public.phone_calls         to service_role;
grant select, insert, update, delete on public.phone_call_events   to service_role;
grant select, insert, update, delete on public.phone_voicemails    to service_role;
grant select, insert, update, delete on public.phone_devices       to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — area_level_for(), re-issued with the `phone` area
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Copied WHOLE from 219_office_staff_designer.sql, the most recent DEFINITION, which was
-- checked against pg_get_functiondef on the live project before this file was written (they
-- were byte-identical). Derive it again before the next re-issue; do not trust this line:
--   grep -l 'create or replace function public.area_level_for' supabase/migrations/*.sql
-- The edits: the "phone" row in k_areas, and a "phone" cell in the owner, admin,
-- office_staff, sales_manager, sales_rep and dealer presets. The resolution logic and the
-- normTitle CASE are untouched. PART 10 re-asserts 219's cells, so a lost cell cannot ship.
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
  k_areas constant jsonb := $j$
  {
    "designer":              {"levels": ["none","view","edit"]},
    "designs":               {"levels": ["none","view","edit"]},
    "contacts":              {"levels": ["none","own","view","edit"]},
    "inventory":             {"levels": ["none","view","edit"]},
    "orders":                {"levels": ["none","view","edit"]},
    "change_orders":         {"levels": ["none","view","edit"]},
    "change_order_approve":  {"levels": ["none","edit"]},
    "build_schedule":        {"levels": ["none","view","edit"]},
    "delivery_schedule":     {"levels": ["none","view","edit"]},
    "repairs":               {"levels": ["none","view","edit"]},
    "commissions":           {"levels": ["none","own","edit"]},
    "reports":               {"levels": ["none","view","edit"]},
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
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","phone":"edit","projects":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"edit"
    },
    "admin": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","phone":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"none"
    },
    "sales_rep": {
      "designer":"edit","designs":"edit","contacts":"edit","phone":"own",
      "inventory":"view","orders":"edit","commissions":"own"
    },
    "office_staff": {
      "designer":"edit",
      "designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit",
      "build_schedule":"view","delivery_schedule":"view","repairs":"view","reports":"view",
      "phone":"view",
      "settings_branding":"edit","settings_quickbooks":"edit"
    },
    "sales_manager": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"view",
      "orders":"edit","change_orders":"edit","commissions":"edit","reports":"edit",
      "phone":"view"
    },
    "dealer": {
      "designer":"edit","designs":"edit","contacts":"own",
      "inventory":"view","orders":"edit","commissions":"own","phone":"own"
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
comment on function public.area_level_for(text, text, jsonb, text) is
  'Pure mirror of effectiveAccess() in supabase/functions/_shared/access.ts: the title preset merged with the stored per-area deviations, owners absolute. MUST be changed in the same commit as that file — scripts/preflight.mjs cross-checks the AREA and TITLE lists on every push, and access.test.ts compares every preset LEVEL cell against this function''s literals. Migration 254 added the phone area. Reads no tables, so it is safe to call for preview/audit.';

revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;
grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — the literal team check (SQL twin of ownPhoneOnly in access.ts)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Takes a RESOLVED level and answers "own only?". TRUE unless the level is literally 'view'
-- or 'edit', so 'none', NULL and anything unrecognised are all "own only": the team check
-- (`not phone_own_only(...)`) fails CLOSED. That is the one way this differs from
-- crm_contact_scope(), which fails open because a permissive tenant policy stands behind it;
-- on realtime.messages nothing stands behind it.
--
-- PURE and granted to authenticated because the realtime policy in PART 8 runs as the
-- signed-in user. It reads no table, so there is nothing to learn by calling it.
create or replace function public.phone_own_only(p_level text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_level is null or p_level not in ('view', 'edit');
$fn$;

comment on function public.phone_own_only(text) is
  'SQL twin of ownPhoneOnly() in _shared/access.ts (migration 254): is this phone level limited to the person''s own calls? TRUE unless literally view or edit, so the team check `not phone_own_only(level)` fails closed. Rank cannot answer this: it scores own and view the same.';

revoke execute on function public.phone_own_only(text) from public, anon;
grant  execute on function public.phone_own_only(text) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 6 — the Worker's two RPCs. service_role only, uncached, one round trip each.
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── phone_route_for_number: everything /voice/inbound needs, in one call ────────────────
-- Twilio waits for our answer before it rings anyone, so this is on the 200 ms budget of
-- every inbound call. It never caches: busy, DND and team membership must take effect on the
-- very next call.
--
-- Returns NULL for a number that is not live here (released, or never ours). Otherwise:
--   {client_id, number_id, phone_status,
--    route: <the phone_routes row as JSON> | null,
--    members: [{user_id, identity, dnd, busy, has_access, full_name, forward_to_cell}],
--    business_name, recent_emergency_user: uuid | null}
-- in the route's member order. The Worker drops members with has_access false, dnd true or
-- busy true; this function reports, it does not filter, so the Worker can log who was skipped.
--
--   identity     u_<user_id hex>_g<device_generation>. Never `_dev`: a development build
--                rings only on test calls placed straight to its own identity (SPEC §1).
--   dnd          EFFECTIVE Do Not Disturb (DEVIATION 3).
--   busy         on a live call they placed (and have not handed on, DEVIATION 10) or
--                answered, or one they handed on by warm transfer that is still in its
--                conference (DEVIATION 13) — the Worker's onTheCall, all three clauses
--                (DEVIATION 2 bounds "live").
--   has_access   still on THIS number's team, at phone own or higher. Someone removed from
--                the team, moved to another tenant or set to 'none' is false.
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

  select cs.phone_status, cs.business_name
    into v_status, v_business
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
    'recent_emergency_user', v_emergency
  );
end
$fn$;

comment on function public.phone_route_for_number(text) is
  'SSS Phone (migration 254): the one database call behind /voice/inbound. Returns {client_id, number_id, phone_status, route, members:[{user_id, identity, dnd, busy, has_access, full_name, forward_to_cell}], business_name, recent_emergency_user} for a live number, NULL otherwise. Uncached by design. service_role only.';

revoke execute on function public.phone_route_for_number(text) from public, anon, authenticated;
grant  execute on function public.phone_route_for_number(text) to service_role;

-- ── phone_caller_context: who is this signed-in person, for /token and /voice/outbound ──
-- The Worker checks Supabase login tokens locally (it never calls auth.getUser), so a local
-- check cannot see a removal. /voice/outbound therefore re-reads this, uncached, on EVERY
-- call: still on a team, phone level, current device generation, the tenant's switch.
--
-- Returns NULL for a user on no team. Otherwise:
--   {client_id, phone_status, phone_level, contacts_level, own_contacts_only,
--    device_generation, number: {id, e164, voice_enabled, registration_status} | null,
--    full_name}
-- `number` is the tenant's live line: the sms_numbers row matching client_settings.sms_number
-- when there is one (that is the number sendTenantSms texts from), else the newest live row.
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
           'full_name',         cu.full_name
         )
    from public.client_users cu
    left join public.client_settings cs on cs.client_id = cu.client_id
    left join public.phone_user_settings s on s.user_id = cu.user_id
   where cu.user_id = p_user_id
   limit 1;
$fn$;

comment on function public.phone_caller_context(uuid) is
  'SSS Phone (migration 254): one uncached read of a signed-in person for /token and every /voice/outbound: {client_id, phone_status, phone_level, contacts_level, own_contacts_only, device_generation, number, full_name}. NULL when the user is on no team. service_role only.';

revoke execute on function public.phone_caller_context(uuid) from public, anon, authenticated;
grant  execute on function public.phone_caller_context(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 6B — "Sign out all devices": end one person's Supabase sessions
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- portal-settings' phone_signout_user bumps phone_user_settings.device_generation, which
-- retires every Twilio identity the person holds. On its own that does not secure a lost
-- phone: a device still signed in to Supabase refreshes its session, asks /token again and
-- gets a line on the NEW generation. supabase-js has no admin "sign out user X"
-- (auth.admin.signOut needs that user's own JWT), so this ends the sessions in the database,
-- which is what GoTrue's own global logout does: delete the person's auth.sessions rows.
-- auth.refresh_tokens.session_id and auth.mfa_amr_claims.session_id are both ON DELETE
-- CASCADE (checked on the live project 2026-09-29), so every refresh token goes with them and
-- the next refresh fails. An access token already issued stays valid until it expires (an hour
-- at most); nothing server-side can recall a JWT, which is why the Worker's /token also asks
-- Auth whether the session still exists (phone-api DEVIATIONS 8).
--
-- ⚠️ IT SIGNS THE PERSON OUT OF STRUCTURE STUDIO EVERYWHERE, not only SSS Phone: the portal
-- and every browser too. For a lost phone or someone leaving, that is the point; the Settings
-- screen says so before the owner presses it.
--
-- SECURITY DEFINER: the function's owner (postgres, which holds DELETE on auth.sessions,
-- checked live) does the delete. service_role only. The caller (portal-settings) has already
-- checked phone:edit and that the person is on THIS tenant's team. Returns how many sessions
-- it ended; 0 for NULL or for someone with none.
create or replace function public.phone_end_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
begin
  if p_user_id is null then
    return 0;
  end if;
  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function public.phone_end_user_sessions(uuid) is
  'SSS Phone (migration 254): "Sign out all devices". Deletes the user''s auth.sessions rows (refresh tokens and MFA claims cascade), so every device must sign in again. Signs them out of Structure Studio everywhere, not only SSS Phone. Returns the number of sessions ended. service_role only; the caller checks phone:edit and team membership.';

revoke execute on function public.phone_end_user_sessions(uuid) from public, anon, authenticated;
grant  execute on function public.phone_end_user_sessions(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 7 — ids-only broadcasts from the three tables
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A trigger rather than application code because FOUR writers touch these rows today or soon
-- (the Worker, sms-inbound, sms-status, portal-settings' crm_send_sms) and a fifth will be
-- written by somebody who has never read this file. One AFTER trigger per table catches all
-- of them, which is 219's reasoning for change_orders_flag_build_job.
--
-- ⛔ A BROADCAST MUST NEVER FAIL THE WRITE. This fires inside the transaction that records a
-- customer's text or a call. The whole body sits in an exception block that downgrades any
-- error to a WARNING, and realtime.send() already does the same for its own insert. A missed
-- live update costs a refresh; a failed insert costs the customer's message.
--
-- SECURITY DEFINER so the contact-owner lookup and the realtime.messages insert work the same
-- whichever role wrote the row. It reads crm_contacts, client_settings and phone_calls and
-- writes nothing but realtime.messages.
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
    elsif tg_table_name = 'sms_messages' then
      v_event   := 'sms';
      v_contact := v_row -> 'contact_id';
      v_snaps   := array[v_row];
      if v_old is not null then v_snaps := v_snaps || v_old; end if;
    else
      return null;
    end if;

    -- The people. Keys a table does not have read as NULL and fall out below, which is what
    -- lets one loop serve both a call (placed_by, answered_by, transferred_from,
    -- rang_user_ids) and a text (sent_by).
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
      'table',      tg_table_name,
      'op',         tg_op,
      'id',         v_row -> 'id',
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
  'SSS Phone (migration 254): AFTER trigger on phone_calls, phone_voicemails and sms_messages. Sends {table, op, id, contact_id} with realtime.send(..., private => true) on phone:<client_id> and on phone:user:<id> for each of the row''s people, only while the tenant''s phone_status is on. Never fails the write: every error becomes a WARNING.';

revoke execute on function public.phone_realtime_notify() from public, anon, authenticated;

drop trigger if exists phone_calls_realtime on public.phone_calls;
create trigger phone_calls_realtime
  after insert or update or delete on public.phone_calls
  for each row execute function public.phone_realtime_notify();

drop trigger if exists phone_voicemails_realtime on public.phone_voicemails;
create trigger phone_voicemails_realtime
  after insert or update or delete on public.phone_voicemails
  for each row execute function public.phone_realtime_notify();

drop trigger if exists sms_messages_phone_realtime on public.sms_messages;
create trigger sms_messages_phone_realtime
  after insert or update or delete on public.sms_messages
  for each row execute function public.phone_realtime_notify();

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 8 — who may join which private channel
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- realtime.messages is owned by supabase_realtime_admin; `postgres` may still manage its
-- policies through supautils.policy_grants (checked 2026-09-29). There were no policies on it
-- before this file, so these four are the whole of private-channel access on this project.
--
-- PERMISSIVE, `to authenticated`, and each one pinned to one extension:
--   broadcast  read on phone:user:<me> and phone:<my client> (team). No INSERT policy: only
--              the database sends on these topics, never a client.
--   presence   read + track on phone:presence:<my client>, for phone own or higher.
--
-- The tenant guard is structural: current_client_id() is NULL for a caller with no
-- client_users row, and 'phone:' || NULL is NULL, so current_area_level()'s fail-open answer
-- for such a caller (154) can never let them in. The `(select ...)` wrappers hoist each call
-- into an InitPlan, the pattern 154 uses on auth.uid().
create policy phone_user_topic_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'phone:user:' || (select auth.uid())::text
  );

create policy phone_team_topic_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'phone:' || (select public.current_client_id())
    and not public.phone_own_only((select public.current_area_level('phone')))
  );

create policy phone_presence_read on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'phone:presence:' || (select public.current_client_id())
    and (select public.current_area_level('phone')) in ('own', 'view', 'edit')
  );

create policy phone_presence_track on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'phone:presence:' || (select public.current_client_id())
    and (select public.current_area_level('phone')) in ('own', 'view', 'edit')
  );

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 9 — the meters, seeded OFF
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 169's arming rail: a price row seeded INACTIVE lets the charging code deploy and be watched
-- running free, and then ONE statement turns the money on. wallet_hold answers
-- `meter_inactive` for such a row, and portal-billing lists only active meters, so these are
-- invisible to builders until armed. Price 0 until the product owner's pricing call (plan §17 lists
-- the meters, not the prices) — set it in the same statement that arms it, as 179 says.
insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note)
values
  ('phone_line_monthly', 'Phone line', 'month', 0, false, true, 40,
   'SSS Phone line fee. Twilio hard cost about $1.15/month per local number. The number is the SAME sms_numbers row texting uses, so decide whether this replaces or adds to sms_number_monthly for a builder who has both before arming. Posted monthly by the phone-api Worker''s cron (plan §17); nothing charges it yet.'),
  ('voice_minute', 'Call minutes', 'minute', 0, false, true, 41,
   'SSS Phone call minutes, debited daily per tenant through wallet_credit (the taxMeter.ts pattern), keyed on tenant + date. Twilio hard cost per minute: about $0.018 outbound, $0.0125 inbound (both legs), each leg rounded up to the whole minute. Nothing charges it yet.'),
  ('voicemail_transcription', 'Voicemail transcription', 'minute', 0, false, true, 42,
   'SSS Phone voicemail transcription (release 2). Twilio <Record transcribe> about $0.05/minute, Conversational Intelligence about $0.024/minute; pick in phase 5. Nothing charges it yet.')
on conflict (kind) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 9B — the CRM learns about calls: "Save as contact", and merges that carry calls
-- ═════════════════════════════════════════════════════════════════════════════════════════

-- ── crm_contacts.source gains 'phone' ───────────────────────────────────────────────────
-- Plan section 6: "Save as contact creates the CRM contact (source "phone")". 130's
-- crm_contacts_source_check allows design | captured_lead | manual | import, verified against
-- pg_get_constraintdef on 2026-09-29. Re-issued with the one new value. Every existing row
-- already satisfies it, so the re-validation is a scan that cannot fail. PART 10 asserts it.
alter table public.crm_contacts drop constraint if exists crm_contacts_source_check;
alter table public.crm_contacts
  add constraint crm_contacts_source_check
  check (source in ('design', 'captured_lead', 'manual', 'import', 'phone'));

-- ── crm_create_contact: "Save as contact" for an unknown number ─────────────────────────
-- portal-settings' crm_create_contact action (called by the SSS Phone extension and app with
-- {name, phone, source: 'phone'}) is this one call, for crm_update_contact's reason (188):
-- the things that have to happen together happen in one statement's transaction. Here they
-- are the new row and the RE-LINK: this tenant's earlier phone_calls and sms_messages rows
-- that have no contact and whose customer-side number matches move onto the new contact, so
-- the thread the person was looking at is the contact's history the moment it is saved.
--
--   the customer's side of a row   phone_calls:  from_e164 when direction = 'in', else to_e164
--                                  sms_messages: from_number when 'in', else to_number
--   matched through crm_phone_key  the same normaliser phone_digits is stored with (132), so
--                                  "+1 555 555 0142" and "(555) 555-0142" are one number, and
--                                  "Anonymous" (NULL key) matches nothing
--
-- Rules, and where each one lives:
--   * DUPLICATES are refused by crm_contacts_tenant_phone (130's partial unique index on
--     client_id + phone_digits among live rows). The 23505 is what portal-settings turns into
--     crm_save_contact's own sentence. Nothing is checked by hand first: a read-then-insert
--     would race, the index cannot.
--   * THE OWNER is the caller's to choose (portal-settings passes the caller when they are
--     limited to their own customers, else NULL: the design path, crm_ensure_contact, assigns
--     nobody either). It must be on THIS tenant's team, crm_update_contact's check (188).
--   * NO PHONE, NO CONTACT: a number crm_phone_key cannot key is refused. Saving a thread's
--     number is the whole point, and a keyless row could never be matched again.
--   * THE RE-LINK MOVES ONLY WHAT NOBODY LOSES AND NOBODY GAINS (DEVIATION 14, review SSB-6).
--     Moving a row onto a contact changes who can see it: the edge and the phone-api Worker
--     show a row with a contact only to people who can see that contact (193's rule: its
--     owner, its followers, anyone at contacts view/edit, and everyone while it is
--     unassigned), where an unlinked call is shown to the people who were on it. So:
--       - a CALL moves only if every team member on it (placed_by, answered_by,
--         transferred_from, rang_user_ids) can see the new contact afterwards. With an owner
--         set, a teammate limited to their own customers who took that call would otherwise
--         lose it from "My calls" and the Calls report the moment someone else saved the
--         number. Such calls stay unlinked, still theirs, still under the number's thread.
--       - when the person SAVING (p_actor) is limited to their own customers, a call moves
--         only if they were on it, and a text only if they sent it. They could not see the
--         rest before (unknown numbers are for contacts view/edit), and making them the owner
--         must not hand them a teammate's calls or the customer's earlier texts.
--     Nobody else's access changes: an unassigned contact is visible to everyone, so for a
--     saver who is not narrowed every row still moves (bar a contacts:'none' teammate's call).
-- SECURITY DEFINER and service_role only, like crm_update_contact: the tenant is a parameter
-- resolveTenant supplies and never a value a browser chooses. Returns
-- {id, relinked: {calls, sms}}.
create or replace function public.crm_create_contact(
  p_client_id text,
  p_name      text,
  p_phone     text,
  p_owner     uuid default null,
  p_actor     uuid default null,
  p_source    text default 'phone'
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_phone  text := nullif(btrim(coalesce(p_phone, '')), '');
  v_digits text;
  v_id     uuid;
  v_calls  integer := 0;
  v_sms    integer := 0;
  v_narrowed boolean;
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'a tenant is required' using errcode = 'null_value_not_allowed';
  end if;
  v_digits := public.crm_phone_key(v_phone);
  if v_digits is null then
    raise exception 'a phone number is required' using errcode = 'check_violation';
  end if;
  if p_owner is not null
     and not exists (select 1 from public.client_users cu
                      where cu.user_id = p_owner and cu.client_id = p_client_id) then
    raise exception 'owner is not on this team' using errcode = 'foreign_key_violation';
  end if;

  insert into public.crm_contacts (client_id, name, phone, phone_digits, owner_user_id, source)
  values (p_client_id, v_name, v_phone, v_digits, p_owner, coalesce(nullif(btrim(p_source), ''), 'phone'))
  returning id into v_id;

  -- The owner is a field a person chose, so it is logged the way crm_update_contact logs an
  -- owner change; crmFeed already renders field 'owner' ("Owner changed: Unassigned → name").
  if p_owner is not null then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, v_id, 'owner', null, p_owner::text, p_actor);
  end if;

  -- Is the person saving limited to their own customers? The same resolver portal-settings'
  -- ownContactsOnly mirrors. Someone with no team row here (an operator in view-as) is not.
  select public.area_level_for(cu.role, cu.title, cu.access, 'contacts') not in ('view', 'edit')
    into v_narrowed
    from public.client_users cu
   where cu.user_id = p_actor and cu.client_id = p_client_id;
  v_narrowed := coalesce(v_narrowed, false);

  update public.phone_calls c
     set contact_id = v_id
   where c.client_id = p_client_id
     and c.contact_id is null
     and public.crm_phone_key(case when c.direction = 'in' then c.from_e164 else c.to_e164 end) = v_digits
     -- A narrowed saver moves only calls they were on.
     and (not v_narrowed
          or p_actor = c.placed_by or p_actor = c.answered_by or p_actor = c.transferred_from
          or p_actor = any(c.rang_user_ids))
     -- Nobody on the call loses it: every team member on it can see the new contact.
     and not exists (
       select 1
         from public.client_users cu
        where cu.client_id = p_client_id
          and (cu.user_id = c.placed_by or cu.user_id = c.answered_by
               or cu.user_id = c.transferred_from or cu.user_id = any(c.rang_user_ids))
          and not (
            public.area_level_for(cu.role, cu.title, cu.access, 'contacts') in ('view', 'edit')
            or (public.area_level_for(cu.role, cu.title, cu.access, 'contacts') = 'own'
                and (p_owner is null or p_owner = cu.user_id))
          )
     );
  get diagnostics v_calls = row_count;

  -- Texts from an unknown number are shown only to contacts view/edit, so moving them onto an
  -- unassigned contact takes nothing from anyone. A narrowed saver moves only what they sent.
  update public.sms_messages m
     set contact_id = v_id
   where m.client_id = p_client_id
     and m.contact_id is null
     and public.crm_phone_key(case when m.direction = 'in' then m.from_number else m.to_number end) = v_digits
     and (not v_narrowed or m.sent_by = p_actor);
  get diagnostics v_sms = row_count;

  return jsonb_build_object(
    'id', v_id,
    'relinked', jsonb_build_object('calls', v_calls, 'sms', v_sms));
end
$fn$;

comment on function public.crm_create_contact(text, text, text, uuid, uuid, text) is
  'SSS Phone "Save as contact" (migration 254): inserts a crm_contacts row (source phone by default, phone_digits through crm_phone_key, owner checked against the tenant''s team) and moves this tenant''s earlier phone_calls and sms_messages rows with no contact and a matching customer-side number onto it — only rows no team member on them would lose sight of, and, for a saver limited to their own customers (p_actor), only calls they were on and texts they sent. A duplicate number raises 23505 from crm_contacts_tenant_phone. Returns {id, relinked:{calls, sms}}. service_role only.';

revoke execute on function public.crm_create_contact(text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.crm_create_contact(text, text, text, uuid, uuid, text) to service_role;

-- ── crm_merge_contacts re-issued: the tenth table is phone_calls ────────────────────────
-- 192's body, copied WHOLE. It was checked byte-identical to the live pg_get_functiondef on
-- 2026-09-29 (192 is the only migration that defines it). Derive it again before the next
-- re-issue; do not trust this line:
--   select pg_get_functiondef('public.crm_merge_contacts(text,uuid,uuid,uuid)'::regprocedure);
-- The one edit: after sms_messages, phone_calls moves to the winner and is counted as
-- moved.calls. phone_voicemails carry no contact of their own (they ride their call), and
-- phone_call_events hang off the call id, so nothing else about a call needs to move. Without
-- this a merged contact's calls stay on the tombstone, which every read filters out: the
-- record kept would simply lose its call history. PART 10 asserts the edit landed and PART 11
-- merges two synthetic contacts to prove a call follows.
create or replace function public.crm_merge_contacts(
  p_client_id text,
  p_winner    uuid,
  p_loser     uuid,
  p_actor     uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_win   public.crm_contacts%rowtype;
  v_lose  public.crm_contacts%rowtype;
  v_moved jsonb := '{}'::jsonb;
  v_label text;
  v_n     integer;
  v_name  text;
  v_phone text;
  v_email text;
  v_street text; v_city text; v_state text; v_zip text;
  v_bstreet text; v_bcity text; v_bstate text; v_bzip text;
  v_owner uuid;
  v_p     public.crm_contact_people%rowtype;
  v_left  integer := 0;
  v_phone_conflict boolean := false;
  v_email_conflict boolean := false;
  v_name_conflict  boolean := false;
begin
  if p_winner is null or p_loser is null then
    raise exception 'both contacts are required' using errcode = 'null_value_not_allowed';
  end if;
  if p_winner = p_loser then
    raise exception 'a contact cannot be merged into itself' using errcode = 'check_violation';
  end if;

  -- ONE MERGE AT A TIME PER PAIR, and the key is ordered so two people pressing the button
  -- from opposite ends (A into B, B into A) queue instead of deadlocking. Same instrument and
  -- the same reasoning as crm_ensure_contact's lock: the alternative is two half-merges
  -- interleaving over the same nine tables.
  perform pg_advisory_xact_lock(
    hashtext('ss_crm_merge:' || p_client_id || ':' || least(p_winner, p_loser)::text));
  perform pg_advisory_xact_lock(
    hashtext('ss_crm_merge:' || p_client_id || ':' || greatest(p_winner, p_loser)::text));

  select * into v_win  from public.crm_contacts where id = p_winner and client_id = p_client_id;
  if not found then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;
  select * into v_lose from public.crm_contacts where id = p_loser  and client_id = p_client_id;
  if not found then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;

  -- REFUSE A TOMBSTONE AT EITHER END, loudly rather than by doing nothing.
  --   * merging INTO one would hang live rows off a record every read in the product filters
  --     out — the customer's history would simply stop appearing anywhere;
  --   * merging one AWAY again would rewrite where the first merge said it went, and
  --     merged_into is the only record of that.
  if v_win.merged_into is not null then
    raise exception 'that contact has already been merged into another one'
      using errcode = 'check_violation';
  end if;
  if v_lose.merged_into is not null then
    raise exception 'that contact has already been merged'
      using errcode = 'check_violation';
  end if;

  -- ⚠️ THE TOMBSTONE GOES FIRST, AND THE ORDER IS NOT COSMETIC. crm_contacts' two unique
  -- indexes are PARTIAL on `merged_into is null` (130:62-68). Enriching the winner with the
  -- loser's phone while the loser is still live collides with the loser's own row; with the
  -- tombstone set, that phone has left the index and the enrichment below is free.
  update public.crm_contacts
     set merged_into = p_winner, updated_at = now()
   where id = p_loser and client_id = p_client_id;

  -- ── RE-POINT ───────────────────────────────────────────────────────────────────────────
  -- Nine tables carry a contact_id. Every one of them is a thing somebody said, sent, filed
  -- or bought, and a merge that leaves any of them behind hangs it off a record nobody can
  -- open — which is worse than the duplicate it was meant to fix, because the duplicate at
  -- least still rendered.
  --
  -- The counts are returned so the caller can show what actually moved. A merge is
  -- irreversible in practice; "17 designs, 3 notes, 41 messages" is what makes it reviewable.
  update public.designs        set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('designs', v_n);

  update public.captured_leads set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('captured_leads', v_n);

  update public.crm_notes      set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('notes', v_n);

  update public.crm_activities set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('activities', v_n);

  update public.crm_files      set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('files', v_n);

  update public.sms_messages   set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('sms', v_n);

  -- 254: THE TENTH TABLE. A merged contact's calls follow it the way its texts do; left
  -- behind, they would hang off a tombstone every read filters out. phone_voicemails carry no
  -- contact of their own (they ride their call), so this one update moves them too.
  update public.phone_calls    set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('calls', v_n);

  update public.email_inbound  set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('email_in', v_n);

  update public.email_sends    set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('email_out', v_n);

  -- The two child tables 189 and 190 added. Not in the original list of nine because they did
  -- not exist when it was written, and leaving them out is not survivable: the loser's second
  -- email is the single thing a merge is most often performed to preserve.
  --
  -- FOLLOWERS: move the ones the winner does not already have, then drop the leftovers. A
  -- leftover is by definition the SAME person already following the SAME winning record, and
  -- the row carries nothing else worth keeping — only when they started following and why.
  -- Both records holding the same follower is common, and is often why somebody noticed the
  -- duplicate in the first place.
  update public.crm_contact_followers f set contact_id = p_winner
   where f.client_id = p_client_id and f.contact_id = p_loser
     and not exists (select 1 from public.crm_contact_followers f2
                      where f2.contact_id = p_winner and f2.user_id = f.user_id);
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('followers', v_n);
  delete from public.crm_contact_followers
   where client_id = p_client_id and contact_id = p_loser;   -- the duplicates left behind

  -- ⚠️ THE PEOPLE ROWS MOVE ONE AT A TIME, not as a set update, and the reason is the shape of
  -- 190's indexes. They are two SEPARATE partial uniques (phone per contact, email per
  -- contact), so a loser's row can collide with the winner on ONE channel while carrying a
  -- second channel the winner does not have — and a set-based "move the ones that do not
  -- collide, delete the rest" throws that second channel away. Which is the exact class of
  -- loss this whole change was written to stop, arriving through the merge instead of through
  -- the resolver.
  --
  -- So: try to move it; if it collides, fill the gaps on the row already there and drop the
  -- redundant copy; if THAT collides too (its two channels are split across two different
  -- rows on the winner), leave it attached to the tombstone rather than delete it. Nothing
  -- here ever destroys a channel — a stranded row is recoverable, a deleted one is not.
  v_n := 0; v_left := 0;
  for v_p in select * from public.crm_contact_people
              where client_id = p_client_id and contact_id = p_loser
              order by ordinal, created_at, id
  loop
    begin
      update public.crm_contact_people
         set contact_id = p_winner,
             ordinal = coalesce((select max(x.ordinal) from public.crm_contact_people x
                                  where x.contact_id = p_winner), 1) + 1,
             is_primary = false          -- the winner already has one, or none; never two
       where id = v_p.id;
      v_n := v_n + 1;
    exception when unique_violation then
      begin
        update public.crm_contact_people w set
          name  = coalesce(w.name,  v_p.name),
          phone = coalesce(w.phone, v_p.phone),
          email = coalesce(w.email, v_p.email)
         where w.contact_id = p_winner
           and ( (v_p.phone_digits is not null and w.phone_digits = v_p.phone_digits)
              or (v_p.email_lower  is not null and w.email_lower  = v_p.email_lower) );
        delete from public.crm_contact_people where id = v_p.id;
      exception when unique_violation then
        v_left := v_left + 1;
      end;
    end;
  end loop;
  v_moved := v_moved || jsonb_build_object('people', v_n)
                      || jsonb_build_object('people_stranded', v_left);

  -- THE LOSER'S OWN IDENTITY BECOMES A PERSON ON THE WINNER. Without this the merge does the
  -- thing it is supposed to prevent: the second name, the second number and the second email
  -- disappear behind the tombstone, and the record that survives can no longer be found by
  -- the channel half the customer's history arrived on.
  --
  -- ONLY THE CHANNELS THAT GENUINELY CONFLICT come here — the same test 191 applies, and for
  -- the same reason. A channel the winner is MISSING is picked up by the enrichment below and
  -- lands on the parent row where every reader in the product already looks; recording it
  -- here as well would store the customer's only phone number twice and leave a person row
  -- that is a copy of the record it hangs off.
  v_phone_conflict := coalesce(v_lose.phone_digits, '') <> ''
                      and coalesce(v_win.phone_digits, '') <> ''
                      and v_lose.phone_digits <> v_win.phone_digits;
  v_email_conflict := coalesce(v_lose.email_lower, '') <> ''
                      and coalesce(v_win.email_lower, '') <> ''
                      and v_lose.email_lower <> v_win.email_lower;
  v_name_conflict  := coalesce(btrim(coalesce(v_lose.name, '')), '') <> ''
                      and coalesce(btrim(coalesce(v_win.name, '')), '') <> ''
                      and lower(btrim(v_lose.name)) <> lower(btrim(v_win.name));

  if v_phone_conflict or v_email_conflict or v_name_conflict then
    begin
      insert into public.crm_contact_people
        (client_id, contact_id, ordinal, name, phone, email, source)
      values (p_client_id, p_winner,
              coalesce((select max(p.ordinal) from public.crm_contact_people p
                         where p.contact_id = p_winner), 1) + 1,
              nullif(btrim(coalesce(v_lose.name, '')), ''),
              case when v_phone_conflict then v_lose.phone else null end,
              case when v_email_conflict then v_lose.email else null end,
              'merge');
    exception when unique_violation then
      null;   -- already recorded on the winner; see 190 PART 2
    end;
  end if;

  -- ── ENRICH THE WINNER, NEVER BLANK IT ──────────────────────────────────────────────────
  -- The winner is the record the human chose to keep, so its stored values win every contest.
  -- The loser only fills gaps. This is 130's rule applied to a merge, and it is also the only
  -- shape that makes the operation safe to describe in one sentence to a builder: "nothing
  -- you can see on the record you kept will change".
  v_name   := coalesce(v_win.name,   nullif(btrim(coalesce(v_lose.name, '')), ''));
  v_phone  := coalesce(v_win.phone,  v_lose.phone);
  v_email  := coalesce(v_win.email,  v_lose.email);
  v_street := coalesce(v_win.street, v_lose.street);
  v_city   := coalesce(v_win.city,   v_lose.city);
  v_state  := coalesce(v_win.state,  v_lose.state);
  v_zip    := coalesce(v_win.zip,    v_lose.zip);
  v_bstreet := coalesce(v_win.billing_street, v_lose.billing_street);
  v_bcity   := coalesce(v_win.billing_city,   v_lose.billing_city);
  v_bstate  := coalesce(v_win.billing_state,  v_lose.billing_state);
  v_bzip    := coalesce(v_win.billing_zip,    v_lose.billing_zip);
  v_owner   := coalesce(v_win.owner_user_id,  v_lose.owner_user_id);

  update public.crm_contacts
     set name = v_name,
         phone = v_phone,
         phone_digits = public.crm_phone_key(v_phone),
         email = v_email,
         street = v_street, city = v_city, state = v_state, zip = v_zip,
         billing_street = v_bstreet, billing_city = v_bcity,
         billing_state = v_bstate, billing_zip = v_bzip,
         owner_user_id = v_owner,
         -- Labels are a set, so a union is the only answer that loses nothing. Nothing reads
         -- them yet (130 shipped the column with the owner); a merge that silently halved
         -- them the day something does would be very hard to notice.
         labels = (select coalesce(array_agg(distinct l), '{}'::text[])
                     from unnest(coalesce(v_win.labels, '{}'::text[])
                              || coalesce(v_lose.labels, '{}'::text[])) as l),
         -- The record is as old as the earlier of the two sightings. first_seen_at drives
         -- "how long have we known this person", and taking the winner's would make a
         -- long-standing customer look new.
         first_seen_at = least(v_win.first_seen_at, v_lose.first_seen_at),
         updated_at = now()
   where id = p_winner and client_id = p_client_id;

  -- ── THE CHANGELOG ──────────────────────────────────────────────────────────────────────
  -- One row naming what was folded in, plus a row per field the merge actually filled. Both
  -- go on the WINNER and both are written BEFORE the loser's history is re-pointed, so they
  -- cannot be swept along by the update below and end up duplicated or misdated.
  v_label := coalesce(nullif(btrim(coalesce(v_lose.name, '')), ''),
                      v_lose.phone, v_lose.email, p_loser::text);
  insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
  values (p_client_id, p_winner, 'merged_from', v_label, p_loser::text, p_actor);

  if v_name  is distinct from v_win.name then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_winner, 'name', v_win.name, v_name, p_actor);
  end if;
  if v_phone is distinct from v_win.phone then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_winner, 'phone', v_win.phone, v_phone, p_actor);
  end if;
  if v_email is distinct from v_win.email then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_winner, 'email', v_win.email, v_email, p_actor);
  end if;
  if v_owner is distinct from v_win.owner_user_id then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_winner, 'owner', v_win.owner_user_id::text, v_owner::text, p_actor);
  end if;

  -- ⚠️ crm_field_changes IS RE-POINTED LAST, and it is the one table where the order is
  -- forced rather than chosen. Two reasons, and they point the same way:
  --   * its contact_id is NOT NULL and ON DELETE CASCADE (143). That cascade is exactly why
  --     this whole function sets merged_into instead of deleting the loser: a hard delete
  --     would take the loser's entire changelog with it — and crm_files' rows too, which
  --     carry the customer's own uploads — silently, as a side effect, with no row anywhere
  --     saying it happened. The tombstone is what keeps the audit trail alive, so it is not
  --     a nicety of 130's design, it is load-bearing here.
  --   * doing it before the inserts above would sweep this merge's own audit rows along with
  --     the history it is describing.
  update public.crm_field_changes set contact_id = p_winner
   where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('field_changes', v_n);

  return jsonb_build_object(
    'ok', true, 'winner', p_winner, 'loser', p_loser,
    'label', v_label, 'moved', v_moved);
end
$fn$;

comment on function public.crm_merge_contacts(text, uuid, uuid, uuid) is
  'Fold one contact into another: sets crm_contacts.merged_into on the loser (never deletes it) and '
  're-points designs, captured_leads, crm_notes, crm_activities, crm_files, sms_messages, '
  'phone_calls, email_inbound, email_sends, crm_contact_people, crm_contact_followers and '
  'crm_field_changes onto the winner. The winner''s own values always survive; the loser only '
  'fills gaps. Migration 192; phone_calls added by 254.';

revoke execute on function public.crm_merge_contacts(text, uuid, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.crm_merge_contacts(text, uuid, uuid, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 10 — apply-time assertions. Each RAISE aborts the transaction.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_tbl  text;
  v_role text;
  v_priv text;
  v_fn   text;
  v_src  text;
begin
  -- ── The phone presets, every title, spelled out (preflight does not check LEVELS) ──
  if public.area_level_for('owner','owner','{}'::jsonb,'phone')           <> 'edit' then raise exception '254: owner phone'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'phone')           <> 'edit' then raise exception '254: admin phone'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'phone')     <> 'view' then raise exception '254: office_staff phone'; end if;
  if public.area_level_for('user','sales_manager','{}'::jsonb,'phone')    <> 'view' then raise exception '254: sales_manager phone'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'phone')        <> 'own'  then raise exception '254: sales_rep phone'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'phone')           <> 'own'  then raise exception '254: dealer phone'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'phone')        <> 'none' then raise exception '254: scheduler phone'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'phone')      <> 'none' then raise exception '254: crew_leader phone'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'phone')      <> 'none' then raise exception '254: crew_member phone'; end if;
  if public.area_level_for('user','driver','{}'::jsonb,'phone')           <> 'none' then raise exception '254: driver phone'; end if;
  -- normTitle's fallback: a NULL or unknown title is a sales_rep, here as everywhere.
  if public.area_level_for('user',null,null,'phone')                      <> 'own'  then raise exception '254: null title phone'; end if;

  -- OWNERS ARE ABSOLUTE, even against a hostile stored map.
  if public.area_level_for('owner','owner','{"phone":"none"}'::jsonb,'phone') <> 'edit' then
    raise exception '254: a stored override narrowed an owner''s phone';
  end if;

  -- Overrides layer on top, in both directions, and only inside the vocabulary.
  if public.area_level_for('user','crew_leader','{"phone":"own"}'::jsonb,'phone')  <> 'own'  then raise exception '254: phone override (grant own)'; end if;
  if public.area_level_for('user','driver','{"phone":"view"}'::jsonb,'phone')      <> 'view' then raise exception '254: phone override (grant view)'; end if;
  if public.area_level_for('user','sales_rep','{"phone":"none"}'::jsonb,'phone')   <> 'none' then raise exception '254: phone override (take away)'; end if;
  if public.area_level_for('user','dealer','{"phone":"approve"}'::jsonb,'phone')   <> 'own'  then raise exception '254: an out-of-vocabulary phone level was accepted'; end if;

  -- THE LITERAL TEAM CHECK. Rank puts own == view; this must not.
  if not public.phone_own_only('own')  then raise exception '254: phone_own_only(own) is false'; end if;
  if not public.phone_own_only('none') then raise exception '254: phone_own_only(none) must fail closed'; end if;
  if not public.phone_own_only(null)   then raise exception '254: phone_own_only(null) must fail closed'; end if;
  if not public.phone_own_only('edit ') then raise exception '254: phone_own_only must compare literally'; end if;
  if public.phone_own_only('view')     then raise exception '254: phone_own_only(view) is true'; end if;
  if public.phone_own_only('edit')     then raise exception '254: phone_own_only(edit) is true'; end if;

  -- ── NOTHING ELSE MOVED. 219's cells, re-asserted: this is a whole-function replace. ──
  if public.area_level_for('user','office_staff','{}'::jsonb,'designer')            <> 'edit' then raise exception '254: office_staff designer'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'designs')             <> 'edit' then raise exception '254: office_staff designs'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'contacts')            <> 'edit' then raise exception '254: office_staff contacts'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'inventory')           <> 'edit' then raise exception '254: office_staff inventory'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'orders')              <> 'edit' then raise exception '254: office_staff orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'change_orders')       <> 'edit' then raise exception '254: office_staff change_orders'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_branding')   <> 'edit' then raise exception '254: office_staff branding'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'settings_quickbooks') <> 'edit' then raise exception '254: office_staff quickbooks'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'build_schedule')      <> 'view' then raise exception '254: office_staff build_schedule'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'reports')             <> 'view' then raise exception '254: office_staff reports'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'commissions')         <> 'none' then raise exception '254: office_staff commissions'; end if;
  if public.area_level_for('owner','owner','{}'::jsonb,'settings_billing')            <> 'edit' then raise exception '254: owner regression'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'settings_billing')            <> 'none' then raise exception '254: admin regression'; end if;
  if public.area_level_for('admin','admin','{"settings_billing":"edit"}'::jsonb,'settings_billing') <> 'edit' then raise exception '254: admin billing grant regression'; end if;
  if public.area_level_for('user','admin','{"settings_team":"none"}'::jsonb,'settings_team') <> 'edit' then raise exception '254: settings_team became grantable'; end if;
  if public.area_level_for('admin','admin','{}'::jsonb,'change_order_approve')        <> 'edit' then raise exception '254: change_order_approve lost'; end if;
  if public.area_level_for('user','crew_leader','{"change_order_approve":"edit"}'::jsonb,'change_order_approve') <> 'edit' then raise exception '254: change_order_approve area lost from k_areas'; end if;
  if public.area_level_for('user','sales_manager','{}'::jsonb,'commissions')          <> 'edit' then raise exception '254: sales_manager regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'commissions')              <> 'own'  then raise exception '254: sales_rep regression'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'orders')                   <> 'edit' then raise exception '254: sales_rep orders regression'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'contacts')                    <> 'own'  then raise exception '254: dealer regression'; end if;
  if public.area_level_for('user','dealer','{}'::jsonb,'designer')                    <> 'edit' then raise exception '254: dealer designer regression'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'delivery_schedule')        <> 'edit' then raise exception '254: scheduler regression'; end if;
  if public.area_level_for('user','scheduler','{}'::jsonb,'designer')                 <> 'none' then raise exception '254: scheduler gained designer'; end if;
  if public.area_level_for('user','crew_leader','{}'::jsonb,'repairs')                <> 'edit' then raise exception '254: crew_leader regression'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'build_schedule')         <> 'view' then raise exception '254: crew_member regression'; end if;
  if public.area_level_for('user','crew_member','{}'::jsonb,'designer')               <> 'none' then raise exception '254: crew_member gained designer'; end if;
  if public.area_level_for('user','driver','{}'::jsonb,'delivery_schedule')           <> 'edit' then raise exception '254: driver regression'; end if;
  if public.area_level_for('user','nonsense','{}'::jsonb,'commissions')               <> 'own'  then raise exception '254: normTitle fallback'; end if;
  if public.area_level_for('user','office_staff','{}'::jsonb,'no_such_area')          <> 'none' then raise exception '254: unknown area'; end if;
  if public.area_level_for('user','sales_rep','{}'::jsonb,'projects')                 <> 'none' then raise exception '254: projects leaked to a preset'; end if;

  -- ── The grant posture. The trap is silent, so it is checked, not assumed. ──
  foreach v_tbl in array array['phone_routes','phone_user_settings','phone_calls',
                               'phone_call_events','phone_voicemails','phone_devices'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c
             where c.oid = ('public.' || v_tbl)::regclass) then
      raise exception '254: RLS is not enabled on %', v_tbl;
    end if;
    if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = ('public.' || v_tbl)::regclass) then
      raise exception '254: % has a policy; it is meant to be service-role only', v_tbl;
    end if;
    foreach v_role in array array['anon','authenticated'] loop
      foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(v_role, 'public.' || v_tbl, v_priv) then
          raise exception '254: % holds % on % — the default-privilege trap is open', v_role, v_priv, v_tbl;
        end if;
      end loop;
    end loop;
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role', 'public.' || v_tbl, v_priv) then
        raise exception '254: service_role lacks % on % — the Worker could not write it', v_priv, v_tbl;
      end if;
    end loop;
  end loop;

  foreach v_fn in array array['public.phone_route_for_number(text)',
                              'public.phone_caller_context(uuid)',
                              'public.phone_realtime_notify()'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '254: % is callable from the browser', v_fn;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.phone_route_for_number(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.phone_caller_context(uuid)', 'EXECUTE') then
    raise exception '254: service_role cannot call the Worker RPCs';
  end if;
  if has_function_privilege('anon', 'public.phone_own_only(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.phone_own_only(text)', 'EXECUTE') then
    raise exception '254: phone_own_only must be callable by authenticated (the realtime policy) and not by anon';
  end if;

  -- ── The triggers exist and are enabled ──
  if (select count(*) from pg_catalog.pg_trigger t
       where not t.tgisinternal and t.tgenabled = 'O'
         and t.tgfoid = 'public.phone_realtime_notify()'::regprocedure
         and t.tgrelid in ('public.phone_calls'::regclass, 'public.phone_voicemails'::regclass,
                           'public.sms_messages'::regclass)) <> 3 then
    raise exception '254: the three broadcast triggers are not all in place';
  end if;

  -- ── The four realtime policies landed as written: permissive, authenticated only ──
  if (select count(*) from pg_catalog.pg_policies p
       where p.schemaname = 'realtime' and p.tablename = 'messages'
         and p.policyname in ('phone_user_topic_read','phone_team_topic_read',
                              'phone_presence_read','phone_presence_track')
         and p.permissive = 'PERMISSIVE'
         and p.roles = array['authenticated']::name[]) <> 4 then
    raise exception '254: the realtime.messages policies are missing or not permissive/authenticated';
  end if;

  -- ── The meters exist and are OFF ──
  if (select count(*) from public.usage_prices
       where kind in ('phone_line_monthly','voice_minute','voicemail_transcription')) <> 3 then
    raise exception '254: a phone meter row is missing';
  end if;
  if exists (select 1 from public.usage_prices
              where kind in ('phone_line_monthly','voice_minute','voicemail_transcription')
                and active) then
    raise exception '254: a phone meter is ARMED — they must ship off (169''s rail)';
  end if;

  -- ── The RPCs answer NULL for strangers ──
  if public.phone_caller_context(gen_random_uuid()) is not null then
    raise exception '254: phone_caller_context answered for a user on no team';
  end if;
  if public.phone_route_for_number('+15555550199') is not null then
    raise exception '254: phone_route_for_number answered for a number that is not ours';
  end if;

  -- ── PART 6B and 9B: three service-role functions, the definer ones checked as such ──
  foreach v_fn in array array['public.phone_end_user_sessions(uuid)',
                              'public.crm_create_contact(text,text,text,uuid,uuid,text)',
                              'public.crm_merge_contacts(text,uuid,uuid,uuid)'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '254: % is callable from the browser', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '254: service_role cannot call %', v_fn;
    end if;
    if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception '254: % must be SECURITY DEFINER', v_fn;
    end if;
  end loop;
  -- Harmless on the live project: a fresh uuid has no sessions, so nothing is deleted.
  if public.phone_end_user_sessions(gen_random_uuid()) <> 0
     or public.phone_end_user_sessions(null) <> 0 then
    raise exception '254: phone_end_user_sessions ended sessions for nobody';
  end if;

  -- ── crm_merge_contacts carries phone_calls now, and lost none of 192's eleven tables ──
  select p.prosrc into v_src from pg_catalog.pg_proc p
   where p.oid = 'public.crm_merge_contacts(text,uuid,uuid,uuid)'::regprocedure;
  foreach v_tbl in array array['designs','captured_leads','crm_notes','crm_activities','crm_files',
                               'sms_messages','phone_calls','email_inbound','email_sends',
                               'crm_contact_followers','crm_contact_people','crm_field_changes'] loop
    if position(('update public.' || v_tbl) in v_src) = 0 then
      raise exception '254: crm_merge_contacts no longer re-points %', v_tbl;
    end if;
  end loop;
  if position('jsonb_build_object(''calls'', v_n)' in v_src) = 0 then
    raise exception '254: crm_merge_contacts does not report the calls it moved';
  end if;

  -- ── "Save as contact" may write source 'phone', and the old four still hold ──
  select pg_get_constraintdef(c.oid) into v_src from pg_catalog.pg_constraint c
   where c.conrelid = 'public.crm_contacts'::regclass and c.conname = 'crm_contacts_source_check';
  if v_src is null
     or position('''phone''' in v_src) = 0 or position('''design''' in v_src) = 0
     or position('''captured_lead''' in v_src) = 0 or position('''manual''' in v_src) = 0
     or position('''import''' in v_src) = 0 then
    raise exception '254: crm_contacts_source_check is %', coalesce(v_src, 'missing');
  end if;
end
$assert$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 11 — behavioural probe. Synthetic tenant, rolled back, leaves nothing.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 219_build_board_change_flag's pattern: exercise the branches that matter, then raise
-- ROLLBACK_PROBE so the inner block's writes (and any realtime.messages rows, which Realtime
-- only streams once COMMITTED) vanish. The synthetic tenant and numbers are obviously fake;
-- the one real row it reads is a client_users row for the read-only context check.
do $probe$
declare
  k_cid     constant text := 'sss-phone-probe';
  k_num     constant text := '+15555550199';
  k_cust    constant text := '+15555550142';
  v_num_id  uuid;
  u1        uuid := gen_random_uuid();
  u2        uuid := gen_random_uuid();
  v         jsonb;
  m         jsonb;
  v_real    public.client_users%rowtype;
  v_ctx     jsonb;
  v_parts   int;
  v_count   int;
  v_keys    text[];
  k_unknown constant text := '+15555550143';
  v_call    uuid;
  v_c1      uuid;
  v_c2      uuid;
  v_res     jsonb;
begin
  -- ── Read-only: phone_caller_context on one real team member ──
  select cu.* into v_real from public.client_users cu order by cu.created_at limit 1;
  if v_real.user_id is not null then
    v_ctx := public.phone_caller_context(v_real.user_id);
    if v_ctx is null then
      raise exception '254 probe: phone_caller_context returned NULL for a real team member';
    end if;
    select array_agg(k order by k) into v_keys from jsonb_object_keys(v_ctx) as k;
    if v_keys <> array['client_id','contacts_level','device_generation','full_name','number',
                       'own_contacts_only','phone_level','phone_status'] then
      raise exception '254 probe: phone_caller_context keys are %', v_keys;
    end if;
    if v_ctx ->> 'client_id' <> v_real.client_id
       or v_ctx ->> 'phone_level' <> public.area_level_for(v_real.role, v_real.title, v_real.access, 'phone')
       or (v_ctx ->> 'own_contacts_only')::boolean
            <> (public.area_level_for(v_real.role, v_real.title, v_real.access, 'contacts') = 'own') then
      raise exception '254 probe: phone_caller_context disagrees with area_level_for';
    end if;
    if jsonb_typeof(v_ctx -> 'number') not in ('null', 'object') then
      raise exception '254 probe: number is neither null nor an object';
    end if;
  end if;

  begin
    -- ── A synthetic tenant with the phone switched on ──
    insert into public.client_settings (client_id, phone_status, business_name)
    values (k_cid, 'on', 'Probe Sheds');
    insert into public.sms_numbers (client_id, phone_number, registration_status)
    values (k_cid, k_num, 'registered')
    returning id into v_num_id;

    -- u1 is listed first AND repeated: first position must win. v_real is a member from
    -- ANOTHER tenant, which must never read as having access to this number.
    insert into public.phone_routes (client_id, number_id, members)
    values (k_cid, v_num_id, array[u1, u2, u1] || coalesce(v_real.user_id, gen_random_uuid()));
    -- u1: a DND that ran out a minute ago, generation 3, forwarding to a cell.
    insert into public.phone_user_settings (user_id, client_id, dnd, dnd_until, forward_to_cell, device_generation)
    values (u1, k_cid, true, now() - interval '1 minute', '+15555550123', 3);
    -- u2: DND with no end.
    insert into public.phone_user_settings (user_id, client_id, dnd)
    values (u2, k_cid, true);

    v := public.phone_route_for_number(k_num);
    select array_agg(k order by k) into v_keys from jsonb_object_keys(v) as k;
    if v_keys <> array['business_name','client_id','members','number_id','phone_status',
                       'recent_emergency_user','route'] then
      raise exception '254 probe: phone_route_for_number keys are %', v_keys;
    end if;
    if v ->> 'client_id' <> k_cid or (v ->> 'number_id')::uuid <> v_num_id
       or v ->> 'phone_status' <> 'on' or v ->> 'business_name' <> 'Probe Sheds'
       or v -> 'route' ->> 'mode' <> 'all_at_once' or (v -> 'route' ->> 'ring_seconds')::int <> 20
       or jsonb_typeof(v -> 'recent_emergency_user') <> 'null' then
      raise exception '254 probe: route header is wrong: %', v - 'members';
    end if;
    if jsonb_array_length(v -> 'members') <> 3 then
      raise exception '254 probe: expected 3 members after collapsing the repeat, got %', jsonb_array_length(v -> 'members');
    end if;

    m := v -> 'members' -> 0;
    select array_agg(k order by k) into v_keys from jsonb_object_keys(m) as k;
    if v_keys <> array['busy','dnd','forward_to_cell','full_name','has_access','identity','user_id'] then
      raise exception '254 probe: member keys are %', v_keys;
    end if;
    if (m ->> 'user_id')::uuid <> u1 then raise exception '254 probe: member order lost'; end if;
    if m ->> 'identity' <> 'u_' || replace(u1::text, '-', '') || '_g3' then
      raise exception '254 probe: identity is %', m ->> 'identity';
    end if;
    if m ->> 'identity' !~ '^u_[0-9a-f]{32}_g[0-9]+$' then
      raise exception '254 probe: identity does not match the SPEC pattern';
    end if;
    if (m ->> 'dnd')::boolean then raise exception '254 probe: a DND that ran out still counts'; end if;
    if (m ->> 'busy')::boolean then raise exception '254 probe: an idle member is busy'; end if;
    if (m ->> 'has_access')::boolean then raise exception '254 probe: a stranger has access'; end if;
    if m ->> 'forward_to_cell' <> '+15555550123' then raise exception '254 probe: forward_to_cell lost'; end if;

    m := v -> 'members' -> 1;
    if (m ->> 'user_id')::uuid <> u2 then raise exception '254 probe: second member out of order'; end if;
    if not (m ->> 'dnd')::boolean then raise exception '254 probe: an open-ended DND was ignored'; end if;
    if m ->> 'identity' not like '%\_g1' then raise exception '254 probe: default generation is not 1'; end if;

    m := v -> 'members' -> 2;
    if (m ->> 'has_access')::boolean then
      raise exception '254 probe: a member of ANOTHER tenant has access to this number';
    end if;

    -- ── busy, and the staleness bound (DEVIATION 2) ──
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status)
    values (k_cid, v_num_id, 'out', k_num, k_cust, u2, 'in_progress');
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status, started_at)
    values (k_cid, v_num_id, 'out', k_num, k_cust, u1, 'ringing', now() - interval '1 hour');
    v := public.phone_route_for_number(k_num);
    if not (v -> 'members' -> 1 ->> 'busy')::boolean then
      raise exception '254 probe: a member on a live call is not busy';
    end if;
    if (v -> 'members' -> 0 ->> 'busy')::boolean then
      raise exception '254 probe: an hour-old ringing row (a lost callback) made a member busy';
    end if;

    -- ── the 911 callback window ──
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status, is_emergency, started_at)
    values (k_cid, v_num_id, 'out', k_num, '933', u2, 'completed', true, now() - interval '2 hours');
    v := public.phone_route_for_number(k_num);
    if jsonb_typeof(v -> 'recent_emergency_user') <> 'null' then
      raise exception '254 probe: a 911 call two hours ago still redirects inbound calls';
    end if;
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status, is_emergency, started_at)
    values (k_cid, v_num_id, 'out', k_num, '933', u1, 'completed', true, now() - interval '10 minutes');
    v := public.phone_route_for_number(k_num);
    if (v ->> 'recent_emergency_user')::uuid is distinct from u1 then
      raise exception '254 probe: recent_emergency_user is %, expected the person who dialed', v ->> 'recent_emergency_user';
    end if;

    -- ── the broadcasts ──
    -- Every insert above already fired phone_realtime_notify with the switch on, and each
    -- write SUCCEEDED — which is the property that matters most. Whether the sends landed
    -- is observable only once Realtime has created realtime.messages partitions.
    select count(*) into v_parts from pg_catalog.pg_inherits where inhparent = 'realtime.messages'::regclass;
    if v_parts = 0 then
      raise notice '254 probe: realtime.messages has NO partitions yet, so every broadcast was dropped with a WARNING and every write still succeeded. Live updates start once Supabase Realtime creates its partitions (see the header).';
    else
      select count(*) into v_count from realtime.messages
       where topic = 'phone:' || k_cid and event = 'call' and private;
      if v_count <> 4 then
        raise exception '254 probe: expected 4 private call broadcasts on the team topic, found %', v_count;
      end if;
      -- Every payload is exactly the four keys, and op is TG_OP's spelling (phone-core reads
      -- "INSERT" | "UPDATE" | "DELETE").
      if exists (select 1 from realtime.messages msg
                  where msg.topic = 'phone:' || k_cid
                    and ((select array_agg(k order by k) from jsonb_object_keys(msg.payload) as k)
                           <> array['contact_id','id','op','table']
                         or msg.payload ->> 'op' not in ('INSERT','UPDATE','DELETE')
                         or msg.payload ->> 'table' <> 'phone_calls')) then
        raise exception '254 probe: a broadcast carries more than ids, or the wrong op/table';
      end if;
      if not exists (select 1 from realtime.messages
                      where topic = 'phone:user:' || u2::text and event = 'call') then
        raise exception '254 probe: the caller''s own topic got nothing';
      end if;

      -- A text broadcasts while the switch is on, and nothing once it is off.
      insert into public.sms_messages (client_id, direction, from_number, to_number, body)
      values (k_cid, 'in', k_cust, k_num, 'probe');
      select count(*) into v_count from realtime.messages where topic = 'phone:' || k_cid and event = 'sms';
      if v_count <> 1 then raise exception '254 probe: an inbound text was not broadcast'; end if;
      update public.client_settings set phone_status = 'off' where client_id = k_cid;
      insert into public.sms_messages (client_id, direction, from_number, to_number, body)
      values (k_cid, 'in', k_cust, k_num, 'probe');
      select count(*) into v_count from realtime.messages where topic = 'phone:' || k_cid and event = 'sms';
      if v_count <> 1 then raise exception '254 probe: a text was broadcast for a tenant switched off'; end if;
      raise notice '254 probe: broadcasts landed on the team and user topics, ids only, and stop when the switch is off';
    end if;

    -- Everything below runs AFTER the broadcast counts above, so the rows it writes cannot move
    -- them. (In the partitioned case the switch is off by now; nothing below depends on it.)

    -- ── busy ends when the placer hands the call on (DEVIATION 10) ──
    -- u1 places a live call and transfers it: transferred_from = u1, answered_by cleared while
    -- the teammate rings. u1 is off the call and must be rung again.
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status, transferred_from, transfer_state)
    values (k_cid, v_num_id, 'out', k_num, k_cust, u1, 'in_progress', u1, 'transferring')
    returning id into v_call;
    v := public.phone_route_for_number(k_num);
    if (v -> 'members' -> 0 ->> 'busy')::boolean then
      raise exception '254 probe: a call its placer transferred away still makes them busy';
    end if;
    -- A second hop moves transferred_from to the teammate; the placer stays free.
    update public.phone_calls set transferred_from = u2, answered_by = null where id = v_call;
    v := public.phone_route_for_number(k_num);
    if (v -> 'members' -> 0 ->> 'busy')::boolean then
      raise exception '254 probe: a second transfer made the original placer busy again';
    end if;
    -- The same call, never handed on, does make them busy: the fix narrowed, it did not blind.
    update public.phone_calls set transferred_from = null, transfer_state = null where id = v_call;
    v := public.phone_route_for_number(k_num);
    if not (v -> 'members' -> 0 ->> 'busy')::boolean then
      raise exception '254 probe: a placed call nobody transferred no longer makes its placer busy';
    end if;

    -- ── DEVIATION 13: a WARM transfer keeps the person who handed it on busy while the call is
    --    in its conference (they may still be in it, consulting), and frees them after ──
    update public.phone_calls set status = 'completed' where id = v_call;   -- u1's own call ends
    v := public.phone_route_for_number(k_num);
    if (v -> 'members' -> 0 ->> 'busy')::boolean then
      raise exception '254 probe: a completed call still makes its placer busy';
    end if;
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, status, answered_by, transferred_from, transfer_state)
    values (k_cid, v_num_id, 'in', k_cust, k_num, 'in_progress', u2, u1, 'conference')
    returning id into v_call;
    v := public.phone_route_for_number(k_num);
    if not (v -> 'members' -> 0 ->> 'busy')::boolean then
      raise exception '254 probe: the person consulting in a warm transfer was reported free';
    end if;
    update public.phone_calls set transfer_state = null where id = v_call;
    v := public.phone_route_for_number(k_num);
    if (v -> 'members' -> 0 ->> 'busy')::boolean then
      raise exception '254 probe: a warm transfer that left its conference still makes the person who handed it on busy';
    end if;

    -- ── "Save as contact" re-links the number's history ──
    -- An unknown caller rang in and was called back, and texted, before anybody saved them. A
    -- second unknown number and a row already on a contact must not move.
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, status)
    values (k_cid, v_num_id, 'in', k_unknown, k_num, 'missed');
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, placed_by, status)
    values (k_cid, v_num_id, 'out', k_num, k_unknown, u1, 'completed');
    insert into public.phone_calls (client_id, number_id, direction, from_e164, to_e164, status)
    values (k_cid, v_num_id, 'in', '+15555550144', k_num, 'missed');
    insert into public.sms_messages (client_id, direction, from_number, to_number, body)
    values (k_cid, 'in', k_unknown, k_num, 'probe');

    v_res := public.crm_create_contact(k_cid, '  Probe Customer ', '(555) 555-0143', null, null, 'phone');
    v_c1 := (v_res ->> 'id')::uuid;
    if v_c1 is null
       or (v_res -> 'relinked' ->> 'calls')::int <> 2
       or (v_res -> 'relinked' ->> 'sms')::int <> 1 then
      raise exception '254 probe: crm_create_contact answered %', v_res;
    end if;
    if not exists (select 1 from public.crm_contacts c
                    where c.id = v_c1 and c.client_id = k_cid and c.source = 'phone'
                      and c.name = 'Probe Customer' and c.phone_digits = '5555550143'
                      and c.owner_user_id is null and c.merged_into is null) then
      raise exception '254 probe: the saved contact is not the row asked for';
    end if;
    if exists (select 1 from public.phone_calls c
                where c.client_id = k_cid and c.contact_id is null
                  and k_unknown in (c.from_e164, c.to_e164)) then
      raise exception '254 probe: a call from the saved number was left unlinked';
    end if;
    if (select count(*) from public.phone_calls c
         where c.client_id = k_cid and c.contact_id is null and c.from_e164 = '+15555550144') <> 1 then
      raise exception '254 probe: a call from ANOTHER number was re-linked';
    end if;
    if exists (select 1 from public.sms_messages s
                where s.client_id = k_cid and s.from_number = k_unknown and s.contact_id is distinct from v_c1) then
      raise exception '254 probe: a text from the saved number was left unlinked';
    end if;

    -- The same number twice is refused by the tenant index, as a 23505 portal-settings words.
    begin
      perform public.crm_create_contact(k_cid, 'Again', '+1 555 555 0143');
      raise exception '254 probe: one number was saved as two contacts';
    exception when unique_violation then
      null;
    end;
    -- An owner from no team, and a number with no digits, are refused.
    begin
      perform public.crm_create_contact(k_cid, 'Probe Two', '+15555550145', gen_random_uuid());
      raise exception '254 probe: an owner from no team was accepted';
    exception when foreign_key_violation then
      null;
    end;
    begin
      perform public.crm_create_contact(k_cid, 'Probe Three', 'Anonymous');
      raise exception '254 probe: a contact with no phone number was saved';
    exception when check_violation then
      null;
    end;

    -- ── a merge carries the loser's calls (the tenth table) ──
    insert into public.crm_contacts (client_id, name, phone, phone_digits, source)
    values (k_cid, 'Probe Duplicate', '+15555550146', '5555550146', 'manual')
    returning id into v_c2;
    insert into public.phone_calls (client_id, number_id, contact_id, direction, from_e164, to_e164, status)
    values (k_cid, v_num_id, v_c2, 'in', '+15555550146', k_num, 'completed')
    returning id into v_call;
    v_res := public.crm_merge_contacts(k_cid, v_c1, v_c2, null);
    if (v_res -> 'moved' ->> 'calls')::int is distinct from 1
       or (select c.contact_id from public.phone_calls c where c.id = v_call) is distinct from v_c1 then
      raise exception '254 probe: the merge left the loser''s call behind: %', v_res -> 'moved';
    end if;
    raise notice '254 probe: a transferred call frees its placer; Save as contact re-links the number''s calls and texts and refuses a duplicate; a merge carries calls';

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '254 probe: routing, identity, DND, busy, has_access and the 911 window behave; nothing was kept';
      else
        raise;
      end if;
  end;
end
$probe$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — verification (run by hand; every write is inside a rolled-back block)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Realtime can deliver at all (see the header): partitions > 0.
--      select count(*) from pg_inherits where inhparent = 'realtime.messages'::regclass;
--
-- B. The policies as a real user. Substitute a team member's user id:
--      begin;
--        select set_config('request.jwt.claims',
--                          json_build_object('sub','<user uuid>','role','authenticated')::text, true);
--        set local role authenticated;
--        select public.current_client_id()                                         as tenant,
--               public.current_area_level('phone')                                 as phone,
--               not public.phone_own_only(public.current_area_level('phone'))      as sees_team;
--      rollback;
--    Then from supabase-js signed in as that user:
--      supabase.channel('phone:user:<their id>', {config:{private:true}}).subscribe()  -> SUBSCRIBED
--      supabase.channel('phone:<their client>',  {config:{private:true}}).subscribe()  -> SUBSCRIBED
--                                                      only at phone view/edit, else CHANNEL_ERROR
--      supabase.channel('phone:<another client>',{config:{private:true}}).subscribe()  -> CHANNEL_ERROR
--
-- C. The meters are still off:
--      select kind, price_cents, active from public.usage_prices where kind like 'phone%' or kind like 'voice%';
--
-- D. Nobody is switched on until somebody means it:
--      select client_id from public.client_settings where phone_status = 'on';   -- no rows
--
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- FULL ROLLBACK — in this order. Deploy code that no longer writes the new columns FIRST.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--   begin;
--   -- 0. The CRM half (PART 9B, PART 6B). crm_merge_contacts goes back to 192's body: re-run
--   --    192_crm_merge_contacts.sql's create-or-replace (it drops nothing). Saved-from-phone
--   --    contacts keep existing; relabel them before the old CHECK comes back.
--   drop function if exists public.crm_create_contact(text, text, text, uuid, uuid, text);
--   drop function if exists public.phone_end_user_sessions(uuid);
--   update public.crm_contacts set source = 'manual' where source = 'phone';
--   alter table public.crm_contacts drop constraint if exists crm_contacts_source_check;
--   alter table public.crm_contacts add constraint crm_contacts_source_check
--     check (source in ('design', 'captured_lead', 'manual', 'import'));
--   -- 1. Private-channel access (postgres may drop these through supautils.policy_grants).
--   drop policy if exists phone_user_topic_read on realtime.messages;
--   drop policy if exists phone_team_topic_read on realtime.messages;
--   drop policy if exists phone_presence_read   on realtime.messages;
--   drop policy if exists phone_presence_track  on realtime.messages;
--   -- 2. Broadcasts.
--   drop trigger if exists sms_messages_phone_realtime on public.sms_messages;
--   drop trigger if exists phone_voicemails_realtime   on public.phone_voicemails;
--   drop trigger if exists phone_calls_realtime        on public.phone_calls;
--   drop function if exists public.phone_realtime_notify();
--   -- 3. The RPCs and the team check.
--   drop function if exists public.phone_route_for_number(text);
--   drop function if exists public.phone_caller_context(uuid);
--   drop function if exists public.phone_own_only(text);
--   -- 4. The access area: re-run 219_office_staff_designer.sql's area_level_for definition,
--   --    and remove `phone` from AREAS/PRESETS (and ownPhoneOnly) in _shared/access.ts in the
--   --    SAME commit, then redeploy every importer of access.ts. A stored {"phone": ...}
--   --    override left in client_users.access is harmless: effectiveAccess ignores an
--   --    unknown area and sanitizeAccess drops it on the next save.
--   -- 5. The meters, only if nothing was ever charged against them:
--   delete from public.usage_prices u
--    where u.kind in ('phone_line_monthly','voice_minute','voicemail_transcription')
--      and not exists (select 1 from public.wallet_transactions w where w.meter_kind = u.kind);
--   -- 6. The tables (call history goes with them — export first if any of it matters).
--   drop table if exists public.phone_devices;
--   drop table if exists public.phone_voicemails;
--   drop table if exists public.phone_call_events;
--   drop table if exists public.phone_calls;
--   drop table if exists public.phone_user_settings;
--   drop table if exists public.phone_routes;
--   -- 7. ⚠️ ONLY after sendTenantSms, sms-inbound and the Worker are redeployed without these
--   --    columns — dropping them under live code makes every text send fail.
--   alter table public.sms_messages drop constraint if exists sms_messages_sent_via_chk;
--   alter table public.sms_messages drop column if exists client_temp_id,
--                                   drop column if exists sent_via,
--                                   drop column if exists num_media;
--   alter table public.sms_numbers  drop column if exists voice_enabled,
--                                   drop column if exists voice_configured_at,
--                                   drop column if exists emergency_address_sid;
--   alter table public.client_settings drop constraint if exists client_settings_phone_status_chk;
--   alter table public.client_settings drop column if exists phone_status;
--   commit;
