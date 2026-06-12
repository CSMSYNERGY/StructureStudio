-- 007_seed_junior_barns: load Junior Barns' catalog + prices into the 006 tables.
--   * Styles/sizes structure: from the existing client_configs blob.
--   * base_price: GHL "Unpainted" price variant, pulled 2026-06-11.
--   * Paint: modeled as +20% of base (GHL "Painted" = "Unpainted" x1.20 across
--     the whole catalog) -> option 'paint', choice 'painted' = pct_building_price 20.
--   * Layout-item add-ons: from GHL products (Single Door $0, Double Door $200,
--     Window $300, Workbench $25/ft, Ramp $200).
--   * NOT seeded: loft, roughOpening (no GHL price — awaiting Carolyn), and
--     building-style images (still served from the config blob; move to Storage later).
-- Idempotent via ON CONFLICT DO NOTHING. NOT YET APPLIED. Requires 006 first.

-- ── Styles ──────────────────────────────────────────────────────────
insert into public.building_styles (client_id, key, label, sort_order) values
  ('junior-barns','econo','Econo',1),
  ('junior-barns','urban','Urban',2),
  ('junior-barns','northwood','Northwood',3),
  ('junior-barns','farmland','Farmland',4)
on conflict (client_id, key) do nothing;

-- ── Sizes (width/depth parsed from label; base_price = GHL Unpainted) ─
insert into public.building_sizes (style_id, label, width_ft, depth_ft, base_price, sort_order)
select bs.id, v.label, v.w, v.d, v.price, v.ord
from (values
  ('econo','8x8',8,8,4300,1),
  ('econo','8x10',8,10,4600,2),
  ('econo','8x12',8,12,4900,3),
  ('econo','8x14',8,14,5200,4),
  ('econo','8x16',8,16,5500,5),
  ('econo','8x20',8,20,6200,6),
  ('urban','8x8',8,8,4600,1),
  ('urban','8x10',8,10,4900,2),
  ('urban','8x12',8,12,5200,3),
  ('urban','8x14',8,14,5500,4),
  ('urban','8x16',8,16,5800,5),
  ('urban','8x20',8,20,6500,6),
  ('urban','10x12',10,12,6500,7),
  ('urban','10x16',10,16,7250,8),
  ('urban','10x20',10,20,9050,9),
  ('urban','10x24',10,24,10800,10),
  ('urban','12x12',12,12,8100,11),
  ('urban','12x16',12,16,9000,12),
  ('urban','12x20',12,20,10800,13),
  ('urban','12x24',12,24,13000,14),
  ('urban','12x28',12,28,15200,15),
  ('urban','12x32',12,32,17500,16),
  ('northwood','8x8',8,8,5000,1),
  ('northwood','8x10',8,10,5300,2),
  ('northwood','8x12',8,12,5600,3),
  ('northwood','8x14',8,14,5900,4),
  ('northwood','8x16',8,16,6200,5),
  ('northwood','8x20',8,20,NULL,6),   -- price intentionally BLANK: GHL had 8x20=8x16=6200 (wrong); fix in portal
  ('farmland','8x8',8,8,5200,1),
  ('farmland','8x10',8,10,5500,2),
  ('farmland','8x12',8,12,5800,3),
  ('farmland','8x14',8,14,6100,4),
  ('farmland','8x16',8,16,6400,5),
  ('farmland','8x20',8,20,7100,6)
) as v(style_key, label, w, d, price, ord)
join public.building_styles bs
  on bs.client_id = 'junior-barns' and bs.key = v.style_key
on conflict (style_id, label) do nothing;

-- ── Paint option (priced as % of building base) ─────────────────────
insert into public.options (client_id, key, label, type, sort_order) values
  ('junior-barns','paint','Paint Option','counter',1)
on conflict (client_id, key) do nothing;

insert into public.option_choices (option_id, key, label, sort_order)
select o.id, c.key, c.label, c.ord
from public.options o
join (values ('no_paint','No Paint',1), ('painted','Painted',2)) as c(key,label,ord) on true
where o.client_id = 'junior-barns' and o.key = 'paint'
on conflict (option_id, key) do nothing;

-- No Paint = $0 on every style; Painted = +20% of base on every style.
insert into public.option_pricing (option_choice_id, style_id, pricing_method, rate)
select oc.id, bs.id,
  case oc.key when 'painted' then 'pct_building_price'::public.pricing_method
              else 'each'::public.pricing_method end,
  case oc.key when 'painted' then 20 else 0 end
from public.option_choices oc
join public.options o on o.id = oc.option_id and o.client_id = 'junior-barns' and o.key = 'paint'
join public.building_styles bs on bs.client_id = 'junior-barns'
on conflict (option_choice_id, style_id) do nothing;

-- ── Layout-item add-ons (same price on every style) ─────────────────
insert into public.layout_item_pricing (client_id, item_key, style_id, pricing_method, rate)
select 'junior-barns', v.item_key, bs.id, v.method::public.pricing_method, v.rate
from (values
  ('singleDoor','each',0),
  ('doubleDoor','each',200),
  ('window','each',300),
  ('workbench','lineal_ft',25),
  ('ramp','each',200)
) as v(item_key, method, rate)
join public.building_styles bs on bs.client_id = 'junior-barns'
on conflict (client_id, item_key, style_id) do nothing;

-- Loft: $0 on Farmland, $2 per sq ft of the loft on every other style.
insert into public.layout_item_pricing (client_id, item_key, style_id, pricing_method, rate)
select 'junior-barns', 'loft', bs.id, 'sqft_option'::public.pricing_method,
  case bs.key when 'farmland' then 0 else 2 end
from public.building_styles bs
where bs.client_id = 'junior-barns'
on conflict (client_id, item_key, style_id) do nothing;

-- Rough openings: $100 each (no GHL product; price from Carolyn).
insert into public.layout_item_pricing (client_id, item_key, style_id, pricing_method, rate)
select 'junior-barns', 'roughOpening', bs.id, 'each'::public.pricing_method, 100
from public.building_styles bs
where bs.client_id = 'junior-barns'
on conflict (client_id, item_key, style_id) do nothing;
