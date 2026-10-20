-- 317_card_on_file_credentials.sql — the Visa/Mastercard stored-credential (COF) framework on the
-- NMI/Deposyt account: which transaction each stored-card agreement starts from, what the builder
-- agreed to, and what the processor said about the flags.
--
-- ⛔ APPLY BY HAND, BEFORE deploying portal-billing / portal-settings / wallet-autotopup /
--    admin-catalog from the same commit (the functions read these columns; against a database
--    without them, portal-billing refuses every card action with a 503 rather than guess).
--    Pipe to `supabase db query --linked` (stdin), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('317', '317_card_on_file_credentials') returning version, name;
--    REHEARSAL: sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/317_card_on_file_credentials.sql | npx supabase db query --linked -o csv
--
-- ── WHY (2026-10-20) ────────────────────────────────────────────────────────────────────────
-- StructureStudio keeps builders' cards in NMI's Customer Vault and charges them again later:
-- subscription renewals, wallet top-ups the builder asks for, and automatic top-ups. Until now
-- every one of those sales went out with no stored-credential data at all (no initiated_by, no
-- stored_credential_indicator, no billing_method, no initial_transaction_id), cards were vaulted
-- before any approved transaction, and nothing recorded what the builder agreed to. The code half
-- of the fix is in _shared/nmi.ts (cofFields) and its callers; this is the schema half:
--
--   1. THE INITIAL TRANSACTION OF EACH AGREEMENT, kept where the next charge can find it.
--      * A SUBSCRIPTION's initial is its first-period sale, sent as the initial recurring CIT.
--        Kept on the subscription row, because every subscription is its own recurring series.
--      * The vault's UNSCHEDULED initial is the first top-up the builder made themselves (or a
--        card replacement's $0 check). Automatic top-ups are merchant-initiated and must name it.
--        NMI: a recurring series' id cannot be reused for unscheduled charges, so a card first
--        saved by a subscription has NO unscheduled initial until its owner adds funds once.
--   2. THE AGREEMENT ITSELF (billing_consents): the exact sentence, its version, who, when, the
--      card's last 4, and the transaction it backs. One row per agreement, never edited.
--   3. WHAT THE PROCESSOR SAID (billing_charge_attempts.cof_supported): NMI answers each COF
--      sale with cof_supported, and "which values apply depends on the processor" behind Deposyt.
--
-- ── BACKFILL ────────────────────────────────────────────────────────────────────────────────
-- Subscription initials come from the attempt ledger: the closed_ok first-period sale for the
-- same tenant and plan, written in the 30 minutes before the subscription row (checkout writes
-- the attempt, sells, registers, then upserts the row — seconds apart). They are marked
-- initial_cof_flagged = false: those sales are the real first transactions, but they went out
-- WITHOUT the COF fields, and the record should say so rather than pass them off as flagged.
-- No unscheduled initial is backfilled: no top-up has ever been charged (0 wallet_topup attempts
-- on 2026-10-20), and a subscription's first sale is not a valid one.
--
-- ⚠️ THE ONE TENANT WITH AUTO TOP-UP ALREADY ON is left on by this migration. It has no unscheduled
--    initial and no recorded agreement, so the first time it falls below its threshold
--    _shared/walletAutoTopup.ts switches it off with a sentence telling the builder why, instead
--    of charging. Switching it off here would be the same outcome sooner; it is a decision about a
--    live tenant's setting, so it is not taken inside a schema migration.

begin;

-- The ALTERs take ACCESS EXCLUSIVE locks on four live tables (wallet_accounts among them, which
-- every text, call and 3D hold debits). Behind a long-held lock the apply would queue and stall
-- that traffic; with this it fails after 5 s instead, nothing applied, and can be run again.
set local lock_timeout = '5s';

-- ── 1a. The vault's unscheduled initial, and which card it is ─────────────────────────────────
alter table public.billing_customers
  -- The gateway transaction id automatic top-ups send as initial_transaction_id. Null until the
  -- builder's own first top-up (or a card replacement) succeeds; auto top-up refuses until then.
  add column if not exists unscheduled_initial_txn text,
  add column if not exists unscheduled_initial_at  timestamptz,
  -- Display only ("your card ending 1234"), from Collect.js's masked number. Truncated card data
  -- is not cardholder data under PCI DSS; nothing else about the card is kept.
  add column if not exists card_last4    text,
  add column if not exists card_brand    text,
  add column if not exists card_saved_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_customers_card_last4_shape') then
    alter table public.billing_customers add constraint billing_customers_card_last4_shape
      check (card_last4 is null or card_last4 ~ '^[0-9]{4}$');
  end if;
end $$;

-- ── 1b. Each subscription's recurring initial ────────────────────────────────────────────────
alter table public.billing_subscriptions
  add column if not exists initial_transaction_id text,
  -- true  = sent as the flagged initial recurring CIT (initiated_by=customer, stored, billing_method)
  -- false = backfilled below from a first sale that went out without COF fields
  -- null  = no initial recorded (an ACH or hand-made row)
  add column if not exists initial_cof_flagged boolean;

-- ── 1c. What each sale was sent as, and what the processor answered ─────────────────────────
alter table public.billing_charge_attempts
  -- The COF framing this attempt went out with. Null for rows from before 317.
  add column if not exists cof text,
  -- billing_method actually accepted ('initial_recurring' | 'recurring'), recurring initials only.
  add column if not exists billing_method text,
  -- NMI's cof_supported response value, verbatim. 'stored' means the processor honours the flags.
  add column if not exists cof_supported text,
  -- The receipt email after a merchant-initiated (automatic or operator) top-up.
  add column if not exists receipt_sent_at timestamptz,
  add column if not exists receipt_error   text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_charge_attempts_cof_kind') then
    alter table public.billing_charge_attempts add constraint billing_charge_attempts_cof_kind check (
      cof is null or cof in ('cit_initial_recurring', 'cit_initial_unscheduled', 'cit_used', 'mit_unscheduled')
    );
  end if;
end $$;

-- The daily cap on automatic top-ups counts these (walletAutoTopup.ts).
create index if not exists billing_charge_attempts_client_cof_recent
  on public.billing_charge_attempts (client_id, cof, created_at desc);

-- ── 2. The agreements ───────────────────────────────────────────────────────────────────────
create table if not exists public.billing_consents (
  id              bigint generated always as identity primary key,
  client_id       text not null,
  kind            text not null check (kind in ('subscription_card', 'topup_card', 'auto_topup', 'card_update')),
  -- The template version (_shared/cofConsent.ts COF_CONSENT_VERSION) and the sentence rendered
  -- from it with the amounts the SERVER computed for this request.
  wording_version text not null,
  wording         text not null,
  -- The numbers behind the sentence (amounts, plans, threshold, who attested it), as data.
  terms           jsonb not null default '{}'::jsonb,
  user_id         uuid,
  user_email      text,
  card_last4      text,
  -- The gateway transaction this agreement backs, written once that transaction is approved.
  -- Null on an agreement whose charge was then declined (the card was not stored).
  transaction_id  text,
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now()
);
create index if not exists billing_consents_client_recent on public.billing_consents (client_id, created_at desc);

-- Service role only, like every other billing table. `from public` as well as the API roles:
-- default privileges hand new tables to PUBLIC, and anon/authenticated inherit from it.
alter table public.billing_consents enable row level security;
revoke all on public.billing_consents from public, anon, authenticated;

-- ── 1d. Which agreement switched automatic top-ups on ────────────────────────────────────────
alter table public.wallet_accounts
  add column if not exists auto_topup_consent_id bigint references public.billing_consents(id);

-- ── Backfill: subscription initials from the attempt ledger ─────────────────────────────────
update public.billing_subscriptions s
   set initial_transaction_id = m.sale_txn,
       initial_cof_flagged    = false
  from (
    select distinct on (s2.id) s2.id, a.sale_txn
      from public.billing_subscriptions s2
      join public.billing_charge_attempts a
        on a.client_id = s2.client_id
       and a.plan_id   = s2.plan_id
       and a.state     = 'closed_ok'
       and a.sale_txn is not null
       and a.created_at <= s2.created_at
       and a.created_at >  s2.created_at - interval '30 minutes'
     order by s2.id, a.created_at desc
  ) m
 where m.id = s.id
   and s.initial_transaction_id is null;

-- Read back (expect: every card subscription with a closed_ok first sale has one, flagged false):
--   select id, plan_id, status, initial_transaction_id is not null as has_initial, initial_cof_flagged
--     from public.billing_subscriptions order by created_at;

commit;

-- Rollback:
--   alter table public.wallet_accounts drop column if exists auto_topup_consent_id;
--   drop table if exists public.billing_consents;
--   drop index if exists public.billing_charge_attempts_client_cof_recent;
--   alter table public.billing_charge_attempts drop constraint if exists billing_charge_attempts_cof_kind,
--     drop column if exists cof, drop column if exists billing_method, drop column if exists cof_supported,
--     drop column if exists receipt_sent_at, drop column if exists receipt_error;
--   alter table public.billing_subscriptions drop column if exists initial_transaction_id,
--     drop column if exists initial_cof_flagged;
--   alter table public.billing_customers drop constraint if exists billing_customers_card_last4_shape,
--     drop column if exists unscheduled_initial_txn, drop column if exists unscheduled_initial_at,
--     drop column if exists card_last4, drop column if exists card_brand, drop column if exists card_saved_at;
