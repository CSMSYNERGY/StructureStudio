// node --test scripts/release-note-nudge.test.mjs   (preflight runs every scripts/*.test.mjs)
//
// The release-note nudge: which paths count as user-facing, what counts as a Release-note trailer
// (the same vectors _shared/releaseTrailer.test.ts pins for the parser), which notes release-ci
// would not read, and the real CLI against a throwaway git repository: it names exactly the
// uncovered user-facing commits and the unreadable notes, an empty note commit covers what came
// before it, --github never prints a subject, and it always exits 0. The real .githooks/commit-msg
// runs in a throwaway clone: it reminds at commit time (through `commit -a` too) and never blocks.
// Commit text below is made up. The repo is public.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitMsgReminder, findMissing, hasReleaseTrailer, isUserFacing, render, trailerProblem } from "./release-note-nudge.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "release-note-nudge.mjs");
const COMMIT_MSG_HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", ".githooks", "commit-msg");
const CO = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

test("isUserFacing: what reaches a builder, and what does not", () => {
  for (const p of ["portal/04-orders.jsx", "portal.html", "index.html", "my-quotes.html", "StructureStudio.jsx",
    "structure-studio.component.js", "index.mount.jsx", "portal.app.compiled.js", "supabase/functions/portal-projects/index.ts",
    "supabase/functions/_shared/releaseTrailer.ts", "portal\\10-projects.jsx", "workers/phone-api/src/routes/reads.ts",
    "workers/phone-api/src/index.ts"]) {
    assert.equal(isUserFacing(p), true, p);
  }
  for (const p of ["admin.html", "admin.app.jsx", "admin.app.compiled.js", "tests/sql/migration293.test.cjs", "scripts/preflight.mjs",
    "supabase/migrations/293_pm_canonical_statuses.sql", "supabase/functions/_shared/_test_stubs/releaseCiWiring_test.ts",
    "supabase/functions/_shared/releaseTrailer.test.ts", "supabase/functions/release-ci/README.md", ".github/workflows/x.yml",
    "CLAUDE.md", "supabase/config.toml", "dev/harness.html", "workers/phone-api/test/reads.test.ts",
    "workers/phone-api/src/routes/reads.test.ts", "workers/phone-api/wrangler.jsonc", "workers/phone-api/DEVIATIONS.md"]) {
    assert.equal(isUserFacing(p), false, p);
  }
});

test("hasReleaseTrailer: the last paragraph, every line a trailer, the subject never one", () => {
  const msg = (...t) => `Subject\n\nBody.\n\n${t.join("\n")}\n`;
  assert.equal(hasReleaseTrailer(msg("Release-note: fix: The door picker remembers your look", CO)), true);
  assert.equal(hasReleaseTrailer(msg("Release-note: none", CO)), true);
  assert.equal(hasReleaseTrailer(msg("release-NOTE: feature: Case does not matter for keys", CO)), true);
  assert.equal(hasReleaseTrailer(msg("Release-note: fix: wraps", "  onto two lines", CO)), true);
  assert.equal(hasReleaseTrailer(msg(CO)), false);
  assert.equal(hasReleaseTrailer(msg("Release-note:", CO)), false, "an empty value is not a note");
  // Its own paragraph above Co-Authored-By counts (15 of 35 notes, 09-22..10-12, were written so);
  // prose after it does not, and neither does the subject.
  assert.equal(hasReleaseTrailer("Subject\n\nBody.\n\nRelease-note: fix: Its own paragraph above the sign-off\n\n" + CO), true);
  assert.equal(hasReleaseTrailer("Subject\n\nRelease-note: fix: In the body, with prose after it\n\nMore prose.\n\n" + CO), false);
  assert.equal(hasReleaseTrailer("Release-note: fix: A subject is never a trailer\n\n" + CO), false);
  assert.equal(hasReleaseTrailer("Subject\n\nRelease-note: fix: Mixed with prose is not a block\nsee above"), false);
  assert.equal(hasReleaseTrailer("Release-note: fix: A subject line is not a trailer"), false);
  assert.equal(hasReleaseTrailer("Subject\r\n\r\nRelease-note: fix: CRLF works the same way\r\n" + CO + "\r\n"), true);
});

test("trailerProblem: what release-ci would refuse or never see, in a fixed sentence that never echoes the words", () => {
  const msg = (...t) => `Subject\n\nBody.\n\n${t.join("\n")}\n`;
  for (const ok of [msg("Release-note: fix: The door picker remembers your look", CO), msg("Release-note: none", CO), msg(CO),
    "Subject only", msg("Release-note:", CO), `Subject\n\nRelease-note: feature: ${"é".repeat(120)}\n\n${CO}`]) {
    assert.equal(trailerProblem(ok), null, ok);
  }
  assert.match(trailerProblem(msg("Release-note: improvement: Something nicer than before", CO)), /feature: <title>/);
  assert.match(trailerProblem(msg("Release-note: fix: Too short", CO)), /10-120 characters/);
  assert.match(trailerProblem(msg(`Release-note: fix: ${"x".repeat(121)}`, CO)), /10-120 characters/);
  assert.match(trailerProblem(msg("Release-note: fix: Try it on beta.structurestudio.app today", CO)), /web address/);
  assert.match(trailerProblem(msg("Release-note: fix: First note of the two here", "Release-note: none", CO)), /more than one/);
  assert.match(trailerProblem("Subject\n\nRelease-note: fix: Written in the body with prose after\n\nMore prose.\n\n" + CO), /not in the closing trailer block/);
  assert.match(trailerProblem("Subject\n\nRelease-note: fix: Mixed with prose is not a block\nsee above"), /not in the closing trailer block/);
  assert.equal(trailerProblem("Release-note: fix: Only ever in the subject line"), null, "a subject is not a misplaced note");
  assert.ok(!trailerProblem(msg("Release-note: fix: Some Builder's door picker", CO))?.includes("Some Builder"));
});

test("commitMsgReminder: user-facing staged files with no trailer are reminded; a usable trailer or no such file is quiet", () => {
  const body = "Subject\n\nWhy.\n\n" + CO + "\n";
  const said = commitMsgReminder({ message: body, files: ["portal/04-orders.jsx", "portal.app.compiled.js"] }).join("\n");
  assert.match(said, /changes what builders see \(portal\/, portal\.app\.compiled\.js\) but has no Release-note trailer/);
  assert.match(said, /git commit --amend --no-edit --trailer "Release-note: fix: /);
  assert.match(said, /does not block the commit/);
  assert.deepEqual(commitMsgReminder({ message: body, files: ["tests/x.test.mjs", "CLAUDE.md"] }), []);
  assert.deepEqual(commitMsgReminder({ message: body.replace(CO, `Release-note: none\n${CO}`), files: ["portal/a.jsx"] }), []);
  assert.deepEqual(commitMsgReminder({ message: body.replace(CO, `Release-note: fix: The portal page loads faster now\n${CO}`), files: ["portal/a.jsx"] }), []);
  // Git's own comment lines and a `commit -v` diff are not the message.
  const verbose = `Subject\n\n${CO}\n# Please enter the commit message\n# Release-note: fix: a comment is not a trailer\n`
    + "# ------------------------ >8 ------------------------\nRelease-note: fix: Inside the diff, not the message\n";
  assert.match(commitMsgReminder({ message: verbose, files: ["portal/a.jsx"] }).join("\n"), /no Release-note trailer/);
  // A note that will not be read is named whatever the files, with the way to fix it.
  const bad = commitMsgReminder({ message: body.replace(CO, `Release-note: fix: Too short\n${CO}`), files: ["CLAUDE.md"] }).join("\n");
  assert.match(bad, /will not reach the Support page: its Release-note title must be 10-120 characters/);
  assert.match(bad, /git commit --amend/);
});

// The pre-push hook runs this file with GIT_DIR, GIT_INDEX_FILE and friends pointing at the real
// repository, and git obeys them over cwd. Every throwaway repo (and the CLI run inside it)
// gets an environment with them removed, or "git add" answers "must be run in a work tree".
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

// ── The real thing, against a throwaway repository ─────────────────────────────────────────
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ssnudge-"));
  const g = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: CLEAN_ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g("init", "-q");
  for (const [k, v] of [["user.email", "nudge@example.invalid"], ["user.name", "nudge"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) g("config", k, v);
  const commit = (files, message) => {
    for (const f of files) { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), `${f} ${Math.random()}\n`); }
    if (files.length) g("add", "-A");
    g("commit", "-q", ...(files.length ? [] : ["--allow-empty"]), "-m", message);
    return g("rev-parse", "HEAD");
  };
  return { dir, g, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("findMissing names exactly the uncovered user-facing commits, oldest first", () => {
  const r = repo();
  try {
    const base = r.commit(["README.md"], "base");
    const a = r.commit(["portal/a.jsx"], "Portal change for Some Builder with no trailer");
    r.commit(["supabase/functions/x/index.ts"], `Function change\n\nWhy.\n\nRelease-note: fix: The function answers faster now\n${CO}`);
    r.commit(["tests/sql/t.test.cjs", "scripts/x.mjs"], "Tests and tooling only");
    r.commit(["supabase/functions/_shared/x.test.ts", "supabase/functions/_shared/_test_stubs/y_test.ts"], "Function tests only");
    r.commit(["portal/b.jsx"], `Internal portal change\n\nRelease-note: none\n${CO}`);
    const f = r.commit(["index.html", "supabase/functions/y/index.ts"], "Page and function, no trailer");
    const head = r.g("rev-parse", "HEAD");
    const missing = findMissing({ ranges: [`${base}..${head}`], cwd: r.dir, env: CLEAN_ENV });
    assert.deepEqual(missing.map((m) => m.sha), [a, f]);
    assert.deepEqual(missing[1].areas, ["index.html", "supabase/functions/"]);

    // An empty note commit covers everything before it in the push...
    r.commit([], `Release note\n\nRelease-note: fix: Pages and functions answer faster\n${CO}`);
    const head2 = r.g("rev-parse", "HEAD");
    assert.deepEqual(findMissing({ ranges: [`${base}..${head2}`], cwd: r.dir, env: CLEAN_ENV }), []);
    // ...but not what comes after it.
    const late = r.commit(["portal/c.jsx"], "A later portal change");
    assert.deepEqual(findMissing({ ranges: [`${base}..HEAD`], cwd: r.dir, env: CLEAN_ENV }).map((m) => m.sha), [late]);
    // --last N <rev>: the workflow's fallback when `before` is unusable.
    assert.deepEqual(findMissing({ ranges: ["HEAD"], last: 1, cwd: r.dir, env: CLEAN_ENV }).map((m) => m.sha), [late]);
    // Junk ranges are skipped, not run: nothing, and no throw.
    assert.deepEqual(findMissing({ ranges: ["--output=/tmp/x", "nope..alsonope"], cwd: r.dir, env: CLEAN_ENV }), []);
  } finally { r.done(); }
});

test("findMissing: a note in its own paragraph counts; a note release-ci cannot read is named whatever it touches", () => {
  const r = repo();
  try {
    const base = r.commit(["README.md"], "base");
    r.commit(["portal/a.jsx"], `Portal change\n\nWhy.\n\nRelease-note: fix: The orders page opens faster now\n\n${CO}`);
    const short = r.commit(["CLAUDE.md"], `Docs only, but a note was meant\n\nRelease-note: fix: Too short\n${CO}`);
    const prose = r.commit(["portal/b.jsx"], `Note in the body\n\nRelease-note: fix: Written with prose after it\n\nMore prose.\n\n${CO}`);
    // An empty commit whose note cannot be read covers nothing, and is named itself.
    const c = r.commit(["portal/c.jsx"], "Portal change, no trailer");
    const emptyBad = r.commit([], `Release note\n\nRelease-note: improvement: Not a kind release-ci knows\n${CO}`);
    const missing = findMissing({ ranges: [`${base}..HEAD`], cwd: r.dir, env: CLEAN_ENV });
    assert.deepEqual(missing.map((m) => m.sha), [short, prose, c, emptyBad]);
    assert.match(missing[0].problem, /10-120 characters/);
    assert.deepEqual(missing[0].areas, [], "a docs-only commit is still named when its note is unusable");
    assert.match(missing[1].problem, /not in the closing trailer block/);
    assert.equal(missing[2].problem, undefined);
    // A usable empty note commit covers the plain misses before it, never a broken note.
    r.commit([], `Release note\n\nRelease-note: fix: The portal pages answer faster now\n${CO}`);
    assert.deepEqual(findMissing({ ranges: [`${base}..HEAD`], cwd: r.dir, env: CLEAN_ENV }).map((m) => m.sha), [short, prose, emptyBad]);
  } finally { r.done(); }
});

test("render: local lines carry the subject and the remedy; --github carries only sha, areas and a fixed reason", () => {
  const missing = [{ sha: "0123456789abcdef0123456789abcdef01234567", subject: "Fixed it for Some Builder", areas: ["portal/"] }];
  const local = render(missing).join("\n");
  assert.match(local, /0123456 {2}Fixed it for Some Builder/);
  assert.match(local, /Support > New Features \/ Bug Fixes will not show them/);
  assert.match(local, /git commit --allow-empty -m "Release note" --trailer "Release-note: fix: /);
  assert.match(local, /does not block the push/);
  const gh = render(missing, { github: true });
  assert.equal(gh.length, 1);
  assert.match(gh[0], /^::warning title=No release note::0123456 changes portal\/ but has no Release-note trailer/);
  assert.ok(!gh[0].includes("Some Builder"), "the public log must not carry the subject");
  const broken = [{ sha: "89abcdef0123456789abcdef0123456789abcdef", subject: "Note for Some Builder", areas: [], problem: "it has more than one Release-note line" }];
  assert.match(render(broken).join("\n"), /89abcde {2}Note for Some Builder\n {11}\(it has more than one Release-note line\)/);
  const ghBroken = render(broken, { github: true });
  assert.deepEqual(ghBroken, ["::warning title=Release note not read::89abcde: it has more than one Release-note line."]);
  assert.deepEqual(render([]), []);
});

test("the commit-msg hook reminds at commit time, through `commit -a` too, and never blocks a commit", () => {
  const r = repo();
  try {
    // The real hook and the real script, wired like a clone: core.hooksPath .githooks.
    mkdirSync(join(r.dir, ".githooks"), { recursive: true });
    mkdirSync(join(r.dir, "scripts"), { recursive: true });
    copyFileSync(COMMIT_MSG_HOOK, join(r.dir, ".githooks", "commit-msg"));
    copyFileSync(SCRIPT, join(r.dir, "scripts", "release-note-nudge.mjs"));
    r.g("config", "core.hooksPath", ".githooks");
    r.g("add", "-A");
    r.g("commit", "-qm", `Tooling\n\nRelease-note: none\n${CO}`);
    const commitWith = (args) => spawnSync("git", ["commit", ...args], { cwd: r.dir, encoding: "utf8", env: CLEAN_ENV });
    const write = (f) => { mkdirSync(join(r.dir, dirname(f)), { recursive: true }); writeFileSync(join(r.dir, f), `${f} ${Math.random()}\n`); };

    write("portal/a.jsx");
    r.g("add", "-A");
    let out = commitWith(["-m", `Portal change\n\nWhy.\n\n${CO}`]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr, /release-note: this commit changes what builders see \(portal\/\) but has no Release-note trailer/);
    assert.equal(r.g("log", "-1", "--format=%s"), "Portal change", "the commit was made");

    // The remedy it prints works, and the amend is quiet.
    out = commitWith(["--amend", "--no-edit", "--trailer", "Release-note: fix: The portal change builders can now use"]);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!out.stderr.includes("release-note:"), out.stderr);
    assert.ok(hasReleaseTrailer(r.g("log", "-1", "--format=%B")));

    // `commit -a`: git hands the hook a temporary index, and the staged portal file is still seen.
    write("portal/a.jsx");
    out = commitWith(["-a", "-m", `Another portal change\n\n${CO}`]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr, /no Release-note trailer/);

    // Not user-facing: quiet.
    write("tests/t.test.mjs");
    r.g("add", "-A");
    out = commitWith(["-m", `Tests only\n\n${CO}`]);
    assert.equal(out.status, 0);
    assert.equal(out.stderr, "");

    // A script that crashes still lets the commit through.
    writeFileSync(join(r.dir, "scripts", "release-note-nudge.mjs"), 'console.error("nudge crashed on purpose"); process.exit(3);\n');
    write("portal/b.jsx");
    r.g("add", "-A");
    out = commitWith(["-m", `Portal change, crashing script\n\n${CO}`]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(r.g("log", "-1", "--format=%s"), "Portal change, crashing script");
  } finally { r.done(); }
});

test("the CLI always exits 0: with findings, with none, and with a range git cannot read", () => {
  const r = repo();
  try {
    const base = r.commit(["README.md"], "base");
    r.commit(["portal/a.jsx"], "No trailer here");
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: r.dir, encoding: "utf8", env: CLEAN_ENV });
    const found = run(`${base}..HEAD`);
    assert.equal(found.status, 0);
    assert.match(found.stderr, /release-note nudge: 1 commit\(s\) going to beta/);
    assert.equal(found.stdout, "");
    const gh = run("--github", `${base}..HEAD`);
    assert.equal(gh.status, 0);
    assert.match(gh.stdout, /^::warning title=No release note::/);
    assert.ok(!gh.stdout.includes("No trailer here"));
    // One argument holding several ranges (how the hook may pass them) is split.
    assert.equal(run(`${base}..HEAD ${base}..HEAD`).status, 0);
    const bad = run("deadbeef..cafebabe");
    assert.equal(bad.status, 0);
    assert.equal(bad.stderr, "");
    assert.equal(run().status, 0);
  } finally { r.done(); }
});
