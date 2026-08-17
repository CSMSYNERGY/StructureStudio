-- 107_email_sending.sql — per-tenant white-label email sending (Postmark): connection
-- state on client_settings + the email_sends ledger.
--
-- Renumbered from the planned 102: billing/inventory/release-notes work landed first
-- (102–106, with 102 and 103 each used twice).
--
-- WHY. GHL email sending is unreliable (twice observed: GHL returns 200, our ledger says
-- "sent", nothing arrives), so estimate/invoice emails move to Postmark — each tenant
-- sending from their OWN verified domain, with a platform-owned domain as the fallback
-- until theirs verifies. The columns below hold the per-tenant connection state (domain,
-- Postmark domain id, DNS snapshot, verification status) plus the cutover flag.
-- `email_provider` defaults to 'ghl', so this migration is inert: nothing changes for any
-- tenant until a human flips their flag AND their domain is verified.
--
-- Hand-apply via the SQL editor / MCP and record as version 107 — NEVER `supabase db push`.

alter table public.client_settings
  -- The tenant's sending domain (e.g. mail.example.com). NULL = none connected; sends
  -- fall back to the platform domain.
  add column if not exists email_domain         text,
  -- Local part of the From address: {email_from_local}@{email_domain}.
  add column if not exists email_from_local     text not null default 'info',
  -- Friendly From name; falls back to business_name when null.
  add column if not exists email_from_name      text,
  -- THE per-tenant cutover flag. 'ghl' (default) = today's send path, byte-identical.
  -- 'postmark' is honoured only while email_domain_status = 'verified' or the platform
  -- fallback is configured — the send path degrades to GHL, never to a dropped email.
  add column if not exists email_provider       text not null default 'ghl'
    check (email_provider in ('ghl', 'postmark')),
  -- Postmark's id for the domain (Account API) — needed for verify/delete round trips.
  add column if not exists postmark_domain_id   bigint,
  add column if not exists email_domain_status  text not null default 'not_configured'
    check (email_domain_status in ('not_configured', 'pending', 'verified', 'failed')),
  -- [{type, host, value, verified}] snapshot for the Settings → Email DNS table, so the
  -- UI can render the records without a Postmark round trip.
  add column if not exists email_dns_records    jsonb,
  add column if not exists email_verified_at    timestamptz,
  -- Last provider/verification failure, for the settings screen. NULL means healthy.
  add column if not exists email_last_error     text;

-- One sending domain belongs to at most one tenant. Same hard lesson as qbo_realm_id
-- (065:44–49): the database refuses the second connection instead of letting two tenants
-- quietly share a domain and knock each other's verification out.
create unique index if not exists client_settings_email_domain_uniq
  on public.client_settings (email_domain)
  where email_domain is not null;

-- ── email_sends ──────────────────────────────────────────────────────────────────────
-- Append-only ledger: one row per email WE send (Postmark path; GHL-path sends leave no
-- row here). Deliberately NOT an idempotency claim like invoice_sends — a design's
-- estimate legitimately re-emails on every resubmit, so there is no natural
-- (client_id, short_code) uniqueness to claim. invoice_sends keeps the convert-once job;
-- this table closes the "no durable trace of a failed estimate email" gap. `status`
-- follows ONE send:
--   claimed   → row written BEFORE the provider call, so a crash mid-send stays visible
--   sent      → the provider accepted it (postmark_message_id recorded)
--   failed    → the provider refused; `error` says why
--   delivered / bounced → flipped later by the postmark-events webhook, matched on
--                         postmark_message_id
create table if not exists public.email_sends (
  id                  uuid primary key default gen_random_uuid(),
  client_id           text not null,
  short_code          text,           -- null for kind = 'test'
  kind                text not null check (kind in ('estimate', 'invoice', 'test')),
  to_email            text not null,  -- the actual recipient
  intended_email      text,           -- pre-beta-redirect recipient, when a redirect fired
  from_email          text not null,
  subject             text,
  status              text not null default 'claimed'
                        check (status in ('claimed', 'sent', 'failed', 'delivered', 'bounced')),
  error               text,
  postmark_message_id text,
  delivered_at        timestamptz,
  bounced_at          timestamptz,
  bounce_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.email_sends enable row level security;
-- No policies → service_role only (edge functions) — the invoice_sends pattern. Owners
-- see send outcomes through the portal's own surfaces, never this table directly.
revoke all on public.email_sends from anon, authenticated;

create index if not exists email_sends_client_code_idx
  on public.email_sends (client_id, short_code);
-- The webhook's lookup path: delivery/bounce events carry only the MessageID.
create index if not exists email_sends_postmark_message_id_idx
  on public.email_sends (postmark_message_id)
  where postmark_message_id is not null;

-- Rollback:
--   drop table if exists public.email_sends;
--   drop index if exists client_settings_email_domain_uniq;
--   alter table public.client_settings
--     drop column if exists email_domain,
--     drop column if exists email_from_local,
--     drop column if exists email_from_name,
--     drop column if exists email_provider,
--     drop column if exists postmark_domain_id,
--     drop column if exists email_domain_status,
--     drop column if exists email_dns_records,
--     drop column if exists email_verified_at,
--     drop column if exists email_last_error;
