// Pre-push correctness gate.
//
// WHY THIS EXISTS: this product has no compiler in the request path — the pages ship
// artifacts compiled OFFLINE from hand-maintained sources (scripts/compile.mjs; until
// 2026-08-13 the JSX compiled in the browser), so nothing catches a broken reference until
// a customer's tab throws. On 2026-07-30 a refactor renamed LeadsTable's private RANK to
// the shared STATUS_RANK but missed one usage; it shipped, load() threw ReferenceError on
// the first row, and the Contacts tab sat on "Loading…" for every tenant until it was
// traced through app_errors. ESLint's no-undef catches that class of bug in two seconds,
// before the push. That incident is also this script's self-test fixture (see --self-test).
//
// WHAT IT CHECKS
//   1. The app sources — index.mount.jsx / portal.app.jsx / admin.app.jsx (extracted from
//      the pages on 2026-08-13) plus structure-studio.component.js and StructureStudio.jsx
//      — are parsed as JSX and linted with correctness-only rules (no style rules — this
//      gate must never argue about formatting):
//        no-undef, no-dupe-keys, no-dupe-args, no-const-assign, no-redeclare,
//        no-unreachable, no-dupe-else-if, no-self-assign, valid-typeof, use-isnan
//      Plus: no road back to in-browser Babel — no type="text/babel" tags and no served
//      babel-standalone tag on any page (the vendored Babel is the OFFLINE compiler now).
//   2. The vendored-dependency lock: all three pages must reference the SAME three /vendor/
//      library files (React, ReactDOM, supabase-js), every one must exist in the repo, and
//      none may be loaded from a CDN again.
//   3. Compiled-tag rules: every *.compiled.js tag is root-absolute, carries `defer`, never
//      `async`, and the shared component tag precedes the page's own app tag (deferred
//      scripts run in document order). Cache busters are content hashes kept in lockstep
//      between index.html and portal.html; whether each hash matches its artifact's real
//      bytes is checked by the artifact drift gate (recompile-and-diff via compile.mjs),
//      which also refuses a stale or hand-edited artifact.
//   4. The dependency boot guard is present on all three pages, byte-identical across them,
//      linted with the same correctness rules as the sources (its body swallows every
//      runtime error by design, so a typo inside is a silent no-op that byte-identity alone
//      would wave through), the LAST <script> in each body, sets __ssBootBlocked (how
//      compiled artifacts are neutralised) and checks the __ssAppBooted sentinel at
//      DOMContentLoaded (how a 404'd/HTML-served app artifact stops being a silent blank
//      page).
//   4b. The one dependency the guard cannot check itself: the shared component artifact.
//      index.mount.jsx must check the module global BEFORE rendering it (rendering
//      undefined throws React #130 onto a blank page — it reached Googlebot on 2026-08-06),
//      the check must sit before that render, both hosting app sources must report
//      `boot_component_missing`, every app source must publish the __ssAppBooted sentinel,
//      and the guard must keep publishing the failure screen the check reuses.
//   5. No Intuit API/OAuth host appears in a browser-served file. QuickBooks calls belong in
//      an edge function (qboFetch) — the client secret lives only there, and "we never call
//      Intuit from the browser" is an answer we give Intuit in writing. Help links to
//      quickbooks.intuit.com are deliberately still allowed.
//   6. `deno check` over every supabase/functions/*/index.ts. The browser artifacts above
//      have no compiler, but the edge functions DO — and nothing was running it, so type
//      errors accumulated silently: two sat in portal-settings' list_inventory long enough
//      that a later commit added two more on the very same line. This step is SKIPPED with
//      a warning when Deno isn't installed (it is not an npm devDependency).
//   7. `deno test` over the edge-function unit tests — the parts of supabase/functions that
//      cannot be exercised any other way. Two groups with different invocations: the
//      self-contained `_shared/*.test.ts` (currently the OAuth discovery document's endpoint
//      validation, which guards where the client secret gets sent), and the pre-existing
//      `_shared/_test_stubs/*_test.ts`, which needs its own import map. Same skip-with-a-warning
//      policy as step 6.
//
// Steps are numbered in the order they RUN.
//
// Zero output on success. Any failure prints the file, line, and message, and exits 1 —
// which makes the pre-push hook refuse the push.

import { Linter } from "eslint";
import globalsPkg from "globals";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// The compile targets are the single source of truth for WHICH sources exist and how each
// one is assembled. Importing them means a new file (or a new portal part) is linted the
// moment it is compiled -- the alternative, a second hand-kept list here, is precisely how
// this gate has twice ended up reporting clean while running zero rules.
import { TARGETS, targetName, readTarget, PORTAL_PARTS } from "./compile.mjs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

// Page-level globals. `browser` covers window/document/location/fetch/…; the rest are the
// UMD/CDN globals the pages rely on, plus the two cross-block publishes on window that the
// thin mount pages read back as bare identifiers.
const PAGE_GLOBALS = {
  ...globalsPkg.browser,
  React: "readonly",
  ReactDOM: "readonly",
  supabase: "readonly",          // supabase-js UMD (createClient namespace)
  StructureStudio: "readonly",   // published by the shared module
  ssAllowedOrigin: "readonly",   // published by the shared module
  google: "readonly",            // Maps/Places, loaded at runtime when configured
};

const RULES = {
  "no-undef": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-const-assign": "error",
  "no-redeclare": "error",
  "no-unreachable": "error",
  "no-dupe-else-if": "error",
  "no-self-assign": "error",
  "valid-typeof": "error",
  "use-isnan": "error",
};

const linter = new Linter();
const lintConfig = {
  // Inline eslint comments are ignored: the sources carry disables for rules this gate
  // doesn't load (react-hooks/*), which ESLint otherwise reports as unknown-rule errors —
  // and a correctness gate shouldn't be switch-off-able from inside the file anyway.
  linterOptions: { noInlineConfig: true },
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",        // tolerates import/export in the .jsx twin
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: PAGE_GLOBALS,
  },
  rules: RULES,
};

function lint(label, code, lineOffset = 0) {
  // NO filename argument, deliberately. With a filename, ESLint's flat config matches it
  // against file patterns — and a display label like "portal.html <script #2>" matches
  // nothing, so ESLint returns a SEVERITY-1 fatal ("No matching configuration found") and
  // runs zero rules. Combined with a severity===2 filter, that made the whole gate lint
  // nothing and report clean — caught by the --self-test, which is why it exists.
  const messages = linter.verify(code, lintConfig);
  return messages
    .filter((m) => m.severity === 2 || m.fatal)
    .map((m) => `${label}:${(m.line || 0) + lineOffset}  ${m.ruleId ?? "fatal"}  ${m.message}`);
}

// (babelBlocks() lived here until 2026-08-13 — the pages carry no inline app code now;
// the extracted .jsx sources are linted as whole files instead.)

function run(files) {
  const errors = [];

  // The app sources: the three per-page .jsx files (extracted from the pages on
  // 2026-08-13, when in-browser Babel was removed) plus the two component twins.
  // The pages themselves carry no app code anymore — they get structural rules
  // below, not a lint.
  for (const f of ["index.mount.jsx", "portal.app.jsx", "admin.app.jsx",
                   "structure-studio.component.js", "StructureStudio.jsx"]) {
    errors.push(...lint(f, files[f]));
  }

  // No going back to in-browser compilation. A text/babel tag on a page would
  // load-bearing-ly do NOTHING now (babel-standalone is not served), and a
  // babel-standalone tag would hand every visitor a 2.85MB compiler again —
  // the exact cost the compiled-artifact architecture removed. The vendored
  // Babel file itself STAYS in /vendor/ as scripts/compile.mjs's compiler.
  for (const f of ["index.html", "portal.html", "admin.html"]) {
    if (/type="text\/babel"/.test(files[f])) {
      errors.push(`${f}: a type="text/babel" tag reappeared — the pages ship compiled artifacts `
        + "(npm run compile); in-browser Babel was removed 2026-08-13 and is no longer served, "
        + "so this tag would silently never execute");
    }
    if (/<script[^>]*src="[^"]*babel-standalone/.test(files[f])) {
      errors.push(`${f}: a babel-standalone script tag reappeared — the vendored Babel is the `
        + "OFFLINE compiler (scripts/compile.mjs), never served to visitors");
    }
  }

  // Vendored-dependency lock. Replaced the old CDN version lock when React / ReactDOM /
  // supabase-js / babel-standalone moved to /vendor/ (2026-08-06) — a blocked third-party request
  // had blanked the page twice, once to Googlebot. Note the old rule could not simply be left in
  // place: it compared the set of `https://` script srcs, which is now EMPTY on all three pages,
  // so it would have passed vacuously forever — exactly the silent-pass failure this file keeps
  // getting bitten by. Three checks, because "same on all pages" is no longer sufficient on its
  // own once the files are ours to lose.
  const libTags = (html) =>
    [...html.matchAll(/<script src="(\/vendor\/[^"]+)"/g)].map((m) => m[1]).join("\n");
  const lock = libTags(files["index.html"]);
  if (!lock) {
    errors.push("index.html: no /vendor/ library tags — the four dependencies must be self-hosted "
      + "(provenance and the update recipe are in vendor/README.md)");
  }
  for (const f of ["portal.html", "admin.html"]) {
    if (libTags(files[f]) !== lock) {
      errors.push(`${f}: /vendor/ library tags differ from index.html — same source text, different `
        + "Babel/React, so one page moving alone silently changes behaviour (CLAUDE.md)");
    }
  }
  // Referenced but absent is the new failure mode self-hosting introduces, and it is worse than a
  // CDN outage: it would be permanent and it would hit EVERY page load, not a subset of visitors.
  for (const src of lock.split("\n").filter(Boolean)) {
    if (!existsSync(join(root, src.replace(/^\//, "")))) {
      errors.push(`${src}: referenced by all three pages but not present in the repo — every `
        + "visitor would land on the boot guard's fallback message");
    }
  }
  // And no quietly going back to a CDN for these four. exceljs is deliberately NOT covered: it is
  // injected on demand for a spreadsheet export, so a failed fetch costs one button rather than
  // the whole page — which is also why its tag is dynamic rather than static.
  const LIB_CDN =
    /https:\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\/[^"'\s]*(?:react|supabase-js|babel)[^"'\s]*/i;
  for (const f of ["index.html", "portal.html", "admin.html"]) {
    const hit = files[f].match(LIB_CDN);
    if (hit) {
      const line = files[f].slice(0, hit.index).split("\n").length;
      errors.push(`${f}:${line}  ${hit[0]} — React/ReactDOM/supabase-js/babel-standalone must come `
        + "from /vendor/, never a CDN: one blocked third-party request blanks the whole page "
        + "(happened 2026-08-04, and 2026-08-05 to Googlebot)");
    }
  }

  // Boot-guard lock — the plain <script data-ss-app="…"> block at the end of each page's body
  // must exist on all three, and its body must be byte-identical everywhere. It is the only
  // thing standing between a dependency that did not load and a permanently blank page (a blank
  // page is what shipped until 2026-08-05, once to Googlebot), and unlike the designer the three
  // mount blocks are NOT hand-mirrored twins — so nothing else in the repo would notice one page
  // losing the guard or drifting from the others. Same argument as the vendored lock above.
  // Self-hosting the four libraries removed the CAUSE of both logged incidents, but not the class:
  // a routing rule, an incomplete deploy or a dropped connection can still lose a file, so the
  // guard stays. The per-page label lives on the tag attribute, outside the compared body.
  //
  // The tag regex tolerates attributes after the label ([^>]*) on purpose: adding a CSP nonce to
  // the tag must not read as "guard is missing" — that message would send someone hunting for a
  // guard that is right there, and the plausible fix for a phantom missing guard is deleting the
  // rule that reports it.
  const GUARD_TAG = /<script data-ss-app="[^"]*"[^>]*>([\s\S]*?)<\/script>/;
  const guards = {};
  for (const f of ["index.html", "portal.html", "admin.html"]) {
    const html = files[f];
    const m = html.match(GUARD_TAG);
    guards[f] = m ? m[1] : null;
    if (!m) {
      errors.push(`${f}: the dependency boot guard (<script data-ss-app="…">) is missing — a `
        + "dependency that failed to load would leave the visitor a blank page again");
      continue;
    }
    // The guard is the ONE script on these pages whose body deliberately swallows every error
    // (a guard that throws is worse than no guard) — which also makes it the one place a typo
    // is a SILENT no-op on all three pages at once, and the byte-identity rule below would pass
    // three identically-broken copies without a murmur. So it gets the same correctness lint as
    // every babel block, at push time instead of never.
    errors.push(...lint(`${f} <boot guard>`, m[1],
      html.slice(0, m.index).split("\n").length - 1 + 1));
    // And its POSITION is load-bearing, not a style choice: byte-identical bytes hoisted into
    // <head> run before the four vendor tags have loaded, see all four globals missing, and
    // replace EVERY healthy page with the failure screen — the catastrophic false positive —
    // while passing the byte-identity rule below. The guard's own comment explains why it must
    // be plain JS at the end of the body; this asserts the "end of the body" half. Checked as
    // "no <script after the guard's closing tag", NOT lastIndexOf over the whole page — the
    // guard's own comment says "<script>" in prose, which a whole-page scan mistakes for a tag
    // (the nonce self-test caught exactly that on this rule's first draft).
    if (/<script\b/i.test(html.slice(m.index + m[0].length))) {
      errors.push(`${f}: the dependency boot guard is not the LAST <script> in the body — earlier `
        + "than that (e.g. hoisted into <head>) it runs before the vendor tags load, sees all four "
        + "globals missing, and replaces a healthy page with the failure screen; later scripts "
        + "would escape its neutralise step");
    }
  }
  for (const f of ["portal.html", "admin.html"]) {
    if (guards[f] !== null && guards["index.html"] !== null && guards[f] !== guards["index.html"]) {
      errors.push(`${f}: the dependency boot guard body differs from index.html — the three copies `
        + "must stay byte-identical (only the data-ss-app label may differ)");
    }
  }

  // ── The one dependency the boot guard CANNOT see ──────────────────────────────────────────
  // structure-studio.component.js is a src'd text/babel file, so Babel fetches it by XHR AFTER
  // the guard has already run and returned. When it does not load, all four library globals are
  // present, the guard stays correctly silent, and index.html's mount block holds `undefined` —
  // which it then renders, throwing React error #130 onto a permanently blank page. That is not
  // hypothetical: it reached GOOGLEBOT crawling a tenant's shopfront on 2026-08-06 (app_errors
  // 96ce38ff). Vendoring did not touch this path — the module was always same-origin.
  //
  // So the check has to live in the mount block (only it runs late enough to see the module) and
  // therefore cannot be covered by the guard's byte-identity rule. Three things are asserted:
  // the check EXISTS, it sits BEFORE the render it protects, and both host pages still report the
  // cause. Note the two pages get deliberately DIFFERENT treatment and byte-identity would be the
  // wrong rule: on index.html the module is the whole page, while the portal only loses its
  // Designer tab and must NOT be blanked over it (verified: the portal renders its normal 3,261
  // chars with the module absent).
  const BOOT_COMPONENT_CODE = "boot_component_missing";
  if (guards["index.html"] !== null && !/window\.ssBootFail\s*=/.test(guards["index.html"])) {
    errors.push("index.html: the boot guard no longer publishes ssBootFail — the mount blocks call "
      + "it to show the same failure screen when the shared component module is the thing that did "
      + "not load, so without it that path throws instead of reporting");
  }
  // The guard's two compiled-world invariants (added 2026-08-13, when in-browser Babel left
  // the pages). __ssBootBlocked is the neutralise mechanism now — every compiled artifact
  // opens with `if (window.__ssBootBlocked) return;`, and the old text/babel type-flip
  // cannot stop an already-parsed classic script. The __ssAppBooted sentinel is the only
  // thing that can see a page whose OWN app artifact never ran (404, or served as HTML by
  // the /portal/* splat) — the failure class the inline-babel world swallowed whole.
  if (guards["index.html"] !== null) {
    if (!/__ssBootBlocked\s*=\s*true/.test(guards["index.html"])) {
      errors.push("index.html: the boot guard no longer sets window.__ssBootBlocked — that flag is "
        + "how compiled app scripts are stopped from running on top of the failure screen; without "
        + "it a failed library still gets the old blank-page throw on top of the message");
    }
    if (!/__ssAppBooted/.test(guards["index.html"])) {
      errors.push("index.html: the boot guard no longer checks the __ssAppBooted sentinel at "
        + "DOMContentLoaded — a 404'd or HTML-served app artifact goes back to being a silent "
        + "blank page, the one failure class no in-page check could see before");
    }
  }
  // Order, not just presence. After the render the throw has already happened, so a check that
  // moved below it would pass a presence-only rule while restoring the exact blank page.
  // Anchored in index.mount.jsx — the page's app SOURCE — since the page carries no app code.
  const iCheck = files["index.mount.jsx"].search(/if\s*\(\s*!\s*StructureStudio\s*\)/);
  const iRender = files["index.mount.jsx"].search(/root\.render\(\s*<StructureStudio\s*\/>\s*\)/);
  const iShows = files["index.mount.jsx"].search(/ssBootFail\s*\(/);
  if (iCheck < 0) {
    errors.push("index.mount.jsx: the mount renders the shared module's component without first "
      + "checking that it loaded (`if (!StructureStudio)`) — if the module did not load this "
      + "renders undefined, throws React error #130, and leaves the visitor a blank page "
      + "(happened 2026-08-06, to Googlebot)");
  } else if (iRender < 0) {
    // The anchor going blind is this file's signature failure: a rule whose regex stops matching
    // reports clean forever and nobody finds out. If the render is respelled, the ORDER half of
    // this rule silently stops existing, so say so instead of quietly degrading to presence-only.
    errors.push("index.mount.jsx: the shared-module check is present but `root.render(<StructureStudio/>)` "
      + "no longer matches, so the check-before-render half of this rule can no longer be verified — "
      + "re-anchor it in scripts/preflight.mjs rather than leaving it silently inert");
  } else if (iCheck > iRender) {
    errors.push("index.mount.jsx: the shared-module check sits AFTER root.render(<StructureStudio/>) — "
      + "by then the #130 throw has already happened, so the check protects nothing");
  }
  // Reporting is not enough on index: there the module IS the page, so the visitor must get
  // the failure SCREEN, not just a row in our table. Without this, downgrading index to
  // portal's deliberate report-only treatment would pass every other rule here while handing
  // the visitor back the blank page this whole change exists to remove.
  if (iShows < 0) {
    errors.push("index.mount.jsx: nothing calls ssBootFail() — the check must SHOW the failure "
      + "screen here, not merely report; on this page the shared module is the entire page, so "
      + "report-only leaves the visitor the same blank page as before");
  }
  // The app sources carry no copy of the guard, so a plain search is a real rule here (the
  // old page-level version had to strip the guard body first to avoid a vacuous match).
  for (const f of ["index.mount.jsx", "portal.app.jsx"]) {
    if (!files[f].includes(BOOT_COMPONENT_CODE)) {
      errors.push(`${f}: nothing reports "${BOOT_COMPONENT_CODE}" — this app hosts the shared `
        + "component module, and a module that stops being served must not fail silently "
        + "(index.mount shows the boot guard's screen; portal.app degrades to its Designer "
        + "tab message, which is invisible to us unless it reports)");
    }
  }
  // Every app source must end in the sentinel the guard's DOMContentLoaded check reads. An
  // app artifact that runs to completion without announcing itself makes the sentinel fire
  // on every healthy load — the catastrophic false positive — and one that never sets it
  // was the point of the sentinel in the first place.
  for (const f of ["index.mount.jsx", "portal.app.jsx", "admin.app.jsx"]) {
    if (!/window\.__ssAppBooted\s*=\s*true/.test(files[f])) {
      errors.push(`${f}: does not set window.__ssAppBooted — the boot guard would report `
        + "boot_app_missing on every healthy load of its page");
    }
  }

  // portal.html's module tag must stay ROOT-ABSOLUTE, and this rule is the only thing that can
  // protect the ONE failure mode no in-page check can reach. If the module URL resolves to
  // something under /portal/ that is not a real asset, the `/portal/*` splat in _redirects returns
  // portal.html itself with HTTP 200 text/html — Babel is handed "<!DOCTYPE html>", throws a
  // SyntaxError inside its own runner, and that throw ABORTS THE WHOLE QUEUE: the mount block
  // never executes, so the page is blank AND completely unlogged, because the error reporter lives
  // in the block that never ran. A check inside the mount block cannot help, by construction.
  // That is not theoretical — it shipped, from exactly this cause: at /portal/settings/colors a
  // relative src asked for /portal/settings/structure-studio.component.js and blanked the entire
  // portal (see the comment above the tag). The src was made root-absolute to fix it, and NOTHING
  // was enforcing that it stays so: the cache-buster regex below matches the relative and
  // root-absolute forms identically, so a regression would pass the gate silently. A missing
  // root-level file, by contrast, 404s cleanly on every host (`not_found_handling: "404-page"`)
  // and the mount block's check handles it. index.html is deliberately exempt — it is only ever
  // served from the root, which is documented at its own tag.
  // Script ORDERING on these pages is load-bearing in two different ways, and both are asserted
  // rather than left to habit.
  //
  // (1) The compiled app tags. Every *.compiled.js tag must be ROOT-ABSOLUTE (portal.html is
  // served at /portal/<page>/<sub> too, where a relative src resolves against URL depth and
  // the /portal/* splat answers with portal.html at HTTP 200 — a classic script handed HTML
  // is a SyntaxError, and only the guard's sentinel would notice), must carry `defer` (defer
  // executes after parsing — after the guard has set or not set __ssBootBlocked — and in
  // DOCUMENT ORDER; a tag without defer executes mid-parse, BEFORE the guard exists), must
  // NOT carry `async` (async abandons document order, so the mount can run before the
  // component published anything), and the shared component tag must PRECEDE the page's own
  // app tag for the same document-order reason.
  for (const f of ["index.html", "portal.html", "admin.html"]) {
    const tags = [...files[f].matchAll(/<script([^>]*)src="([^"]*\.compiled\.js[^"]*)"[^>]*>/g)];
    for (const t of tags) {
      const attrs = t[1] + " ";
      if (!t[2].startsWith("/")) {
        errors.push(`${f}: compiled tag src "${t[2]}" is not root-absolute — under /portal/* a `
          + "relative src resolves to portal.html at HTTP 200 and the script dies on HTML with "
          + "only the sentinel to notice. Use a leading /");
      }
      if (!/\sdefer\b/.test(attrs)) {
        errors.push(`${f}: compiled tag for "${t[2]}" is missing \`defer\` — without it the script `
          + "executes mid-parse, before the boot guard has run, so a failed library gets the old "
          + "blank-page throw instead of the failure screen");
      }
      if (/\sasync\b/.test(attrs)) {
        errors.push(`${f}: compiled tag for "${t[2]}" carries \`async\` — async abandons document `
          + "order, so the page's mount can run before the shared component has published itself");
      }
    }
  }
  for (const f of ["index.html", "portal.html"]) {
    const comp = files[f].search(/<script[^>]*src="\/structure-studio\.component\.compiled\.js/);
    const own = files[f].search(f === "index.html"
      ? /<script[^>]*src="\/index\.mount\.compiled\.js/
      : /<script[^>]*src="\/portal\.app\.compiled\.js/);
    if (comp < 0) {
      errors.push(`${f}: no /structure-studio.component.compiled.js tag — this page mounts the `
        + "shared module and cannot work without it");
    } else if (own >= 0 && comp > own) {
      errors.push(`${f}: the shared component tag sits AFTER the page's own app tag — deferred `
        + "scripts run in document order, so the mount would run before StructureStudio exists`");
    }
  }
  // (2) The /vendor/ tags must not be async/defer — and THIS one is the real
  // catastrophic false positive, the older hazard, and the one nothing was enforcing. The guard
  // works only because those tags block parsing, so all four have resolved by the time it runs (its
  // own comment says exactly that). Reproduced with `defer` on /vendor/react: React loaded fine and
  // was present on the finished page, but the guard had already run, found it missing, and replaced
  // a page that WOULD have worked with a screen reading "did not load (react)" — on all three pages
  // at once, for every visitor. This was hand-checked when the guard shipped and then trusted to
  // habit; habit is not a gate.
  for (const f of ["index.html", "portal.html", "admin.html"]) {
    for (const tag of files[f].matchAll(/<script[^>]*src="\/vendor\/[^>]*>/g)) {
      if (/\s(?:async|defer)\b/.test(tag[0])) {
        errors.push(`${f}: a /vendor/ library tag carries async/defer (${tag[0].slice(0, 80)}…) — the `
          + "boot guard runs during parsing and depends on all four having resolved by then, which "
          + "is only true while they block parsing. Deferred, the library still loads and the page "
          + "would have WORKED, but the guard fires first and shows every visitor the failure screen");
      }
    }
  }
  // (The old dedicated portal-module root-absolute rule folded into the compiled-tag rules
  // above, which assert root-absolute + defer + order for every compiled tag on every page.)

  // Intuit API/OAuth hosts must never appear in a browser-served file. Every QuickBooks call
  // goes through qboFetch inside an edge function, and that is load-bearing twice over: the
  // client secret exists only server-side, and it is what we attest to Intuit in the App
  // Assessment questionnaire ("what platform do you make API calls from" → Web/SaaS, and "are
  // the client id and secret stored securely, not displayed in browser console logs" → yes).
  // A browser-side call would silently falsify both, and nothing else in the repo would notice.
  // Scoped to the API/OAuth hosts on purpose: a help or marketing link to quickbooks.intuit.com
  // is legitimate and must keep passing.
  const INTUIT_API_HOST =
    /(?:quickbooks\.api|sandbox-quickbooks\.api|oauth\.platform|appcenter|developer\.api)\.intuit\.com/i;
  for (const f of ["index.html", "portal.html", "admin.html",
                   "structure-studio.component.js", "StructureStudio.jsx"]) {
    const hit = files[f].match(INTUIT_API_HOST);
    if (hit) {
      const line = files[f].slice(0, hit.index).split("\n").length;
      errors.push(`${f}:${line}  Intuit API host "${hit[0]}" in a browser-served file — `
        + "QuickBooks calls must go through an edge function (qboFetch), never the browser");
    }
  }

  // Every action in a gated edge function must have a line in that function's GATES table.
  //
  // WHY THIS IS A PUSH-BLOCKING RULE. Per-person access (migration 100) is enforced by one
  // table per function, checked in resolveTenant before dispatch. That design is only sound
  // while the table is COMPLETE: these functions are long `if (action === "x")` chains, so a
  // branch is reachable the moment it is written. resolveTenant refuses actions missing from
  // the table, which turns the mistake into a 403 instead of an open endpoint — but a 403 on
  // a brand-new feature reads like a bug in the feature, and the tempting fix is to widen the
  // gate rather than to write the right one. Catching it here says exactly what is wrong.
  // The reverse (a table entry with no branch) is caught too: a stale line is a claim that
  // something is protected when nothing by that name exists.
  for (const fn of ["portal-settings", "portal-schedule", "portal-billing", "sync-design-status"]) {
    const src = readFileSync(join(root, "supabase", "functions", fn, "index.ts"), "utf8");
    const start = src.indexOf("const GATES: GateTable = {");
    if (start < 0) {
      errors.push(`supabase/functions/${fn}/index.ts: no GATES table — every JWT-authenticated `
        + "function must declare one (see _shared/access.ts)");
      continue;
    }
    const rest = src.slice(start);
    const end = rest.search(/\n\};/);
    const table = rest.slice(0, end);
    const body = rest.slice(end);
    // [a-z0-9_] not [a-z_]: an action name carrying a DIGIT (save_style_d3) never matched, so
    // the table could not satisfy this rule for it by ANY spelling. The only ways out were
    // renaming a deployed action or --no-verify -- i.e. a correctness gate teaching people to
    // bypass it. Surfaced by the 3D merge, which grafted six such actions in at once.
    const gated = new Set([...table.matchAll(/^\s*([a-z0-9_]+)\s*:/gm)].map((m) => m[1]));
    const used = new Set([...body.matchAll(/action\s*===\s*"([^"]+)"/g)].map((m) => m[1]));
    for (const a of used) {
      if (!gated.has(a)) {
        errors.push(`supabase/functions/${fn}/index.ts: action "${a}" has no entry in GATES — `
          + "add the area and level it requires, or it is refused at runtime");
      }
    }
    for (const a of gated) {
      if (!used.has(a)) {
        errors.push(`supabase/functions/${fn}/index.ts: GATES lists "${a}" but no branch handles `
          + "it — remove the stale entry so the table describes what actually exists");
      }
    }
  }

  // Cache-buster lockstep between the two hosts of the shared component artifact. Busters
  // are CONTENT HASHES now, rewritten by `npm run compile`; whether each hash matches its
  // artifact's real bytes is the compile drift gate's job (it recompiles and compares) —
  // this in-memory rule keeps the two pages honest against each other.
  const buster = (html) => (html.match(/structure-studio\.component\.compiled\.js\?v=([a-zA-Z0-9]+)/) || [])[1];
  const vi = buster(files["index.html"]);
  const vp = buster(files["portal.html"]);
  if (!vi || !vp || vi !== vp) {
    errors.push(`cache-buster mismatch: index.html has v=${vi ?? "MISSING"}, portal.html has v=${vp ?? "MISSING"}`);
  }

  // No ORPHAN portal part. A .jsx under portal/ that is not in PORTAL_PARTS is not compiled,
  // not linted and not shipped -- it just silently does nothing, which is the worst possible
  // failure for a file someone believes they are editing. The reverse (a listed part that is
  // missing) already fails loudly, because compile.mjs cannot read it.
  const partSet = new Set(PORTAL_PARTS);
  for (const f of readdirSync(join(root, "portal")).filter((f) => f.endsWith(".jsx"))) {
    if (!partSet.has(`portal/${f}`)) {
      errors.push(`portal/${f}: not listed in PORTAL_PARTS (scripts/compile.mjs) -- it is `
        + "compiled by nothing, linted by nothing and shipped nowhere. Add it in the right "
        + "ORDER position, or delete it.");
    }
  }

  return errors;
}

const load = () => Object.fromEntries([
  ...["index.html", "portal.html", "admin.html"].map((f) => [f, read(f)]),
  // Every compile target, under its reported name and with its parts already assembled --
  // so `files["portal.app.jsx"]` is the exact text that gets compiled even though no such
  // file exists on disk anymore (it is portal/01-core.jsx ... 08-shell.jsx since 2026-08-19).
  ...TARGETS.map((t) => [targetName(t), readTarget(t)]),
  ["StructureStudio.jsx", read("StructureStudio.jsx")],
]);

// ── Compiled artifacts: the drift gate ───────────────────────────────────────────────────
// The pages ship artifacts compiled OFFLINE from the sources linted above (scripts/
// compile.mjs, using the vendored babel-standalone as the compiler). Recompile-and-diff is
// deliberately the freshness rule — strictly stronger than any manifest bookkeeping, since
// a hand-edited artifact with self-consistent bookkeeping still fails a byte compare. Also
// covers the content-hash ?v= busters on every page. Runs on real disk files, like the
// deno steps, so it lives outside run(files).
async function artifactCheck() {
  const { checkArtifacts, compileSource } = await import("./compile.mjs");
  // Vacuity guard, the lesson this script keeps re-learning: a compiler that silently
  // stopped compiling must not read as "everything is fresh".
  if (!compileSource("const x = <a/>;", "probe.jsx").includes("React.createElement")) {
    return ["compile self-check failed: the vendored Babel produced no JSX output — the artifact drift gate cannot run"];
  }
  return checkArtifacts();
}

// ── Edge functions: deno check ───────────────────────────────────────────────────────────
// Deliberately NOT part of run(files): everything above works on an in-memory copy so the
// self-test can mutate it, whereas this shells out to a real type-checker over real paths.
const FUNCTIONS_DIR = "supabase/functions";

// Spawn deno WITHOUT a shell. Passing an args array with shell:true makes Node print a
// DEP0190 deprecation warning to stderr, and this gate's contract is that zero output means
// go — a permanent warning on every clean push would train everyone to ignore its output.
//
// EVERY ARG MUST BE SPACE-FREE: the ENOENT retry below joins them into one command string
// (an args array there would reintroduce DEP0190). Callers pass relative paths with `cwd`
// rather than absolute ones, which keeps that true even under a username with a space.
function runDeno(args, cwd) {
  const opts = { encoding: "utf8", ...(cwd ? { cwd } : {}) };
  const res = spawnSync("deno", args, opts);
  // Windows: a scoop/choco/npm-shim install is deno.cmd, which CreateProcess will not
  // resolve. Only then is a shell worth the trouble.
  if (res.error && res.error.code === "ENOENT") {
    return spawnSync(["deno", ...args].join(" "), { ...opts, shell: true });
  }
  return res;
}

// One entrypoint per function directory. `_shared/` is skipped because it has no index.ts
// and is type-checked transitively through the imports anyway. Discovered rather than
// listed, so a newly-added function is covered the day it lands.
function edgeEntrypoints() {
  const dir = join(root, FUNCTIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => `${e.name}/index.ts`)
    .filter((rel) => existsSync(join(dir, rel)))
    .sort();
}

function denoInstalled() {
  // Probed explicitly instead of interpreting a failed `deno check`. Via the shell fallback a
  // missing binary is NOT ENOENT — cmd.exe reports "not recognized" and exits non-zero, which
  // is indistinguishable from real type errors. That would BLOCK pushes on every machine
  // without Deno, precisely the outcome this gate must never cause.
  const probe = runDeno(["--version"]);
  return !probe.error && probe.status === 0;
}

// Returns { errors, skipped, why }. Deno is not an npm devDependency, so a teammate may
// simply not have it: warn and continue, mirroring the hook's freshness check failing open
// when origin is unreachable. A gate that makes the repo unpushable is worse than the bugs
// it catches.
function denoCheck() {
  const entrypoints = edgeEntrypoints();
  if (!entrypoints.length) return { errors: [], skipped: true, why: `no function entrypoints under ${FUNCTIONS_DIR}/` };
  if (!denoInstalled()) return { errors: [], skipped: true, why: "deno is not installed or not on PATH" };

  // ONE invocation for all entrypoints, not one per function: the module graph and download
  // cache are shared, which is ~3s for all of them versus ~30s serially.
  //
  // --node-modules-dir=none is MANDATORY. This repo's own `npm install` (for the eslint
  // above) leaves a root node_modules that Deno then discovers and dies on — "Could not
  // find a matching package for 'npm:@supabase/realtime-js'". The functions are fine; the
  // resolver isn't. See the pre-push section of CLAUDE.md.
  const args = ["check", "--quiet", "--node-modules-dir=none", ...entrypoints];
  const res = runDeno(args, join(root, FUNCTIONS_DIR));
  if (res.status === 0) return { errors: [], skipped: false, count: entrypoints.length };

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return {
    errors: [`edge functions: deno check failed (${entrypoints.length} entrypoint(s) checked)\n${out}`],
    skipped: false,
    count: entrypoints.length,
  };
}

// ── Edge functions: deno test ────────────────────────────────────────────────────────────
// Unit tests for the parts of supabase/functions that CANNOT be exercised any other way. The
// first of them (_shared/qboDiscovery.test.ts) pins the validation on Intuit's OAuth discovery
// document — the token endpoint it names is where the client secret is sent, so a document that
// could move it is a credential-exfiltration primitive, and the only live way to test the module
// is to complete a real OAuth round trip. Same skip-with-a-warning policy as denoCheck().
//
// TWO GROUPS, because they need different invocations and the difference is not cosmetic:
//
//   _shared/*.test.ts          — self-contained (no jsr:/npm: imports), run with no import map.
//   _shared/_test_stubs/*_test.ts — the pre-existing resolveTenant suite. It REQUIRES its own
//                                import map (which rewrites jsr:@supabase/supabase-js@2 to a
//                                stub); without it 12 of its 14 cases fail on module resolution.
//
// The second group existed before this step did and nothing ran it automatically — it guards
// resolveTenant, which its own header notes sits in front of every tenant's settings, billing and
// designs. Discovering it by convention rather than listing it means a new file in either shape is
// covered the day it lands.
function testGroups() {
  const shared = join(root, FUNCTIONS_DIR, "_shared");
  const stubs = join(shared, "_test_stubs");
  const groups = [];

  if (existsSync(shared)) {
    const files = readdirSync(shared)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `_shared/${f}`)
      .sort();
    if (files.length) groups.push({ label: "_shared", files, importMap: null });
  }

  if (existsSync(stubs)) {
    const files = readdirSync(stubs)
      .filter((f) => f.endsWith("_test.ts"))
      .map((f) => `_shared/_test_stubs/${f}`)
      .sort();
    const map = "_shared/_test_stubs/import_map.json";
    if (files.length && existsSync(join(root, FUNCTIONS_DIR, map))) {
      groups.push({ label: "_test_stubs", files, importMap: map });
    }
  }

  return groups;
}

function denoTest() {
  const groups = testGroups();
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  if (!total) return { errors: [], skipped: true, why: `no test files under ${FUNCTIONS_DIR}/_shared/` };
  if (!denoInstalled()) return { errors: [], skipped: true, why: "deno is not installed or not on PATH" };

  const errors = [];
  for (const g of groups) {
    // --allow-env only: the tests stub globalThis.fetch / inject fake clients, so no network
    // permission is needed — and withholding it means a test that accidentally reaches the real
    // internet fails loudly instead of passing slowly.
    const args = ["test", "--quiet", "--allow-env", "--node-modules-dir=none"];
    if (g.importMap) args.push(`--import-map=${g.importMap}`);
    args.push(...g.files);
    const res = runDeno(args, join(root, FUNCTIONS_DIR));
    if (res.status !== 0) {
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
      errors.push(`edge functions: deno test failed in ${g.label} (${g.files.length} file(s))\n${out}`);
    }
  }
  return { errors, skipped: false, count: total, groups: groups.length };
}

if (process.argv.includes("--self-test")) {
  // The gate must FAIL on the exact incident that motivated it: commit a763b3b shipped
  // `RANK[st]` after the RANK definition was removed. Reconstruct that state by reverting
  // the one-word fix in the current file and expect no-undef to fire.
  const files = load();
  const fixed = "if (STATUS_RANK[st] > STATUS_RANK[g.topStatus]) g.topStatus = st;";
  if (!files["portal.app.jsx"].includes(fixed)) {
    console.error("self-test: fixture line not found in portal.app.jsx — update the self-test");
    process.exit(1);
  }
  files["portal.app.jsx"] = files["portal.app.jsx"].replace(fixed,
    "if (RANK[st] > STATUS_RANK[g.topStatus]) g.topStatus = st;");
  const errors = run(files);
  const caught = errors.some((e) => e.includes("no-undef") && e.includes("RANK"));
  if (!caught) {
    console.error("self-test FAILED: the reintroduced RANK bug was not caught. Errors were:");
    for (const e of errors) console.error("  " + e);
    process.exit(1);
  }
  console.log("self-test passed: the RANK regression is caught by no-undef");

  // ── The Intuit-host rule ───────────────────────────────────────────────────
  // Same silent-pass risk as everything else in this file: a regex that never matches is
  // indistinguishable from a clean repo. So prove BOTH directions — it fires on a real API call,
  // and it does not fire on a help link. The second half matters as much as the first: a rule
  // that flags legitimate links gets deleted by the next person it annoys.
  const withApiCall = load();
  withApiCall["portal.html"] = withApiCall["portal.html"].replace("</body>",
    '<script>fetch("https://quickbooks.api.intuit.com/v3/company/1/companyinfo/1")</script></body>');
  if (!run(withApiCall).some((e) => e.includes("Intuit API host"))) {
    console.error("self-test FAILED: an Intuit API host in portal.html was not caught");
    process.exit(1);
  }
  const withHelpLink = load();
  withHelpLink["portal.html"] = withHelpLink["portal.html"].replace("</body>",
    '<a href="https://quickbooks.intuit.com/learn-support/">QuickBooks help</a></body>');
  if (run(withHelpLink).some((e) => e.includes("Intuit API host"))) {
    console.error("self-test FAILED: a quickbooks.intuit.com help link tripped the Intuit-host rule");
    process.exit(1);
  }
  console.log("self-test passed: Intuit API hosts are refused in browser files, help links are not");

  // ── The boot-guard lock ────────────────────────────────────────────────────
  // Two regexes that never match are indistinguishable from three healthy pages, and this rule
  // exists precisely because nothing else notices a page losing its guard. Prove both failure
  // modes fire: a page with the guard deleted, and a page whose copy has drifted by one byte.
  const guardGone = load();
  guardGone["admin.html"] = guardGone["admin.html"].replace(/<script data-ss-app="[^"]*"[^>]*>[\s\S]*?<\/script>/, "");
  if (!run(guardGone).some((e) => e.includes("boot guard") && e.includes("missing"))) {
    console.error("self-test FAILED: a missing dependency boot guard in admin.html was not caught");
    process.exit(1);
  }
  const guardDrift = load();
  const driftFrom = 'missing.push("react-dom");';
  if (!guardDrift["portal.html"].includes(driftFrom)) {
    console.error("self-test: boot-guard fixture line not found in portal.html — update the self-test");
    process.exit(1);
  }
  guardDrift["portal.html"] = guardDrift["portal.html"].replace(driftFrom, 'missing.push("reactdom");');
  if (!run(guardDrift).some((e) => e.includes("boot guard body differs"))) {
    console.error("self-test FAILED: a drifted CDN boot guard in portal.html was not caught");
    process.exit(1);
  }
  console.log("self-test passed: the dependency boot guard must be present on all three pages and identical");

  // The guard LINT. Fire direction: a typo inside the guard's try/catch is a silent no-op at
  // runtime on all three pages at once, so prove no-undef reaches inside it. The typo goes into
  // ALL THREE copies identically, so byte-identity stays quiet and the failure is attributable
  // to the lint alone.
  const guardTypo = load();
  const typoFrom = "var missing = [];";
  if (!guardTypo["index.html"].includes(typoFrom)) {
    console.error("self-test: boot-guard lint fixture line not found in index.html — update the self-test");
    process.exit(1);
  }
  for (const f of ["index.html", "portal.html", "admin.html"]) {
    guardTypo[f] = guardTypo[f].replace(typoFrom, "var missing = misssingList;");
  }
  if (!run(guardTypo).some((e) => e.includes("<boot guard>") && e.includes("no-undef"))) {
    console.error("self-test FAILED: an undefined identifier inside the boot guard was not caught — "
      + "the guard's own try/catch makes that a silent no-op on every page in production");
    process.exit(1);
  }
  // Quiet direction: the real guard is plain pre-library JS and must lint CLEAN under the page
  // config — a rule that flags the healthy guard gets deleted by the next person it annoys.
  const guardLintNoise = run(load()).filter((e) => e.includes("<boot guard>"));
  if (guardLintNoise.length) {
    console.error("self-test FAILED: the pristine boot guard does not lint clean:");
    for (const e of guardLintNoise) console.error("  " + e);
    process.exit(1);
  }
  console.log("self-test passed: a typo inside the boot guard is caught by the lint, and the real guard lints clean");

  // The guard POSITION, both failure directions. Hoisted ahead of the vendor tags, byte-identical
  // bytes run before the libraries load, see all four globals missing, and replace EVERY healthy
  // page with the failure screen — while the missing/byte-identity rules pass. And a script added
  // AFTER the guard escapes its neutralise step. Both must land on the position error.
  const guardHoisted = load();
  const hoistMatch = guardHoisted["admin.html"].match(/<script data-ss-app="[^"]*"[^>]*>[\s\S]*?<\/script>/);
  if (!hoistMatch) {
    console.error("self-test: no boot guard found in admin.html to hoist — update the self-test");
    process.exit(1);
  }
  const firstTag = guardHoisted["admin.html"].indexOf("<script");
  guardHoisted["admin.html"] = guardHoisted["admin.html"].replace(hoistMatch[0], "");
  guardHoisted["admin.html"] = guardHoisted["admin.html"].slice(0, firstTag) + hoistMatch[0]
    + guardHoisted["admin.html"].slice(firstTag);
  if (!run(guardHoisted).some((e) => e.includes("admin.html") && e.includes("not the LAST <script>"))) {
    console.error("self-test FAILED: the boot guard hoisted above the vendor tags in admin.html was "
      + "not caught — it would fire on every healthy page load");
    process.exit(1);
  }
  const guardTrailing = load();
  guardTrailing["portal.html"] = guardTrailing["portal.html"].replace("</body>",
    "<script>/* added after the guard */</script></body>");
  if (!run(guardTrailing).some((e) => e.includes("portal.html") && e.includes("not the LAST <script>"))) {
    console.error("self-test FAILED: a script added after the boot guard in portal.html was not caught");
    process.exit(1);
  }
  console.log("self-test passed: the boot guard must be the last script in the body — hoisting it and trailing it are both caught");

  // A CSP nonce (or any future attribute) on the guard TAG must not read as "guard is missing" —
  // the body is unchanged, so every guard rule must stay quiet. This is the false-positive
  // direction of the tag regex, same reasoning as the Intuit help link and exceljs cases.
  const guardNonce = load();
  for (const f of ["index.html", "portal.html", "admin.html"]) {
    guardNonce[f] = guardNonce[f].replace(/<script data-ss-app="([^"]*)">/, '<script data-ss-app="$1" nonce="c3lfdGVzdA">');
    if (!guardNonce[f].includes('nonce="c3lfdGVzdA"')) {
      console.error(`self-test: could not add a nonce to the boot guard tag in ${f} — update the self-test`);
      process.exit(1);
    }
  }
  const nonceNoise = run(guardNonce).filter((e) => e.includes("boot guard"));
  if (nonceNoise.length) {
    console.error("self-test FAILED: a CSP nonce on the boot guard tag tripped the guard rules:");
    for (const e of nonceNoise) console.error("  " + e);
    process.exit(1);
  }
  console.log("self-test passed: a CSP nonce on the boot guard tag does not read as a missing guard");

  // ── The shared-module check (the dependency the guard cannot see) ───────────
  // This rule exists because the failure it prevents ALREADY SHIPPED and was crawled by
  // Googlebot (React #130 on a blank designer, app_errors 96ce38ff). Prove all four directions.
  const compCheckGone = load();
  compCheckGone["index.mount.jsx"] = compCheckGone["index.mount.jsx"].replace(/if \(!StructureStudio\) \{/, "if (false) {");
  if (!run(compCheckGone).some((e) => e.includes("without first checking that it loaded"))) {
    console.error("self-test FAILED: index.mount.jsx rendering the shared module with no loaded-check was "
      + "not caught — that is the exact #130 blank page that reached Googlebot");
    process.exit(1);
  }
  // Order matters as much as presence: a check that survives but moves below the render is the
  // same blank page with a rule that still passes.
  const compCheckAfter = load();
  const renderLine = "  root.render(<StructureStudio/>);";
  if (!compCheckAfter["index.mount.jsx"].includes(renderLine)) {
    console.error("self-test: render fixture line not found in index.mount.jsx — update the self-test");
    process.exit(1);
  }
  compCheckAfter["index.mount.jsx"] = compCheckAfter["index.mount.jsx"].replace(renderLine, "")
    .replace("if (!StructureStudio) {", renderLine + "\nif (!StructureStudio) {");
  if (!run(compCheckAfter).some((e) => e.includes("sits AFTER root.render"))) {
    console.error("self-test FAILED: a shared-module check moved below the render was not caught");
    process.exit(1);
  }
  const bootFailUnpublished = load();
  for (const f of ["index.html", "portal.html", "admin.html"]) {
    bootFailUnpublished[f] = bootFailUnpublished[f].replace("window.ssBootFail = ssBootFail;", "");
  }
  if (!run(bootFailUnpublished).some((e) => e.includes("no longer publishes ssBootFail"))) {
    console.error("self-test FAILED: a boot guard that stopped publishing ssBootFail was not caught — "
      + "the mount blocks' module-missing path would throw instead of showing the message");
    process.exit(1);
  }
  // The sources carry no guard copy, so the plain-search rule is exercised directly.
  const compReportGone = load();
  compReportGone["portal.app.jsx"] = compReportGone["portal.app.jsx"].replaceAll("boot_component_missing", "some_other_code");
  if (!run(compReportGone).some((e) => e.includes("boot_component_missing") && e.includes("portal.app.jsx"))) {
    console.error("self-test FAILED: portal.app.jsx no longer reporting a missing shared module was not "
      + "caught — its Designer tab would degrade silently");
    process.exit(1);
  }
  // The sentinel publish: an app source that stops announcing itself makes the guard report
  // boot_app_missing on every HEALTHY load of that page — assert the rule sees it gone.
  const sentinelGone = load();
  sentinelGone["admin.app.jsx"] = sentinelGone["admin.app.jsx"].replace(/window\.__ssAppBooted\s*=\s*true;/, "");
  if (!run(sentinelGone).some((e) => e.includes("__ssAppBooted") && e.includes("admin.app.jsx"))) {
    console.error("self-test FAILED: admin.app.jsx losing its __ssAppBooted sentinel was not caught — "
      + "the guard would fire on every healthy admin load");
    process.exit(1);
  }
  console.log("self-test passed: the shared-module check must exist, precede the render, keep its "
    + "reporter, and keep the guard's published failure screen");

  // The compiled-tag rules: root-absolute, defer required, async forbidden, component before
  // the page's own app tag, and no road back to in-browser Babel. Each direction fires.
  const relSrc = load();
  relSrc["portal.html"] = relSrc["portal.html"].replace(
    'src="/structure-studio.component.compiled.js', 'src="structure-studio.component.compiled.js');
  if (relSrc["portal.html"] === load()["portal.html"]) {
    console.error("self-test: portal.html's root-absolute compiled tag not found — update the self-test");
    process.exit(1);
  }
  if (!run(relSrc).some((e) => e.includes("not root-absolute"))) {
    console.error("self-test FAILED: a compiled src regressing to a relative path was not caught — "
      + "at /portal/<page>/<sub> that returns portal.html at 200 and the script dies on HTML");
    process.exit(1);
  }
  const deferGone = load();
  deferGone["index.html"] = deferGone["index.html"].replace(
    '<script defer src="/index.mount.compiled.js', '<script src="/index.mount.compiled.js');
  if (!run(deferGone).some((e) => e.includes("missing `defer`"))) {
    console.error("self-test FAILED: a compiled tag without defer was not caught — it would execute "
      + "mid-parse, before the boot guard exists");
    process.exit(1);
  }
  const asyncAdded = load();
  asyncAdded["portal.html"] = asyncAdded["portal.html"].replace(
    '<script defer src="/portal.app.compiled.js', '<script defer async src="/portal.app.compiled.js');
  if (!run(asyncAdded).some((e) => e.includes("carries `async`"))) {
    console.error("self-test FAILED: async on a compiled tag was not caught — document order would be "
      + "abandoned and the mount could run before the component published");
    process.exit(1);
  }
  const orderSwap = load();
  {
    const comp = orderSwap["index.html"].match(/<script defer src="\/structure-studio\.component\.compiled\.js[^>]*><\/script>/)[0];
    const own = orderSwap["index.html"].match(/<script defer src="\/index\.mount\.compiled\.js[^>]*><\/script>/)[0];
    orderSwap["index.html"] = orderSwap["index.html"].replace(comp, "@@SWAP@@").replace(own, comp).replace("@@SWAP@@", own);
  }
  if (!run(orderSwap).some((e) => e.includes("sits AFTER the page's own app tag"))) {
    console.error("self-test FAILED: the component tag moved below the page's app tag was not caught — "
      + "deferred scripts run in document order, so the mount would run first");
    process.exit(1);
  }
  const babelTagBack = load();
  babelTagBack["admin.html"] = babelTagBack["admin.html"].replace("</body>",
    '<script src="/vendor/babel-standalone-7.23.9.min.js"></script></body>');
  if (!run(babelTagBack).some((e) => e.includes("babel-standalone script tag reappeared"))) {
    console.error("self-test FAILED: a babel-standalone tag reintroduced into admin.html was not caught");
    process.exit(1);
  }
  const babelBlockBack = load();
  babelBlockBack["index.html"] = babelBlockBack["index.html"].replace("</body>",
    '<script type="text/babel">const x = 1;</script></body>');
  if (!run(babelBlockBack).some((e) => e.includes('type="text/babel" tag reappeared'))) {
    console.error("self-test FAILED: an inline text/babel block reintroduced into index.html was not caught");
    process.exit(1);
  }
  console.log("self-test passed: compiled tags must be root-absolute + defer'd, ordered component-first, "
    + "async is refused, and both roads back to in-browser Babel are closed");

  const libDefer = load();
  libDefer["portal.html"] = libDefer["portal.html"].replace(
    '<script src="/vendor/react-18.2.0', '<script defer src="/vendor/react-18.2.0');
  if (libDefer["portal.html"] === load()["portal.html"]) {
    console.error("self-test: portal.html's /vendor/react tag not found — update the self-test");
    process.exit(1);
  }
  if (!run(libDefer).some((e) => e.includes("library tag carries async/defer"))) {
    console.error("self-test FAILED: defer on a /vendor/ library tag was not caught — the library "
      + "still loads and the page would have worked, but the guard runs first and replaces it with "
      + "the failure screen for every visitor (reproduced in a browser with defer on react)");
    process.exit(1);
  }
  console.log("self-test passed: the /vendor/ library tags may not carry async/defer");

  // ── The vendored-dependency lock ────────────────────────────────────────────
  // This rule REPLACED one that had become vacuous, so proving it actually fires is the whole
  // point. Three directions, one per failure mode it owns.
  const libDrift = load();
  libDrift["portal.html"] = libDrift["portal.html"].replace(
    '<script src="/vendor/react-dom-18.2.0.production.min.js"></script>',
    '<script src="/vendor/react-dom-18.3.1.production.min.js"></script>');
  if (!run(libDrift).some((e) => e.includes("/vendor/ library tags differ"))) {
    console.error("self-test FAILED: portal.html loading a different React DOM build was not caught");
    process.exit(1);
  }
  const libGone = load();
  libGone["index.html"] = libGone["index.html"].replace(
    "/vendor/supabase-js-2.112.1.umd.min.js", "/vendor/supabase-js-2.999.0.umd.min.js");
  libGone["portal.html"] = libGone["portal.html"].replace(
    "/vendor/supabase-js-2.112.1.umd.min.js", "/vendor/supabase-js-2.999.0.umd.min.js");
  libGone["admin.html"] = libGone["admin.html"].replace(
    "/vendor/supabase-js-2.112.1.umd.min.js", "/vendor/supabase-js-2.999.0.umd.min.js");
  if (!run(libGone).some((e) => e.includes("not present in the repo"))) {
    console.error("self-test FAILED: a /vendor/ file referenced by all three pages but missing from "
      + "the repo was not caught — every visitor would get the fallback message");
    process.exit(1);
  }
  const cdnBack = load();
  cdnBack["admin.html"] = cdnBack["admin.html"].replace("</body>",
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script></body>');
  if (!run(cdnBack).some((e) => e.includes("must come") && e.includes("/vendor/"))) {
    console.error("self-test FAILED: a React CDN tag reintroduced into admin.html was not caught");
    process.exit(1);
  }
  // The other direction, same reasoning as the Intuit help-link case: exceljs is legitimately
  // CDN-loaded on demand (from portal.app.jsx, at runtime — the pages carry no such tag), and
  // a rule that flags it gets deleted by the next person it annoys. Injected here because the
  // rule scans PAGES; the injection proves the regex scoping, not repo content.
  const exceljsOk = load();
  exceljsOk["portal.html"] = exceljsOk["portal.html"].replace("</body>",
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js"></script></body>');
  const exceljsNoise = run(exceljsOk).filter((e) => e.includes("must come") && e.includes("/vendor/"));
  if (exceljsNoise.length) {
    console.error("self-test FAILED: an exceljs CDN tag tripped the vendored-lock rule");
    process.exit(1);
  }
  console.log("self-test passed: the three libraries must be vendored, identical, present, and not "
    + "CDN-loaded — while exceljs stays allowed");

  // ── The artifact drift gate ────────────────────────────────────────────────
  // Fire direction: a source edited without recompiling must produce different bytes than
  // the committed artifact (proven in memory — the real gate does this same compare on
  // disk). Quiet direction: the pristine repo must check clean. Vacuity direction: the
  // compiler must actually compile JSX, or "no drift" means "the gate is dead".
  {
    const { checkArtifacts, compileSource } = await import("./compile.mjs");
    if (!compileSource("const x = <a/>;", "probe.jsx").includes("React.createElement")) {
      console.error("self-test FAILED: the vendored Babel produced no JSX output — the drift gate is dead");
      process.exit(1);
    }
    const drifted = compileSource(read("index.mount.jsx") + "\nconsole.log('drift');\n", "index.mount.jsx");
    if (drifted === read("index.mount.compiled.js").replace(/\r\n/g, "\n")) {
      console.error("self-test FAILED: an edited source compiled to the same bytes as the committed "
        + "artifact — the drift compare cannot distinguish stale from fresh");
      process.exit(1);
    }
    const pristine = checkArtifacts();
    if (pristine.length) {
      console.error("self-test FAILED: the pristine repo does not pass the artifact drift gate:");
      for (const p of pristine) console.error("  " + p);
      process.exit(1);
    }
  }
  console.log("self-test passed: the artifact drift gate compiles for real, flags an edited source, "
    + "and passes the pristine repo");

  // ── The deno step ──────────────────────────────────────────────────────────
  // Asserts the MECHANISM, not a historical bug. A subprocess check whose clean result and
  // whose "tool missing" result both print nothing has an obvious silent-pass failure mode,
  // and this script has already been bitten by exactly that once (the lint matched no config,
  // ran ZERO rules, and reported clean). So prove two things: we actually found entrypoints,
  // and deno really does fail a file that has a type error.
  const entrypoints = edgeEntrypoints();
  if (!entrypoints.length) {
    console.error(`self-test FAILED: found no edge-function entrypoints under ${FUNCTIONS_DIR}/`);
    process.exit(1);
  }
  if (!denoInstalled()) {
    console.log(`self-test: deno not installed — cannot verify the edge-function step (${entrypoints.length} entrypoint(s) would be checked)`);
    process.exit(0);
  }
  const tmp = mkdtempSync(join(tmpdir(), "ss-preflight-"));
  try {
    // Written to a temp dir and checked as a RELATIVE path with cwd — the absolute path can
    // contain a space (any username with one), which runDeno's shell fallback cannot carry.
    writeFileSync(join(tmp, "bad.ts"), 'const n: number = "not a number";\nconsole.log(n);\n');
    const res = runDeno(["check", "--quiet", "--node-modules-dir=none", "bad.ts"], tmp);
    if (res.status === 0) {
      console.error("self-test FAILED: deno check passed a file with a type error — the edge-function step would never fail a push");
      process.exit(1);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`self-test passed: deno check fails on a type error, and ${entrypoints.length} edge-function entrypoint(s) are covered`);

  // ── The deno test step ─────────────────────────────────────────────────────
  // Same silent-pass hazard, one level up: if the discovery glob matched nothing, denoTest()
  // would skip and this gate would report clean while running zero tests. Assert files were
  // found, and that the runner really does fail a failing test.
  const groups = testGroups();
  const found = groups.flatMap((g) => g.files);
  if (!found.length) {
    console.error(`self-test FAILED: found no test files under ${FUNCTIONS_DIR}/_shared/`);
    process.exit(1);
  }
  // BOTH groups must be discovered. The _test_stubs suite was already in the repo and this step
  // originally missed it twice over — wrong directory AND a `_test.ts` rather than `.test.ts`
  // suffix — so it ran zero of those 14 cases while reporting clean.
  for (const want of ["_shared", "_test_stubs"]) {
    if (!groups.some((g) => g.label === want)) {
      console.error(`self-test FAILED: test group "${want}" was not discovered`);
      process.exit(1);
    }
  }
  const tmpT = mkdtempSync(join(tmpdir(), "ss-preflight-test-"));
  try {
    writeFileSync(join(tmpT, "fails.test.ts"),
      'Deno.test("deliberately failing", () => { throw new Error("boom"); });\n');
    const res = runDeno(["test", "--quiet", "--allow-env", "--node-modules-dir=none", "fails.test.ts"], tmpT);
    if (res.status === 0) {
      console.error("self-test FAILED: deno test passed a failing test — the unit-test step would never fail a push");
      process.exit(1);
    }
  } finally {
    rmSync(tmpT, { recursive: true, force: true });
  }
  console.log(`self-test passed: deno test fails on a failing test, and ${found.length} test file(s) are covered`);
  process.exit(0);
}

const errors = run(load());

errors.push(...await artifactCheck());

const deno = denoCheck();
errors.push(...deno.errors);
// Announced even on an otherwise clean run: a skip that printed nothing would read as
// "edge functions checked and fine" when nothing looked at them at all.
if (deno.skipped) {
  console.error(`preflight: edge-function type check SKIPPED — ${deno.why}.`);
  console.error("           supabase/functions/ is NOT covered by this run. Install Deno: https://docs.deno.com/runtime/getting_started/installation/");
}

const tests = denoTest();
errors.push(...tests.errors);
if (tests.skipped) {
  console.error(`preflight: edge-function unit tests SKIPPED — ${tests.why}.`);
}

if (errors.length) {
  console.error(`preflight: ${errors.length} error(s) — push refused\n`);
  for (const e of errors) console.error("  " + e);
  console.error("\nFix the above, or in a genuine emergency: git push --no-verify (and say so in the commit).");
  process.exit(1);
}
