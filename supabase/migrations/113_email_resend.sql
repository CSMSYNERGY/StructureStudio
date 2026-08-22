-- 113_email_resend.sql — move the white-label email path from Postmark to Resend.
--
-- WHY: Postmark's approval review DECLINED the CSM Synergy account on 2026-08-13 (see
-- commit 41032fa). The whole email feature built in 107 is stranded on a provider we
-- cannot use. Resend is the replacement, and unlike Postmark its AUP contains no clause
-- restricting one account from sending on behalf of many unrelated businesses — which is
-- the clause family that declined us.
--
-- SAFE TO RUN: verified against live on 2026-08-21 before writing this file —
-- client_settings.postmark_domain_id is null on EVERY row, no tenant has an email_domain,
-- and email_sends holds ZERO rows. Nothing was ever sent through the Postmark path, so
-- there is no data to migrate and no tenant to disturb. Every tenant stays on 'ghl'.
--
-- ADDITIVE ONLY. The dead Postmark columns are deliberately NOT dropped: dropping a column
-- is irreversible and buys nothing here, while an unused nullable column costs nothing.
-- They are documented as dead instead, so the next reader does not wire them back up.

alter table public.client_settings
  -- Resend's domain id is a UUID STRING, not a bigint — postmark_domain_id physically
  -- cannot hold one. This is the column the connect/verify/delete round trips key on.
  add column if not exists resend_domain_id text;

-- Widen the per-tenant cutover flag. 'postmark' is kept as a legacy value rather than
-- rewritten away: no row carries it today, and a CHECK that silently forbids a value the
-- code might still write turns into a 23514 at the worst possible moment (the tenant
-- clicking Activate). 'resend' is the value the new send path gates on.
alter table public.client_settings
  drop constraint if exists client_settings_email_provider_check;
alter table public.client_settings
  add constraint client_settings_email_provider_check
    check (email_provider in ('ghl', 'postmark', 'resend'));

alter table public.email_sends
  -- Provider-neutral on purpose. postmark_message_id is dead but retained; naming this one
  -- resend_message_id would just buy the same rename again at the next provider change.
  -- Persist it the instant a send returns — it is the only key a delivery/bounce webhook
  -- can match on, so a lost id is a send whose fate is unknowable.
  add column if not exists provider_message_id text;

comment on column public.client_settings.postmark_domain_id is
  'DEAD (2026-08-21). Postmark declined the account; use resend_domain_id.';
comment on column public.email_sends.postmark_message_id is
  'DEAD (2026-08-21). Use provider_message_id.';

-- Webhook lookups match on the provider id and nothing else, so it needs to be indexed the
-- moment real traffic starts — a sequential scan per delivery event is a slow fuse.
create index if not exists email_sends_provider_message_id_idx
  on public.email_sends (provider_message_id)
  where provider_message_id is not null;

-- NOTE on email_sends.status: the CHECK stays ('claimed','sent','failed','delivered',
-- 'bounced'). Resend emits email.complained and email.delivery_delayed, which have no slot
-- here BY DESIGN — complained maps onto 'bounced' with an authored reason (a complaint is
-- as final as a bounce for sending purposes), and delivery_delayed is ignored entirely
-- because it is not terminal. Widening the vocabulary would mean the UI must learn states
-- that tell a builder nothing actionable.
