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
//   1b. The hand-mirrored twins must not DRIFT. StructureStudio.jsx and
//      structure-studio.component.js are the same designer maintained by hand in two
//      dialects (CLAUDE.md: "any non-trivial edit must be mirrored in both files"). Linting
//      them both — which is all this gate did — cannot see a one-sided edit: each half stays
//      perfectly valid on its own, so the drift passes, compiles, and ships. Their bodies are
//      compared line by line after normalising the three documented dialect differences, and
//      the report NAMES the region on both sides. See the section comment in run().
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
//   8. my-quotes.html's sales-tax breakdown, executed against a DOM shim. That page is a
//      standalone HTML file, so the eslint pass never reads its inline script and the deno
//      steps do not know it exists — yet it is the only place a CUSTOMER sees the tax they
//      are charged, and it carries the figure their consent sentence quotes. The check LIFTS
//      the shipped block out of the file rather than re-implementing it, so a copy cannot
//      drift into passing while the page is broken.
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

// ── The hand-mirrored twins: normalise, then compare ──────────────────────────────────────
//
// StructureStudio.jsx (the ES-module canon) and structure-studio.component.js (the
// browser/global dialect the pages actually ship) are the SAME ~14,000-line designer, kept in
// step BY HAND — CLAUDE.md: "Any non-trivial edit must be mirrored in both files or the
// browser deliverable will drift from the JSX source. There is no generator." Nothing checked
// it. Both files have been LINTED here since this gate existed, and a lint cannot see this
// class of bug: each half is perfectly valid on its own, so a one-sided edit passes every
// rule, compiles cleanly and ships. The .js is what customers run; the .jsx is what the next
// person reads and edits — so the drift is invisible until someone "fixes" something in the
// copy that never ran, or mirrors a later change on top of a body that already disagreed.
//
// Only THREE differences are legitimate (CLAUDE.md), and all three are dialect, not behaviour:
//   (1) the module top — `const {useState,…}=React;` / `= ReactDOM;` / `= window.supabase;`
//       global destructures instead of `import … from "react"` and friends;
//   (2) `export default function StructureStudio` in the .jsx, a plain declaration in the .js;
//   (3) the module bottom — the .js publishes window.StructureStudio / window.ssAllowedOrigin
//       (and has no createRoot; mounting belongs to the host pages).
// Each is normalised BY SHAPE, never by position: the `= window.supabase` destructure already
// sits 27 lines below its .jsx import, and line numbers move the moment anyone edits above
// them. A positional rule that silently stops matching is this file's signature failure.
//
// COMMENTS AND BLANK LINES ARE DROPPED FROM BOTH SIDES, deliberately, and the choice is worth
// stating because it is the difference between a rule people keep and a rule people delete:
//   * The twins legitimately carry the SAME prose in DIFFERENT PLACES. The .jsx explains the
//     removed feedback widget in its header; the .js explains it 13,900 lines lower, next to
//     where the widget used to be. Comparing comments would fail on a clean tree, and the only
//     way to pass would be the line-number special-casing this rule exists to avoid.
//   * They also differ by one blank line (a double blank at StructureStudio.jsx:8098). Blank
//     lines and comments compile to NOTHING — both twins produce identical artifacts across
//     that difference — so failing a push over it would be this gate arguing about formatting,
//     which its own header forbids, on a file 14,000 lines long. That is how a correctness
//     gate gets switched off by the first person it annoys.
// Dropping them costs this rule nothing it exists for: it removes no code, so every real body
// edit still lands in the comparison. What it does not catch is a comment that drifts — which
// ships no bug, and which the mirror rule's own author already treats as free to differ.
const TWIN_DIALECT_LINES = [
  // (1) The .jsx's imports, and the .js's global destructures that stand in for them. `import`
  // anchored at column 0 with a following space: a dynamic `import(` has no space and is
  // always indented inside a function, so nothing real is dropped.
  /^import\s/,
  /^const\s*\{[^}]*\}\s*=\s*(?:React|ReactDOM|window\.supabase)\s*;?\s*$/,
  // (3) The two publishes the host pages' mount blocks read back off window.
  /^window\.(?:StructureStudio|ssAllowedOrigin)\s*=\s*[A-Za-z_$][\w$]*\s*;?\s*$/,
];

// One twin reduced to its comparable body: { n: 1-based line in the ORIGINAL file, text }.
// The original line number rides along so a failure can point at the real file.
function twinBody(text) {
  const out = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (TWIN_DIALECT_LINES.some((re) => re.test(line))) continue;
    // (2) The export keyword, stripped rather than matched against a known line.
    out.push({ n: i + 1, text: line.replace(/^export default (?=(?:async )?function\b)/, "") });
  }
  return out;
}

// How many consecutive equal lines count as "the two sides line up again", and how far to look
// for that. Three lines is enough that a repeated `  }` or `  );` cannot fake a resync; 300 is
// far more than any real one-sided edit and keeps the worst case at ~135k string compares.
const TWIN_SYNC = 3;
const TWIN_WINDOW = 300;

// Walk the two bodies together and return every region where they disagree. The look-ahead
// resync is the whole point of not using a plain index compare: ONE line inserted on one side
// would otherwise renumber the remaining ~6,000 and report the entire rest of the file as
// drifted, which tells a reader nothing and is exactly the kind of output people learn to skip.
function twinRegions(a, b) {
  const regions = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].text === b[j].text) { i++; j++; continue; }
    let sync = null;
    // Smallest total edit first (d = di + dj), so the region reported is the smallest one that
    // explains the difference — a changed line, not "everything until the next coincidence".
    for (let d = 1; d <= TWIN_WINDOW && !sync; d++) {
      for (let di = 0; di <= d; di++) {
        const dj = d - di;
        if (i + di + TWIN_SYNC > a.length || j + dj + TWIN_SYNC > b.length) continue;
        let ok = true;
        for (let k = 0; k < TWIN_SYNC; k++) {
          if (a[i + di + k].text !== b[j + dj + k].text) { ok = false; break; }
        }
        if (ok) { sync = { di, dj }; break; }
      }
    }
    regions.push({
      jsx: a.slice(i, i + (sync ? sync.di : a.length - i)),
      comp: b.slice(j, j + (sync ? sync.dj : b.length - j)),
      jsxAt: a[i],
      compAt: b[j],
      resynced: !!sync,
    });
    if (!sync) return regions;   // no way back into step — everything after is one region
    i += sync.di;
    j += sync.dj;
  }
  // A tail on one side only: one twin ends while the other still has body left.
  if (i < a.length || j < b.length) {
    regions.push({
      jsx: a.slice(i), comp: b.slice(j), jsxAt: a[i] ?? null, compAt: b[j] ?? null, resynced: false,
    });
  }
  return regions;
}

// Takes the two texts as arguments (rather than reading the files) so --self-test can hand it
// deliberately drifted variants and prove it fails — the my-quotes check's shape, same reason.
const TWIN_JSX = "StructureStudio.jsx";
const TWIN_COMP = "structure-studio.component.js";
const TWIN_MAX_REPORTED = 5;

function checkTwinDrift(jsxText, compText) {
  const errors = [];
  const a = twinBody(jsxText);
  const b = twinBody(compText);

  // Vacuity guard, the lesson this script keeps re-learning: a normaliser that has quietly
  // stopped seeing the file compares two empty lists and reports two identical twins. Scaled
  // to the file rather than a fixed number, so it cannot start crying wolf as the designer
  // grows or shrinks — today each side keeps 10,301 of ~14,100 lines.
  const rawA = jsxText.split("\n").length;
  const rawB = compText.split("\n").length;
  if (a.length * 4 < rawA || b.length * 4 < rawB) {
    errors.push(`twin drift: the normaliser kept only ${a.length}/${rawA} line(s) of ${TWIN_JSX} `
      + `and ${b.length}/${rawB} of ${TWIN_COMP} — it has stopped seeing most of the file, so `
      + "this rule would pass because it is comparing almost nothing. Fix twinBody() in "
      + "scripts/preflight.mjs rather than leaving a check that cannot fail.");
    return errors;
  }

  const regions = twinRegions(a, b);
  // Both sides get a real line number even when a region is empty on one of them: the anchor
  // is the next line that side WOULD have had, which is where the missing code belongs.
  const side = (file, own, anchor, lastLine) => (own.length
    ? `${file}:${own[0].n}`
    : `${file}:${anchor ? anchor.n : lastLine} (nothing here)`);
  const excerpt = (own) => (own.length ? own[0].text.trim().slice(0, 110) : "(no line — this side is missing it)");
  for (const r of regions.slice(0, TWIN_MAX_REPORTED)) {
    errors.push(`twin drift — the hand-mirrored designer copies disagree here `
      + `(${r.jsx.length} line(s) vs ${r.comp.length}`
      + `${r.resynced ? "" : "; they never line up again after this point"}):`
      + `\n      ${side(TWIN_JSX, r.jsx, r.jsxAt, rawA)}\n          ${excerpt(r.jsx)}`
      + `\n      ${side(TWIN_COMP, r.comp, r.compAt, rawB)}\n          ${excerpt(r.comp)}`
      + "\n      Mirror the edit into BOTH files (CLAUDE.md). Only the module top, the export-default "
      + "keyword and the window.* publishes at the bottom may differ; comments and blank lines are "
      + "ignored, so this is real code.");
  }
  if (regions.length > TWIN_MAX_REPORTED) {
    errors.push(`twin drift: ${regions.length - TWIN_MAX_REPORTED} further drifting region(s) not `
      + "listed. That many usually means an edit landed in one twin only and was never mirrored "
      + `at all — diff the two files directly: git diff --no-index ${TWIN_JSX} ${TWIN_COMP}`);
  }
  return errors;
}

function run(files) {
  const errors = [];

  // The app sources: the three per-page .jsx files (extracted from the pages on
  // 2026-08-13, when in-browser Babel was removed) plus the two component twins.
  // The pages themselves carry no app code anymore — they get structural rules
  // below, not a lint.
  // Derived from TARGETS so a new compile target (or portal part, via readTarget) is
  // linted the moment it exists -- the hand-kept five-name list this replaces is the same
  // second-copy-drifts shape the load() comment already warns about (audit 2026-08-19).
  // StructureStudio.jsx rides along explicitly: it is the component's hand-mirrored twin,
  // linted but never compiled, so it is not a TARGET.
  for (const f of [...TARGETS.map((t) => targetName(t)), "StructureStudio.jsx"]) {
    errors.push(...lint(f, files[f]));
  }

  // ── Git conflict markers ─────────────────────────────────────────────────
  // 2026-08-28: portal.html was pushed mid-rebase with a conflict hunk still in it — the
  // markers replaced the two compiled-artifact <script> tags, so every visitor got the
  // "Couldn't load the portal" screen (and the raw `<<<<<<< HEAD` text) until the next
  // push. Nothing here caught it: the pages are checked structurally, not parsed, so
  // markers sail through where a .jsx source would at least fail the lint. This rule
  // closes that class for EVERY file in the map. A file is flagged only when it carries
  // BOTH an opening `<<<<<<< ` line and a closing `>>>>>>> ` line — git always writes the
  // pair, and requiring both keeps a lone `=======` (markdown underlines, comment rules)
  // or a `<<<<<<<` inside a string from tripping it.
  for (const [f, text] of Object.entries(files)) {
    const open = text.match(/^<{7} .+$/m);
    const close = text.match(/^>{7} .+$/m);
    if (open && close) {
      const line = text.slice(0, text.indexOf(open[0])).split("\n").length;
      errors.push(`${f}:${line}  git conflict markers — this file still contains an unresolved `
        + `merge/rebase hunk ("${open[0].slice(0, 30)}…"). Resolve the conflict, run `
        + "`npm run compile` if a page or source changed, and commit the clean file.");
    }
  }

  // ── The hand-mirrored twins must not drift ───────────────────────────────
  // The rule itself, its normalisation and the reasoning behind every exemption live with
  // checkTwinDrift() above. It runs on the in-memory map like every other rule here, which is
  // what lets --self-test inject a one-sided edit and prove the gate fails on it.
  errors.push(...checkTwinDrift(files[TWIN_JSX], files[TWIN_COMP]));

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
  // The rule itself is checkGateTable(); the functions it runs over are DISCOVERED rather than
  // listed, because the four-name array that used to sit here left portal-sms — ten gates,
  // three of them able to spend the tenant's money — checked by nothing at all.
  //
  // The old "no GATES table" arm is gone with the array: a function that loses its table leaves
  // `gates: GATES` dangling, which the deno check below fails on. What CANNOT be caught that
  // way is discovery going blind, so that is what is guarded here.
  const gatedFns = gatedFunctions();
  if (!gatedFns.length) {
    errors.push(`${FUNCTIONS_DIR}/: no function declares \`${GATES_DECL}\` — either the gate `
      + "model was renamed or this discovery has gone blind; re-anchor it in "
      + "scripts/preflight.mjs rather than leaving every gated function unchecked");
  }
  for (const g of gatedFns) errors.push(...checkGateTable(g.fn, g.src));

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
  // file exists on disk anymore (it is portal/01-core.jsx ... 09-shell.jsx since 2026-08-19).
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

// ── my-quotes.html: the customer's sales-tax breakdown ───────────────────────────────────
//
// This page has NO other automated coverage — it is a standalone HTML file, so the eslint pass
// above never reads its inline script and the deno steps below do not know it exists. It is
// also the only place a CUSTOMER sees what they are being charged, and the figure it renders is
// the one their consent sentence quotes. Untested money in front of a customer is the wrong
// thing to leave uncovered.
//
// Rather than re-implement the block here — a copy would drift from the page and start passing
// while the page was broken — the SHIPPED source is lifted out of the file and executed against
// a DOM shim. Extraction is brace-balanced, so it survives edits above and below it.
//
// Takes the html as an argument (rather than reading the file) so --self-test can hand it a
// deliberately broken variant and prove this check actually fails.
// Lifts payFigures() + fmtMoney() out of the shipped page and executes them, so a copy in this
// file cannot drift into passing while the page itself is broken. payFigures decides what a
// customer is asked to pay; the case that matters most is a clearing bank transfer removing
// the button, because a button that still says you owe it is how a customer pays twice.
function checkMyQuotesPayFigures(html) {
  const errors = [];
  const lines = html.split("\n");
  const takeBlock = (needle) => {
    const start = lines.findIndex((l) => l.includes(needle));
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (depth === 0 && i > start) return lines.slice(start, i + 1).join("\n");
    }
    return null;
  };

  const fmtSrc = takeBlock("function fmtMoney(");
  const figSrc = takeBlock("function payFigures(");
  if (!fmtSrc || !figSrc) {
    errors.push("my-quotes.html: payFigures() or fmtMoney() is gone — that function decides what a "
      + "customer is asked to pay, and it is the only automated coverage this page's pay panel has. "
      + "If it was removed on purpose, remove this check too.");
    return errors;
  }

  let fig;
  try {
    fig = new Function("opt", [fmtSrc, figSrc, "return payFigures(opt);"].join("\n"));
  } catch (e) {
    errors.push("my-quotes.html: payFigures() does not parse in isolation — " + e.message);
    return errors;
  }

  const cases = [
    ["deposit set, nothing paid",
      { canPay: true, askCents: 100000, askKind: "deposit", balanceCents: 365000, settledCents: 0, pendingCents: 0, depositCents: 100000 },
      (r) => r.canPay === true && r.askCents === 100000 && r.rows[0].value === "$1,000.00"],
    ["no deposit: the ask is the balance",
      { canPay: true, askCents: 365000, askKind: "balance", balanceCents: 365000, settledCents: 0, pendingCents: 0, depositCents: null },
      (r) => r.canPay === true && r.rows[0].value === "$3,650.00"],
    // THE ONE THAT MATTERS: a clearing bank transfer must remove the button entirely.
    ["pending ACH covers the ask",
      { canPay: false, reason: "pending_clearing", askCents: 0, balanceCents: 365000, settledCents: 0, pendingCents: 365000, depositCents: null },
      (r) => r.canPay === false && /clearing/i.test(r.notice || "")],
    ["pending ACH covers only PART of it — still no button",
      { canPay: false, reason: "pending_clearing", askCents: 0, balanceCents: 365000, settledCents: 0, pendingCents: 10000, depositCents: null },
      (r) => r.canPay === false],
    ["paid in full: no ask, no button",
      { canPay: false, reason: "paid_in_full", askCents: 0, balanceCents: 0, settledCents: 365000, pendingCents: 0, depositCents: null },
      (r) => r.canPay === false && r.rows.length === 1 && /Paid in full/.test(r.rows[0].label)],
    ["overpaid never renders a negative ask",
      { canPay: false, reason: "paid_in_full", askCents: 0, balanceCents: -5000, settledCents: 370000, pendingCents: 0, depositCents: null },
      (r) => r.canPay === false && !r.rows.some((x) => /-/.test(x.value))],
    ["an empty payload renders nothing rather than throwing",
      null,
      (r) => r.canPay === false && r.rows.length === 0],
  ];

  for (const [name, input, ok] of cases) {
    let out;
    try {
      out = fig(input);
    } catch (e) {
      errors.push(`my-quotes.html payFigures — ${name}: threw ${e.message}`);
      continue;
    }
    if (!ok(out)) {
      errors.push(`my-quotes.html payFigures — ${name}: got ${JSON.stringify(out)}`);
    }
  }
  return errors;
}

function checkMyQuotesTaxBreakdown(html) {
  const errors = [];
  const lines = html.split("\n");
  const takeBlock = (needle) => {
    const start = lines.findIndex((l) => l.includes(needle));
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (depth === 0 && i > start) return lines.slice(start, i + 1).join("\n");
    }
    return null;
  };

  const fmtSrc = takeBlock("function fmtMoney(");
  const blkSrc = takeBlock("if (hasTax) {");
  if (!fmtSrc || !blkSrc) {
    errors.push("my-quotes.html: the sales-tax breakdown block (`if (hasTax) {`) or fmtMoney() is gone — "
      + "the customer's card is the only place they see the tax they are being charged, and it carries "
      + "the figure their consent sentence quotes. If it was removed on purpose, remove this check too.");
    return errors;
  }

  const mk = () => ({ className: "", textContent: "", children: [], appendChild(c) { this.children.push(c); return c; } });
  let render;
  try {
    render = new Function("q", "document", "mk", [
      fmtSrc,
      "const card = mk();",
      "const hasTax = q.tax != null && q.taxable != null && q.nonTaxable != null;",
      blkSrc,
      "return card;",
    ].join("\n"));
  } catch (e) {
    errors.push("my-quotes.html: the tax-breakdown block does not parse in isolation — " + e.message);
    return errors;
  }

  const flat = (n, out = []) => {
    if (n.className.startsWith("qc-tax-row") || n.className === "qc-tax-total") {
      out.push(n.children[0].textContent + " | " + n.children[1].textContent
        + (n.className.includes("is-credit") ? " | credit" : ""));
    }
    n.children.forEach((c) => flat(c, out));
    return out;
  };
  const doc = { createElement: () => mk() };

  // The plan's mock-up figures, so the customer's screen and the PDF are demonstrably the same
  // arithmetic rather than two implementations that happen to agree today.
  const cases = [
    ["with discounts",
      { taxable: 11950, nonTaxable: 500, discount: 600, tax: 866.38, taxRate: 0.0725, taxLabel: "Sales tax", total: 13316.38 },
      ["Taxable | $11,950.00", "Non-taxable | $500.00", "Discount | -$600.00 | credit", "Sales tax (7.25%) | $866.38", "Total | $13,316.38"]],
    ["no discount",
      { taxable: 12450, nonTaxable: 600, tax: 902.63, taxRate: 0.0725, taxLabel: "Sales tax", total: 13952.63 },
      ["Taxable | $12,450.00", "Non-taxable | $600.00", "Sales tax (7.25%) | $902.63", "Total | $13,952.63"]],
    // 0% must be STATED. A silently absent tax row is indistinguishable from the pre-tax bug
    // this whole feature exists to fix.
    ["0% stated, not hidden",
      { taxable: 13050, nonTaxable: 0, tax: 0, taxRate: 0, taxLabel: "Sales tax", total: 13050 },
      ["Taxable | $13,050.00", "Non-taxable | $0.00", "Sales tax | $0.00", "Total | $13,050.00"]],
    ["whole-number rate drops the decimals",
      { taxable: 1000, nonTaxable: 0, tax: 70, taxRate: 0.07, taxLabel: "Sales tax", total: 1070 },
      ["Taxable | $1,000.00", "Non-taxable | $0.00", "Sales tax (7%) | $70.00", "Total | $1,070.00"]],
    ["the builder's own label is honoured",
      { taxable: 1000, nonTaxable: 0, tax: 50, taxRate: 0.05, taxLabel: "GST", total: 1050 },
      ["Taxable | $1,000.00", "Non-taxable | $0.00", "GST (5%) | $50.00", "Total | $1,050.00"]],
    // The regression that protects every pre-tax quote and every CRM tenant.
    ["a snapshot with no tax renders no breakdown", { total: 5000 }, []],
    ["a partial payload is not half-rendered", { taxable: 100, total: 100 }, []],
  ];

  for (const [name, q, expect] of cases) {
    let got;
    try { got = flat(render(q, doc, mk)); } catch (e) {
      errors.push('my-quotes.html: tax breakdown threw on "' + name + '" — ' + e.message);
      continue;
    }
    if (JSON.stringify(got) !== JSON.stringify(expect)) {
      errors.push('my-quotes.html: tax breakdown wrong for "' + name + '"'
        + "\n      got:      " + JSON.stringify(got)
        + "\n      expected: " + JSON.stringify(expect));
    }
  }
  return errors;
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

// ── Gated edge functions: the GATES ⇄ action cross-check ─────────────────────────────────
// Discovered rather than listed, for the reason this file opens with: a second hand-kept list
// is how this gate has twice reported clean while running zero rules. The four-name array that
// used to live inside run() was exactly that mistake — portal-sms shipped a GATES table of ten
// actions, three of which SPEND THE TENANT'S MONEY, covered by nothing at all, because nobody
// added its name to the array. Now a new gated function is checked the day it lands.
const GATES_DECL = "const GATES: GateTable = {";

function gatedFunctions() {
  const dir = join(root, FUNCTIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => ({ fn: e.name, path: join(dir, e.name, "index.ts") }))
    .filter((f) => existsSync(f.path))
    .map((f) => ({ fn: f.fn, src: readFileSync(f.path, "utf8") }))
    .filter((f) => f.src.includes(GATES_DECL))
    .sort((a, b) => a.fn.localeCompare(b.fn));
}

// Sticky (`y`) on purpose: walkBlock anchors these at a known offset rather than searching.
//
// [a-z0-9_] not [a-z_]: an action name carrying a DIGIT (save_style_d3) never matched, so the
// table could not satisfy this rule for it by ANY spelling. The only ways out were renaming a
// deployed action or --no-verify -- i.e. a correctness gate teaching people to bypass it.
// Surfaced by the 3D merge, which grafted six such actions in at once.
const GATE_KEY = /([a-z0-9_]+)\s*:/y;
const CASE_LABEL = /case\s*"([^"]+)"\s*:/y;

// A gate name follows the table's `{` or a comma; a `case` label follows the switch's `{`, a
// previous case's `:`, or the end of the previous case's block or statement.
const KEY_AFTER = new Set(["{", ","]);
const CASE_AFTER = new Set(["{", "}", ";", ":"]);

function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === q) return j + 1;
    // An unterminated quote must not swallow the rest of the file and take the brace depth
    // with it. Only a template literal legitimately spans lines.
    if (q !== "`" && src[j] === "\n") return j;
  }
  return src.length;
}

// Walk the braced block whose `{` sits at `open`. Returns { end, hits }: `end` is the index
// just past the matching `}` (-1 if the braces never balance), and `hits` are `token`'s capture
// groups matched at DEPTH 1 of that block, outside comments and strings, and only where the
// preceding significant character is in `after` — so a match can never start mid-identifier.
//
// Character-level rather than line-anchored, and that is load-bearing three times over:
//   - sync-design-status writes its whole table on ONE line, which has no line anchor at all.
//     The old `/\n\};/` extent search ran straight past it into the next object and the old
//     `/^\s*name:/gm` then matched nothing -- zero gates, zero actions, a silent pass on a
//     function that was already named in the checked list.
//   - every entry in all five tables happens to sit on one line TODAY. Wrap one and a
//     line-anchored scan harvests `area` and `level` as gate names, reporting two phantom
//     stale entries. Depth is what tells a gate name from a field of its value.
//   - portal-sms holds a SECOND switch (`switch (reg.status)`, in advanceOne) whose ten labels
//     are states, not actions. Scoping the case scan to the dispatch block's own braces is the
//     only thing keeping those out of the action set.
function walkBlock(src, open, token, after) {
  const hits = [];
  let depth = 0;
  let prev = "";
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); prev = c; continue; }
    if (c === "{") { depth++; prev = c; i++; continue; }
    if (c === "}") {
      depth--;
      prev = c;
      i++;
      if (depth === 0) return { end: i, hits };
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (depth === 1 && after.has(prev)) {
      token.lastIndex = i;
      const m = token.exec(src);
      if (m) { hits.push(m[1]); prev = ":"; i = token.lastIndex; continue; }
    }
    prev = c;
    i++;
  }
  return { end: -1, hits };
}

// Every action a gated edge function dispatches must have a line in that function's GATES
// table, and every line in that table must have a branch.
//
// WHY THIS IS A PUSH-BLOCKING RULE. Per-person access (migration 100) is enforced by one table
// per function, checked in resolveTenant before dispatch. That design is only sound while the
// table is COMPLETE: a branch is reachable the moment it is written. resolveTenant refuses
// actions missing from the table, which turns the mistake into a 403 instead of an open
// endpoint -- but a 403 on a brand-new feature reads like a bug in the feature, and the
// tempting fix is to widen the gate rather than to write the right one. Catching it here says
// exactly what is wrong. The reverse (a table entry with no branch) is caught too: a stale line
// is a claim that something is protected when nothing by that name exists.
//
// Takes its subject as an ARGUMENT, like checkMyQuotesTaxBreakdown above, so --self-test can
// feed it a mutated source and prove each direction really fires.
function checkGateTable(fn, src) {
  const errors = [];
  const file = `${FUNCTIONS_DIR}/${fn}/index.ts`;
  const decl = src.indexOf(GATES_DECL);
  if (decl < 0) return errors;   // gatedFunctions() only yields files that have one

  const { end, hits } = walkBlock(src, decl + GATES_DECL.length - 1, GATE_KEY, KEY_AFTER);
  if (end < 0) {
    errors.push(`${file}: the GATES table's braces never close — preflight cannot read it, so `
      + "nothing in this function is cross-checked; re-anchor it in scripts/preflight.mjs");
    return errors;
  }
  const gated = new Set(hits);
  const body = src.slice(end);

  // The two dispatch shapes, unioned. The Set is what keeps an action written both ways from
  // counting twice.
  const used = new Set([...body.matchAll(/action\s*===\s*"([^"]+)"/g)].map((m) => m[1]));
  const sw = /switch\s*\(\s*action\s*\)\s*\{/.exec(body);
  if (sw) {
    const dispatch = walkBlock(body, sw.index + sw[0].length - 1, CASE_LABEL, CASE_AFTER);
    if (dispatch.end < 0) {
      errors.push(`${file}: the \`switch (action)\` block's braces never close — its case `
        + "labels cannot be read, so every gate in this function would report as stale");
      return errors;
    }
    for (const a of dispatch.hits) used.add(a);
  }
  // The default action is dispatched too: resolveTenant reads `payload?.action ||
  // opts.defaultAction`, so a request with no action in its body runs it, and it is gated like
  // any other. It is the ONLY thing justifying sync-design-status's single entry — that
  // function compares `action` nowhere at all.
  const dflt = /defaultAction\s*:\s*"([^"]+)"/.exec(body);
  if (dflt) used.add(dflt[1]);

  // Vacuity guard. A rule whose anchors stop matching reports clean forever and nobody finds
  // out — this file's signature failure, and exactly what happened here: sync-design-status sat
  // in the checked list for months while zero gates and zero actions were parsed out of it.
  if (!gated.size || !used.size) {
    errors.push(`${file}: parsed ${gated.size} gate(s) and ${used.size} action(s) — the `
      + "cross-check can no longer read this function and is silently inert; re-anchor it in "
      + "scripts/preflight.mjs rather than leaving a gated function unchecked");
    return errors;
  }

  for (const a of used) {
    if (!gated.has(a)) {
      errors.push(`${file}: action "${a}" has no entry in GATES — `
        + "add the area and level it requires, or it is refused at runtime");
    }
  }
  for (const a of gated) {
    if (!used.has(a)) {
      errors.push(`${file}: GATES lists "${a}" but no branch handles `
        + "it — remove the stale entry so the table describes what actually exists");
    }
  }
  return errors;
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
    // --allow-env and a repo-scoped --allow-read, nothing else. The tests stub globalThis.fetch
    // / inject fake clients, so NO network permission is granted — withholding --allow-net means
    // a test that accidentally reaches the real internet fails loudly instead of passing slowly,
    // and that property is untouched by the read grant. Read is needed because some tests assert
    // against the SHIPPED source rather than a copy of it (wallSlab_test lifts the designer's
    // slab rules; the my-quotes check does the same for that page) — a copied-out copy would keep
    // passing while the real file drifted. Scoped to the repo so a test still cannot wander.
    const args = ["test", "--quiet", "--allow-env", `--allow-read=${root}`, "--node-modules-dir=none"];
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

  // ── The conflict-marker rule ───────────────────────────────────────────────
  // Fixture = the 2026-08-28 incident itself: portal.html pushed mid-rebase with the hunk
  // around its two <script> tags, visitors served "<<<<<<< HEAD" as page text. Prove it
  // fires on that exact shape, and prove the two lookalikes that must NOT fire don't: a
  // lone `=======` (comment rules, markdown underlines) and an unpaired `<<<<<<<` inside
  // a string — half a marker never comes out of git, and a rule that cries wolf on
  // legitimate text gets deleted by the next person it annoys.
  const withConflict = load();
  withConflict["portal.html"] = withConflict["portal.html"].replace("</body>",
    '<<<<<<< HEAD\n<script defer src="/a.js?v=1"></script>\n=======\n<script defer src="/a.js?v=2"></script>\n>>>>>>> 4389eec (Projects: name the intake group)\n</body>');
  if (!run(withConflict).some((e) => e.includes("git conflict markers"))) {
    console.error("self-test FAILED: an unresolved conflict hunk in portal.html was not caught");
    process.exit(1);
  }
  const withLookalikes = load();
  withLookalikes["portal.html"] = withLookalikes["portal.html"].replace("</body>",
    "<!--\n=======\na heading underline, and a stray <<<<<<< inside prose\n-->\n</body>");
  if (run(withLookalikes).some((e) => e.includes("git conflict markers"))) {
    console.error("self-test FAILED: a lone ======= / unpaired <<<<<<< tripped the conflict-marker rule");
    process.exit(1);
  }
  console.log("self-test passed: unresolved conflict hunks are refused, marker lookalikes are not");

  // ── The twin-drift rule ────────────────────────────────────────────────────
  // This rule is a NORMALISER wrapped around a compare, which gives it two ways to be useless
  // and both are silent: normalise too much and it compares nothing, normalise too little and
  // it fires on a clean tree until someone deletes it. So prove all four directions.
  //
  // QUIET on the pristine repo. Asserted explicitly rather than trusted to the overall run,
  // because this is the direction that decides whether the rule survives its first month.
  const twinNoise = run(load()).filter((e) => e.includes("twin drift"));
  if (twinNoise.length) {
    console.error("self-test FAILED: the pristine twins do not pass the drift check — the three "
      + "legitimate dialect differences (or the blank-line/comment exemptions) are not being "
      + "normalised:");
    for (const e of twinNoise) console.error("  " + e);
    process.exit(1);
  }
  // FIRES on a changed line — the ordinary case: someone edits the .js and forgets the .jsx,
  // or vice versa. A string literal, because that is a change no lint of either file can see.
  const twinChanged = load();
  const twinBanner = 'console.log("[StructureStudio] multi-tenant build: config-loader + RPC data path");';
  if (!twinChanged[TWIN_COMP].includes(twinBanner)) {
    console.error("self-test: twin-drift fixture line not found in " + TWIN_COMP + " — update the self-test");
    process.exit(1);
  }
  twinChanged[TWIN_COMP] = twinChanged[TWIN_COMP].replace(twinBanner,
    'console.log("[StructureStudio] single-tenant build");');
  {
    const hits = run(twinChanged).filter((e) => e.includes("twin drift"));
    if (!hits.length) {
      console.error("self-test FAILED: a changed line in " + TWIN_COMP + " was not caught — the two "
        + "twins would ship different code with every lint and every artifact check passing");
      process.exit(1);
    }
    // Naming the region is the rule's whole value: a 14,000-line "these files differ" is a
    // second job for the reader, not a finding. Both files and both line numbers must be there.
    if (!hits.some((e) => e.includes(TWIN_JSX + ":") && e.includes(TWIN_COMP + ":")
        && e.includes("single-tenant build"))) {
      console.error("self-test FAILED: the twin-drift report does not name both sides of the "
        + "drifting region with line numbers and an excerpt. It said:");
      for (const e of hits) console.error("  " + e);
      process.exit(1);
    }
  }
  // FIRES on an INSERTION, and reports it as ONE region. A plain index compare would call every
  // remaining line drifted; the look-ahead resync is what keeps the output readable, so assert
  // the count rather than merely that something fired.
  const twinInserted = load();
  const twinAnchor = "const SUPABASE_URL = \"https://jzeamjbhdrsbygdnphbm.supabase.co\";";
  if (!twinInserted[TWIN_JSX].includes(twinAnchor)) {
    console.error("self-test: twin-drift insertion anchor not found in " + TWIN_JSX + " — update the self-test");
    process.exit(1);
  }
  twinInserted[TWIN_JSX] = twinInserted[TWIN_JSX].replace(twinAnchor,
    "const SS_TWIN_SELFTEST_ONLY = 1;\n" + twinAnchor);
  {
    const hits = run(twinInserted).filter((e) => e.includes("twin drift"));
    if (!hits.length) {
      console.error("self-test FAILED: a line added to " + TWIN_JSX + " only was not caught");
      process.exit(1);
    }
    if (hits.length !== 1) {
      console.error(`self-test FAILED: one inserted line produced ${hits.length} drift region(s) — `
        + "the resync is not working, and a report that flags the rest of the file is a report "
        + "nobody reads. It said:");
      for (const e of hits) console.error("  " + e);
      process.exit(1);
    }
  }
  // QUIET on each legitimate difference, exercised rather than merely present in the tree.
  // A rule that flags the module top, the export keyword, a moved comment or a blank line
  // fails on the first honest mirror edit and gets deleted; these are the shapes CLAUDE.md
  // explicitly permits.
  const twinLegit = load();
  twinLegit[TWIN_JSX] = twinLegit[TWIN_JSX]
    .replace("import { createPortal } from \"react-dom\";", "import { createPortal, flushSync } from \"react-dom\";")
    .replace(twinAnchor, "// a fresh comment, on the .jsx side only\n\n\n" + twinAnchor);
  twinLegit[TWIN_COMP] = twinLegit[TWIN_COMP]
    .replace("const { createPortal } = ReactDOM;", "const { createPortal, flushSync } = ReactDOM;");
  if (twinLegit[TWIN_JSX] === load()[TWIN_JSX] || twinLegit[TWIN_COMP] === load()[TWIN_COMP]) {
    console.error("self-test: the legitimate-difference fixtures did not apply — update the self-test");
    process.exit(1);
  }
  {
    const noise = run(twinLegit).filter((e) => e.includes("twin drift"));
    if (noise.length) {
      console.error("self-test FAILED: a legitimate dialect difference (import vs global destructure) "
        + "or a comment/blank-line-only edit tripped the twin-drift rule:");
      for (const e of noise) console.error("  " + e);
      process.exit(1);
    }
  }
  // And the vacuity direction, which is how this rule would fail SILENTLY: a normaliser that
  // dropped everything would compare two empty lists and pass forever.
  if (!checkTwinDrift("// only a comment\n", "// only a comment\n")
      .some((e) => e.includes("stopped seeing most of the file"))) {
    console.error("self-test FAILED: twinBody() reducing a file to nothing did not trip the vacuity "
      + "guard — the drift check could compare zero lines and report two identical twins");
    process.exit(1);
  }
  console.log("self-test passed: the twins must not drift — a changed line and a one-sided insertion "
    + "are both caught and located, while the module top, comments and blank lines stay quiet");

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

  // ── The my-quotes tax-breakdown step ───────────────────────────────────────
  // Same silent-pass hazard as the two above, and a sharper one: this check EXTRACTS its
  // subject from a file by pattern, so a rename could leave it quietly asserting nothing.
  // Prove three things — it passes on the real file, it FAILS on a broken breakdown, and it
  // fails when the block has been extracted away to nothing.
  const mqHtml = readFileSync(join(root, "my-quotes.html"), "utf8");
  if (checkMyQuotesTaxBreakdown(mqHtml).length) {
    console.error("self-test FAILED: the my-quotes tax breakdown does not pass against the real file");
    process.exit(1);
  }
  // Break the arithmetic the way a careless edit would: charge tax on the gross taxable pool
  // instead of the net, which is exactly the discount bug this check exists to catch.
  const brokenMath = mqHtml.replace("addRow(\"Taxable\", fmtMoney(q.taxable));",
    "addRow(\"Taxable\", fmtMoney(q.taxable + (q.discount || 0)));");
  if (brokenMath === mqHtml) {
    console.error("self-test FAILED: could not find the Taxable row to break — the check's subject moved");
    process.exit(1);
  }
  if (!checkMyQuotesTaxBreakdown(brokenMath).length) {
    console.error("self-test FAILED: a wrong Taxable figure passed the my-quotes breakdown check");
    process.exit(1);
  }
  if (!checkMyQuotesTaxBreakdown("<html><body>nothing here</body></html>").length) {
    console.error("self-test FAILED: a my-quotes.html with no breakdown block at all passed the check");
    process.exit(1);
  }
  console.log("self-test passed: the my-quotes tax breakdown check fails on wrong figures and on a missing block");

  // ── The GATES ⇄ action cross-check ─────────────────────────────────────────
  // This rule had NO self-test at all until now, in either direction — while quietly running
  // zero checks on one of the four functions it named. So prove the whole mechanism: that
  // discovery finds the functions, that BOTH dispatch shapes are read, that the real repo is
  // quiet, and that the scoping which makes the case scan safe is really in place.
  const gateFns = gatedFunctions();
  if (gateFns.length < 5) {
    console.error(`self-test FAILED: discovery found ${gateFns.length} gated function(s), expected at least 5`);
    process.exit(1);
  }
  // Named explicitly, in the shape of the ["_shared", "_test_stubs"] assertion above: portal-sms
  // is the function the hand-kept list missed entirely, and sync-design-status is the one it
  // named while parsing nothing out of it.
  for (const want of ["portal-sms", "sync-design-status"]) {
    if (!gateFns.some((g) => g.fn === want)) {
      console.error(`self-test FAILED: gated function "${want}" was not discovered`);
      process.exit(1);
    }
  }
  // The case-label half must have a real subject. If no discovered function dispatches with
  // `switch (action)` any more, every assertion below still passes while that whole code path
  // sits inert — the failure shape this script keeps re-learning.
  if (!gateFns.some((g) => /switch\s*\(\s*action\s*\)/.test(g.src))) {
    console.error("self-test FAILED: no discovered gated function dispatches with `switch (action)` — "
      + "the case-label half of the cross-check has no subject and is silently inert");
    process.exit(1);
  }
  for (const g of gateFns) {
    const errs = checkGateTable(g.fn, g.src);
    if (errs.length) {
      console.error(`self-test FAILED: ${g.fn} does not pass the GATES cross-check against the real file:`);
      for (const e of errs) console.error("  " + e);
      process.exit(1);
    }
  }
  const gateSrcOf = (fn) => gateFns.find((g) => g.fn === fn).src;

  // FIRES on the switch/case form. portal-sms dispatches with `switch (action)`, so under the
  // old `action === "x"` scan every one of its ten gates would have read as stale — which is
  // why adding it to the list was never enough on its own.
  const smsSrc = gateSrcOf("portal-sms");
  const smsCase = 'case "opt_outs": {';
  if (!smsSrc.includes(smsCase)) {
    console.error("self-test: could not find the portal-sms case label to rename — update the self-test");
    process.exit(1);
  }
  const smsErrs = checkGateTable("portal-sms", smsSrc.replace(smsCase, 'case "opt_outs_typo": {'));
  if (!smsErrs.some((e) => e.includes('action "opt_outs_typo" has no entry in GATES'))) {
    console.error("self-test FAILED: a `case` label with no GATES entry was not caught — the switch/case "
      + "half of the cross-check does not fire");
    process.exit(1);
  }
  if (!smsErrs.some((e) => e.includes('GATES lists "opt_outs" but no branch'))) {
    console.error("self-test FAILED: a GATES entry whose `case` label is gone was not reported as stale");
    process.exit(1);
  }
  // SCOPED. portal-sms holds a second switch (`switch (reg.status)`, in advanceOne) whose ten
  // labels are states, not actions. An unscoped case scan reports every one of them as ungated.
  if (smsErrs.some((e) => e.includes("brand_pending"))) {
    console.error("self-test FAILED: a `switch (reg.status)` label was read as an action — the case scan "
      + "is no longer scoped to the `switch (action)` dispatch block");
    process.exit(1);
  }

  // FIRES on the `action === "x"` form too — the original shape, which had no coverage either.
  const setSrc = gateSrcOf("portal-settings");
  const setIf = 'if (action === "save_colors") {';
  if (!setSrc.includes(setIf)) {
    console.error("self-test: could not find the portal-settings branch to rename — update the self-test");
    process.exit(1);
  }
  const setErrs = checkGateTable("portal-settings", setSrc.replace(setIf, 'if (action === "save_colors_typo") {'));
  if (!setErrs.some((e) => e.includes('action "save_colors_typo" has no entry in GATES'))
      || !setErrs.some((e) => e.includes('GATES lists "save_colors" but no branch'))) {
    console.error("self-test FAILED: the `action === \"x\"` half of the cross-check no longer fires");
    process.exit(1);
  }

  // The ONE-LINE table is really parsed. sync-design-status writes its whole table on a single
  // line and reaches its only action through `defaultAction`, never `===` — it sat in the
  // checked list for months with zero gates and zero actions read out of it, passing by saying
  // nothing about anything.
  const syncSrc = gateSrcOf("sync-design-status");
  const syncTable = 'const GATES: GateTable = { sync: { area: "designs", level: "view" } };';
  if (!syncSrc.includes(syncTable)) {
    console.error("self-test: could not find sync-design-status's one-line GATES table — update the self-test");
    process.exit(1);
  }
  const syncStale = checkGateTable("sync-design-status",
    syncSrc.replace(syncTable, syncTable.replace(" } };", ' }, stale_entry: "open" };')));
  if (!syncStale.some((e) => e.includes('GATES lists "stale_entry"'))) {
    console.error("self-test FAILED: a second entry added to the one-line GATES table was not read — the "
      + "table's extent or its keys are being parsed as nothing");
    process.exit(1);
  }
  // Multi-line, the shape any reformat would produce. `area` and `level` are fields of the
  // value, not gate names: a line-anchored key scan reports two phantom stale entries here.
  const syncMulti = checkGateTable("sync-design-status", syncSrc.replace(syncTable,
    'const GATES: GateTable = {\n  sync: {\n    area: "designs",\n    level: "view",\n  },\n};'));
  if (syncMulti.length) {
    console.error("self-test FAILED: the same table written across several lines does not pass:");
    for (const e of syncMulti) console.error("  " + e);
    process.exit(1);
  }
  // And the vacuity guard fires: strip the default action and nothing in that file dispatches
  // at all, which must read as "this rule has gone blind", never as a clean pass.
  const syncBlind = checkGateTable("sync-design-status",
    syncSrc.replace('defaultAction: "sync"', "readActions: new Set()"));
  if (!syncBlind.some((e) => e.includes("silently inert"))) {
    console.error("self-test FAILED: a gated function with no discoverable action passed the cross-check — "
      + "the vacuity guard does not fire, so a rule reading nothing reports clean");
    process.exit(1);
  }
  console.log(`self-test passed: the GATES cross-check reads all ${gateFns.length} discovered function(s), fires on `
    + "both `action === \"x\"` and `switch/case` dispatch, ignores a non-dispatch switch, and refuses to run blind");

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

errors.push(...checkMyQuotesTaxBreakdown(readFileSync(join(root, "my-quotes.html"), "utf8")));
errors.push(...checkMyQuotesPayFigures(readFileSync(join(root, "my-quotes.html"), "utf8")));

if (errors.length) {
  console.error(`preflight: ${errors.length} error(s) — push refused\n`);
  for (const e of errors) console.error("  " + e);
  console.error("\nFix the above, or in a genuine emergency: git push --no-verify (and say so in the commit).");
  process.exit(1);
}
