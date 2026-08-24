-- 122_ss_quote: the columns a StructureStudio-issued quote needs on the design row.
--
-- Only tenants with client_settings.invoice_in_ghl = false (migration 121) ever populate
-- these. For everyone else — which is everyone until a human flips the switch — they stay
-- NULL forever and nothing reads them, so this is inert on apply.
--
--   ss_quote_number    the number the CUSTOMER sees, prefix included (e.g. "JB-1041"). Text,
--                      not an integer: the prefix is part of the identity of the document, and
--                      a number that renders differently on the PDF than it reads in the
--                      database is how a support call becomes unanswerable. Allocated from
--                      client_settings.ss_quote_next.
--   ss_quote_pdf_url   the three-sheet document (priced estimate + floor plan + four-sided 3D).
--                      Distinct from `image_url`, which is and stays the PLAN-only PDF that the
--                      designer uploads and the GHL estimate line links to.
--   ss_quote_sent_at   when the customer was actually emailed it. NULL with a number set means
--                      the document exists but the send did not land — the recoverable state.
--   accepted_at        when the customer accepted, from their own quote page. `status` already
--                      carries 'accepted', but status is a ladder that later rungs overwrite
--                      (invoiced, delivered), so the timestamp is the only durable record of
--                      WHEN they said yes — and commissions' earned-on date needs exactly that.
--                      Deliberately mirrors the delivered_at precedent (migration 091).
--
-- LEDGER NOTE: hand-applied live 2026-08-21 as (then-)111/112 on the stale feat/ss-invoicing
-- worktree; beta later took 112 for revoke_browser_roles_sweep. Record THIS file as version
-- 122 — insert only, the statements are idempotent and already live.
--
-- Hand-apply via the SQL editor / MCP and record as version 122 — NEVER `supabase db push`.

alter table public.designs
  add column if not exists ss_quote_number  text,
  add column if not exists ss_quote_pdf_url text,
  add column if not exists ss_quote_sent_at timestamptz,
  add column if not exists accepted_at      timestamptz;

-- One quote number per tenant, enforced rather than trusted. The allocator hands out
-- ss_quote_next and bumps it, so a duplicate can only come from a bug or a hand-edit — and a
-- second document sharing a number with one a customer already holds is not something to
-- discover from a phone call. Partial, so the NULLs every GHL-mode design carries don't collide.
create unique index if not exists designs_ss_quote_number_uniq
  on public.designs (client_id, ss_quote_number)
  where ss_quote_number is not null;

-- Rollback:
--   drop index if exists public.designs_ss_quote_number_uniq;
--   alter table public.designs
--     drop column if exists ss_quote_number,
--     drop column if exists ss_quote_pdf_url,
--     drop column if exists ss_quote_sent_at,
--     drop column if exists accepted_at;
