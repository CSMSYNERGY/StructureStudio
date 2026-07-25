-- 052_invoice_sends: idempotency + retry ledger for the portal's "Send invoice" action.
--
-- Why this table exists. Converting a GHL estimate to an invoice is IRREVERSIBLE
-- (markAsInvoiced flips the estimate), while emailing the invoice is a second, separate
-- call that can fail. Without a ledger:
--   * two concurrent clicks could each convert the same estimate (two invoices, one deal);
--   * if the email failed, the invoice existed in GHL but nothing recorded it, the retry
--     hit the "already invoiced" guard, and the next status sync flipped the design to
--     Invoiced — so the portal claimed the customer was billed when no invoice was sent.
--
-- One row per (client_id, short_code). The PK is the concurrency claim: the first
-- request inserts, a racing request gets a unique violation and inspects the row instead
-- of converting again. `status` drives recovery:
--   claimed → a send is in flight (a stale claim can be taken over after a timeout)
--   created → the invoice EXISTS in GHL but was never emailed → the retry re-sends the
--             stored invoice_id instead of converting a second time
--   sent    → done; further attempts are refused idempotently
--   failed  → nothing durable happened; a retry may start over
--
-- Service-role only: the browser never reads this directly — portal-settings surfaces the
-- relevant state (a created-but-unsent invoice) through contact_activity.
--
-- Hand-apply via the SQL editor / MCP and record as version 052 — NEVER `supabase db push`.

create table if not exists public.invoice_sends (
  client_id       text not null,
  short_code      text not null,
  ghl_estimate_id text,
  invoice_id      text,
  invoice_number  text,
  sender_user_id  text,          -- the GHL user the invoice is emailed as (reused on retry)
  status          text not null default 'claimed'
                    check (status in ('claimed', 'created', 'sent', 'failed')),
  error           text,
  attempts        int  not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (client_id, short_code)
);

alter table public.invoice_sends enable row level security;
-- No policies → service_role only (edge functions). Owners never query it directly.
revoke all on public.invoice_sends from anon, authenticated;

create index if not exists invoice_sends_client_status_idx
  on public.invoice_sends (client_id, status);

-- Rollback: drop table public.invoice_sends;
