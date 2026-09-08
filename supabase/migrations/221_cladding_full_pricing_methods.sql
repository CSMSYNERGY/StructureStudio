-- 221_cladding_full_pricing_methods.sql — cladding gets the SAME pricing vocabulary as every
-- other option, instead of the three I invented for it.
--
-- NUMBERING: repo folder runs to 220 here, and the live ledger carries timestamp-versioned rows
-- with higher NNN names from branches this clone has not seen. Check BOTH before adding 222.
--
-- Carolyn, 2026-09-07, pasting the Options header at me: "Add this in the header of the cladding
-- and also add all these as options for the pricing." The seven methods are the product's
-- existing vocabulary, defined in that header and implemented for layout items since 006:
--
--   each               = rate × count
--   lineal ft          = rate × total feet
--   sqft option        = rate × option area
--   sqft building      = rate × (width × depth)
--   perimeter building = rate × 2 × (width + depth)
--   pct building price = (rate ÷ 100) × base building price
--   pct estimate total = (rate ÷ 100) × subtotal of all other lines, resolved last
--
-- ⚠️ `wall_sqft` IS RETIRED, and every row carrying it becomes `sqft_option`. It was my own
-- invention three days ago because the shared enum has no wall-area member, and the header
-- Carolyn just handed me says what the canonical name means: sqft option is "rate × option
-- AREA". For cladding the option's area IS the wall area — perimeter × wall height — so the
-- canonical name already covered it and a second name for the same thing was the mistake.
-- One meaning per name; the card's header now spells out what the option's area is here.
--
-- STILL ITS OWN CHECK, not the shared public.pricing_method enum. The values match it exactly
-- and deliberately, but cladding's rows are read by their own code path; binding the column to
-- an enum five other tables share would mean a future value added for one of them silently
-- becoming offerable here, with no implementation behind it.
--
-- SAFE: every one of the 150 live rows is `wall_sqft` (verified before writing this), so the
-- rewrite below is a pure rename with no pricing change on any building anywhere.

begin;

alter table public.style_cladding drop constraint if exists style_cladding_basis_check;

update public.style_cladding set basis = 'sqft_option' where basis = 'wall_sqft';

alter table public.style_cladding
  alter column basis set default 'sqft_option',
  add constraint style_cladding_basis_check check (basis in (
    'each', 'lineal_ft', 'sqft_option', 'sqft_building',
    'perimeter_building', 'pct_building_price', 'pct_estimate_total'));

comment on column public.style_cladding.basis is
  'How the rate is applied, using the product''s shared pricing vocabulary. For cladding: each = once per building; lineal_ft and perimeter_building both = the building perimeter (a whole-building option has no length of its own); sqft_option = the WALL area, perimeter × wall height, so a taller-walls upgrade is charged for automatically; sqft_building = the footprint; pct_building_price = a share of the base building price; pct_estimate_total = a share of every other line, resolved last.';

commit;

-- No get_config change: `basis` was always passed through verbatim, so the emitted config picks
-- the new vocabulary up on the next read. Nothing to redeploy for the rename itself — but the
-- designer twins and submit-estimate DO need the new methods implemented, which is the commit
-- this migration ships with.
