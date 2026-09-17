-- 245_location_tax_rates.sql — a tax rate per sales location, and the location a quote was sold
-- from.
--
-- APPLY BY HAND through the SQL editor, as the owner, then record version 245 in
-- supabase_migrations.schema_migrations. NEVER `supabase db push`. Not as a whole file inline
-- from the CLI: "<newline>$(cat …)" was refused as an EMPTY query when 242 was applied (see
-- 242_lead_sms_consent_box.sql), and inside a double-quoted bash string `$probe$` expands to
-- nothing. Exit codes prove nothing either way — read it back:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'designs_sales_location_fk';
--     -- must end in ON DELETE SET NULL (sales_location_id)
-- The probe at the bottom runs inside the transaction and aborts the whole file if any property
-- below does not hold. Independent of 244; either may be applied first.
--
-- ── WHY ───────────────────────────────────────────────────────────────────────────────────
-- The free default rate a quote is taxed at becomes a chain: a verified Avalara rate carried
-- over → the rate of the sales location the quote belongs to → the company rate
-- (client_settings.ss_tax_rate) → refuse. This file adds the two middle links' storage.
--
-- 1. builder_locations.tax_rate numeric(7,5) + tax_label. The builder's LOCAL rate for a lot,
--    as a fraction with the same 0–25% ceiling as ss_tax_rate (158) and the stored Avalara rate.
--    It is right for an origin-sourced state and a guess for a delivery across a state line —
--    the copy that shows it says "your local rate", never "the correct rate". tax_label is
--    capped at 40, the same cap portal-settings puts on ss_tax_label. Both NULL = no location
--    rate, which is every row on apply. Written only by portal-settings (service role):
--    builder_locations has a select policy for the tenant and no write policy (075).
--    A signed-in member of the tenant can SELECT these columns straight off the table through
--    that policy, whatever their area access. That is deliberate rather than overlooked: a
--    location's tax rate is printed on every quote it issues, so it is not a secret — the
--    control that matters is on the WRITE (save_location_tax, settings_crm:edit).
--
-- 2. unique (client_id, id) on builder_locations. `id` alone is the primary key, so no foreign
--    key could say "a location of THIS tenant". The pair is trivially unique (id already is);
--    it exists to be the target of the composite key below.
--
-- 3. designs.sales_location_id uuid — which lot a quote was sold from. Staff set it (a shopper
--    never picks or changes a location). The foreign key is COMPOSITE,
--    (client_id, sales_location_id) → builder_locations (client_id, id), so a design can only
--    ever point at a location of its own tenant — checked by the database, not by each caller.
--    ON DELETE SET NULL (sales_location_id) — THE COLUMN LIST IS REQUIRED. A plain SET NULL on
--    a composite key nulls EVERY referencing column, client_id included; designs.client_id is
--    NOT NULL, so deleting a location with a quote on it would fail outright (and on a table
--    without that constraint it would orphan the design from its tenant). Postgres 15+; live
--    is 17.6. Partial index on the referencing pair, which is also what the delete-time lookup
--    uses.
--
-- ── WHAT IT LEAVES ALONE (checked read-only on live, 2026-09-17) ───────────────────────────
-- Column types: builder_locations.id uuid, builder_locations.client_id text NOT NULL,
-- designs.client_id text NOT NULL — the composite key's pairs match.
-- save_design (the anon RPC) inserts and upserts an EXPLICIT column list that does not name
-- sales_location_id, so a browser can neither set the column nor clobber it on a re-save. It
-- `returning *` into a designs row and returns it, and load_design returns
-- jsonb_populate_record over to_jsonb(d); both pick the new column up without a signature
-- change, so the holder of a short code can read the uuid of the lot — an opaque id, the same
-- exposure inventory_unit_id already has. No other function inserts designs or reads
-- builder_locations. designs has select policies only; its writes go through service role.
-- Portal reads designs through its existing RLS'd select, which now carries the column.
--
-- Nothing reads either column until portal-settings / submit-estimate are deployed with the
-- rate chain, so this file alone changes no quote.

begin;

-- 1. The location rate.
alter table public.builder_locations
  add column if not exists tax_rate  numeric(7,5),
  add column if not exists tax_label text;

alter table public.builder_locations drop constraint if exists builder_locations_tax_rate_range;
alter table public.builder_locations
  add constraint builder_locations_tax_rate_range
  check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 0.25));

alter table public.builder_locations drop constraint if exists builder_locations_tax_label_length;
alter table public.builder_locations
  add constraint builder_locations_tax_label_length
  check (tax_label is null or char_length(tax_label) <= 40);

comment on column public.builder_locations.tax_rate is
  'Migration 245. This lot''s local sales tax rate as a FRACTION (0.0725 = 7.25%). NULL = none; quotes from this lot use the company rate. Set in settings (save_location_tax). A local rate, not a verified one.';
comment on column public.builder_locations.tax_label is
  'Migration 245. What the tax row is called on a quote taxed at this lot''s rate. NULL = the company label.';

-- 2 + 3. The link. Dropped in dependency order first so a re-run rebuilds cleanly: the foreign
-- key depends on the unique constraint.
alter table public.designs
  add column if not exists sales_location_id uuid;

alter table public.designs drop constraint if exists designs_sales_location_fk;
alter table public.builder_locations drop constraint if exists builder_locations_client_id_id_key;

alter table public.builder_locations
  add constraint builder_locations_client_id_id_key unique (client_id, id);

alter table public.designs
  add constraint designs_sales_location_fk
  foreign key (client_id, sales_location_id)
  references public.builder_locations (client_id, id)
  on delete set null (sales_location_id);

create index if not exists designs_sales_location
  on public.designs (client_id, sales_location_id)
  where sales_location_id is not null;

comment on column public.designs.sales_location_id is
  'Migration 245. The sales location (builder_locations) this quote was sold from; its tax_rate is the quote''s default rate when set. Composite FK with client_id, so it can only name a location of the same tenant; deleting the location nulls this column only. Set by staff through portal-settings; save_design never writes it.';

-- 4. The probe. Everything it writes is undone by the ROLLBACK_PROBE exception; any other
--    exception aborts the whole file. Synthetic tenants, a draft design (the orders trigger
--    ignores drafts), nothing real touched.
do $probe$
declare
  a_loc uuid;
  b_loc uuid;
  got_client text;
  got_loc uuid;
begin
  begin
    insert into public.builder_locations (client_id, name, state, zip, tax_rate, tax_label)
    values ('probe-245-tenant-a', 'Probe lot A', 'MO', '63090', 0.0725, 'Sales tax')
    returning id into a_loc;
    insert into public.builder_locations (client_id, name)
    values ('probe-245-tenant-b', 'Probe lot B')
    returning id into b_loc;

    insert into public.designs (short_code, client_id, bldg_w, bldg_h, status, sales_location_id)
    values ('SS-PROBE244QA', 'probe-245-tenant-a', 10, 12, 'draft', a_loc);

    -- Another tenant's location is refused by the key, not by a caller remembering to check.
    begin
      update public.designs set sales_location_id = b_loc where short_code = 'SS-PROBE244QA';
      raise exception '245 probe: a design was pointed at another tenant''s location';
    exception when foreign_key_violation then null;
    end;

    -- A percent-shaped rate and an over-long label are refused.
    begin
      update public.builder_locations set tax_rate = 7.25 where id = a_loc;
      raise exception '245 probe: a percent-shaped location rate was stored';
    exception when check_violation then null;
    end;
    begin
      update public.builder_locations set tax_label = repeat('x', 41) where id = a_loc;
      raise exception '245 probe: a 41-character tax label was stored';
    exception when check_violation then null;
    end;

    -- Deleting the location nulls the link and ONLY the link.
    delete from public.builder_locations where id = a_loc;
    select client_id, sales_location_id into got_client, got_loc
      from public.designs where short_code = 'SS-PROBE244QA';
    if got_client is distinct from 'probe-245-tenant-a' or got_loc is not null then
      raise exception '245 probe: deleting a location did not null only sales_location_id (client_id %, location %)',
        got_client, got_loc;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '245: location rates are bounded; a design can only name its own tenant''s location; deleting a location nulls only the link';
      else
        raise;
      end if;
  end;
end
$probe$;

commit;

-- ROLLBACK:
-- Revert portal-settings and submit-estimate to builds that do not read these columns FIRST, or
-- their selects fail. What a rollback loses: every design's recorded sales location and every
-- per-location rate (export both first if they hold data). Quotes already issued keep the tax
-- stamped into designs.estimate_lines — that is a snapshot, so no issued document's total moves;
-- the next resubmit of such a quote re-stamps at the company rate.
--
--   begin;
--   drop index if exists public.designs_sales_location;
--   alter table public.designs drop constraint if exists designs_sales_location_fk;
--   alter table public.designs drop column if exists sales_location_id;
--   alter table public.builder_locations drop constraint if exists builder_locations_client_id_id_key;
--   alter table public.builder_locations drop constraint if exists builder_locations_tax_label_length;
--   alter table public.builder_locations drop constraint if exists builder_locations_tax_rate_range;
--   alter table public.builder_locations drop column if exists tax_label;
--   alter table public.builder_locations drop column if exists tax_rate;
--   commit;
