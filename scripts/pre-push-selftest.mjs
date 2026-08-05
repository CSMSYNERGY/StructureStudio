// Self-test for the FRESHNESS half of .githooks/pre-push. Run it by hand:
//
//     npm run selftest:pre-push
//
// NOT part of the push gate — it builds real repositories and takes ~45s, far too slow to
// sit in front of every push. Same posture as `node scripts/preflight.mjs --self-test`: a
// thing you run when you touch the gate.
//
// WHY IT EXISTS. On 2026-08-04 the freshness check was found to have been INERT for this
// repo's most common push style. It probed the local branch name on origin:
//     git fetch --quiet origin "$(git rev-parse --abbrev-ref HEAD)"
// so `git push origin HEAD:beta` looked for a ref that does not exist on origin, fetch
// exited 128, and the hook printed "could not reach origin — skipping the freshness check"
// and passed. Nothing detected it because nothing ever asserted that the gate still bites.
//
// Ordinary stale pushes were never actually landing — git rejects those itself, and it only
// ever hands a pre-push hook the REJECT_FETCH_FIRST class of stale ref anyway. The real
// damage was FORCE pushes, which git does not guard at all: a stale
// `git push --force origin HEAD:beta` sailed straight through the inert check and destroyed
// commits a concurrent session had just pushed to beta. Part D reproduces exactly that.
//
// WHY THIS IS NODE AND NOT A SHELL SCRIPT. It was `pre-push-selftest.sh` for one commit.
// npm on Windows runs scripts through cmd.exe, where there is no `sh` on PATH (Git ships
// C:\Program Files\Git\bin\sh.exe but does not expose it), so `npm run selftest:pre-push`
// died instantly for anyone in PowerShell. The driver never needed a POSIX shell in the
// first place: every step is a git command, and git runs the hook under test with its own
// bundled shell whatever the caller is written in. Node also removes the CRLF fragility
// that a committed .sh carries on this autocrlf=true repo, and spawns git without a shell
// so paths containing spaces (this repo lives under "New folder") need no quoting.
//
// STRUCTURE
//   A  legitimate pushes must NOT be blocked      (a false refuse blocks every session)
//   B  stale pushes must not land
//   C  the printed remedy must clear the gate
//   D  DISCRIMINATION: the pre-2026-08-04 hook must FAIL this suite. Without D the suite
//      could pass while asserting nothing, which is precisely how the original bug
//      survived. D is the whole point.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No shell: argv is passed through verbatim, so spaces in paths are a non-issue.
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const git = (args, cwd) => run("git", args, cwd);

const top = git(["rev-parse", "--show-toplevel"]);
if (top.rc !== 0) {
  console.error("selftest: not inside a git repository");
  process.exit(1);
}
const ROOT = top.out.trim();
const HOOK = join(ROOT, ".githooks", "pre-push");
if (!existsSync(HOOK)) {
  console.error(`selftest: no hook at ${HOOK}`);
  process.exit(1);
}

const LAB = mkdtempSync(join(tmpdir(), "sspph-"));
// Windows/MAX_PATH: git writes <lab>/oN.git/objects/ab/<38 more chars>, so a deep temp dir
// makes pushes die with "Filename too long" / "unpacker error" rather than anything that
// reads as a test failure. Hit for real while developing this, from a ~180-char base.
// core.longpaths is also set on every repo below; this check stays because longpaths needs
// opt-in support and this message is far clearer than git's.
if (process.platform === "win32" && LAB.length > 180) {
  console.error(`selftest: temp dir is too deep for git on Windows (${LAB.length} chars):`);
  console.error(`  ${LAB}`);
  console.error("  Re-run with a shorter one, e.g.  set TMP=C:\\tmp && npm run selftest:pre-push");
  rmSync(LAB, { recursive: true, force: true });
  process.exit(1);
}

let pass = 0;
let fail = 0;
let seq = 0;

const ok = (label) => { pass += 1; console.log(`  ok    ${label}`); };
const bad = (label, out) => {
  fail += 1;
  console.log(`  FAIL  ${label}`);
  if (out) console.log(out.trim().split("\n").slice(0, 5).map((l) => `          | ${l}`).join("\n"));
};

// The freshness check as it stood before 2026-08-04, kept verbatim as a fixture so part D
// exercises the real historical bug rather than a paraphrase of it. Do not "fix" this.
const OLD_HOOK_BODY = `#!/bin/sh
cd "$(git rev-parse --show-toplevel)" || exit 1
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "HEAD" ]; then
  if git fetch --quiet origin "$branch" 2>/dev/null; then
    behind=$(git rev-list --count "HEAD..FETCH_HEAD" 2>/dev/null || echo 0)
    if [ "\${behind:-0}" -gt 0 ]; then
      echo "pre-push: refused — origin/$branch has $behind commit(s) you do not have." >&2
      exit 1
    fi
  else
    echo "pre-push: could not reach origin — skipping the freshness check." >&2
  fi
fi
exit 0
`;
const OLD_HOOK = join(LAB, "old-pre-push");
writeFileSync(OLD_HOOK, OLD_HOOK_BODY);
chmodSync(OLD_HOOK, 0o755);

// Fresh bare origin + a clone wired like a real checkout: the RELATIVE core.hooksPath from
// the runbook, so the clone runs its own copy of the hook.
function setup(hookPath) {
  seq += 1;
  const W = join(LAB, `w${seq}`);
  const O = join(LAB, `o${seq}.git`);
  git(["init", "-q", "--bare", O]);
  git(["-c", "core.longpaths=true", "clone", "-q", O, W]);
  for (const [k, v] of [
    ["user.email", "selftest@example.invalid"],
    ["user.name", "selftest"],
    ["core.autocrlf", "false"],
    ["core.longpaths", "true"],
    ["core.hooksPath", ".githooks"],
  ]) git(["config", k, v], W);
  mkdirSync(join(W, ".githooks"), { recursive: true });
  mkdirSync(join(W, "scripts"), { recursive: true });
  mkdirSync(join(W, "node_modules", "eslint"), { recursive: true });
  copyFileSync(hookPath, join(W, ".githooks", "pre-push"));
  chmodSync(join(W, ".githooks", "pre-push"), 0o755);
  // Section 2 stands in as a no-op so every verdict is attributable to freshness alone.
  writeFileSync(join(W, "scripts", "preflight.mjs"), "process.exit(0)\n");
  writeFileSync(join(W, "f.txt"), "one\n");
  git(["add", "-A"], W);
  git(["commit", "-qm", "one"], W);
  git(["branch", "-M", "beta"], W);
  git(["push", "-q", "-u", "origin", "beta"], W);
  return { W, O };
}

// A concurrent session lands n commits on origin/beta. Touches its own file so the rebase
// in part C is conflict-free (otherwise C would fail for the wrong reason).
function advance(ctx, n) {
  const OTHER = join(LAB, `other${seq}`);
  git(["-c", "core.longpaths=true", "clone", "-q", ctx.O, OTHER]);
  git(["config", "user.email", "other@example.invalid"], OTHER);
  git(["config", "user.name", "other"], OTHER);
  git(["config", "core.autocrlf", "false"], OTHER);
  git(["checkout", "-q", "-B", "beta", "origin/beta"], OTHER);
  for (let i = 1; i <= n; i += 1) {
    writeFileSync(join(OTHER, "other.txt"), `other ${i}\n`.repeat(i));
    git(["add", "-A"], OTHER);
    git(["commit", "-qm", `other ${i}`], OTHER);
  }
  git(["push", "-q", "origin", "beta"], OTHER);
  return ctx;
}

function mine(ctx) {
  writeFileSync(join(ctx.W, "mine.txt"), `mine ${seq}\n`);
  git(["add", "-A"], ctx.W);
  git(["commit", "-qm", "mine"], ctx.W);
  return ctx;
}

const originTip = (ctx) => git(["--git-dir=" + ctx.O, "rev-parse", "beta"]).out.trim();

// expect: "PASS" push succeeds | "REFUSE" our hook refuses (message asserted, not just the
// exit code) | "BLOCKED" push does not land, by the hook or by git's own non-ff check.
function check(label, expect, ctx, ...pushArgs) {
  const { rc, out } = git(["push", ...pushArgs], ctx.W);
  const refused = out.includes("pre-push: refused");
  if (expect === "PASS") rc === 0 ? ok(label) : bad(label, out);
  else if (expect === "REFUSE") (refused && rc !== 0) ? ok(label) : bad(label, out);
  else (rc !== 0) ? ok(label) : bad(label, out);
  // The old hook's tell. It must never reappear: it names a failure that cannot happen
  // here, since an unreachable origin aborts the push at ref discovery, before any hook.
  if (out.includes("could not reach origin")) {
    fail += 1;
    console.log('        !! printed "could not reach origin" — the old false alarm');
  }
}

try {
  console.log("A. legitimate pushes are not blocked");
  check("up-to-date, git push origin beta", "PASS", mine(setup(HOOK)), "origin", "beta");
  let c = mine(setup(HOOK));
  git(["checkout", "-q", "-b", "topic/x"], c.W);
  check("up-to-date, HEAD:beta from a topic branch", "PASS", c, "origin", "HEAD:beta");
  c = mine(setup(HOOK));
  git(["checkout", "-q", "--detach"], c.W);
  check("up-to-date, HEAD:beta from a detached HEAD", "PASS", c, "origin", "HEAD:beta");
  check("brand-new branch, absent on origin", "PASS", setup(HOOK), "origin", "HEAD:refs/heads/brand-new");
  c = setup(HOOK);
  git(["push", "-q", "origin", "HEAD:refs/heads/doomed"], c.W);
  check("deleting a remote ref", "PASS", c, "origin", ":refs/heads/doomed");
  c = setup(HOOK);
  git(["tag", "-a", "v9", "-m", "t"], c.W);
  check("pushing a tag", "PASS", c, "origin", "v9");
  c = mine(setup(HOOK));
  git(["branch", "-q", "side"], c.W);
  check("multi-ref push, all current", "PASS", c, "origin", "beta", "side");

  console.log("B. stale pushes do not land");
  check("stale, remote tip object absent locally", "REFUSE", mine(advance(setup(HOOK), 8)), "origin", "beta");
  c = mine(advance(setup(HOOK), 5));
  git(["checkout", "-q", "-b", "topic/y"], c.W);
  check("stale via HEAD:beta (the 2026-08-04 bug)", "REFUSE", c, "origin", "HEAD:beta");
  c = mine(advance(setup(HOOK), 5));
  git(["checkout", "-q", "--detach"], c.W);
  check("stale via HEAD:beta, detached HEAD", "REFUSE", c, "origin", "HEAD:beta");
  c = mine(advance(setup(HOOK), 2));
  git(["branch", "-q", "side"], c.W);
  check("multi-ref push, one ref stale", "REFUSE", c, "origin", "beta", "side");
  c = mine(advance(setup(HOOK), 3));
  git(["fetch", "-q", "origin", "beta"], c.W);
  check("stale, remote tip present (git's own check)", "BLOCKED", c, "origin", "beta");
  // Objects present AND --force is the only combination git passes through to the hook, so
  // this is what exercises counting from the local object database with no fetch.
  c = mine(advance(setup(HOOK), 3));
  git(["fetch", "-q", "origin", "beta"], c.W);
  check("stale + fetched + --force", "REFUSE", c, "--force", "origin", "beta");

  console.log("C. the printed remedy clears the gate");
  c = mine(advance(setup(HOOK), 4));
  git(["pull", "-q", "--rebase", "origin", "beta"], c.W);
  check("after git pull --rebase origin beta", "PASS", c, "origin", "beta");

  console.log("D. the pre-2026-08-04 hook still fails this suite");
  // D1 — the old hook waves a stale HEAD:beta through, blaming the network.
  c = mine(advance(setup(OLD_HOOK), 3));
  git(["checkout", "-q", "-b", "topic/z"], c.W);
  let out = git(["push", "origin", "HEAD:beta"], c.W).out;
  out.includes("could not reach origin")
    ? ok("old hook still reproduces the false 'could not reach origin'")
    : bad("old hook no longer prints the false network warning — fixture has drifted", out);
  out.includes("pre-push: refused")
    ? bad("old hook unexpectedly refused — fixture no longer reproduces the bug", out)
    : ok("old hook does not refuse a stale HEAD:beta (the inert gate)");

  // D2 — the consequence: with the gate inert, a forced push destroys the other session's
  // commits. This is the assertion that matters most in the file.
  c = mine(advance(setup(OLD_HOOK), 3));
  git(["checkout", "-q", "-b", "topic/w"], c.W);
  let before = originTip(c);
  git(["push", "--force", "origin", "HEAD:beta"], c.W);
  let after = originTip(c);
  const clobbered = before !== after &&
    git(["--git-dir=" + c.O, "merge-base", "--is-ancestor", before, after]).rc !== 0;
  clobbered
    ? ok("old hook lets --force clobber the concurrent session's commits")
    : bad("old hook no longer clobbers on --force — fixture has drifted", "");

  // D3 — the current hook must refuse that same push and leave origin untouched.
  c = mine(advance(setup(HOOK), 3));
  git(["checkout", "-q", "-b", "topic/v"], c.W);
  before = originTip(c);
  git(["push", "--force", "origin", "HEAD:beta"], c.W);
  after = originTip(c);
  before === after
    ? ok("current hook refuses it and preserves those commits")
    : bad("current hook allowed a stale --force to rewrite origin/beta", "");
} finally {
  rmSync(LAB, { recursive: true, force: true });
}

console.log("");
console.log("-----------------------------------------------");
console.log(`pre-push self-test: ${pass} passed, ${fail} failed`);
if (fail !== 0) {
  console.error("The freshness gate is not behaving as documented in .githooks/pre-push.");
  process.exit(1);
}
console.log("freshness gate verified");
