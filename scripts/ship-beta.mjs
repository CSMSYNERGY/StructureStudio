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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRANCH = "beta";

// The files `npm run compile` OWNS outright. A conflict in one of these is not a disagreement about
// anything a person wrote — both sides are machine output from sources that git has already
// merged, so the fix is always "take either side, then recompile".
const GENERATED = new Set([
  "portal.app.compiled.js",
  "structure-studio.component.compiled.js",
  "index.mount.compiled.js",
  "admin.app.compiled.js",
]);

// portal.html is NOT one of those, even though it conflicts on nearly every rebase. compile.mjs
// rewrites only its ?v= cache-busters; the rest of the file is hand-written, the portal's CSS among
// it. A hand-written conflict here is just more hunks in the same conflicted file, and a commit's
// clean hand-written changes sit outside the hunks altogether, so `git checkout --ours` throws them
// all away with upstream's whole file. Reproduced 2026-11-02 in a private repo: a commit's 19 CSS
// lines became 0 and the push still landed. So this file is settled one hunk at a time, see
// settlePortalHunks.
const PORTAL = "portal.html";

// Everything the compile can write, compile.mjs's PAGES included. It rewrites a page's busters
// whether or not that page conflicted, and `rebase --continue` refuses to run over unstaged changes.
const COMPILE_WRITES = new Set([...GENERATED, PORTAL, "index.html", "admin.html"]);

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

/** Abort the rebase, and say how that went for the STOPPED message. */
function abortRebase() {
  const a = git(["rebase", "--abort"]);
  return a.code === 0
    ? "The rebase was aborted, so your branch is exactly as it was."
    : `\`git rebase --abort\` failed too, so the rebase is still in progress:\n${a.out.trim()}`;
}

// A hunk's text with the hash taken out of every compiled tag: the same tags compile.mjs's
// rebuster() rewrites, and no others. A ?v= on anything else is hand-written, so it has to match.
const sansBusters = (text) => text.replace(/(src="\/?[a-zA-Z0-9.-]+\.compiled\.js\?v=)[a-zA-Z0-9]*"/g, '$1"');

/**
 * Settle portal.html's conflict hunks in the working tree, keeping everything git merged on its own.
 * A hunk whose two sides differ only in ?v= hashes takes upstream's side; the recompile rewrites the
 * hashes either way. Returns one description per hunk it refused, and writes nothing if there are any.
 */
function settlePortalHunks() {
  // Rebuilt from the index, so the hunks below have the plain two-sided shape whatever
  // merge.conflictStyle or rerere did to the file.
  const rebuilt = git(["checkout", "--conflict=merge", "--", PORTAL]);
  if (rebuilt.code !== 0) return [`git could not rebuild the conflict: ${rebuilt.out.trim()}`];
  const file = join(root, PORTAL);
  const refused = [];
  let hunks = 0;
  const settled = readFileSync(file, "utf8").replace(
    /^<{7} [^\n]*\n([\s\S]*?)^={7}\r?\n([\s\S]*?)^>{7} [^\n]*(?:\n|$)/gm,
    (hunk, upstream, commit) => {
      hunks++;
      if (sansBusters(upstream) === sansBusters(commit)) return upstream;
      const firstLine = (side) => side.split("\n")[0].trim().slice(0, 100);
      refused.push(`upstream has "${firstLine(upstream)}", your commit has "${firstLine(commit)}"`);
      return hunk;
    },
  );
  if (!hunks) refused.push("git says it conflicts, but this script can read no conflict hunks in it");
  if (!refused.length) writeFileSync(file, settled);
  return refused;
}

/**
 * See a stopped rebase through to the end, resolving each commit that conflicts only in what the
 * compile owns. Anything else aborts the whole rebase and stops. Every round leaves nothing unmerged
 * before `rebase --continue`, so each one moves on to a later commit and the loop has to end.
 */
function finishRebase() {
  for (;;) {
    const paths = conflictedPaths();
    const source = paths.filter((p) => !GENERATED.has(p) && p !== PORTAL);
    if (source.length) {
      die([
        "STOPPED — a SOURCE file conflicts, and this script will not guess at that:",
        ...source.map((p) => `  ${p}`),
        "",
        abortRebase(),
        "Resolve it by hand, run `npm run compile`, then `npm run ship` again.",
      ].join("\n"));
    }
    if (paths.includes(PORTAL)) {
      const refused = settlePortalHunks();
      if (refused.length) {
        die([
          `STOPPED — ${PORTAL} has a hand-written conflict, and this script will not guess at that:`,
          ...refused.map((r) => `  ${r}`),
          "",
          abortRebase(),
          "Resolve it by hand, run `npm run compile`, then `npm run ship` again.",
        ].join("\n"));
      }
    }
    say(`  conflicts in generated files and ?v= lines only (${paths.join(", ")}) — recompiling`);
    // Upstream's copy during a rebase is --ours. Whichever side is taken, the recompile below
    // regenerates every artifact from the MERGED sources, so the content is correct either way;
    // taking upstream just keeps the busters consistent until it runs.
    const artifacts = paths.filter((p) => GENERATED.has(p));
    if (artifacts.length) git(["checkout", "--ours", "--", ...artifacts]);
    const c = run("npm", ["run", "compile"]);
    if (c.code !== 0) die(`STOPPED — npm run compile failed:\n${c.out}\n\n${abortRebase()}`);
    // Belt and braces for the exact bug this script was written after: a file staged with the
    // markers still in it. compile.mjs rewrites portal.html's busters but has no reason to notice
    // a conflict hunk elsewhere in the file.
    for (const p of paths) {
      if (markersIn(p)) die(`STOPPED — ${p} still has conflict markers after recompiling.\n\n${abortRebase()}\nResolve it by hand.`);
    }
    const written = git(["diff", "--name-only"]).out.split("\n").filter((p) => COMPILE_WRITES.has(p));
    const add = git(["add", "--", ...new Set([...paths, ...written])]);
    if (add.code !== 0 || conflictedPaths().length) die(`STOPPED — could not stage the recompile:\n${add.out}\n\n${abortRebase()}`);
    const cont = git(["-c", "core.editor=true", "rebase", "--continue"]);
    if (cont.code === 0) return;
    if (!conflictedPaths().length) die(`STOPPED — rebase --continue failed:\n${cont.out}\n\n${abortRebase()}`);
  }
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
      finishRebase();
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
