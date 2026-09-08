-- 207_style_cladding.sql — Cladding becomes a builder-configured, priced option.
--
-- NUMBERING: 206 is used TWICE in this folder (206_electrical_one_list, 206_pipeline_card_fields)
-- and the live ledger keys on the timestamp, not the prefix. Check BOTH before adding another.
-- ⚠️ 207 IS THE NEXT FREE PREFIX IN THIS FOLDER BUT NOT IN THE WORLD: the live ledger already
-- carries a timestamp-versioned `214_consume_unlock_after_insert`, applied from a branch this
-- clone has never seen. Reading the folder alone would tell you 208 is free; it is not
-- obviously free, and neither is anything up to 214. Read the ledger too, every time.
--
-- WHAT THIS IS. Carolyn, 2026-09-07: "Move the cladding into options allowing people to select
-- the cladding they use... but keep the cladding as dropdown options as we have it worked into
-- the 3D so make sure you don't lose that."
--
-- Cladding was the one thing a customer picks that a builder could neither configure nor charge
-- for. Four types are hardcoded in the designer (D3_CLADDING: panel / lap / batten / agpanel),
-- every tenant was offered all four, and the pick cost nothing anywhere — submit-estimate did
-- not contain the word, and _shared/attributeLines.ts said so out loud ("visual-only, no price,
-- no estimate line"). The only narrowing lived in a checkbox grid buried in the 3D calibration
-- editor under Settings → Designer, writing building_styles.d3.claddingChoices.
--
-- ⛔ THE FOUR TYPES ARE STILL CLOSED AND THE IDS ARE STILL THE IDS. We ship a texture and a
-- relief profile per type; a builder cannot invent a fifth. What they gain is which ones they
-- SELL, per style, what each COSTS, and what the customer sees it CALLED. The id in
-- designs.selections.cladding is untouched, so d3NormalizeCladding → D3_CLADDING[id] → the 3D
-- renderer receives exactly what it receives today. That is the whole point of the change.
--
-- PER STYLE, not per tenant (Carolyn's call): a Greenhouse and a Lofted Barn do not sell the
-- same siding, and the price differs with the wall area anyway. Same shape as
-- style_wall_heights (172), which this file follows closely.
--
-- ⚠️ THIS RETIRES d3.claddingChoices AS A CONTROL. The seed below reads it ONCE to reproduce
-- today's offered set exactly, and after this migration nothing consults it. The column
-- contents are deliberately left alone — it is one key inside a jsonb blob that a dozen other
-- things read, and sanitizeD3Spec still round-trips it. Two per-style lists deciding one
-- question is the electrical duplication 206 just finished removing; do not reintroduce it.

begin;

create table if not exists public.style_cladding (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  style_id       uuid not null references public.building_styles(id) on delete cascade,
  -- CLOSED SET, enforced here as well as in the browser and the edge function. A row naming a
  -- fifth id would reach D3_CLADDING[id] as undefined and take the 3D wall material with it.
  cladding_id    text not null check (cladding_id in ('panel', 'lap', 'batten', 'agpanel')),
  -- What the customer sees. NULL = the built-in name ("Lap Siding"). DISPLAY ONLY — it must
  -- never reach d3NormalizeCladding, which is why the id is a separate column rather than this
  -- being a renameable key.
  label_override text,
  -- The fixtures contract, unchanged: NULL = not offered on this style, 0 = included at no
  -- charge, > 0 = an upcharge. The seed below writes 0 rather than NULL precisely so that
  -- contract can hold without turning cladding off for every existing tenant.
  rate           numeric check (rate is null or rate >= 0),
  -- Its own CHECK, deliberately NOT the shared public.pricing_method enum. That enum has no
  -- wall-area member — its `sqft_building` is the FOOTPRINT — and cladding is sold by the wall.
  -- Adding a value to an enum five other tables use, to serve one card, is the wrong trade.
  -- wall_sqft = perimeter x wall height, the same geometry insulation's Walls row already uses,
  -- so a taller-wall upgrade is picked up automatically.
  basis          text not null default 'wall_sqft'
                 check (basis in ('wall_sqft', 'lineal_ft', 'each')),
  taxable        boolean not null default true,
  -- Offered in the REP designer, hidden from the customer-facing page. Same rule as wall
  -- heights and layout items: visibility only, it never suppresses a charge.
  internal_only  boolean not null default false,
  active         boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (client_id, style_id, cladding_id)
);

create index if not exists style_cladding_style_idx on public.style_cladding (style_id);

-- Same posture as style_wall_heights: RLS on, owner-scoped SELECT for authenticated, and NO
-- write policy — every write goes through portal-settings on the service role, so the tenant is
-- resolved from the JWT and never trusted from the body. The public designer never reads this
-- table; it arrives via get_config.
alter table public.style_cladding enable row level security;

drop policy if exists style_cladding_owner_read on public.style_cladding;
create policy style_cladding_owner_read on public.style_cladding
  for select to authenticated
  using (client_id = current_client_id());

revoke all on public.style_cladding from anon;

comment on table public.style_cladding is
  'Which cladding types a builder offers per building style, what each costs, and what the customer sees it called. cladding_id is the CLOSED D3_CLADDING set — the 3D renderer keys on it. NULL rate = not offered, 0 = included, > 0 = upcharge.';

comment on column public.style_cladding.label_override is
  'Customer-facing name. Display only — never resolve a cladding id from this.';

-- ── Seed: reproduce today's behaviour exactly ────────────────────────────────
-- Cladding is free and universally offered right now. Cutting straight over to "priced = offered"
-- would switch it OFF for every tenant until they filled in rates, which is a regression dressed
-- as a feature. So every style gets a row per cladding it offers TODAY, at rate 0 = included.
--
-- The WHERE clause is d3CladdingChoicesFor() transcribed into SQL and must stay that way: that
-- function treats an absent key AND a non-array AND an empty list as "all four"
-- ("nothing ticked is a slip, not an instruction"), so the jsonb_typeof test has to cover the
-- first two, and the `? c.id` test naturally yields nothing for an empty array — which is the
-- ONE divergence, and it is unreachable: the editor stores `undefined` rather than [] for both
-- the none-ticked and all-ticked cases, so no row can hold an empty array.
--
-- ⚠️ COALESCE IS LOAD-BEARING, and leaving it out is why the first run of this seed inserted 2
-- rows instead of 150. `bs.d3 -> 'claddingChoices'` is SQL NULL both when d3 is null and when
-- the key is simply absent — which is the ordinary case, 37 styles out of 38 — so
-- `jsonb_typeof(...) <> 'array'` evaluated to NULL, not TRUE, and the row was filtered out.
-- The same trap swallowed the verification query written to catch it: a `<> 'array'` test in
-- the checker excluded exactly the rows it was meant to be counting, and reported zero
-- mismatches against an empty table. Test three-valued logic against a row COUNT, never
-- against a predicate that shares the bug.
insert into public.style_cladding (client_id, style_id, cladding_id, rate, basis, sort_order)
select bs.client_id, bs.id, c.id, 0, 'wall_sqft', c.ord
  from public.building_styles bs
  cross join (values ('panel', 1), ('lap', 2), ('batten', 3), ('agpanel', 4)) as c(id, ord)
 where coalesce(jsonb_typeof(bs.d3 -> 'claddingChoices'), 'absent') <> 'array'
    or bs.d3 -> 'claddingChoices' ? c.id
on conflict (client_id, style_id, cladding_id) do nothing;

-- ── get_config: emit the offered cladding per style ──────────────────────────
-- Spliced, not rewritten — 110's rule: get_config gets rewritten wholesale on branches we
-- cannot see, so pasting a stored body would silently drop whatever landed in between. A
-- drifted body RAISES instead. Same mechanism as 171/172/173/178/180/181/206.
--
-- Keyed by building_styles.key, matching wallHeightOptions, because the browser looks it up by
-- sel.style — which is buildingStyles[].value — and that is the same column.
--
-- ⚠️ WHY THERE IS NO SEPARATE `offered` BOOLEAN, unlike electricalItems (181). There, a row
-- could be offered in one mode and not the other, so "price is null" could not also carry "not
-- offered" once show_pricing nulled it. Here the WHERE clause does that job: a row with no rate
-- is not emitted AT ALL, so an emitted `rate: null` can only ever mean "this tenant hides
-- prices". One meaning per null.
do $mig$
declare
  src      text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk  text;
  new_blk  text;
begin
  old_blk := $anchor$    'wallHeightOptions', coalesce(($anchor$;

  new_blk := $repl$    'claddingOptions', coalesce((
      select jsonb_object_agg(st.key, cl.list)
      from public.building_styles st
      cross join lateral (
        select jsonb_agg(jsonb_build_object(
                 'id', sc.cladding_id,
                 'label', nullif(btrim(coalesce(sc.label_override, '')), ''),
                 'basis', sc.basis,
                 'rate', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then sc.rate else null end,
                 -- ⚠️ CHARGED IS EMITTED SEPARATELY FROM THE RATE, and it is load-bearing — the
                 -- same split 181 had to make for electricalItems. The rate is NULLED when a
                 -- tenant hides prices, so "rate is null" cannot ALSO carry "included at no
                 -- charge". Without this flag a hide-prices tenant would show a cladding line
                 -- on every quote, because every seeded row is 0 and 0 would be indistinguishable
                 -- from hidden. Computed from the real number server-side, always present.
                 'charged', coalesce(sc.rate, 0) > 0)
                 || case when coalesce(sc.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
                 || case when coalesce(sc.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
               order by sc.sort_order, sc.cladding_id) as list
        from public.style_cladding sc
        where sc.style_id = st.id and sc.active and sc.rate is not null
      ) cl
      where st.client_id = cc.client_id and st.active and cl.list is not null), '{}'::jsonb),
    'wallHeightOptions', coalesce(($repl$;

  if position('claddingOptions' in src) > 0 then
    raise notice '207: get_config already emits claddingOptions.';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '207: the wallHeightOptions block was not found in the LIVE get_config body — '
                    'apply 172 first, or re-derive the anchor from a fresh pg_get_functiondef dump.';
  end if;
  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- `label` is emitted as NULL rather than the built-in name when there is no override, so the
-- browser falls back to D3_CLADDING[id].label — one place owns those four strings, and a
-- renamed built-in does not need a data migration.
--
-- After this: config.claddingOptions[styleKey] = [{ id, label|null, basis, rate|null, charged,
-- taxable?: false, internalOnly?: true }], and a style with nothing offered is absent from the
-- map entirely — which the browser reads as "no cladding choice", i.e. builder's standard only.
