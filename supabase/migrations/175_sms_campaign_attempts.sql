-- 175 — A campaign can be retried, and the retries are counted.
--
-- APPLY BY HAND (SQL Editor / MCP execute_sql). NEVER `supabase db push`.
--
-- THE DEAD END THIS OPENS. `campaign_failed` had no way out. The UI card said "This one has to
-- be corrected by us directly rather than resubmitted — we have been notified and will be in
-- touch", there was no `case "campaign_failed"` in portal-sms, and `deleteCampaign()` had NO
-- CALLERS at all (its URL bug was fixed in 0538d84 by somebody reading it, not by it running).
-- So the first real rejection stranded the builder exactly the way `profile_pending` did, one
-- stage later, and the promise of a human getting in touch had no mechanism behind it.
--
-- ⚠️ WHY A COUNTER AND NOT JUST A BUTTON. The retry itself is FREE — it deletes the failed
-- campaign at Twilio and drops the row back to `brand_approved` so the copy form reappears. The
-- money is spent one press later, by the existing `advance`, which is already gated
-- settings_billing:'edit'. But nothing stops a builder cycling retry -> Continue -> rejected ->
-- retry, and every Continue is a real campaign submission that TCR bills for. The brand path
-- already solved this exact problem with `brand_update_count` and a cap of 3; this mirrors it
-- rather than inventing a second shape.
--
-- ⚠️ THE RETRY MUST DELETE, NOT EDIT. The Usa2p resource has NO update operation (see
-- createCampaign in _shared/twilioTrustHub.ts). Twilio keeps whatever copy was submitted,
-- forever — the first live rejection is still holding a MessageFlow that describes a consent
-- checkbox which does not exist on the builder's website. Correcting our own row changes
-- nothing there. Delete-and-recreate is the only remedy, which is why this is not a "resubmit".
--
-- Rollback:
--   alter table public.sms_registrations drop column if exists campaign_attempt_count;

alter table public.sms_registrations
  add column if not exists campaign_attempt_count integer not null default 0;

comment on column public.sms_registrations.campaign_attempt_count is
  'How many times this tenant has had a campaign DELETED and rebuilt after a carrier rejection. Capped at 3 in portal-sms, mirroring brand_update_count. Each retry leads to a fresh campaign submission that TCR bills for, so this is a spend limit, not bookkeeping.';
