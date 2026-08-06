// Pre-push correctness gate.
//
// WHY THIS EXISTS: this product has NO build step — the pages ship JSX that
// babel-standalone compiles in the browser, so nothing catches a broken reference until a
// customer's tab throws. On 2026-07-30 a refactor renamed LeadsTable's private RANK to the
// shared STATUS_RANK but missed one usage; it shipped, load() threw ReferenceError on the
// first row, and the Contacts tab sat on "Loading…" for every tenant until it was traced
// through app_errors. ESLint's no-undef catches that class of bug in two seconds, before
// the push. That incident is also this script's self-test fixture (see --self-test).
//
// WHAT IT CHECKS
//   1. Every inline <script type="text/babel"> block in index.html / portal.html /
//      admin.html, plus structure-studio.component.js and StructureStudio.jsx, is parsed
//      as JSX and linted with correctness-only rules (no style rules — this gate must
//      never argue about formatting):
//        no-undef, no-dupe-keys, no-dupe-args, no-const-assign, no-redeclare,
//        no-unreachable, no-dupe-else-if, no-self-assign, valid-typeof, use-isnan
//   2. The vendored-dependency lock (replaced the CDN version lock on 2026-08-06, when the four
//      libraries moved to /vendor/): all three pages must reference the SAME four /vendor/ files,
//      every one of those files must exist in the repo, and none of the four may be loaded from a
//      CDN again. One page moving alone silently changes behaviour, since the same source text is
//      compiled by whichever Babel that page loaded.
//   3. Cache-buster lockstep: index.html and portal.html must reference the same
//      structure-studio.component.js?v=… value.
//   4. The dependency boot guard is present on all three pages, byte-identical across them,
//      linted with the same correctness rules as the babel blocks (its body swallows every
//      runtime error by design, so a typo inside is a silent no-op that byte-identity alone
//      would wave through), and the LAST <script> in each body (hoisted above the vendor tags
//      it would run before they load and replace every healthy page with the failure screen).
//      It is what turns a dependency that did not load into a message the visitor can act on
//      instead of a permanently blank page; the three mount blocks are not twinned, so only
//      this notices one page drifting.
//   4b. The one dependency that guard CANNOT see: structure-studio.component.js, which Babel
//      fetches by XHR after the guard has already run. So index.html's mount block must check
//      the module global BEFORE rendering it (rendering undefined throws React #130 onto a
//      blank page — it reached Googlebot on 2026-08-06), the check must sit before that render,
//      both host pages must still report `boot_component_missing`, and the guard must keep
//      publishing the failure screen the check reuses. Plus portal.html's module src must stay
//      ROOT-ABSOLUTE: relative, it resolves under /portal/, the splat answers with portal.html
//      at HTTP 200, and Babel's throw on that HTML aborts every block — the one failure mode no
//      in-page check can reach, so the gate is its only defence.
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
  Babel: "readonly",
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

// Pull every inline text/babel block with its line offset so reported lines match the
// real file. The src= module tag has no body and is skipped.
function babelBlocks(html) {
  const out = [];
  const re = /<script[^>]*type="text\/babel"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (!m[1].trim()) continue;
    const before = html.slice(0, m.index);
    out.push({ code: m[1], lineOffset: before.split("\n").length - 1 + 1 });
  }
  return out;
}

function run(files) {
  const errors = [];

  for (const f of ["index.html", "portal.html", "admin.html"]) {
    const html = files[f];
    for (const [i, b] of babelBlocks(html).entries()) {
      errors.push(...lint(`${f} <script #${i + 1}>`, b.code, b.lineOffset));
    }
  }
  errors.push(...lint("structure-studio.component.js", files["structure-studio.component.js"]));
  errors.push(...lint("StructureStudio.jsx", files["StructureStudio.jsx"]));

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
  // Order, not just presence. After the render the throw has already happened, so a check that
  // moved below it would pass a presence-only rule while restoring the exact blank page.
  const iCheck = files["index.html"].search(/if\s*\(\s*!\s*StructureStudio\s*\)/);
  const iRender = files["index.html"].search(/root\.render\(\s*<StructureStudio\s*\/>\s*\)/);
  const iShows = files["index.html"].replace(GUARD_TAG, "").search(/ssBootFail\s*\(/);
  if (iCheck < 0) {
    errors.push("index.html: the mount block renders the shared module's component without first "
      + "checking that it loaded (`if (!StructureStudio)`) — if the module did not load this "
      + "renders undefined, throws React error #130, and leaves the visitor a blank page "
      + "(happened 2026-08-06, to Googlebot)");
  } else if (iRender < 0) {
    // The anchor going blind is this file's signature failure: a rule whose regex stops matching
    // reports clean forever and nobody finds out. If the render is respelled, the ORDER half of
    // this rule silently stops existing, so say so instead of quietly degrading to presence-only.
    errors.push("index.html: the shared-module check is present but `root.render(<StructureStudio/>)` "
      + "no longer matches, so the check-before-render half of this rule can no longer be verified — "
      + "re-anchor it in scripts/preflight.mjs rather than leaving it silently inert");
  } else if (iCheck > iRender) {
    errors.push("index.html: the shared-module check sits AFTER root.render(<StructureStudio/>) — "
      + "by then the #130 throw has already happened, so the check protects nothing");
  }
  // Reporting is not enough on index.html: there the module IS the page, so the visitor must get
  // the failure SCREEN, not just a row in our table. Without this, downgrading index.html to
  // portal.html's deliberate report-only treatment would pass every other rule here while handing
  // the visitor back the blank page this whole change exists to remove.
  if (iShows < 0) {
    errors.push("index.html: nothing outside the boot guard calls ssBootFail() — the check must SHOW "
      + "the failure screen here, not merely report; on this page the shared module is the entire "
      + "page, so report-only leaves the visitor the same blank page as before");
  }
  for (const f of ["index.html", "portal.html"]) {
    // Searched with the guard body REMOVED, which is the difference between a real rule and a
    // vacuous one: the guard names this code itself (in the ternary that picks the report
    // wording) and the guard is on all three pages, so a whole-file search would be satisfied
    // by the guard alone and pass a page that reports nothing. The --self-test caught exactly
    // that on this rule's first draft.
    if (!files[f].replace(GUARD_TAG, "").includes(BOOT_COMPONENT_CODE)) {
      errors.push(`${f}: nothing outside the boot guard reports "${BOOT_COMPONENT_CODE}" — this page `
        + "hosts the shared component module, and a module that stops being served must not fail "
        + "silently (index.html shows the boot guard's screen; portal.html degrades to its Designer "
        + "tab message, which is invisible to us unless it reports)");
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
  // Script ORDERING on these pages is load-bearing in two different ways, and both are now asserted
  // rather than left to habit. Neither is hypothetical — both were reproduced in a browser against
  // these exact files.
  //
  // (1) The shared-module tag must not be async/defer. Babel's runner only holds later blocks back
  // while an earlier non-async src'd block is PENDING; `async` drops that barrier, so the mount
  // block runs before the module has defined anything. Note what this is and is not: it does NOT
  // make the new loaded-check lie about a working page — with async the page is broken either way,
  // because the module contains no mount of its own (mounting is the host page's job), so a
  // late-arriving module just declares a function nobody calls. Verified: pre-change + async is a
  // blank page, post-change + async is the failure screen. The rule earns its place by refusing a
  // config that silently breaks the page, not by protecting the check.
  for (const f of ["index.html", "portal.html"]) {
    const tag = files[f].match(/<script[^>]*structure-studio\.component\.js[^>]*>/);
    if (tag && /\s(?:async|defer)\b/.test(tag[0])) {
      errors.push(`${f}: the shared-module tag carries async/defer — that drops Babel's ordering `
        + "barrier, so the mount block runs before the module defines StructureStudio. The module "
        + "does not mount itself, so one arriving late cannot recover the page: it is a blank page "
        + "before this check existed and the boot failure screen after. Load it synchronously");
    }
  }
  // (2) The four /vendor/ tags must not be async/defer either — and THIS one is the real
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
  const portalModule = files["portal.html"].match(/<script src="([^"]*structure-studio\.component\.js[^"]*)"/);
  if (!portalModule) {
    errors.push("portal.html: no structure-studio.component.js tag — the in-portal Designer tab "
      + "mounts the shared module and cannot work without it");
  } else if (!portalModule[1].startsWith("/")) {
    errors.push(`portal.html: the shared-module src "${portalModule[1]}" is not root-absolute — this `
      + "page is served at /portal/<page>/<sub> too, where a relative src resolves against the URL "
      + "depth and the /portal/* splat answers with portal.html at HTTP 200; Babel then throws on "
      + "\"<!DOCTYPE html>\" and aborts every text/babel block, blanking the WHOLE portal with no "
      + "error reported anywhere (this exact bug shipped once). Use /structure-studio.component.js");
  }

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

  // Cache-buster lockstep between the two hosts of the shared module.
  const buster = (html) => (html.match(/structure-studio\.component\.js\?v=([a-z0-9]+)/) || [])[1];
  const vi = buster(files["index.html"]);
  const vp = buster(files["portal.html"]);
  if (!vi || !vp || vi !== vp) {
    errors.push(`cache-buster mismatch: index.html has v=${vi ?? "MISSING"}, portal.html has v=${vp ?? "MISSING"}`);
  }

  return errors;
}

const load = () => Object.fromEntries(
  ["index.html", "portal.html", "admin.html", "structure-studio.component.js", "StructureStudio.jsx"]
    .map((f) => [f, read(f)]));

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
  if (!files["portal.html"].includes(fixed)) {
    console.error("self-test: fixture line not found in portal.html — update the self-test");
    process.exit(1);
  }
  files["portal.html"] = files["portal.html"].replace(fixed,
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
  compCheckGone["index.html"] = compCheckGone["index.html"].replace(/if \(!StructureStudio\) \{/, "if (false) {");
  if (!run(compCheckGone).some((e) => e.includes("without first checking that it loaded"))) {
    console.error("self-test FAILED: index.html rendering the shared module with no loaded-check was "
      + "not caught — that is the exact #130 blank page that reached Googlebot");
    process.exit(1);
  }
  // Order matters as much as presence: a check that survives but moves below the render is the
  // same blank page with a rule that still passes.
  const compCheckAfter = load();
  const renderLine = "  root.render(<StructureStudio/>);";
  if (!compCheckAfter["index.html"].includes(renderLine)) {
    console.error("self-test: render fixture line not found in index.html — update the self-test");
    process.exit(1);
  }
  compCheckAfter["index.html"] = compCheckAfter["index.html"].replace(renderLine, "")
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
  // The FIRST occurrence in the file is the page's own reporter (the mount block precedes the
  // guard), so this removes the report while leaving the guard — and therefore the guard's own
  // mention of the same string — intact. That is the case the first draft of the rule missed.
  const compReportGone = load();
  compReportGone["portal.html"] = compReportGone["portal.html"].replace("boot_component_missing", "some_other_code");
  if (!run(compReportGone).some((e) => e.includes("boot_component_missing") && e.includes("portal.html"))) {
    console.error("self-test FAILED: portal.html no longer reporting a missing shared module was not "
      + "caught — its Designer tab would degrade silently");
    process.exit(1);
  }
  console.log("self-test passed: the shared-module check must exist, precede the render, keep its "
    + "reporter, and keep the guard's published failure screen");

  // The root-absolute module src on portal.html. This one guards the failure mode that CANNOT be
  // checked in-page (Babel aborts every block, so the reporter never runs) — the gate is the only
  // available defence, and until now nothing enforced it.
  const portalRelSrc = load();
  portalRelSrc["portal.html"] = portalRelSrc["portal.html"].replace(
    '<script src="/structure-studio.component.js', '<script src="structure-studio.component.js');
  if (portalRelSrc["portal.html"] === load()["portal.html"]) {
    console.error("self-test: portal.html's root-absolute module tag not found — update the self-test");
    process.exit(1);
  }
  if (!run(portalRelSrc).some((e) => e.includes("not root-absolute"))) {
    console.error("self-test FAILED: portal.html's shared-module src regressing to a relative path was "
      + "not caught — at /portal/<page>/<sub> that returns portal.html at 200, which blanks the whole "
      + "portal with zero telemetry (it shipped once)");
    process.exit(1);
  }
  console.log("self-test passed: portal.html's shared-module src must stay root-absolute");

  // async/defer, on both the module tag and the four library tags. The second is the one that
  // blanks a page which would otherwise have worked, so prove both fire.
  const moduleAsync = load();
  moduleAsync["index.html"] = moduleAsync["index.html"].replace(
    'src="structure-studio.component.js?v=', 'async src="structure-studio.component.js?v=');
  if (moduleAsync["index.html"] === load()["index.html"]) {
    console.error("self-test: index.html's module tag not found — update the self-test");
    process.exit(1);
  }
  if (!run(moduleAsync).some((e) => e.includes("shared-module tag carries async/defer"))) {
    console.error("self-test FAILED: async on the shared-module tag was not caught — the mount block "
      + "would run before the module defines anything, and the module cannot recover the page");
    process.exit(1);
  }
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
  console.log("self-test passed: neither the shared-module tag nor the /vendor/ library tags may "
    + "carry async/defer");

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
    "/vendor/babel-standalone-7.23.9.min.js", "/vendor/babel-standalone-7.99.0.min.js");
  libGone["portal.html"] = libGone["portal.html"].replace(
    "/vendor/babel-standalone-7.23.9.min.js", "/vendor/babel-standalone-7.99.0.min.js");
  libGone["admin.html"] = libGone["admin.html"].replace(
    "/vendor/babel-standalone-7.23.9.min.js", "/vendor/babel-standalone-7.99.0.min.js");
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
  // CDN-loaded on demand, and a rule that flags it gets deleted by the next person it annoys.
  const exceljsOk = load();
  if (!exceljsOk["portal.html"].includes("cdnjs.cloudflare.com/ajax/libs/exceljs/")) {
    console.error("self-test: exceljs fixture not found in portal.html — update the self-test");
    process.exit(1);
  }
  if (run(exceljsOk).some((e) => e.includes("must come") && e.includes("/vendor/"))) {
    console.error("self-test FAILED: the on-demand exceljs CDN load tripped the vendored-lock rule");
    process.exit(1);
  }
  console.log("self-test passed: the four libraries must be vendored, identical, present, and not "
    + "CDN-loaded — while exceljs stays allowed");

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
