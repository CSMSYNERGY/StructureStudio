// Offline JSX compiler — the pages ship COMPILED classic scripts; in-browser
// babel-standalone was removed from the pages on 2026-08-13 (it cost every visitor
// 2.85MB of compiler plus 1.5-4s of main-thread compile of up to ~1.2MB of JSX
// before anything rendered, on every single page load).
//
// THE COMPILER IS THE VENDORED vendor/babel-standalone-7.23.9.min.js, loaded in
// Node — the exact build that used to run in the browser, with the exact options
// its script-tag runner used (presets react+env, the three legacy plugins). Parity
// is therefore by construction, not by matching version numbers across two npm
// packages, and the repo gains zero new dependencies. The ONE deliberate
// divergence: sourceMaps off (the runner inlined them; a committed artifact would
// double in size for a map pointing at a public source anyway).
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

// source → artifact. The component's artifact name is load-bearing in preflight
// and the pages; extend here when a page grows a new source file.
export const TARGETS = [
  { src: "structure-studio.component.js", out: "structure-studio.component.compiled.js" },
  { src: "index.mount.jsx", out: "index.mount.compiled.js" },
  { src: "portal.app.jsx", out: "portal.app.compiled.js" },
  { src: "admin.app.jsx", out: "admin.app.compiled.js" },
];

export const PAGES = ["index.html", "portal.html", "admin.html"];

let _babel = null;
function babel() {
  if (!_babel) _babel = require(join(root, "vendor", "babel-standalone-7.23.9.min.js"));
  return _babel;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const lf = (s) => s.replace(/\r\n/g, "\n");

// Compile one source text to its full artifact text (banner + wrapper included).
export function compileSource(srcText, srcName) {
  const normalized = lf(srcText);
  const res = babel().transform(normalized, { ...RUNNER_OPTIONS, filename: srcName });
  return "// GENERATED FILE — do not edit. Compiled from " + srcName
    + " (sha256 " + sha256(normalized).slice(0, 12) + ")\n"
    + "// by scripts/compile.mjs using vendored babel-standalone 7.23.9. Rebuild: npm run compile\n"
    + ";(function () {\n"
    + "if (window.__ssBootBlocked) return; // the boot guard neutralises compiled scripts via this flag\n"
    + res.code
    + "\n}).call(window);\n";
}

const read = (f) => readFileSync(join(root, f), "utf8");

// Rewrite every compiled-artifact tag's ?v= on a page to the artifact's hash.
function rebuster(html, hashes) {
  return html.replace(/(src="\/?([a-zA-Z0-9.-]+\.compiled\.js))\?v=[a-zA-Z0-9]*"/g,
    (m, pre, file) => (hashes[file] ? `${pre}?v=${hashes[file]}"` : m));
}

export function buildAll() {
  const artifacts = {};
  const hashes = {};
  for (const t of TARGETS) {
    const art = compileSource(read(t.src), t.src);
    artifacts[t.out] = art;
    hashes[t.out] = sha256(art).slice(0, 8);
  }
  return { artifacts, hashes };
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
  if (!compileSource("const x = <a/>;", "probe.jsx").includes("React.createElement")) {
    return ["compile self-check failed: the vendored Babel produced no JSX output — the drift gate cannot run"];
  }
  for (const t of TARGETS) {
    if (!existsSync(join(root, t.out))) {
      problems.push(`${t.out}: missing — run \`npm run compile\` (compiled from ${t.src})`);
      continue;
    }
    if (lf(read(t.out)) !== built.artifacts[t.out]) {
      problems.push(`${t.out}: STALE — ${t.src} changed without recompiling. Run \`npm run compile\``);
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
