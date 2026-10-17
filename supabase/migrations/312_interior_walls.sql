-- 312_interior_walls.sql — Interior walls get their own tab: Settings → Options → Interior →
--                          Interior walls (Interior walls v2, slice 1: data + portal, designer unchanged).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, BEFORE the portal-settings deploy that reads it (its
--    catalog read selects fixture_items.in_partition and the two new tables, so a deploy ahead of
--    this file fails every Options tab's load). Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('312', '312_interior_walls') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- NUMBERING: 306 is held by another branch, and 310 (310_inventory_shop) and 311 (311_shop_requests)
-- are in the folder but not in the ledger; this was written as 311 and renumbered when beta took it.
-- The live ledger's last row on 2026-10-17 was 309. Read the ledger again before applying.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Partition walls shipped on 2026-10-05 (278) as one row on Settings → Options → Interior items. The
-- v2 plan (Carolyn, 2026-10-17) gives builders their own Interior walls tab and customers walls
-- anywhere, on a diagonal, drawn double-line at the stud width, with a covering per side, doors /
-- windows / rough openings in them and electrical on them. This file is the data for the tab:
--   * the builder's standard stud (2x4 or 2x6; owners, admins and reps override it per wall, the
--     customer never sees the choice), a rate per stud size, and how the wall is priced;
--   * the standard height (stud wall height = 'plate', or 'rafters') and whether "To the rafters" is
--     offered at all (slice 2b);
--   * whether rough openings may go in an interior wall (priced at the builder's existing RO rates);
--   * a list of wall coverings the builder owns (181's electrical_items shape);
--   * per door/window "Allowed in interior walls" and per electrical item "Allowed on interior walls".
--
-- ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────────────────
--   PART 1   interior_wall_settings, one row per tenant.
--   PART 2   interior_wall_coverings, the builder's own list.
--   PART 3   fixture_items.in_partition and electrical_items.interior_wall_ok, both boolean not null
--            default TRUE, so every door, window and electrical item offered today stays offered.
--   PART 4   SEED: a tenant that priced the 278 row (layout_item_pricing 'partitionWall', all styles)
--            gets that method and rate as its 2x4 rate, with 2x4 as the standard and the 278 row's
--            taxable / internal-only. The 278 rows stay where they are (rollback, and the designer
--            still reads them until slice 2).
--   PART 5   get_config, SPLICED (207/238 anchor-replace, never rewritten):
--              * a new top-level key `interiorWalls` (shape below), null for a tenant with no row;
--              * electricalItems gain `interiorWallOk: false`, SPARSE: only for an item ticked off,
--                so nothing moves at apply.
--   PART 6   get_fixtures, SPLICED the same way: a door or window gains `inPartition: false`, SPARSE.
--   PART 7   apply-time assertions (they RAISE and abort the transaction).
--   THE RECORD
--
-- get_config.interiorWalls (the 207 cladding rules: one meaning per null):
--   { offered,                     -- the standard stud has a rate. Always present.
--     standardStud: '2x4'|'2x6',
--     studs: { '2x4'?: {rate}, '2x6'?: {rate} },   -- a key per OFFERED size; the rate is nulled
--                                                   -- when the tenant hides prices (show_pricing)
--     method: 'each'|'lineal_ft'|'sqft_option',
--     allowRo, standardHeight: 'plate'|'rafters', allowRafters,
--     coverings: [{ id, name, method, rate|null, charged, taxable?: false, internalOnly?: true }],
--     taxable?: false, internalOnly?: true }
--   A covering is emitted only when ACTIVE and rated (NULL = not offered; 0 = included, charged false).
--
-- ── BLAST RADIUS (read on 2026-10-17, read-only) ─────────────────────────────────────────
-- Two layout_item_pricing rows for 'partitionWall', both all-styles, lineal_ft, $35 (two tenants).
-- No design uses a partition. Every tenant's get_config gains ONE key (interiorWalls); nothing else in
-- it, and nothing in get_fixtures, moves (PART 7 checks both). The designer ignores the new key until
-- slice 2.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────
-- Ship portal-settings without the Interior walls actions and without in_partition in its catalog read
-- FIRST (both fail on the missing objects). Then take the splices back out BEFORE the tables and
-- columns go: neither function tracks what it reads, so a dropped table under the spliced body fails
-- every designer's config load at call time.
--   begin;
--   do $rb$
--   declare src text; a int; b int;
--   begin
--     src := pg_get_functiondef('public.get_config(text)'::regprocedure);
--     a := position($k$    'interiorWalls', ($k$ in src);
--     b := position($k$    'colors', coalesce(($k$ in src);
--     if a > 0 and b > a then src := substr(src, 1, a - 1) || substr(src, b); end if;
--     src := replace(src, $k$|| case when not coalesce(ei.interior_wall_ok, true) then jsonb_build_object('interiorWallOk', false) else '{}'::jsonb end$k$, '');
--     execute src;
--     src := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
--     src := replace(src, $k$|| case when fi.category in ('door', 'window') and not coalesce(fi.in_partition, true) then jsonb_build_object('inPartition', false) else '{}'::jsonb end$k$, '');
--     execute src;
--   end $rb$;
--   drop table if exists public.interior_wall_coverings;
--   drop table if exists public.interior_wall_settings;
--   alter table public.fixture_items drop column if exists in_partition;
--   alter table public.electrical_items drop column if exists interior_wall_ok;
--   delete from supabase_migrations.schema_migrations where version = '312';
--   notify pgrst, 'reload schema';
--   commit;
-- Then check: position('interiorWalls' in pg_get_functiondef('public.get_config(text)'::regprocedure)) = 0
-- and position('inPartition' in pg_get_functiondef('public.get_fixtures(text)'::regprocedure)) = 0.

begin;

-- Every tenant's config and fixtures as they are now, for PART 7 to compare against. Dropped at commit.
create temp table m312_before on commit drop as
  select cc.client_id,
         md5((public.get_config(cc.client_id) - 'interiorWalls')::text) as cfg,
         md5(public.get_fixtures(cc.client_id)::text) as fix
  from public.client_configs cc;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — interior_wall_settings (one row per tenant)
-- ═════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.interior_wall_settings (
  client_id            text primary key,
  -- The builder's standard framing. Owners, admins and reps may override it per wall in the
  -- designer; a customer never sees the choice.
  standard_stud        text not null default '2x4' check (standard_stud in ('2x4', '2x6')),
  -- The three methods a wall's pricing understands (278's set): each, per foot of wall, per square
  -- foot of wall face. Its own CHECK, not the shared pricing_method enum (207's reasoning).
  pricing_method       text not null default 'lineal_ft' check (pricing_method in ('each', 'lineal_ft', 'sqft_option')),
  -- NULL = that size is not offered; 0 = included. Walls are offered only while the STANDARD size
  -- has a rate (portal-settings refuses a blank one; get_config's `offered` says it).
  rate_2x4             numeric check (rate_2x4 is null or rate_2x4 >= 0),
  rate_2x6             numeric check (rate_2x6 is null or rate_2x6 >= 0),
  -- Slice 2b: where a new wall's top stops. 'plate' = level with the exterior wall plate (today's
  -- "full height"); 'rafters' = follows the underside of the roof. A standard of 'rafters' needs
  -- "To the rafters" offered.
  standard_height      text not null default 'plate' check (standard_height in ('plate', 'rafters')),
  allow_rafters        boolean not null default true,
  -- Rough openings in an interior wall, priced at the builder's existing RO rates (Doors / Windows).
  allow_rough_openings boolean not null default true,
  taxable              boolean not null default true,
  -- Rep designer only, hidden from the customer-facing page (style_wall_heights.internal_only).
  internal_only        boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint interior_wall_settings_rafters_chk check (standard_height = 'plate' or allow_rafters)
);

comment on table public.interior_wall_settings is
  'Interior walls (312): the builder''s standard stud, a rate per stud size (NULL = not offered), method, standard height and switches. One row per tenant; written only by portal-settings.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — interior_wall_coverings (the builder's own list; 181's electrical_items shape)
-- ═════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.interior_wall_coverings (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  name           text not null check (length(btrim(name)) between 1 and 60),
  -- sqft_option = per square foot of THAT face (length × height); lineal_ft = per foot of wall;
  -- each = per covered face.
  pricing_method text not null default 'sqft_option' check (pricing_method in ('sqft_option', 'lineal_ft', 'each')),
  -- NULL = not offered; 0 = included at no charge.
  rate           numeric check (rate is null or rate >= 0),
  taxable        boolean not null default true,
  internal_only  boolean not null default false,
  active         boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (client_id, name)
);

create index if not exists interior_wall_coverings_client_idx on public.interior_wall_coverings (client_id, sort_order);

comment on table public.interior_wall_coverings is
  'Interior walls (312): the coverings a builder offers for each face of an interior wall. rate NULL = not offered, 0 = included. Written only by portal-settings.';

-- RLS, 181's posture: owner-scoped SELECT, NO write policy — every write goes through portal-settings
-- on the service role, so the tenant comes from the JWT and is never trusted from the body. anon reads
-- nothing; the designer reads these through get_config.
alter table public.interior_wall_settings enable row level security;
alter table public.interior_wall_coverings enable row level security;

drop policy if exists interior_wall_settings_owner_read on public.interior_wall_settings;
create policy interior_wall_settings_owner_read on public.interior_wall_settings
  for select to authenticated
  using (client_id = current_client_id());

drop policy if exists interior_wall_coverings_owner_read on public.interior_wall_coverings;
create policy interior_wall_coverings_owner_read on public.interior_wall_coverings
  for select to authenticated
  using (client_id = current_client_id());

revoke all on public.interior_wall_settings from anon;
revoke all on public.interior_wall_coverings from anon;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the two "allowed in / on interior walls" ticks
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 289's in_door precedent, defaulting TRUE so today's behaviour holds: every floor-standing door and
-- every window is offered in an interior wall, and every electrical item may go on one. The column is
-- read for doors and windows only; a ramp or vent carries the default and nothing reads it.
alter table public.fixture_items add column if not exists in_partition boolean not null default true;
comment on column public.fixture_items.in_partition is
  'Interior walls (312): this door or window may be placed in an interior wall. Default true. get_fixtures sends inPartition: false only when unticked.';

alter table public.electrical_items add column if not exists interior_wall_ok boolean not null default true;
comment on column public.electrical_items.interior_wall_ok is
  'Interior walls (312): this item may be placed on an interior wall. Default true. get_config sends interiorWallOk: false only when unticked.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — SEED from the 278 rows
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The all-styles row only (style_id is null), and only the three methods a wall understands (portal-
-- settings never let another be saved for it). `on conflict do nothing`: a re-apply never overwrites a
-- tab the builder has since saved.
insert into public.interior_wall_settings (client_id, standard_stud, pricing_method, rate_2x4, taxable, internal_only)
select lp.client_id, '2x4', lp.pricing_method::text, lp.rate,
       coalesce(cli.taxable, true), coalesce(cli.internal_only, false)
from public.layout_item_pricing lp
left join public.client_layout_items cli on cli.client_id = lp.client_id and cli.item_key = 'partitionWall'
where lp.item_key = 'partitionWall' and lp.style_id is null and lp.rate is not null
  and lp.pricing_method::text in ('each', 'lineal_ft', 'sqft_option')
on conflict (client_id) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — get_config: interiorWalls, and interiorWallOk on electricalItems
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $m312_cfg$
declare
  src     text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text;
  new_blk text;
begin
  -- (a) electricalItems: interiorWallOk, sparse. Anchored on 181's internalOnly merge, which is the
  --     only `ei.internal_only` in the body.
  if position('interiorWallOk' in src) = 0 then
    old_blk := $anchor$|| case when ei.internal_only then jsonb_build_object('internalOnly', true) else '{}'::jsonb end$anchor$;
    new_blk := $repl$|| case when ei.internal_only then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
             || case when not coalesce(ei.interior_wall_ok, true) then jsonb_build_object('interiorWallOk', false) else '{}'::jsonb end$repl$;
    if position(old_blk in src) = 0 then
      raise exception '312: the electricalItems internalOnly merge (181) was not found in the LIVE get_config body — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
    end if;
    src := replace(src, old_blk, new_blk);
  else
    raise notice '312: get_config already emits interiorWallOk';
  end if;

  -- (b) interiorWalls, before colors (181's anchor). Prices follow show_pricing; `offered` and the
  --     studs' keys do not, so a hide-prices tenant still knows WHAT is offered (181's split).
  if position('interiorWalls' in src) = 0 then
    old_blk := $anchor2$    'colors', coalesce(($anchor2$;
    new_blk := $repl2$    'interiorWalls', (
      select jsonb_build_object(
               'offered', case iw.standard_stud when '2x6' then iw.rate_2x6 is not null else iw.rate_2x4 is not null end,
               'standardStud', iw.standard_stud,
               'studs', (case when iw.rate_2x4 is not null
                              then jsonb_build_object('2x4', jsonb_build_object('rate',
                                     case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then iw.rate_2x4 else null end))
                              else '{}'::jsonb end)
                     || (case when iw.rate_2x6 is not null
                              then jsonb_build_object('2x6', jsonb_build_object('rate',
                                     case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then iw.rate_2x6 else null end))
                              else '{}'::jsonb end),
               'method', iw.pricing_method,
               'allowRo', iw.allow_rough_openings,
               'standardHeight', iw.standard_height,
               'allowRafters', iw.allow_rafters,
               'coverings', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', iwc.id, 'name', iwc.name, 'method', iwc.pricing_method,
                          'rate', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then iwc.rate else null end,
                          'charged', coalesce(iwc.rate, 0) > 0)
                        || case when coalesce(iwc.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
                        || case when coalesce(iwc.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
                        order by iwc.sort_order, iwc.name)
                 from public.interior_wall_coverings iwc
                 where iwc.client_id = cc.client_id and iwc.active and iwc.rate is not null), '[]'::jsonb))
             || case when coalesce(iw.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
             || case when coalesce(iw.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
      from public.interior_wall_settings iw where iw.client_id = cc.client_id),
    'colors', coalesce(($repl2$;
    if position(old_blk in src) = 0 then
      raise exception '312: the colors anchor (181) was not found in the LIVE get_config body — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
    end if;
    src := replace(src, old_blk, new_blk);
  else
    raise notice '312: get_config already emits interiorWalls';
  end if;

  execute src;
end
$m312_cfg$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 6 — get_fixtures: inPartition, sparse
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Anchored on 289's inDoor merge, one line, no line ending: the live body was applied with CRLF.
do $m312_fix$
declare
  src     text := pg_get_functiondef('public.get_fixtures(text)'::regprocedure);
  old_blk text := $anchor$|| case when fi.category = 'window' and coalesce(fi.in_door, false)$anchor$;
  new_blk text := $repl$|| case when fi.category in ('door', 'window') and not coalesce(fi.in_partition, true) then jsonb_build_object('inPartition', false) else '{}'::jsonb end
    || case when fi.category = 'window' and coalesce(fi.in_door, false)$repl$;
begin
  if position('inPartition' in src) > 0 then
    raise notice '312: get_fixtures already emits inPartition';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '312: the inDoor merge (289) was not found in the LIVE get_fixtures body — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
  end if;
  execute replace(src, old_blk, new_blk);
end
$m312_fix$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 7 — apply-time assertions
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $check$
declare
  v_n     int;
  r       record;
  got     jsonb;
begin
  -- 1. Both tables are RLS'd, with the owner read and no write policy.
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('interior_wall_settings', 'interior_wall_coverings') and c.relrowsecurity;
  if v_n <> 2 then
    raise exception '312: row level security is not on for both interior wall tables';
  end if;
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename in ('interior_wall_settings', 'interior_wall_coverings') and cmd <> 'SELECT';
  if v_n > 0 then
    raise exception '312: an interior wall table has a write policy; every write goes through portal-settings';
  end if;

  -- 2. The two ticks: boolean, not null, default true, so nothing offered today stops being offered.
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public'
     and ((table_name = 'fixture_items' and column_name = 'in_partition')
       or (table_name = 'electrical_items' and column_name = 'interior_wall_ok'))
     and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'true';
  if v_n <> 2 then
    raise exception '312: fixture_items.in_partition and electrical_items.interior_wall_ok should both be boolean not null default true';
  end if;

  -- 3. Every tenant that priced the 278 row has its settings row, 2x4 offered.
  select count(*) into v_n
  from public.layout_item_pricing lp
  where lp.item_key = 'partitionWall' and lp.style_id is null and lp.rate is not null
    and lp.pricing_method::text in ('each', 'lineal_ft', 'sqft_option')
    and not exists (select 1 from public.interior_wall_settings iw where iw.client_id = lp.client_id);
  if v_n > 0 then
    raise exception '312: % tenant(s) priced a partition wall but have no interior_wall_settings row', v_n;
  end if;

  -- 4. Nothing else in any tenant's get_config or get_fixtures moved.
  select count(*) into v_n from m312_before b
   where b.cfg is distinct from md5((public.get_config(b.client_id) - 'interiorWalls')::text)
      or b.fix is distinct from md5(public.get_fixtures(b.client_id)::text);
  if v_n > 0 then
    raise exception '312: get_config (outside interiorWalls) or get_fixtures changed for % tenant(s); this migration must move nothing else', v_n;
  end if;

  -- 5. Every tenant's get_config carries the key: null without a row, the shape above with one.
  for r in select cc.client_id, iw.standard_stud, iw.pricing_method, iw.rate_2x4, iw.rate_2x6
           from public.client_configs cc left join public.interior_wall_settings iw on iw.client_id = cc.client_id
  loop
    got := public.get_config(r.client_id);
    if not (got ? 'interiorWalls') then
      raise exception '312: get_config(%) has no interiorWalls key', r.client_id;
    end if;
    got := got -> 'interiorWalls';
    if r.standard_stud is null then
      if jsonb_typeof(got) <> 'null' then
        raise exception '312: get_config(%) emits interiorWalls % for a tenant with no settings row', r.client_id, got;
      end if;
    elsif got ->> 'standardStud' is distinct from r.standard_stud
       or got ->> 'method' is distinct from r.pricing_method
       or (got ->> 'offered')::boolean is distinct from (case r.standard_stud when '2x6' then r.rate_2x6 is not null else r.rate_2x4 is not null end)
       or ((got -> 'studs') ? '2x4') is distinct from (r.rate_2x4 is not null)
       or ((got -> 'studs') ? '2x6') is distinct from (r.rate_2x6 is not null)
       or jsonb_typeof(got -> 'coverings') is distinct from 'array' then
      raise exception '312: get_config(%) emits interiorWalls as %, which does not match its settings row', r.client_id, got;
    end if;
  end loop;
  raise notice '312: interior wall settings in place; every tenant''s get_config carries interiorWalls and nothing else moved';
end
$check$;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- THE RECORD — `db query` prints only the last statement's rows, so this is what the apply shows.
-- Expect on 2026-10-17: true, <tenant count>, 2, 2, 0, 0.
-- ═════════════════════════════════════════════════════════════════════════════════════════
select (to_regclass('public.interior_wall_settings') is not null and to_regclass('public.interior_wall_coverings') is not null) as tables_ready,
       (select count(*) from public.client_configs) as tenants,
       (select count(*) from public.interior_wall_settings) as settings_rows,
       (select count(*) from public.client_configs cc where (public.get_config(cc.client_id) -> 'interiorWalls' ->> 'offered')::boolean) as walls_offered,
       (select count(*) from public.fixture_items where not in_partition) as fixtures_not_in_walls,
       (select count(*) from public.electrical_items where not interior_wall_ok) as electrical_not_on_walls;

commit;
