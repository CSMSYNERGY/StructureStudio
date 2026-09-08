-- 174_card_payments: taking money inside StructureStudio (Fiserv CardPointe).
--
-- Card and ACH, on two surfaces: the shed shopper paying their own invoice from
-- my-quotes.html, and the builder taking a card in the Orders tab's "Record a payment"
-- modal. `payments.gateway` / `.gateway_txn_id` have existed since the orders work with
-- ZERO producers -- 136's header named them as the seam and warned that anything richer
-- needs its own migration. This is that migration.
--
-- ── LIVE DDL, DUMPED 2026-09-01 BEFORE WRITING A LINE OF THIS FILE ──────────────────
-- orders and payments have no migration in this repo (their DDL lives on a `wip/orders`
-- branch that exists nowhere), and the two snapshots that DO exist -- 136's header and
-- portal-settings/index.ts:3764 -- already disagree with each other by a column. So this
-- was re-queried from information_schema rather than trusted:
--
--   orders(id uuid, client_id text, short_code text, order_no int, total_cents int,
--          currency text, total_source text, ordered_at timestamptz, notes text,
--          created_at, updated_at, submitter_user_id uuid, pretax_subtotal_cents int,
--          tax_cents int, building_serial text)                    -- NO status column
--   payments(id uuid, client_id text, order_id uuid NOT NULL, amount_cents int NOT NULL,
--          method text NOT NULL, reference text, received_at timestamptz, note text,
--          voided_at timestamptz, void_reason text, gateway text, gateway_txn_id text,
--          created_by uuid, created_at timestamptz)
--
--   payments_method_check       method in ('card','cash','check','ach','other')
--   orders_total_source_check   total_source in ('pending','ghl','manual')
--   payments_order_client_fk    (order_id, client_id) -> orders(id, client_id) CASCADE
--   payments_gateway_txn_uniq   UNIQUE (client_id, gateway, gateway_txn_id)
--                                 WHERE gateway_txn_id IS NOT NULL
--
-- ── THREE THINGS THE LIVE DUMP CHANGED, AND THEY ALL REMOVED WORK ───────────────────
--
-- 1. THE BROWSER ALREADY CANNOT WRITE A GATEWAY PAYMENT. `payments_owner_insert` carries
--    `WITH CHECK (client_id = current_client_id() AND gateway IS NULL)`, and
--    `payments_owner_update` carries the same test in BOTH its USING and WITH CHECK. So
--    an authenticated team member cannot mint a row claiming settled card funds, and
--    cannot edit or void one either. The write-guard trigger this migration was going to
--    add is unnecessary -- RLS does it already, and does it better than a trigger would.
--    The consequence to design around: voiding a CardPointe payment MUST go through the
--    edge function under the service role. The portal's existing void button is correctly
--    inert on gateway rows (04-orders.jsx:2524) and stays that way.
--
-- 2. REPLAY IDEMPOTENCY ALREADY EXISTS. `payments_gateway_txn_uniq` is unique on
--    (client_id, gateway, gateway_txn_id). A reconcile that re-completes an interrupted
--    charge inserts the same retref and gets 23505, which the charge path reads as "this
--    already happened" rather than double-recording. No new unique index is needed;
--    attempt_id below is added for the JOIN, not for the guard.
--
-- 3. payments.order_id IS NOT NULL. So the walk-in "take a random payment" case (Carolyn,
--    2026-08-28: someone buys a couple of pieces of trim) does NOT get a dangling payment
--    and does NOT get a relaxed constraint. It creates a real `orders` row -- no
--    short_code, total_source 'manual', total_cents = the amount. That is semantically
--    honest (a walk-in sale IS an order) and it keeps the Orders list, the balance
--    arithmetic, refunds and the payments FK correct with ZERO changes to any of them.
--
-- ── WHY funding_state DEFAULTS TO 'settled' ────────────────────────────────────────
-- ACH is real money three days late, and it can come back Rejected after the builder was
-- already told it arrived. So the balance arithmetic has to count settled money only. But
-- every payment recorded before today -- every cash, cheque and card-taken-elsewhere row
-- in the table -- is money the builder already has. The default is what preserves that
-- meaning. Without it, this migration would silently un-pay every historical invoice.
--
-- ── surcharge_cents: THE SEMANTIC, WHICH MUST NEVER BE VIOLATED ────────────────────
-- Fiserv's gateway adds the surcharge itself when the merchant has it enabled and the card
-- is credit, and reports it back in the auth response (Bryan Greene, 2026-08-28). We never
-- compute it. So:
--        amount_cents          is what is applied to the BALANCE
--        amount_cents + surcharge_cents  is what was charged to the CARD
-- Keeping the fee out of amount_cents is what keeps balOf (04-orders.jsx:1225) correct
-- with no portal change, and stops a builder's books recording a card fee as revenue.
--
-- EVERYTHING HERE IS ADDITIVE and inert until code ships: no writer emits the new columns
-- yet, payment_attempts starts empty, and funding_state reads 'settled' exactly as the
-- balance already behaves. Hand-apply via the SQL editor / MCP and record as version 174.
-- NEVER `supabase db push`. (Ledger tip was 172 when this was written; 173 is a file that
-- has not been applied, so 174 is free either way.)

-- ── 1. The invoice learns what the builder is asking for NOW ───────────────────────
--    NULL = no deposit asked, pay in full. Set at send_invoice, frozen once the customer
--    signs (the claim-recovery path already refuses to touch signed paperwork).
alter table public.invoice_sends
  add column if not exists deposit_cents integer;

alter table public.invoice_sends
  drop constraint if exists invoice_sends_deposit_positive;
alter table public.invoice_sends
  add  constraint invoice_sends_deposit_positive
  check (deposit_cents is null or deposit_cents > 0);

comment on column public.invoice_sends.deposit_cents is
  'Builder-set deposit the customer is asked to pay now. NULL = pay in full. Frozen once signed_at is set.';

-- ── 2. Per-tenant switch and merchant id ───────────────────────────────────────────
--    client_settings is service-role only (025 revoked anon+authenticated), which is the
--    same posture ghl_api_key and the QBO tokens already rely on. A tenant can neither
--    read their own merchid nor forge one.
alter table public.client_settings
  add column if not exists payments_online_enabled boolean not null default false,
  add column if not exists cardpointe_merchid      text;

comment on column public.client_settings.payments_online_enabled is
  'Master switch for taking money for this tenant. Default false: a tenant who has not boarded a merchant account has no pay surface at all, rather than one that fails.';
comment on column public.client_settings.cardpointe_merchid is
  'This builder''s own CardPointe MID. Each builder boards and underwrites directly with Fiserv and carries their own chargeback liability (Kaylee McLaughlin, 2026-08-28), so the money and the risk are theirs, not ours.';

-- ── 3. The attempt ledger ──────────────────────────────────────────────────────────
--    A near-transcription of billing_charge_attempts (061) for invoice payments. The rule
--    it exists to enforce, from walletTopup.ts: the charge exists in OUR records BEFORE
--    the card is touched, and the balance is credited only AFTER the sale is known good.
create table if not exists public.payment_attempts (
  id            bigint generated always as identity primary key,
  client_id     text not null,
  order_id      uuid not null,
  short_code    text,                       -- soft link for support triage; payments has none
  amount_cents  integer not null check (amount_cents > 0),
  rail          text not null check (rail in ('card','ach')),
  merchid       text not null,
  orderid       text not null,              -- what we SENT as CardPointe `orderid`
  retref        text,                       -- CardPointe's transaction reference
  payment_id    uuid,
  state         text not null default 'open'
    check (state in ('open', 'closed_ok', 'closed_declined', 'closed_unknown')),
  respstat      text,
  respcode      text,
  detail        text,
  actor_kind    text not null check (actor_kind in ('customer', 'operator', 'staff')),
  actor_ref     text,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);

comment on table public.payment_attempts is
  'One row per charge attempt, written BEFORE the card is touched. States: open (in flight, outcome unknown); closed_ok (charged and recorded); closed_declined (no net charge -- declined, rate-limited, or charged then successfully reversed); closed_unknown (the outcome could NOT be verified). A closed_unknown BLOCKS further attempts on that order until it is resolved -- retrying an unverified charge is how a customer gets billed twice.';

-- THE CONCURRENCY GUARD, and the reason the INSERT is the guard rather than a
-- read-then-write. Two tabs, a double-click, or a customer paying while a rep charges the
-- same balance: the second request violates this index and stops BEFORE any money moves.
--
-- Scoped to the ORDER, deliberately. billing_charge_attempts keys on (client_id, plan_id)
-- and walletTopup.ts had to synthesize a plan_id, accepting the documented cost that one
-- unverifiable top-up blocks every later one for that tenant. That blast radius is wrong
-- here: it would freeze a whole builder's book over one stuck charge at 2am. Order scope
-- blocks exactly the balance at risk and nothing else.
--
-- It deliberately EXCLUDES amount_cents (else concurrent $500 and $500.01 submits both
-- land) and rail (else a card charge races an ACH debit against one balance).
create unique index if not exists payment_attempts_one_open
  on public.payment_attempts (client_id, order_id) where state = 'open';

-- THE RECOVERY KEY. `orderid` is minted before the row is inserted, so it is durable
-- before the card is touched -- which is what lets /inquireByOrderid answer "did that
-- charge actually happen?" for any attempt whose response we never received. That turns a
-- closed_unknown from "phone CSM Synergy" into "resolved in seconds". The NMI path has no
-- equivalent, and reconciliation is only sound if this maps 1:1 to an attempt.
create unique index if not exists payment_attempts_orderid_uniq
  on public.payment_attempts (merchid, orderid);

create index if not exists payment_attempts_client_idx
  on public.payment_attempts (client_id, created_at desc);
create index if not exists payment_attempts_unresolved_idx
  on public.payment_attempts (client_id, order_id) where state = 'closed_unknown';

-- RLS on, ZERO policies -> service_role only, the invoice_sends / billing_charge_attempts
-- posture. The browser never reads this; the portal is served a projection.
alter table public.payment_attempts enable row level security;
revoke all on public.payment_attempts from anon, authenticated;

-- ── 4. What a gateway payment needs beyond the two seam columns ────────────────────
alter table public.payments
  add column if not exists attempt_id         bigint references public.payment_attempts(id),
  add column if not exists funding_state      text not null default 'settled',
  add column if not exists funding_updated_at timestamptz,
  add column if not exists return_code        text,
  add column if not exists gateway_authcode   text,
  add column if not exists instrument_brand   text,
  add column if not exists instrument_last4   text,
  add column if not exists entry_mode         text,
  add column if not exists avs_result         text,
  add column if not exists cvv_result         text,
  add column if not exists surcharge_cents    integer;

alter table public.payments
  drop constraint if exists payments_funding_state_check;
alter table public.payments
  add  constraint payments_funding_state_check
  check (funding_state in ('settled', 'pending', 'returned'));

alter table public.payments
  drop constraint if exists payments_surcharge_nonneg;
alter table public.payments
  add  constraint payments_surcharge_nonneg
  check (surcharge_cents is null or surcharge_cents >= 0);

comment on column public.payments.funding_state is
  'settled = counts toward the balance. pending = submitted, not funded (ACH); counts toward NOTHING. returned = came back; counts toward nothing and stays visible rather than being deleted. Defaults to settled so every payment recorded before 174 keeps its existing meaning.';
comment on column public.payments.surcharge_cents is
  'The card-brand surcharge Fiserv added and reported back. NOT included in amount_cents: amount_cents applies to the balance, amount_cents + surcharge_cents is what hit the card. Never computed by us.';
comment on column public.payments.attempt_id is
  'Join back to payment_attempts. Not a uniqueness guard -- payments_gateway_txn_uniq (client_id, gateway, gateway_txn_id) already makes a replayed completion idempotent.';
comment on column public.payments.instrument_brand is
  'VISA / MC / ACH etc. Brand and last four are explicitly storable under PCI DSS; the PAN never reaches our origin because the iFrame tokenizer keeps it in the cardholder''s browser.';

-- Pending money must be cheap to find: the reconcile sweep reads exactly this.
create index if not exists payments_funding_pending_idx
  on public.payments (client_id, funding_state)
  where funding_state <> 'settled' and voided_at is null;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────────────
-- Leaving 174 applied is harmless and preferred once any writer has run. If it must come
-- out BEFORE any charge has been taken:
--   drop index if exists public.payments_funding_pending_idx;
--   alter table public.payments
--     drop column if exists attempt_id, drop column if exists funding_state,
--     drop column if exists funding_updated_at, drop column if exists return_code,
--     drop column if exists gateway_authcode, drop column if exists instrument_brand,
--     drop column if exists instrument_last4, drop column if exists entry_mode,
--     drop column if exists avs_result, drop column if exists cvv_result,
--     drop column if exists surcharge_cents;
--   drop table if exists public.payment_attempts;
--   alter table public.client_settings
--     drop column if exists payments_online_enabled, drop column if exists cardpointe_merchid;
--   alter table public.invoice_sends drop column if exists deposit_cents;
-- After a charge exists, dropping funding_state would re-count returned ACH as money.
