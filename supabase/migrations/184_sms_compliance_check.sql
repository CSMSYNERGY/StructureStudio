-- 184 — Somewhere to keep the pre-submission compliance check.
--
-- APPLY BY HAND (SQL Editor / MCP execute_sql). NEVER `supabase db push`.
--
-- WHAT THIS IS FOR. Before a builder spends a carrier registration, the portal fetches their
-- privacy policy and terms pages and grades the whole registration — the GoHighLevel A2P screen,
-- but ours. Fetching somebody's website takes seconds and cannot ride the `status` action, which
-- the portal polls every sixty seconds while anything is pending: that would turn every open SMS
-- tab into a crawler pointed at a builder's own site. So the check is an explicit press, and its
-- result is SNAPSHOTTED here, exactly the way `client_settings.email_dns_records` snapshots a
-- domain verification so the screen can paint without a vendor round trip.
--
-- ⚠️ ONLY THE FETCHED ROWS BELONG IN HERE. The checks that are pure functions of data we already
-- hold — is the business name filled in, do the two website fields agree, does a sample contain
-- STOP — are recomputed on every read and never stored. A stale "your business name is missing"
-- sitting on screen after the builder has fixed it is worse than no check at all: it teaches them
-- the card is lying, and then they stop reading the row that actually matters. `compliance_checked_at`
-- therefore means one specific thing and should keep meaning it: WHEN WE LAST FETCHED THEIR PAGES.
--
-- ⚠️ AND IT COULD NOT BORROW A COLUMN. Both existing jsonb columns on this table are spoken for:
-- `last_errors` is Twilio's own errors array off the brand or campaign resource (and is rendered
-- to the builder as the carriers' rejection reasons), and `campaign_message_samples` is the copy.
-- Overloading either would collide with what `advanceOne` and the Event Streams webhook write.
--
-- Rollback:
--   alter table public.sms_registrations
--     drop constraint if exists sms_registrations_compliance_is_array,
--     drop column if exists compliance_checked_at,
--     drop column if exists compliance_result;

alter table public.sms_registrations
  add column if not exists compliance_checked_at timestamptz,
  add column if not exists compliance_result     jsonb not null default '[]'::jsonb;

-- SHAPE ONLY, and for the same reason migration 173's samples constraint is shape only: the
-- verdict vocabulary ("pass" / "warn" / "fail") and the set of rule keys are product decisions
-- that will be corrected as we learn what the carriers actually refuse. Pinning them in a CHECK
-- would mean a migration every time a rule is reworded, and a rule that cannot be reworded
-- quickly is a rule that stays wrong. The database's job here is to guarantee the value is an
-- array so nothing downstream has to guess.
alter table public.sms_registrations
  drop constraint if exists sms_registrations_compliance_is_array;
alter table public.sms_registrations
  add constraint sms_registrations_compliance_is_array
  check (jsonb_typeof(compliance_result) = 'array');
