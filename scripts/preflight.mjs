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
//
// Zero output on success. Any failure prints the file, line, and message, and exits 1 —
// which makes the pre-push hook refuse the push.

import { Linter } from "eslint";
import globalsPkg from "globals";
import { readFileSync } from "node:fs";
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
  process.exit(0);
}

const errors = run(load());
if (errors.length) {
  console.error(`preflight: ${errors.length} error(s) — push refused\n`);
  for (const e of errors) console.error("  " + e);
  console.error("\nFix the above, or in a genuine emergency: git push --no-verify (and say so in the commit).");
  process.exit(1);
}
