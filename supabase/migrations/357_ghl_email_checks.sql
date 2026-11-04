-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 357 — GHL QUOTE EMAIL CHECKS: what became of a quote email after GHL accepted it
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger read 2026-11-04: highest numbered version 355. 356 is held by another session's
-- branch (a client_settings column for the GHL sender), so this is 357. Neither depends on the
-- other, so they can apply in either order. Re-read BOTH the ledger and this folder before applying.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- POST /invoices/estimate/{id}/send answers 201 when GHL takes the request, not when the email
-- leaves. In October 2026 one builder's quote emails failed inside GHL after that 201, the design
-- went to `sent`, app_errors stayed empty, and the builder heard about it from customers four weeks
-- later. The answer exists only in GHL, some time after the send, so somebody has to come back and
-- read it. This table is the list of what to read. _shared/ghlEmailCheck.ts says how each row is
-- decided, and the ghl-email-check function does the reading from the Phone Worker's tick.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
-- One table. submit-estimate adds a row for each send GHL accepted. Applying this changes nothing
-- until that function is deployed.
--
-- ── WHAT THE ROW HOLDS ───────────────────────────────────────────────────────────────────
-- GHL ids and GHL's status word. No name, address, subject or body: the tick's report must not
-- carry customer data, and what is not stored cannot leak into it.
--
-- Closed rows are kept. A later feature showing "this email failed" on a design reads them, and at
-- a few rows per quote email the table stays small.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Additive. tenant_purge (321) deletes a removed builder's rows because the table has client_id;
-- tenantTables.ts records that decision.
--
-- ── REVERSE (only if this has to be undone) ──────────────────────────────────────────────
--   -- drop table if exists public.ghl_email_checks;
-- ═════════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.ghl_email_checks (
  id                  bigserial primary key,
  client_id           text not null,
  short_code          text not null,
  ghl_estimate_id     text not null,
  ghl_contact_id      text not null,
  -- Taken before the POST, because GHL adds the email row while answering it.
  send_started_at     timestamptz not null,
  next_check_at       timestamptz not null,
  looks               integer not null default 0,
  state               text not null default 'pending'
    check (state in ('pending', 'ok', 'failed', 'no_delivery', 'not_found', 'unreadable')),
  ghl_conversation_id text,
  -- The id the email route answers to (meta.email.messageIds[0]), not the message row's own id.
  ghl_email_id        text,
  last_status         text,
  -- Beta mode replaced the customer with the builder's test inbox, so this failure reached no customer.
  test_inbox          boolean not null default false,
  created_at          timestamptz not null default now(),
  closed_at           timestamptz
);

create index if not exists ghl_email_checks_due_idx
  on public.ghl_email_checks (next_check_at) where state = 'pending';

-- One check per email. Two sends to one contact inside the matching window must each find their
-- own email, or one failure could be hidden by the other's success.
create unique index if not exists ghl_email_checks_email_uq
  on public.ghl_email_checks (client_id, ghl_email_id) where ghl_email_id is not null;

-- Service role only, like crm_rule_outbox. RLS on with no policies, and the default grants removed:
-- Supabase's default privileges hand every new table to anon and authenticated.
alter table public.ghl_email_checks enable row level security;
revoke all on public.ghl_email_checks from public, anon, authenticated;
revoke all on sequence public.ghl_email_checks_id_seq from public, anon, authenticated;
grant select, insert, update, delete on public.ghl_email_checks to service_role;
grant usage, select on sequence public.ghl_email_checks_id_seq to service_role;
