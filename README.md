# StructureStudio

A config-driven, multi-tenant floor plan designer and quote builder for custom shed and barn businesses.

## Live sites

| | URL | Host | Ships from |
|---|---|---|---|
| **Production** | https://app.structurestudiosuite.com | Cloudflare Workers | `main`, Workers Builds on push |
| **Beta** | https://beta.structurestudiosuite.com | Cloudflare Workers | `beta`, Workers Builds on push |
| **Legacy production** | https://structurestudio.app | Netlify | `main`, on push — sunsetting; serves already-sent customer links only |

The app was renamed **Structure Studio Suite** (trademark conflict), so hosting moved to the structurestudiosuite.com domain; structurestudio.app is being discontinued behind a redirect. Read `CLAUDE.md` before you ship anything.

⚠️ **`beta.structurestudio.app` still resolves (Netlify) but is a stale parallel copy — never verify against it.** The live beta is the `structurestudiosuite.com` one.

## How it works

Each customer (a shed business) is a **tenant** identified by a `client_id` slug, with:

- A **public designer link** — `https://app.structurestudiosuite.com/?client=<client_id>` — branded with their config. Shoppers design a building and submit for a quote; no login required.
- A **business portal** — `https://<site>/portal.html` (also where the bare site root redirects) — where the owner logs in to see their submitted designs/leads, copy their customer link, run the build/delivery schedules, and manage their GoHighLevel + business settings. Row Level Security guarantees each business only ever sees its own data.

The tenant parser also recognizes per-tenant subdomains on either apex, but **no wildcard DNS is provisioned** — subdomain links do not currently resolve; tenant links use `?client=<id>`.

## Layout

The designer is a single React component delivered as two hand-mirrored artifacts, plus two host pages:

- `structure-studio.component.js` — **the one shared browser module** (babel/global-destructure dialect), self-contained, ending in `window.StructureStudio = …`. Loaded by *both* host pages.
- `StructureStudio.jsx` — the ES-module source of truth, for hosts with their own build.
- `index.html` — a **thin mount page** (CDN tags + the shared module + a small mount block). It is *not* self-contained: it hard-requires its sibling `structure-studio.component.js` on the same origin, so **opening it from `file://` does not work** — serve it over http.
- `portal.html` — standalone owner login + dashboard, including an in-portal Designer tab that mounts the same shared module. HTML-only; no `.jsx` sibling.

**The mirrored pair is `StructureStudio.jsx` ↔ `structure-studio.component.js`.** There is no generator — any non-trivial edit must land in both files by hand, or the browser deliverable drifts from the source. See `CLAUDE.md` for the three permitted structural differences.

## Development

**There is no build step for the product** — Babel-standalone compiles in the browser. To sanity-check a change, serve the folder over http and open the pages (never `file://`):

```bash
python -m http.server 8123
```

`.claude/launch.json` also defines a `static` server config for the preview tools.

Because nothing compiles ahead of time, a broken reference ships silently and throws in the customer's tab. `scripts/preflight.mjs` is a correctness gate that lints every inline `text/babel` block and both component twins, enforces the CDN version lock and the `?v=` cache-buster lockstep, type-checks and tests the edge functions, and blocks browser-served files from referencing Intuit API hosts. It runs automatically on `git push`.

**One-time setup per clone:**

```bash
git config core.hooksPath .githooks && npm install
```

Run it by hand any time with `npm run preflight`. (The `devDependencies` in `package.json` exist *only* for this gate — the product itself has no dependencies to install.)

**Always rebase before you push:** `git pull --rebase origin beta`. This clone is shared by several sessions; the pre-push hook refuses the push while you are behind.

## Backend

Supabase (single project, `jzeamjbhdrsbygdnphbm`): Postgres + RLS for tenant isolation, Storage for floor-plan PDFs, Auth for owner logins, and 15 Edge Functions. SQL migrations are in `supabase/migrations/`; edge function sources in `supabase/functions/` (redeploy after editing the checked-in source).

**Capability data model.** The anon browser never reads or writes tables directly — it goes through SECURITY DEFINER RPCs keyed by `client_id` or by a design's unguessable `short_code`: `get_config`, `get_catalog`, `load_design`, `save_design`. Authenticated owners are RLS-confined to `current_client_id()`; `client_settings` is service-role only. Treat any weakening of these RPC checks, RLS policies, or short-code entropy as a security regression.

Notable functions: `submit-estimate` (GoHighLevel contact/opportunity/estimate + email), `portal-settings`, `portal-billing` + `billing-webhook`, `portal-schedule` (build/delivery schedules and repairs), `portal-feedback` + `feedback-monday-webhook`, `admin-catalog`, and the QuickBooks OAuth pair.

## Configuration

White-labeled per client. **There is no in-source config and no `DEFAULT_CONFIG`** — the source of truth is the `public.client_configs` table (one row per `client_id`), fetched via the `get_config` RPC on every page load, *before* the component mounts. Changing a client's behavior means editing their database row, not the code.

Every row must be **complete**: `branding`, `contactFields`, `buildingStyles`, `defaultSizes`, `options`, `layoutItems` (`REQUIRED_CONFIG_KEYS`). A partial row, an unknown `client_id`, or a fetch failure renders an error screen with a retry button — it never silently falls back to another tenant's config.

Resolution order: a `config` React prop → `?client=<id>` → tenant subdomain → the owning tenant of a `?id=<short_code>` share link → otherwise redirect to the portal. Hosts embedding the designer can also supply config via `postMessage`.

## Deployment

**Both workers deploy from git via Cloudflare Workers Builds** (account CSM Synergy): a push to `beta` builds and deploys the `structurestudio-beta` worker (live at beta.structurestudiosuite.com within ~2 minutes), and a push to `main` builds and deploys the `structurestudio-app` worker (live at app.structurestudiosuite.com). Verified end-to-end 2026-08-05 (push → deploy → live bytes identical to git). ⚠️ The `main` build **fails until the Monday promotion carries the wrangler configs to `main`** — expected; ignore it until then. Manual fallback if Builds is down: `npx wrangler deploy [--config wrangler.beta.jsonc]`; verify any deploy with `npx wrangler deployments list --name <worker>`.

**Legacy (structurestudio.app) is still Netlify**, deploying `main` on push, until its sunset redirect ships. When the Netlify team's credits are exhausted, git deploys are silently marked *"Skipped due to account credit usage exceeded"* — pushes look fine while shipping nothing. Check `npx netlify-cli api listSiteDeploys` when a `main` push doesn't appear there.

**Branching.** `beta` is the working line — all development happens there. `main` is production and is reached **only by promotion**: `.github/workflows/merge-beta-to-main.yml` merges beta into main at **10:00 UTC every Monday**, and can be dispatched on demand from the Actions tab. So the answer to *"when do clients see this?"* is the next Monday. Do not hand-merge to `main`, and never develop on it. Check the pending gap with:

```bash
git log --oneline origin/main..origin/beta
```

(That workflow file lives only on `main`, so it is invisible from a `beta` checkout.)

## Onboarding a new customer

See the operator runbook in `CLAUDE.md` — insert `client_configs` + `client_users` + `client_settings` rows, create the owner's auth user, then send them their portal login and designer link. ⚠️ Verify a new tenant by submitting a test estimate with **a contact email you control**: `beta_mode` does *not* redirect the estimate email, so a verification submit with a real lead's details emails that customer a live branded quote.

New tenants land on a billing gate until they subscribe; tenants predating the gate were grandfathered via `client_settings.billing_exempt`. Use the admin console's **Non-billable** checkbox for demo and test tenants rather than hand-editing that flag.

## Supabase Auth settings

Configured in the Dashboard (Authentication): public sign-ups disabled (the operator creates owner accounts), Site URL `https://app.structurestudiosuite.com`, with `https://app.structurestudiosuite.com/portal` on the redirect allow-list so password-recovery emails land there. Keep the legacy structurestudio.app entries while already-sent links are alive.

⛔ **Never run `supabase config push`.** It is declarative and `supabase/config.toml` deliberately has no `[auth]` section — pushing it would reset `site_url` to localhost, de-allow-list the real redirect, and clear custom SMTP. Make auth changes in the dashboard.

---

**Maintained by:** CSM Synergy — see `CLAUDE.md` for the full working guide.
