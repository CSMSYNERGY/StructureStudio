// deno test -A supabase/functions/_shared/overhangZoom.test.ts
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import {
  OVERHANG_INSIDE_MAX_FT, OVERHANG_LOPSIDED_MIN_FT, OVERHANG_LOPSIDED_RATIO, OVERHANG_ZOOM, OVERHANG_ZOOM_ASKS,
  OVERHANG_ZOOM_MAX_TOKENS, OVERHANG_ZOOM_MIN_LEFT_MS, overhangAskFeet, overhangGableWidthFt, overhangZoomPlan,
  overhangZoomPrompt, overhangZoomVerdict, overhangZoomWindows, runOverhangZoom,
} from "./overhangZoom.ts";
import { readDraftReply } from "./styleD3.ts";

// The image library fetches its WebAssembly from deno.land as it loads (closeUp.ts's note), so the
// tests that cut a real close-up run only with network access; preflight's run skips them.
const NET = (await Deno.permissions.query({ name: "net", host: "deno.land" })).state === "granted";
const imagescript = () => import("https://deno.land/x/imagescript@1.3.0/mod.ts");

// ─── The two buildings the probe measured, in the numbers the probe saw ──────────────────────────
// A 14x40 gable cabin with a recessed front porch (truth 1.3 ft), and a 37x22 raised-centre house
// with side wings whose centre gable is about 14 ft wide (truth 1.0 ft). Their reads' measure.pitch
// blocks, three each, as the v2 draft gave them in 1280 x 720 frames.
const CABIN_READS = [
  { frame: 2, size: [1280, 720], left: [248, 226], peak: [645, 108], right: [975, 272] },
  { frame: 2, size: [1280, 720], left: [248, 228], peak: [648, 108], right: [973, 268] },
  { frame: 2, size: [1280, 720], left: [248, 224], peak: [648, 108], right: [975, 268] },
];
const HOUSE_READS = [
  { frame: 7, size: [1280, 720], left: [468, 190], peak: [650, 90], right: [830, 160] },
  { frame: 7, size: [1280, 720], left: [470, 184], peak: [648, 90], right: [826, 152] },
  { frame: 7, size: [1280, 720], left: [470, 188], peak: [648, 90], right: [830, 165] },
];
// The close-up answers the probe's final run got back (its first three asks on each building), in
// the close-ups' own pixels.
const ans = (l: [number, number, number, number], r: [number, number, number, number], is: [string, string] = ["wall corner", "wall corner"]) =>
  JSON.stringify({
    left: { roofEdge: [l[0], l[1]], wallFace: [l[2], l[3]], wallFaceIs: is[0] },
    right: { roofEdge: [r[0], r[1]], wallFace: [r[2], r[3]], wallFaceIs: is[1] },
    why: "the fascia's bottom and the wall's top corner",
  });
const CABIN_ANSWERS = [
  ans([657, 522, 1047, 562], [628, 490, 284, 565], ["wall corner", "porch post"]),
  ans([658, 524, 1044, 572], [628, 490, 283, 568], ["wall corner", "porch post"]),
  ans([658, 525, 1045, 575], [628, 490, 284, 565], ["wall corner", "porch post"]),
];
const HOUSE_ANSWERS = [
  ans([627, 340, 787, 446], [618, 308, 490, 395]),
  ans([635, 400, 788, 442], [615, 390, 490, 395]),
  "```json\n" + ans([636, 402, 789, 390], [614, 388, 492, 396]) + "\n```",
];
// An answer on the cabin's close-ups that reads `lf` ft on the left and `rf` ft on the right: both wall
// corners where the probe's first answer put them (left window at x 142, right at 869, 6x), each roof
// end moved out from its wall by its feet at the walls' span to the 14 ft gable. A negative side puts
// the roof end inside its wall.
const WALL_L = 142 + 1047 / 6, WALL_R = 869 + 284 / 6, PX_PER_FT = (WALL_R - WALL_L) / 14;
const feetAns = (lf: number, rf: number) =>
  ans([(WALL_L - lf * PX_PER_FT - 142) * 6, 522, 1047, 562], [(WALL_R + rf * PX_PER_FT - 869) * 6, 490, 284, 565]);

Deno.test("overhangZoomPlan: the reads' most common frame, and each tip the median of theirs, as shares of the frame", () => {
  const cabin = overhangZoomPlan(CABIN_READS)!;
  assertEquals(cabin.frame, 2);
  assertEquals(overhangZoomWindows(cabin, [1280, 720]).tipL, [248, 226]);
  assertEquals(overhangZoomWindows(cabin, [1280, 720]).tipR, [975, 268]);
  const house = overhangZoomWindows(overhangZoomPlan(HOUSE_READS)!, [1280, 720]);
  assertEquals([house.tipL, house.tipR], [[470, 188], [830, 160]]);
  // A tie goes to the lower frame; a lone read on another frame does not move the tips.
  assertEquals(overhangZoomPlan([{ ...CABIN_READS[0], frame: 9 }, CABIN_READS[1]])?.frame, 2);
  assertEquals(overhangZoomPlan([...CABIN_READS, { ...CABIN_READS[0], frame: 9, left: [10, 600] }])?.frame, 2);
  // A read that gave another size lands in the same place: its points are shares of its own size.
  const scaled = { frame: 2, size: [1920, 1080], left: [372, 339], peak: [966, 162], right: [1462.5, 402] };
  assertEquals(overhangZoomWindows(overhangZoomPlan([scaled])!, [1280, 720]).tipL, [248, 226]);
});

Deno.test("overhangZoomPlan: only blocks that make a gable count, and none is no plan", () => {
  const b = CABIN_READS[0];
  for (const bad of [
    null, "x", [], {}, { ...b, frame: 0 }, { ...b, frame: 2.5 }, { ...b, frame: "2" }, { ...b, size: [0, 720] }, { ...b, size: [1280] },
    { ...b, left: ["248", 226] }, { ...b, peak: undefined },
    // left and right swapped, the peak outside the tips, y read UP (the peak below the tips)
    { ...b, left: b.right, right: b.left }, { ...b, peak: [1000, 108] }, { ...b, peak: [645, 300] },
    // a point outside the block's own size (the pitch's rule): the size given as [height, width] puts
    // the right tip at 975 of 720; a point a pixel off the top or the left
    { ...b, size: [720, 1280] }, { ...b, left: [-1, 226] }, { ...b, peak: [645, -1] }, { ...b, right: [1281, 268] },
  ]) {
    assertEquals(overhangZoomPlan([bad]), null, JSON.stringify(bad));
  }
  assertEquals(overhangZoomPlan([]), null);
  // ...and a bad block beside good ones is simply left out: the swapped size would have moved the right
  // tip to x 1733 of 1280 and taken both the roof's end and the wall corner out of the close-up.
  assertEquals(overhangZoomPlan([{ ...b, peak: [645, 300] }, CABIN_READS[1]])?.left, [248 / 1280, 228 / 720]);
  const swapped = overhangZoomPlan([b, { ...CABIN_READS[1], size: [720, 1280] }])!;
  assertEquals(overhangZoomWindows(swapped, [1280, 720]).tipR, [975, 272], "the good read's own tip, not a mean with 1733");
  // A point ON the size's edge is inside it.
  assertEquals(overhangZoomWindows(overhangZoomPlan([{ ...b, right: [1280, 268] }])!, [1280, 720]).tipR, [1280, 268]);
});

Deno.test("overhangZoomWindows: a sixth of the frame each way, centred on each tip, kept inside the frame", () => {
  const w = overhangZoomWindows(overhangZoomPlan(CABIN_READS)!, [1280, 720]);
  assertEquals([w.left, w.right], [{ x: 142, y: 166, w: 213, h: 120 }, { x: 869, y: 208, w: 213, h: 120 }]);
  // A frame of another size: the tips scale with it.
  const big = overhangZoomWindows(overhangZoomPlan(CABIN_READS)!, [1920, 1080]);
  assertEquals([big.tipL, big.left], [[372, 339], { x: 212, y: 249, w: 320, h: 180 }]);
  // A tip 12 px from the frame's edge: the window moves inside, whole-sized.
  const edge = overhangZoomWindows(overhangZoomPlan([{ ...CABIN_READS[0], left: [12, 225] }])!, [1280, 720]);
  assertEquals(edge.left, { x: 0, y: 165, w: 213, h: 120 });
  assertEquals(OVERHANG_ZOOM, 6);
});

Deno.test("overhangGableWidthFt: the width the renderer draws the gable at, less its wings", () => {
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable" }, 14, 40), { gableFt: 14, wings: false });
  // The raised-centre house: 37 ft wide, wings of 11.5 ft on both sides, a 14 ft centre gable.
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", wingSide: "both", wingWidthFt: 11.5 }, 37, 22), { gableFt: 14, wings: true });
  // No side given is both sides, as the renderer draws it; one named eave side is one wing.
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", wingWidthFt: 11.5 }, 37, 22)?.gableFt, 14);
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", wingSide: "left", wingWidthFt: 10 }, 37, 22)?.gableFt, 27);
  // An eave front: the gable spans the depth, and its wings run along the front and back.
  assertEquals(overhangGableWidthFt({ type: "gable", front: "eave" }, 40, 14), { gableFt: 14, wings: false });
  assertEquals(overhangGableWidthFt({ type: "gable", front: "eave", wingSide: "front", wingWidthFt: 4 }, 40, 22), { gableFt: 18, wings: true });
  assertEquals(overhangGableWidthFt({ type: "gable", front: "eave", wingSide: "both", wingWidthFt: 4 }, 40, 22)?.gableFt, 14);
  // A wing on a side that is not an eave side is not drawn, so it takes nothing off.
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", wingSide: "front", wingWidthFt: 8 }, 37, 22), { gableFt: 37, wings: false });
  assertEquals(overhangGableWidthFt({ type: "gable", front: "eave", wingSide: "left", wingWidthFt: 8 }, 40, 22), { gableFt: 22, wings: false });
  // The renderer's caps: at most 16 ft a wing, a centre of at least 4 ft, nothing at half a foot or less.
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", wingSide: "both", wingWidthFt: 20 }, 40, 22)?.gableFt, 8);
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", wingSide: "both", wingWidthFt: 12 }, 20, 22)?.gableFt, 4);
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", wingSide: "both", wingWidthFt: 0.5 }, 37, 22), { gableFt: 37, wings: false });
  // Without a front, the old rule: the gable spans the width when the depth is at least the width.
  assertEquals(overhangGableWidthFt({ type: "gable" }, 14, 40)?.gableFt, 14);
  assertEquals(overhangGableWidthFt({ type: "gable" }, 40, 14)?.gableFt, 14);
  // Anything but a gable, or no real size: no ruler.
  for (const [roof, w, l] of [[{ type: "shed" }, 16, 10], [{ type: "gambrel", front: "gable" }, 16, 24], [null, 14, 40], [{ type: "gable" }, 0, 40], [{ type: "gable" }, 14, NaN]] as const) {
    assertEquals(overhangGableWidthFt(roof as Record<string, unknown> | null, w, l), null, JSON.stringify([roof, w, l]));
  }
  // A lean-to (over half a foot, the renderer's own test) is no ruler either: drawn off an eave side,
  // outside the footprint, it runs the roof on past one wall of the gable end, and this width knows
  // nothing of it. Half a foot or less is not drawn, so it changes nothing.
  for (const lean of [{ leanToWidthFt: 8, leanToSide: "right" }, { leanToWidthFt: 0.6, leanToSide: "left" }, { leanToWidthFt: "8" }]) {
    const roof = { type: "gable", front: "gable", ...lean };
    assertEquals(overhangGableWidthFt(roof, 12, 20), null, JSON.stringify(roof));
  }
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", leanToWidthFt: 0.5, leanToSide: "right" }, 12, 20), { gableFt: 12, wings: false });
  assertEquals(overhangGableWidthFt({ type: "gable", front: "gable", leanToWidthFt: 0 }, 12, 20), { gableFt: 12, wings: false });
});

Deno.test("overhangZoomPrompt: the probe's words, the wing sentence only with wings, and the close-up's size", () => {
  const plain = overhangZoomPrompt(false, 1278, 720), winged = overhangZoomPrompt(true, 1278, 720);
  assert(plain.startsWith("These two images are close-ups, each enlarged 6 times, cut from ONE photo of a portable building"));
  assert(plain.includes("each close-up is 1278 pixels wide and 720 tall"));
  assert(!plain.includes("lower side wings"));
  assert(winged.includes("to the left of the second. This building has lower side wings: the gable is the taller CENTRE section's"));
  assertEquals(winged.replace(" This building has lower side wings: the gable is the taller CENTRE section's, so the wall you want is the centre section's own wall where it rises above the wing roof, and the roof edge is the centre roof's, never the lower wing roof's edge.", ""), plain);
  // Plain line breaks whatever this file's checkout does, and the two paragraphs the model was taught with.
  assert(!plain.includes("\r"));
  assertEquals(plain.split("\n").length, 7);
  for (const must of [
    "Use the board's own face, not the thin metal drip edge",
    "the corner nearer the middle of the gable: never the far edge of the side-wall strip",
    "If this end of the building is an open porch under the main roof, with a post at the corner, use that post's outer face instead.",
    '"wallFaceIs": "wall corner" | "porch post" | "not in view"',
  ]) assert(plain.includes(must), must);
});

Deno.test("overhangAskFeet: the probe's own answers, each side's gap over the wall-to-wall span times the gable", () => {
  const cabin = overhangZoomWindows(overhangZoomPlan(CABIN_READS)!, [1280, 720]);
  // Left: roof 142 + 657/6 = 251.5, wall 142 + 1047/6 = 316.5; right: wall 869 + 284/6, roof 869 + 628/6.
  const a = overhangAskFeet(CABIN_ANSWERS[0], cabin, 1280, 14);
  assert("ft" in a, JSON.stringify(a));
  const span = (869 + 284 / 6) - 316.5;
  assertAlmostEquals(a.ft, ((65 / span) * 14 + ((628 - 284) / 6 / span) * 14) / 2, 1e-9);
  assertEquals([a.left, a.right], [1.517, 1.338]);
  const house = overhangZoomWindows(overhangZoomPlan(HOUSE_READS)!, [1280, 720]);
  const h = HOUSE_ANSWERS.map((t) => overhangAskFeet(t, house, 1280, 14));
  assertEquals(h.map((x) => ("ft" in x ? Math.round(x.ft * 1000) / 1000 : x.why)), [1.082, 1.045, 1.033], "a fenced reply reads too");
});

Deno.test("overhangAskFeet: every rejection, with its reason", () => {
  const w = overhangZoomWindows(overhangZoomPlan(CABIN_READS)!, [1280, 720]);
  const why = (t: string | null, frameW = 1280) => {
    const r = overhangAskFeet(t, w, frameW, 14);
    return "why" in r ? r.why : r.ft;
  };
  assertEquals(why(null), "unparsed");
  assertEquals(why("no json here"), "unparsed");
  assertEquals(why("{ not json }"), "unparsed");
  assertEquals(why('{"left": {"roofEdge": [657, 522], "wallFace": [1047, 562]}}'), "no point");
  assertEquals(why(ans([657, 522, 1047, 562], [628, 490, 284, 565]).replace('"roofEdge":[628,490]', '"roofEdge":"628,490"')), "no point");
  // A point outside its close-up (1278 x 720) was not read off it.
  assertEquals(why(ans([657, 522, 1300, 562], [628, 490, 284, 565])), "no point");
  assertEquals(why(ans([657, 522, 1047, 562], [628, 490, 284, -3])), "no point");
  assertEquals(why(ans([657, 522, 1047, 562], [628, 490, 284, 565], ["wall corner", "not in view"])), "not in view");
  // The right wall left of the left one.
  const crossed = overhangAskFeet(ans([657, 522, 1047, 562], [628, 490, 284, 565]), { left: w.left, right: { ...w.right, x: 200 } }, 1280, 14);
  assertEquals("why" in crossed && crossed.why, "no span");
  // A roof end on the frame's border: the corner is cut off by the frame.
  const atEdge = { left: { x: 0, y: 165, w: 213, h: 120 }, right: w.right };
  assertEquals("why" in overhangAskFeet(ans([3, 475, 312, 450], [628, 490, 284, 565]), atEdge, 1280, 14) ? "rejected" : "kept", "rejected");
  assertEquals(overhangAskFeet(ans([6, 475, 312, 450], [628, 490, 284, 565]), atEdge, 1280, 14), { why: "at the border" });
  assertEquals("ft" in overhangAskFeet(ans([12, 475, 312, 450], [628, 490, 284, 565]), atEdge, 1280, 14), true, "2 px in is not the border");
  assertEquals(why(ans([657, 522, 1047, 562], [628, 490, 284, 565]), 869 + 628 / 6 + 1.5), "at the border");
  // LOPSIDED: the side-eave mistake reads one side at about nothing. Kept at 0.64 of the other side,
  // dropped under half of it once the larger side is 0.25 ft or more.
  const lop = overhangAskFeet(ans([657, 522, 1047, 562], [628, 490, 600, 565]), w, 1280, 14);
  assertEquals("why" in lop && lop.why, "lopsided");
  assert("left" in lop && lop.left! > 1.3 && lop.right! < 0.15, "and both sides are kept for the record");
  // Both sides small is a tight eave, not a lopsided one.
  const tight = overhangAskFeet(ans([1030, 522, 1047, 562], [300, 490, 284, 565]), w, 1280, 14);
  assert("ft" in tight && tight.ft < 0.25, JSON.stringify(tight));
});

Deno.test("overhangAskFeet: a roof end INSIDE its wall is a point on the wrong thing, and the checks' edges", () => {
  const w = overhangZoomWindows(overhangZoomPlan(CABIN_READS)!, [1280, 720]);
  const read = (t: string) => {
    const r = overhangAskFeet(t, w, 1280, 14);
    return "why" in r ? r.why : "kept";
  };
  // The builder helper reads what it was built to.
  const built = overhangAskFeet(feetAns(1.2, 0.9), w, 1280, 14);
  assert("ft" in built && Math.abs(built.left - 1.2) < 1e-3 && Math.abs(built.right - 0.9) < 1e-3, JSON.stringify(built));
  // The left roof end 1.4 ft inside its wall beside a right one 0.04 ft out: the larger side is under
  // 0.25 ft, so the lopsided check alone kept it, at -0.69 ft, and a verdict beside one good answer
  // wrote 4 in and locked it from the self-check.
  const wrong = overhangAskFeet(ans([1100, 522, 700, 562], [300, 490, 290, 565]), w, 1280, 14);
  assertEquals(wrong, { why: "inside the wall", left: -1.417, right: 0.035 });
  // Both sides half a foot inside, and one side just over the 0.1 ft allowance.
  assertEquals(read(feetAns(-0.538, -0.538)), "inside the wall");
  assertEquals(read(feetAns(-0.11, 0.1)), "inside the wall");
  assertEquals(read(feetAns(0.1, -0.11)), "inside the wall");
  // A flush eave's trim may read a hair inside: kept.
  assertEquals(read(feetAns(-0.09, 0.1)), "kept");
  assertEquals(read(feetAns(-0.09, -0.09)), "kept");
  assertEquals(OVERHANG_INSIDE_MAX_FT, 0.1);
  // LOPSIDED at its edges: the smaller side under half the larger (0.49 of it) is dropped, over half
  // (0.51) kept, once the larger is 0.25 ft or more; at 0.24 ft both sides are a tight eave.
  assertEquals([OVERHANG_LOPSIDED_RATIO, OVERHANG_LOPSIDED_MIN_FT], [0.5, 0.25]);
  assertEquals(read(feetAns(1, 0.49)), "lopsided");
  assertEquals(read(feetAns(0.49, 1)), "lopsided");
  assertEquals(read(feetAns(1, 0.51)), "kept");
  assertEquals(read(feetAns(0.26, 0.1)), "lopsided");
  assertEquals(read(feetAns(0.24, 0.1)), "kept");
});

Deno.test("overhangZoomVerdict: the median of at least two kept answers, to the nearest inch, held to 0..3 ft", () => {
  const cabin = overhangZoomWindows(overhangZoomPlan(CABIN_READS)!, [1280, 720]);
  const v = overhangZoomVerdict(CABIN_ANSWERS, cabin, 1280, 14);
  assertEquals([v.overhangFt, v.kept], [17 / 12, 3], "the cabin reads 17 in (truth about 16)");
  const house = overhangZoomWindows(overhangZoomPlan(HOUSE_READS)!, [1280, 720]);
  assertEquals(overhangZoomVerdict(HOUSE_ANSWERS, house, 1280, 14).overhangFt, 13 / 12, "the house reads 13 in (truth 12)");
  // One kept answer is not enough: the consensus's overhang stands.
  const one = overhangZoomVerdict([CABIN_ANSWERS[0], null, "garbage"], cabin, 1280, 14);
  assertEquals([one.overhangFt, one.kept, one.asks.map((a) => ("why" in a ? a.why : "kept"))], [null, 1, ["kept", "unparsed", "unparsed"]]);
  // Two of three kept (one lopsided) is enough.
  const two = overhangZoomVerdict([CABIN_ANSWERS[0], ans([657, 522, 1047, 562], [628, 490, 600, 565]), CABIN_ANSWERS[1]], cabin, 1280, 14);
  assertEquals([two.overhangFt, two.kept], [17 / 12, 2]);
  // Roofs well inside their walls are not an overhang of 0: both asks are dropped, and the consensus's
  // overhang stands.
  const inside = ans([1100, 522, 1047, 562], [250, 490, 284, 565]);
  const none = overhangZoomVerdict([inside, inside], cabin, 1280, 14);
  assertEquals([none.overhangFt, none.kept, none.asks.map((a) => ("why" in a ? a.why : "kept"))], [null, 0, ["inside the wall", "inside the wall"]]);
  // One wrong-side answer beside a good one no longer halves the cabin's 17 in to 4 (and locks it).
  const wrong = ans([1100, 522, 700, 562], [300, 490, 290, 565]);
  const beside = overhangZoomVerdict([CABIN_ANSWERS[0], wrong, null], cabin, 1280, 14);
  assertEquals([beside.overhangFt, beside.kept], [null, 1]);
  const twoIn = overhangZoomVerdict([feetAns(-0.538, -0.538), feetAns(-0.538, -0.538), CABIN_ANSWERS[0]], cabin, 1280, 14);
  assertEquals([twoIn.overhangFt, twoIn.kept], [null, 1]);
  // Held to 0..3 ft: a flush eave whose trim reads a hair inside is 0, and a ruler gone wrong at most 3.
  assertEquals(overhangZoomVerdict([feetAns(-0.05, -0.05), feetAns(-0.05, -0.05)], cabin, 1280, 14).overhangFt, 0);
  assertEquals(overhangZoomVerdict(CABIN_ANSWERS, cabin, 1280, 60).overhangFt, 3);
  // The MEDIAN, not the mean: 1.0, 1.1 and 2.0 ft is 13 in (the mean would be 16).
  assertEquals(overhangZoomVerdict([feetAns(1, 1), feetAns(2, 2), feetAns(1.1, 1.1)], cabin, 1280, 14).overhangFt, 13 / 12);
});

Deno.test("readDraftReply: a gable read's pitch points ride on the reading, whatever became of its pitch", () => {
  const text = (roof: Record<string, unknown>, pitch: unknown = CABIN_READS[0]) => JSON.stringify({
    measure: { pitch },
    roof: { type: "gable", front: "gable", pitch: 0.4, overhangIn: 6, eave: "fascia", ...roof },
    siding: "batten", colors: { body: "#555555" },
  });
  const body = (t: string) => JSON.stringify({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
  const dims = { widthFt: 14, lengthFt: 40, wallHeightFt: 7.75 };
  const read = readDraftReply(body(text({})), dims, true);
  assertEquals(read.pitchPoints, CABIN_READS[0]);
  assertEquals(read.pitch?.pitchSource, "points");
  // Points the pitch refused (y up) still ride along: the close-up's plan judges them on its own terms.
  const yUp = { ...CABIN_READS[0], peak: [645, 400] };
  const refused = readDraftReply(body(text({}, yUp)), dims, true);
  assertEquals([refused.pitchPoints, refused.pitch?.pitchRejected], [yUp, true]);
  // No points, a shed, a legacy read: none.
  assertEquals(readDraftReply(body(JSON.stringify({ roof: { type: "gable", pitch: 0.4 }, siding: "batten", colors: {} })), dims, true).pitchPoints, undefined);
  assertEquals(readDraftReply(body(text({ type: "shed", highSide: "front", front: undefined })), dims, true).pitchPoints, undefined);
  assertEquals(readDraftReply(body(text({})), dims, false).pitchPoints, undefined);
});

// ─── The whole close-up, with a stand-in for the frame and the Messages API ─────────────────────
// A 1280 by 720 frame drawn like the cabin's gable end: sky, the gable wall from x 316 to 916 below
// y 230, and the roof's eave band from x 251 to 974 between y 214 and 232 (1-based pixels). `s`
// draws the same picture `s` times the size (1.5: a 1920 by 1080 frame).
const frameJpeg = async (s = 1) => {
  const { Image } = await imagescript();
  const px = (v: number) => Math.round(v * s);
  const img = new Image(px(1280), px(720));
  img.fill(Image.rgbaToColor(120, 170, 220, 255));
  for (let y = px(230); y <= px(720); y++) for (let x = px(316); x <= px(916); x++) img.setPixelAt(x, y, Image.rgbaToColor(150, 40, 40, 255));
  for (let y = px(214); y <= px(232); y++) for (let x = px(251); x <= px(974); x++) img.setPixelAt(x, y, Image.rgbaToColor(20, 20, 20, 255));
  return await img.encodeJPEG(95);
};
const fakeFetch = (frame: Uint8Array | null, replies: (string | null)[], onFrame?: () => void) => {
  const sent: Record<string, unknown>[] = [];
  const frames: string[] = [];
  let n = 0;
  // deno-lint-ignore require-await
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.anthropic.com/")) {
      sent.push(JSON.parse(String(init?.body)));
      const text = replies[n++ % replies.length];
      if (text === null) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
      return new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "" }, { type: "text", text }], usage: { input_tokens: 3300, output_tokens: 900 } }), { status: 200 });
    }
    frames.push(u);
    onFrame?.();
    return frame ? new Response(frame as BodyInit, { status: 200 }) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fn, sent, frames };
};
const CABIN_ROOF = { type: "gable", front: "gable", pitch: 0.52, overhang: 0.5, eave: "fascia", porchDepthFt: 6 };
const RUN = (over: Partial<Parameters<typeof runOverhangZoom>[0]> = {}) => ({
  blocks: [...CABIN_READS, null], photoUrls: Array.from({ length: 12 }, (_, i) => `https://x/frame-${i + 1}.jpg`),
  roof: CABIN_ROOF, widthFt: 14, lengthFt: 40, leftMs: 200_000, apiKey: "k", model: { model: "m" },
  signal: new AbortController().signal, ...over,
});

Deno.test({ name: "runOverhangZoom: both corners cut from the reads' frame, asked together three times, and the median lands", ignore: !NET, fn: async () => {
  const f = fakeFetch(await frameJpeg(), CABIN_ANSWERS);
  const z = await runOverhangZoom(RUN({ fetchFn: f.fn }));
  assertEquals(z.overhangFt, 17 / 12);
  assertEquals([z.input, z.output], [3 * 3300, 3 * 900]);
  assertEquals(f.frames, ["https://x/frame-2.jpg"], "the frame the reads used, fetched once");
  const r = z.record!;
  assertEquals([r.frame, r.gableFt, r.before, r.after, r.used], [2, 14, 0.5, 17 / 12, 3]);
  assertEquals(r.tips, { left: [248, 226], right: [975, 268] });
  assertEquals(r.usage, { input: 9900, output: 2700 });
  assertEquals((r.asks as Record<string, unknown>[]).map((a) => [a.left, a.right]), [[1.517, 1.338], [1.501, 1.341], [1.505, 1.337]]);
  assert(typeof r.ms === "number" && !("error" in r));
  // OVERHANG_ZOOM_ASKS asks, each the left close-up, the right one and the prompt, on the model it was handed.
  assertEquals(f.sent.length, OVERHANG_ZOOM_ASKS);
  const body = f.sent[0] as { model: string; max_tokens: number; output_config: unknown; messages: { content: { type: string; text?: string; source?: { data: string } }[] }[] };
  const content = body.messages[0].content;
  assertEquals([body.model, body.max_tokens, body.output_config], ["m", OVERHANG_ZOOM_MAX_TOKENS, { effort: "high" }]);
  assertEquals(content.map((c) => c.type), ["image", "image", "text"]);
  assertEquals(content[2].text, overhangZoomPrompt(false, 1278, 720), "the cabin has no wings");
  // The FIRST close-up is the left corner: the eave band ends 109 px in (251 - 142, times 6 is ~654).
  const { Image } = await imagescript();
  const left = await Image.decode(Uint8Array.from(atob(content[0].source!.data), (ch) => ch.charCodeAt(0)));
  const right = await Image.decode(Uint8Array.from(atob(content[1].source!.data), (ch) => ch.charCodeAt(0)));
  assertEquals([left.width, left.height, right.width, right.height], [1278, 720, 1278, 720]);
  const dark = (img: typeof left, x: number, y: number) => Image.colorToRGBA(img.getPixelAt(x, y))[0] < 60;
  // Row 57 of the frame's band (y 223) is close-up row (223 - 166) x 6 in the left window.
  assert(!dark(left, 600, 342) && dark(left, 700, 342), "left: sky, then the band from ~654");
  assert(dark(right, 500, 90) && !dark(right, 700, 90), "right: the band, then sky past ~630");
} });

Deno.test({ name: "runOverhangZoom: the wing sentence on a centre gable, and answers that do not hold keep the consensus's", ignore: !NET, fn: async () => {
  const house = { type: "gable", front: "gable", pitch: 0.55, overhang: 0.5, wingSide: "both", wingWidthFt: 11.5, wingPitch: 0.2, centerEaveFt: 13 };
  const f = fakeFetch(await frameJpeg(), HOUSE_ANSWERS);
  const z = await runOverhangZoom(RUN({ fetchFn: f.fn, blocks: HOUSE_READS, roof: house, widthFt: 37, lengthFt: 22 }));
  assertEquals([z.overhangFt, z.record?.gableFt, z.record?.frame], [13 / 12, 14, 7]);
  const text = (f.sent[0] as { messages: { content: { text?: string }[] }[] }).messages[0].content[2].text;
  assertEquals(text, overhangZoomPrompt(true, 1278, 720));
  // Two asks turned away and one lopsided answer: nothing to use, the consensus's overhang stands.
  const g = fakeFetch(await frameJpeg(), [null, ans([657, 522, 1047, 562], [628, 490, 600, 565]), null]);
  const none = await runOverhangZoom(RUN({ fetchFn: g.fn }));
  assertEquals([none.overhangFt, none.record?.after, none.record?.used], [null, null, 0]);
  assertEquals((none.record?.asks as Record<string, unknown>[]).map((a) => a.why), ["unparsed", "lopsided", "unparsed"]);
  assertEquals([none.input, none.output], [3300, 900], "only the ask that answered is counted");
} });

Deno.test("runOverhangZoom: not a gable, no usable points, no such frame, or too little time is no close-up and no call", async () => {
  const f = fakeFetch(null, CABIN_ANSWERS);
  for (const over of [
    { blocks: [null, {}] }, { blocks: [{ ...CABIN_READS[0], peak: [645, 400] }] }, { roof: { ...CABIN_ROOF, type: "shed", highSide: "front" } },
    { roof: { ...CABIN_ROOF, type: "gambrel" } }, { photoUrls: ["https://x/1.jpg"] }, { leftMs: OVERHANG_ZOOM_MIN_LEFT_MS - 1 }, { widthFt: 0 },
    { roof: { ...CABIN_ROOF, leanToWidthFt: 8, leanToSide: "right" } },
  ]) {
    const z = await runOverhangZoom(RUN({ ...over, fetchFn: f.fn }));
    assertEquals(z, { overhangFt: null, record: null, input: 0, output: 0 }, JSON.stringify(over));
  }
  assertEquals([f.sent.length, f.frames.length], [0, 0]);
  // A frame that will not load is recorded, costs nothing and changes nothing.
  const z = await runOverhangZoom(RUN({ fetchFn: f.fn }));
  assertEquals([z.overhangFt, z.record?.error, z.record?.after, z.record?.before, z.input], [null, "the frame answered 404", null, 0.5, 0]);
  assertEquals(f.sent.length, 0);
});

Deno.test("runOverhangZoom: the draft's time running out during the cut stops it there, recorded, with no ask sent", async () => {
  // The frame's fetch returns just as the draft's signal fires: the cut is never waited for (the image
  // library's own load takes no signal and once held a draft 11 s past its deadline), no ask goes out.
  const c = new AbortController();
  const f = fakeFetch(new Uint8Array([0xff, 0xd8, 0xff]), CABIN_ANSWERS, () => c.abort(new DOMException("Signal timed out.", "TimeoutError")));
  const t = Date.now();
  const z = await runOverhangZoom(RUN({ fetchFn: f.fn, signal: c.signal }));
  assert(Date.now() - t < 1_000, `returned ${Date.now() - t} ms later`);
  assertEquals([z.overhangFt, z.record?.error, z.record?.after, z.input, z.output], [null, "Signal timed out.", null, 0, 0]);
  assertEquals([f.frames.length, f.sent.length], [1, 0]);
});

Deno.test({ name: "runOverhangZoom: a 1920 x 1080 frame is cut, placed and bordered by its REAL size, not the reads'", ignore: !NET, fn: async () => {
  // The reads gave their points in 1280 x 720; the frame is 1920 x 1080. The tips scale to (372, 339)
  // and (1462.5, 402), the windows to 320 x 180 at x 212 and 1303, and each close-up is 1920 x 1080.
  // The answers put the corners where the probe's first cabin answer did, 1.5 times further out.
  const at = (winX: number, frameX: number) => (frameX - winX) * 6;
  const big = (y: number) => ans([at(212, 377.25), y, at(212, 474.75), y + 40], [at(1303, 1460.5), y, at(1303, 1374.5), y + 40], ["wall corner", "porch post"]);
  const f = fakeFetch(await frameJpeg(1.5), [big(500), big(510), big(520)]);
  const z = await runOverhangZoom(RUN({ fetchFn: f.fn }));
  assertEquals(z.overhangFt, 17 / 12, "the same cabin, read on the bigger frame");
  assertEquals(z.record?.tips, { left: [372, 339], right: [1463, 402] });
  assertEquals((z.record?.asks as Record<string, unknown>[]).map((a) => [a.left, a.right]), [[1.517, 1.338], [1.517, 1.338], [1.517, 1.338]]);
  const content = (f.sent[0] as { messages: { content: { text?: string; source?: { data: string } }[] }[] }).messages[0].content;
  assertEquals(content[2].text, overhangZoomPrompt(false, 1920, 1080), "the close-ups' own size in the prompt");
  const { Image } = await imagescript();
  const left = await Image.decode(Uint8Array.from(atob(content[0].source!.data), (ch) => ch.charCodeAt(0)));
  const right = await Image.decode(Uint8Array.from(atob(content[1].source!.data), (ch) => ch.charCodeAt(0)));
  assertEquals([left.width, left.height, right.width, right.height], [1920, 1080, 1920, 1080]);
  const dark = (img: typeof left, x: number, y: number) => Image.colorToRGBA(img.getPixelAt(x, y))[0] < 60;
  // The band (frame rows 321-348) ends at frame x 376.5 on the left, close-up x ~987, and at 1461 on
  // the right, close-up x ~948.
  assert(!dark(left, 900, 500) && dark(left, 1100, 500), "left: sky, then the band from ~987");
  assert(dark(right, 850, 130) && !dark(right, 1050, 130), "right: the band, then sky past ~948");
  // THE BORDER is the real frame's: reads whose right tip is 5 px from their frame's edge put the right
  // window at x 1600, up against the 1920 px frame's edge. A roof end at frame x 1919 is on the border
  // and dropped; one at 1860 (a wall corner at 1800) is kept, though both lie past 1280.
  const edge = [{ ...CABIN_READS[0], peak: [760, 108], right: [1275, 268] }, { ...CABIN_READS[1], peak: [760, 108], right: [1275, 268] }];
  const side = (roofX: number) => ans([at(212, 377.25), 500, at(212, 474.75), 540], [at(1600, roofX), 500, at(1600, 1800), 540]);
  const g = fakeFetch(await frameJpeg(1.5), [side(1919), side(1860), side(1860)]);
  const e = await runOverhangZoom(RUN({ fetchFn: g.fn, blocks: edge }));
  assertEquals((e.record?.asks as Record<string, unknown>[]).map((a) => a.why ?? "kept"), ["at the border", "kept", "kept"]);
  assertEquals([e.overhangFt, e.record?.used], [10 / 12, 2]);
} });
