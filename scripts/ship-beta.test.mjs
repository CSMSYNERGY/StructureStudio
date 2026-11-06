// node --test scripts/ship-beta.test.mjs   (preflight runs every scripts/*.test.mjs)
//
// The real scripts/ship-beta.mjs, the real three pages and the real .gitattributes, against a private
// bare "origin" in a temp folder. Another session has always pushed a recompile first, so portal.html's
// ?v= lines conflict every time. The compile is a stub that does what the real one does to the files
// this script cares about: one artifact per source, each a single line so two recompiles always
// conflict, and every page's busters rewritten with the real pattern.
//
// WHY (2026-11-02). portal.html sat in the script's "take upstream's whole file" set, so a commit's
// hand-written CSS vanished on the ordinary ?v= conflict and the push still landed. A second commit
// that also compiled then stopped the script mid-rebase. Both are pinned here, along with the other
// half of the bargain: a real conflict stops, aborts, and pushes nothing. index.html and admin.html
// have the same shape, and their ?v= lines used to stop the script as a false "source conflict", so
// they are pinned to the same rules. Fixture text is made up. The repo is public.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["index.html", "portal.html", "admin.html"];
const TARGETS = {
  "portal.app.compiled.js": "portal/03-catalog.jsx",
  "structure-studio.component.compiled.js": "structure-studio.component.js",
  "index.mount.compiled.js": "index.mount.jsx",
  "admin.app.compiled.js": "admin.app.jsx",
};
const SOURCE = "line one\nline two\nline three\nline four\nline five\n";

const STUB_COMPILE = `
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const TARGETS = ${JSON.stringify(TARGETS)};
const hashes = {};
for (const [out, src] of Object.entries(TARGETS)) {
  const art = "bundle of " + readFileSync(src, "utf8").trim().split("\\n").join(" ; ") + "\\n";
  writeFileSync(out, art);
  hashes[out] = createHash("sha256").update(art).digest("hex").slice(0, 8);
}
for (const p of ${JSON.stringify(PAGES)}) {
  const html = readFileSync(p, "utf8");
  const next = html.replace(/(src="\\/?([a-zA-Z0-9.-]+\\.compiled\\.js))\\?v=[a-zA-Z0-9]*"/g,
    (m, pre, file) => (hashes[file] ? pre + "?v=" + hashes[file] + '"' : m));
  if (next !== html) writeFileSync(p, next);
}
`;

// The pre-push hook runs this file with GIT_DIR, GIT_INDEX_FILE and friends pointing at the real
// repository, and git obeys those over cwd. Without this the fixture's git would write to the real
// .git/config. The config file keeps the machine's own settings out, and mirrors autocrlf on Windows.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "ssship-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  writeFileSync(join(dir, "gitconfig"), "[user]\n\temail = ship@example.invalid\n\tname = ship\n[core]\n\tautocrlf = true\n[commit]\n\tgpgsign = false\n");
  const env = { ...CLEAN_ENV, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const origin = join(dir, "origin.git");
  const other = join(dir, "other");
  const mine = join(dir, "mine");

  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const path = (cwd, p) => join(cwd, p);
  const read = (cwd, p) => readFileSync(path(cwd, p), "utf8");
  const write = (cwd, p, text) => {
    mkdirSync(dirname(path(cwd, p)), { recursive: true });
    writeFileSync(path(cwd, p), text);
  };
  // Both ends of the portal's first <style> block, far enough apart to merge cleanly.
  const cssAtEnd = (cwd, ...rules) => write(cwd, "portal.html", read(cwd, "portal.html").replace("</style>", () => `${rules.join("\n")}\n</style>`));
  const cssAtStart = (cwd, ...rules) => write(cwd, "portal.html", read(cwd, "portal.html").replace("<style>", () => `<style>\n${rules.join("\n")}`));
  const sourceFirst = (cwd, line, src = TARGETS["portal.app.compiled.js"]) => write(cwd, src, `${line}\n${read(cwd, src)}`);
  const sourceLast = (cwd, line, src = TARGETS["portal.app.compiled.js"]) => write(cwd, src, `${read(cwd, src)}${line}\n`);
  const compile = (cwd) => {
    const r = spawnSync(process.execPath, ["scripts/compile.mjs"], { cwd, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`compile: ${r.stderr}`);
  };
  const commit = (cwd, message, { compiled = true } = {}) => {
    if (compiled) compile(cwd);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };

  git(dir, "init", "-q", "--bare", "-b", "beta", origin);
  git(dir, "init", "-q", "-b", "beta", other);
  git(other, "remote", "add", "origin", origin);
  for (const p of [...PAGES, ".gitattributes"]) copyFileSync(join(ROOT, p), path(other, p));
  write(other, "scripts/compile.mjs", STUB_COMPILE);
  copyFileSync(join(ROOT, "scripts", "ship-beta.mjs"), path(other, "scripts/ship-beta.mjs"));
  write(other, "package.json", `${JSON.stringify({ name: "ship-fixture", private: true, type: "module", scripts: { compile: "node scripts/compile.mjs" } })}\n`);
  for (const src of Object.values(TARGETS)) write(other, src, SOURCE);
  commit(other, "base");
  git(other, "push", "-q", "origin", "beta");
  git(dir, "clone", "-q", "-b", "beta", origin, mine);

  /** Another session lands a recompile, with a rule of its own at the far end of the same <style>. */
  const anotherSessionPushes = () => {
    sourceFirst(other, "another session's change");
    cssAtStart(other, ".upstream-rule { color: red; }");
    commit(other, "another session: unrelated work");
    git(other, "push", "-q", "origin", "beta");
  };
  const ship = () => spawnSync(process.execPath, ["scripts/ship-beta.mjs"], { cwd: mine, encoding: "utf8", env });
  const shown = (ref, p) => git(mine, "show", `${ref}:${p}`);
  const onOrigin = (p) => git(origin, "show", `beta:${p}`);
  const originTip = () => git(origin, "rev-parse", "beta");
  const inRebase = () => existsSync(path(mine, ".git/rebase-merge"));
  /** Every artifact at `ref` carries the buster its bytes hash to, on every page that has a tag for it. */
  const assertBustersMatch = (ref) => {
    for (const art of Object.keys(TARGETS)) {
      const want = createHash("sha256").update(`${shown(ref, art)}\n`).digest("hex").slice(0, 8);
      for (const page of PAGES) {
        for (const m of shown(ref, page).matchAll(/src="\/?([a-zA-Z0-9.-]+\.compiled\.js)\?v=([a-zA-Z0-9]*)"/g)) {
          if (m[1] === art) assert.equal(m[2], want, `${ref} ${page} ${art}`);
        }
      }
    }
  };
  /** The promise of every stop: exit 1, the branch exactly as it was, nothing on origin. */
  const assertStopped = (r, before, wants) => {
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /STOPPED/);
    assert.match(r.stdout, wants);
    assert.match(r.stdout, /The rebase was aborted/);
    assert.doesNotMatch(r.stdout, /PUSHED/);
    assert.equal(inRebase(), false, "the rebase is still in progress");
    assert.equal(git(mine, "rev-parse", "HEAD"), before.head);
    assert.equal(git(mine, "status", "--porcelain", "--untracked-files=no"), "");
    assert.equal(read(mine, "portal.html"), before.portal);
    assert.equal(originTip(), before.origin, "something reached origin");
  };
  const snapshot = () => ({ head: git(mine, "rev-parse", "HEAD"), portal: read(mine, "portal.html"), origin: originTip() });

  return { other, mine, git, read, write, cssAtEnd, sourceFirst, sourceLast, compile, commit, anotherSessionPushes, ship, shown, onOrigin, originTip, inRebase, assertBustersMatch, assertStopped, snapshot };
}

const SLOT_RULES = Array.from({ length: 19 }, (_, i) => `.ss-test-slot-${i} { width: ${i}px; }`);
const count = (text, needle) => text.split(needle).length - 1;

test("one commit: its CSS survives the ?v= conflict, upstream's does too, and the busters are recomputed", (t) => {
  const f = setup(t);
  f.cssAtEnd(f.mine, ...SLOT_RULES);
  f.sourceLast(f.mine, "my change");
  f.commit(f.mine, "my commit");
  f.anotherSessionPushes();

  const r = f.ship();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /PUSHED/);
  assert.match(r.stdout, /only \(.*portal\.html.*\) — recompiling/, "the conflict this test exists for never happened");

  const page = f.shown("origin/beta", "portal.html");
  assert.equal(count(page, ".ss-test-slot-"), 19);
  assert.equal(count(page, ".upstream-rule"), 1);
  assert.equal(count(page, "<<<<<<<"), 0);
  const source = f.shown("origin/beta", "portal/03-catalog.jsx");
  assert.ok(source.includes("my change") && source.includes("another session's change"));
  f.assertBustersMatch("origin/beta");
});

test("two commits that both compile ship without stopping, and each one is whole", (t) => {
  const f = setup(t);
  f.cssAtEnd(f.mine, ...SLOT_RULES);
  f.sourceLast(f.mine, "first change");
  f.commit(f.mine, "commit 1");
  f.sourceLast(f.mine, "second change");
  f.commit(f.mine, "commit 2");
  f.anotherSessionPushes();

  const r = f.ship();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /PUSHED/);
  assert.equal(count(r.stdout, "— recompiling"), 2, "both commits should have conflicted");
  assert.equal(f.inRebase(), false);
  assert.equal(f.git(f.mine, "log", "-2", "--format=%s", "origin/beta"), "commit 2\ncommit 1");
  for (const ref of ["origin/beta", "origin/beta~1"]) {
    assert.equal(count(f.shown(ref, "portal.html"), ".ss-test-slot-"), 19, ref);
    f.assertBustersMatch(ref);
  }
  assert.ok(f.shown("origin/beta", "portal/03-catalog.jsx").includes("second change"));
  assert.ok(!f.shown("origin/beta~1", "portal/03-catalog.jsx").includes("second change"));
});

test("a real CSS conflict stops, aborts, and pushes nothing", (t) => {
  const f = setup(t);
  f.cssAtEnd(f.mine, ".mine-rule { color: blue; }");
  f.commit(f.mine, "my commit");
  f.cssAtEnd(f.other, ".their-rule { color: green; }");
  f.sourceFirst(f.other, "another session's change");
  f.commit(f.other, "another session: same spot");
  f.git(f.other, "push", "-q", "origin", "beta");

  const before = f.snapshot();
  f.assertStopped(f.ship(), before, /a page has a hand-written conflict[\s\S]*portal\.html: [\s\S]*\.their-rule[\s\S]*\.mine-rule/);
});

test("a hand edit inside the ?v= hunk is a real conflict, not a difference in hashes", (t) => {
  const f = setup(t);
  f.write(f.mine, "portal.html", f.read(f.mine, "portal.html").replace('<script defer src="/portal.app.compiled.js', '<script defer data-mine="1" src="/portal.app.compiled.js'));
  f.sourceLast(f.mine, "my change");
  f.commit(f.mine, "my commit");
  f.anotherSessionPushes();

  const before = f.snapshot();
  assert.ok(before.portal.includes('data-mine="1"'), "the fixture's edit missed the real tag");
  f.assertStopped(f.ship(), before, /a page has a hand-written conflict[\s\S]*portal\.html: /);
});

test("a real conflict in the second commit aborts the whole rebase, the first commit included", (t) => {
  const f = setup(t);
  f.sourceLast(f.mine, "first change");
  f.commit(f.mine, "commit 1");
  f.cssAtEnd(f.mine, ".mine-rule { color: blue; }");
  f.sourceLast(f.mine, "second change");
  f.commit(f.mine, "commit 2");
  f.cssAtEnd(f.other, ".their-rule { color: green; }");
  f.sourceFirst(f.other, "another session's change");
  f.commit(f.other, "another session: same spot");
  f.git(f.other, "push", "-q", "origin", "beta");

  const before = f.snapshot();
  const r = f.ship();
  assert.equal(count(r.stdout, "— recompiling"), 1, "the first commit should have been resolved first");
  f.assertStopped(r, before, /a page has a hand-written conflict[\s\S]*portal\.html: /);
  assert.equal(f.git(f.mine, "log", "-2", "--format=%s"), "commit 2\ncommit 1");
});

// The artifact whose tag each page carries, so both sides recompiling makes that page's ?v= conflict.
for (const [page, artifact] of [["index.html", "structure-studio.component.compiled.js"], ["admin.html", "admin.app.compiled.js"]]) {
  const src = TARGETS[artifact];

  test(`${page}: its ?v= conflict resolves, and both sides' hand-written changes survive`, (t) => {
    const f = setup(t);
    f.write(f.mine, page, f.read(f.mine, page).replace("</body>", () => "<!-- my note -->\n</body>"));
    f.sourceLast(f.mine, "my change", src);
    f.commit(f.mine, "my commit");
    f.write(f.other, page, f.read(f.other, page).replace("<head>", () => "<head><!-- their note -->"));
    f.sourceFirst(f.other, "another session's change", src);
    f.commit(f.other, "another session: recompile");
    f.git(f.other, "push", "-q", "origin", "beta");

    const r = f.ship();
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /PUSHED/);
    assert.ok(new RegExp(`only \\(.*${page.replace(".", "\\.")}.*\\) — recompiling`).test(r.stdout), `${page} never conflicted:\n${r.stdout}`);

    const html = f.onOrigin(page);
    assert.equal(count(html, "<!-- my note -->"), 1);
    assert.equal(count(html, "<!-- their note -->"), 1);
    assert.equal(count(html, "<<<<<<<"), 0);
    const source = f.onOrigin(src);
    assert.ok(source.includes("my change") && source.includes("another session's change"));
    f.assertBustersMatch("origin/beta");
  });

  test(`${page}: a real conflict stops, named, and pushes nothing`, (t) => {
    const f = setup(t);
    f.write(f.mine, page, f.read(f.mine, page).replace("</body>", () => "<!-- my note -->\n</body>"));
    f.sourceLast(f.mine, "my change", src);
    f.commit(f.mine, "my commit");
    f.write(f.other, page, f.read(f.other, page).replace("</body>", () => "<!-- their note -->\n</body>"));
    f.sourceFirst(f.other, "another session's change", src);
    f.commit(f.other, "another session: same spot");
    f.git(f.other, "push", "-q", "origin", "beta");

    const before = f.snapshot();
    f.assertStopped(f.ship(), before, new RegExp(`a page has a hand-written conflict[\\s\\S]*${page.replace(".", "\\.")}: `));
  });
}

test("a conflicted source file still stops, named as one", (t) => {
  const f = setup(t);
  f.write(f.mine, "portal/03-catalog.jsx", SOURCE.replace("line one", "my line one"));
  f.commit(f.mine, "my commit");
  f.write(f.other, "portal/03-catalog.jsx", SOURCE.replace("line one", "their line one"));
  f.commit(f.other, "another session: same line");
  f.git(f.other, "push", "-q", "origin", "beta");

  const before = f.snapshot();
  f.assertStopped(f.ship(), before, /a SOURCE file conflicts[\s\S]*portal\/03-catalog\.jsx/);
});

test("merge.conflictStyle does not change the answer", (t) => {
  const f = setup(t);
  f.git(f.mine, "config", "merge.conflictStyle", "diff3");
  f.cssAtEnd(f.mine, ...SLOT_RULES);
  f.sourceLast(f.mine, "my change");
  f.commit(f.mine, "my commit");
  f.anotherSessionPushes();

  const r = f.ship();
  assert.equal(r.status, 0, r.stdout);
  const page = f.shown("origin/beta", "portal.html");
  assert.equal(count(page, ".ss-test-slot-"), 19);
  assert.equal(count(page, "|||||||"), 0);
  f.assertBustersMatch("origin/beta");
});

test("a page the compile rewrites without it having conflicted is staged, so the rebase can go on", (t) => {
  const f = setup(t);
  f.sourceLast(f.mine, "my change");
  f.commit(f.mine, "my commit");
  f.sourceFirst(f.other, "another session's change");
  f.compile(f.other);
  f.write(f.other, "index.html", f.read(f.other, "index.html").replace(/(index\.mount\.compiled\.js\?v=)[a-zA-Z0-9]*/, "$1deadbeef"));
  f.commit(f.other, "another session: left a stale buster", { compiled: false });
  f.git(f.other, "push", "-q", "origin", "beta");
  assert.equal(count(f.onOrigin("index.html"), "?v=deadbeef"), 1, "the fixture's stale buster did not land");

  const r = f.ship();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /PUSHED/);
  assert.equal(count(f.onOrigin("index.html"), "?v=deadbeef"), 0);
  f.assertBustersMatch("origin/beta");
});

test("a commit that holds nothing once recompiled drops out, and a lone one leaves nothing to push", (t) => {
  const f = setup(t);
  f.sourceLast(f.mine, "a change that was never committed");
  f.compile(f.mine);
  f.git(f.mine, "checkout", "--", "portal/03-catalog.jsx");
  f.commit(f.mine, "compile output alone", { compiled: false });
  f.anotherSessionPushes();

  const r = f.ship();
  assert.equal(r.status, 0, r.stdout);
  assert.equal(count(r.stdout, "— recompiling"), 1, "the commit should have conflicted");
  assert.match(r.stdout, /Nothing to push/);
  assert.equal(f.git(f.mine, "rev-parse", "HEAD"), f.originTip());
  f.assertBustersMatch("origin/beta");
});

test("rebase --continue failing with nothing conflicted aborts instead of leaving the rebase open", (t) => {
  const f = setup(t);
  // The compile dirties a tracked file nobody listed as its own, so `rebase --continue` refuses to run.
  f.write(f.mine, "scripts/compile.mjs", `${STUB_COMPILE}\nwriteFileSync("notes.txt", String(Math.random()));\n`);
  f.sourceLast(f.mine, "my change");
  f.commit(f.mine, "my commit");
  f.anotherSessionPushes();

  const before = f.snapshot();
  f.assertStopped(f.ship(), before, /rebase --continue failed/);
});
