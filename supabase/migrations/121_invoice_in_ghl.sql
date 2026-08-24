-- 121_invoice_in_ghl: the switch that decides WHO issues the paperwork.
--
-- Today every tenant's quote and invoice are GHL objects: submit-estimate creates the GHL
-- estimate (step 9) and lets GHL email it (step 10); portal-settings' send_invoice converts
-- that estimate into a GHL invoice. This column lets a tenant say "StructureStudio issues my
-- quotes and invoices instead" — while contacts and opportunities keep going to the CRM, so
-- the CRM stays the CRM.
--
-- DEFAULT TRUE IS THE WHOLE SAFETY STORY. Every existing tenant — Junior Barns above all, who
-- is selling on the GHL path right now — is on today's behaviour the instant this applies, and
-- stays there until a human turns the switch off in Settings → CRM Connection. Nothing reads
-- this column until the submit-estimate branch ships, so applying it alone changes nothing.
--
-- ss_quote_next is the builder's own numbering: they set the starting number so their SS
-- quotes continue where their CRM or QuickBooks left off, and it is allocated +1 per quote.
-- NULL means "not set yet" — deliberately distinct from 0, because a tenant who has not chosen
-- a start must not silently begin at 1 and collide with their existing paperwork.
--
-- LEDGER NOTE: this DDL was hand-applied to live on 2026-08-21 while the file was numbered 111
-- on the (stale-based) feat/ss-invoicing worktree; 111 was later taken on beta by
-- save_design_protect_invoiced. Record THIS file as version 121 in the ledger — insert only,
-- the statements below are idempotent and already live.
--
-- Hand-apply via the SQL editor / MCP and record as version 121 — NEVER `supabase db push`.

alter table public.client_settings
  add column if not exists invoice_in_ghl  boolean not null default true,
  add column if not exists ss_quote_next   integer,
  add column if not exists ss_quote_prefix text not null default '';

comment on column public.client_settings.invoice_in_ghl is
  'true (default) = quotes/invoices are GHL objects, today''s path. false = StructureStudio issues them; contacts + opportunities still go to GHL.';
comment on column public.client_settings.ss_quote_next is
  'Next SS quote number. NULL until the builder sets a start value; allocated +1 per quote.';

-- The browser never reads client_settings directly (portal-settings surfaces it), so there is
-- no policy to add here — the table's existing service-role-only posture already covers these.

-- Rollback:
--   alter table public.client_settings
--     drop column if exists invoice_in_ghl,
--     drop column if exists ss_quote_next,
--     drop column if exists ss_quote_prefix;
