# StructureStudio

A config-driven white-label React floor plan designer and quote builder for custom sheds and barns.

## Live demo

- **Junior Barns (default config):** deployed URL will appear here after first Netlify build

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

Deployed via Netlify from the `main` branch. Pushes to `main` auto-deploy.

---

**Maintained by:** CSM Synergy
