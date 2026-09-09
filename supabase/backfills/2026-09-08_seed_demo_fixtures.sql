-- Seed catalog doors + windows for the two DEMO tenants, so that retiring the built-in
-- door/window layout items (222_retire_builtin_doors_windows.sql) does not leave them with
-- no way to place either. Applied live 2026-09-08.
--
-- demo-sheds and pw-demo-barns were the only tenants with singleDoor/doubleDoor/window still
-- switched ON and zero rows in fixture_items. pw-demo-barns is also the tenant the Playwright
-- designer suite drives (tests/e2e/helpers.mjs:16), so without this the suite has no door or
-- window to place.
--
-- Copied from structure-studio's catalog. Two columns are deliberately NULLed rather than
-- copied: fixed_color_id references colors(id) and window_color_ids references
-- window_colors(id), and both of those are the SOURCE tenant's rows — carrying them over
-- would point a demo tenant's fixture at another tenant's palette. Both nulls are states
-- that already occur live (see structure-studio's own 48" Double Barn Door and Slider
-- Window), so no CHECK or FK is strained. image_url is NULLed for the same reason; none of
-- the source rows had one anyway.
--
-- The NOT EXISTS guard makes this re-runnable: it seeds only a tenant that has no door or
-- window fixture at all, so a second run is a no-op rather than a duplicate catalog.

insert into public.fixture_items
  (client_id, category, name, width_in, height_in, price,
   swing_in, swing_out, swing_default, op_right, op_left, op_double, op_slideup, op_default,
   sort_order, active, archived, plan_label, color_mode, has_trim_color,
   fixed_color_id, window_color_ids, sill_in, sill_mode, door_style,
   internal_only, taxable, show_image_on_estimate, image_url)
select t.client_id, f.category, f.name, f.width_in, f.height_in, f.price,
       f.swing_in, f.swing_out, f.swing_default, f.op_right, f.op_left, f.op_double, f.op_slideup, f.op_default,
       f.sort_order, f.active, f.archived, f.plan_label, f.color_mode, f.has_trim_color,
       null, null, f.sill_in, f.sill_mode, f.door_style,
       f.internal_only, f.taxable, f.show_image_on_estimate, null
from public.fixture_items f
cross join (values ('demo-sheds'), ('pw-demo-barns')) as t(client_id)
where f.client_id = 'structure-studio'
  and f.category in ('door', 'window')
  and not exists (select 1 from public.fixture_items x
                  where x.client_id = t.client_id and x.category in ('door', 'window'));

-- Result: 9 fixtures each (5 doors, 4 windows).
