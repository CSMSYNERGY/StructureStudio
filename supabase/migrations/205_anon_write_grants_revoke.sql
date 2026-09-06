-- 205_anon_write_grants_revoke: take INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER away
--                               from `anon` on every table in public.
--
-- APPLY BY HAND (SQL editor / `supabase db query --linked`), then record the version row.
-- NEVER `supabase db push`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- 21 tables granted `anon` all six write privileges, including TRUNCATE. The list is not
-- obscure: designs, design_versions, captured_leads, client_users, commission_settings,
-- inventory_units, building_styles, building_sizes, colors, layout_item_pricing, repairs,
-- build_crews, build_jobs, builder_locations, client_configs, delivery_loads,
-- delivery_stops, delivery_territories, fixture_items, schedule_activity, schedule_stages.
--
-- ⚠️ RLS DOES NOT FILTER TRUNCATE. Row-level security constrains SELECT/INSERT/UPDATE/DELETE;
-- TRUNCATE is a table-level DDL-ish privilege and no policy can see it. So `truncate
-- public.designs` from anyone holding the public anon key would empty EVERY tenant's designs
-- at once, with policies fully enabled and nothing in the way. Same for captured_leads
-- (every lead ever captured) and inventory_units.
--
-- These grants are not deliberate. They are the artifact this project has hit before: its
-- default privileges make every NEW table world-writable, and the PUBLIC grant survives a
-- revoke aimed only at anon/authenticated — which is why the `from public` line below is not
-- redundant.
--
-- ── WHY THIS IS SAFE ─────────────────────────────────────────────────────────────────────
-- `anon` is the role the browser uses on the PUBLIC pages only: index.html (the public
-- designer) and my-quotes.html (the customer quotes page). Three independent checks agreed
-- that neither writes any of these tables directly:
--
--   1. Per-table source audit of index.html / index.mount.jsx / StructureStudio.jsx /
--      my-quotes.html AND the compiled bundles those pages actually load. The table names do
--      not appear in the shipped browser code at all.
--   2. A second adversarial pass per table, hunting specifically for what a plain grep
--      misses: dynamic `.from(<variable>)` table names, shared helpers reached from a public
--      page, and inline scripts. Nothing found.
--   3. `pg_policies` contains ZERO policies targeting `anon` for INSERT/UPDATE/DELETE/ALL on
--      any table in public. Nobody ever wrote a rule intending anon to write.
--
-- Everything the public pages DO write goes through a path this revoke cannot touch:
--   * SECURITY DEFINER RPCs (save_design, and the list_* readers) run as their OWNER, so the
--     caller needs no table grant at all.
--   * Edge functions (capture-lead, submit-estimate, customer-auth, ...) use the SERVICE ROLE
--     client, which is not `anon` and is unaffected.
--
-- SELECT IS DELIBERATELY LEFT ALONE. The public designer legitimately READS building styles,
-- sizes, colors and fixtures with the anon key, and RLS does constrain reads. This migration
-- is about writes only; touching SELECT would dark the public designer instantly.
--
-- `authenticated` is also left alone here — that is the signed-in portal, governed by
-- migration 100's area model, 188's restrictive write policies and 199's column grant.

begin;

-- PART 1 — the revoke. `from public` is the load-bearing half: a privilege held via PUBLIC
-- survives a revoke naming only anon.
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from public;

-- Stop the next table inheriting the same grants on creation.
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon;

-- PART 2 — APPLY-TIME ASSERTIONS. Every failure below is silent at runtime, so assert now.
do $$
declare
  n_write int;
  n_read  int;
  n_svc   int;
begin
  select count(*) into n_write
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'
     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER');
  if n_write > 0 then
    raise exception
      'migration 205: anon still holds % write grant(s) on public — the revoke did not take. Check for a grant held via PUBLIC or via a role anon inherits.', n_write;
  end if;

  -- The public designer must still be able to READ. If this ever hits zero the shopfront is
  -- dark for every tenant, which is far worse than the exposure being closed.
  select count(*) into n_read
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon' and privilege_type = 'SELECT';
  if n_read = 0 then
    raise exception
      'migration 205: anon lost SELECT on every table in public — the public designer would render empty. Roll back.';
  end if;

  -- Edge functions run as service_role; if this moved, every webhook and function is broken.
  select count(*) into n_svc
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'service_role' and privilege_type = 'INSERT';
  if n_svc = 0 then
    raise exception
      'migration 205: service_role lost INSERT on public — the edge functions cannot write. Roll back immediately.';
  end if;

  raise notice 'migration 205 OK: anon write grants = 0, anon SELECT tables = %, service_role INSERT tables = %', n_read, n_svc;
end
$$;

commit;

-- PART 3 — ROLLBACK (only if a public page turns out to write directly after all; find the
-- exact table from the browser console error and grant THAT table, not all of them):
--   grant insert on public.<table> to anon;
