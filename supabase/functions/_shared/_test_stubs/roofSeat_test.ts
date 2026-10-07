// THE ROOF RAISED BY THE RAFTER (roof.seat, roof.rafterDepthIn; 2026-10-06, Carolyn's Q28: "make it an
// option in the designer setup for each design: roof on the plate, or raised by the rafter height").
//
// WHAT IS BEING PINNED. "Raised" stands the whole shell, the walls and the roof together, one rafter
// above the wall plate, and it does that through ONE seam: every place that turns the wall height into
// wall, roof, vent or appendage geometry reads it through d3ShellFt. Three things have to stay true:
//
//   1. With nothing set, d3ShellFt hands back its own argument, the same value of the same type. That is
//      what keeps every stored style drawing exactly as it did (the stored-style digest checks the
//      pixels' geometry; this checks the rule that guarantees it).
//   2. The inside of the building keeps the true plate: partition walls, ceiling fittings and lofts
//      stand on the walls, not under the roof. So do the price and the wall-height boxes and words.
//   3. No read slips through unclassified. A raw `wallHeightFt || D3.WALL_H` that should have been the
//      shell draws a vent, a lean-to or a readout one rafter away from the 3D, but only on a raised
//      style, which is the kind of disagreement nobody sees until a customer does. The allow-list guard
//      at the bottom fails the moment a new raw read appears in either twin, until someone decides
//      which side of the seam it is on.
//
// HOW. The slice-and-run idiom of overhangStyle_test and loftHeight_test: the shipped text is LIFTED
// between stable anchors and executed, both twins byte-identical. Nothing is copied out.
//
// ⚠️ WHAT THIS DOES NOT PROVE: that the meshes really move together. tests/harness/roofSeat.mjs measures
// that in the browser (needs a static server; manual), and the stored-style digest proves the default.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));
const STYLE_D3 = await Deno.readTextFile(new URL("../styleD3.ts", import.meta.url));
const SCORE = await Deno.readTextFile(new URL("../../../../dev/score.mjs", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `roofSeat_test: could not find ${JSON.stringify(start)} .. ${JSON.stringify(end)} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}
/** Comments out, so an assertion about CODE is not satisfied by a comment that mentions it. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ");

const TWINS: Array<[string, string]> = [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]];

// ── 1. the helpers ──────────────────────────────────────────────────────────────────────────────
const HELPERS = ["function d3SeatApplies(", "function d3WingListDeep("];
Deno.test("the seat helpers are byte-identical in the two twins, inside the lifted roof region", () => {
  assertEquals(lift(JSX, "StructureStudio.jsx", HELPERS[0], HELPERS[1]), lift(CMP, "structure-studio.component.js", HELPERS[0], HELPERS[1]));
  // Inside d3RoofAxes .. d3FtIn: the readouts there call d3ShellFt, and every test and the stored-style
  // digest that evaluates that region must find it in the same slice.
  const region = lift(CMP, "structure-studio.component.js", "function d3RoofAxes(", "function d3FtIn(");
  assert(region.includes(HELPERS[0]) && region.includes("function d3ShellFt("), "the helpers sit in the lifted region");
  // Literals inside the functions: no module-level const for the band or the default.
  const block = lift(CMP, "structure-studio.component.js", HELPERS[0], HELPERS[1]);
  assertEquals(codeOnly(block).split("\n").filter((l) => /^(const|let|var) /.test(l)), [], "no top-level binding");
});

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["function d3RoofAxes(", "function d3FtIn("],
  // The porch, lean-to and recessed-porch readouts, which sit after d3FtIn and read the shell too.
  ["function d3FtIn(", "function D3ElevationSVG("],
  ["function ssVentSpan(", "function buildFixtureTools("],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));
Deno.test("every lifted region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});
// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; ` +
    "return { D3, d3SeatApplies, d3SeatLiftFt, d3ShellFt, d3ModelTopFt, d3Massing, d3DormerReadout, d3LeanToReadout, d3PorchReadout, ssGableVentFit };",
)() as Record<string, Any>;

// The band, read from the SERVER's text, so the two copies cannot drift apart silently.
const band = (() => {
  const m = /\n\s*rafterDepthIn:\s*\[([\d.]+),\s*([\d.]+)\]/.exec(STYLE_D3);
  if (!m) throw new Error("roofSeat_test: CLAMPS.rafterDepthIn is not in styleD3.ts");
  return [Number(m[1]), Number(m[2])];
})();

// ── 2. absent is today's roof, value AND type ───────────────────────────────────────────────────
Deno.test("on the plate, d3ShellFt hands back its own argument untouched", () => {
  const cases: Any[] = [
    undefined, null, {}, { type: "gable", pitch: 0.4 },
    { seat: "plate" }, { seat: "plate", rafterDepthIn: 7.25 },
    { seat: "Raised" }, { seat: true }, { seat: 1 }, { seat: "" },
    { rafterDepthIn: 5.5 },                          // a rafter with no seat
  ];
  for (const r of cases) {
    assertEquals(F.d3SeatLiftFt(r), 0, JSON.stringify(r));
    for (const x of [8, 9.5, "8", 0, undefined]) {
      assert(Object.is(F.d3ShellFt(r, x), x), `${JSON.stringify(r)} with ${JSON.stringify(x)}`);
    }
  }
});

// ── 3. raised ───────────────────────────────────────────────────────────────────────────────────
Deno.test("raised lifts by the rafter: blank is a 2x4's 3.5 in, and the band is the server's", () => {
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised" }), 3.5 / 12, 1e-12);
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised", rafterDepthIn: "" }), 3.5 / 12, 1e-12, "a blank box");
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised", rafterDepthIn: null }), 3.5 / 12, 1e-12);
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised", rafterDepthIn: "abc" }), 3.5 / 12, 1e-12, "junk draws the default");
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised", rafterDepthIn: 5.5 }), 5.5 / 12, 1e-12, "a 2x6");
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised", rafterDepthIn: 7.25 }), 7.25 / 12, 1e-12, "a 2x8");
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised", rafterDepthIn: "5.5" }), 5.5 / 12, 1e-12, "a numeric string");
  assertEquals(band, [1.5, 12], "CLAMPS.rafterDepthIn");
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised", rafterDepthIn: 0.5 }), band[0] / 12, 1e-12, "raised to the floor of the band");
  assertAlmostEquals(F.d3SeatLiftFt({ seat: "raised", rafterDepthIn: 40 }), band[1] / 12, 1e-12, "lowered to the top of the band");
  // The shell is a NUMBER even when the plate arrives as a string, and never "8" + lift.
  const s = F.d3ShellFt({ seat: "raised" }, "8");
  assertEquals(typeof s, "number");
  assertAlmostEquals(s, 8 + 3.5 / 12, 1e-12);
});

Deno.test("v1: a style with wings stays on the plate, whatever it says", () => {
  const wings = { type: "gable", pitch: 0.4, seat: "raised", rafterDepthIn: 5.5, wingWidthFt: 8 };
  assertEquals(F.d3SeatApplies(wings), false);
  assertEquals(F.d3SeatLiftFt(wings), 0);
  assert(Object.is(F.d3ShellFt(wings, 9), 9));
  const listed = { type: "gable", pitch: 0.4, seat: "raised", wingList: [{ wall: "left", widthFt: 8 }] };
  assertEquals(F.d3SeatApplies(listed), false, "a wing list");
  assertEquals(F.d3SeatLiftFt(listed), 0);
  // Half a foot or less is no wing, the appendage rule everywhere else.
  assertEquals(F.d3SeatApplies({ type: "gable", wingWidthFt: 0.5 }), true);
  assertEquals(F.d3SeatApplies({ type: "gable", wingList: [{ wall: "left", widthFt: 0.4 }] }), true);
});

Deno.test("the readouts move with the shell: the model's top, the porch's wall, the lean-to and the dormer", () => {
  const roof = { type: "gable", pitch: 0.4, overhang: 1 };
  const lift = 5.5 / 12;
  const raised = { ...roof, seat: "raised", rafterDepthIn: 5.5 };
  const top0 = F.d3ModelTopFt({ roof, wallHeightFt: 8 }, 12, 16), top1 = F.d3ModelTopFt({ roof: raised, wallHeightFt: 8 }, 12, 16);
  assertAlmostEquals(top1 - top0, lift, 1e-9, "the peak");
  // A projecting porch's readout reads the wall it stands on: the shell.
  const porch = { ...roof, porchOutFt: 6, porchEnd: "front" };
  const p0 = F.d3PorchReadout({ roof: porch, wallHeightFt: 8 }, "12x16");
  const p1 = F.d3PorchReadout({ roof: { ...porch, seat: "raised", rafterDepthIn: 5.5 }, wallHeightFt: 8 }, "12x16");
  assert(p0 && p1, "a porch is read");
  assertEquals(JSON.stringify(F.d3PorchReadout({ roof: { ...porch, seat: "plate" }, wallHeightFt: 8 }, "12x16")), JSON.stringify(p0), "plate is today's");
  assertAlmostEquals(p1.wallTop - p0.wallTop, lift, 1e-9, "the porch's wall top");
  assertAlmostEquals(p1.yHigh - p0.yHigh, lift, 1e-9, "where the porch roof meets the wall");
  // A lean-to set on the wall, a foot down from the eave: the eave and its roof move up together.
  const lt = { ...roof, leanToWidthFt: 6, leanToDropFt: 1, leanToSide: "right", leanToAttach: "wall", leanToAttachFt: 1 };
  const l0 = F.d3LeanToReadout({ roof: lt, wallHeightFt: 8 }, "12x16"), l1 = F.d3LeanToReadout({ roof: { ...lt, seat: "raised", rafterDepthIn: 5.5 }, wallHeightFt: 8 }, "12x16");
  assert(l0 && l1, "a lean-to is read");
  assertAlmostEquals(l1.E - l0.E, lift, 1e-9, "the lean-to's eave");
  assertAlmostEquals(l1.ya - l0.ya, lift, 1e-9, "where its roof meets the wall");
  assertEquals(l1.at, l0.at, "measured down from the eave, the same distance");
  // A transom dormer is measured on the shell's roof: the same face, a rafter higher.
  const dorm = { ...roof, dormerWidthFt: 6, dormerType: "transom", dormerRiseFt: 2 };
  const d0 = F.d3DormerReadout({ roof: dorm, wallHeightFt: 8 }, "12x16"), d1 = F.d3DormerReadout({ roof: { ...dorm, seat: "raised", rafterDepthIn: 5.5 }, wallHeightFt: 8 }, "12x16");
  assert(d0 && d1, "a transom dormer is read");
  assertAlmostEquals(d1.face, d0.face, 1e-9, "the dormer's face");
  assertAlmostEquals(d1.yTop - d0.yTop, lift, 1e-9, "a rafter up");
});

Deno.test("a gable vent fitted on the shell sits a rafter higher, at the same rise above the wall", () => {
  const roof = { type: "gable", pitch: 0.4, overhang: 1 };
  const vent = { id: 1, type: "window", isVent: true, wall: "south", widthFt: 1.5, heightIn: 12, ventZone: "gable" };
  const f0 = F.ssGableVentFit(roof, 12, 16, "south", 8, vent, 6, null);
  const f1 = F.ssGableVentFit({ ...roof, seat: "raised" }, 12, 16, "south", F.d3ShellFt({ ...roof, seat: "raised" }, 8), vent, 6, null);
  assert(f0 && f1, "it fits both ways");
  // The rise is measured above the wall top, so the fit is the same but for where it is drawn.
  assertEquals({ ...f1, y0: 0, y1: 0 }, { ...f0, y0: 0, y1: 0 }, "the same fit");
  assertAlmostEquals(f1.y0 - f0.y0, 3.5 / 12, 1e-9, "its bottom, a rafter up");
  assertAlmostEquals(f1.y1 - f0.y1, 3.5 / 12, 1e-9, "its top, a rafter up");
});

// ── 4. the wiring, in both twins ────────────────────────────────────────────────────────────────
Deno.test("the renderer reads the shell once, and the inside of the building reads the plate", () => {
  for (const [name, src] of TWINS) {
    const body = codeOnly(lift(src, name, "function buildShed3DModel(", "\nfunction d3UnbindFixtureMats("));
    assertEquals((body.match(/const H = d3ShellFt\(/g) || []).length, 1, `${name}: H is the shell, once`);
    assert(body.includes("const Hplate = p.wallHeightFt || D3.WALL_H, T = D3.WALL_T;"), `${name}: Hplate`);
    assert(body.includes("const H = d3ShellFt((p.styleSpec && p.styleSpec.roof) || D3_DEFAULT_ROOF, Hplate);"), `${name}: the shell over the plate`);
    assert(body.includes("ssPartitionHeightFt(it, Hplate)"), `${name}: partitions stand on the plate`);
    assert(body.includes("const cH0 = d3CeilingFt(roofCfg, bldgW, bldgH, Hplate, g.position.x, g.position.z);"), `${name}: the ceiling is the plate`);
    assert(body.includes("ssLoftPlateFt(roofCfg, bldgW, bldgH, Hplate, ftX(it.x), ftZ(it.y),"), `${name}: lofts sit on the plate`);
    assert(!/ssPartitionHeightFt\(it, H\)|d3CeilingFt\(roofCfg, bldgW, bldgH, H,|ssLoftPlateFt\(roofCfg, bldgW, bldgH, H,/.test(body), `${name}: no interior read of the shell`);
  }
});

Deno.test("the end elevation draws the shell, dimensions the plate, and names the rafter only when raised", () => {
  for (const [name, src] of TWINS) {
    const el = codeOnly(lift(src, name, "function D3ElevationSVG(", "\nfunction d3LeanTosElev("));
    assert(el.includes("const Hplate = (spec && spec.wallHeightFt) || 8;") && el.includes("const H = d3ShellFt(roof, Hplate);"), `${name}: Hplate and H`);
    assert(el.includes('d3FtIn(Hplate), "wall", "wallHeightFt"'), `${name}: the wall label is the plate`);
    assert(!el.includes('d3FtIn(H), "wall"'), `${name}: never the shell as "wall"`);
    assert(el.includes("{H !== Hplate && ("), `${name}: the rafter only when raised`);
    assertEquals((el.match(/"rafter", "rafterDepthIn"/g) || []).length, 2, `${name}: its label, lit by the rafter box`);
  }
});

Deno.test("the plan: ventRoof2D hands out the shell AND the plate, and the loft bar reads the plate", () => {
  for (const [name, src] of TWINS) {
    const code = codeOnly(src);
    assert(code.includes("const roof = (s && s.roof) || D3_DEFAULT_ROOF, Hplate = (s && s.wallHeightFt) || D3.WALL_H;\n    return { roof, H: d3ShellFt(roof, Hplate), Hplate };"), `${name}: ventRoof2D`);
    assert(code.includes("ssLoftPlateFt(vr.roof, bldgW, bldgH, vr.Hplate,"), `${name}: loftPlate2D`);
    assert(!code.includes("ssLoftPlateFt(vr.roof, bldgW, bldgH, vr.H,"), `${name}: never the shell for a loft`);
  }
});

Deno.test("builder-only: kept across a redraft, in the self-check's roof slice, and never resolved or defaulted", () => {
  for (const [name, src] of TWINS) {
    assert(src.includes('const BUILDER_ONLY = ["plateBand", "overhangStyle", "seat", "rafterDepthIn"];'), `${name}: calDraftRoof`);
    assert(src.includes("roof.wingList, roof.wingCornersMeet, roof.seat, roof.rafterDepthIn]);"), `${name}: calQuestionSig("roof"), appended`);
    const resolve = codeOnly(lift(src, name, "function d3ResolveStyleSpec(", "\nfunction d3SidingOverride("));
    assert(!/\bseat\b|rafterDepthIn/.test(resolve), `${name}: d3ResolveStyleSpec writes neither key`);
  }
  assert(SCORE.includes('const BUILDER_ONLY = ["plateBand", "overhangStyle", "seat", "rafterDepthIn"];'), "dev/score.mjs mirrors calDraftRoof");
  // The server never asks the model about it: the walk-around never sees the heel.
  assert(!/SELF_CHECK_ALLOW[^\]]*roof\.seat/.test(STYLE_D3), "not a self-check key");
});

Deno.test("the two controls: an exact word or nothing, greyed with wings, and a box whose blank clears", () => {
  for (const [name, src] of TWINS) {
    // The Advanced page.
    assert(src.includes('advSeg({ f: "seat", label: "Roof on the wall"'), `${name}: the Advanced choice`);
    assert(src.includes('pick: (v) => calSetRoofOpt("seat", v === "raised" ? "raised" : null),'), `${name}: "On the plate" deletes the key`);
    assert(src.includes('opts: [["plate", "On the plate", !seatLive, seatLive ? undefined : "Not with wings"], ["raised", "Raised by the rafter height", !seatLive, seatLive ? undefined : "Not with wings"]],'), `${name}: greyed with wings`);
    assert(src.includes('{seatRaised && advNum({ k: "rafterDepthIn", label: "Rafter height", unit: "in", value: roof.rafterDepthIn, min: 1.5, max: 12, step: 0.25,\n              band: [1.5, 12], write: (n) => calSetRoofOpt("rafterDepthIn", n), placeholder: "3.5", fallback: 3.5,'.replace(/\n/g, src.includes("\r\n") ? "\r\n" : "\n")), `${name}: the rafter box, band and blank`);
    // The classic calibration grid.
    assert(src.includes('onChange={(e) => calSetRoofOpt("seat", e.target.value === "raised" ? "raised" : null)}'), `${name}: the grid's choice`);
    assert(src.includes('{...calOptNumProps("rafterDepthIn", adminCal.spec.roof.rafterDepthIn, [1.5, 12], (n) => calSetRoofOpt("rafterDepthIn", n))}'), `${name}: the grid's box`);
    // "What we drew" (after a self-check) keeps the walls' own height and then says where the roof sits.
    assert(src.includes("{d3SeatLiftFt(adminCal.spec.roof) > 0 ? ` The roof sits ${Math.round(d3SeatLiftFt(adminCal.spec.roof) * 1200) / 100} in above the top of the walls, raised by the rafter.` : \"\"}"), `${name}: What we drew`);
  }
});

// ── 5. THE ALLOW-LIST GUARD ─────────────────────────────────────────────────────────────────────
// Every line in either twin that reads a wall height with a fallback (`wallHeightFt || D3.WALL_H`, `|| 8`,
// `|| 0`) is either WRAPPED in d3ShellFt (the shell) or listed here as a PLATE read, with why. A new raw
// read fails this test until it is put on one side of the seam.
const PLATE_READS: Array<[string, string]> = [
  // Pure helpers that take the height as a PARAMETER: each caller decides, and the 3D and plan hand them the shell.
  ["const H = Math.max(1, Number(wallHeightFt) || D3.WALL_H);", "ssVentSpan / ssVentWhere / ssVentAt / ssVentDragZone / SSWallElevation: a parameter"],
  ["const Hw = Math.max(1, Number(wallHeightFt) || D3.WALL_H);", "ssGableVentFit: a parameter"],
  ["const w = Number(widthFt) || 0, l = Number(lengthFt) || 0, h = Number(wallHeightFt) || 0;", "insulationSqft: the price"],
  ["return Number(o.wallHeightFt || (styleCfg && styleCfg.wallHeightFt) || (C && C.wallHeightFt) || 8) || 8;", "pricedWallHeightFt: the price"],
  // The plate itself, then wrapped on the next line.
  ["const Hplate = (spec && spec.wallHeightFt) || 8;", "D3ElevationSVG: the wall dimension; H = d3ShellFt(roof, Hplate)"],
  ["const Hplate = p.wallHeightFt || D3.WALL_H, T = D3.WALL_T;", "buildShed3DModel: H = d3ShellFt(..., Hplate)"],
  ["const roof = (s && s.roof) || D3_DEFAULT_ROOF, Hplate = (s && s.wallHeightFt) || D3.WALL_H;", "ventRoof2D: H = d3ShellFt(roof, Hplate)"],
  // Wings only: d3SeatApplies is false with wings, so the shell IS the plate there.
  ["const H = (spec && spec.wallHeightFt) || 8;", "the four wing-list / wings elevations"],
  ["const H = Number(p.spec.wallHeightFt) || D3.WALL_H;", "calEditWingList"],
  ["if (d3WingListOn(roof)) calWingListSync(roof, Number(p.spec.wallHeightFt) || D3.WALL_H);", "calWingListSync"],
  ["const wm = on && roof.wingAttach ? d3Massing(roof, bldgW, bldgH, Number(adminCal.spec.wallHeightFt) || D3.WALL_H) : null;", "the wings' attach readout"],
  ["const blankHc = wm ? d3Massing({ ...roof, centerEaveFt: null }, bldgW, bldgH, Number(adminCal.spec.wallHeightFt) || D3.WALL_H).Hc : null;", "the wings' auto middle"],
  ["const recessedLost = kind === \"recessed\" && d3WingsOn(d3Massing(roof, bldgW, bldgH, adminCal.spec.wallHeightFt || D3.WALL_H));", "a recessed porch under wings (grid)"],
  ["const recessedLost = kind === \"recessed\" && d3WingsOn(d3Massing(roof, bldgW, bldgH, spec.wallHeightFt || D3.WALL_H));", "a recessed porch under wings (Advanced)"],
  // The inside of the building: a ceiling fitting hangs from the top of the walls.
  ["const Hn = spec.wallHeightFt || D3.WALL_H;", "the viewer's ceiling-fitting highlight with nothing drawn yet"],
  ["dragging3.elecY = eb ? (eb.min.y + eb.max.y) / 2 : (spec.wallHeightFt || D3.WALL_H) - 0.5;", "the ceiling-fitting drag plane with nothing drawn yet"],
  // The wall-height boxes, the words and the config: the number a builder types and frames to.
  [": (Number(adminCal && adminCal.spec && adminCal.spec.wallHeightFt) || 0);", "calDimH"],
  ["{...calNumProps(\"ssc-fix-wall\", Number(adminCal.spec.wallHeightFt) || 0, (n) => calSetDim(\"wallHeightFt\", n))}", "the self-check's wall box"],
  ["<input type=\"number\" step=\"0.5\" {...calNumProps(\"wallHeightFt\", adminCal.spec.wallHeightFt || 8, (n) => calSet({ wallHeightFt: Math.max(5, Math.min(20, n)) }))} style={{ ...S.sel, width: \"100%\", boxSizing: \"border-box\" }} />", "the grid's wall box"],
  ["{advNum({ k: \"wallHeightFt\", label: \"Wall height (ft)\", value: spec.wallHeightFt || 8, min: 5, max: 20, step: 0.5,", "the Advanced wall box"],
  ["const spec = s ? d3ResolveStyleSpec(s, s.value, C.wallHeightFt || 8) : d3ResolveStyleSpec(null, \"\", C.wallHeightFt || 8);", "advSeed: the tenant's default wall"],
];
// "What we drew" says how tall the WALLS are, and then, raised, where the roof sits above them.
const WHAT_WE_DREW = "<b>What we drew:</b>";
const SHELL_READS = 26;

Deno.test("⚠️ every wall-height read is on one side of the seam: wrapped in d3ShellFt, or a listed plate read", () => {
  const re = /wallHeightFt\)*\s*\|\|\s*(?:D3\.WALL_H|8|0)\b/;
  const allowed = new Map<string, number>();
  for (const [line] of PLATE_READS) allowed.set(line, 0);
  for (const [name, src] of TWINS) {
    const raw: string[] = [], wrapped: string[] = [];
    for (const l of src.split(/\r?\n/)) {
      if (!re.test(l) || /^\s*\/\//.test(l)) continue;
      (l.includes("d3ShellFt(") ? wrapped : raw).push(l.trim());
    }
    const unknown = raw.filter((l) => !allowed.has(l) && !l.startsWith(WHAT_WE_DREW));
    assertEquals(unknown, [], `${name}: a raw wall-height read nobody has classified. Wrap it in d3ShellFt (wall, roof, vent or appendage geometry) or add it to PLATE_READS with why (the inside, the price, the boxes and words).`);
    assertEquals(wrapped.length, SHELL_READS, `${name}: the shell reads`);
    // Each listed plate read is really there (a stale entry would hide a moved one), and the counts are pinned.
    const counts = new Map<string, number>();
    for (const l of raw) counts.set(l, (counts.get(l) || 0) + 1);
    for (const [line, why] of PLATE_READS) assert(counts.has(line), `${name}: the plate read for ${why} is gone; remove it from PLATE_READS`);
    assertEquals(raw.length, 29, `${name}: the plate reads, the listed lines with repeats and the "What we drew" line`);
  }
});

Deno.test("E - plate traps: \"under the eave\" compares a lean-to's eave with the SHELL, on both pages", () => {
  for (const [name, src] of TWINS) {
    assert(src.includes("const underEave = at0 ? at0.E - d3ShellFt(roof, (adminCal.spec.wallHeightFt) || D3.WALL_H) : 0;"), `${name}: the grid`);
    assert(src.includes('const eaveGap = !gable && r && r.kind === "eave" ? r.E - d3ShellFt(roof, (spec && spec.wallHeightFt) || D3.WALL_H) : 0;'), `${name}: the Advanced page`);
  }
});

// ── 6. "the plate" in a rule or a word means the plate a builder framed (review, 2026-10-07) ─────────────
// Under a raised roof the wall stands a rafter above its plate (H, the shell), so a rule or a readout that
// says "plate" and reads H is a rafter out, on raised styles only.
Deno.test("a wall device's plate rules and the gable vent's words measure the PLATE; the lamp's eave cap stays on the shell", () => {
  for (const [name, src] of TWINS) {
    const body = codeOnly(lift(src, name, "function buildShed3DModel(", "\nfunction d3UnbindFixtureMats("));
    const el = lift(body, name, "const buildElectrical3D = (", "\n  const buildPartition3D = (it) => {");
    assert(el.includes("const wPlate = wTop - (H - Hplate);"), `${name}: the plate under the device`);
    // "Mounted within 3 in of the plate": a 96 in light on a raised 8 ft wall is still the lamp under the eave.
    assert(el.includes("(hFt != null && hFt >= wPlate - 0.25)"), `${name}: the outside test reads the plate`);
    // "Never above the plate line": an inside cover plate stays out of the rafter band.
    assert(el.includes("Math.min(hFt != null ? hFt : 1.5, wPlate - ph / 2 - 0.05)"), `${name}: the inside clamp reads the plate`);
    assert(!/hFt >= wTop - 0\.25|wTop - ph \/ 2 - 0\.05/.test(el), `${name}: neither plate rule reads the shell`);
    assert(el.includes("const EAVE_CAP = wTop > H + 0.01 ? Math.min(wTop - 0.75, ownHang) : Math.min(H - 0.75, eaveHangY - 0.45);"), `${name}: the lamp's cap is under the eave, which moved up with it`);
    // The selected gable vent's toolbar: ssVentWhere's rise is from vr.H, so "above the plate" adds the rafter back.
    const code = codeOnly(src);
    assert(code.includes("const w = ssVentWhere(vr.roof, bldgW, bldgH, vr.H, si, scale, mgX, mgY);"), `${name}: the toolbar measures on the shell`);
    assert(code.includes("${fmtDimFtIn(w.riseFt + (vr.H - vr.Hplate))} above the plate"), `${name}: ...and says its height above the plate`);
    assert(!code.includes("${fmtDimFtIn(w.riseFt)} above the plate"), `${name}: never the rise above the shell as "above the plate"`);
  }
});

Deno.test("the End view's rafter words, with a lean-to on the left, sit under the plate line, clear of the roof's slope", () => {
  for (const [name, src] of TWINS) {
    const el = codeOnly(lift(src, name, "function D3ElevationSVG(", "\nfunction d3LeanTosElev("));
    assert(el.includes('? label(WX + 6, Y(Hplate) + 12, `${Math.round((H - Hplate) * 1200) / 100}"`, "rafter", "rafterDepthIn", "start")'), `${name}: under the plate, inside the wall`);
    assert(el.includes(': label(PL - 30, Y(H) - 12, `${Math.round((H - Hplate) * 1200) / 100}"`, "rafter", "rafterDepthIn", "end")'), `${name}: in the left margin otherwise`);
    assert(!el.includes("label(WX + 6, Y(H) - 12,"), `${name}: never above the shell top inside the wall, where the roof line runs`);
  }
});

// ── 7. A RAISED ROOF SURVIVES AN OLDER DESIGNER'S REDRAFT (carryForwardRoofSeat) ──────────────────────────
// Beta and production share save_style_d3. Production's designer, until the next promotion, drops both keys on
// an AI redraft and can never set them, so the server keeps the stored pair over a save that does not say it
// knows them (styleD3.test.ts runs the rule). Here: the panels that draw the choice say so, and both servers
// carry before they write.
const SHELL = await Deno.readTextFile(new URL("../../../../portal/12-shell.jsx", import.meta.url));
const PORTAL_SETTINGS = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const ADMIN_SAVE = (await Deno.readTextFile(new URL("../../admin-save-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
Deno.test("⚠️ the saves that draw the choice send seatAware, and both servers carry the pair, before the guard and the write", () => {
  const shellSave = lift(SHELL, "portal/12-shell.jsx", 'const body = { action: "save_style_d3", styleValue, d3: ssD3WithFall(d3), d3Photos, frame: "front", slabGround: true };', "body.targetClientId = target || null;");
  assert(codeOnly(shellSave).includes("body.seatAware = true;"), "12-shell onSaveSpec sends seatAware");
  for (const [name, src] of TWINS) {
    assert(src.includes('d3Photos: adminCal.photos.filter(Boolean), frame: "front", slabGround: true, seatAware: true },'), `${name}: the operator page's save sends seatAware`);
  }
  assert(PORTAL_SETTINGS.includes('import { carryForwardRoofSeat } from "../_shared/styleD3.ts";'), "portal-settings imports it");
  const act = PORTAL_SETTINGS.indexOf('if (action === "save_style_d3") {');
  const call = PORTAL_SETTINGS.indexOf("carryForwardRoofSeat(clean.d3, payload.d3, found.style!.d3, payload.seatAware === true);", act);
  const guard = PORTAL_SETTINGS.indexOf("const decision = guardDecision(", act);
  assert(act > 0 && call > act && guard > call, `portal-settings: carried inside save_style_d3, before the guard (${act}, ${call}, ${guard})`);
  assert(ADMIN_SAVE.includes("carryForwardFoundation, carryForwardRoofSeat } from \"../_shared/styleD3.ts\";"), "admin-save-settings imports it");
  assert(ADMIN_SAVE.includes("const { styleValue, d3, d3Photos, d3VideoFrames, frame, slabGround, seatAware } = payload || {};"), "admin-save-settings reads the flag");
  const aCall = ADMIN_SAVE.indexOf("carryForwardRoofSeat(clean.d3, d3, lockRow?.d3, seatAware === true);");
  const aWrite = ADMIN_SAVE.indexOf("const { error: upErr, count } = await supabase");
  assert(aCall > 0 && aWrite > aCall, `admin-save-settings: carried before the write (${aCall}, ${aWrite})`);
});
