-- 054_operator_writes: let an operator act AS another tenant, with attribution.
--
-- Until now an operator could only READ another tenant (Designs + Contacts, via
-- operator-portal). This migration is the data side of giving them the full portal with
-- write access — GoHighLevel sub-account parity — which means two things have to exist
-- that don't yet: a capability flag per operator, and a record of WHO did an irreversible
-- thing to WHICH tenant.
--
-- Hand-apply via the SQL editor / MCP and record as version 056 — NEVER `supabase db push`.
-- (Ledger note: 052 AND 054 are each used twice already — 052_billing_features /
-- 052_invoice_sends, and 054_feedback_submissions landed on beta the same day as this
-- one. Do not add to that; 056 is the next free number after 055_billing_price_visible.)

-- ── 1. Operator capabilities ────────────────────────────────────────────────────
-- Being in app_operators currently means "can do everything", which is fine while the
-- roster is two people who own the product. It stops being fine the first time a support
-- hire needs to LOOK at a client's account. Splitting read from write now costs two
-- columns; retrofitting it after support staff exist is the version that gets done wrong.
--
-- Default FALSE deliberately: a hand-inserted operator row is read-only until somebody
-- deliberately promotes it. Adding an operator should never silently grant the ability to
-- charge a client's card.
alter table public.app_operators
  add column if not exists can_write boolean not null default false,
  add column if not exists can_bill  boolean not null default false;

-- The two existing operators own the product; grant both.
update public.app_operators set can_write = true, can_bill = true;

-- ── 2. Invoice attribution ──────────────────────────────────────────────────────
-- NOTE: the existing `sender_user_id` is the GHL user the invoice is sent AS
-- (portal-settings resolves it from est.sentBy, or the location's first user). It says
-- nothing about who clicked the button. This column records the CSM Synergy operator who
-- triggered it — the difference between "an invoice went out for Junior Barns" and
-- "<operator> sent an invoice to Junior Barns' customer".
--
-- Nullable: the owner path leaves it null, so nothing existing changes.
alter table public.invoice_sends
  add column if not exists sent_by_operator text;

-- ── 3. Audit actor as real columns ──────────────────────────────────────────────
-- admin_audit has no actor column, so operator-portal encodes it into free-text `note`
-- as "operator:<email>" — where it collides with adminGate's "bucket=… action=…" notes
-- and can't be indexed or joined. Both nullable, so every existing writer stays valid.
alter table public.admin_audit
  add column if not exists actor_email   text,
  add column if not exists actor_user_id uuid;

-- "Show me everything an operator did to tenant X" is the question this table exists to
-- answer, and there is no index for it today.
create index if not exists admin_audit_target_created_idx
  on public.admin_audit (target_client_id, created_at desc);

-- No RLS changes: app_operators, invoice_sends and admin_audit are already
-- service-role-only (RLS on, zero policies).

-- Rollback:
--   drop index if exists admin_audit_target_created_idx;
--   alter table public.admin_audit  drop column if exists actor_email, drop column if exists actor_user_id;
--   alter table public.invoice_sends drop column if exists sent_by_operator;
--   alter table public.app_operators drop column if exists can_write, drop column if exists can_bill;
