// The door-look local path (scripts/doorLookLocal.mjs), end to end on stub reads: prepare writes the
// exact Stage A prompt, the request and the size to echo; settle runs the answers through the server's
// own maths and writes the spec, its warnings and refusals, and the sim's recorded format. The browser's
// image work is stood in for (no Chromium here), and every output goes to the OS temp folder, outside
// the repo. Run with: node --test scripts/doorLookLocal.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { insideGitWorkTree, insideRepo, main, parseArgs, preparedSize, REPO_ROOT } from "./doorLookLocal.mjs";
import { doorStageAPrompt } from "../supabase/functions/_shared/doorLookPrompt.ts";
import { singleDoor, doubleDoor } from "../supabase/functions/_shared/_test_stubs/doorReads.ts";

// Stands in for headless Chromium: a "photo" file holds its own size as JSON.
function fakeOps(paint = [150, 110, 70]) {
  const calls = [];
  return {
    calls,
    size: async (file) => JSON.parse(readFileSync(file, "utf8")).size,
    render: async ({ file, quad, out, padPx }) => {
      calls.push({ op: "render", file, quad, out, padPx });
      return Buffer.from(JSON.stringify({ size: out }));
    },
    pixels: async (file) => {
      const [w, h] = JSON.parse(readFileSync(file, "utf8")).size;
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.set([...paint, 255], i * 4);
      return { w, h, rgba };
    },
    close: async () => {},
  };
}
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "doorlocal-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("prepare: the photo fitted to the limits, the exact Stage A prompt, the request and the size to echo", async () => {
  const w = workspace();
  try {
    const photo = join(w.dir, "door.jpg");
    writeFileSync(photo, JSON.stringify({ size: [3024, 4032] }));
    const hinge = join(w.dir, "hinge.jpg");
    writeFileSync(hinge, JSON.stringify({ size: [1200, 1600] }));
    const out = join(w.dir, "prep");
    const ops = fakeOps();
    const r = await main(["prepare", "--photo", photo, "--width", "36", "--height", "80", "--leaves", "1", "--out", out, "--hinge", hinge, "--meet", hinge], async () => ops);
    assert.deepEqual(r.photo, [950, 1267], "1.15 MP at the photo's own shape");
    const req = JSON.parse(readFileSync(join(out, "request.json"), "utf8"));
    assert.deepEqual([req.prompt, req.model, req.maxTokens, req.effort, req.reads], ["DOOR_LOOK_V3", "claude-opus-5-5", 12000, "high", 3]);
    assert.deepEqual(req.expectSize, [950, 1267]);
    assert.deepEqual(req.images, ["photo.jpg", "closeup-hinge.jpg"], "a single door has no meeting edge");
    const text = readFileSync(join(out, "prompt.txt"), "utf8");
    assert.equal(text, doorStageAPrompt({ widthIn: 36, heightIn: 80, leaves: 1, photo: [950, 1267], padIn: 0, closeUps: ["hinge"] }), "byte for byte the server's prompt; not straightened here, so no edge strips");
    assert.equal(req.padIn, 0);
    assert.equal(req.body.messages[0].content.at(-1).text, text);
    assert.match(readFileSync(join(out, "HOW-TO-RUN.txt"), "utf8"), /measure\.size must be \[950, 1267\]/);
    assert.ok(existsSync(join(out, "photo.jpg")) && existsSync(join(out, "closeup-hinge.jpg")));
  } finally {
    w.done();
  }
});

test("prepare: a quad straightens the photo to the typed shape; outputs inside the repo are refused", async () => {
  const quad = [[100, 200], [1100, 220], [1080, 2400], [120, 2380]];
  const size = preparedSize({ src: [3000, 4000], quad, widthIn: 36, heightIn: 80 });
  assert.ok(Math.abs(size[0] / size[1] - 0.45) < 0.003, String(size));
  assert.ok(size[1] <= 1568 && size[0] * size[1] <= 1205862);
  const w = workspace();
  try {
    const photo = join(w.dir, "door.jpg");
    writeFileSync(photo, JSON.stringify({ size: [3000, 4000] }));
    const ops = fakeOps();
    await main(["prepare", "--photo", photo, "--width", "36", "--height", "80", "--leaves", "1", "--out", join(w.dir, "p"), "--quad", quad.flat().join(",")], async () => ops);
    assert.deepEqual(ops.calls[0].quad, quad);
    // DOOR_LOOK_V2: straightened with 2 in past each side edge, so a butt hinge's knuckle stays whole.
    const strip = preparedSize({ src: [3000, 4000], quad, widthIn: 36, heightIn: 80, padIn: 2 });
    assert.ok(Math.abs(strip[0] / strip[1] - 0.5) < 0.003, `40 x 80 in shape: ${strip}`);
    assert.deepEqual(ops.calls[0].out, strip);
    assert.ok(Math.abs(ops.calls[0].padPx - strip[0] * 2 / 40) < 1e-9, "the door's box starts one strip in");
    const req = JSON.parse(readFileSync(join(w.dir, "p", "request.json"), "utf8"));
    assert.equal(req.padIn, 2);
    assert.match(readFileSync(join(w.dir, "p", "prompt.txt"), "utf8"), /The door's leaves fill it across from x = \d+ to x = \d+/);
    await main(["prepare", "--photo", photo, "--width", "36", "--height", "80", "--leaves", "1", "--out", join(w.dir, "p0"), "--quad", quad.flat().join(","), "--pad", "0"], async () => fakeOps());
    assert.equal(JSON.parse(readFileSync(join(w.dir, "p0", "request.json"), "utf8")).padIn, 0, "--pad 0: cut at the leaves");
    await assert.rejects(main(["prepare", "--photo", photo, "--width", "36", "--height", "80", "--leaves", "1", "--out", join(REPO_ROOT, "tmp-prep")], async () => fakeOps()), /outside the repo/);
    await assert.rejects(main(["prepare", "--photo", photo, "--width", "36", "--height", "80", "--leaves", "3", "--out", join(w.dir, "q")], async () => fakeOps()), /--leaves is 1 or 2/);
  } finally {
    w.done();
  }
  assert.ok(insideRepo(join(REPO_ROOT, "x")) && !insideRepo(tmpdir()));
});

test("outputs: refused inside ANY git checkout (another worktree of this repo too), and the photo's own path is never written", async () => {
  assert.equal(insideGitWorkTree(join(REPO_ROOT, "not", "yet", "made")), true);
  const w = workspace();
  try {
    const repo = join(w.dir, "some-checkout");
    mkdirSync(repo);
    // The pre-push hook runs this file with GIT_DIR, GIT_INDEX_FILE and friends pointing at the real
    // repository, and git obeys them over the path: `git init` would rewrite the SHARED .git/config
    // (core.bare = true, every session's git broken; it happened on 2026-10-27). So they are removed.
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
    assert.equal(spawnSync("git", ["init", "-q", repo], { env: cleanEnv }).status, 0);
    assert.equal(insideGitWorkTree(join(repo, "prep")), true);
    assert.equal(insideGitWorkTree(join(w.dir, "prep")), false);
    const photo = join(w.dir, "Builder Name door.jpg");
    writeFileSync(photo, JSON.stringify({ size: [900, 2000] }));
    await assert.rejects(main(["prepare", "--photo", photo, "--width", "36", "--height", "80", "--leaves", "1", "--out", join(repo, "prep")], async () => fakeOps()), /any git checkout/);
    await main(["prepare", "--photo", photo, "--width", "36", "--height", "80", "--leaves", "1", "--out", join(w.dir, "prep")], async () => fakeOps());
    const req = readFileSync(join(w.dir, "prep", "request.json"), "utf8");
    assert.ok(!req.includes("Builder Name") && !req.includes(w.dir.replace(/\\/g, "\\\\")), "no path to the builder's photo");
  } finally {
    w.done();
  }
});

test("settle: three stub reads through the server's maths; close-ups and Stage B skipped with their warnings", async () => {
  const w = workspace();
  try {
    const { read, ctx } = singleDoor();
    const photo = join(w.dir, "door.jpg");
    writeFileSync(photo, JSON.stringify({ size: ctx.photo }));
    const prep = join(w.dir, "prep");
    const prepared = await main(["prepare", "--photo", photo, "--width", "36", "--height", "80", "--leaves", "1", "--out", prep], async () => fakeOps());
    assert.deepEqual(prepared.photo, [705, 1568], "900 x 2000 shrunk to the long-side limit; the reads' echo of 900 x 2000 is the same shape");
    const reads = [1, 2, 3].map((i) => join(prep, `read-${i}.json`));
    writeFileSync(reads[0], JSON.stringify(read));
    writeFileSync(reads[1], "Here is the answer:\n```json\n" + JSON.stringify(read) + "\n```");
    writeFileSync(reads[2], JSON.stringify({ ...read, observed: ["one leaf", "a Z brace", "a small window"] }));
    const rec = join(w.dir, "corpus", "reads", "case1.json");
    const r = await main(["settle", "--prep", prep, "--reads", ...reads, "--record", rec], async () => fakeOps());
    const x = r.result;
    assert.equal(x.outcome, "draft");
    assert.deepEqual([x.spec.base, x.spec.src.leaves, x.spec.src.hinge], ["zbrace", 1, "left"]);
    assert.deepEqual(x.spec.colors, { infill: "door", frame: "door", members: "door" }, "one paint all over: every part follows the Door pick");
    const codes = x.warnings.map((w) => w.code);
    for (const c of ["closeup_hinges", "closeup_handle", "stageb_skipped", "observed_mismatch"]) assert.ok(codes.includes(c), `${c} in ${codes}`);
    assert.equal(x.sideFrom, "hinges");
    assert.deepEqual(x.skipped, { closeUps: true, stageB: true });
    assert.ok(existsSync(join(prep, "stageB-prompt.txt")), "Stage B's exact prompt, for a hand run");
    assert.match(readFileSync(join(prep, "stageB-prompt.txt"), "utf8"), /"a small window" \(you saw it, and the draft does not draw it\)/);
    const saved = JSON.parse(readFileSync(rec, "utf8"));
    assert.deepEqual(saved.photo, prepared.photo);
    assert.equal(saved.runs.length, 1);
    assert.equal(saved.runs[0].reads.length, 3);
    // A second run appends; a run for another photo size is refused.
    await main(["settle", "--prep", prep, "--reads", ...reads, "--record", rec, "--no-colors"]);
    assert.equal(JSON.parse(readFileSync(rec, "utf8")).runs.length, 2);
  } finally {
    w.done();
  }
});

test("settle: refusals carry the server's code and words; unreadable answers fail as unparseable; given close-ups decide", async () => {
  const w = workspace();
  try {
    const { read, ctx } = doubleDoor();
    const photo = join(w.dir, "door.jpg");
    writeFileSync(photo, JSON.stringify({ size: ctx.photo }));
    const prep = join(w.dir, "prep");
    await main(["prepare", "--photo", photo, "--width", "72", "--height", "80", "--leaves", "2", "--out", prep], async () => fakeOps());
    const put = (name, v) => {
      const f = join(prep, name);
      writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
      return f;
    };
    const open = put("open.json", { measure: {}, refuse: "open", leaves: 2 });
    const r = await main(["settle", "--prep", prep, "--reads", open, open, put("ok.json", read), "--no-colors"]);
    assert.deepEqual([r.result.outcome, r.result.refuse.code, r.result.refuse.reason, r.result.refuse.text], ["refused", "ai_door_refused", "open", "Close the door and take the photo again."]);
    const junk = put("junk.json", "I can't see a door.");
    assert.equal((await main(["settle", "--prep", prep, "--reads", junk, junk, junk, "--no-colors"])).result.error, "ai_door_unparseable");
    const ups = put("ups.json", { hinges: { status: "ok", votes: [{ type: "strap", finish: "galv" }, { type: "strap", finish: "galv" }, null] }, meet: { status: "ok", votes: [{ type: "astragal", wIn: 2 }, { type: "astragal", wIn: 2 }] } });
    const d = await main(["settle", "--prep", prep, "--reads", put("a.json", read), put("b.json", read), "--closeups", ups, "--no-colors"]);
    assert.equal(d.result.outcome, "draft");
    assert.deepEqual([d.result.spec.hinges.type, d.result.spec.hinges.finish, d.result.spec.meet.type], ["strap", "galv", "astragal"]);
    assert.ok(!d.result.warnings.some((x) => x.code === "closeup_hinges" || x.code === "closeup_meet"));
    assert.ok(d.result.warnings.some((x) => x.code === "closeup_handle"), "the handle's close-up was not given");
  } finally {
    w.done();
  }
});

test("args: --reads takes every file up to the next flag", () => {
  assert.deepEqual(parseArgs(["settle", "--prep", "p", "--reads", "a", "b", "c", "--no-colors", "--out", "o"]), { _: ["settle"], prep: "p", reads: ["a", "b", "c"], noColors: true, out: "o" });
});
