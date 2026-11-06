-- 310_inventory_shop.sql — the public Online Shop: listed lot buildings, their photos, per-builder
-- shop settings, and the one anon read path that serves them.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('310', '310_inventory_shop') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/310_inventory_shop.sql | npx supabase db query --linked -o csv
--
-- ── NUMBERING (TENTATIVE: RENUMBER AT APPLY) ─────────────────────────────────────────────
-- 306 is held by ss/c1012-csv-import, 309 by the ACH branch, so this is 310. Take the next free
-- number at apply time, renaming this file and every '310' below.
--
-- ── WHY (Carolyn 2026-10-17, from the 2026-10-12 call with Brittney Weis / Midwest Mini Barns) ──
-- Builders want their lot inventory on their own website — branded, with photos, a delivery
-- calculator, an inquiry form per building and (later phases) a cart. Brittney was about to build
-- it in Shopify. Migration 102:201-211 already reserved the shape: a sold unit keeps a SOLD badge
-- for 30 days, and "no anon read path exists yet". This file is that read path.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────────────────
--   1. inventory_units: listed (opt-in, default false — nothing goes public by surprise),
--      show_price_online (per unit, default true), public_title, public_description.
--   2. inventory_unit_photos — many photos per unit, first = cover. Owner read via RLS; every
--      write goes through portal-settings (service role), like every other inventory write.
--   3. shop_settings — one row per builder: on/off, hide-all-prices, deposit rule, GTM id, copy.
--   4. storage bucket inventory-photos — PUBLIC read (the shop is a public page), images only,
--      8 MB cap, no anon/authenticated write policy (uploads use service-role signed URLs).
--   5. captured_leads.inventory_unit_id — which building an inquiry was about.
--   6. get_public_shop(p_client_id) — SECURITY DEFINER, anon-executable. Returns ONLY what a
--      public page may show. NEVER: the master design short_code (it is a load_design capability),
--      sold_by / sold_first_name (buyer identity), estimates, tax config, merchant ids. Price is
--      returned only when the unit's show_price_online is on AND the shop's hide_all_prices is off.

begin;

-- ── 1. Listing fields on the unit ────────────────────────────────────────────────────────
alter table public.inventory_units
  add column listed boolean not null default false,
  add column show_price_online boolean not null default true,
  add column public_title text,
  add column public_description text;
alter table public.inventory_units
  add constraint inventory_units_public_title_len check (public_title is null or char_length(public_title) <= 120),
  add constraint inventory_units_public_description_len check (public_description is null or char_length(public_description) <= 4000);

-- ── 2. Photos ────────────────────────────────────────────────────────────────────────────
create table public.inventory_unit_photos (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  unit_id uuid not null references public.inventory_units(id) on delete cascade,
  -- Object key inside the inventory-photos bucket: '<client_id>/<unit_id>/<uuid>.<ext>'.
  storage_key text not null,
  -- For an AI background change (phase 2): the photo it was made from. Kept so "undo" is free.
  source_photo_id uuid references public.inventory_unit_photos(id) on delete set null,
  ai_edited boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint inventory_unit_photos_key_shape check (storage_key ~ '^[a-z0-9-]+/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  constraint inventory_unit_photos_key_tenant check (split_part(storage_key, '/', 1) = client_id)
);
create index inventory_unit_photos_unit on public.inventory_unit_photos (unit_id, sort_order);
alter table public.inventory_unit_photos enable row level security;
create policy inventory_unit_photos_owner_select on public.inventory_unit_photos
  for select to authenticated using (client_id = current_client_id());

-- ── 3. Shop settings ─────────────────────────────────────────────────────────────────────
create table public.shop_settings (
  client_id text primary key,
  enabled boolean not null default false,
  hide_all_prices boolean not null default false,
  -- What a buyer pays at checkout (phase 4). 'full' = whole price; 'percent' = deposit_value % of
  -- the price; 'flat' = deposit_value whole dollars. allow_pay_in_full lets the buyer choose more.
  deposit_mode text not null default 'percent' check (deposit_mode in ('full','percent','flat')),
  deposit_value numeric(10,2) not null default 10 check (deposit_value >= 0),
  allow_pay_in_full boolean not null default true,
  gtm_container_id text check (gtm_container_id is null or gtm_container_id ~ '^GTM-[A-Z0-9]{4,12}$'),
  heading text check (heading is null or char_length(heading) <= 120),
  intro text check (intro is null or char_length(intro) <= 1000),
  terms_url text check (terms_url is null or (terms_url ~ '^https://' and char_length(terms_url) <= 500)),
  updated_at timestamptz not null default now(),
  constraint shop_settings_percent_range check (deposit_mode <> 'percent' or deposit_value <= 100)
);
alter table public.shop_settings enable row level security;
create policy shop_settings_owner_select on public.shop_settings
  for select to authenticated using (client_id = current_client_id());

-- ── 4. Photo bucket ──────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inventory-photos', 'inventory-photos', true, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 8388608, allowed_mime_types = array['image/jpeg','image/png','image/webp'];
-- No storage.objects policy is added on purpose: public buckets serve reads by URL without one,
-- and every upload is a service-role signed upload URL minted by portal-settings for a key in the
-- builder's own folder.

-- ── 5. Which building an inquiry was about ───────────────────────────────────────────────
alter table public.captured_leads
  add column inventory_unit_id uuid references public.inventory_units(id) on delete set null;

-- ── 6. The public read path ──────────────────────────────────────────────────────────────
create function public.get_public_shop(p_client_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_shop public.shop_settings;
  v_cfg record;
  v_pay boolean;
  v_units jsonb;
  v_photo_base text := 'https://jzeamjbhdrsbygdnphbm.supabase.co/storage/v1/object/public/inventory-photos/';
begin
  if p_client_id is null or p_client_id !~ '^[a-z0-9-]{1,64}$' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_shop from public.shop_settings where client_id = p_client_id;
  if not found or not v_shop.enabled then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select company_name, tagline, logo_url, header_bg, accent_color into v_cfg
    from public.client_configs where client_id = p_client_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select coalesce(cs.payments_online_enabled, false) and cs.cardpointe_merchid is not null
    into v_pay from public.client_settings cs where cs.client_id = p_client_id;

  select coalesce(jsonb_agg(u order by (u->>'sold')::boolean, (u->>'createdAt') desc), '[]'::jsonb) into v_units
  from (
    select jsonb_build_object(
      'id', iu.id,
      'serial', iu.serial,
      'title', nullif(btrim(coalesce(iu.public_title, '')), ''),
      'description', nullif(btrim(coalesce(iu.public_description, '')), ''),
      'style', coalesce(bs.label, d.selections->>'style'),
      'size', d.selections->>'size',
      'roofType', d.selections->>'roofType',
      'roofColor', nullif(d.selections->>'roofColor', ''),
      'bodyColor', nullif(d.paint_colors->>'body', ''),
      'trimColor', nullif(d.paint_colors->>'trim', ''),
      'locationId', l.id,
      'locationName', l.name,
      'locationCity', l.city,
      'locationState', l.state,
      'priceCents', case when iu.show_price_online and not v_shop.hide_all_prices then iu.asking_price_cents end,
      'sold', iu.sale_state = 'sold',
      'soldLabelExpiresAt', case when iu.sale_state = 'sold' and iu.sold_at is not null then iu.sold_at + interval '30 days' end,
      'createdAt', iu.created_at,
      'photos', coalesce((
        select jsonb_agg(v_photo_base || p.storage_key order by p.sort_order, p.created_at)
          from public.inventory_unit_photos p where p.unit_id = iu.id
      ), '[]'::jsonb)
    ) as u
    from public.inventory_units iu
    join public.designs d on d.short_code = iu.design_short_code and d.client_id = iu.client_id
    left join public.builder_locations l on l.id = iu.location_id
    left join public.building_styles bs on bs.client_id = iu.client_id and bs.key = d.selections->>'style'
    where iu.client_id = p_client_id
      and iu.listed
      and (iu.sale_state = 'unsold' or iu.sold_at > now() - interval '30 days')
  ) s;

  return jsonb_build_object(
    'ok', true,
    'clientId', p_client_id,
    'branding', jsonb_build_object(
      'companyName', v_cfg.company_name, 'tagline', v_cfg.tagline, 'logoUrl', v_cfg.logo_url,
      'headerBg', v_cfg.header_bg, 'accentColor', v_cfg.accent_color),
    'shop', jsonb_build_object(
      'heading', v_shop.heading, 'intro', v_shop.intro, 'termsUrl', v_shop.terms_url,
      'gtmContainerId', v_shop.gtm_container_id, 'hideAllPrices', v_shop.hide_all_prices,
      'depositMode', v_shop.deposit_mode, 'depositValue', v_shop.deposit_value,
      'allowPayInFull', v_shop.allow_pay_in_full,
      'paymentsLive', coalesce(v_pay, false)),
    'units', v_units);
end
$$;
revoke execute on function public.get_public_shop(text) from public;
grant execute on function public.get_public_shop(text) to anon, authenticated, service_role;

-- ── THE RECORD ───────────────────────────────────────────────────────────────────────────
select
  '310' as migration,
  exists (select 1 from information_schema.columns where table_schema='public' and table_name='inventory_units' and column_name='listed') as listed_column,
  to_regclass('public.inventory_unit_photos') is not null as photos_table,
  to_regclass('public.shop_settings') is not null as shop_table,
  exists (select 1 from storage.buckets where id='inventory-photos' and public) as bucket,
  has_function_privilege('anon', 'public.get_public_shop(text)', 'execute') as anon_can_read,
  (select count(*) from public.inventory_units where listed)::int as listed_units;

commit;
