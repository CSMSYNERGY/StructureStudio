-- 114_release_note_section: which part of the product a What's New entry is about.
--
-- The changelog passed 88 entries and reads as one undifferentiated stream: a tenant
-- scanning "New Features" cannot tell a Build Schedule change from a Designer change without
-- reading every line (Carolyn 2026-08-23). The section is the label that makes the list
-- skimmable, and it is stored rather than parsed out of the title — several older titles carry
-- their area as a prefix ("Commissions — every rep knows where they stand") and most do not, so
-- deriving it from text would be right for a handful and wrong for the rest.
--
-- DEFAULT '' IS MEANINGFUL: it means "not labelled", and the portal renders no chip for it. So
-- an entry written before someone adds a section shows exactly as it does today rather than
-- claiming to belong somewhere. That also makes the backfill below re-runnable and safe to do
-- in pieces.
--
-- Deliberately NOT a foreign key or an enum. The section vocabulary is product-shaped and will
-- change as the product does (Orders and Reports are roadmap items today, real sections later),
-- and a check constraint would mean a migration every time a label is renamed. The portal
-- renders whatever string is here.
--
-- NOTE ON NUMBERING: 111-113 were taken on `beta` (save_design_protect_invoiced,
-- revoke_browser_roles_sweep, email_resend) while a parallel branch also wrote 111-113 for the
-- invoicing work. This file is 114 to sit clear of both.
--
-- Hand-apply via the SQL editor / MCP and record as version 114 — NEVER `supabase db push`.

alter table public.release_notes
  add column if not exists section text not null default '';

comment on column public.release_notes.section is
  'Product area this entry is about (e.g. "Build Schedule", "Designer"). Empty = unlabelled; the portal renders no chip.';

-- Rollback: alter table public.release_notes drop column if exists section;
