-- 086_style_d3: give every building style a real home for its 3D appearance spec.
--
-- WHY: the per-style d3 spec (roof type/pitch/overhang, siding, unpainted colors, wall
-- height) is what makes a tenant's 3D look like THEIR buildings instead of a generic
-- gable. The save path for it has been dead the whole time: admin-save-settings'
-- save_style_d3 read and wrote `client_configs.config`, a jsonb column that no longer
-- exists (dropped back in 020) -- so every calibration 404'd -- and get_config never
-- emitted a d3 key anyway, so even a stored spec could not reach a customer's browser.
-- Every tenant has therefore been rendering built-in defaults, and junior-barns only
-- looks right because its four style keys happen to match the four built-in names.
--
-- Columns on building_styles (not a config blob): styles are already per-tenant rows
-- with a unique (client_id, key), the portal edits them there, and this survives the
-- coming sheds/post-frame split without another migration.
--
-- ADDITIVE AND BACKWARD-COMPATIBLE, which matters because this database serves main,
-- beta and beta-2.0 at once: the columns are nullable, get_config OMITS the new keys
-- when they are null (matching how 083 omits doorSnap/archived/internalOnly), and a
-- designer that has never heard of `d3` ignores an extra key. Nothing about the
-- existing payload shape changes.
--
-- ⚠️ The get_config body below is copied from **083**, not 081 — 083 is what is live
-- (it added the internalOnly tag to layoutItems). Rebuilding this from 081 would have
-- silently reverted that and un-hidden internal-only palette items for every tenant.
-- Before ever replacing get_config again: diff
-- `pg_get_functiondef('public.get_config(text)'::regprocedure)` against the migration
-- you are about to base it on, and confirm which NNN actually owns the live body.
--
-- HAND-APPLY via MCP apply_migration; record in the ledger. Never `supabase db push`.

alter table public.building_styles
  add column if not exists d3        jsonb,   -- { roof:{type,pitch,ridgeOffset,overhang,kneeU,kneeRise,ridgeRise}, siding, colors:{body,trim,roof}, wallHeightFt }
  add column if not exists d3_photos jsonb;   -- up to 4 reference photo URLs the spec was calibrated against

-- get_config: byte-identical to the LIVE (083) body except the per-style object now
-- carries d3/d3Photos when present. Keys are absent (not null) when unset.
create or replace function public.get_config(p_client_id text)
returns jsonb language sql stable security definer set search_path to ''
as $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,
    'branding', jsonb_build_object('companyName', cc.company_name, 'tagline', cc.tagline,
      'logo', cc.logo_url, 'headerBg', cc.header_bg, 'accentColor', cc.accent_color),
    'contactFields', cc.contact_fields,
    'defaultSizes',  cc.default_sizes,
    'options',       cc.options,
    'buildingStyles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'value', st.key, 'label', st.label, 'img', st.image_url,
               'sizes', coalesce((select jsonb_agg(sz.label order by sz.sort_order, sz.label)
                                  from public.building_sizes sz
                                  where sz.style_id = st.id and sz.active), '[]'::jsonb),
               'sizeInclusions', coalesce((
                 select jsonb_object_agg(s2.label, inc.keys)
                 from public.building_sizes s2
                 cross join lateral (
                   select coalesce(jsonb_agg(bsi.item_key order by bsi.item_key), '[]'::jsonb) as keys
                   from public.building_size_inclusions bsi
                   where bsi.size_id = s2.id and bsi.included
                     and not exists (select 1 from public.client_layout_items cli
                                     where cli.client_id = cc.client_id and cli.item_key = bsi.item_key and cli.archived)
                     and not exists (select 1 from public.fixture_items fi
                                     where fi.client_id = cc.client_id and fi.id::text = bsi.item_key and fi.archived)
                 ) inc
                 where s2.style_id = st.id and s2.active and jsonb_array_length(inc.keys) > 0
               ), '{}'::jsonb),
               'sizeInclusionQty', coalesce((
                 select jsonb_object_agg(s2.label, inc.qmap)
                 from public.building_sizes s2
                 cross join lateral (
                   select jsonb_object_agg(bsi.item_key, coalesce(bsi.qty, 1)) as qmap
                   from public.building_size_inclusions bsi
                   where bsi.size_id = s2.id and bsi.included
                     and not exists (select 1 from public.client_layout_items cli
                                     where cli.client_id = cc.client_id and cli.item_key = bsi.item_key and cli.archived)
                     and not exists (select 1 from public.fixture_items fi
                                     where fi.client_id = cc.client_id and fi.id::text = bsi.item_key and fi.archived)
                 ) inc
                 where s2.style_id = st.id and s2.active and inc.qmap is not null
               ), '{}'::jsonb))
               || case when st.d3 is not null then jsonb_build_object('d3', st.d3) else '{}'::jsonb end
               || case when st.d3_photos is not null and jsonb_typeof(st.d3_photos) = 'array'
                            and jsonb_array_length(st.d3_photos) > 0
                       then jsonb_build_object('d3Photos', st.d3_photos) else '{}'::jsonb end
             order by st.sort_order, st.label)
      from public.building_styles st
      where st.client_id = cc.client_id and st.active), '[]'::jsonb),
    'layoutItems', coalesce((
      select jsonb_object_agg(cli.item_key,
               jsonb_build_object(
                 'label', coalesce(cli.label_override, lt.label),
                 'icon', lt.icon, 'color', lt.color,
                 'width',  coalesce(cli.width_override,  lt.default_width),
                 'height', coalesce(cli.height_override, lt.default_height),
                 'shortLabel', coalesce(cli.short_label_override, lt.short_label),
                 'wallOnly', lt.wall_only, 'wallSnap', lt.wall_snap)
               || case when lt.door_snap then jsonb_build_object('doorSnap', true) else '{}'::jsonb end
               || case when coalesce(cli.archived, false) then jsonb_build_object('noPalette', true, 'archived', true) else '{}'::jsonb end
               || case when coalesce(cli.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end)
      from public.client_layout_items cli
      join public.layout_item_types lt on lt.item_key = cli.item_key and lt.active
      where cli.client_id = cc.client_id and (cli.active or coalesce(cli.archived, false))), '{}'::jsonb),
    'colors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'label', c.label,
               'siding', c.siding, 'trim', c.trim,
               'shingle', c.shingle, 'metal', c.metal,
               'allowCustom', c.allow_custom, 'isDefault', c.is_default,
               'hex', c.hex, 'swatch', c.image_url,
               'rate', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then c.rate else null end,
               'pricingMethod', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then c.pricing_method::text else null end)
             order by c.sort_order, c.label)
      from public.colors c
      where c.client_id = cc.client_id and c.active), '[]'::jsonb),
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),
    'layoutPrices', case
      when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
      then coalesce((select jsonb_object_agg(lp.item_key, lp.rate)
                     from public.layout_item_pricing lp
                     where lp.client_id = cc.client_id and lp.style_id is null), '{}'::jsonb)
      else '{}'::jsonb end,
    'layoutPricing', case
      when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
      then coalesce((
        select jsonb_object_agg(k.item_key, jsonb_build_object(
                 'rate',   coalesce(dflt.rate, 0),
                 'method', coalesce(dflt.pricing_method, 'each'),
                 'byStyle', coalesce(bystyle.map, '{}'::jsonb)))
        from (select distinct item_key from public.layout_item_pricing where client_id = cc.client_id) k
        left join lateral (
          select lp2.rate, lp2.pricing_method
          from public.layout_item_pricing lp2
          where lp2.client_id = cc.client_id and lp2.item_key = k.item_key and lp2.style_id is null
          limit 1
        ) dflt on true
        left join lateral (
          select jsonb_object_agg(st2.key, jsonb_build_object('rate', o.rate, 'method', o.pricing_method)) as map
          from public.layout_item_pricing o
          join public.building_styles st2 on st2.id = o.style_id
          where o.client_id = cc.client_id and o.item_key = k.item_key and o.style_id is not null
        ) bystyle on true
      ), '{}'::jsonb)
      else '{}'::jsonb end,
    'sizePricing', case
      when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
      then coalesce((
        select jsonb_object_agg(st.key, sizes.map)
        from public.building_styles st
        cross join lateral (
          select jsonb_object_agg(sz.label, jsonb_build_object(
                   'basePrice', sz.base_price, 'widthFt', sz.width_ft, 'lengthFt', sz.length_ft)) as map
          from public.building_sizes sz
          where sz.style_id = st.id and sz.active
        ) sizes
        where st.client_id = cc.client_id and st.active and sizes.map is not null
      ), '{}'::jsonb)
      else '{}'::jsonb end
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;
$function$;
-- junior-barns: persist the four specs the app has been inferring from style NAMES, so
-- the tenant stops depending on that coincidence and the save path has real data to
-- prove itself against. Values are D3_STYLE_DEFAULTS verbatim, so nothing renders
-- differently -- d3ResolveStyleSpec already merges config over those same defaults.
-- Note the keys are capitalised in this tenant (Econo/Urban/...) while the built-in
-- lookup lowercases, hence the lower() match. Only fills NULLs: an operator's later
-- calibration must never be clobbered by re-running this.
update public.building_styles st set d3 = v.spec::jsonb
from (values
  ('econo',     '{"roof":{"type":"shed","pitch":0.25,"overhang":0.35},"siding":null,"colors":{}}'),
  ('urban',     '{"roof":{"type":"gable","pitch":0.33,"overhang":0.85},"siding":null,"colors":{"body":"#D6CCB6","trim":"#575044","roof":"#3E434A"}}'),
  ('northwood', '{"roof":{"type":"gable","pitch":0.55,"overhang":0.6},"siding":"batten","colors":{"body":"#C7B183","roof":"#4E5560"}}'),
  ('farmland',  '{"roof":{"type":"gambrel","kneeU":0.55,"kneeRise":0.55,"ridgeRise":0.8,"overhang":0.5},"siding":"batten","colors":{"body":"#C2A377","trim":"#8A6F4D","roof":"#5D5348"}}')
) as v(key, spec)
where st.client_id = 'junior-barns' and lower(st.key) = v.key and st.d3 is null;

-- Per-tenant ledger for the AI calibration call (photos -> draft spec). The call costs
-- real money per invocation, and it is about to become builder-reachable rather than
-- operator-only, so it needs a countable record. Service-role only: RLS on with no
-- policies at all (046_admin_audit posture).
create table if not exists public.ai_style_calls (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  user_id    uuid,          -- the resolved caller, for audit; never used to gate
  style_key  text,
  called_at  timestamptz not null default now()
);
create index if not exists ai_style_calls_client_idx on public.ai_style_calls (client_id, called_at desc);
alter table public.ai_style_calls enable row level security;

-- Cap the two image buckets the portal writes to. Both have carried NULL/NULL since
-- they were created -- the same hole 071 closed on floor-plans -- so a service-role
-- upload could put a file of any size or type behind a public URL. 5 MB sits above the
-- 3 MB in-function caps on purpose (the function should be the thing that refuses, with
-- a readable message; the bucket is the backstop), and the MIME list is exactly what
-- update_style / upload_fixture_image / upload_style_photo accept.
update storage.buckets
   set file_size_limit    = 5242880,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif']
 where id in ('branding', 'fixtures');
