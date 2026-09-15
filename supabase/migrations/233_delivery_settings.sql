-- 233_delivery_settings: how a builder prices delivery — by rule, optionally by driving miles.
-- Applied live 2026-09-14; this file records what ran.
--
-- WHY. Carolyn 2026-09-14: a "Services" heading under Settings → Options, with Delivery first —
-- "the option for them to setup their delivery fees and the option for them to set it up for the
-- fees to be charged based on the miles from either the main builder address or any location
-- address. They should specify whether they want the delivery fee to automatically add based on
-- their rules.. or not automate it." Until now delivery was a number a rep typed into the
-- designer (submit-estimate step 7a-ii); nothing in the product computed miles.
--
-- SHAPE. One row per tenant, typed columns plus `bands jsonb`. Bands are only ever read and
-- written as a whole (the editor saves the full table, the fee rule consumes the full list),
-- their invariants are cross-row (ascending, contiguous from 0) and so cannot be CHECKs anyway,
-- and one upsert is atomic from an edge function where a child table would need delete+insert
-- with no transaction. Their shape is enforced by _shared/deliveryFee.ts normalizeRules(), which
-- both the save action and every reader call. Row presence = "rules configured"; there is no
-- separate enabled flag because with `automate` off the rules still feed the rep's suggestion.
--
-- TAXABLE lives on client_settings.ss_tax_delivery (158) — the delivery line already reads it.
-- MILES are whole, rounded UP, and cached (235) so the designer preview and the estimate agree.

begin;

create table if not exists public.delivery_settings (
  client_id       text primary key,
  -- ON: the Delivery line is added to every estimate by these rules and the customer sees it in
  -- the designer once their address is complete. OFF: the rules only suggest a figure to the rep.
  automate        boolean not null default false,
  -- Where the miles are measured FROM. business = client_settings.business_address;
  -- rep = the signing-in rep's home lot (client_users.location_id, 234), falling back to nearest
  -- when there is no rep (the public designer) or no home lot; nearest = the closest of the
  -- business address and every active builder_locations row.
  origin_mode     text not null default 'business'
                    check (origin_mode in ('business', 'rep', 'nearest')),
  -- The four shapes Carolyn asked for. flat: one fee. base_plus: base_fee + per_mile × miles.
  -- free_radius: free within free_miles, then per_mile × (miles beyond, or all miles — see
  -- per_mile_counts). bands: the first band whose [min_miles, max_miles] holds the miles.
  rule_type       text not null default 'flat'
                    check (rule_type in ('flat', 'base_plus', 'free_radius', 'bands')),
  flat_fee        numeric check (flat_fee is null or flat_fee >= 0),
  base_fee        numeric check (base_fee is null or base_fee >= 0),
  per_mile        numeric check (per_mile is null or per_mile >= 0),
  free_miles      numeric check (free_miles is null or free_miles >= 0),
  per_mile_counts text not null default 'beyond'
                    check (per_mile_counts in ('beyond', 'all')),
  -- [{ "minMiles": 0, "maxMiles": 25, "fee": 150 }, ...] — whole miles, both ends inclusive.
  bands           jsonb not null default '[]'::jsonb
                    check (jsonb_typeof(bands) = 'array'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.delivery_settings enable row level security;
drop policy if exists delivery_settings_owner_read on public.delivery_settings;
create policy delivery_settings_owner_read on public.delivery_settings
  for select to authenticated using (client_id = public.current_client_id());
-- No write policy on purpose: every write goes through portal-settings on the service role.
revoke all on public.delivery_settings from anon;

comment on table public.delivery_settings is
  'Per-tenant delivery fee rules (233). Taxable lives on client_settings.ss_tax_delivery, not here. Bands are validated by _shared/deliveryFee.ts normalizeRules(), never by SQL.';

commit;
