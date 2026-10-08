#!/usr/bin/env node
// Release-note nudge: name the commits going to beta that change something a builder sees but
// carry no `Release-note:` trailer. It NEVER blocks anything and always exits 0.
//
//   node scripts/release-note-nudge.mjs <from>..<to> [more ranges]     (.githooks/pre-push)
//   node scripts/release-note-nudge.mjs --github --last 20 <sha>       (the workflow's fallback)
//   node scripts/release-note-nudge.mjs --github <before>..<after>     (release-notes-on-beta.yml)
//
// WHY. What's New is written by people, in the commit (CLAUDE.md, "What's New changelog"):
// release-ci copies a commit's `Release-note:` trailer word for word when the commit lands on beta,
// and nothing ever writes a note for you. So the only way a fix reaches builders' Support page is a
// person remembering the trailer. This is the reminder, at the moment it is still cheap: before the
// push (the hook) and in the push's Actions summary (the workflow).
//
// WHAT COUNTS AS USER-FACING (isUserFacing): portal/, the public pages (*.html but admin.html), the
// designer component and its mount, the compiled artifacts that ship them, and supabase/functions
// except tests. Not tests/, scripts/, migrations, docs, workflows or admin-only files. A commit with
// `Release-note: none` is a deliberate "nothing to announce" and is not named.
//
// COVERED LATER IN THE SAME PUSH: an EMPTY commit (no files) carrying a Release-note trailer covers
// the user-facing commits before it in the range. That is the fix this nudge suggests:
//     git commit --allow-empty -m "Release note" --trailer "Release-note: fix: <words>"
//
// --github prints `::warning::` lines for the Actions log naming only the short sha and the areas
// touched, never the commit subject: the log is public and a subject may name a builder.
//
// The trailer rule is the one _shared/releaseTrailer.ts parses (the LAST paragraph of a message with
// more than one, every line `Key: value` or an indented continuation). It is restated here, not
// imported, so this runs on any Node with no TypeScript step; the test pins the same vectors.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAX_COMMITS = 200;

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*[ \t]*:/;
const CONTINUATION = /^[ \t]+\S/;

/** Does this message carry a Release-note trailer (any value, `none` included)? */
export function hasReleaseTrailer(message) {
  const text = String(message ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const paras = text.split(/\n[ \t]*\n/).filter((p) => p.trim() !== "");
  if (paras.length < 2) return false;
  const lines = paras[paras.length - 1].split("\n");
  let found = false;
  for (const [i, line] of lines.entries()) {
    if (i > 0 && CONTINUATION.test(line)) continue;
    if (!TRAILER_LINE.test(line)) return false;
    if (/^release-note[ \t]*:[ \t]*\S/i.test(line)) found = true;
  }
  return found;
}

const PUBLIC_ROOT_FILES = new Set(["StructureStudio.jsx", "structure-studio.component.js", "index.mount.jsx"]);

/** Would a change to this repo path reach a builder or their customer? */
export function isUserFacing(path) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("portal/")) return true;
  if (!p.includes("/")) {
    if (PUBLIC_ROOT_FILES.has(p)) return true;
    if (p === "admin.html" || p.startsWith("admin.")) return false;
    return p.endsWith(".html") || p.endsWith(".compiled.js");
  }
  if (p.startsWith("supabase/functions/")) {
    if (p.includes("/_test_stubs/")) return false;
    if (/(?:\.test|_test)\.(?:ts|js|mjs|cjs)$/.test(p)) return false;
    if (/\.md$/i.test(p)) return false;
    return true;
  }
  return false;
}

/** The areas a list of paths touches, for a log line: "portal/", "supabase/functions/", "index.html". */
function areas(files) {
  const out = new Set();
  for (const f of files) {
    if (!isUserFacing(f)) continue;
    out.add(f.startsWith("portal/") ? "portal/" : f.startsWith("supabase/functions/") ? "supabase/functions/" : f);
  }
  return [...out].slice(0, 4);
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/**
 * The commits in `ranges` (oldest first, merges skipped, at most MAX_COMMITS) that are user-facing
 * and not covered by a trailer. `last` + a single rev means "the last N commits of that rev".
 */
export function findMissing({ ranges = [], last = null, cwd = process.cwd() } = {}) {
  const shas = [];
  const seen = new Set();
  const specs = ranges.flatMap((r) => String(r).split(/\s+/)).filter(Boolean);
  for (const spec of specs) {
    if (!/^[0-9A-Za-z_./^~-]+(?:\.\.[0-9A-Za-z_./^~-]+)?$/.test(spec)) continue;   // no options smuggled in
    const n = last ? Math.min(Number(last) || 0, MAX_COMMITS) : MAX_COMMITS;
    const r = git(["rev-list", "--no-merges", `--max-count=${n}`, spec, "--"], cwd);
    if (!r.ok) continue;
    for (const s of r.out.split("\n").filter(Boolean)) if (!seen.has(s)) { seen.add(s); shas.push(s); }
  }
  // rev-list is newest first; walk oldest first so an empty note commit covers what came before it.
  const ordered = shas.slice(0, MAX_COMMITS).reverse();
  let pending = [];
  for (const sha of ordered) {
    const msg = git(["show", "-s", "--format=%B", sha], cwd).out;
    const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-z", sha], cwd).out.split("\0").filter(Boolean);
    const trailer = hasReleaseTrailer(msg);
    if (!files.length && trailer) { pending = []; continue; }
    if (trailer) continue;
    const touched = areas(files);
    if (!touched.length) continue;
    pending.push({ sha, subject: msg.split("\n")[0].trim(), areas: touched });
  }
  return pending;
}

/** The lines to print. Local: subjects (it is your own terminal). --github: shas and areas only. */
export function render(missing, { github = false } = {}) {
  if (!missing.length) return [];
  if (github) {
    return missing.map((m) => `::warning title=No release note::${m.sha.slice(0, 7)} changes ${m.areas.join(", ")} but has no Release-note trailer `
      + "(Release-note: feature|fix: <words a builder reads>, or Release-note: none).");
  }
  const lines = [`release-note nudge: ${missing.length} commit(s) going to beta change what builders see but have no Release-note trailer:`];
  for (const m of missing) lines.push(`  ${m.sha.slice(0, 7)}  ${m.subject.slice(0, 72)}`);
  lines.push(
    "If builders can use the change, write the words now, in the block with Co-Authored-By (an empty commit is fine):",
    '  git commit --allow-empty -m "Release note" --trailer "Release-note: fix: <what a builder can now do, 10-120 chars>"',
    'or, when there is nothing to announce: --trailer "Release-note: none".',
    "Never a builder's name or pricing in a trailer: this repo is public. (This does not block the push.)",
  );
  return lines;
}

function main(argv) {
  const github = argv.includes("--github");
  let last = null;
  const ranges = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--github") continue;
    if (argv[i] === "--last") { last = argv[i + 1]; i += 1; continue; }
    ranges.push(argv[i]);
  }
  try {
    const lines = render(findMissing({ ranges, last }), { github });
    // Workflow commands are read from stdout; the hook's notes go to stderr like the rest of its output.
    for (const l of lines) (github ? console.log : console.error)(l);
  } catch (e) {
    console.error(`release-note nudge: skipped (${e && e.message ? e.message : e})`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
