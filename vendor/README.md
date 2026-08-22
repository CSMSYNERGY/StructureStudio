# vendor/ — the browser dependencies, self-hosted

`index.html`, `portal.html` and `admin.html` load **three** of these files (React, ReactDOM,
supabase-js) and nothing else from here. **`babel-standalone-7.23.9.min.js` is no longer served
to visitors (2026-08-13): it is the OFFLINE COMPILER** — `scripts/compile.mjs` loads it in Node
with the exact options its in-browser script-tag runner used, and compiles the `.jsx` app
sources into the committed `*.compiled.js` artifacts (`npm run compile`). **Do not delete it**,
and know that bumping it now changes compiled output: a Babel bump requires a full recompile
plus the render-parity re-verification described in CLAUDE.md's "Compiled artifacts" section.

## Why they are here and not on a CDN

They used to be loaded from cdnjs and jsdelivr. Because there is no bundler, a single failed or
blocked request meant babel-standalone still compiled the inline mount block, the block threw on
the first missing global, and the visitor got a **permanently blank page** — no message, nothing to
act on. That reached real traffic twice:

| when | page | missing | who saw it |
|---|---|---|---|
| 2026-08-04 21:40 UTC | designer | react-dom | a real browser (Chrome 142; stack shows an extension reading inline scripts) |
| 2026-08-05 14:09 UTC | designer | react-dom | **Googlebot** — a tenant's public shopfront was crawled blank |

A guard now turns that into an actionable message (`<script data-ss-app>` at the end of each page's
body), but a message is not a working page. Serving the files from our own origin removes the
failure mode instead of reporting it: there is no third party left to be unreachable, blocked by a
VPN or corporate filter, or blackholed by a browser extension.

Self-hosting also **pins supabase-js**, which was previously requested as `@2` — a floating major.
Any npm publish could change the library under every live tenant with no commit on our side. It
resolved to 2.112.1 on the day these were vendored, so that is what is here.

## What is here

| file | source URL it was fetched from | bytes | sha256 |
|---|---|---|---|
| `react-18.2.0.production.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js` | 10,737 | `4b4969fa4ef35943…` |
| `react-dom-18.2.0.production.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js` | 131,882 | `21758ed084cd0e37…` |
| `supabase-js-2.112.1.umd.min.js` | `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js` | 211,134 | `6ce78333437820a2…` |
| `babel-standalone-7.23.9.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js` | 2,849,480 | `b1e09e947968baa0…` |

Vendored 2026-08-06. The bytes are exactly what the CDNs were serving to visitors that day, fetched
from the same URLs the pages had been using — so this move changed *where* the files come from and
nothing about *what* runs. Verified: `@2` and `@2.112.1` were byte-identical, so the pin is exact.

Two notes on the files themselves:

- The supabase bundle carries a jsdelivr-generated header ("Skipped minification because the
  original files appears to be already minified") because jsdelivr repackages that path. It is
  jsdelivr's wrapper around `@supabase/supabase-js@2.112.1/dist/umd/supabase.js`, kept verbatim
  rather than re-fetched from npm, so the bytes match what production was already running.
- That bundle exports via a top-level `var supabase = …` rather than the usual UMD
  `global.supabase =` assignment. It still lands on `window` as a classic script, which is what the
  pages and the boot guard read.

No Subresource Integrity attributes: SRI exists to detect a third party tampering with a file, and
there is no third party any more. The hashes above are provenance for a human, not a runtime check.

## Rules

- **Root-absolute `/vendor/…` references only.** `portal.html` is served at `/portal/<page>/<sub>`
  as well as `/portal.html`, so a relative `src` resolves against whatever depth the URL has and
  gets rewritten by the `/portal/*` splat in `_redirects`. That exact mistake once blanked the
  entire portal (see the comment above the tag in `portal.html`).
- **The version is in the filename.** A library bump is then a visible rename in the diff and a
  new URL for caches, never a silent byte change under the same name.
- **All three pages must load the same four files.** `scripts/preflight.mjs` enforces this, that
  each referenced file exists, and that none of the four comes from a CDN again.
- **Do not add anything else here** without deciding it genuinely must be same-origin. `exceljs` is
  deliberately still CDN-loaded and injected on demand (`portal.html`): it powers one spreadsheet
  export, so a failed fetch costs a button rather than the page.

## Updating a library

1. Download the new file to `vendor/<name>-<version>.<ext>`; keep the old one in place for now.
2. Update the `<script src>` in **all three** pages to the new filename — preflight fails the push
   if they disagree, if a referenced file is missing, or if a CDN tag comes back.
3. Delete the old file in the same commit, and update the table above (URL, bytes, sha256).
4. Serve the folder and load all three pages. React/ReactDOM/babel move together: the same JSX text
   is compiled by whichever Babel the page loaded, so a mismatch shows up as behaviour, not an
   error. Check the designer renders, the portal login renders, and the admin gate renders.
5. Remember `structure-studio.component.js?v=` is a *separate* cache-buster for the shared module
   and does not need touching for a vendor bump.
