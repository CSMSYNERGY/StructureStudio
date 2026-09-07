-- 206_electrical_one_list.sql — ONE list of electrical items, one pricing rule.
--
-- Carolyn, 2026-09-03, looking at the Electrical card: "I think we have some duplicates going
-- on here... I don't understand entirely." She was right, and the duplication was mine.
--
-- 180 shipped the three package devices (outlet / lightSwitch / lightFixture) as
-- layout_item_types priced through layout_item_pricing — ONE rate each. 181 then shipped a
-- builder's own items in electrical_items with TWO prices, because (her rule) adding something
-- while an electrician is already on site is a different job from a special trip for it.
--
-- That left two systems answering the same question, with different rules — and the three
-- devices were the ones NOT following the rule she had just given. An extra outlet is exactly
-- as much "a second trip" as an extra ceiling fan. Worse, a customer without the package could
-- still place outlets from the palette, so those three WERE being sold standalone, at the
-- single with-package-shaped rate.
--
-- So: electrical_items becomes the only list. The three devices join it as ordinary rows with
-- two prices like everything else, and electrical_settings simply POINTS at which item the
-- auto-layout should use for outlets, for the switch and for lights.
--
-- The uniform rule this buys, which is the real prize:
--     price(item)  = package ? price_with_package : price_standalone
--     charge(item) = max(0, placed - (item is one the package lays out ? autoCount : 0)) * price
-- One expression covers every electrical thing. "Removing one doesn't discount it" still falls
-- out of the max(0, …), exactly as before.
--
-- SAFE TO RESTRUCTURE RATHER THAN MIGRATE: verified before writing this that NO design anywhere
-- has ever placed one of the three devices or a custom electrical item, and that
-- structure-studio (CSM's own test tenant) is the only tenant with any electrical rows at all.
-- Electrical reached beta yesterday and no builder has used it. There is no legacy shape to
-- preserve, so this deletes rather than dual-writes.

begin;

-- ── 1. Which item does the auto-layout use for each device? ──────────────────
-- Nullable on purpose: a builder who has not chosen one simply gets no devices of that kind
-- laid out, rather than the package inventing one. ON DELETE SET NULL so removing an item can
-- never leave a pointer at a row that is gone.
alter table public.electrical_settings
  add column if not exists outlet_item_id uuid references public.electrical_items(id) on delete set null,
  add column if not exists switch_item_id uuid references public.electrical_items(id) on delete set null,
  add column if not exists light_item_id  uuid references public.electrical_items(id) on delete set null;

comment on column public.electrical_settings.outlet_item_id is
  'Which electrical_items row the package lays out at outlet_spacing_ft. NULL = lay out no outlets. The package COVERS this many of that item; extras beyond are charged at its normal price.';

-- ── 2. Carry the three devices over as real items ────────────────────────────
-- Their existing rate becomes price_with_package (it was only ever charged as an add-on to a
-- package). price_standalone is left NULL — NOT copied — because nobody has ever decided what
-- an outlet costs on its own, and guessing it equals the with-package price is exactly the
-- conflation this migration exists to remove. NULL reads as "not offered that way" until the
-- builder sets it, which is the honest state.
insert into public.electrical_items
  (client_id, name, icon, mount, height_off_floor_in, price_with_package, price_standalone, sort_order)
select p.client_id,
       case p.item_key when 'outlet' then 'Outlet'
                       when 'lightSwitch' then 'Light Switch'
                       else 'Light' end,
       case p.item_key when 'outlet' then '🔌'
                       when 'lightSwitch' then '🎚️'
                       else '💡' end,
       case p.item_key when 'lightFixture' then 'ceiling' else 'wall' end,
       case p.item_key when 'outlet' then 24
                       when 'lightSwitch' then 48
                       else 96 end,
       p.rate,
       null,
       case p.item_key when 'outlet' then 1 when 'lightSwitch' then 2 else 3 end
  from public.layout_item_pricing p
 where p.item_key in ('outlet', 'lightSwitch', 'lightFixture')
   and p.style_id is null
   and exists (select 1 from public.electrical_settings es where es.client_id = p.client_id)
on conflict (client_id, name) do nothing;

-- Point the standards at them.
update public.electrical_settings es set
  outlet_item_id = coalesce(es.outlet_item_id, (select ei.id from public.electrical_items ei where ei.client_id = es.client_id and ei.name = 'Outlet')),
  switch_item_id = coalesce(es.switch_item_id, (select ei.id from public.electrical_items ei where ei.client_id = es.client_id and ei.name = 'Light Switch')),
  light_item_id  = coalesce(es.light_item_id,  (select ei.id from public.electrical_items ei where ei.client_id = es.client_id and ei.name = 'Light'));

-- ── 3. Retire the layout-item half ───────────────────────────────────────────
-- Nothing is placed and nothing else references these, so they go rather than lingering as a
-- second way to price the same thing. (Compare the doubleDoor retirement, where placed items
-- DID exist and the rate had to stay: here there are none, which is why this is a delete.)
delete from public.layout_item_pricing where item_key in ('outlet', 'lightSwitch', 'lightFixture');
delete from public.client_layout_items  where item_key in ('outlet', 'lightSwitch', 'lightFixture');
delete from public.layout_item_types    where item_key in ('outlet', 'lightSwitch', 'lightFixture');

-- ── 4. get_config: emit the three pointers alongside the standards ───────────
do $mig$
declare
  src text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text; new_blk text;
begin
  old_blk := $anchor$               'panelHeightIn', es.panel_height_in,$anchor$;
  new_blk := $repl$               'panelHeightIn', es.panel_height_in,
               'outletItemId', es.outlet_item_id,
               'switchItemId', es.switch_item_id,
               'lightItemId', es.light_item_id,$repl$;

  if position('outletItemId' in src) > 0 then
    raise notice '206: get_config already emits the device pointers.';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '206: the electrical block was not found in the LIVE get_config body — apply 180 and 181 first.';
  end if;
  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- After this, layoutItems loses three keys for every tenant and the Electrical card has ONE
-- table. A builder who wants outlets sold without a package sets price_standalone on the
-- Outlet row — the field that did not exist before.
