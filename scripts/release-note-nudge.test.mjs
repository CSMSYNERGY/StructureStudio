// node --test scripts/release-note-nudge.test.mjs   (preflight runs every scripts/*.test.mjs)
//
// The release-note nudge: which paths count as user-facing, what counts as a Release-note trailer
// (the same vectors _shared/releaseTrailer.test.ts pins for the parser), and the real CLI against a
// throwaway git repository: it names exactly the uncovered user-facing commits, an empty note commit
// covers what came before it, --github never prints a subject, and it always exits 0.
// Commit text below is made up. The repo is public.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findMissing, hasReleaseTrailer, isUserFacing, render } from "./release-note-nudge.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "release-note-nudge.mjs");
const CO = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

test("isUserFacing: what reaches a builder, and what does not", () => {
  for (const p of ["portal/04-orders.jsx", "portal.html", "index.html", "my-quotes.html", "StructureStudio.jsx",
    "structure-studio.component.js", "index.mount.jsx", "portal.app.compiled.js", "supabase/functions/portal-projects/index.ts",
    "supabase/functions/_shared/releaseTrailer.ts", "portal\\10-projects.jsx"]) {
    assert.equal(isUserFacing(p), true, p);
  }
  for (const p of ["admin.html", "admin.app.jsx", "admin.app.compiled.js", "tests/sql/migration293.test.cjs", "scripts/preflight.mjs",
    "supabase/migrations/293_pm_canonical_statuses.sql", "supabase/functions/_shared/_test_stubs/releaseCiWiring_test.ts",
    "supabase/functions/_shared/releaseTrailer.test.ts", "supabase/functions/release-ci/README.md", ".github/workflows/x.yml",
    "CLAUDE.md", "supabase/config.toml", "dev/harness.html"]) {
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
  assert.equal(hasReleaseTrailer("Subject\n\nRelease-note: fix: In the body, not the last block\n\n" + CO), false);
  assert.equal(hasReleaseTrailer("Subject\n\nRelease-note: fix: Mixed with prose is not a block\nsee above"), false);
  assert.equal(hasReleaseTrailer("Release-note: fix: A subject line is not a trailer"), false);
  assert.equal(hasReleaseTrailer("Subject\r\n\r\nRelease-note: fix: CRLF works the same way\r\n" + CO + "\r\n"), true);
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

test("render: local lines carry the subject and the remedy; --github carries only sha and areas", () => {
  const missing = [{ sha: "0123456789abcdef0123456789abcdef01234567", subject: "Fixed it for Some Builder", areas: ["portal/"] }];
  const local = render(missing).join("\n");
  assert.match(local, /0123456 {2}Fixed it for Some Builder/);
  assert.match(local, /git commit --allow-empty -m "Release note" --trailer "Release-note: fix: /);
  assert.match(local, /does not block the push/);
  const gh = render(missing, { github: true });
  assert.equal(gh.length, 1);
  assert.match(gh[0], /^::warning title=No release note::0123456 changes portal\/ but has no Release-note trailer/);
  assert.ok(!gh[0].includes("Some Builder"), "the public log must not carry the subject");
  assert.deepEqual(render([]), []);
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
