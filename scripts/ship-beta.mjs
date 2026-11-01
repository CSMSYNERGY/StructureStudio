#!/usr/bin/env node
// ship-beta.mjs — rebase onto beta, then push, and keep trying until it lands.
//
// WHY THIS EXISTS (Carolyn 2026-11-01: "I am running 4 agents. and I want you to always rebase
// then push to beta. this back and forth has got to stop.")
//
// Four sessions share this clone and this branch. Every push runs the pre-push gate, which takes
// minutes; in that window another session pushes, the ref moves, and the push is rejected with
// `cannot lock ref 'refs/heads/beta'`. The rebase that follows ALWAYS conflicts in the same four
// generated artifacts, because two sessions recompiled the same files. Resolving that by hand is
// where the real damage happened on 2026-11-01: a portal.html was committed with conflict markers
// still in it, and then a hand-written fix flipped the whole file to CRLF, which broke the boot
// guard's byte-identity rule. Both were caught by the gate, but only after two more lost rounds.
//
// So: the loop is scripted, and the artifact resolution is scripted, and neither is done by hand
// again. What is NOT scripted is a conflict in a SOURCE file — that stops immediately and hands it
// back, because a machine guessing at two people's edits is how work gets silently dropped.
//
//   npm run ship            — rebase, push, retry (default 6 attempts)
//   npm run ship -- --max 3
//   npm run ship -- --dry   — say what it would do, touch nothing
//
// It never force-pushes, never uses --no-verify, and never resolves a source conflict.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRANCH = "beta";

// The files `npm run compile` OWNS. A conflict in one of these is not a disagreement about
// anything a person wrote — both sides are machine output from sources that git has already
// merged, so the fix is always "take either side, then recompile". portal.html is here because
// compile.mjs rewrites its ?v= cache-busters; its hand-written parts conflicting would show up
// as a source conflict in the same file, which is why `git checkout --ours` is followed by a
// recompile AND a marker check rather than trusted on its own.
const GENERATED = new Set([
  "portal.app.compiled.js",
  "structure-studio.component.compiled.js",
  "index.mount.compiled.js",
  "admin.app.compiled.js",
  "portal.html",
]);

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const MAX = Number((args[args.indexOf("--max") + 1] || "").trim()) || 6;

function git(cmdArgs, { capture = true } = {}) {
  const r = spawnSync("git", cmdArgs, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const say = (s) => process.stdout.write(`${s}\n`);
const die = (s) => { process.stdout.write(`\n${s}\n`); process.exit(1); };

function conflictedPaths() {
  // U on either side of the status code = unmerged, whatever the combination (UU, AA, DU…).
  return git(["status", "--porcelain"]).out.split("\n")
    .filter((l) => /^(U.|.U|AA|DD)/.test(l))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

function markersIn(path) {
  const r = git(["grep", "-c", "-e", "^<<<<<<< ", "--", path]);
  return r.code === 0 && !/:0$/.test(r.out.trim());
}

/** Resolve a rebase whose conflicts are ONLY generated files. Returns true when it did. */
function resolveGenerated() {
  const paths = conflictedPaths();
  if (!paths.length) return false;
  const source = paths.filter((p) => !GENERATED.has(p));
  if (source.length) {
    git(["rebase", "--abort"]);
    die([
      "STOPPED — a SOURCE file conflicts, and this script will not guess at that:",
      ...source.map((p) => `  ${p}`),
      "",
      "The rebase was aborted, so your branch is exactly as it was. Resolve it by hand,",
      "run `npm run compile`, then `npm run ship` again.",
    ].join("\n"));
  }
  say(`  conflicts in generated files only (${paths.join(", ")}) — taking upstream and recompiling`);
  if (DRY) return true;
  // Upstream's copy during a rebase is --ours. Whichever side is taken, the recompile below
  // regenerates every artifact from the MERGED sources, so the content is correct either way;
  // taking upstream just keeps the busters consistent until it runs.
  git(["checkout", "--ours", "--", ...paths]);
  const c = run("npm", ["run", "compile"]);
  if (c.code !== 0) { git(["rebase", "--abort"]); die(`STOPPED — npm run compile failed:\n${c.out}`); }
  // Belt and braces for the exact bug this script was written after: a file staged with the
  // markers still in it. compile.mjs rewrites portal.html's busters but has no reason to notice
  // a conflict hunk elsewhere in the file.
  for (const p of paths) {
    if (markersIn(p)) { git(["rebase", "--abort"]); die(`STOPPED — ${p} still has conflict markers after recompiling. Resolve it by hand.`); }
  }
  git(["add", "--", ...paths]);
  const cont = git(["-c", "core.editor=true", "rebase", "--continue"]);
  if (cont.code !== 0) { die(`STOPPED — rebase --continue failed:\n${cont.out}`); }
  return true;
}

// ── Preconditions ────────────────────────────────────────────────────────────────────────
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
if (branch !== BRANCH) die(`STOPPED — you are on "${branch}", not ${BRANCH}. This script only ships ${BRANCH}.`);

const dirty = git(["status", "--porcelain", "--untracked-files=no"]).out.trim();
if (dirty) {
  die([
    "STOPPED — there are uncommitted changes. Commit them first (the push ships commits,",
    "not your working tree), then run this again:",
    ...dirty.split("\n").map((l) => `  ${l}`),
  ].join("\n"));
}

// ── The loop ─────────────────────────────────────────────────────────────────────────────
say(`ship-beta: up to ${MAX} attempt(s)${DRY ? " (dry run)" : ""}\n`);

for (let n = 1; n <= MAX; n++) {
  say(`── attempt ${n} of ${MAX} ──`);

  say("  rebasing onto origin/beta…");
  if (!DRY) {
    const pull = git(["pull", "--rebase", "origin", BRANCH]);
    if (pull.code !== 0) {
      if (!conflictedPaths().length) die(`STOPPED — the rebase failed and nothing is conflicted:\n${pull.out}`);
      resolveGenerated();
    }
  }

  const ahead = git(["rev-list", "--count", `origin/${BRANCH}..HEAD`]).out.trim();
  if (ahead === "0") { say("\nNothing to push — your commits are already on beta."); process.exit(0); }
  say(`  ${ahead} commit(s) to push`);

  if (DRY) { say("\n(dry run — stopping before the push)"); process.exit(0); }

  say("  pushing (the pre-push gate runs the full suite — this takes minutes)…");
  const push = git(["push", "origin", BRANCH]);
  if (push.code === 0) {
    const head = git(["rev-parse", "--short", "HEAD"]).out.trim();
    say(`\n✅ PUSHED — ${head} is on origin/${BRANCH} after ${n} attempt(s).`);
    say("   Workers Builds deploys beta in 1–3 minutes. Verify the live ?v= hash before");
    say("   calling it done (CLAUDE.md: a push that did not go live is a FAILED BUILD).");
    process.exit(0);
  }

  // Two very different failures wear the same exit code.
  const raced = /cannot lock ref|non-fast-forward|fetch first|\[rejected\]|\[remote rejected\]/i.test(push.out);
  const gate = /preflight:|push refused|pre-push/i.test(push.out);
  if (gate && !raced) {
    die([
      "STOPPED — the pre-push gate refused this push. That is a real defect, not the race;",
      "fix it rather than reaching for --no-verify:",
      "",
      push.out.trim(),
    ].join("\n"));
  }
  say(`  attempt ${n} lost the race (the ref moved while the gate ran) — rebasing and trying again\n`);
}

die(`STOPPED — still not pushed after ${MAX} attempts. The branch is moving faster than the gate runs; try again when the other sessions are quieter.`);
