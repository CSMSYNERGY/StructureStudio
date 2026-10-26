#!/usr/bin/env node
// Release-note nudge: name the commits going to beta that change something a builder sees but
// carry no `Release-note:` trailer, or carry one release-ci cannot read. It NEVER blocks anything
// and always exits 0.
//
//   node scripts/release-note-nudge.mjs <from>..<to> [more ranges]     (.githooks/pre-push)
//   node scripts/release-note-nudge.mjs --commit-msg <message file>     (.githooks/commit-msg)
//   node scripts/release-note-nudge.mjs --github --last 20 <sha>       (the workflow's fallback)
//   node scripts/release-note-nudge.mjs --github <before>..<after>     (release-notes-on-beta.yml)
//
// WHY. What's New is written by people, in the commit (CLAUDE.md, "What's New changelog"):
// release-ci copies a commit's `Release-note:` trailer word for word when the commit lands on beta,
// and nothing ever writes a note for you. So the only way a fix reaches builders' Support page is a
// person remembering the trailer. This is the reminder, at the moments it is still cheap: when the
// commit is made (the commit-msg hook, while the change is in front of you), before the push (the
// pre-push hook) and in the push's Actions summary (the workflow).
//
// WHAT COUNTS AS USER-FACING (isUserFacing): portal/, the public pages (*.html but admin.html), the
// designer component and its mount, the compiled artifacts that ship them, supabase/functions
// except tests, and the phone Worker's source (workers/phone-api/src: what My Synergy Phone does).
// Not tests/, scripts/, migrations, docs, workflows or admin-only files. A commit with
// `Release-note: none` is a deliberate "nothing to announce" and is not named.
//
// NOT READ AS WRITTEN (trailerProblem): a Release-note line release-ci would refuse (not
// `feature: …` / `fix: …` / `none`, a title outside 10-120 characters, a web address, two notes) or
// one that is not in the closing trailer block at all. Those are named whatever files they touch:
// somebody meant to write a note, and it will not appear.
//
// COVERED LATER IN THE SAME PUSH: an EMPTY commit (no files) carrying a usable Release-note trailer
// covers the user-facing commits before it in the range. That is the fix this nudge suggests:
//     git commit --allow-empty -m "Release note" --trailer "Release-note: fix: <words>"
//
// --github prints `::warning::` lines for the Actions log naming only the short sha, the areas
// touched and a fixed reason, never the commit subject: the log is public and a subject may name a
// builder.
//
// The trailer rule is the one _shared/releaseTrailer.ts parses (the closing run of paragraphs in
// which every line is `Key: value` or an indented continuation; never the subject). It is restated
// here, not imported, so this runs on any Node with no TypeScript step; the test pins the same
// vectors.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAX_COMMITS = 200;

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*[ \t]*:/;
const CONTINUATION = /^[ \t]+\S/;
const RELEASE_LINE = /^release-note[ \t]*:[ \t]*(.*)$/i;
// releaseTrailer.ts's URLISH, TITLE_MIN and TITLE_MAX.
const URLISH = /(?:https?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:app|com|net|org|io|dev|co|us)\b)/i;
const TITLE_MIN = 10;
const TITLE_MAX = 120;

/** The trailer lines of a message: the closing run of paragraphs that are all trailer lines
 *  (continuations folded onto the line above), never the first paragraph. [] when none. */
function trailerLines(message) {
  const text = String(message ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const paras = text.split(/\n[ \t]*\n/).filter((p) => p.trim() !== "");
  const blocks = [];
  for (let i = paras.length - 1; i >= 1; i -= 1) {
    const out = [];
    let ok = true;
    for (const line of paras[i].split("\n")) {
      if (CONTINUATION.test(line) && out.length) { out[out.length - 1] += ` ${line.trim()}`; continue; }
      if (!TRAILER_LINE.test(line)) { ok = false; break; }
      out.push(line);
    }
    if (!ok) break;
    blocks.unshift(out);
  }
  return blocks.flat();
}

/** Does this message carry a Release-note trailer (any value, `none` included)? */
export function hasReleaseTrailer(message) {
  return trailerLines(message).some((l) => /^release-note[ \t]*:[ \t]*\S/i.test(l));
}

/**
 * Why release-ci will not read this message's Release-note as written, as a fixed sentence that
 * never repeats the text; null when there is nothing wrong (including when there is no
 * Release-note line at all: that is findMissing's business, not a problem with a note).
 */
export function trailerProblem(message) {
  const notes = trailerLines(message).map((l) => RELEASE_LINE.exec(l)).filter(Boolean);
  if (!notes.length) {
    // A Release-note line somewhere below the subject that is not in the closing block.
    const body = String(message ?? "").replace(/\r\n?/g, "\n").split("\n").slice(1);
    return body.some((l) => RELEASE_LINE.test(l))
      ? "its Release-note line is not in the closing trailer block (prose after it, or on a line with prose), so it is not read"
      : null;
  }
  if (notes.length > 1) return "it has more than one Release-note line";
  const value = notes[0][1].trim();
  if (!value) return null;   // an empty value is no trailer (hasReleaseTrailer is false too)
  if (/^none$/i.test(value)) return null;
  const m = /^(feature|fix)[ \t]*:[ \t]*(.*)$/i.exec(value);
  if (!m) return "its Release-note must be `feature: <title>`, `fix: <title>` or `none`";
  const n = Array.from(m[2].trim()).length;
  if (n < TITLE_MIN || n > TITLE_MAX) return `its Release-note title must be ${TITLE_MIN}-${TITLE_MAX} characters`;
  if (URLISH.test(m[2])) return "its Release-note title has a web address in it";
  return null;
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
  // The phone Worker's code is what My Synergy Phone does on a builder's phone and in Chrome.
  if (p.startsWith("workers/phone-api/src/")) return !/\.(?:test|spec)\.[cm]?[jt]s$/.test(p);
  return false;
}

/** The areas a list of paths touches, for a log line: "portal/", "supabase/functions/", "index.html". */
function areas(files) {
  const out = new Set();
  for (const f of files) {
    if (!isUserFacing(f)) continue;
    out.add(f.startsWith("portal/") ? "portal/"
      : f.startsWith("supabase/functions/") ? "supabase/functions/"
        : f.startsWith("workers/phone-api/") ? "workers/phone-api/" : f);
  }
  return [...out].slice(0, 4);
}

function git(args, cwd, env) {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/**
 * The commits in `ranges` (oldest first, merges skipped, at most MAX_COMMITS) that are user-facing
 * and not covered by a trailer, plus any whose Release-note release-ci cannot read (`problem`).
 * `last` + a single rev means "the last N commits of that rev".
 */
export function findMissing({ ranges = [], last = null, cwd = process.cwd(), env = process.env } = {}) {
  const shas = [];
  const seen = new Set();
  const specs = ranges.flatMap((r) => String(r).split(/\s+/)).filter(Boolean);
  for (const spec of specs) {
    if (!/^[0-9A-Za-z_./^~-]+(?:\.\.[0-9A-Za-z_./^~-]+)?$/.test(spec)) continue;   // no options smuggled in
    const n = last ? Math.min(Number(last) || 0, MAX_COMMITS) : MAX_COMMITS;
    const r = git(["rev-list", "--no-merges", `--max-count=${n}`, spec, "--"], cwd, env);
    if (!r.ok) continue;
    for (const s of r.out.split("\n").filter(Boolean)) if (!seen.has(s)) { seen.add(s); shas.push(s); }
  }
  // rev-list is newest first; walk oldest first so an empty note commit covers what came before it.
  const ordered = shas.slice(0, MAX_COMMITS).reverse();
  let pending = [];
  for (const sha of ordered) {
    const msg = git(["show", "-s", "--format=%B", sha], cwd, env).out;
    const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-z", sha], cwd, env).out.split("\0").filter(Boolean);
    const trailer = hasReleaseTrailer(msg);
    const problem = trailerProblem(msg);
    const subject = msg.split("\n")[0].trim();
    // Somebody wrote a note and it will not be read: say so whatever the commit touches.
    if (problem) { pending.push({ sha, subject, areas: areas(files), problem }); continue; }
    if (!files.length && trailer) { pending = pending.filter((m) => m.problem); continue; }
    if (trailer) continue;
    const touched = areas(files);
    if (!touched.length) continue;
    pending.push({ sha, subject, areas: touched });
  }
  return pending;
}

const REMEDY = [
  "If builders can use the change, write the words now, in the block with Co-Authored-By (an empty commit is fine):",
  '  git commit --allow-empty -m "Release note" --trailer "Release-note: fix: <what a builder can now do, 10-120 chars>"',
  'or, when there is nothing to announce: --trailer "Release-note: none".',
];
const PUBLIC = "Never a builder's name or pricing in a trailer: this repo is public.";

/** The lines to print. Local: subjects (it is your own terminal). --github: shas, areas, reasons. */
export function render(missing, { github = false } = {}) {
  if (!missing.length) return [];
  if (github) {
    return missing.map((m) => (m.problem
      ? `::warning title=Release note not read::${m.sha.slice(0, 7)}: ${m.problem}.`
      : `::warning title=No release note::${m.sha.slice(0, 7)} changes ${m.areas.join(", ")} but has no Release-note trailer `
        + "(Release-note: feature|fix: <words a builder reads>, or Release-note: none)."));
  }
  const lines = [
    `release-note nudge: ${missing.length} commit(s) going to beta change what builders see but have no Release-note trailer `
      + "that release-ci can read, so Support > New Features / Bug Fixes will not show them:",
  ];
  for (const m of missing) {
    lines.push(`  ${m.sha.slice(0, 7)}  ${m.subject.slice(0, 72)}`);
    if (m.problem) lines.push(`           (${m.problem})`);
  }
  lines.push(...REMEDY, `${PUBLIC} (This does not block the push.)`);
  return lines;
}

/** Strip what git strips from a commit message file: comment lines, and everything from the
 *  `git commit -v` scissors line down (the diff). */
function cleanMessage(text) {
  const out = [];
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^# -+ >8 -+$/.test(line)) break;
    if (line.startsWith("#")) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The commit-msg reminder: the lines to print for a commit about to be made with `message` over the
 * staged `files`, or [] when there is nothing to say. Pure, so the test drives it directly.
 */
export function commitMsgReminder({ message, files }) {
  const msg = cleanMessage(message);
  const problem = trailerProblem(msg);
  if (problem) {
    return [
      `release-note: this commit's note will not reach the Support page: ${problem}.`,
      "  Fix the words with: git commit --amend",
      `  ${PUBLIC} (This does not block the commit.)`,
    ];
  }
  if (hasReleaseTrailer(msg)) return [];
  const touched = areas(files || []);
  if (!touched.length) return [];
  return [
    `release-note: this commit changes what builders see (${touched.join(", ")}) but has no Release-note trailer,`,
    "  so it will not appear in Support > New Features / Bug Fixes. Add the words now, while the change is in front of you:",
    '    git commit --amend --no-edit --trailer "Release-note: fix: <what a builder can now do, 10-120 chars>"',
    '  (or "Release-note: feature: ..."; or "Release-note: none" when there is nothing to announce).',
    `  ${PUBLIC} (This does not block the commit.)`,
  ];
}

/** commit-msg: the staged paths (git hands the hook GIT_INDEX_FILE for `commit -a` / `commit <paths>`). */
function stagedFiles(cwd, env) {
  const r = git(["diff", "--cached", "--name-only", "--no-renames", "-z"], cwd, env);
  return r.ok ? r.out.split("\0").filter(Boolean) : [];
}

function main(argv) {
  const github = argv.includes("--github");
  let last = null;
  let msgFile = null;
  const ranges = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--github") continue;
    if (argv[i] === "--last") { last = argv[i + 1]; i += 1; continue; }
    if (argv[i] === "--commit-msg") { msgFile = argv[i + 1] ?? ""; i += 1; continue; }
    ranges.push(argv[i]);
  }
  try {
    const lines = msgFile !== null
      ? (msgFile ? commitMsgReminder({ message: readFileSync(msgFile, "utf8"), files: stagedFiles(process.cwd(), process.env) }) : [])
      : render(findMissing({ ranges, last }), { github });
    // Workflow commands are read from stdout; the hooks' notes go to stderr like the rest of their output.
    for (const l of lines) (github ? console.log : console.error)(l);
  } catch (e) {
    console.error(`release-note nudge: skipped (${e && e.message ? e.message : e})`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
