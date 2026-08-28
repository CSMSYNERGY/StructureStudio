-- 142_inbound_dns_snapshot.sql — the columns the receiving UI needs to render without a
-- provider round trip on every page load.
--
-- Migration 137 gave us `inbound_domain` and `inbound_status` and stopped there. That is
-- enough to ROUTE a reply but not enough to SHOW a builder what to publish: the Settings ->
-- Email screen renders its DNS table straight out of `email_dns_records`, and there was no
-- equivalent for the inbound MX. Without a snapshot the portal would have to call Resend on
-- every render of the settings tab, which is slow, rate-limited per TEAM (10 req/sec shared
-- across every tenant), and fails the screen entirely when the provider is having a bad day.
-- The sending half already learned this; this is the same shape.
--
-- ⚠️ NOTE THE NUMBER. 141 was taken by a concurrent session's `141_crm_field_changes.sql`,
-- which was untracked on disk when this was written. Check the directory, not just the
-- ledger, before claiming a migration number on a shared checkout.
--
-- Additive only. No table, index, policy or grant changes; every column is nullable with no
-- default, so existing rows are untouched and nothing reads differently until the portal
-- writes one.
--
-- Rollback:
--   alter table public.client_settings
--     drop column if exists inbound_dns_records,
--     drop column if exists resend_inbound_domain_id,
--     drop column if exists inbound_verified_at,
--     drop column if exists inbound_last_error;

alter table public.client_settings
  -- The MX row(s) the tenant must publish, snapshotted from the provider's create/verify
  -- response. Same jsonb shape the sending table renders:
  --   [{ purpose, host, fqdn, type, value, verified, priority }]
  add column if not exists inbound_dns_records jsonb,
  -- Resend's id for the RECEIVING domain. Deliberately separate from resend_domain_id: an
  -- inbound subdomain (reply.jrbarns.com) is a DIFFERENT domain object from the sending
  -- domain (jrbarns.com), so one column cannot hold both, and each consumes its own slot
  -- against the account's domain cap.
  add column if not exists resend_inbound_domain_id text,
  add column if not exists inbound_verified_at timestamptz,
  -- The provider's last refusal, so the screen can say WHY rather than just "not verified".
  add column if not exists inbound_last_error text;

comment on column public.client_settings.inbound_dns_records is
  'Snapshot of the MX record(s) the tenant must publish on inbound_domain, so the portal can '
  'render the receiving DNS table without calling the provider on every page load. Same '
  'shape as email_dns_records.';

comment on column public.client_settings.resend_inbound_domain_id is
  'Resend domain id for the RECEIVING subdomain. Separate from resend_domain_id because '
  'reply.<domain> is its own domain object and burns its own slot against the account cap — '
  'so one tenant costs TWO of the plan''s domains, not one.';
