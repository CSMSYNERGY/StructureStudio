# Supabase Cutover & Migration Handoff

**Prepared 2026-06-12; updated 2026-06-13** with the per-tenant isolation work
(migrations `000`/`012`/`013`/`014`/`015`, the `005` storage edit, and the
`get_config` front-end swap). State below was verified read-only against the live
DB (`jzeamjbhdrsbygdnphbm`). Outstanding tasks: (1) the RLS **cutover**,
(2) reconciling the **migration history**, and (3) applying this change set's
**new migrations** (Task 3). Task 1 and the config lockdown in Task 3 share one
precondition: the new front-end must be live on **production** first.

> You'll need your own access. Either `supabase login` (browser flow) or a
> Personal Access Token (Account → Access Tokens) for the Management API. The
> token used to gather this info has been revoked.

---

## Verified current state

- **All expected tables exist and are seeded.** `designs` (38 rows),
  `client_configs` (3), `client_settings` (3), `client_users` (2), plus the
  catalog/pricing tables `building_styles` (4), `building_sizes` (34),
  `colors` (2), `layout_item_pricing` (8). Migrations 006–010 are live; `011`
  (building_sizes client_id) also landed on live — as **two** migrations (an
  additive add then a recreate-reorder), see Task 2.
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
`db push` will misbehave. ⚠ **This is the main data-loss risk in the whole
handoff:** a `db push` sees the `NNN_` repo names as unrecorded and tries to
re-run them — and `008`/`009`/`010`/`011` contain `DROP TABLE … recreate`, which
would **wipe the seeded/edited catalog**. Reconcile the history (below) BEFORE
any `db push`; until then, hand-apply via the SQL Editor only.

**Repo files** use `001`–`011`. **Remote `supabase_migrations`** records
timestamp names, and has **4 pre-repo migrations with no file in the repo**.
One of those four also defines `public.set_updated_at()`, which `004` alters and
`006`–`011` bind as a trigger — so a clean `db reset` of the repo alone fails
until that function exists. Repo file **`000_prereqs.sql`** now re-creates it
(idempotent, no-op on live), closing the function gap; the base TABLES
(`designs`/`client_configs`/`client_settings`) are still pre-repo and a fully
green from-zero replay needs them backfilled via `db pull`.

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
| `011_building_sizes_client_id` | `20260612…` building_sizes_client_id **+** building_sizes_reorder_client_id_second (landed as TWO migrations) |
| `000_prereqs` *(new)* | *(none — additive `set_updated_at`; apply as a new version)* |
| `012_catalog_rls_scope` *(new)* | *(none — apply)* |
| `013_deactivate_unpriced_sizes` *(new)* | *(none — apply)* |
| `014_get_config_rpc` *(new)* | *(none — apply)* |
| `015_config_rls_scope` *(new)* | *(none — cutover-gated, apply with Task 1)* |

Note `011` collapses what live recorded as two migrations; when reconciling,
mark BOTH remote versions applied for the single repo file.

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

## Task 3 — Apply the per-tenant isolation change set (this change)

Closes the two remaining cross-tenant read surfaces (the catalog tables and
`client_configs`) and re-paths storage under `client_id`. **Every migration here
is non-destructive** (policy/grant/function changes + one reversible `UPDATE`);
nothing is dropped or deleted.

### Backup FIRST (no data loss)
- Database: a full snapshot — Supabase dashboard backup / enable PITR. (`pg_dump`
  18.4 is on Carolyn's box but Docker isn't, so the dashboard backup is the
  reliable path.)
- Storage: copy the whole `floor-plans` bucket before the re-path step.
- Ledger: `create table supabase_migrations.schema_migrations_bak_<date> as
  select * from supabase_migrations.schema_migrations;`

### Group A — SAFE NOW  ✅ APPLIED TO LIVE 2026-06-13
`000_prereqs` → `012_catalog_rls_scope` → `013_deactivate_unpriced_sizes` →
`014_get_config_rpc`. These are additive / lock only the **inert** catalog tables
and add the `get_catalog` + `get_config` RPCs. They don't touch the live
front-end path. `000` is a no-op sanity check on live.

**Status:** applied to `jzeamjbhdrsbygdnphbm` on 2026-06-13 via
`supabase db query --linked -f <file>` (catalog backed up first to
`ss_backup_catalog_*.json`). Verified live: anon is blocked (401) on
`building_styles`/`building_sizes`/`colors`; `get_config`/`get_catalog` work for
anon; `get_catalog` hides prices (show_pricing=false) and raises on unknown
client; `013` deactivated exactly 1 size (junior-barns northwood 8x20, 34→33
active). ⚠ Applied via `db query`, NOT `db push`, so they are **not recorded in
`supabase_migrations`** — during Task 2 reconciliation, mark `000`/`012`/`013`/
`014` as applied. All four are idempotent, so a later `db push` re-running them is
harmless.

The new front-end (config-loader reads via `get_config`, uploads to
`{client_id}/<code>.pdf`) is on **beta** and verified against live `get_config`
(designer loads). Deploy to **production** before Group B.

### Group B — CUTOVER-GATED (apply only after the new front-end is live on production)
Run together with Task 1:
1. `005_cutover.sql` (now also requires the client-prefixed storage path) and
   `015_config_rls_scope.sql` (revokes anon's `client_configs` read).
2. **Re-path existing storage files via COPY (never move/delete):** for each
   design, `supabase.storage.from('floor-plans').copy('<code>.pdf',
   '<client_id>/<code>.pdf')` (service role). The originals stay at the root as
   backups and remain publicly readable, so old links never break.
3. **Verify** each prefixed copy returns 200, THEN snapshot + update URLs:
   `create table public.designs_imageurl_bak as select short_code, image_url from public.designs;`
   `update public.designs set image_url = regexp_replace(image_url,'/floor-plans/(SS-[A-HJ-NP-Z2-9]{6,12}\.pdf)$','/floor-plans/'||client_id||'/\1') where image_url ~ '/floor-plans/SS-';`

After Group B: anon can read no table directly (catalog + `client_configs` go
through `get_catalog`/`get_config`; designs through `load_design`); authenticated
owners see only their own tenant; storage objects are client-prefixed.

---

## Notes
- `005_cutover.sql`'s header (was mislabeled "004_cutover" + Netlify) is now
  corrected, and its storage policy now requires the client-prefixed path
  `{client_id}/SS-<code>.pdf`.
- Local tooling on Carolyn's machine: `psql`/`pg_dump` 18.4 (scoop, no service);
  no Docker, so `supabase db diff`/`db dump` won't run there — use
  `supabase inspect db *` or the Management API for live introspection.
