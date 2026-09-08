// Offline JSX compiler — the pages ship COMPILED classic scripts; in-browser
// babel-standalone was removed from the pages on 2026-08-13 (it cost every visitor
// 2.85MB of compiler plus 1.5-4s of main-thread compile of up to ~1.2MB of JSX
// before anything rendered, on every single page load).
//
// THE COMPILER IS THE VENDORED vendor/babel-standalone-7.23.9.min.js, loaded in
// Node — the exact build that used to run in the browser, with the exact options
// its script-tag runner used (presets react+env, the three legacy plugins). Parity
// of the TRANSFORM is therefore by construction, not by matching version numbers
// across two npm packages. One deliberate divergence there: sourceMaps off (the
// runner inlined them; see NO SOURCE MAPS below).
//
// THE OUTPUT IS THEN MINIFIED (2026-09-06). The transform is still the runner's, but
// what gets written is no longer its default printout: Babel drops comments and
// squeezes whitespace (OUTPUT_OPTIONS), then the wrapped artifact goes through terser,
// which renames LOCAL bindings only. Two reasons, and the second is the sharper one.
// Speed: about a quarter of the two large artifacts was retained source comments, and
// RAW size is what the browser's parser pays for on the main thread before anything
// renders. Reliability: the boot_app_missing rows that commit 39e84b5 traced to
// truncated chunked transfers of these very files track SIZE, so every byte removed
// narrows that window too.
//
// NO SOURCE MAPS, still: a map is 1-1.5x the artifact, changes on every compile, and
// this repo commits its artifacts. keep_fnames/keep_classnames are on instead, so an
// app_errors stack trace still names the function that threw.
//
// WHY COMMITTED ARTIFACTS, NOT A DEPLOY-TIME BUILD: beta deploys are git-driven
// Workers Builds and production has a manual-LF-worktree fallback — a build step
// at deploy time breaks the manual path and the byte-parity verification habit.
// Artifacts are just more committed files; preflight recompiles and byte-compares
// them so a stale or hand-edited artifact refuses the push (the drift gate).
//
// EACH ARTIFACT IS WRAPPED in `(function () { if (window.__ssBootBlocked) return;
// … })();`. That is the boot guard's neutralise mechanism now — the old guard
// re-typed text/babel tags before Babel compiled them, which cannot stop an
// already-parsed classic script; a flag checked at the top of each artifact can.
// The wrapper also makes each artifact an isolated scope, which is the semantics
// the sources were already written for ("cross-block const sharing does not exist
// under Babel-standalone") — every cross-script handoff goes through an explicit
// window.* publish (window.StructureStudio, window.ssLogError, window.ssBootFail,
// window.__ssAppBooted). One documented consequence: a module that throws MID-RUN
// no longer half-publishes via hoisting, so index.html shows the boot screen
// (boot_component_missing) instead of the config-error screen — better reporting
// for a strictly-broken state.
//
// CACHE BUSTERS ARE CONTENT HASHES: every compiled tag's ?v= is rewritten to the
// first 8 hex of the artifact's sha256, so a stale buster is structurally
// impossible and the old hand-bumped date convention retires for these tags.
//
// Modes:
//   node scripts/compile.mjs             compile all sources, write artifacts,
//                                        rewrite ?v= hashes in the three pages
//   node scripts/compile.mjs --check     recompile in memory and byte-compare to
//                                        the committed artifacts + page busters;
//                                        exit 1 on drift (preflight runs this)
//   node scripts/compile.mjs --extract   one-time page surgery: move the inline
//                                        text/babel blocks out of the pages into
//                                        .jsx sources and rewire the tags (kept
//                                        scripted so the SAME transform can be
//                                        replayed on `beta` — see CLAUDE.md)
//
// Output is DETERMINISTIC: no timestamps, no machine paths (public repo). The
// banner carries the source sha256 so `git log -S` can tie an artifact to the
// source state it was built from.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// The exact options babel-standalone's script-tag runner applies to a tag with no
// data-presets/data-plugins attributes (none of ours carried any) — verified by
// reading the runner in the vendored file. Changing these changes what ships;
// don't, without re-verifying against a browser-compiled capture.
const RUNNER_OPTIONS = {
  presets: ["react", "env"],
  plugins: ["transform-class-properties", "transform-object-rest-spread", "transform-flow-strip-types"],
  sourceMaps: false,
  babelrc: false,
  configFile: false,
};

// How the transformed code is PRINTED. Kept out of RUNNER_OPTIONS on purpose: that
// constant is the record of what the browser runner did and has to stay readable as
// one, and neither of these changes a single semantic — they change the text.
//   comments: false — the sources are heavily commented and Babel copies every comment
//     into the artifact. That was ~500KB across the two large artifacts (about a
//     quarter of their bytes) of prose no browser needs.
//   compact: true — Babel's default is `compact: "auto"`, which turns whitespace
//     squeezing on only above a 500KB threshold, so the small artifacts shipped
//     formatted and the large ones did not, for no reason a reader could see.
const OUTPUT_OPTIONS = { comments: false, compact: true };

// THE MINIFIER, PINNED EXACTLY (no caret, deliberately). terser's output is
// deterministic for a given version + options, and the drift gate byte-compares
// artifacts — so two people on different patch releases would each see the other's
// artifacts as STALE, forever, with nothing on screen explaining why. package.json
// carries this same exact string and preflight refuses a mismatch. terser is pure JS
// (no platform binary, no postinstall download), which is what lets it sit in a repo
// whose only other dev dependencies are eslint and globals.
export const TERSER_VERSION = "5.51.2";

// Mangling renames LOCAL bindings only. `mangle.properties` stays OFF and must: every
// window.* publish, every field name in an edge function's JSON and every React prop is
// a property name, and renaming those breaks silently and everywhere. keep_fnames /
// keep_classnames preserve the names an app_errors stack trace is read by. No `ecma`
// override either — terser's default of 5 is what stops it from printing syntax newer
// than the ES5 Babel's `env` preset just produced.
const TERSER_OPTIONS = {
  compress: { passes: 2, keep_fnames: true, keep_classnames: true },
  mangle: { keep_fnames: true, keep_classnames: true },
  format: { comments: false },
};

// The portal app, split into ORDERED PARTS (2026-08-19). They are concatenated here and
// compiled as one script, which is the whole point: the emitted artifact is byte-identical
// to the single portal.app.jsx it replaced, so the split is a pure file reorganisation with
// nothing to re-verify at runtime.
//
// WHY CONCATENATION rather than one <script> per module: a compiled artifact is wrapped in
// its own IIFE, so separate artifacts share NO lexical scope and every one of the ~75
// top-level components would have to be re-plumbed through a window.* namespace. That is a
// large, risky rewrite which buys nothing here — the portal is ONE page, so all six tabs'
// code is downloaded on any route either way. Concatenating gets the thing that was actually
// asked for (Carolyn 2026-08-18: two people editing different areas stop colliding) at zero
// behavioural risk.
//
// ORDER IS LOAD-BEARING and must stay source order: `const` does not hoist, so moving a part
// changes evaluation order. Parts are contiguous slices of the original file, cut only at
// top-level boundaries (never inside a function), which is why 09-shell holds Dashboard and
// PortalApp together — Dashboard's hook order and its render-time ssTargetClientId
// assignment are documented hazards and nothing about them moves.
//
// THE NUMERIC PREFIX IS THE CONCATENATION INDEX, not a filing label. When a part is inserted,
// every later part is renumbered so a directory listing and this array can never disagree —
// a file numbered 09 that evaluates sixth is a trap, and the one thing a reader checks is the
// number. That is why 06-3d.jsx pushed admin/integrations/shell up by one (2026-08-21) rather
// than being appended as "09-3d.jsx": appended, it would land AFTER 09-shell's
// `ReactDOM.createRoot(…).render(<PortalApp/>)` and after the `__ssAppBooted` sentinel, which
// is defined as the last statement that runs.
export const PORTAL_PARTS = [
  "portal/01-core.jsx",          // supabase client, ssFetch/ssLogError, tenant scoping, routing, S/ACCENT, UI atoms
  "portal/02-sales.jsx",         // DesignsTable, contact timeline, LeadsTable
  "portal/03-catalog.jsx",       // SettingsView, csv/xlsx, BillingView, PricingCsv, LayoutPricing, fixtures, colors
  "portal/04-orders.jsx",        // feedback + releases, ComingSoon, Orders, OrderDetail, Inventory
  "portal/05-schedule.jsx",      // build + delivery schedule, repairs, drivers, locations
  "portal/06-3d.jsx",            // Studio3DStatus, DesignerTab, fixture-photo straightening (ssWarpQuad et al)
  "portal/07-admin.jsx",         // AccountsTab, BillingGate, the operator admin console (Adm*)
  "portal/08-integrations.jsx",  // QuickBooks, email sending, commissions, per-person access, SettingsShell
  "portal/09-table-engine.jsx",  // generic Monday-style grouped table (PMTable, PM_TYPES, cell editors)
  "portal/10-projects.jsx",      // internal Projects boards (operator-only Monday replacement)
  "portal/11-sms.jsx",           // self-serve SMS onboarding (A2P registration + number purchase)
  "portal/12-shell.jsx",         // Dashboard, ProfileDialog, PortalApp, the mount + __ssAppBooted sentinel
];

// source → artifact. The component's artifact name is load-bearing in preflight
// and the pages; extend here when a page grows a new source file.
export const TARGETS = [
  { src: "structure-studio.component.js", out: "structure-studio.component.compiled.js" },
  { src: "index.mount.jsx", out: "index.mount.compiled.js" },
  { name: "portal.app.jsx", parts: PORTAL_PARTS, out: "portal.app.compiled.js" },
  { src: "admin.app.jsx", out: "admin.app.compiled.js" },
];

// The name a target is REPORTED under (banners, preflight lint labels). A split target keeps
// its old single-file name so nothing downstream has to learn about the parts.
export const targetName = (t) => t.name || t.src;

export const PAGES = ["index.html", "portal.html", "admin.html"];

let _babel = null;
function babel() {
  if (!_babel) _babel = require(join(root, "vendor", "babel-standalone-7.23.9.min.js"));
  return _babel;
}

// The installed terser's version, or null when it is not installed at all. Exported so
// preflight can report both cases in its own voice rather than by catching an exception.
export function installedTerserVersion() {
  try {
    return require("terser/package.json").version;
  } catch {
    return null;
  }
}

let _terser = null;
function terser() {
  if (!_terser) {
    const version = installedTerserVersion();
    if (version === null) {
      throw new Error("terser is not installed — the artifacts cannot be minified. Run `npm install`.");
    }
    if (version !== TERSER_VERSION) {
      throw new Error(`terser ${version} is installed but package.json pins ${TERSER_VERSION}. `
        + "Different minifier versions emit different bytes and the artifact drift gate "
        + "byte-compares, so this would read as permanent staleness. Run `npm install`.");
    }
    _terser = require("terser");
  }
  return _terser;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const lf = (s) => s.replace(/\r\n/g, "\n");

// Compile one source text to its full artifact text (banner + wrapper included).
//
// The minifier runs over the WRAPPED text, not over Babel's output: the wrapper is what
// gives the ~75 top-level components a function scope, and renaming a binding is only
// safe — and only worth anything — inside one. The banner rides in as terser's
// `preamble` so it survives `comments: false`.
export function compileSource(srcText, srcName) {
  const normalized = lf(srcText);
  const res = babel().transform(normalized, { ...RUNNER_OPTIONS, ...OUTPUT_OPTIONS, filename: srcName });
  const banner = "// GENERATED FILE — do not edit. Compiled from " + srcName
    + " (sha256 " + sha256(normalized).slice(0, 12) + ")\n"
    + "// by scripts/compile.mjs: vendored babel-standalone 7.23.9 + terser " + TERSER_VERSION
    + ". Rebuild: npm run compile";
  const wrapped = ";(function () {\n"
    + "if (window.__ssBootBlocked) return; // the boot guard neutralises compiled scripts via this flag\n"
    + res.code
    + "\n}).call(window);\n";
  const min = terser().minify_sync(wrapped, {
    ...TERSER_OPTIONS,
    format: { ...TERSER_OPTIONS.format, preamble: banner },
  });
  if (min.error) throw min.error;
  return min.code + "\n";
}

const read = (f) => readFileSync(join(root, f), "utf8");

// One target's full source: a plain file, or its parts concatenated IN ORDER. Exported so
// preflight lints exactly the text that gets compiled, rather than keeping its own list that
// could drift out of step (a source nothing lints is this repo's oldest silent-pass shape).
export function readTarget(t) {
  return t.parts ? t.parts.map(read).join("") : read(t.src);
}

// Rewrite every compiled-artifact tag's ?v= on a page to the artifact's hash.
function rebuster(html, hashes) {
  return html.replace(/(src="\/?([a-zA-Z0-9.-]+\.compiled\.js))\?v=[a-zA-Z0-9]*"/g,
    (m, pre, file) => (hashes[file] ? `${pre}?v=${hashes[file]}"` : m));
}

export function buildAll() {
  const artifacts = {};
  const hashes = {};
  for (const t of TARGETS) {
    const art = compileSource(readTarget(t), targetName(t));
    artifacts[t.out] = art;
    hashes[t.out] = sha256(art).slice(0, 8);
  }
  return { artifacts, hashes };
}

// The vacuity probe both gates compile with. It ASSIGNS TO A GLOBAL rather than binding a
// local (`const x = <a/>;`, what this used to be) because the minifier is entitled to drop
// an unused local — and a probe the minifier dead-strips would read as "the compiler is
// broken" and take both gates down with a message pointing at the wrong thing entirely.
export const PROBE_SOURCE = "window.__ssProbe = <a/>;";

// ── The artifact SHAPE gate ──────────────────────────────────────────────────────────────
//
// The drift gate below proves an artifact matches its source. It cannot prove the artifact
// still has the runtime properties the boot machinery depends on, because a minifier that
// quietly renamed one of them would change source and artifact together and the byte compare
// would stay happy. So these are asserted directly, on the shipped text.
//
// All three checks are written to pass BOTH the un-minified shape (`if (window.__ssBootBlocked)
// return;` … `window.__ssAppBooted = true;`) and terser's rewrite of it, so the gate survives a
// minifier version bump without being rewritten — it is about the shape, not about terser.
const ARTIFACT_BANNER = /^(?:\/\/[^\n]*\n)+/;

// 1. The boot guard's neutralise mechanism must be the first thing the wrapper touches.
//    Terser prints the `if (…) return;` as `if(!window.__ssBootBlocked){…}` and, for a small
//    enough body, as `window.__ssBootBlocked||(…)`; both are accepted, anything that runs
//    BEFORE the flag is read is not.
const GUARD_FIRST =
  /^\s*[;!]?\(?function\s*\(\s*\)\s*\{\s*(?:"use strict";\s*)?(?:if\s*\(\s*!?\s*window\.__ssBootBlocked\s*\)|!?\s*window\.__ssBootBlocked\s*(?:\|\||&&|\?))/;

// 2. The DOMContentLoaded sentinel must still be the LAST statement of the guarded body —
//    the `}` is what proves "last": nothing follows it inside its block. (Terser prints the
//    babel helper FUNCTION DECLARATIONS after that brace; declarations hoist, so they cannot
//    run first, and they are outside the guarded block by then anyway.)
const SENTINEL_LAST = /window\.__ssAppBooted\s*=\s*(?:true|!0)\s*;?\s*\}/;

// 3. Every cross-script handoff goes through an explicit window.* publish — each artifact is
//    its own IIFE and shares no lexical scope with the others, so these NAMES are the whole
//    interface between them. Property names are never mangled (see TERSER_OPTIONS), and this
//    is the assertion that says so out loud. Listed per artifact rather than derived from the
//    sources, because a source mention can be a comment and comments no longer ship.
const ARTIFACT_PUBLISHES = {
  "structure-studio.component.compiled.js": ["window.StructureStudio", "window.ssAllowedOrigin", "window.ssLogError"],
  "index.mount.compiled.js": ["window.StructureStudio", "window.ssAllowedOrigin", "window.ssLogError", "window.ssBootFail", "window.__ssAppBooted"],
  "portal.app.compiled.js": ["window.StructureStudio", "window.ssLogError", "window.__ssAppBooted"],
  "admin.app.compiled.js": ["window.ssLogError", "window.__ssAppBooted"],
};

// Which artifacts are an APP (they mount something and publish the sentinel) as opposed to
// the shared designer module, which is only ever loaded by one of them.
const APP_ARTIFACTS = ["index.mount.compiled.js", "portal.app.compiled.js", "admin.app.compiled.js"];

// Takes the artifact texts as a map so the caller can hand it the committed files OR a
// deliberately broken copy — the gate is only worth having if it can be proven to fire.
export function checkArtifactShape(artifacts) {
  const problems = [];
  for (const t of TARGETS) {
    const text = artifacts[t.out];
    if (text === undefined) continue; // missing entirely: the drift gate names it
    if (!GUARD_FIRST.test(text.replace(ARTIFACT_BANNER, ""))) {
      problems.push(`${t.out}: the \`window.__ssBootBlocked\` guard is no longer the first thing the `
        + "artifact's wrapper does — that flag is how the dependency boot guard neutralises "
        + "compiled scripts, and code above it runs on a page the guard has already given up on");
    }
    if (APP_ARTIFACTS.includes(t.out) && !SENTINEL_LAST.test(text)) {
      problems.push(`${t.out}: \`window.__ssAppBooted\` is not the last statement of the guarded body — `
        + "the boot guard's DOMContentLoaded check reads that sentinel to mean \"this app ran to "
        + "completion\", so setting it anywhere earlier turns a broken app back into a silent blank page");
    }
    for (const name of ARTIFACT_PUBLISHES[t.out] || []) {
      if (!text.includes(name)) {
        problems.push(`${t.out}: \`${name}\` is missing from the built artifact — the artifacts share no `
          + "lexical scope, so a lost or renamed window.* publish breaks the handoff between two "
          + "<script> tags with nothing at compile time to notice");
      }
    }
  }
  return problems;
}

// The drift gate: recompile everything and byte-compare against what is committed.
// Returns a list of human-readable problems (empty = fresh).
export function checkArtifacts() {
  const problems = [];
  let built;
  try {
    built = buildAll();
  } catch (e) {
    return [`compile failed: ${e && e.message ? e.message : e}`];
  }
  // Vacuity guard: a broken require of the vendored compiler must never read as
  // "everything is fresh". Prove the compiler actually compiles JSX.
  if (!compileSource(PROBE_SOURCE, "probe.jsx").includes("React.createElement")) {
    return ["compile self-check failed: the vendored Babel produced no JSX output — the drift gate cannot run"];
  }
  for (const t of TARGETS) {
    if (!existsSync(join(root, t.out))) {
      problems.push(`${t.out}: missing — run \`npm run compile\` (compiled from ${targetName(t)})`);
      continue;
    }
    if (lf(read(t.out)) !== built.artifacts[t.out]) {
      problems.push(`${t.out}: STALE — ${targetName(t)} changed without recompiling. Run \`npm run compile\``);
    }
  }
  for (const p of PAGES) {
    const html = read(p);
    for (const m of html.matchAll(/src="\/?([a-zA-Z0-9.-]+\.compiled\.js)\?v=([a-zA-Z0-9]*)"/g)) {
      const want = built.hashes[m[1]];
      if (want && m[2] !== want) {
        problems.push(`${p}: ${m[1]} buster is ?v=${m[2] || "MISSING"} but the artifact hashes ${want} — run \`npm run compile\``);
      }
    }
  }
  return problems;
}

function writeAll() {
  const { artifacts, hashes } = buildAll();
  for (const t of TARGETS) {
    writeFileSync(join(root, t.out), artifacts[t.out]);
    console.log(`wrote ${t.out}  (${artifacts[t.out].length} B, v=${hashes[t.out]})`);
  }
  for (const p of PAGES) {
    const html = read(p);
    const next = rebuster(html, hashes);
    if (next !== html) {
      writeFileSync(join(root, p), next);
      console.log(`rebusted ${p}`);
    }
  }
}

// One-time page surgery, kept as code so the same transform replays on `beta`.
// Moves the FIRST inline text/babel block of each page into its .jsx source (with
// the __ssAppBooted sentinel appended), swaps the src'd component tag and the
// inline block for defer'd compiled tags, and deletes the babel-standalone vendor
// tag. Refuses to run twice (no inline block left).
function extract() {
  const SENTINEL = "\n// The boot guard's DOMContentLoaded check reads this sentinel: a compiled app\n"
    + "// script that ran to completion is the definition of \"the app booted\". Without\n"
    + "// it, a 404'd or syntax-broken app artifact was a silent blank page - the one\n"
    + "// failure class the old inline-babel world could not even see.\n"
    + "window.__ssAppBooted = true;\n";
  const jobs = [
    { page: "index.html", jsx: "index.mount.jsx", out: "index.mount.compiled.js" },
    { page: "portal.html", jsx: "portal.app.jsx", out: "portal.app.compiled.js" },
    { page: "admin.html", jsx: "admin.app.jsx", out: "admin.app.compiled.js" },
  ];
  for (const j of jobs) {
    let html = read(j.page);
    const block = html.match(/<script type="text\/babel">\r?\n([\s\S]*?)<\/script>/);
    if (!block) { console.error(`${j.page}: no inline text/babel block — already extracted?`); continue; }
    writeFileSync(join(root, j.jsx), lf(block[1]) + SENTINEL);
    html = html.replace(block[0], `<script defer src="/${j.out}?v=00000000"></script>`);
    html = html.replace(/<script src="\/?structure-studio\.component\.js\?v=[a-z0-9]+" type="text\/babel"><\/script>/,
      '<script defer src="/structure-studio.component.compiled.js?v=00000000"></script>');
    html = html.replace(/<script src="\/vendor\/babel-standalone-[0-9.]+\.min\.js"><\/script>\n?/, "");
    writeFileSync(join(root, j.page), html);
    console.log(`extracted ${j.page} -> ${j.jsx}`);
  }
}

const mode = process.argv[2] || "";
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/")
  || process.argv[1] && process.argv[1].endsWith("compile.mjs")) {
  if (mode === "--check") {
    const problems = checkArtifacts();
    if (problems.length) {
      console.error(`compile --check: ${problems.length} problem(s)`);
      for (const p of problems) console.error("  " + p);
      process.exit(1);
    }
  } else if (mode === "--extract") {
    extract();
  } else {
    writeAll();
  }
}
