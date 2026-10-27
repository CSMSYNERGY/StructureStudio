// deno test supabase/functions/_shared/doorMeasure.test.ts
// One read of a door photo, pixel points to the latch leaf's numbers (doorLook.ts doorLookFromMeasure):
// the size echo and its 2% drop, points to fractions and inches, leaf assignment by the meeting line and
// the mirroring, the hinge-side fallback chain with a warning on every guessed side, the points winning
// over the read's own words, short corner gussets as board parts, and 3 or more leaves refused rather
// than clamped.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { colorRolesOf, type DoorReadDraft, type DoorReadResult, doorLookFromMeasure, samplePatch, snapFinish } from "./doorLook.ts";
import { doubleDoor, gussetDoor, inches, nudge, paintAt, PX_PER_IN, singleDoor, withStrips } from "./_test_stubs/doorReads.ts";

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

Deno.test("edge strips: a photo with 2 in past each side edge measures the same door, and its pixels map back onto it", () => {
  const door = withStrips(singleDoor({ lite: true }), 2);
  const r = doorLookFromMeasure(door.read, { ...door.ctx, colorAt: paintAt(door.read, door.ctx.photo) });
  const d = draftOf(r);
  assertEquals(numbers(d), SINGLE);
  assertEquals([d.side, d.sideFrom, d.colors], ["left", "hinges", { infill: "door", frame: "trim", members: "trim" }]);
  assertEquals(rnd(d.px), { hinges: [[62.5, 1740], [62.5, 900], [62.5, 260]], handle: [900, 900] }, "the close-ups are cut where the hinges are in the photo");
  // A butt hinge's knuckle sits ON the edge, half in the strip: read there, it is still the hinge.
  const knuckles = withMeasure(door.read, { hinges: [10.4, 44, 69.6].map((y) => ({ pivot: [45, (80 - y) * PX_PER_IN] })) });
  const k = draftOf(doorLookFromMeasure({ ...knuckles, hinges: { type: "butt" } }, door.ctx));
  assertEquals([k.side, k.sideFrom, k.hingeCount, rnd(k.hingeAt)], ["left", "hinges", 3, [0.13, 0.55, 0.87]]);
  // A double: the meeting line and the latch leaf's hinges through the strips.
  const pair = withStrips(doubleDoor({ lite: true }), 2);
  const p = draftOf(doorLookFromMeasure(pair.read, pair.ctx));
  assertEquals([numbers(p), p.side, p.meetX, rnd(p.px.hinges)], [SINGLE, "right", 0.5, [[1837.5, 1740], [1837.5, 900], [1837.5, 260]]]);
});

Deno.test("edge strips: a stile edge read on the jamb (in a strip) is no stile, never a 0 in one", () => {
  const door = withStrips(singleDoor(), 2), px = 2 * PX_PER_IN;
  const jamb = { inner: [[px - 15, 5 * PX_PER_IN], [px - 15, 75 * PX_PER_IN]] }; // 0.6 in out, on the jamb
  const [, right] = (door.read.measure as Rec).stiles as Rec[];
  assertEquals(draftOf(doorLookFromMeasure(withMeasure(door.read, { stiles: [jamb, right] }), door.ctx)).fIn, 5.5, "the other stile's 5.5 in, not their median with 0");
  assertEquals(draftOf(doorLookFromMeasure(withMeasure(door.read, { stiles: [jamb] }), door.ctx)).fIn, null, "no stile measured");
  // With no strips nothing changes: an edge on the photo's own edge is still a 0 in stile, as before.
  const cut = singleDoor();
  assertEquals(draftOf(doorLookFromMeasure(withMeasure(cut.read, { stiles: [{ inner: [[0, 125], [0, 1875]] }] }), cut.ctx)).fIn, 0);
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

// ─── Corner gussets ──────────────────────────────────────────────────────────────────────────────
// Every board part as [u0, v0, u1, v1, wIn, role] to 2 decimals, its ends and the list each in one
// order (a board is the same board either way round).
const boards = (d: DoorReadDraft) =>
  (rnd(d.parts) as Rec[]).filter((p) => p.t === "board").map((p) => {
    const ends = [[p.u0, p.v0], [p.u1, p.v1]] as number[][];
    ends.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return [...ends[0], ...ends[1], p.wIn, p.role];
  }).sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number));
// gussetDoor's four, from the hinge side: bottom and top by the hinges, bottom and top by the latch.
const GUSSETS = [
  [0.04, 0.09, 0.21, 0.02, 2, "members"],
  [0.04, 0.91, 0.21, 0.98, 2, "members"],
  [0.79, 0.02, 0.96, 0.09, 2, "members"],
  [0.79, 0.98, 0.96, 0.91, 2, "members"],
];
const fills = (d: DoorReadDraft) => d.panels?.map((p) => p.fill);

Deno.test("a short diagonal in a panel is a corner gusset: a board part, never the panel's Z or X", () => {
  const d = draftOf(measure(gussetDoor()));
  assertEquals(fills(d), ["none", "none"]);
  assertEquals(d.brace, { t: "none", from: null, wIn: null });
  assertEquals(boards(d), GUSSETS);
  // The read calling them an X changes nothing: the points win.
  assertEquals(fills(draftOf(measure(gussetDoor({ panels: ["x", "x"] })))), ["none", "none"]);
});

Deno.test("a diamond's corner braces stay its own (its octagon), never board parts", () => {
  const d = draftOf(measure(gussetDoor({ panels: ["diamond", "none"] })));
  assertEquals(rnd(d.panels), [{ fill: "diamond", braceWIn: 2 }, { fill: "none" }]);
  assertEquals(boards(d), [GUSSETS[1], GUSSETS[3]], "only the plain top panel's gussets are parts");
});

Deno.test("a full diagonal and a gusset in one panel: the panel's Z, and one board part", () => {
  const door = gussetDoor(), d = inches(36, 80);
  const [gusset] = (door.read.measure as Rec).braces as Rec[];
  const read = withMeasure(door.read, { braces: [{ a: d.p(3, 3), b: d.p(33, 37), across: d.line(16, 20, 20, 20) }, gusset] });
  const r = draftOf(doorLookFromMeasure(read, door.ctx));
  assertEquals(rnd(r.panels), [{ fill: "z", zFrom: "hinge", braceWIn: 4 }, { fill: "none" }], "the gusset's 2 in is not the Z's width");
  assertEquals(boards(r), [GUSSETS[0]]);
});

Deno.test("the gusset line: a diagonal must rise half its panel AND run 0.4 of its opening (the leaf less its stiles)", () => {
  // The lower panel here is 40 in high and the opening 36 - 2 x 1.5 = 33 in: 20 in up and 13.2 in across.
  const door = gussetDoor(), d = inches(36, 80);
  const lower = (x0: number, y0: number, x1: number, y1: number) => {
    const r = draftOf(doorLookFromMeasure(withMeasure(door.read, { braces: [{ a: d.p(x0, y0), b: d.p(x1, y1) }] }), door.ctx));
    return [r.panels?.[0].fill, r.parts.length];
  };
  assertEquals(lower(5, 5, 20, 26), ["z", 0], "21 in up, 15 in across");
  assertEquals(lower(5, 5, 20, 24), ["none", 1], "19 in up");
  assertEquals(lower(5, 5, 19, 26), ["z", 0], "14 in across");
  assertEquals(lower(5, 5, 18, 26), ["none", 1], "13 in across");
  // A double's leaf is 36 of its 72 in with 5.5 in stiles, and its lower panel (mid rail at 55%) 44 in
  // high: 22 in up and 0.4 x 25 = 10 in across, though 11 in is far under 0.4 of the whole door.
  const pair = doubleDoor({ brace: "none" }), p = inches(72, 80);
  const latch = (x0: number) => {
    const r = draftOf(doorLookFromMeasure(withMeasure(pair.read, { braces: [{ a: p.p(x0, 6), b: p.p(65, 30) }] }), pair.ctx));
    return [r.panels?.[0].fill, r.parts.length];
  };
  assertEquals(latch(54), ["z", 0], "24 in up, 11 in across");
  assertEquals(latch(56), ["none", 1], "9 in across");
});

// A 48 x 80 in double of 24 in leaves, each hinged on its outer jamb, the handle on the RIGHT leaf just
// past the meeting line: `stileIn` stiles, sill and head rails, and a mid rail at 55% unless `noMid`.
// Braces are [x0, y0, x1, y1] in inches, each 3.5 in wide.
function narrowPair(braces: number[][], o: { stileIn: number; noMid?: boolean; panels: string[] }) {
  const d = inches(48, 80), s = o.stileIn;
  const rail = (y0: number, y1: number) => [d.rail(s, 24 - s, y0, y1), d.rail(24 + s, 48 - s, y0, y1)];
  const read: Rec = {
    measure: {
      size: d.size,
      leaves: [[d.p(0, 0), d.p(24, 0), d.p(24, 80), d.p(0, 80)], [d.p(24, 0), d.p(48, 0), d.p(48, 80), d.p(24, 80)]],
      meet: d.line(24, 2, 24, 78),
      rails: [...rail(0, s), ...(o.noMid ? [] : rail(42.25, 45.75)), ...rail(80 - s, 80)],
      stiles: [s, 24 - s, 24 + s, 48 - s].map((x) => ({ inner: d.line(x, 5, x, 75) })),
      braces: braces.map(([x0, y0, x1, y1]) => {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        return { a: d.p(x0, y0), b: d.p(x1, y1), across: d.line(cx - 1.75, cy, cx + 1.75, cy) };
      }),
      hinges: [10.4, 44, 69.6].flatMap((y) => [{ pivot: d.p(0.5, y) }, { pivot: d.p(47.5, y) }]),
      handle: d.p(26, 44),
    },
    refuse: null,
    base: "plank",
    leaves: 2,
    field: "v",
    brace: "none",
    panels: o.panels,
  };
  return draftOf(doorLookFromMeasure(read, { widthIn: 48, heightIn: 80, leaves: 2, photo: d.size }));
}
const mirror48 = (b: number[]) => [48 - b[0], b[1], 48 - b[2], b[3]];

// An X's second board butted against the first: the cut leg in two pieces that stop at the whole board's
// edges (w wide), each `short` in further back. In inches; returns [whole, piece, piece].
function buttedX(whole: number[], cut: number[], w: number, short = 0): number[][] {
  const [a0, b0, a1, b1] = whole, [c0, d0, c1, d1] = cut;
  const ux = c1 - c0, uy = d1 - d0, vx = a1 - a0, vy = b1 - b0, len = Math.hypot(ux, uy);
  const t = ((a0 - c0) * vy - (b0 - d0) * vx) / (ux * vy - uy * vx); // where the cut leg meets the whole one
  const sin = Math.abs(ux * vy - uy * vx) / (len * Math.hypot(vx, vy));
  const k = (w / 2 / sin + short) / len, mx = c0 + ux * t, my = d0 + uy * t;
  return [whole, [c0, d0, mx - ux * k, my - uy * k], [mx + ux * k, my + uy * k, c1, d1]];
}

Deno.test("a panel Z on a narrow leaf with wide stiles is still the panel's Z: the run is judged against the opening", () => {
  // 24 in leaves with 5.5 in stiles leave a 13 in opening. A 3.5 in Z laid into its corners has its
  // centre line 1.9 in in from each stile, so it runs 9.2 in: 0.38 of the leaf, 0.71 of the opening.
  const zs = [[7.4, 7.4, 16.6, 40.35], [40.6, 7.4, 31.4, 40.35]]; // each low at its own hinge
  const xs = [...zs, [16.6, 7.4, 7.4, 40.35], [31.4, 7.4, 40.6, 40.35]];
  const z = narrowPair(zs, { stileIn: 5.5, panels: ["z", "none"] });
  assertEquals([rnd(z.panels), z.parts], [[{ fill: "z", zFrom: "hinge", braceWIn: 3.5 }, { fill: "none" }], []]);
  const x = narrowPair(xs, { stileIn: 5.5, panels: ["z", "none"] });
  assertEquals([rnd(x.panels), x.parts], [[{ fill: "x", braceWIn: 3.5 }, { fill: "none" }], []]);
});

Deno.test("a full-height X on a narrow leaf, its second board butted in two, is still the panel's X: the butt gap grows as the legs close", () => {
  // No mid rail and 3.5 in stiles: each leaf's legs cross at about 23 degrees, so the butted board's
  // pieces stop 9.1 in apart along it, more than two board widths.
  for (const short of [0, 0.5]) {
    const left = buttedX([5, 5, 19, 75], [19, 5, 5, 75], 3.5, short);
    const r = narrowPair([...left, ...left.map(mirror48)], { stileIn: 3.5, noMid: true, panels: ["x"] });
    assertEquals([fills(r), r.parts], [["x"], []], `pieces ${short} in short`);
  }
});

Deno.test("a butted X joins whatever order its pieces are listed in, with one end read 1.8 in off the board's line or the pieces overlapping", () => {
  const door = singleDoor({ brace: "none", base: "xbrace" }), d = inches(36, 80);
  const board = ([x0, y0, x1, y1]: number[]) => ({ a: d.p(x0, y0), b: d.p(x1, y1), across: d.line(0, 20, 4, 20) });
  const lower = (braces: number[][]) => {
    const r = draftOf(doorLookFromMeasure({ ...withMeasure(door.read, { braces: braces.map(board) }), panels: ["x", "none"] }, door.ctx));
    return [fills(r), r.parts.length];
  };
  const whole = [7, 7, 29, 40], low = [29, 7, 21.2, 21.9], high = [16.3, 26.1, 7, 40]; // low's inner end 1.8 in off
  for (const order of [[whole, low, high], [whole, high, low], [high, low, whole]]) assertEquals(lower(order), [["x", "none"], 0], JSON.stringify(order));
  assertEquals(lower([whole, [29, 7, 15.8, 26.8], [19.1, 21.85, 7, 40]]), [["x", "none"], 0], "pieces overlapping 6 in");
});

Deno.test("an X across the whole leaf whose second board is butted at the crossing is still brace x; a Z in each panel stays two Zs", () => {
  const door = singleDoor({ brace: "x" }), d = inches(36, 80);
  const leaf = (braces: number[][]) => {
    const r = draftOf(doorLookFromMeasure(withMeasure(door.read, {
      braces: braces.map(([x0, y0, x1, y1]) => ({ a: d.p(x0, y0), b: d.p(x1, y1), across: d.line(15, 40, 20.5, 40) })),
    }), door.ctx));
    return [r.brace?.t, fills(r), r.parts.length];
  };
  assertEquals(leaf(buttedX([7, 7, 29, 73], [29, 7, 7, 73], 5.5)), ["x", ["none", "none"], 0]);
  assertEquals(leaf([[7, 7, 29, 73], [29, 7, 18, 40], [18, 40, 7, 73]]), ["x", ["none", "none"], 0], "cut at the crossing");
  assertEquals(leaf([[7, 7, 29, 40], [7, 48, 29, 73]]), ["none", ["z", "z"], 0], "a Z in each panel");
});

Deno.test("an X whose second board is butted in two is the panel's X, not a Z and two boards", () => {
  const door = singleDoor({ brace: "none", base: "xbrace" }), d = inches(36, 80);
  const board = (x0: number, y0: number, x1: number, y1: number) => ({ a: d.p(x0, y0), b: d.p(x1, y1), across: d.line(0, 20, 4, 20) });
  const whole = board(7, 7, 29, 40);
  const lower = (braces: Rec[]) => {
    const r = draftOf(doorLookFromMeasure({ ...withMeasure(door.read, { braces }), panels: ["x", "none"] }, door.ctx));
    return rnd([r.panels, r.parts]);
  };
  const X = [[{ fill: "x", braceWIn: 4 }, { fill: "none" }], []];
  assertEquals(lower([whole, board(29, 7, 18, 23.5), board(18, 23.5, 7, 40)]), X, "cut at the crossing");
  assertEquals(lower([whole, board(29, 7, 19.7, 20.9), board(16.3, 26.1, 7, 40)]), X, "butted against the whole board");
  assertEquals(lower([board(7, 7, 18, 23.5), board(18, 23.5, 29, 40), board(29, 7, 18, 23.5), board(18, 23.5, 7, 40)]), X, "both cut");
  assertEquals(lower([whole, board(29, 7, 18, 23.5), board(29, 7, 18, 23.5), board(18, 23.5, 7, 40)]), X, "a piece given twice");
});

Deno.test("a Classic-style double: each leaf's cut X stays an X, and the octagon's corner braces stay the diamond's", () => {
  const door = doubleDoor({ brace: "none" }), d = inches(72, 80);
  const leaf = (m: (x: number) => number) => [
    [7, 7, 29, 40], [29, 7, 18, 23.5], [18, 23.5, 7, 40], // the X, its second board in two
    [5.5, 70, 10, 74.5], [26, 74.5, 30.5, 70], [5.5, 50.25, 10, 45.75], [26, 45.75, 30.5, 50.25], // the octagon
  ].map(([x0, y0, x1, y1]) => ({ a: d.p(m(x0), y0), b: d.p(m(x1), y1), across: d.line(m(17), 20, m(21), 20) }));
  const braces = [...leaf((x) => x), ...leaf((x) => 72 - x)];
  const r = draftOf(doorLookFromMeasure({ ...withMeasure(door.read, { braces }), panels: ["x", "diamond"] }, door.ctx));
  assertEquals([fills(r), r.parts], [["x", "diamond"], []]);
});

Deno.test("an unequal double: the latch leaf's own four gussets, the other leaf's only where the latch leaf has none", () => {
  // 29 + 43 of 72 in (8% off centre, no warning): mirrored by fraction, the narrow leaf's gussets land
  // 0.1 off the latch leaf's own and would be kept beside them.
  const door = gussetDoor({ double: true, meetIn: 29 });
  const d = draftOf(measure(door));
  assertEquals([d.side, fills(d)], ["right", ["none", "none"]]);
  const LATCH = [
    [0.03, 0.09, 0.17, 0.02, 2, "members"],
    [0.03, 0.91, 0.17, 0.98, 2, "members"],
    [0.83, 0.02, 0.97, 0.09, 2, "members"],
    [0.83, 0.98, 0.97, 0.91, 2, "members"],
  ];
  assertEquals(boards(d), LATCH);
  // The latch leaf's bottom gusset by its hinges missed: the narrow leaf's, mirrored in, stands for it.
  const p = inches(72, 80).p(64.5, 1.5);
  const braces = ((door.read.measure as Rec).braces as Rec[]).filter((b) => (b.a as number[])[0] !== p[0] || (b.a as number[])[1] !== p[1]);
  const missed = boards(draftOf(doorLookFromMeasure(withMeasure(door.read, { braces }), door.ctx)));
  assertEquals(missed, [LATCH[1], [0.05, 0.09, 0.26, 0.02, 2, "members"], LATCH[2], LATCH[3]]);
  // No mid rail read (one panel a leaf) and both of the latch leaf's top gussets missed: the narrow leaf's
  // two top ones stand for them, matched by corner (side AND top or bottom), not by side alone.
  const m = door.read.measure as Rec, top = [inches(72, 80).p(30.5, 72.5), inches(72, 80).p(64.5, 78.5)];
  const oneRail = withMeasure(door.read, {
    rails: (m.rails as Rec[]).filter((_, i) => i % 3 !== 1),
    braces: (m.braces as Rec[]).filter((b) => !top.some((q) => (b.a as number[])[0] === q[0] && (b.a as number[])[1] === q[1])),
  });
  const r = draftOf(doorLookFromMeasure(oneRail, door.ctx));
  assertEquals([fills(r), boards(r)], [["none"], [
    LATCH[0],
    [0.05, 0.91, 0.26, 0.98, 2, "members"],
    [0.74, 0.98, 0.95, 0.91, 2, "members"],
    LATCH[2],
  ]]);
});

Deno.test("a gusset given both ways, as a diagonal and as a board, is one part: the read's own board", () => {
  const both = draftOf(measure(gussetDoor({ both: true })));
  assertEquals([fills(both), boards(both)], [["none", "none"], GUSSETS]);
  // The read's own copy is the one kept: widen its boards and the parts follow.
  const door = gussetDoor({ both: true }), d = inches(36, 80);
  const own = ((door.read.measure as Rec).parts as Rec[]).map((q) => ({ ...q, across: d.line(0, 40, 2.5, 40) }));
  assertEquals(boards(draftOf(doorLookFromMeasure(withMeasure(door.read, { parts: own }), door.ctx))).map((b) => b[4]), [2.5, 2.5, 2.5, 2.5]);
});

Deno.test("diagonals in a pickets or lite panel stay that panel's own: no board parts", () => {
  const d = draftOf(measure(gussetDoor({ panels: ["pickets", "lite"] })));
  assertEquals(fills(d), ["pickets", "lite"]);
  assertEquals(d.parts, []);
});

Deno.test("a double with gussets on both leaves: the latch leaf's four, the other leaf's copies folded in", () => {
  const door = gussetDoor({ double: true });
  const d = draftOf(measure(door));
  assertEquals([d.leaves, d.side, fills(d)], [2, "right", ["none", "none"]]);
  assertEquals(boards(d), GUSSETS);
  // Only the other leaf's gussets read: the same four, mirrored in.
  const braces = ((door.read.measure as Rec).braces as Rec[]).filter((b) => (b.a as number[])[0] < 36 * PX_PER_IN);
  assertEquals(boards(draftOf(doorLookFromMeasure(withMeasure(door.read, { braces }), door.ctx))), GUSSETS);
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
