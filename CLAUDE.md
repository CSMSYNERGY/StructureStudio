# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

StructureStudio is a multi-tenant SaaS floor-plan designer + quote builder for custom shed/barn businesses. The designer is a single-file React component delivered as two parallel artifacts, plus a standalone owner portal:

- `StructureStudio.jsx` — ES-module React source (`import { useState, ... } from "react"`; default export `StructureStudio`, the config-loader wrapper around the internal `StructureStudioInner`). Consumed by hosts that have their own build.
- `index.html` — self-contained, zero-build drop-in: loads React 18 UMD + ReactDOM + **Babel-standalone** from CDN and inlines the whole component in `<script type="text/babel">`. Opens directly in a browser; no bundler, no package.json, no tests, no lint config. This is also the file the static host (Cloudflare Pages, production `structurestudio.app`) serves at the site root.
- `portal.html` — standalone owner login + dashboard (designs/leads list, settings). Same CDN stack, **HTML-only — it has no .jsx sibling and is exempt from the mirror rule** (it is only ever served by the static host, never embedded by other sites).

**`StructureStudio.jsx` and `index.html` contain the same component body.** The only structural differences:
1. HTML top: `const {useState,useRef,useCallback,useEffect,useMemo}=React;` instead of `import ... from "react";`
2. `export default function StructureStudio` (the config-loader) in the .jsx is a plain `function` declaration in the HTML.
3. HTML bottom: `ReactDOM.createRoot(...).render(<StructureStudio/>)` + a `window.addEventListener("message", ...)` re-render hook.

Any non-trivial edit must be mirrored in both files or the HTML deliverable will drift from the JSX source. There is no generator — they are hand-maintained siblings.

There is no build/run/test command. To sanity-check a change, serve the folder (`python -m http.server 8123`) and open `index.html` / `portal.html` — `.claude/launch.json` has a `static` server config for the preview tools.

## Multi-tenancy model

Each customer (a shed business, e.g. Junior Barns) is a **tenant** identified by a `client_id` slug:

- **Public designer link** per tenant: `https://<client_id>.structurestudio.app` or `https://<site>/?client=<client_id>`. The config-loader wrapper (bottom of the component files, default export `StructureStudio`) fetches the tenant's row from `client_configs` (public read) **before** mounting `StructureStudioInner` (several `useState` initializers read config once on mount). There is **no in-source config** — every row must be complete (`REQUIRED_CONFIG_KEYS` is enforced; a partial row gets the error screen, not a crash). The baked-in `SUPABASE_URL`/`SUPABASE_ANON_KEY` constants are the only data connection — config rows can't redirect it — and `clientId` is forced to the row's key.
- **Owner login** via `portal.html`: Supabase email/password auth. The `client_users` table maps `auth.users` → `client_id`; RLS policy `designs_owner_select` (`client_id = current_client_id()`) confines every authenticated query to the owner's tenant. End shed-shoppers never log in.
- **Data isolation**: tenants cannot see each other's designs, settings, or configs. Do not weaken the RLS policies or the RPC checks below.

### Designs data path (capability model)

The browser **never reads/writes the `designs` table directly** (legacy direct access dies at cutover — see below). Instead two SECURITY DEFINER RPCs in Postgres, keyed by the unguessable `short_code`:

- `load_design(p_code)` — returns the one row matching the code.
- `save_design(p_code, p_client_id, ...)` — upsert; validates code shape (`SS-` + 6–12 chars of the no-look-alike alphabet), requires `p_client_id` to exist in `client_configs`, and **never re-homes an existing design to a different client**.

`genShortCode()` emits 10-char codes (32^10 ≈ 2^50); legacy 6-char codes still load. The code is the capability — treat any weakening of code entropy or RPC checks as a security regression.

### Supabase backend (project `jzeamjbhdrsbygdnphbm`)

Tables: `designs` (per-design row, `client_id` column), `client_settings` (**service-role only** — GHL creds + business identity + quote terms + beta switch; never browser-readable), `client_configs` (public-read white-label config), `client_users` (auth user → tenant mapping).

Edge functions (sources mirrored in `supabase/functions/`, deployed via Supabase MCP — **redeploy after editing the checked-in source**):
- `submit-estimate` — creates/updates the GHL contact, opportunity, estimate, and emails it. Business identity (name/phone/website/address/logo/terms) comes from `client_settings.business_*`; beta mode (`beta_mode`/`beta_email` or request `betaMode`) redirects the estimate email to a test inbox.
- `portal-settings` — owner-facing settings read/save. JWT-authenticated: `verify_jwt` alone is NOT auth (the anon key passes the gateway) — the function resolves a real user via `auth.getUser()` and maps it through `client_users`; `client_id` is never trusted from the body. The GHL API key is write-only (masked status, absent/empty never blanks it).
- `admin-save-settings` — operator bootstrap tool behind the shared `ADMIN_PASSWORD` secret (used by the designer's `?admin=1` panel).

SQL migrations live in `supabase/migrations/` (001–004 applied; **005_cutover.sql is NOT applied** — see below).

### ⚠ Cutover state (read before touching RLS)

The legacy open policies (`designs_anon_all` on `public.designs`, `floor_plans_public_all` on storage) are **still in place** because the live site is built from GitHub `main`, which may still serve the old direct-table frontend. After the new frontend is pushed and deployed (verify the console marker `[StructureStudio] multi-tenant build` on the live site), run `supabase/migrations/005_cutover.sql` to drop them. Until then, anon can still read all designs — the cutover is the step that actually enforces isolation against the anon key.

## Runtime configuration model

The component is white-labeled per client. There is **no in-source copy** of any client's config — the source of truth is the `public.client_configs` table (one row per `client_id`, `config` jsonb). The config-loader wrapper fetches it on every page load. Resolution order:

1. React prop: `<StructureStudio config={clientConfig} />` — wins, no fetch. Used by the `postMessage` re-render path in `index.html` and by hosts that supply their own config.
2. `?client=<id>` URL param — explicit override, wins over hostname.
3. **Subdomain** — `juniorbarns.structurestudio.app` → `client_id = "juniorbarns"`. Only fires for `<sub>.structurestudio.app`; the apex, IPs, localhost, `*.pages.dev`/`*.netlify.app` deploy hosts, and the reserved env labels (`www`/`beta`/`dev`/`staging`/`app`) all fall through — a deploy hostname is never a tenant.
4. `?id=<short_code>` share-link — without a `?client=` or tenant subdomain, the owning `client_id` is looked up via the `load_design` RPC so a rep clicking someone else's link gets that tenant's branding/config.
5. Fallback: `DEFAULT_CLIENT_ID` (currently `junior-barns`).
6. On fetch failure (network error, unknown `client_id`, or an incomplete row missing one of `REQUIRED_CONFIG_KEYS`) the wrapper renders an error screen with a retry button — it does NOT silently fall back to another tenant's config.

A separate `postMessage` listener inside the inner component handles `{ type: "structureConfig", <flat fields> }` to prefill selections and contact info without a full re-render.

Config shape (see any `client_configs.config` row): `clientId` (forced to the row key on load), `branding`, `contactFields[]`, `buildingStyles[]` (each with its own `sizes[]`), `defaultSizes[]`, `options[]` (dynamic option renderers — currently `counter` and `image_cards` types), `layoutItems{}` (the palette of placeable items), and optional `googleMapsApiKey` (falls back to the baked-in `DEFAULT_GOOGLE_MAPS_API_KEY`). A `supabase` key in a row is ignored — the connection is always the baked-in constants. Changing client behavior means editing the DB row, not code.

Each entry in `options[]` may optionally declare `buildingStyles: ["Urban", "Northwood"]` to limit when it appears. Without that field the option always shows. Visibility is computed by `isOptionApplicable(opt, sel.style)`; on style change, values of options that just became inapplicable are reset to their default so they don't leak into the submit payload.

## Onboarding a new customer (operator runbook)

1. Pick a `client_id` slug (e.g. `acme-barns` — it doubles as their subdomain, so keep it DNS-safe).
2. Insert a `client_configs` row: **clone junior-barns' config jsonb and swap branding/styles/images.** The row must be COMPLETE (`branding`, `contactFields`, `buildingStyles`, `defaultSizes`, `options`, `layoutItems`) — there is no in-source default to inherit from; a partial row shows the error screen.
3. Supabase Dashboard → Authentication → Add user (email + temp password, auto-confirm).
4. `insert into client_users (user_id, client_id) values ('<auth uid>', '<client_id>');`
5. Insert a `client_settings` row (or let the owner fill it via the portal): business details + GHL Location ID/API key/pipeline/stage. Recommend `beta_mode = true` until their first real estimate is verified.
6. Send the owner: `https://<site>/portal.html` + credentials (tell them to use "Forgot password" to set their own) and their public designer link `https://<site>/?client=<client_id>`.

## Architectural concepts

**Coordinate system.** The floor plan is stored in feet (`bldgW`, `bldgH`, `widthFt`, `heightFt`, and item positions converted from px). All on-screen geometry is `feet * scale + mg`, where `scale` is recomputed from `bldgW/bldgH` on every render and `mg` is a fixed margin. When adding geometry, work in feet and convert at the edges.

**Item taxonomy via flags on `C.layoutItems`.** Placement rules are driven by per-type flags, not class hierarchies:
- `wallOnly: true` — doors, windows, rough openings. Must click a wall; rendered as a bar on the wall line.
- `wallSnap: true` — workbench. Snaps to the nearest wall's interior; can be resized along the wall (1D).
- `doorSnap: true` — ramp. Attaches to an existing door (outside the building); cannot be dragged; only one per door.
- Neither — loft. Free-floating with 4-sided resize; must pass `checkLoftAttached` (both ends of at least one axis touching a wall or another loft).

Adding a new item type usually means adding an entry to `layoutItems` + any new flag branch in `handleClick`, `onPtrMove` (drag), `startResize` logic, `generatePNG`, and the submit payload rollup.

**Logical walls vs. display labels.** Walls are stored as `north|south|east|west` (positional). `getFrontWall(items)` picks the FRONT from door placement (double door wins over single), and `getDisplayLabel(positionalWall, frontWall)` maps each positional wall to `FRONT/BACK/LEFT/RIGHT` for user-facing labels and for the submit payload's wall fields. Internal collision/snap math uses positional walls; anything shown to the user or sent to the webhook uses display labels.

**Collision / placement invariants.** These are enforced by `checkDoorCollision`, workbench-on-wall overlap checks in `handleClick`/`onPtrMove`, loft-vs-loft overlap checks, and `checkLoftAttached`. Breaking any of these will let users build layouts the backend and downstream estimating logic assumes are impossible.

**Two rendering paths that must stay in sync.** Live UI renders via SVG inside the component's JSX. Export and submit both call `generatePNG()`, which draws the same scene on a `<canvas>` using 2× DPR for the exported image. When adjusting visuals (colors, labels, door swing arcs, loft hatching, etc.), update both the SVG JSX and the canvas drawing inside `generatePNG` — otherwise the PDF/email the customer receives won't match what they designed.

## Submit flow

`submitQuote()`: validates contact/selections → renders the canvas → wraps the JPEG into a single-page PDF client-side → uploads to the `floor-plans` storage bucket as `{shortCode}.pdf` → saves the design via the `save_design` RPC → updates the URL to `?client=<id>&id=<code>` → invokes the `submit-estimate` edge function. Payload shape is consumed downstream, so treat it as a contract:

- `designId` — short code (e.g. `SS-NR4DV8XK2P`) that keys the design in Supabase
- `imageUrl` — public Storage URL of the rendered PDF
- `viewUrl` — `?client=...&id=...` URL on the deployed host (owners/reps click this to reopen/edit)
- `clientId` — the tenant; the edge function uses it to look up GHL creds + business identity
- `contact`, `selections` (`buildingStyle`, `buildingSize`, `paint`, optional paint colors)
- `floorPlanItems[]` — raw list; each has `type`, `wall` (already mapped to front/back/left/right lowercase), and `lengthFt` for workbenches
- `itemSummary` — rolled-up counts + workbench lengths
- `customOptions[]` (only rows with a non-empty name are included)
- `roughOpenings[]` — one entry per RO with its dimensions string

The edge function returns GHL ids (`contactId`, `estimateId`, `estimateNumber`, `opportunityId`) which the component stores in refs — a resubmit becomes an update of the same estimate. If you rename or restructure these fields, the estimate flow breaks silently.

## Cutover checklist (run once, after deploying the new frontend)

1. Open the live site; confirm the console logs `[StructureStudio] multi-tenant build: config-loader + RPC data path` and a `?id=` load hits `/rest/v1/rpc/load_design` in devtools Network.
2. Apply `supabase/migrations/005_cutover.sql` (drops `designs_anon_all` + `floor_plans_public_all`, adds scoped storage policies).
3. Smoke: load an old `?id=` design; submit a new design on `?client=junior-barns`; portal lists it; resubmit updates the same estimate.
4. Negative: from a console with only the anon key, `from("designs").select("*")` returns zero rows; storage upload to a non-code filename fails.
5. Run the Supabase security advisors and clear anything new.
