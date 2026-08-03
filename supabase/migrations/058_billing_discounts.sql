-- 058_billing_discounts: per-account recurring discount, set by CSM Synergy at its
-- own discretion (e.g. a founding customer kept at 50% off for life).
--
-- Deliberately NOT a coupon-code system. The discount is an attribute of the ACCOUNT,
-- not of a purchase, so it applies automatically to any feature the tenant subscribes
-- to later — there is no code to re-enter, forget, share, or leak. A redeemed coupon
-- would discount only the first thing they bought, which is the opposite of "for life".
--
-- RECURRING ONLY. Setup fees are never discounted (project owner, 2026-07-28).
--
-- Lives on client_settings, which is service-role only, so a tenant can neither read
-- their own discount nor forge one — the same reasoning as billing_exempt in 057. The
-- discounted amount is computed server-side in portal-billing and sent to the gateway;
-- the browser never supplies a price.
--
-- NOTE on why this needed a gateway change too: subscriptions used to be created with
-- NMI's plan_id form, where the charged amount lives in a plan record inside Deposyt and
-- billing_plans.price_cents was never transmitted. Discounting price_cents alone would
-- have changed what we DISPLAY and RECORD while still charging full price. portal-billing
-- now creates custom-amount subscriptions (plan_amount), which also makes price_cents the
-- single source of truth for what is actually billed.

alter table public.client_settings
  add column if not exists discount_percent integer not null default 0,
  add column if not exists discount_features text[];

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'client_settings_discount_percent_ck'
  ) then
    alter table public.client_settings
      add constraint client_settings_discount_percent_ck
      check (discount_percent >= 0 and discount_percent <= 100);
  end if;
end $$;

comment on column public.client_settings.discount_percent is
  'Percent off the RECURRING price (0-100), applied server-side at subscribe time. Setup fees are never discounted. 100 creates a $0 subscription; prefer billing_exempt for internal accounts.';
comment on column public.client_settings.discount_features is
  'Features the discount applies to (billing_plans.feature values). NULL or empty = every feature.';

-- What the tenant WOULD have paid. price_cents keeps holding what is actually billed,
-- so the pair lets the portal show "was X, now Y" and keeps a discounted subscription
-- distinguishable from one taken out when the list price happened to be lower.
alter table public.billing_subscriptions
  add column if not exists list_price_cents integer;

comment on column public.billing_subscriptions.list_price_cents is
  'billing_plans.price_cents at subscribe time, BEFORE any account discount. NULL on rows created before 058. price_cents = what the gateway actually bills.';
