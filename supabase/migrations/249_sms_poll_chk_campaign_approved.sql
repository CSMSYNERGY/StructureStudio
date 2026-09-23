-- 249_sms_poll_chk_campaign_approved.sql — an approved campaign may stop polling.
--
-- ── THE BUG ──────────────────────────────────────────────────────────────────────────────
-- sms_registrations_poll_chk (165) says a row must carry a next_poll_at unless its status is
-- one that nothing polls. Its exempt list left out 'campaign_approved', and that state is
-- exactly one that nothing polls: the carriers are done, and the next step is the builder
-- picking a number (portal-sms advanceOne: "Waiting for the builder to pick a number. Nothing
-- to poll."). BOTH writers of the state — twilio-events on the campaign-approved event, and
-- the portal-sms lazy sweep on campaign_pending — set status='campaign_approved' together with
-- next_poll_at = null, so every write of it failed with 23514 and neither writer read the error.
--
-- It had never run before. The first campaign-approved event this project received was
-- structure-studio's, 2026-09-22 20:56:07 UTC (sms_registration_events 5951b33f, campaignsid
-- matching the row's campaign_cm_sid). Postgres logged the refusal 0.4s later:
--   new row for relation "sms_registrations" violates check constraint "sms_registrations_poll_chk"
-- The whole patch was lost with it, campaign_status included, so the row still reads
-- campaign_pending / PENDING with an overdue next_poll_at, and the SMS page keeps showing
-- "carriers reviewing" over an approved campaign. The number picker only renders at
-- campaign_approved, so the builder had no way forward.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────────────────
-- The same constraint with 'campaign_approved' added to the exempt list. Everything else is
-- identical to the live definition (read with pg_get_constraintdef on 2026-09-23 before this
-- was written). It only LOOSENS the check, so every existing row passes it; live rows at the
-- time were one campaign_pending (next_poll_at set) and three 'none'.
--
-- Recovery needs no deploy. Once this is live, the next Settings > SMS status load for
-- structure-studio runs the lazy sweep (campaign_pending, next_poll_at overdue), re-reads the
-- approved campaign from Twilio and writes campaign_approved. The edge changes in the same
-- commit only make a failure of that write visible (app_errors, sms_registration_update_failed).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, and neither frontend reads the constraint. No code
-- ever wrote campaign_approved successfully, so no code depends on it being refused.
--
-- NOT APPLIED when written. Apply only with Ahsan's go-ahead, from Git Bash, as ONE inline
-- transaction that starts at SQL (a leading "--" line is read as a CLI flag), never
-- `supabase db push` and never from PowerShell 5.1:
--   supabase db query --linked "begin; alter table public.sms_registrations drop constraint
--     sms_registrations_poll_chk, add constraint sms_registrations_poll_chk check (…);
--     insert into supabase_migrations.schema_migrations (version, name)
--     values ('249', '249_sms_poll_chk_campaign_approved') returning version, name; commit;"
-- Exit codes prove nothing, so read it back:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.sms_registrations'::regclass and conname = 'sms_registrations_poll_chk';
--   → the list includes 'campaign_approved'.
--
-- Rollback (fails, correctly, once any row sits at campaign_approved with no next_poll_at —
-- move those rows first or leave this in place):
--   alter table public.sms_registrations drop constraint sms_registrations_poll_chk,
--     add constraint sms_registrations_poll_chk check (
--       status in ('none','intake','aup_pending','ready','brand_failed','campaign_failed',
--                  'number_pending','active','paused','off')
--       or next_poll_at is not null);

begin;

-- One statement, so there is no moment with the check missing.
alter table public.sms_registrations
  drop constraint if exists sms_registrations_poll_chk,
  add constraint sms_registrations_poll_chk check (
    status in ('none','intake','aup_pending','ready','brand_failed','campaign_failed',
               -- 249: approved by the carriers, waiting on the builder to pick a number
               'campaign_approved',
               'number_pending','active','paused','off')
    or next_poll_at is not null
  );

commit;
