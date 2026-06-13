# Supabase Cutover & Migration Handoff

**Prepared 2026-06-12.** State below was verified read-only against the live DB
(`jzeamjbhdrsbygdnphbm`). Two tasks are outstanding: (1) the RLS **cutover**, and
(2) reconciling the **migration history**. They are independent — do the cutover
first if you only do one.

> You'll need your own access. Either `supabase login` (browser flow) or a
> Personal Access Token (Account → Access Tokens) for the Management API. The
> token used to gather this info has been revoked.

---

## Verified current state

- **All expected tables exist and are seeded.** `designs` (38 rows),
  `client_configs` (3), `client_settings` (3), `client_users` (2), plus the
  catalog/pricing tables `building_styles` (4), `building_sizes` (34),
  `colors` (2), `layout_item_pricing` (8). Migrations 006–010 are live.
- **RLS is enabled on every table** — but see the open policies below.
- **The cutover has NOT run.** These legacy open policies are still live:
  | Policy | Object | Grant | Effect |
  |---|---|---|---|
  | `designs_anon_all` | `public.designs` | `ALL` to `anon`, `qual = true` | anon key can read/write/delete **all** designs across all tenants |
  | `floor_plans_public_all` | `storage.objects` | `ALL` to `public` | anyone can read/write/delete any file in `floor-plans` |

  Until these are dropped, tenant isolation is **not** enforced against the anon
  key, even though the `load_design`/`save_design` RPCs exist.

---

## Task 1 — Cutover (`005_cutover.sql`)

Drops the two open policies above and replaces the storage policy with
code-shaped-name insert/update only. **Running it while the OLD frontend is live
breaks design load/save for every visitor**, so the precondition matters.

### Precondition (do NOT skip)
1. Open the live site (`structurestudio.app`).
2. Browser console must log:
   `[StructureStudio] multi-tenant build: ...` (the config-loader + RPC marker).
3. DevTools → Network: loading a `?id=<code>` design must hit
   `/rest/v1/rpc/load_design` — **NOT** `/rest/v1/designs`.

If any of those fail, the deployed frontend is still the legacy direct-table
build. **Stop** — deploy the multi-tenant frontend from `main` first.

### Apply
```bash
supabase link --project-ref jzeamjbhdrsbygdnphbm   # run from the repo root
supabase db push                                    # see Task 2 caveat first
# — or apply just this file's SQL via the dashboard SQL Editor if push is unsafe
```
The file is `supabase/migrations/005_cutover.sql`.

### Smoke test (from CLAUDE.md "Cutover checklist")
1. Load an existing `?id=` design — still loads.
2. Submit a new design on `?client=junior-barns` — saves; portal lists it.
3. Resubmit — updates the same GHL estimate (not a duplicate).
4. **Negative:** from a console with only the anon key,
   `from("designs").select("*")` returns **zero rows**; a storage upload to a
   non-code filename fails.
5. Run the Supabase **Security Advisor**; clear anything new.

---

## Task 2 — Reconcile migration history (do this BEFORE `supabase db push`)

The schema is consistent, but migration **names** diverge, so a plain
`db push` will misbehave (it may try to re-apply 001–010).

**Repo files** use `001`–`010`. **Remote `supabase_migrations`** records
timestamp names, and has **4 pre-repo migrations with no file in the repo**:

| Repo file | Remote version (name) |
|---|---|
| *(none)* | `20260504170907` add_ghl_fields_and_client_settings |
| *(none)* | `20260505033300` enable_http_extension |
| *(none)* | `20260505033527` add_opportunity_columns |
| *(none)* | `20260515193433` create_client_configs |
| `001_tenancy` | `20260611055602` tenancy_client_users_and_owner_policies |
| `002_design_rpcs` | `20260611055623` design_capability_rpcs |
| `003_client_settings_business` | `20260611055636` client_settings_business_details |
| `004_advisor_hardening` | `20260611062404` advisor_hardening |
| `005_cutover` | *(none — correctly not applied)* |
| `006_catalog_pricing` | `20260612072557` catalog_pricing |
| `007_seed_junior_barns` | `20260612072623` seed_junior_barns |
| `008_flatten_options` | `20260612080443` flatten_options |
| `009_colors` | `20260612081714` colors |
| `010_layout_item_pricing_defaults` | `20260612082216` layout_item_pricing_defaults |

### Recommended approach
1. **Back up first:**
   `create table supabase_migrations.schema_migrations_bak_20260612 as
    select * from supabase_migrations.schema_migrations;`
2. Decide the source of truth. Simplest: **adopt the remote timestamp names** —
   pull them down so the repo matches reality:
   `supabase db pull`  (writes a remote-schema migration; review before commit).
3. Alternatively, keep the `001`–`010` names and use
   `supabase migration repair --status applied <version>` /
   `--status reverted <version>` to line the two lists up. Map each repo file to
   its remote version using the table above before running anything.
4. Only after the lists reconcile should anyone run `supabase db push`.

The 4 pre-repo migrations have no files — either backfill them from whoever
applied them, or accept them as remote-only history via `db pull`.

---

## Notes
- `005_cutover.sql`'s header comment still says "004_cutover" and references
  Netlify — cosmetic, the SQL is correct.
- Local tooling on Carolyn's machine: `psql`/`pg_dump` 18.4 (scoop, no service);
  no Docker, so `supabase db diff`/`db dump` won't run there — use
  `supabase inspect db *` or the Management API for live introspection.
