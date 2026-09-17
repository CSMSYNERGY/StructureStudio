-- 246_avalara_tax_codes.sql — the platform's list of Avalara tax codes, and which code each
-- builder puts on each thing they sell.
--
-- APPLY BY HAND through the SQL editor, as the owner, then record version 246 in
-- supabase_migrations.schema_migrations. NEVER `supabase db push`. Not as a whole file inline
-- from the CLI: "<newline>$(cat …)" was refused as an EMPTY query when 242 was applied (see
-- 242_lead_sms_consent_box.sql), and inside a double-quoted bash string `$probe$` expands to
-- nothing. Exit codes prove nothing either way — read it back:
--   select to_regclass('public.avalara_tax_codes'), to_regclass('public.tax_code_assignments'); -- both not null
--   select count(*) from public.avalara_tax_codes where source = 'seed';                          -- 12 on a fresh apply
-- The probe at the bottom runs inside the transaction and aborts the whole file if any property
-- below does not hold, so a failed apply leaves the database exactly as it was. Independent of
-- 244 and 245; either may be applied first.
--
-- ── WHY ───────────────────────────────────────────────────────────────────────────────────
-- The owner's ask (2026-09-14): every product, its installation and its delivery each carry a
-- tax code; Avalara provides the codes, and every builder codes their own. This file stores the
-- codes and the mapping. NOTHING HERE CHANGES ANY QUOTE'S TAX — the rate is still one rate over
-- one taxable base, and using a code per line is a later stage.
--
-- 1. public.avalara_tax_codes — the PLATFORM catalog, not tenant data. Avalara's system codes
--    are the same for every account (ListTaxCodes, GET /api/v2/definitions/taxcodes), so one
--    copy serves every builder's picker without a live call per keystroke.
--      code          the primary key, uppercase letters and digits up to 25 — Avalara's line
--                    taxCode limit, and _shared/taxCodes.ts normalizeTaxCode's shape.
--      description   Avalara's, capped (taxCodes.ts clips to the same 1000 before an upsert).
--      type_id       taxCodeTypeId: P product, S service, F freight, O other, D digital,
--                    U unknown. Checked for shape only — a new letter from Avalara must not fail
--                    a whole sync chunk. NULL on the seed rows: the public list gives goods or
--                    services, not the type letter, and the first sync fills the real value.
--      parent_code   parentTaxCode, same shape as code, no foreign key (a sync upserts in
--                    chunks, so a child can arrive before its parent).
--      is_active     Avalara's "can be used in transactions"; a code missing from a COMPLETE
--                    sync is also set false. Codes are NEVER deleted: an assignment may point
--                    at one, and the key below refuses the delete.
--      north_america false when the description says "not applicable to north america" (the
--                    VAT codes), so a builder's search is not buried in them.
--      source        'seed' for the starter rows below, 'avalara' once a sync has written it.
--      synced_at     when a sync last wrote the row. Null on a seed row never synced.
--    Seeded with the starter set (COMMON_CODES in _shared/taxCodes.ts, same order) so the tab
--    works before any sync; descriptions are Avalara's own wording, read from its public tax code
--    list on 2026-09-17. `on conflict do nothing`, so a re-run never overwrites a synced row.
--
-- 2. public.tax_code_assignments — per tenant: one code per thing.
--      (client_id, target_type, target_key) is the primary key, so a second code for the same
--      building style or option heading cannot be stored — structural, not a rule a caller must
--      remember. target_type 'style' keys on building_styles.id as text (lowercase uuid);
--      'heading' keys on a heading from TAX_HEADINGS in _shared/taxCodes.ts. The heading LIST is
--      deliberately not repeated here: qbo_item_map keeps its line kinds in a CHECK, a server set
--      and a portal array, and the server set drifted, silently skipping seven kinds' saves. The
--      CHECK below tests shape only; portal-settings validates the key.
--      No foreign key to building_styles: target_key is shared by two kinds of target. A deleted
--      style's row is hidden by tax_codes_get and dropped by the next save.
--      tax_code references avalara_tax_codes(code): an unknown code is refused by the database.
--      updated_by is the auth user who last changed the row (an operator's own id in view-as),
--      no foreign key, like tax_lookups.actor_user_id.
--    No separate (client_id) index: the primary key leads with client_id and already serves
--    every `where client_id = …` read this table gets.
--
-- Both tables are SERVICE-ROLE ONLY: RLS on, zero policies, grants revoked from anon,
-- authenticated AND public — 204_rate_buckets verbatim. The PUBLIC revoke is the one that
-- matters: this project's default privileges make every NEW table world-readable. The builder
-- reads and writes through portal-settings (tax_codes_get / tax_codes_search / tax_codes_save,
-- settings_crm); the operator sync is admin-catalog avalara_sync_tax_codes.
--
-- ── ORDER OF APPLY ────────────────────────────────────────────────────────────────────────
-- THIS FILE FIRST, then portal-settings and admin-catalog. Deployed before it, the new actions
-- answer "couldn't load your tax codes" and the sync fails on its first upsert; no existing
-- action reads either table.

begin;

-- 1. The catalog.
create table if not exists public.avalara_tax_codes (
  code          text        primary key check (code ~ '^[A-Z0-9]{1,25}$'),
  description   text        not null check (char_length(description) <= 1000),
  type_id       text        check (type_id is null or type_id ~ '^[A-Z]{1,2}$'),
  parent_code   text        check (parent_code is null or parent_code ~ '^[A-Z0-9]{1,25}$'),
  is_active     boolean     not null default true,
  north_america boolean     not null default true,
  source        text        not null default 'seed' check (source in ('seed', 'avalara')),
  synced_at     timestamptz
);

alter table public.avalara_tax_codes enable row level security;

-- No policies → service_role only. Revoke PUBLIC explicitly (see the header).
revoke all on public.avalara_tax_codes from public;
revoke all on public.avalara_tax_codes from anon, authenticated;

comment on table public.avalara_tax_codes is
  'Migration 246. The platform catalog of Avalara system tax codes (not tenant data). Seeded with a starter set; admin-catalog avalara_sync_tax_codes upserts from ListTaxCodes (source avalara) and never deletes. Service-role only.';
comment on column public.avalara_tax_codes.is_active is
  'Avalara''s isActive, or false when a complete sync no longer lists the code. Rows are never deleted: tax_code_assignments may reference them.';
comment on column public.avalara_tax_codes.north_america is
  'false when Avalara''s description says the code is not applicable to North America. The builder''s search hides those unless asked.';

insert into public.avalara_tax_codes (code, description, source, north_america) values
  ('P0000000', 'Tangible personal property (tpp)',                                                    'seed', true),
  ('NT',       'Non-taxable product',                                                                 'seed', true),
  ('ON030000', 'Non-taxable transaction',                                                             'seed', true),
  ('SI020100', 'Installation-associated with the sale of tpp (equipment/parts and labor) - separately stated', 'seed', true),
  ('SI020200', 'Installation-not associated with the sale of tpp (labor only)',                       'seed', true),
  ('SC150100', 'Construction services relating to real property (original construction)',            'seed', true),
  ('FR010000', 'Delivery by company vehicle',                                                         'seed', true),
  ('FR010100', 'Delivery by company vehicle before passage of title',                                 'seed', true),
  ('FR010200', 'Delivery by company vehicle after passage of title',                                  'seed', true),
  ('FR020100', 'Shipping / common carrier / fob destination',                                         'seed', true),
  ('FR030000', 'Shipping / shipping and handling combined',                                           'seed', true),
  ('OH010000', 'Handling only charges (separately identified from shipping)',                         'seed', true)
on conflict (code) do nothing;

-- 2. The mapping.
create table if not exists public.tax_code_assignments (
  client_id   text        not null check (char_length(client_id) between 1 and 100),
  target_type text        not null check (target_type in ('style', 'heading')),
  target_key  text        not null,
  tax_code    text        not null references public.avalara_tax_codes (code),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (client_id, target_type, target_key),
  -- Shape per type: a style is a lowercase uuid, a heading a short snake_case key.
  constraint tax_code_assignments_target_key_shape check (
    (target_type = 'style'   and target_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (target_type = 'heading' and target_key ~ '^[a-z][a-z_]{0,39}$')
  )
);

alter table public.tax_code_assignments enable row level security;

revoke all on public.tax_code_assignments from public;
revoke all on public.tax_code_assignments from anon, authenticated;

comment on table public.tax_code_assignments is
  'Migration 246. Per tenant: the Avalara tax code on each building style (target_type style, building_styles.id) and option heading (target_type heading, _shared/taxCodes.ts TAX_HEADINGS). One code per target by primary key. Saved as a whole set by portal-settings tax_codes_save. Not yet read by any tax calculation. Service-role only.';

-- 3. The probe. Everything it writes is undone by the ROLLBACK_PROBE exception; any other
--    exception aborts the whole file. A synthetic tenant, nothing real touched.
do $probe$
declare
  n int;
  t text;
  priv text;
begin
  foreach t in array array['public.avalara_tax_codes', 'public.tax_code_assignments'] loop
    foreach priv in array array['select', 'insert', 'update', 'delete'] loop
      if has_table_privilege('anon', t, priv) or has_table_privilege('authenticated', t, priv) then
        raise exception '246 probe: a browser role holds % on %', priv, t;
      end if;
      -- portal-settings and admin-catalog write these as service_role, which keeps its grant
      -- through this project's default privileges (tax_lookups reads the same way live). If that
      -- ever stops being true, fail here rather than on the first save after the deploy.
      if not has_table_privilege('service_role', t, priv) then
        raise exception '246 probe: service_role lacks % on %', priv, t;
      end if;
    end loop;
    if not (select relrowsecurity from pg_catalog.pg_class where oid = t::regclass) then
      raise exception '246 probe: row level security is off on %', t;
    end if;
  end loop;
  select count(*) into n from pg_catalog.pg_policies
   where schemaname = 'public' and tablename in ('avalara_tax_codes', 'tax_code_assignments');
  if n <> 0 then
    raise exception '246 probe: % policies exist on the tax code tables — they are service-role only', n;
  end if;

  select count(*) into n from public.avalara_tax_codes
   where code in ('P0000000', 'NT', 'ON030000', 'SI020100', 'SI020200', 'SC150100',
                  'FR010000', 'FR010100', 'FR010200', 'FR020100', 'FR030000', 'OH010000');
  if n <> 12 then
    raise exception '246 probe: % of the 12 starter codes are present', n;
  end if;

  begin
    insert into public.tax_code_assignments (client_id, target_type, target_key, tax_code)
    values ('probe-246-tenant', 'heading', 'delivery', 'FR010000'),
           ('probe-246-tenant', 'style', '3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c', 'P0000000');

    -- One code per thing: the same target again is refused, whatever the code.
    begin
      insert into public.tax_code_assignments (client_id, target_type, target_key, tax_code)
      values ('probe-246-tenant', 'heading', 'delivery', 'ON030000');
      raise exception '246 probe: a second code for the same target was accepted';
    exception when unique_violation then null;
    end;

    -- A code that is not in the catalog is refused by the key.
    begin
      insert into public.tax_code_assignments (client_id, target_type, target_key, tax_code)
      values ('probe-246-tenant', 'heading', 'doors', 'ZZ999999');
      raise exception '246 probe: an unknown tax code was accepted';
    exception when foreign_key_violation then null;
    end;

    -- An assigned code cannot be deleted out from under the assignment.
    begin
      delete from public.avalara_tax_codes where code = 'FR010000';
      raise exception '246 probe: an assigned tax code was deleted';
    exception when foreign_key_violation then null;
    end;

    -- Shapes: an unknown target type, a style that is not a uuid, a lowercase code.
    begin
      insert into public.tax_code_assignments (client_id, target_type, target_key, tax_code)
      values ('probe-246-tenant', 'line_kind', 'door', 'P0000000');
      raise exception '246 probe: an unknown target_type was accepted';
    exception when check_violation then null;
    end;
    begin
      insert into public.tax_code_assignments (client_id, target_type, target_key, tax_code)
      values ('probe-246-tenant', 'style', 'lofted-barn', 'P0000000');
      raise exception '246 probe: a style target that is not a uuid was accepted';
    exception when check_violation then null;
    end;
    begin
      insert into public.avalara_tax_codes (code, description) values ('p0000001', 'probe');
      raise exception '246 probe: a lowercase tax code was accepted';
    exception when check_violation then null;
    end;
    begin
      insert into public.avalara_tax_codes (code, description, source) values ('PROBE246', 'probe', 'manual');
      raise exception '246 probe: an unknown source was accepted';
    exception when check_violation then null;
    end;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '246: both tables service-role only with RLS and no policies; 12 starter codes; one code per target; unknown codes refused; assigned codes undeletable; shapes checked';
      else
        raise;
      end if;
  end;
end
$probe$;

notify pgrst, 'reload schema';

commit;

-- ROLLBACK:
-- Revert portal-settings (tax_codes_get / tax_codes_search / tax_codes_save) and admin-catalog
-- (avalara_sync_tax_codes) FIRST, or those actions fail on the missing tables. What a rollback
-- loses: every builder's tax code mapping and the synced catalog — export tax_code_assignments
-- first if it holds rows. No quote reads either table, so no document changes.
--
--   begin;
--   drop table if exists public.tax_code_assignments;
--   drop table if exists public.avalara_tax_codes;
--   notify pgrst, 'reload schema';
--   commit;
