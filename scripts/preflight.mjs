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
//   2. The CDN version lock: all three pages must carry byte-identical React / ReactDOM /
//      supabase-js / babel-standalone URLs (CLAUDE.md rule — one page upgrading alone
//      silently changes behaviour for the shared module).
//   3. Cache-buster lockstep: index.html and portal.html must reference the same
//      structure-studio.component.js?v=… value.
//   4. The CDN boot guard is present on all three pages and byte-identical across them. It is
//      what turns a failed/blocked CDN request into a message the visitor can act on instead of
//      a permanently blank page; the three mount blocks are not twinned, so only this notices
//      one page drifting.
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

  // CDN lock — identical library URLs on all three pages.
  const cdnUrls = (html) =>
    [...html.matchAll(/<script src="(https:\/\/[^"]+)"/g)].map((m) => m[1]).sort().join("\n");
  const lock = cdnUrls(files["index.html"]);
  for (const f of ["portal.html", "admin.html"]) {
    if (cdnUrls(files[f]) !== lock) {
      errors.push(`${f}: CDN script URLs differ from index.html — the version lock (CLAUDE.md) is broken`);
    }
  }

  // Boot-guard lock — the plain <script data-ss-app="…"> block at the end of each page's body
  // must exist on all three, and its body must be byte-identical everywhere. It is the only
  // thing standing between a failed CDN request and a permanently blank page (a blank page is
  // what shipped until 2026-08-05, once to Googlebot), and unlike the designer the three mount
  // blocks are NOT hand-mirrored twins — so nothing else in the repo would notice one page
  // losing the guard or drifting from the others. Same argument as the CDN version lock above.
  // The per-page label lives on the tag attribute, deliberately outside the compared body.
  const guardBody = (html) => {
    const m = html.match(/<script data-ss-app="[^"]*">([\s\S]*?)<\/script>/);
    return m ? m[1] : null;
  };
  const guards = Object.fromEntries(
    ["index.html", "portal.html", "admin.html"].map((f) => [f, guardBody(files[f])]));
  for (const [f, body] of Object.entries(guards)) {
    if (body === null) {
      errors.push(`${f}: the CDN boot guard (<script data-ss-app="…">) is missing — a failed `
        + "CDN request would leave the visitor a blank page again");
    }
  }
  for (const f of ["portal.html", "admin.html"]) {
    if (guards[f] !== null && guards["index.html"] !== null && guards[f] !== guards["index.html"]) {
      errors.push(`${f}: the CDN boot guard body differs from index.html — the three copies must `
        + "stay byte-identical (only the data-ss-app label may differ)");
    }
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
    const gated = new Set([...table.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]));
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
  guardGone["admin.html"] = guardGone["admin.html"].replace(/<script data-ss-app="[^"]*">[\s\S]*?<\/script>/, "");
  if (!run(guardGone).some((e) => e.includes("boot guard") && e.includes("missing"))) {
    console.error("self-test FAILED: a missing CDN boot guard in admin.html was not caught");
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
  console.log("self-test passed: the CDN boot guard must be present on all three pages and identical");

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
