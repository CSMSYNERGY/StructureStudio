-- 177_insulation.sql — insulation offerings (slice 3 of the Interior / Electrical / Insulation
-- / Taller-walls plan).
--
-- NUMBERING: 176 was taken by 176_captured_lead_crm_link while this session was running, and
-- 174 is used TWICE in the ledger (174_card_payments + 174_wall_height_widths_explicit). Check
-- the folder AND the live ledger every time; this is the third shift in two days.
--
-- WHAT THIS IS. A builder offers batt and/or spray foam, priced per SQUARE FOOT, per area:
-- floor, walls, roof. The customer ticks the areas they want; "entire building" is a UI
-- shortcut for all three and is deliberately NOT a fourth row — a stored fourth rate would be
-- a second place for the price to live and the two would drift.
--
-- WHY IT WAITED FOR TALLER WALLS. Wall area is perimeter x wall height, and the wall height is
-- whatever the customer's chosen increase resolves to (172/173). Building this first would have
-- meant either ignoring the upgrade or writing the resolution twice.

begin;

create table if not exists public.insulation_offerings (
  id              uuid primary key default gen_random_uuid(),
  client_id       text not null,
  ins_type        text not null check (ins_type in ('batt', 'spray_foam')),
  area            text not null check (area in ('floor', 'walls', 'roof')),
  -- NULL = not offered. The same not-yet-priced contract as building_sizes.base_price,
  -- fixture_items.price and style_wall_heights.rate_per_lf: a builder can leave a cell empty
  -- while deciding, and the customer is never shown a choice we cannot price.
  rate_per_sqft   numeric check (rate_per_sqft is null or rate_per_sqft >= 0),
  taxable         boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (client_id, ins_type, area)
);

-- Same posture as style_wall_heights / building_sizes: RLS on, owner-scoped SELECT, and NO
-- write policy — every write goes through portal-settings on the service role, so the tenant
-- is resolved from the JWT and never trusted from the body. The public designer never reads
-- this table directly; it arrives via get_config.
alter table public.insulation_offerings enable row level security;

drop policy if exists insulation_offerings_owner_read on public.insulation_offerings;
create policy insulation_offerings_owner_read on public.insulation_offerings
  for select to authenticated
  using (client_id = current_client_id());

revoke all on public.insulation_offerings from anon;

comment on table public.insulation_offerings is
  'Per-tenant insulation rates, $/sq ft per type per area. NULL rate = not offered. "Entire building" is a UI shortcut for all three areas, never a stored row.';

-- ── get_config: emit what is actually offered ────────────────────────────────
-- Spliced, not rewritten — see 171 for why. Carolyn chose NO price in the designer for this
-- one ("no price until the quote"), so the rate is NOT emitted at all: the browser only needs
-- to know which type/area combinations exist. That also means nothing here is show_pricing
-- gated, because there is no price to gate — and a tenant who hides pricing gets exactly the
-- same payload as one who does not.
do $mig$
declare
  src text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text; new_blk text;
begin
  old_blk := $anchor$    'colors', coalesce(($anchor$;

  new_blk := $repl$    'insulation', coalesce((
      select jsonb_agg(jsonb_build_object('type', io.ins_type, 'area', io.area) order by io.ins_type, io.area)
      from public.insulation_offerings io
      where io.client_id = cc.client_id and io.active and io.rate_per_sqft is not null), '[]'::jsonb),
    'colors', coalesce(($repl$;

  if position('insulation_offerings' in src) > 0 then
    raise notice '177: get_config already emits insulation - nothing to splice.';
    return;
  end if;

  if position(old_blk in src) = 0 then
    raise exception '177: the colors anchor was not found in the LIVE get_config body. '
                    'Re-derive it from a fresh pg_get_functiondef dump before applying.';
  end if;

  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- This adds a 15th top-level key, so every tenant's get_config md5 moves. What must NOT move
-- is anything else — check the styles, colors, sizes and layoutItems counts, and confirm
-- get_fixtures is byte-identical.
