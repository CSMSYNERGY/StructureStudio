# StructureStudio

A config-driven white-label React floor plan designer and quote builder for custom sheds and barns.

## Live demo

- **Production:** https://structurestudio.app (per-tenant subdomains: e.g. https://juniorbarns.structurestudio.app)
- **Beta:** https://beta.structurestudio.app

## How it works

StructureStudio is a **single-file React component** delivered as two parallel artifacts:

- StructureStudio.html — zero-build drop-in that loads React 18 + Babel-standalone from CDN. Open directly in any browser. No bundler, no npm.
- StructureStudio.jsx — ES-module source for hosts with their own build system.
- index.html — a copy of the HTML file served as the site root.

Both files are hand-maintained siblings. Any non-trivial edit must be mirrored in both (see CLAUDE.md for details).

## Configuration

White-labeled per client via a config object. See DEFAULT_CONFIG at the top of the HTML/JSX for the canonical example (currently set to Junior Barns).

Clients can override the config three ways:
1. React prop: `<StructureStudio config={clientConfig} />`
2. `postMessage` from a parent frame
3. Direct edit of `DEFAULT_CONFIG`

See `CLAUDE.md` for full architecture notes.

## Deployment

Deployed via Cloudflare Pages from the `main` branch (production) and `beta` branch (beta preview at `beta.structurestudio.app`). Pushes auto-deploy. Per-tenant subdomains (`<client_id>.structurestudio.app`) are served by the same Pages project via wildcard DNS; the wrapper component picks the `client_configs` row to load from the first DNS label.

---

**Maintained by:** CSM Synergy
