-- 173 — The campaign copy the carriers read, persisted.
--
-- APPLY BY HAND (SQL Editor / MCP execute_sql). NEVER `supabase db push`.
--
-- THE BUG THIS FIXES. advanceOne's `ready` branch reads only p.intake; `p.copy` is accepted
-- from the browser, passed through, and DROPPED. There are no columns for it anywhere, so the
-- paragraphs a builder types at step 3 are gone the instant the page reloads.
--
-- That is not a tidiness problem, it is a wall. The step-3 form only renders at
-- status='ready' (portal/11-sms.jsx), and the carriers take DAYS to answer — so by the time a
-- builder reaches the brand_approved card, a reload has certainly happened and the React state
-- behind it is back to {description:"", messageFlow:"", messageSamples:["",""]}. That card has
-- no input fields; it just posts whatever `copy` currently holds. It therefore posts two empty
-- strings into the `samples.length < 2` check in portal-sms and gets a 400, with NO FORM ON
-- SCREEN to fix it. Deterministic, and unescapable from the UI.
--
-- Live proof it is not theoretical: the first real registration (structure-studio, 2026-08-31)
-- was submitted with messageFlow EMPTY and BOTH sample messages EMPTY — the builder had only
-- filled the use-case sentence, and even that carried a typo ("...their quotes in out portal").
-- The screen told her "Everything is filled in." An empty MessageFlow is a documented TCR
-- rejection cause, so that registration was going to be refused by the carriers on content
-- even after the state machine was unstuck.
--
-- ⚠️ NAMED COLUMNS, NOT ONE jsonb BLOB, and the reason is operational rather than aesthetic.
-- The Usa2p campaign resource has NO UPDATE OPERATION (see createCampaign in
-- _shared/twilioTrustHub.ts): remediating a carrier rejection means a human retyping this text
-- into the Twilio console. Our stored copy is the ONLY source for that retyping, so it has to
-- be something an operator can select column by column at 2am, not a blob to spelunk. The
-- samples array genuinely varies in length (2–5), so that one stays jsonb.
--
-- ⚠️ THIS IS NOT THE PII THAT 165's HEADER FORBIDS. The EIN, the rep's mobile and the street
-- address stay at Twilio behind SIDs and are deliberately absent from this table. What lands
-- here is marketing copy the carriers publish against the brand — the builder wrote it to be
-- read by strangers. Storing it does not weaken that rule.
--
-- Rollback:
--   alter table public.sms_registrations
--     drop constraint if exists sms_registrations_samples_is_array,
--     drop column if exists campaign_description,
--     drop column if exists campaign_message_flow,
--     drop column if exists campaign_message_samples,
--     drop column if exists campaign_copy_updated_at;

alter table public.sms_registrations
  add column if not exists campaign_description     text,
  add column if not exists campaign_message_flow    text,
  add column if not exists campaign_message_samples jsonb not null default '[]'::jsonb,
  add column if not exists campaign_copy_updated_at timestamptz;

-- SHAPE ONLY — deliberately not the 2–5 count, and not the 20–1024 length.
--
-- Those are submit-time rules and they live in validateCampaignCopy, because this column has
-- to hold a HALF-TYPED DRAFT. A CHECK enforcing "at least two samples" here would refuse the
-- empty default that every row legitimately carries while the builder is still typing, which
-- would break the save_copy action whose whole purpose is to let typing survive a reload.
-- The database's job is to guarantee the value is an array so nothing downstream has to guess.
alter table public.sms_registrations
  drop constraint if exists sms_registrations_samples_is_array;
alter table public.sms_registrations
  add constraint sms_registrations_samples_is_array
  check (jsonb_typeof(campaign_message_samples) = 'array');

comment on column public.sms_registrations.campaign_description is
  'What the builder will text customers about, in their own words. Read by the carriers.';

comment on column public.sms_registrations.campaign_message_flow is
  'How consent is obtained, in the builder''s words. An EMPTY MessageFlow is a documented TCR rejection cause — the carriers check it against the consent language actually present on the builder''s website, so a blank here is a refusal waiting to happen rather than a blank field.';

comment on column public.sms_registrations.campaign_message_samples is
  'Example messages, 2-5 of them. At least one must show how to stop ("Reply STOP to opt out"); that is the single most-cited campaign rejection reason. Count and length are enforced in validateCampaignCopy, not here, so a half-typed draft stays saveable.';

comment on column public.sms_registrations.campaign_copy_updated_at is
  'When the copy was last saved. The Usa2p resource has no update operation, so after submission this is the only record of what the carriers were actually sent.';
