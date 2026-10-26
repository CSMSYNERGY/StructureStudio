// deno test supabase/functions/_shared/doorMeasure.test.ts
// One read of a door photo, pixel points to the latch leaf's numbers (doorLook.ts doorLookFromMeasure):
// the size echo and its 2% drop, points to fractions and inches, leaf assignment by the meeting line and
// the mirroring, the hinge-side fallback chain with a warning on every guessed side, the points winning
// over the read's own words, and 3 or more leaves refused rather than clamped.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { colorRolesOf, type DoorReadDraft, type DoorReadResult, doorLookFromMeasure, samplePatch, snapFinish } from "./doorLook.ts";
import { doubleDoor, inches, nudge, paintAt, singleDoor } from "./_test_stubs/doorReads.ts";

type Rec = Record<string, unknown>;
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
// Every number in `v` to 2 decimals (a measurement off pixels is never exact).
const rnd = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x)));
function draftOf(r: DoorReadResult): DoorReadDraft {
  if (!r.ok) throw new Error(`not a draft: ${JSON.stringify(r)}`);
  return r.draft;
}
const measure = (door: { read: Rec; ctx: Parameters<typeof doorLookFromMeasure>[1] }) => doorLookFromMeasure(door.read, door.ctx);
const codes = (r: DoorReadResult) => (r.ok ? r.warnings.map((w) => w.code) : []);
// The numbers a draft measured, rounded, without the side and pixels (which differ when mirrored).
const numbers = (d: DoorReadDraft) =>
  rnd({
    rails: d.rails,
    railHIn: d.railHIn,
    fIn: d.fIn,
    pitchIn: d.pitchIn,
    brace: d.brace,
    panels: d.panels,
    hingeCount: d.hingeCount,
    hingeAt: d.hingeAt,
    hingeLenIn: d.hingeLenIn,
    handleV: d.handleV,
    parts: d.parts,
  }) as Rec;
const withMeasure = (read: Rec, patch: Rec): Rec => ({ ...read, measure: { ...read.measure as Rec, ...patch } });

const SINGLE = {
  rails: [0.55],
  railHIn: 3.5,
  fIn: 5.5,
  pitchIn: 5,
  brace: { t: "z", from: "hinge", wIn: 5.5 },
  panels: [{ fill: "none" }, { fill: "none" }],
  hingeCount: 3,
  hingeAt: [0.13, 0.55, 0.87],
  hingeLenIn: 16,
  handleV: "rail",
  parts: [{ t: "lite", u0: 0.28, v0: 0.65, u1: 0.72, v1: 0.88, rows: 3, cols: 2 }],
};

Deno.test("points to numbers: a single Z door hinged left, read to the inch", () => {
  const door = singleDoor({ lite: true });
  const r = doorLookFromMeasure(door.read, { ...door.ctx, colorAt: paintAt(door.read, door.ctx.photo) });
  const d = draftOf(r);
  assertEquals(numbers(d), SINGLE);
  assertEquals([d.base, d.leaves, d.side, d.sideFrom, d.meetX, d.fieldDir], ["zbrace", 1, "left", "hinges", null, "v"]);
  assertEquals(d.colors, { infill: "door", frame: "trim", members: "trim" });
  assertEquals(d.finish, "black");
  assertEquals(d.stageA, { hingeType: "tstrap", handleType: "barn", meetType: null });
  assertEquals(rnd(d.px), { hinges: [[12.5, 1740], [12.5, 900], [12.5, 260]], handle: [850, 900] });
  assertEquals(codes(r), [], "hinges seen: nothing guessed, nothing to warn about");
});

Deno.test("the same door hung the other way reads the same: u starts at the hinge", () => {
  const left = draftOf(measure(singleDoor({ lite: true }))), right = draftOf(measure(singleDoor({ lite: true, mirror: true })));
  assertEquals(right.side, "right");
  assertEquals(numbers(right), numbers(left));
});

Deno.test("points are normalised by the size the model ECHOED, not the photo's", () => {
  const door = singleDoor({ lite: true });
  const half = withMeasure(nudge(door.read, (p) => [p[0] / 2, p[1] / 2]), { size: [450, 1000] });
  assertEquals(numbers(draftOf(doorLookFromMeasure(half, door.ctx))), SINGLE);
});

Deno.test("the size echo is required, and a read whose size is more than 2% off the photo's shape is dropped", () => {
  const door = singleDoor();
  const at = (size: unknown) => doorLookFromMeasure(withMeasure(door.read, { size }), door.ctx);
  assertEquals(at(undefined), { ok: false, drop: "no_size" });
  assertEquals(at([0, 2000]), { ok: false, drop: "no_size" });
  assertEquals(at(["900", 2000]), { ok: false, drop: "no_size" });
  assert(at([900 * 1.02, 2000]).ok, "2% exactly is kept");
  assert(at([900, 2000 * 1.02]).ok);
  assertEquals(at([900 * 1.021, 2000]), { ok: false, drop: "size_aspect" });
  assertEquals(at([900, 2000 * 0.97]), { ok: false, drop: "size_aspect" });
});

Deno.test("a double: points go to the leaf their side of the meeting line, the other leaf mirrored in", () => {
  const r = measure(doubleDoor({ lite: true }));
  const d = draftOf(r);
  assertEquals([d.leaves, d.side, d.sideFrom, d.meetX], [2, "right", "hinges", 0.5]);
  // Both leaves' rails, stiles, seams and hinges collapse onto the one latch leaf, and the lite each
  // leaf has is one part.
  assertEquals(numbers(d), SINGLE);
  assertEquals(d.stageA.meetType, "overlap");
  assertEquals(codes(r), []);
  // The pixels for the close-ups are the latch (right) leaf's own hinges.
  assertEquals(rnd(d.px.hinges), [[1787.5, 1740], [1787.5, 900], [1787.5, 260]]);
});

Deno.test("a double hung the other way (handle on the left leaf) reads the same", () => {
  const d = draftOf(measure(doubleDoor({ lite: true, mirror: true })));
  assertEquals(d.side, "left");
  assertEquals(numbers(d), SINGLE);
});

Deno.test("a part only the other leaf of a double has is kept, mirrored into the latch leaf", () => {
  const d = draftOf(measure(doubleDoor({ oneLite: true })));
  assertEquals(numbers(d).parts, SINGLE.parts);
});

Deno.test("the meeting line: its own points, else the leaves' inner edges, else the centre; over 10% off centre warns", () => {
  assertEquals(codes(measure(doubleDoor({ meetIn: 30 }))), [], "30 in of 72 is 8% off");
  const off = measure(doubleDoor({ meetIn: 28 }));
  assertEquals(r2(draftOf(off).meetX), 0.39);
  assertEquals(codes(off), ["unequal_leaves"]);
  assertEquals(off.ok && off.warnings[0].text, "The two doors aren't the same width. We've drawn them equal.");
  const noLine = doubleDoor({ meetIn: 28 });
  assertEquals(r2(draftOf(doorLookFromMeasure(withMeasure(noLine.read, { meet: null }), noLine.ctx)).meetX), 0.39);
  assertEquals(draftOf(doorLookFromMeasure(withMeasure(noLine.read, { meet: null, leaves: [] }), noLine.ctx)).meetX, 0.5);
});

// ─── The hinge side ──────────────────────────────────────────────────────────────────────────────
const SIDE_CODES = ["hinge_side_brace", "hinge_side_handle", "hinge_side_default", "latch_leaf_default"];
const sideOf = (r: DoorReadResult) => {
  const d = draftOf(r);
  return [d.side, d.sideFrom, codes(r).filter((c) => SIDE_CODES.includes(c))];
};

Deno.test("hinge side, single: the hinge points, else a lone Z's low end, else opposite the handle, else left", () => {
  assertEquals(sideOf(measure(singleDoor())), ["left", "hinges", []]);
  assertEquals(sideOf(measure(singleDoor({ mirror: true }))), ["right", "hinges", []]);
  assertEquals(sideOf(measure(singleDoor({ hinges: false }))), ["left", "brace", ["hinge_side_brace"]]);
  assertEquals(sideOf(measure(singleDoor({ hinges: false, mirror: true }))), ["right", "brace", ["hinge_side_brace"]]);
  // An X is no lone Z, so the handle decides: the hinges go opposite it.
  assertEquals(sideOf(measure(singleDoor({ hinges: false, brace: "x" }))), ["left", "handle", ["hinge_side_handle"]]);
  assertEquals(sideOf(measure(singleDoor({ hinges: false, brace: "x", mirror: true }))), ["right", "handle", ["hinge_side_handle"]]);
  assertEquals(sideOf(measure(singleDoor({ hinges: false, brace: "none", mirror: true }))), ["right", "handle", ["hinge_side_handle"]]);
  assertEquals(sideOf(measure(singleDoor({ hinges: false, brace: "none", handle: false, mirror: true }))), ["left", "default", ["hinge_side_default"]]);
});

Deno.test("a side guessed from the brace takes the brace to rise from the hinge side; seen hinges let it rise from the strike", () => {
  assertEquals(draftOf(measure(singleDoor({ hinges: false, mirror: true }))).brace?.from, "hinge");
  const door = singleDoor(), d = inches(36, 80);
  const strike = withMeasure(door.read, { braces: [{ a: d.p(29, 7), b: d.p(7, 73), across: d.line(15, 40, 20.5, 40) }] });
  const r = doorLookFromMeasure(strike, door.ctx);
  assertEquals(draftOf(r).brace?.from, "strike");
  assertEquals(sideOf(r), ["left", "hinges", []]);
});

Deno.test("hinge side, double: hinges and a handle are a reading; a handle alone, hinges alone or nothing are guesses", () => {
  assertEquals(sideOf(measure(doubleDoor())), ["right", "hinges", []]);
  assertEquals(sideOf(measure(doubleDoor({ hinges: false }))), ["right", "handle", ["hinge_side_handle"]]);
  assertEquals(sideOf(measure(doubleDoor({ hinges: false, mirror: true }))), ["left", "handle", ["hinge_side_handle"]]);
  assertEquals(sideOf(measure(doubleDoor({ handle: false }))), ["left", "latch", ["latch_leaf_default"]]);
  assertEquals(sideOf(measure(doubleDoor({ hinges: false, handle: false }))), ["left", "default", ["hinge_side_default"]]);
});

Deno.test("EVERY side not read off the hinges warns, whatever else the photo shows", () => {
  for (const double of [false, true]) {
    for (const hinges of [true, false]) {
      for (const brace of ["z", "x", "none"] as const) {
        for (const handle of [true, false]) {
          for (const mirror of [false, true]) {
            const o = { hinges, brace, handle, mirror };
            const r = measure(double ? doubleDoor(o) : singleDoor(o));
            const [, from, warned] = sideOf(r);
            assertEquals((warned as string[]).length, from === "hinges" ? 0 : 1, JSON.stringify({ double, ...o, from }));
          }
        }
      }
    }
  }
});

// ─── The points win ──────────────────────────────────────────────────────────────────────────────
Deno.test("the points win over the read's own words: rail count, brace, panel braces", () => {
  const door = singleDoor(), d = inches(36, 80);
  // Three panels said, one mid rail measured: two panels, the bottom one and the top one.
  assertEquals(draftOf(doorLookFromMeasure({ ...door.read, panels: ["none", "x", "lite"] }, door.ctx)).panels, [{ fill: "none" }, { fill: "lite" }]);
  // An X said, one diagonal across the leaf measured: a Z.
  assertEquals(draftOf(doorLookFromMeasure({ ...door.read, brace: "x" }, door.ctx)).brace?.t, "z");
  // Diagonals measured, none across the leaf: no leaf brace, whatever was said.
  assertEquals(draftOf(measure(singleDoor({ brace: "none" }))).brace, { t: "none", from: null, wIn: null });
  // No diagonals key at all: the read's word stands.
  const words = { ...door.read, measure: { ...door.read.measure as Rec } };
  delete (words.measure as Rec).braces;
  assertEquals(draftOf(doorLookFromMeasure(words, door.ctx)).brace, { t: "z", from: null, wIn: null });
  // An X in the lower panel (two diagonals under the mid rail) overrules a "none" there.
  const x = withMeasure(door.read, {
    braces: [{ a: d.p(7, 7), b: d.p(29, 40), across: d.line(15, 20, 19, 20) }, { a: d.p(29, 7), b: d.p(7, 40), across: d.line(15, 20, 19, 20) }],
  });
  const xd = draftOf(doorLookFromMeasure(x, door.ctx));
  assertEquals(rnd([xd.brace?.t, xd.panels]), ["none", [{ fill: "x", braceWIn: 4 }, { fill: "none" }]]);
  // A diamond has no point of its own, so its corner braces cannot turn it into an X.
  const diamond = draftOf(doorLookFromMeasure({ ...x, panels: ["diamond", "none"] }, door.ctx));
  assertEquals(rnd(diamond.panels?.[0]), { fill: "diamond", braceWIn: 4 });
  // No rail points at all: the read's own panels, at its own count.
  const noRails = draftOf(doorLookFromMeasure({ ...withMeasure(door.read, { rails: undefined }), panels: ["x", "none", "lite"] }, door.ctx));
  assertEquals([noRails.rails, noRails.panels?.map((p) => p.fill)], [null, ["x", "none", "lite"]]);
});

Deno.test("the handle: on the mid rail it is 'rail', off it a height", () => {
  const door = singleDoor(), d = inches(36, 80);
  assertEquals(rnd(draftOf(doorLookFromMeasure(withMeasure(door.read, { handle: d.p(34, 36) }), door.ctx)).handleV), 0.45);
  assertEquals(draftOf(doorLookFromMeasure(withMeasure(door.read, { handle: d.p(34, 43) }), door.ctx)).handleV, "rail");
});

Deno.test("level boards: the seams are heights", () => {
  const door = singleDoor(), d = inches(36, 80);
  const read = { ...withMeasure(door.read, { seams: [10, 20, 30, 40].map((y) => d.p(0, y)[1]) }), field: "h" };
  assertEquals(r2(draftOf(doorLookFromMeasure(read, door.ctx)).pitchIn), 10);
});

Deno.test("hidden hinges with no hinge points are none at all; other words with no points are unknown", () => {
  const door = singleDoor({ hinges: false });
  const hidden = draftOf(doorLookFromMeasure({ ...door.read, hinges: { type: "hidden" } }, door.ctx));
  assertEquals([hidden.hingeCount, hidden.hingeAt], [0, []]);
  const unseen = draftOf(doorLookFromMeasure(door.read, door.ctx));
  assertEquals([unseen.hingeCount, unseen.hingeAt], [null, null]);
});

// ─── Refusals ────────────────────────────────────────────────────────────────────────────────────
Deno.test("3 or more leaves are refused, never clamped to 2, whether the read says so or its points do", () => {
  const door = doubleDoor(), d = inches(72, 80);
  const third = [d.p(48, 0), d.p(72, 0), d.p(72, 80), d.p(48, 80)];
  assertEquals(doorLookFromMeasure({ ...door.read, leaves: 3, measure: { size: d.size } }, door.ctx), { ok: false, refuse: "leaves", leaves: 3 });
  assertEquals(doorLookFromMeasure({ ...door.read, leaves: 4 }, door.ctx), { ok: false, refuse: "leaves", leaves: 4 }, "two outlined, four said");
  const quads = (door.read.measure as Rec).leaves as unknown[];
  assertEquals(doorLookFromMeasure(withMeasure(door.read, { leaves: [...quads, third] }), door.ctx), { ok: false, refuse: "leaves", leaves: 3 });
});

Deno.test("the read's own refusals, and answers that are not reads", () => {
  const door = singleDoor();
  for (const code of ["not_door", "open", "blocked", "angled", "unsupported", "leaves"]) {
    assertEquals(doorLookFromMeasure({ ...door.read, refuse: ` ${code.toUpperCase()} ` }, door.ctx), { ok: false, refuse: code } as DoorReadResult);
  }
  assertEquals(doorLookFromMeasure({ ...door.read, refuse: "too dark" }, door.ctx), { ok: false, drop: "unreadable" });
  assertEquals(doorLookFromMeasure("a door", door.ctx), { ok: false, drop: "unreadable" });
  assertEquals(doorLookFromMeasure([door.read], door.ctx), { ok: false, drop: "unreadable" });
});

Deno.test("the leaves: the points' count, else the read's word, else what the builder typed", () => {
  const door = singleDoor();
  assertEquals(draftOf(doorLookFromMeasure({ ...door.read, leaves: 2 }, door.ctx)).leaves, 1, "one leaf outlined beats a word");
  const unsaid = { ...withMeasure(door.read, { leaves: [] }), leaves: undefined };
  assertEquals(draftOf(doorLookFromMeasure(unsaid, door.ctx)).leaves, 1);
  assertEquals(draftOf(doorLookFromMeasure(unsaid, { ...door.ctx, leaves: 2 })).leaves, 2);
});

// ─── Colours ─────────────────────────────────────────────────────────────────────────────────────
Deno.test("samplePatch: the median of a 5 x 5 patch, channel by channel, clipped to the image", () => {
  const w = 10, h = 10, rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([10, 20, 30, 255], i * 4);
  for (const [x, y] of [[4, 4], [5, 5], [6, 4]]) rgba.set([255, 255, 255, 255], (y * w + x) * 4); // glints
  assertEquals(samplePatch(rgba, w, h, [5, 5]), [10, 20, 30]);
  assertEquals(samplePatch(rgba, w, h, [0, 0]), [10, 20, 30], "a 3 x 3 corner");
  assertEquals(samplePatch(rgba, w, h, [50, 50]), null, "off the image");
});

Deno.test("colour roles: the photo picks which colour each part follows, never the colour", () => {
  const wood = [150, 110, 70] as [number, number, number], white = [240, 240, 235] as [number, number, number];
  assertEquals(colorRolesOf({ infill: wood, frame: white, members: white }), { infill: "door", frame: "trim", members: "trim" });
  assertEquals(colorRolesOf({ infill: wood, frame: [155, 112, 72], members: [150, 112, 70] }), { infill: "door", frame: "door", members: "door" });
  assertEquals(colorRolesOf({ infill: wood, frame: [155, 112, 72], members: white }), { infill: "door", frame: "door", members: "trim" });
  assertEquals(colorRolesOf({ infill: wood, frame: white, members: [160, 115, 75] }), { infill: "door", frame: "trim", members: "door" });
  assertEquals(colorRolesOf({}), {});
  assertEquals([snapFinish([20, 20, 20]), snapFinish([140, 150, 160]), snapFinish([85, 65, 45])], ["black", "galv", "bronze"]);
});
