-- 055_billing_price_visible: let a plan be listed WITHOUT publishing its price yet.
--
-- WHY: "coming soon" and "price not decided yet" are two different things, and the
-- Billing tab needs both independently. 3D View and RealTime Pricing are coming_soon
-- but their prices ARE settled and should stay on the card; Self Serve Displays and
-- Schedule Builds are still being costed, and showing a number now would anchor
-- tenants to a figure we may have to raise. So this is a separate flag from
-- `availability`, NOT a re-use of it.
--
-- SCOPE: this is PRESENTATION ONLY, by explicit decision (2026-07-26). No price is
-- changed here and nothing changes in the Deposyt/NMI gateway — `price_cents` keeps
-- its real value, `portal-billing` still returns it, and the Billing tab simply
-- doesn't print it. Consequence worth knowing: the figure is still visible to anyone
-- who opens devtools on the status response. That was accepted as a non-issue for a
-- coming-soon feature; if it ever matters, redact price_cents in the `publicPlans`
-- projection in portal-billing (safe, since a coming-soon plan can't enter the cart).
--
-- To publish a price later: set price_visible = true (and update price_cents if it
-- changed). Nothing else needs to change — the card starts showing the amount.
--
-- Hand-apply via the SQL editor / MCP and record as version 055 — NEVER `supabase db push`.

alter table public.billing_plans
  add column if not exists price_visible boolean not null default true;

comment on column public.billing_plans.price_visible is
  'False = price not published yet; portal-billing withholds price_cents/setup_fee_cents and the Billing tab shows "Pricing at launch". Independent of availability.';

-- Still being costed — hide the number for now.
update public.billing_plans
   set price_visible = false, updated_at = now()
 where feature in ('self_serve_displays', 'schedule_builds');

-- Explicit for the rest, so the intent is visible in the data rather than implied by
-- the column default: these prices are settled and stay on the cards.
update public.billing_plans
   set price_visible = true, updated_at = now()
 where feature in ('simple_layout', 'view_3d', 'on_demand_pricing');

-- Rollback: alter table public.billing_plans drop column price_visible;
