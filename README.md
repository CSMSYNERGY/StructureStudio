# StructureStudio

A config-driven, multi-tenant floor plan designer and quote builder for custom shed and barn businesses.

## Live demo

- **Production:** https://structurestudio.app (per-tenant subdomains: e.g. https://juniorbarns.structurestudio.app)
- **Beta:** https://beta.structurestudio.app

## How it works

Each customer (a shed business) is a **tenant** with:

- A **public designer link** — `https://<client_id>.structurestudio.app` (or `https://<site>/?client=<client_id>`) — branded with their config. Shoppers design a building and submit for a quote; no login required.
- A **business portal** — `https://<site>/portal.html` (also where the bare site root redirects) — where the owner logs in to see their submitted designs/leads, copy their customer link, and manage their GoHighLevel + business settings. Row Level Security guarantees each business only ever sees its own data.

The designer is a **single-file React component** delivered as two parallel artifacts:

- `index.html` — zero-build drop-in that loads React 18 + Babel-standalone from CDN; served as the site root.
- `StructureStudio.jsx` — ES-module source for hosts with their own build system.
- `portal.html` — standalone owner login + dashboard (no `.jsx` sibling).

`index.html` and `StructureStudio.jsx` are hand-maintained siblings. Any non-trivial edit must be mirrored in both (see `CLAUDE.md`).

## Backend

Supabase (single project): Postgres + RLS for tenant isolation, Storage for floor-plan PDFs, Auth for owner logins, and Edge Functions (`submit-estimate`, `portal-settings`, `admin-save-settings`) for GoHighLevel estimate creation and settings management. SQL migrations are in `supabase/migrations/`; edge function sources in `supabase/functions/`.

**Note:** `supabase/migrations/005_cutover.sql` must only be applied after the new frontend is live — see the cutover checklist in `CLAUDE.md`.

## Onboarding a new customer

See the operator runbook in `CLAUDE.md` (insert `client_configs` + `client_users` + `client_settings` rows, create the owner's auth user, send them their portal login and designer link).

## Configuration

White-labeled per client via a config object stored in the `client_configs` table and merged over `DEFAULT_CONFIG` at load. See `DEFAULT_CONFIG` at the top of the HTML/JSX for the canonical shape (currently Junior Barns). Hosts with their own build can also pass `<StructureStudio config={...} />` or use `postMessage`.

## Deployment

Deployed via Cloudflare Pages from the `main` branch (production) and `beta` branch (beta preview at `beta.structurestudio.app`). Pushes auto-deploy. Per-tenant subdomains (`<client_id>.structurestudio.app`) are served by the same Pages project via wildcard DNS; the config-loader picks the `client_configs` row to load from the first DNS label.

Recommended Supabase Auth settings (Dashboard → Authentication):
- **Disable public sign-ups** (the operator creates owner accounts).
- Set **Site URL** to `https://structurestudio.app` and add `https://structurestudio.app/portal.html` to the redirect allow-list (password recovery emails land there).

---

**Maintained by:** CSM Synergy
