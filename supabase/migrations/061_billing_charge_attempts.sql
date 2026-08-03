-- 061_billing_charge_attempts: a durable record of every checkout charge attempt,
-- written BEFORE the card is touched.
--
-- Why (adversarial review of the pay-upfront change, 2026-07-29): checkout now runs a real
-- first-period sale — up to $1,950 — before registering the subscription. Two failure modes
-- would otherwise leave money moving with no trace:
--   1. TRANSPORT failure: NMI approves the sale but the response never arrives (timeout,
--      reset, 5xx after processing). The function knows nothing charged-shaped happened, so
--      nothing is recorded — and the customer's natural retry charges them AGAIN.
--   2. CRASH between the sale and the DB write: same blind spot, same double charge.
-- An attempt row is inserted with state 'open' before the sale and closed with the outcome
-- after, so the charge exists in our records during the exact window it exists nowhere else.
--
-- The partial unique index is also the CONCURRENCY guard: two simultaneous subscribe calls
-- for the same tenant+plan both try to insert an 'open' row; the second violates the index
-- and is refused before it can charge.
--
-- States: open            — charge in flight; outcome not yet known
--         closed_ok       — charged and the feature activated
--         closed_declined — no net charge (declined, or charged then successfully reversed)
--         closed_unknown  — the outcome could NOT be verified (transport failure, or a
--                           reversal that itself failed). Subscribe REFUSES to run for this
--                           tenant+plan while one of these exists; support resolves it by
--                           checking the gateway and updating the row's state.

create table if not exists public.billing_charge_attempts (
  id bigint generated always as identity primary key,
  client_id text not null,
  plan_id text not null,
  orderid text not null,
  sale_txn text,
  state text not null default 'open'
    check (state in ('open', 'closed_ok', 'closed_declined', 'closed_unknown')),
  detail text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index if not exists billing_charge_attempts_one_open
  on public.billing_charge_attempts (client_id, plan_id) where state = 'open';
create index if not exists billing_charge_attempts_client
  on public.billing_charge_attempts (client_id, created_at desc);

-- Service-role only: RLS on, zero policies — same posture as client_settings.
alter table public.billing_charge_attempts enable row level security;

comment on table public.billing_charge_attempts is
  'One row per checkout charge attempt, written before the card is touched. closed_unknown blocks further attempts for that tenant+plan until support reconciles against the gateway.';
