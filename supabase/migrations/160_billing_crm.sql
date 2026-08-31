-- 160_billing_crm: sell the built-in CRM, fold it into the Suite, and give the Suite a
-- prorated upgrade path (Carolyn, 2026-08-29).
--
-- THREE THINGS, one migration, because they only make sense together:
--
--   1. "Built-in CRM" becomes a subscribable feature at $400/mo · $4,000/yr. The CRM itself
--      (contact records, notes, activities, SMS/email threads, file attachments) has shipped
--      and been given away free since migration 130. This puts a price on it.
--
--   2. The Structure Studio Suite absorbs it and reprices $795→$1,195/mo, $7,950→$11,950/yr.
--      Carolyn gave the annual; the monthly follows this table's universal annual = 10×
--      monthly rule, and is also exactly the old Suite plus the CRM at list. NOBODY is
--      subscribed to full_suite as of this migration (checked live: the only active
--      subscriptions are simple_layout ×2 and view_3d ×1), so the reprice moves no existing
--      customer's bill. Even if it did, it could not: portal-billing snapshots the charged
--      amount onto the NMI subscription at subscribe time, so repricing billing_plans only
--      ever affects NEW subscribers. That is the Founding-price guarantee.
--
--   3. billing_upgrade_credits records what a prorated Suite upgrade forgave. Without it a
--      $7,657 charge against an $11,950 plan is unexplainable six months later.
--
-- ⚠️ NOTHING TO DO IN DEPOSYT. Since the 2026-08-24 collapse to the custom-amount form,
--    gateway_plan_id is a LABEL ONLY — it rides along as plan_name and the charged amount
--    is transmitted from price_cents on every subscribe (portal-billing/index.ts, "ONE
--    gateway form since 2026-08-24"). Do not go create SS_CRM_* recurring plans; there is
--    nothing for them to do, and the ones that used to exist were deleted on purpose.
--
-- ⚠️ crm is PAY-ONLY (portal-billing PAID_ONLY_FEATURES) and therefore NOT grantable:
--    operator_grantable stays false. A pay-only feature that could be comped from the
--    Accounts screen would be neither. Carolyn 2026-08-29, asked directly about the two
--    tenants who lose Contacts on deploy: "Let them lose it."
--
-- ALREADY APPLIED to live via execute_sql; this file records it. HAND-APPLY if re-seeding.

-- ── 1. Built-in CRM ─────────────────────────────────────────────────────────────────────
-- sort_order 74 puts it immediately below Structure Studio Suite (75) and above Self Serve
-- Displays (60): the grid renders sort_order DESCENDING, so the CRM card sits with the Suite
-- rather than down among the à-la-carte features. Carolyn: "the new subscription card should
-- sit up with the SSS".
insert into public.billing_plans
  (id, feature, name, billing_interval, price_cents, gateway_plan_id, setup_fee_cents, availability, required, sort_order, price_visible, active)
values
  ('crm_monthly','crm','Built-in CRM','monthly',  40000, 'SS_CRM_MONTHLY', 0, 'available', false, 74, true, true),
  ('crm_annual', 'crm','Built-in CRM','annual',  400000, 'SS_CRM_YEARLY',  0, 'available', false, 74, true, true)
on conflict (id) do update set
  name = excluded.name, price_cents = excluded.price_cents, gateway_plan_id = excluded.gateway_plan_id,
  availability = excluded.availability, sort_order = excluded.sort_order, price_visible = excluded.price_visible,
  active = excluded.active, updated_at = now();

-- ── 2. The Suite reprices to include it ─────────────────────────────────────────────────
-- The MEMBERSHIP itself is not in this table — BUNDLE_FEATURES lives in code, in three
-- places that must agree: portal-billing/index.ts, _shared/featureCheck.ts (its own
-- duplication ledger says so), and SUITE_MEMBERS in portal/03-catalog.jsx. This migration
-- only moves the price; applying it WITHOUT that code change sells a dearer Suite that
-- still does not include the CRM.
update public.billing_plans
   set price_cents = 119500, updated_at = now()
 where id = 'full_suite_monthly';

update public.billing_plans
   set price_cents = 1195000, updated_at = now()
 where id = 'full_suite_annual';

-- ── 3. The upgrade-credit ledger ────────────────────────────────────────────────────────
-- One row per prorated upgrade to a bundle. This is a RECEIPT, not a mechanism: nothing
-- reads it to decide anything, and deleting a row cannot give anyone their money back. It
-- exists so that "why was this customer charged $7,657 for an $11,950 plan?" has an answer
-- with arithmetic in it.
--
-- source_plans is the plan ids whose unused time was credited, with the per-plan cents, as
-- [{"plan_id":"view_3d_annual","cents":249315}] — the breakdown, not just the total, because
-- the total alone cannot be re-derived once the source subscriptions are cancelled.
create table if not exists public.billing_upgrade_credits (
  id            bigserial primary key,
  client_id     text not null,
  to_plan_id    text references public.billing_plans(id),   -- what they upgraded TO
  to_sub_id     text,                                       -- gateway subscription id, once registered
  credit_cents  int  not null,                              -- total forgiven off the first charge
  charged_cents int  not null,                              -- what actually hit the card today
  extended_days int  not null default 0,                    -- renewal push when credit > charge
  source_plans  jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

alter table public.billing_upgrade_credits enable row level security;

-- Service-role only, like billing_charge_attempts. A tenant has no read here: the credit is
-- already shown to them at checkout and on the receipt, and this table is the accounting
-- copy. No policy is created, so RLS denies everyone; the edge function's service-role
-- client bypasses it.
revoke all on public.billing_upgrade_credits from anon, authenticated;
revoke all on sequence public.billing_upgrade_credits_id_seq from anon, authenticated;

create index if not exists billing_upgrade_credits_client_idx
  on public.billing_upgrade_credits (client_id, created_at desc);
