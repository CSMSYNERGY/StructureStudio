// GROUND THAT FALLS AWAY (top-level gradeFallFt / gradeFallToward, 2026-09-28), measured off the scene
// graph of the COMPILED designer, and the calibration panel's controls for it driven with the SAVE
// PAYLOAD read off the wire.
//
// Carolyn, 09-28: "these piers are, like, deeper here". floorHeightFt stays the height at the front
// (the uphill side); gradeFallFt is how much lower the ground is at the far side, toward back, left
// or right. This proves, through __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. model.grade is still the front's depth and model.gradeFall says the fall; the grass is bent to
//      d3GradeAt: sampled off the drawn triangles it is the front grade along the uphill edge, the
//      grade plus the fall along the far edge, a straight line between, and level past the blend
//      either side; its faces look up
//   2. ⚠️ every support under the building stands ON the drawn grass at its own spot: its foot at the
//      lowest grass under it (the uphill edge bedded in, nothing floating), within half a foot's
//      slope of the grass under its centre; the downhill rows stand taller by the fall times their
//      share of the way across; tops at the runners' underside; block stacks a course per 8 in of
//      their own height (model.foundation.supports[].courses)
//   3. the porch deck's own supports, the porch steps' foot, a lean-to's posts and a customer's ramp
//      reach the drawn grass at their own spot; the steps climb it in risers of 7.5 in or less and
//      their count is the one the panel's readout says (d3PorchReadout)
//   4. d3PorchToRoot (pure) is where the deck really stands: it maps the porch's own frame onto the
//      placed deck's matrices on a gable end, an eave wall, and an old-frame end wall
//   5. the shade under the building and the deck, and the ground labels, lie on the grass
//   6. the 3D editor frames the grass under every support's foot, its orbit target down by the
//      DEEPEST ground (d3GradeLiftFt); and with no door placed, the 3D Views preset the direction
//      names (B, ← L, R →), clicked, looks at the side the ground falls to, old frame and new.
//      ⚠️ The ground stays with the building, like the roof: a door on the east wall re-homes the
//      presets (F looks at the door's wall) and never turns the ground
//   6b. THE SELF-CHECK'S PHONE (review, 2026-09-29): every walk camera ssSelfCheckCameras aims (the
//      designer's own pure function) has its eye EYE_FT + FLOOR_T over the DRAWN grass under it,
//      uphill views included -- on a 6 ft fall the pre-review eye was under the grass. With
//      SS_SHOTS, the front (uphill) view before (SS_EYE_BEFORE, default f33a6fa) and after
//   7. ⚠️ LEVEL GROUND IS TODAY'S, BYTE FOR BYTE: a style with no fall, one whose fall is 0, and a slab
//      carrying a fall it cannot have, each build a scene (every node's matrix, every mesh's geometry
//      and material) identical to the one the designer at SS_LEVEL_BASE (default 5345037, the commit
//      before this) builds from the same style, and the same camera (a projecting porch's cheeks and the
//      wood past its corner posts aside: 2026-10-04 changed those on purpose, see digest)
//   8. THE PANEL (?admin=1): blocks and piers show "Ground falls away (ft)"; an untouched level style
//      saves no fall (both keys sent as an explicit null, review BC-1 2026-09-29), and a style storing
//      a fall saves it back exactly; a typed fall saves, "Toward" appears with its hint and saves its
//      word; the height box's hint says where the height is taken (the uphill side); a cleared box
//      sends gradeFallFt null; leaving blocks or piers sends both as null; the preview draws the
//      typed fall. With a fall the height box's hint gives the
//      ramp's rule, not the level sentence's one length, and Toward says every direction is the 3D
//      Views menu's (review, 2026-09-29)
//   8b. THE STEP BOX OVER FALLING GROUND (review, 2026-09-29): case K's back porch in the panel.
//      "Number of steps" says "blank = 6", the count drawn down to the lower ground, not the front's
//      3; on a 6 ft fall "blank = 13" and the rise hint says a typed count stops at 12; the preview
//      draws the placeholder's number (SS_CASES=panelSteps runs it alone)
//   9. zero page errors
//
// THE GROUND AT EACH CORNER (top-level gradeCornersFt, 2026-09-29). Carolyn, 09-29, on the Advanced page:
// "we need to be able to put in where the zero is ... put in four corners". { fl, fr, bl, br }, how many
// feet lower the ground is at each corner, the highest one the zero; a stored fall is the same ground
// read as corners. This proves, on top of the above:
//   10. ⚠️ A STORED FALL RENDERS AS IT DID: cases K, Lf, Bk and O build a scene identical, node for node
//      but the grass (a grid now, not rows; held to d3GradeAt by 1 above), to the designer at
//      SS_FALL_BASE (default 5fb622a, the commit before the corners), and the same camera (the porch's
//      two front-corner parts aside, as in 7)
//   11. four-corner cases (C1..C4): model.gradeCorners is d3GradeCorners (the highest corner the zero),
//      model.gradeFall null; the drawn grass is d3GradeAt's bilinear surface over and round the
//      footprint (within 0.01 ft); ⚠️ every support's foot is on the drawn grass at its own spot; the
//      supports at the DEEPEST corner are the tallest, those at the zero corner the shortest; the deck's
//      supports, the steps, a lean-to's posts, a ramp, the shade and the labels are on the grass; the
//      editor frames every foot; the self-check's phone stands on the grass
//   12. level corners (all 0) are today's level ground, node for node (LV5, LV6 in 7)
//   8.  THE PANEL (rewritten 2026-09-29): "Ground at each corner (in lower)", four boxes in INCHES since
//      2026-10-03 (stored in feet); each types, reads out ("highest", "2 ft lower"), saves the four
//      corners and sends the fall keys null; "Level ground" and leaving piers send gradeCornersFt null;
//      a style storing a fall opens with its corners, saves the fall back untouched, and an edited corner
//      saves corners in its place; the preview draws them. A slab keeps the boxes, a typed corner saves
//      on it, and every save says slabGround: true
//   13. A SLAB ON GROUND THAT FALLS AWAY (gradeCornersFt on a slab, 2026-10-03, case SL): model.grade the
//      band's 0.35 at the highest corner, model.foundation the slab's; the grass is d3GradeAt's surface;
//      ⚠️ the stem wall's tops at -0.35 and every vertex of its bottom edge under the drawn grass; no
//      skirt, runners, supports under the building or shade; the porch deck's piers, the steps, a lean-
//      to's posts and a ramp reach the drawn grass; the labels lie on it; the cameras frame the drop
//   14. STEPS OFF A DECK'S END AND A RECESSED PORCH'S STEPS (2026-10-03, cases F*): on a fall and on
//      corners, front, back, eave and old-frame walls, raised and on a slab. ⚠️ The placed flight's own
//      matrix is the pure map: a point (x, d) of the flight lands where d3PorchToRoot puts
//      (edgeX + turn d, atD - turn x) off a deck's end, and where d3RecessedPorchToRoot puts (x, d) in a
//      recessed porch's opening, and (2026-10-07, F9 / F10) at (edgeX + turn d, atD - turn x) off one of a
//      recessed porch's open sides, turned the same way; its foot is on the drawn grass; its treads rise evenly in risers of
//      7.5 in or less; and the panel's readout (d3PorchReadout / d3RecessedPorchReadout) counts the same
//
//   python -m http.server 8142 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8142 node tests/harness/gradeFall.mjs
//   SS_CASES=K,level,panel,panelSteps,corners,C1,legacy,flights,F1 ...   (a subset)  SS_SHOTS=<dir>  (side views, before and after)
//
// Exit 0 = every assertion held.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool, BASE } from "./lib.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

// The designer's own pure functions, lifted out of the component twin by the anchors raisedFloor_test
// and gradeFall_test lift them by, so the scene is held against the numbers the code says.
function pure() {
  const src = readFileSync(new URL("../../structure-studio.component.js", import.meta.url), "utf8");
  const lift = (a, b) => {
    const i = src.indexOf(a), j = i < 0 ? -1 : src.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error(`gradeFall.mjs: the anchors ${a} .. ${b} moved; re-point them`);
    return src.slice(i, j);
  };
  const body = [
    ["const D3 = {", "// The casing reveal every opening"],
    // D3_CLADDING and d3CladdingFor: the corner boards' face the recessed porch's posts stand on (2026-10-07).
    ["const D3_CLADDING = {", "// ── METAL ROOF PROFILE"],
    ["function d3RoofAxes(", "function d3FtIn("],
    ["function ssPorchTrussWall(", "// Where a vent sits in the gable above"],
    ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
    ["function d3PorchGeom(", "function d3PorchReadout("],
    ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
  ].map(([a, b]) => lift(a, b)).join("\n");
  return new Function(`${body}; return { D3, d3GradeFt, d3GradeAt, d3GradeFall, d3GradeFallAxis, d3GradeFallBlendFt, d3GradeMaxFt, d3GradeLiftFt, d3FrameHeightFt, d3PorchToRoot, d3PorchReadout, d3GradeCorners, d3RecessedPorchToRoot, d3RecessedPorchReadout };`)();
}
const PURE = pure();
// The self-check's cameras (ssSelfCheckCameras), from this checkout or from another revision's source.
const SELF_REGIONS = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_STYLE_DEFAULTS = {", "// ── CLADDING ──"],
  // D3_CLADDING and d3CladdingFor: the corner boards' face the recessed porch's posts stand on (2026-10-07).
  ["const D3_CLADDING = {", "// ── METAL ROOF PROFILE"],
  ["function d3RoofAxes(", "function d3FtIn("],
  ["function ssPorchTrussWall(", "// Where a vent sits in the gable above"],
  ["function d3DefaultOverhangStyle(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  ["function d3PorchGeom(", "function d3PorchReadout("],
  ["function d3PorchReadout(", "// A dimensioned end-elevation of the style"],
  ["const SS_SHOT = {", "// Render the draft the builder just paid for"],
];
function selfCheck(src) {
  const lift = (a, b) => {
    const i = src.indexOf(a), j = i < 0 ? -1 : src.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error(`gradeFall.mjs: the anchors ${a} .. ${b} moved; re-point them`);
    return src.slice(i, j);
  };
  return new Function(`${SELF_REGIONS.map(([a, b]) => lift(a, b)).join("\n")}; return { ssSelfCheckCameras, SS_SHOT, D3 };`)();
}
const SELF = selfCheck(readFileSync(new URL("../../structure-studio.component.js", import.meta.url), "utf8"));
// Every viewpoint the self-check can be given, all the way round.
const WALK_MAP = {
  front: { frame: 1, azimuthDeg: 0 }, side: { frame: 2, azimuthDeg: 90 }, corner: { frame: 3, azimuthDeg: 45 },
  back: { frame: 4, azimuthDeg: 180 }, otherSide: { frame: 5, azimuthDeg: 270 }, eaveCorner: { frame: 6, azimuthDeg: 30 },
};

const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const PLAIN = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266", wood: "#c4965a" };
const FARM_COLORS = { body: "#785f51", trim: "#f0f0ec", roof: "#383d44", corner: "#785f51", fascia: "#4b5359", wood: "#9a5f4a" };
// A Tri Home-like 16x24: its gable end is the front, a porch off one end with steps, a lean-to off the
// left (west) eave wall.
const TRI = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchOutFt: 6, leanToWidthFt: 8, leanToSide: "left" };
const FARM_ROOF = { type: "shed", highSide: "front", pitch: 0.22, overhang: 0.8, eave: "fascia", porchEnd: "front", porchOutFt: 4, porchAttachFt: 8, porchPosts: 4, porchPitch: 0.25, porchSteps: "center" };
const tri = (roof, extra) => ({ roof: { ...TRI, ...roof }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, ...extra });

// fall: the style's gradeFallFt / toward. ramp: a door and a ramp on the EAST wall. wall: the porch's.
const CASES = [
  { id: "K", label: "Fall Back Piers", size: "16x24", kind: "piers", grade: 1.5, fall: 2, toward: "back", wall: "north", leanTo: true, ramp: true, selfCheck: true,
    d3: tri({ porchEnd: "back", porchSteps: "center" }, { gradeFallFt: 2, gradeFallToward: "back" }) },
  { id: "Lf", label: "Fall Left Piers", size: "16x24", kind: "piers", grade: 1.5, fall: 2, toward: "left", wall: "south", leanTo: true, ramp: true, selfCheck: true,
    d3: tri({ porchEnd: "front", porchSteps: "left" }, { gradeFallFt: 2, gradeFallToward: "left" }) },
  { id: "Rt", label: "Fall Right Piers", size: "16x24", kind: "piers", grade: 1.5, fall: 2, toward: "right", wall: "south", leanTo: true,
    d3: tri({ porchEnd: "front", porchSteps: "right" }, { gradeFallFt: 2, gradeFallToward: "right" }) },
  // An eave-wall porch (the new frame's shed, Farmstand) on blocks, the ground falling to its right.
  { id: "Bk", label: "Fall Farm Blocks", size: "16x10", kind: "blocks", grade: 1.1, fall: 1.5, toward: "right", wall: "south",
    d3: { roof: FARM_ROOF, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7.3, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1, gradeFallFt: 1.5, gradeFallToward: "right" } },
  // The OLD frame: no roof.front, a landscape gable, so the "front" porch is on the WEST end wall,
  // which the presets call the left side; the ground falls toward it.
  { id: "O", label: "Fall Old Frame", size: "24x12", kind: "piers", grade: 1.5, fall: 2, toward: "left", wall: "west",
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 5, porchSteps: "left" }, siding: "panel", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "left" } },
  // A left wing: the porch stands in front of the CENTRE section, off the wall's middle
  // (d3PorchSpan's centerU), and the ground falls across it.
  { id: "Wg", label: "Fall Wing Porch", size: "16x24", kind: "piers", grade: 1.5, fall: 2, toward: "left", wall: "south",
    d3: tri({ porchEnd: "front", porchSteps: "center", wingSide: "left", wingWidthFt: 4, leanToWidthFt: 0 }, { gradeFallFt: 2, gradeFallToward: "left" }) },
  // The front sits on the ground (a 0.3 ft floor is the floor band itself): no room for a support
  // there, but the far side still stands on piers, the runners bedded into the grade at the front.
  { id: "Th", label: "Fall Thin Front", size: "12x16", kind: "piers", grade: 0.35, fall: 2, toward: "back", wall: null, thin: true,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "lap", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 0.3, gradeFallFt: 2 } },
  // The sanitiser's steepest fall, to the back: the self-check's front (uphill) camera used to stand
  // 0.6 ft under the grass here.
  { id: "St", label: "Fall Steep Back", size: "16x24", kind: "piers", grade: 1.5, fall: 6, toward: "back", wall: null, selfCheck: true,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6 }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 6, gradeFallToward: "back" } },
  // No direction given: the fall is toward the back.
  { id: "D", label: "Fall Default Toward", size: "12x16", kind: "piers", grade: 1.5, fall: 1, toward: "back", wall: null,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "lap", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 1 } },
];
// ── 7. LEVEL GROUND: each built by this designer and by the one at SS_LEVEL_BASE, from the same style.
const LEVEL = [
  { id: "LV1", label: "Level Piers", size: "16x24", ramp: true, d3: tri({ porchEnd: "back", porchSteps: "center" }) },
  { id: "LV2", label: "Level Piers Zero Fall", size: "16x24", d3: tri({ porchEnd: "back", porchSteps: "center" }, { gradeFallFt: 0, gradeFallToward: "left" }) },
  { id: "LV3", label: "Level Slab With Fall", size: "12x16", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 6, porchSteps: "left" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, foundation: "slab", gradeFallFt: 2, gradeFallToward: "back" } },
  { id: "LV4", label: "Level Farm Blocks", size: "16x10", d3: { roof: FARM_ROOF, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7.3, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1 } },
  // 12. Corners that make no slope (2026-09-29): all 0, all the same, and corners on a style that says
  //     nothing about its foundation (a slab's own corners slope since 2026-10-03: case SL).
  { id: "LV5", label: "Level Corners Zero", size: "16x24", d3: tri({ porchEnd: "back", porchSteps: "center" }, { gradeCornersFt: { fl: 0, fr: 0, bl: 0, br: 0 } }) },
  { id: "LV6", label: "Level Corners Same", size: "16x24", d3: tri({ porchEnd: "back", porchSteps: "center" }, { gradeCornersFt: { fl: 2, fr: 2, bl: 2, br: 2 } }) },
  { id: "LV7", label: "Level No Foundation Corners", size: "12x16", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 6, porchSteps: "left" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, gradeCornersFt: { fl: 0, br: 3 } } },
];
// ── 11. THE GROUND AT EACH CORNER (2026-09-29): drops in feet below... as typed; the highest is the zero.
const CORNER_CASES = [
  // The Tri Home: a back porch with centre steps, a lean-to off the left, a ramp on the east, the ground
  // lowest at the back-right corner.
  { id: "C1", label: "Corners Tri Piers", size: "16x24", kind: "piers", wall: "north", leanTo: true, ramp: true, selfCheck: true,
    d3: tri({ porchEnd: "back", porchSteps: "center" }, { gradeCornersFt: { fl: 0, fr: 0.5, bl: 1.5, br: 3 } }) },
  // Carolyn's drawing: 0 at one front corner, 2 at the other, the back dropping 18 in and 2 ft.
  { id: "C2", label: "Corners Carolyn", size: "12x16", kind: "piers", wall: "south", selfCheck: true,
    d3: tri({ porchEnd: "front", porchSteps: "left", leanToWidthFt: 0 }, { gradeCornersFt: { fl: 0, fr: 2, bl: 1.5, br: 2.5 } }) },
  // Blocks on an eave-wall porch (the Farmstand), the zero at the FRONT-RIGHT corner, typed off zero.
  { id: "C3", label: "Corners Farm Blocks", size: "16x10", kind: "blocks", wall: "south",
    d3: { roof: FARM_ROOF, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7.3, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1, gradeCornersFt: { fl: 2, fr: 1, bl: 3.5, br: 1.5 } } },
  // The old frame's landscape gable: the "front" porch on the WEST end wall, the ground twisted.
  { id: "C4", label: "Corners Old Frame", size: "24x12", kind: "piers", wall: "west",
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 5, porchSteps: "left" }, siding: "panel", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5, gradeCornersFt: { fl: 2.5, fr: 0, bl: 1, br: 0.75 } } },
];
// ── 13. A SLAB ON GROUND THAT FALLS AWAY (2026-10-03): a back porch with centre steps, a lean-to off the
// left, a ramp on the east, the ground lowest at the back-right corner.
const SLAB_CASES = [
  { id: "SL", label: "Corners Slab", size: "16x24", wall: "north", leanTo: true, ramp: true, selfCheck: true,
    d3: { roof: { ...TRI, porchEnd: "back", porchSteps: "center" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "slab", gradeCornersFt: { fl: 0, fr: 0.5, bl: 1.5, br: 2.5 } } },
];
// ── 10. A STORED FALL, as the designer before the corners drew it.
const LEGACY = ["K", "Lf", "Bk", "O"];
// ── 14. STEPS OFF A DECK'S END, AND A RECESSED PORCH'S STEPS (2026-10-03), on ground that falls away.
// `recessed` marks a porch cut into the building; `wall` is the porch's.
const FLIGHT_CASES = [
  { id: "F1", label: "Flight Side Left Fall", size: "16x24", wall: "south",
    d3: tri({ porchEnd: "front", porchSteps: "leftSide", leanToWidthFt: 0 }, { gradeFallFt: 2, gradeFallToward: "left" }) },
  { id: "F2", label: "Flight Side Right Corners", size: "16x24", wall: "north",
    d3: tri({ porchEnd: "back", porchSteps: "rightSide", leanToWidthFt: 0 }, { gradeCornersFt: { fl: 0, fr: 0.5, bl: 1.5, br: 3 } }) },
  { id: "F3", label: "Flight Side Farm Blocks", size: "16x10", wall: "south",
    d3: { roof: { ...FARM_ROOF, porchSteps: "rightSide" }, siding: "batten", colors: FARM_COLORS, wallHeightFt: 7.3, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1, gradeFallFt: 1.5, gradeFallToward: "right" } },
  { id: "F4", label: "Flight Side Old Frame", size: "24x12", wall: "west",
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 5, porchSteps: "leftSide" }, siding: "panel", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5, gradeCornersFt: { fl: 2.5, fr: 0, bl: 1, br: 0.75 } } },
  { id: "F5", label: "Flight Recessed Front Piers", size: "16x24", wall: "south", recessed: true,
    d3: { roof: { type: "gable", pitch: 0.42, overhang: 0.8, porchDepthFt: 5, porchSteps: "center" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, gradeCornersFt: { fl: 2, fr: 1, bl: 0, br: 0 } } },
  { id: "F6", label: "Flight Recessed Old Frame", size: "24x12", wall: "west", recessed: true,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6, porchDepthFt: 5, porchSteps: "left" }, siding: "panel", colors: PLAIN, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "left" } },
  { id: "F7", label: "Flight Recessed Eave Blocks", size: "16x12", wall: "south", recessed: true,
    d3: { roof: { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6, porchDepthFt: 4, porchSteps: "right" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1, gradeFallFt: 1.5, gradeFallToward: "right" } },
  { id: "F8", label: "Flight Recessed Back Slab", size: "12x16", wall: "north", recessed: true,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, porchDepthFt: 4, porchEnd: "back", porchSteps: "center" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "slab", gradeCornersFt: { fl: 0, fr: 0, bl: 1.5, br: 2 } } },
  // Off an OPEN SIDE of a recessed porch (2026-10-07): turned onto that side, on the downhill side of a fall, and an
  // eave wall's end on corners.
  { id: "F9", label: "Flight Recessed Side Left Fall", size: "16x24", wall: "south", recessed: true, side: true,
    d3: { roof: { type: "gable", pitch: 0.42, overhang: 0.8, porchDepthFt: 6, porchSteps: "leftSide" }, siding: "batten", colors: { ...PLAIN, wood: "#9A4530" }, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "left" } },
  { id: "F10", label: "Flight Recessed Eave Side Corners", size: "16x12", wall: "south", recessed: true, side: true,
    d3: { roof: { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6, porchDepthFt: 4.5, porchSteps: "rightSide" }, siding: "panel", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1, gradeCornersFt: { fl: 0, fr: 1.5, bl: 0, br: 0.5 } } },
];

const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-gradefall",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "fall", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { fall: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { fall: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: true, imageUrl: null, showImage: false },
  items: [{ id: "d-walk", name: "Harness Walk Door", price: 300, widthIn: 36, heightIn: 80, category: "door", colorMode: "fixed", planLabel: "WD", sortOrder: 0, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false }],
  windowColors: [],
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function pickStyle(page, label) {
  await page.waitForFunction((lab) => {
    const want = lab.trim().toLowerCase();
    return [...document.querySelectorAll("div,span,p,strong,b")]
      .some((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === want && e.offsetParent);
  }, label, { timeout: 30000 }).catch(() => {});
  const ok = await page.evaluate((lab) => {
    const want = lab.trim().toLowerCase();
    const el = [...document.querySelectorAll("div,span,p,strong,b")]
      .find((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === want && e.offsetParent);
    if (!el) return false;
    el.click();
    return true;
  }, label);
  if (!ok) throw new Error(`no style tile labelled ${label}`);
  await settle(page, 500);
}
async function chooseSize(page, size) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: size }) });
  if (await sel.count()) await sel.first().selectOption({ label: size });
  const l = Number(size.split("x")[1]);
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), l, { timeout: 15000 });
  await settle(page, 600);
}
async function openEditor(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible())) {
    const show = page.getByRole("button", { name: /Show 3D|3D View/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await edit.first().click();
  await page.waitForFunction(() => {
    const E = window.__ss3dEngine;
    return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0);
  }, null, { timeout: 90000 });
  await settle(page, 1200);
}
// A door and its ramp on the EAST wall, half way along, placed in 2D (foundation.mjs's).
async function placeRampEast(page, ok, tag, W, L) {
  const eastAt = async (alongFt) => {
    const r = await buildingRect(page);
    return svgPoint(page, r.x + r.w - 0.4 * (r.w / W), r.y + alongFt * (r.h / L));
  };
  await (await revealTool(page, /^Door wall$/)).click();
  await settle(page, 300);
  let p = await eastAt(L / 2);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  await page.getByText(FIXTURES.items[0].name, { exact: true }).first().click({ timeout: 10000 });
  await settle(page, 300);
  await page.getByRole("button", { name: "Place door" }).click();
  await settle(page, 600);
  await (await revealTool(page, /Ramp/)).click();
  await settle(page, 300);
  p = await eastAt(L / 2);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  const items = (await readItems(page)) || [];
  const ramp = items.find((i) => i.type === "ramp");
  ok(`${tag}: a ramp placed on the east wall`, ramp && ramp.wall === "east", JSON.stringify(ramp && { wall: ramp.wall }));
}
// The designer at SS_LEVEL_BASE: its compiled component, served in place of this checkout's.
function baseBundle() {
  const rev = process.env.SS_LEVEL_BASE || "5345037";
  try {
    return { rev, js: execFileSync("git", ["-C", REPO, "show", `${rev}:structure-studio.component.compiled.js`], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8") };
  } catch (_e) {
    return { rev, js: null };
  }
}

// Open the designer on a case's style and size (and its ramp), then the 3D editor.
async function openCase(ctx, c, ok, tag, bundle) {
  const [W, L] = c.size.split("x").map(Number);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor(c), fixtures: FIXTURES });
  if (bundle) await page.route(/structure-studio\.component\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: bundle }));
  await openDesigner(page, "harness-gradefall");
  await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
  await pickStyle(page, c.label);
  await chooseSize(page, c.size);
  if (c.ramp) await placeRampEast(page, ok, tag, W, L);
  await openEditor(page);
  return { page, errors, W, L };
}

// Every node of the model: its world matrix and, on a mesh, its geometry (type, parameters, a hash of
// every vertex) and material. Two builds with equal digests are the same scene. `skipGround` leaves
// the grass out (10: a fall's grass is a grid now, held to d3GradeAt by 1).
// A projecting porch's two front-corner parts are left out on BOTH sides (2026-10-04): the sided cheek
// now stops at the corner post's outer face and the wood past it reaches the ceiling, on purpose (the
// 10-01 call), so no older build draws them. porchProbe holds both; `corner` counts what was left out.
const PORCH_CORNER = ["cheek", "cornerFill"];
async function digest(page, skipGround = false) {
  return page.evaluate(({ skipGround, PORCH_CORNER }) => {
    const E = window.__ss3dEngine, M = E.model;
    M.root.updateMatrixWorld(true);
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    const out = [];
    let corner = 0;
    M.root.traverse((o) => {
      if (skipGround && o.userData && o.userData.ssGround) return;
      if (o.userData && PORCH_CORNER.includes(o.userData.ssPorchPart)) { corner++; return; }
      let s = `${o.type}|${o.matrixWorld.elements.map(r6).join(",")}|${o.visible}`;
      if (o.isMesh) {
        const g = o.geometry, pa = g.attributes.position;
        let h = 0;
        for (let i = 0; i < pa.array.length; i++) h = (h * 31 + Math.round(pa.array[i] * 1e5)) % 1000000007;
        const prm = g.type === "ExtrudeGeometry" ? "" : JSON.stringify(g.parameters || null);
        const m = o.material;
        s += `|${g.type}|${prm}|${pa.count}|${g.index ? g.index.count : -1}|${h}|${m && m.type}|${m && m.color ? m.color.getHexString() : ""}|${m && m.opacity}`;
      }
      out.push(s);
    });
    return { lines: out, corner, cam: [...E.camera.position.toArray(), ...E.controls.target.toArray()].map(r6) };
  }, { skipGround, PORCH_CORNER });
}

// Everything the fall assertions read, in world space, in one pass; `P` is what the pure functions say.
async function measure(page, W, L) {
  return page.evaluate(({ W, L }) => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const bbOf = (o) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      o.traverse((q) => {
        if (!q.isMesh || !q.geometry) return;
        if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
        const b = q.geometry.boundingBox;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        }
      });
      return { mn, mx, cx: (mn[0] + mx[0]) / 2, cz: (mn[2] + mx[2]) / 2 };
    };
    const all = (pred) => { const a = []; M.root.traverse((q) => { if (q.isMesh && pred(q)) a.push(q); }); return a; };
    const under = (q, anc) => { let n = q; while (n) { if (n === anc) return true; n = n.parent; } return false; };
    // THE DRAWN GRASS, sampled off its own triangles (barycentric in x-z), never off d3GradeAt.
    const ground = all((q) => q.userData && q.userData.ssGround)[0];
    const pos = ground.geometry.attributes.position, idx = ground.geometry.index;
    const wv = [];
    for (let i = 0; i < pos.count; i++) wv.push(new V().fromBufferAttribute(pos, i).applyMatrix4(ground.matrixWorld));
    const tris = [];
    for (let t = 0; t < idx.count; t += 3) tris.push([wv[idx.getX(t)], wv[idx.getX(t + 1)], wv[idx.getX(t + 2)]]);
    let upFaces = 0, downFaces = 0;
    const grassAt = (x, z) => {
      for (const [a, b, c] of tris) {
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
        const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * a.y + l2 * b.y + l3 * c.y;
      }
      return NaN;
    };
    // Faces under and around the building look up (their world normal's y).
    for (const [a, b, c] of tris) {
      if (Math.max(Math.abs(a.x), Math.abs(a.z)) > Math.max(W, L)) continue;
      const n = new V().subVectors(b, a).cross(new V().subVectors(c, a));
      if (n.length() < 1e-9) continue;
      if (n.y > 0) upFaces++; else downFaces++;
    }
    const lowestGrass = (cx, cz, hx, hz) => Math.min(grassAt(cx - hx, cz - hz), grassAt(cx + hx, cz - hz), grassAt(cx - hx, cz + hz), grassAt(cx + hx, cz + hz));
    const out = { grade: M.grade, gradeFall: M.gradeFall || null, foundation: M.foundation || null, groundType: ground.geometry.type, upFaces, downFaces,
      // The steps as built (14): the projecting porch's (d3PorchStepsGeom on the drawn porch) and a recessed one's.
      porchSteps: (M.porch && M.porch.steps) || null, recessedSteps: M.recessedSteps || null };
    // The grass along the fall's axis through the middle, and across it, for the profile checks.
    out.grassProbe = [];
    for (let k = -30; k <= 30; k++) {
      const s = k * 0.5;
      out.grassProbe.push({ s, alongX: grassAt(s, 0), alongZ: grassAt(0, s), offX: grassAt(s, 3.3), offZ: grassAt(2.7, s) });
    }
    // Supports under the building (not the deck's): one per stack, foot, top, the grass under them.
    const fpart = (name) => all((q) => q.userData && q.userData.ssFoundationPart === name);
    const inDeck = (q) => q.userData && q.userData.ssPorchPart === "deckSupport";
    const stacks = (list) => {
      const map = new Map();
      list.forEach((q) => {
        const b = bbOf(q), k = `${b.cx.toFixed(2)},${b.cz.toFixed(2)}`;
        const cur = map.get(k) || { cx: b.cx, cz: b.cz, bottom: Infinity, top: -Infinity, n: 0, hx: (b.mx[0] - b.mn[0]) / 2, hz: (b.mx[2] - b.mn[2]) / 2 };
        cur.bottom = Math.min(cur.bottom, b.mn[1]); cur.top = Math.max(cur.top, b.mx[1]); cur.n++;
        map.set(k, cur);
      });
      return [...map.values()].map((t) => ({ ...t, grassC: grassAt(t.cx, t.cz), grassLow: lowestGrass(t.cx, t.cz, t.hx, t.hz) }));
    };
    const kind = M.foundation && M.foundation.kind;
    out.supports = stacks(fpart(kind === "blocks" ? "block" : "pier").filter((q) => !inDeck(q)));
    out.deckSupports = stacks(all(inDeck));
    out.runnerBottom = Math.min(...fpart("runner").map((q) => bbOf(q).mn[1]));
    // The porch: deck frame (for d3PorchToRoot), rim, steps.
    const decks = []; M.root.traverse((q) => { if (q.userData && q.userData.ssPorch === "deck") decks.push(q); });
    const partsIn = (grp, name) => { const a = []; grp.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssPorchPart === name) a.push(q); }); return a; };
    if (decks.length) {
      const frame = decks[0].children[0];
      out.deckMap = [[0, 0], [1, 0], [0, 1], [2.5, 3]].map(([x, d]) => { const v = new V(x, 0, d).applyMatrix4(frame.matrixWorld); return { x, d, at: [v.x, v.z] }; });
      out.rimBottom = Math.min(...partsIn(decks[0], "rim").map((q) => bbOf(q).mn[1]));
    }
    out.steps = [];
    M.root.traverse((q) => {
      if (!(q.userData && q.userData.ssPorchPart === "steps")) return;
      const b = bbOf(q);
      const treads = partsIn(q, "stepTread").map((t) => bbOf(t));
      // The flight's footprint: the treads' union, and the grass under its four corners.
      const fx0 = Math.min(...treads.map((t) => t.mn[0])), fx1 = Math.max(...treads.map((t) => t.mx[0]));
      const fz0 = Math.min(...treads.map((t) => t.mn[2])), fz1 = Math.max(...treads.map((t) => t.mx[2]));
      const corners = [[fx0, fz0], [fx1, fz0], [fx0, fz1], [fx1, fz1]].map(([x, z]) => grassAt(x, z));
      // The flight's own frame (x across it, z = d out from the edge it leaves), as placed: where its
      // points land in the building's x, z (14).
      const map = [[0, 0], [1, 0], [0, 1], [-1.2, 2.5]].map(([x, d]) => { const v = new V(x, 0, d).applyMatrix4(q.matrixWorld); return { x, d, at: [v.x, v.z] }; });
      out.steps.push({ bottom: b.mn[1], top: b.mx[1], treads: treads.length, risers: partsIn(q, "stepRiser").length, treadTops: treads.map((t) => t.mx[1]).sort((p, r) => p - r), grassMin: Math.min(...corners), grassMax: Math.max(...corners),
        where: q.userData.ssPorchSteps, map });
    });
    // A slab's stem wall (2026-10-03): its top, and every vertex of its bottom edge against the grass there.
    out.stems = fpart("stem").map((q) => {
      const pa = q.geometry.attributes.position;
      let top = -Infinity, worst = -Infinity, n = 0;
      for (let i = 0; i < pa.count; i++) {
        const v = new V().fromBufferAttribute(pa, i).applyMatrix4(q.matrixWorld);
        top = Math.max(top, v.y);
        if (v.y < -0.35 - 1e-6) {
          const gy = grassAt(v.x, v.z);
          if (Number.isFinite(gy)) { worst = Math.max(worst, v.y - gy); n++; }
        }
      }
      return { wall: q.userData.ssStem, top, worst, n, inSlab: !!(q.parent && q.parent.userData && q.parent.userData.ssFoundation === "slab") };
    });
    out.skirtN = fpart("skirt").length;
    out.runnerN = fpart("runner").length;
    // Lean-to posts.
    out.leanPosts = all((q) => q.userData && q.userData.ssLeanToPost).map((q) => { const b = bbOf(q); return { bottom: b.mn[1], grassLow: lowestGrass(b.cx, b.cz, 0.15, 0.15), grassC: grassAt(b.cx, b.cz) }; });
    // Ramps: the lowest point, its far end, and the grass under its two far corners.
    out.ramps = [];
    M.interiorGroup.children.forEach((g) => {
      if (!(g.userData && g.userData.ssRamp)) return;
      const b = bbOf(g), wall = g.userData.ssRamp;
      const N = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[wall];
      const farA = N[0] ? (N[0] > 0 ? b.mx[0] : b.mn[0]) : (N[1] > 0 ? b.mx[2] : b.mn[2]);
      const lat = N[0] ? [b.mn[2], b.mx[2]] : [b.mn[0], b.mx[0]];
      const inset = 0.02;
      const g1 = N[0] ? grassAt(farA - N[0] * inset, lat[0] + inset) : grassAt(lat[0] + inset, farA - N[1] * inset);
      const g2 = N[0] ? grassAt(farA - N[0] * inset, lat[1] - inset) : grassAt(lat[1] - inset, farA - N[1] * inset);
      out.ramps.push({ wall, bottom: b.mn[1], top: b.mx[1], out: Math.abs(farA - (N[0] ? Math.sign(N[0]) * W / 2 : Math.sign(N[1]) * L / 2)), grassFar: Math.min(g1, g2) });
    });
    // Sheets on the grass: every vertex of the shades and the labels, over the grass under it.
    const sheetGap = (q) => {
      const pa = q.geometry.attributes.position; const gaps = [];
      for (let i = 0; i < pa.count; i++) {
        const v = new V().fromBufferAttribute(pa, i).applyMatrix4(q.matrixWorld);
        const gy = grassAt(v.x, v.z);
        if (Number.isFinite(gy)) gaps.push(v.y - gy);
      }
      return { min: Math.min(...gaps), max: Math.max(...gaps), n: gaps.length };
    };
    out.shades = fpart("shade").map(sheetGap);
    out.labels = all((q) => under(q, M.envGroup) && q !== ground && !(q.userData && q.userData.ssFoundationPart)).map(sheetGap);
    // The camera: the orbit target, and every support's foot in the frame.
    const cam = E.camera; cam.updateMatrixWorld(true);
    out.target = [E.controls.target.x, E.controls.target.y, E.controls.target.z];
    out.framed = out.supports.concat(out.deckSupports).map((t) => { const v = new V(t.cx, t.bottom, t.cz).project(cam); return [v.x, v.y, v.z]; });
    return out;
  }, { W, L });
}

// The DRAWN grass (its own triangles, barycentric in x-z) under each [x, z]: measure()'s grassAt.
async function grassUnder(page, pts) {
  return page.evaluate((pts) => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    let ground = null;
    M.root.traverse((q) => { if (!ground && q.isMesh && q.userData && q.userData.ssGround) ground = q; });
    const pos = ground.geometry.attributes.position, idx = ground.geometry.index;
    const wv = [];
    for (let i = 0; i < pos.count; i++) wv.push(new V().fromBufferAttribute(pos, i).applyMatrix4(ground.matrixWorld));
    const at = (x, z) => {
      for (let t = 0; t < idx.count; t += 3) {
        const a = wv[idx.getX(t)], b = wv[idx.getX(t + 1)], c = wv[idx.getX(t + 2)];
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
        const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * a.y + l2 * b.y + l3 * c.y;
      }
      return NaN;
    };
    return pts.map(([x, z]) => at(x, z));
  }, pts);
}
// A self-check camera in the editor's canvas: its eye, its aim, its 60° lens.
async function shootCam(page, file, cam) {
  await page.evaluate((cam) => {
    const E = window.__ss3dEngine;
    E.camera.fov = cam.fov;
    E.camera.updateProjectionMatrix();
    E.camera.position.set(...cam.eye);
    E.controls.target.set(...cam.at);
    E.controls.update();
    E.camera.lookAt(...cam.at);
    E.render();
  }, cam);
  await settle(page, 300);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.locator("canvas").last().screenshot({ path: file });
}
// The self-check's cameras as a revision before this fix aimed them (SS_EYE_BEFORE), or null.
function selfCheckBefore() {
  const rev = process.env.SS_EYE_BEFORE || "f33a6fa";
  try {
    return { rev, SELF: selfCheck(execFileSync("git", ["-C", REPO, "show", `${rev}:structure-studio.component.js`], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8")) };
  } catch (_e) {
    return { rev, SELF: null };
  }
}
const BEFORE = selfCheckBefore();

// Shots for the eye (SS_SHOTS): the building seen ACROSS the fall, so the rows of supports read short
// to tall; and from the corner on the downhill side, where the tall supports stand. `lift` is about
// the middle of the ground's depth.
async function aim(page, file, eye, at) {
  await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    if (E.camera.fov !== 34) { E.camera.fov = 34; E.camera.updateProjectionMatrix(); }
    E.camera.position.set(...eye);
    E.controls.target.set(...at);
    E.controls.update();
    E.render();
  }, { eye, at });
  await settle(page, 300);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.locator("canvas").last().screenshot({ path: file });
}
function sideShot(page, file, W, L, toward, lift) {
  const R = Math.max(W, L), side = toward === "back" ? [1, 0] : [0, 1];
  return aim(page, file, [side[0] * R * 2.1, 3.2 - lift, side[1] * R * 2.1], [0, 0.6 - lift, 0]);
}
function cornerShot(page, file, W, L, toward, lift) {
  const R = Math.max(W, L), ax = PURE.d3GradeFallAxis(toward, W, L), perp = [Math.abs(ax.dir[1]), Math.abs(ax.dir[0])];
  const dx = ax.dir[0] * 1.2 + perp[0], dz = ax.dir[1] * 1.2 + perp[1], n = Math.hypot(dx, dz);
  return aim(page, file, [(dx / n) * R * 2, 7 - lift, (dz / n) * R * 2], [0, 1.2 - lift, 0]);
}

async function runCase(ctx, c, ok, shots) {
  const tag = `${c.id} ${c.label} ${c.size} (${c.fall} ft ${c.toward})`;
  let page = null;
  try {
    const o = await openCase(ctx, c, ok, tag, null);
    page = o.page;
    const { W, L, errors } = o;
    const m = await measure(page, W, L);
    const g = c.grade, fall = c.fall;
    const ax = PURE.d3GradeFallAxis(c.toward, W, L), D = ax.ext, B = PURE.d3GradeFallBlendFt(fall, D);
    // ── 1. the model and the grass ──
    ok(`${tag}: model.grade is the front's ${g}; model.gradeFall ${fall} ft toward the ${c.toward}`,
      near(m.grade, g, 1e-9) && m.gradeFall && near(m.gradeFall.fallFt, fall, 1e-9) && m.gradeFall.toward === c.toward, JSON.stringify(m.gradeFall));
    ok(`${tag}: the grass is bent (not the level disc), every face under and round the building looking up`,
      m.groundType !== "CircleGeometry" && m.upFaces > 50 && m.downFaces === 0, `${m.groundType} up ${m.upFaces} down ${m.downFaces}`);
    // Along the fall's axis through the middle (and a line off it, since it is the same across):
    // a(s) is the distance down the fall of the probe point.
    const probe = m.grassProbe.map((p) => {
      const onX = ax.dir[0] !== 0;
      const a = onX ? p.s * ax.dir[0] : p.s * ax.dir[1];
      return { a, y: onX ? p.alongX : p.alongZ, yOff: onX ? p.offX : p.offZ, want: -PURE.d3GradeAt(c.d3, W, L, onX ? p.s : 0, onX ? 0 : p.s) };
    });
    const bad = probe.filter((p) => !(near(p.y, p.want, 0.003) && near(p.yOff, p.want, 0.003)));
    ok(`${tag}: ⚠️ THE DRAWN GRASS IS d3GradeAt (along the fall and off to one side, within 0.003 ft)`, bad.length === 0,
      bad.slice(0, 3).map((p) => `a ${f3(p.a)}: ${f3(p.y)}/${f3(p.yOff)} want ${f3(p.want)}`).join(" | "));
    const at = (a) => -PURE.d3GradeAt(c.d3, W, L, a * ax.dir[0], a * ax.dir[1]);
    ok(`${tag}: front grade ${g} along the uphill edge, ${g + fall} along the far edge, straight between`,
      near(at(-D / 2), -g, 1e-12) && near(at(D / 2), -(g + fall), 1e-12) && near(at(0), -(g + fall / 2), 1e-12) && near(at(D / 4), -(g + 0.75 * fall), 1e-12));
    ok(`${tag}: level past the blend either side (${f3(B)} ft), the ease under 3 in`,
      near(at(-D / 2 - B - 5), at(-D / 2 - B - 0.01), 1e-9) && near(at(D / 2 + B + 5), at(D / 2 + B + 0.01), 1e-9)
      && Math.abs(at(-D / 2 - B - 5) + g) <= 0.25 + 1e-9 && Math.abs(at(D / 2 + B + 5) + g + fall) <= 0.25 + 1e-9);
    // ── 2. the supports under the building ──
    const S = m.supports;
    const slope = fall / D, half = c.kind === "piers" ? 0.5 : null;
    const footBad = S.filter((t) => !(near(t.bottom, t.grassLow, 0.01) && t.bottom <= t.grassC + 0.01));
    ok(`${tag}: ⚠️ EVERY SUPPORT'S FOOT IS ON THE DRAWN GRASS: at the lowest grass under it, never above the grass at its centre (${S.length})`,
      S.length > 0 && footBad.length === 0, footBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) foot ${f3(t.bottom)} low ${f3(t.grassLow)} centre ${f3(t.grassC)}`).join(" | "));
    const centreGap = Math.max(...S.map((t) => Math.abs(t.bottom - t.grassC)));
    ok(`${tag}: ...within half its width's slope of the grass at its own x,z (${f3(centreGap)} ft; the uphill side bedded in)`,
      centreGap <= (half != null ? half : 8 / 12) * slope + 0.01 && (slope > 0.1 || centreGap <= 0.05), f3(centreGap));
    ok(`${tag}: every support tops out at the runners' underside`, S.every((t) => near(t.top, m.runnerBottom, 0.002)), f3(m.runnerBottom));
    if (c.thin) {
      ok(`${tag}: no support where there is no room (the front), piers where the ground has fallen away`,
        S.length >= m.foundation.runners.length && S.every((t) => t.top - t.bottom >= 0.04 && t.cx * ax.dir[0] + t.cz * ax.dir[1] + D / 2 > 1) && near(m.foundation.runnerH, 0.15, 1e-9),
        `${S.length} piers, runner ${f3(m.foundation.runnerH)}`);
    }
    // Heights against the distance down the fall: height = runner underside + depth at (a + half).
    const hOf = (t) => t.top - t.bottom;
    const aOf = (t) => t.cx * ax.dir[0] + t.cz * ax.dir[1];
    // Its foot is at the ground under its downhill edge: half its size further down the fall.
    const depthA = (a) => PURE.d3GradeAt(c.d3, W, L, a * ax.dir[0], a * ax.dir[1]);
    const expectH = (t) => m.runnerBottom + depthA(aOf(t) + (c.kind === "piers" ? 0.5 : (ax.dir[0] ? t.hx : t.hz)));
    const hBad = S.filter((t) => !near(hOf(t), expectH(t), 0.005));
    const rows = [...new Set(S.map((t) => aOf(t).toFixed(2)))].map(Number).sort((p, q) => p - q);
    const rowH = (a) => S.filter((t) => near(aOf(t), a, 0.01)).map(hOf);
    const up = Math.max(...rowH(rows[0])), downRow = Math.min(...rowH(rows[rows.length - 1]));
    ok(`${tag}: ⚠️ THE DOWNHILL ROW STANDS TALLER BY THE FALL TIMES ITS SHARE OF THE WAY ACROSS (${f3(up)} → ${f3(downRow)} ft over ${f3(rows[rows.length - 1] - rows[0])} ft)`,
      hBad.length === 0 && rows.length >= 2 && near(downRow - up, (fall * (rows[rows.length - 1] - rows[0])) / D, 0.005),
      hBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) ${f3(hOf(t))} want ${f3(expectH(t))}`).join(" | "));
    if (c.kind === "blocks") {
      // n is the nearest whole number of 8 in courses to the stack's own height (at least 1), and
      // model.foundation.supports records it for the support standing there.
      const sup = m.foundation.supports || [];
      const rec = (t) => sup.find((s) => near(s.x, t.cx, 0.01) && near(s.z, t.cz, 0.01));
      ok(`${tag}: block stacks a course per 8 in of their own height, recorded per support`,
        sup.length === S.length && S.every((t) => (t.n === 1 ? hOf(t) < 1 + 1e-6 : Math.abs(hOf(t) / (8 / 12) - t.n) <= 0.5 + 1e-6) && rec(t) && rec(t).courses === t.n)
        && new Set(S.map((t) => t.n)).size >= 2,
        S.map((t) => `${t.n}@${f3(hOf(t))}`).join(" "));
    }
    ok(`${tag}: model.foundation.supports say the foot each stands on`, (m.foundation.supports || []).every((s) => S.some((t) => near(t.cx, s.x, 0.01) && near(t.cz, s.z, 0.01) && near(t.bottom, s.y0, 0.002))));
    // ── 3. the porch, the lean-to, the ramp ──
    if (c.wall) {
      const DS = m.deckSupports;
      const dBad = DS.filter((t) => !(near(t.bottom, t.grassLow, 0.01) && t.bottom <= t.grassC + 0.01 && near(t.top, m.rimBottom, 0.002)));
      ok(`${tag}: ⚠️ THE DECK'S SUPPORTS REACH THE DRAWN GRASS AT THEIR OWN SPOT, FROM THE RIM (${DS.length})`, DS.length >= 2 && dBad.length === 0,
        dBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) ${f3(t.bottom)}..${f3(t.top)} grass ${f3(t.grassLow)}`).join(" | "));
      const st = m.steps[0];
      const rd = PURE.d3PorchReadout(c.d3, c.size);
      const count = st ? st.treads : 0, h = st ? -st.bottom : NaN, rise = h / (count + 1);
      ok(`${tag}: ⚠️ THE STEPS' FOOT IS ON THE GRASS: at the lowest grass under the flight, nothing floating`,
        st && near(st.bottom, st.grassMin, 0.01) && st.bottom <= st.grassMax + 0.01, st && `foot ${f3(st.bottom)} grass ${f3(st.grassMin)}..${f3(st.grassMax)}`);
      ok(`${tag}: ${count} steps, risers of ${f3(rise * 12)} in (7.5 in or less), treads rising evenly`,
        st && count >= 1 && st.risers === count && rise <= 7.5 / 12 + 1e-9 && st.treadTops.every((y, i) => near(y, -h + (i + 1) * rise, 0.003)), st && st.treadTops.map(f3).join(" "));
      // The readout builds its porch on panel cladding (its trimFace), so steps at a porch's side sit a
      // hair across from the drawn ones: the count is the same, the ground under them within 0.02 ft.
      ok(`${tag}: the panel's readout counts the same steps (d3PorchReadout ${rd && rd.steps && rd.steps.count})`, rd && rd.steps && rd.steps.count === count && near(-rd.steps.grade, h, 0.02),
        rd && rd.steps && `${rd.steps.count} at ${f3(-rd.steps.grade)}`);
      // ── 4. d3PorchToRoot is where the deck stands ──
      const toRoot = PURE.d3PorchToRoot(c.d3.roof, W, L);
      const mapBad = (m.deckMap || []).filter((p) => { const q = toRoot(p.x, p.d); return !(near(q[0], p.at[0], 1e-6) && near(q[1], p.at[1], 1e-6)); });
      ok(`${tag}: d3PorchToRoot maps the porch's frame onto the placed deck (${c.wall} wall)`, m.deckMap && mapBad.length === 0,
        mapBad.slice(0, 2).map((p) => `(${p.x},${p.d}) drawn ${p.at.map(f3)} pure ${toRoot(p.x, p.d).map(f3)}`).join(" | "));
    }
    if (c.leanTo) {
      const lp = m.leanPosts;
      ok(`${tag}: ⚠️ THE LEAN-TO'S POSTS STAND ON THE DRAWN GRASS AT THEIR OWN FOOT (${lp.length})`, lp.length >= 2 && lp.every((q) => near(q.bottom, q.grassLow, 0.01) && q.bottom <= q.grassC + 0.01),
        lp.map((q) => `${f3(q.bottom)}/${f3(q.grassLow)}`).join(" "));
    }
    if (c.ramp) {
      const r = m.ramps.find((q) => q.wall === "east");
      ok(`${tag}: ⚠️ THE RAMP RUNS FROM THE FLOOR TO THE DRAWN GRASS AT ITS FOOT`, r && near(r.bottom, r.grassFar, 0.08) && r.top <= 0.13, r && `${f3(r.bottom)} grass ${f3(r.grassFar)}`);
      const drop = r ? -r.grassFar : NaN;
      ok(`${tag}: ...1 in 4 or gentler (${f3(r && r.out)} ft out for a ${f3(drop)} ft drop)`, r && r.out >= Math.max(3, 4 * drop) - 0.15, r && f3(r.out));
    }
    // ── 5. sheets on the grass ──
    ok(`${tag}: the shade under the building${c.wall ? " and the deck" : ""} lies 0.02 over the grass everywhere`,
      m.shades.length === (c.wall ? 2 : 1) && m.shades.every((s) => s.n > 4 && s.min >= 0.012 && s.max <= 0.028), m.shades.map((s) => `${f3(s.min)}..${f3(s.max)}`).join(" "));
    ok(`${tag}: the ground labels lie on it`, m.labels.length >= 2 && m.labels.every((s) => s.n > 4 && s.min >= 0.03 && s.max <= 0.05), m.labels.map((s) => `${f3(s.min)}..${f3(s.max)}`).join(" "));
    // ── 6. the camera ──
    const maxLift = PURE.d3GradeLiftFt(c.d3), fH = PURE.d3FrameHeightFt(c.d3, W, L);
    ok(`${tag}: d3GradeLiftFt frames from the deepest ground (${f3(maxLift)} = ${g} + ${fall} - 0.35)`, near(maxLift, g + fall - 0.35, 1e-9));
    ok(`${tag}: the orbit target comes down with it (${f3(fH * 0.45 - maxLift)})`, near(m.target[1], fH * 0.45 - maxLift, 1e-6), f3(m.target[1]));
    const inNdc = (p) => Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && p[2] < 1;
    ok(`${tag}: the 3D editor frames every support's foot`, m.framed.every(inNdc), m.framed.filter((p) => !inNdc(p)).slice(0, 3).map((p) => p.map(f3).join(",")).join(" | "));
    // ── the directions are the ones the customer's 3D Views presets name ──
    // With no door placed the front is the south wall, and B, ← L and R → look at the back, left and
    // right. (A case with a door on another wall re-homes the presets; the ground stays put.)
    if (!c.ramp) {
      const preset = { back: "B", left: "← L", right: "R →" }[c.toward];
      await page.getByRole("button", { name: /Views/ }).first().click();
      await page.getByRole("button", { name: preset, exact: true }).first().click();
      await settle(page, 300);
      const cam = await page.evaluate(() => { const E = window.__ss3dEngine; return [E.camera.position.x - E.controls.target.x, E.camera.position.z - E.controls.target.z]; });
      const along = cam[0] * ax.dir[0] + cam[1] * ax.dir[1], across = Math.abs(cam[0] * ax.dir[1] - cam[1] * ax.dir[0]);
      ok(`${tag}: ⚠️ THE 3D VIEWS PRESET "${preset}" LOOKS AT THE SIDE THE GROUND FALLS TO`, along > 5 && across < 0.01 * along, `camera offset ${cam.map(f3)}`);
      if (shots) {
        await page.evaluate(() => window.__ss3dEngine.render());
        await page.locator("canvas").last().screenshot({ path: join(shots, `${c.id}-${c.toward}-preset.png`) });
      }
    }
    if (c.ramp) {
      // ⚠️ THE GROUND STAYS WITH THE BUILDING, LIKE THE ROOF (d3RoofAxes' rule). The door on the east wall
      // makes the east wall the customer's FRONT -- the Views presets re-home to it -- but the site the
      // builder described does not turn: the tallest supports are still on the ${c.toward} side.
      const tallest = S.reduce((a, t) => (hOf(t) > hOf(a) ? t : a));
      ok(`${tag}: ⚠️ A DOOR ON THE EAST WALL DOES NOT TURN THE GROUND: the tallest support is still toward the ${c.toward}`,
        m.gradeFall.toward === c.toward && aOf(tallest) > 0 && near(hOf(tallest), up + fall * (rows[rows.length - 1] - rows[0]) / D, 0.005),
        `tallest at (${f3(tallest.cx)},${f3(tallest.cz)}) ${f3(hOf(tallest))}`);
      await page.getByRole("button", { name: /Views/ }).first().click();
      await page.getByRole("button", { name: "F", exact: true }).first().click();
      await settle(page, 300);
      const camF = await page.evaluate(() => { const E = window.__ss3dEngine; return [E.camera.position.x - E.controls.target.x, E.camera.position.z - E.controls.target.z]; });
      ok(`${tag}: ...while the Views presets follow the door: F looks at the east wall`, camF[0] > 5 && Math.abs(camF[1]) < 0.01 * camF[0], `camera offset ${camF.map(f3)}`);
    }
    // ── 6b. the self-check's phone stands on the grass ──
    if (c.selfCheck) {
      const want = SELF.SS_SHOT.EYE_FT + SELF.D3.FLOOR_T;
      const cams = SELF.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: c.d3 }, WALK_MAP).filter((q) => q.viewpoint !== "eaveCorner");
      const grass = await grassUnder(page, cams.map((q) => [q.eye[0], q.eye[2]]));
      const gaps = cams.map((q, i) => ({ v: q.viewpoint, gap: q.eye[1] - grass[i] }));
      ok(`${tag}: ⚠️ THE SELF-CHECK'S PHONE STANDS ON THE GRASS: every walk view's eye is ${f3(want)} ft over the drawn grass under it (${cams.length} views)`,
        cams.length === 5 && gaps.every((q) => near(q.gap, want, 0.01)), gaps.map((q) => `${q.v} ${f3(q.gap)}`).join(" "));
      // The aim is 0.45 of the way up from the DEEPEST ground: the level building's, down 0.55 x the fall.
      const levelSpec = { ...c.d3 };
      delete levelSpec.gradeFallFt; delete levelSpec.gradeFallToward;
      const lvl = SELF.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: levelSpec }, WALK_MAP).filter((q) => q.viewpoint !== "eaveCorner");
      ok(`${tag}: ...its aim still frames from the deepest ground (the level building's aim, down 0.55 x the fall)`,
        cams.every((q, i) => near(q.at[1], lvl[i].at[1] - 0.55 * fall, 1e-6)), cams.map((q, i) => `${f3(q.at[1])}/${f3(lvl[i].at[1])}`).join(" "));
      // The UPHILL view: the one looking down the fall from its top, where the old eye was lowest.
      const ax = PURE.d3GradeFallAxis(c.toward, W, L);
      const uphill = cams.reduce((a, q) => ((q.eye[0] * ax.dir[0] + q.eye[2] * ax.dir[1]) < (a.eye[0] * ax.dir[0] + a.eye[2] * ax.dir[1]) ? q : a));
      if (BEFORE.SELF) {
        const olds = BEFORE.SELF.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: c.d3 }, WALK_MAP).filter((q) => q.viewpoint !== "eaveCorner");
        const og = await grassUnder(page, olds.map((q) => [q.eye[0], q.eye[2]]));
        const i = olds.findIndex((q) => q.viewpoint === uphill.viewpoint);
        ok(`${tag}: ...and the ${BEFORE.rev} designer's uphill (${uphill.viewpoint}) eye was not: ${f3(olds[i].eye[1] - og[i])} ft over the grass (this harness fails it)`,
          i >= 0 && Math.abs(olds[i].eye[1] - og[i] - want) > fall * 0.9, olds.map((q, k) => `${q.viewpoint} ${f3(q.eye[1] - og[k])}`).join(" "));
        if (shots && i >= 0) await shootCam(page, join(shots, `${c.id}-selfcheck-${uphill.viewpoint}-BEFORE.png`), olds[i]);
      }
      if (shots) await shootCam(page, join(shots, `${c.id}-selfcheck-${uphill.viewpoint}-AFTER.png`), uphill);
    }
    if (shots) {
      await cornerShot(page, join(shots, `${c.id}-${c.toward}-corner.png`), W, L, c.toward, g + fall / 2);
      await sideShot(page, join(shots, `${c.id}-${c.toward}-side.png`), W, L, c.toward, g + fall / 2);
    }
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    if (page) await page.close();
  }
}

// ── 7. LEVEL GROUND IS TODAY'S ──
async function runLevel(ctx, c, ok, base, shots) {
  const tag = `${c.id} ${c.label} ${c.size}`;
  const pages = [];
  try {
    const now = await openCase(ctx, c, ok, `${tag} (this build)`, null);
    pages.push(now.page);
    const a = await digest(now.page);
    const then = await openCase(ctx, c, ok, `${tag} (${base.rev})`, base.js);
    pages.push(then.page);
    const b = await digest(then.page);
    // Proof the two pages ran different designers: only this one's model says gradeFall (null here).
    const marks = await Promise.all([now.page, then.page].map((pg) => pg.evaluate(() => ("gradeFall" in window.__ss3dEngine.model ? window.__ss3dEngine.model.gradeFall : "absent"))));
    ok(`${tag}: this build says gradeFall null, the ${base.rev} designer has no such field (it really is the old bundle)`, marks[0] === null && marks[1] === "absent", JSON.stringify(marks));
    const i = a.lines.findIndex((l, k) => l !== b.lines[k]);
    ok(`${tag}: ⚠️ THE SCENE IS ${base.rev}'S, NODE FOR NODE (${a.lines.length} nodes: matrices, geometry, materials; ${a.corner} porch-corner parts left out)`,
      a.lines.length === b.lines.length && i < 0, i >= 0 ? `node ${i}: now ${a.lines[i] && a.lines[i].slice(0, 160)} | then ${b.lines[i] && b.lines[i].slice(0, 160)}` : `${a.lines.length} vs ${b.lines.length}`);
    ok(`${tag}: ...and the camera and its target`, JSON.stringify(a.cam) === JSON.stringify(b.cam), `${JSON.stringify(a.cam)} vs ${JSON.stringify(b.cam)}`);
    if (shots && c.id === "LV1") {
      const [W, L] = c.size.split("x").map(Number);
      await cornerShot(now.page, join(shots, "K-back-corner-BEFORE-level.png"), W, L, "back", 1.5 + 1);
      await sideShot(now.page, join(shots, "K-back-side-BEFORE-level.png"), W, L, "back", 1.5 + 1);
    }
    ok(`${tag}: zero page errors`, now.errors.length === 0 && then.errors.length === 0, [...now.errors, ...then.errors].slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    for (const p of pages) await p.close();
  }
}

// ── 10. A STORED FALL RENDERS AS IT DID ──
// The designer at SS_FALL_BASE (default 5fb622a, the commit before the corners): its compiled component.
function fallBaseBundle() {
  const rev = process.env.SS_FALL_BASE || "5fb622a";
  try {
    return { rev, js: execFileSync("git", ["-C", REPO, "show", `${rev}:structure-studio.component.compiled.js`], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8") };
  } catch (_e) {
    return { rev, js: null };
  }
}
async function runLegacy(ctx, c, ok, base) {
  const tag = `${c.id} ${c.label} ${c.size} (a stored fall, against ${base.rev})`;
  const pages = [];
  try {
    const now = await openCase(ctx, c, ok, tag, null);
    pages.push(now.page);
    const a = await digest(now.page, true);
    const then = await openCase(ctx, c, ok, `${tag} (${base.rev})`, base.js);
    pages.push(then.page);
    const b = await digest(then.page, true);
    const marks = await Promise.all([now.page, then.page].map((pg) => pg.evaluate(() => ("gradeCorners" in window.__ss3dEngine.model ? window.__ss3dEngine.model.gradeCorners : "absent"))));
    ok(`${tag}: this build reads the fall as corners, the ${base.rev} designer has no such field (it really is the old bundle)`,
      marks[0] && typeof marks[0] === "object" && marks[1] === "absent", JSON.stringify(marks));
    const i = a.lines.findIndex((l, k) => l !== b.lines[k]);
    ok(`${tag}: ⚠️ EVERY NODE BUT THE GRASS IS ${base.rev}'S (${a.lines.length} nodes: supports, deck, steps, posts, ramp, shade, labels; ${a.corner} porch-corner parts left out)`,
      a.lines.length === b.lines.length && i < 0, i >= 0 ? `node ${i}: now ${a.lines[i] && a.lines[i].slice(0, 160)} | then ${b.lines[i] && b.lines[i].slice(0, 160)}` : `${a.lines.length} vs ${b.lines.length}`);
    ok(`${tag}: ...and the camera and its target`, JSON.stringify(a.cam) === JSON.stringify(b.cam), `${JSON.stringify(a.cam)} vs ${JSON.stringify(b.cam)}`);
    ok(`${tag}: zero page errors`, now.errors.length === 0 && then.errors.length === 0, [...now.errors, ...then.errors].slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    for (const p of pages) await p.close();
  }
}

// ── 11. THE GROUND AT EACH CORNER ──
async function runCornerCase(ctx, c, ok, shots) {
  const gc = c.d3.gradeCornersFt;
  const tag = `${c.id} ${c.label} ${c.size} (corners ${gc.fl}/${gc.fr}/${gc.bl}/${gc.br})`;
  let page = null;
  try {
    const o = await openCase(ctx, c, ok, tag, null);
    page = o.page;
    const { W, L, errors } = o;
    const m = await measure(page, W, L);
    const want = PURE.d3GradeCorners(c.d3);
    const g = c.d3.floorHeightFt;
    const deepCorner = Object.entries(want).reduce((a, e) => (e[1] > a[1] ? e : a));
    const zeroCorner = Object.entries(want).find((e) => e[1] === 0);
    const cornerXZ = { fl: [-W / 2, L / 2], fr: [W / 2, L / 2], bl: [-W / 2, -L / 2], br: [W / 2, -L / 2] };
    const depth = (x, z) => PURE.d3GradeAt(c.d3, W, L, x, z);
    // ── the model and the grass ──
    const mc = await page.evaluate(() => ({ gc: window.__ss3dEngine.model.gradeCorners, gf: window.__ss3dEngine.model.gradeFall }));
    ok(`${tag}: model.gradeCorners is d3GradeCorners, the highest (${zeroCorner[0]}) the zero; no fall`,
      mc.gc && ["fl", "fr", "bl", "br"].every((k) => near(mc.gc[k], want[k], 1e-12)) && mc.gf === null && near(m.grade, g, 1e-9), JSON.stringify(mc));
    ok(`${tag}: the grass is bent (not the level disc), every face under and round the building looking up`,
      m.groundType !== "CircleGeometry" && m.upFaces > 50 && m.downFaces === 0, `${m.groundType} up ${m.upFaces} down ${m.downFaces}`);
    const pts = [];
    for (let x = -W / 2 - 6; x <= W / 2 + 6; x += 0.75) for (let z = -L / 2 - 6; z <= L / 2 + 6; z += 0.8) pts.push([x, z]);
    for (const k of Object.keys(cornerXZ)) pts.push(cornerXZ[k]);
    const grass = await grassUnder(page, pts);
    const gBad = pts.map((p, i) => ({ p, y: grass[i], want: -depth(p[0], p[1]) })).filter((q) => !near(q.y, q.want, 0.01));
    ok(`${tag}: ⚠️ THE DRAWN GRASS IS d3GradeAt'S FOUR-CORNER SURFACE, over and 6 ft round the footprint (${pts.length} points, within 0.01 ft)`,
      gBad.length === 0, gBad.slice(0, 3).map((q) => `(${f3(q.p[0])},${f3(q.p[1])}) ${f3(q.y)} want ${f3(q.want)}`).join(" | "));
    const atCorner = Object.fromEntries(Object.entries(cornerXZ).map(([k, p], i) => [k, grass[pts.length - 4 + i]]));
    ok(`${tag}: each corner's grass is the floor height plus its drop below the highest`,
      Object.keys(cornerXZ).every((k) => near(atCorner[k], -(g + want[k]), 0.005)), JSON.stringify(Object.fromEntries(Object.entries(atCorner).map(([k, v]) => [k, f3(v)]))));
    // ── the supports ──
    const S = m.supports;
    const foot = c.kind === "piers" ? () => [0.5, 0.5] : (t) => [t.hx, t.hz];
    const expectBottom = (t) => { const [hx, hz] = foot(t); return -Math.max(depth(t.cx - hx, t.cz - hz), depth(t.cx + hx, t.cz - hz), depth(t.cx - hx, t.cz + hz), depth(t.cx + hx, t.cz + hz)); };
    const footBad = S.filter((t) => !(near(t.bottom, expectBottom(t), 0.003) && near(t.bottom, t.grassLow, 0.015) && t.bottom <= t.grassC + 0.015));
    ok(`${tag}: ⚠️ EVERY SUPPORT'S FOOT IS ON THE DRAWN GRASS AT ITS OWN SPOT: the ground under its lowest edge (${S.length})`,
      S.length >= 4 && footBad.length === 0, footBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) foot ${f3(t.bottom)} want ${f3(expectBottom(t))} grass ${f3(t.grassLow)}`).join(" | "));
    ok(`${tag}: every support tops out at the runners' underside`, S.every((t) => near(t.top, m.runnerBottom, 0.002)), f3(m.runnerBottom));
    const hOf = (t) => t.top - t.bottom;
    const nearest = (k) => S.reduce((a, t) => (Math.hypot(t.cx - cornerXZ[k][0], t.cz - cornerXZ[k][1]) < Math.hypot(a.cx - cornerXZ[k][0], a.cz - cornerXZ[k][1]) ? t : a));
    const tallest = Math.max(...S.map(hOf)), shortest = Math.min(...S.map(hOf));
    const deepT = nearest(deepCorner[0]), zeroT = nearest(zeroCorner[0]);
    ok(`${tag}: ⚠️ THE SUPPORTS AT THE DEEPEST CORNER (${deepCorner[0]}, ${deepCorner[1]} ft down) ARE THE TALLEST (${f3(hOf(deepT))} ft), AT THE ZERO CORNER THE SHORTEST (${f3(hOf(zeroT))} ft)`,
      near(hOf(deepT), tallest, 0.005) && near(hOf(zeroT), shortest, 0.005) && hOf(deepT) - hOf(zeroT) > deepCorner[1] * 0.6, `tallest ${f3(tallest)} shortest ${f3(shortest)}`);
    if (c.kind === "blocks") {
      const sup = m.foundation.supports || [];
      ok(`${tag}: block stacks a course per 8 in of their own height, recorded per support`,
        sup.length === S.length && S.every((t) => (t.n === 1 ? hOf(t) < 1 + 1e-6 : Math.abs(hOf(t) / (8 / 12) - t.n) <= 0.5 + 1e-6)) && new Set(S.map((t) => t.n)).size >= 2,
        S.map((t) => `${t.n}@${f3(hOf(t))}`).join(" "));
    }
    // ── the porch, the lean-to, the ramp ──
    if (c.wall) {
      const DS = m.deckSupports;
      const dBad = DS.filter((t) => !(near(t.bottom, t.grassLow, 0.015) && t.bottom <= t.grassC + 0.015 && near(t.top, m.rimBottom, 0.002)));
      ok(`${tag}: ⚠️ THE DECK'S SUPPORTS REACH THE DRAWN GRASS AT THEIR OWN SPOT, FROM THE RIM (${DS.length})`, DS.length >= 2 && dBad.length === 0,
        dBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) ${f3(t.bottom)}..${f3(t.top)} grass ${f3(t.grassLow)}`).join(" | "));
      const st = m.steps[0];
      const rd = PURE.d3PorchReadout(c.d3, c.size);
      const count = st ? st.treads : 0, h = st ? -st.bottom : NaN, rise = h / (count + 1);
      ok(`${tag}: ⚠️ THE STEPS' FOOT IS ON THE GRASS: at the lowest grass under the flight`,
        st && near(st.bottom, st.grassMin, 0.015) && st.bottom <= st.grassMax + 0.015, st && `foot ${f3(st.bottom)} grass ${f3(st.grassMin)}..${f3(st.grassMax)}`);
      ok(`${tag}: ${count} steps, risers of ${f3(rise * 12)} in (7.5 in or less), the panel's readout counting the same`,
        st && count >= 1 && rise <= 7.5 / 12 + 1e-9 && rd && rd.steps && rd.steps.count === count && near(-rd.steps.grade, h, 0.02), rd && rd.steps && `${rd.steps.count} at ${f3(-rd.steps.grade)}`);
    }
    if (c.leanTo) {
      const lp = m.leanPosts;
      ok(`${tag}: ⚠️ THE LEAN-TO'S POSTS STAND ON THE DRAWN GRASS AT THEIR OWN FOOT (${lp.length})`, lp.length >= 2 && lp.every((q) => near(q.bottom, q.grassLow, 0.015) && q.bottom <= q.grassC + 0.015),
        lp.map((q) => `${f3(q.bottom)}/${f3(q.grassLow)}`).join(" "));
    }
    if (c.ramp) {
      const r = m.ramps.find((q) => q.wall === "east");
      ok(`${tag}: ⚠️ THE RAMP RUNS FROM THE FLOOR TO THE DRAWN GRASS AT ITS FOOT`, r && near(r.bottom, r.grassFar, 0.08) && r.top <= 0.13, r && `${f3(r.bottom)} grass ${f3(r.grassFar)}`);
      ok(`${tag}: ...1 in 4 or gentler`, r && r.out >= Math.max(3, 4 * -r.grassFar) - 0.15, r && f3(r.out));
    }
    // ── sheets on the grass ──
    ok(`${tag}: the shade under the building${c.wall ? " and the deck" : ""} lies 0.02 over the grass everywhere`,
      m.shades.length === (c.wall ? 2 : 1) && m.shades.every((s) => s.n > 4 && s.min >= 0.01 && s.max <= 0.03), m.shades.map((s) => `${f3(s.min)}..${f3(s.max)}`).join(" "));
    ok(`${tag}: the ground labels lie on it`, m.labels.length >= 2 && m.labels.every((s) => s.n > 4 && s.min >= 0.028 && s.max <= 0.052), m.labels.map((s) => `${f3(s.min)}..${f3(s.max)}`).join(" "));
    // ── the camera ──
    const maxLift = PURE.d3GradeLiftFt(c.d3), fH = PURE.d3FrameHeightFt(c.d3, W, L);
    ok(`${tag}: d3GradeLiftFt frames from the deepest corner (${f3(maxLift)} = ${g} + ${deepCorner[1]} - 0.35)`, near(maxLift, g + deepCorner[1] - 0.35, 1e-9));
    ok(`${tag}: the orbit target comes down with it`, near(m.target[1], fH * 0.45 - maxLift, 1e-6), f3(m.target[1]));
    const inNdc = (p) => Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && p[2] < 1;
    ok(`${tag}: the 3D editor frames every support's foot`, m.framed.every(inNdc), m.framed.filter((p) => !inNdc(p)).slice(0, 3).map((p) => p.map(f3).join(",")).join(" | "));
    if (c.selfCheck) {
      const wantEye = SELF.SS_SHOT.EYE_FT + SELF.D3.FLOOR_T;
      const cams = SELF.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: c.d3 }, WALK_MAP).filter((q) => q.viewpoint !== "eaveCorner");
      const gu = await grassUnder(page, cams.map((q) => [q.eye[0], q.eye[2]]));
      const gaps = cams.map((q, i) => ({ v: q.viewpoint, gap: q.eye[1] - gu[i] }));
      ok(`${tag}: ⚠️ THE SELF-CHECK'S PHONE STANDS ON THE GRASS: every walk view's eye ${f3(wantEye)} ft over the drawn grass under it`,
        cams.length === 5 && gaps.every((q) => near(q.gap, wantEye, 0.01)), gaps.map((q) => `${q.v} ${f3(q.gap)}`).join(" "));
    }
    if (shots) {
      const R = Math.max(W, L), [dx, dz] = cornerXZ[deepCorner[0]], n = Math.hypot(dx, dz);
      const lift = g + deepCorner[1] / 2;
      await aim(page, join(shots, `${c.id}-corners-deep.png`), [(dx / n) * R * 1.9, 6 - lift, (dz / n) * R * 1.9], [0, 1.2 - lift, 0]);
    }
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    if (page) await page.close();
  }
}

// ── 13. A SLAB ON GROUND THAT FALLS AWAY ──
async function runSlabCase(ctx, c, ok, shots) {
  const gc = c.d3.gradeCornersFt;
  const tag = `${c.id} ${c.label} ${c.size} (slab, corners ${gc.fl}/${gc.fr}/${gc.bl}/${gc.br})`;
  let page = null;
  try {
    const o = await openCase(ctx, c, ok, tag, null);
    page = o.page;
    const { W, L, errors } = o;
    const m = await measure(page, W, L);
    const want = PURE.d3GradeCorners(c.d3);
    const depth = (x, z) => PURE.d3GradeAt(c.d3, W, L, x, z);
    const mc = await page.evaluate(() => ({ gc: window.__ss3dEngine.model.gradeCorners, gf: window.__ss3dEngine.model.gradeFall }));
    ok(`${tag}: model.grade is the slab band's 0.35 at the highest corner; model.gradeCorners the corners; no fall`,
      near(m.grade, 0.35, 1e-9) && mc.gc && ["fl", "fr", "bl", "br"].every((k) => near(mc.gc[k], want[k], 1e-12)) && mc.gf === null, JSON.stringify(mc));
    ok(`${tag}: model.foundation is the slab's stem wall, four sides`, m.foundation && m.foundation.kind === "slab" && m.foundation.stems.length === 4, JSON.stringify(m.foundation));
    ok(`${tag}: the grass is bent, every face under and round the building looking up`, m.groundType !== "CircleGeometry" && m.upFaces > 50 && m.downFaces === 0, `${m.groundType} up ${m.upFaces} down ${m.downFaces}`);
    const pts = [];
    for (let x = -W / 2 - 6; x <= W / 2 + 6; x += 0.75) for (let z = -L / 2 - 6; z <= L / 2 + 6; z += 0.8) pts.push([x, z]);
    const grass = await grassUnder(page, pts);
    const gBad = pts.map((p, i) => ({ p, y: grass[i], want: -depth(p[0], p[1]) })).filter((q) => !near(q.y, q.want, 0.01));
    ok(`${tag}: the drawn grass is d3GradeAt's surface, the highest corner at the band's -0.35 (${pts.length} points)`,
      gBad.length === 0 && near(-depth(-W / 2, L / 2), -0.35, 1e-12), gBad.slice(0, 3).map((q) => `(${f3(q.p[0])},${f3(q.p[1])}) ${f3(q.y)} want ${f3(q.want)}`).join(" | "));
    // ── the stem wall ──
    const S = m.stems;
    ok(`${tag}: ⚠️ THE STEM WALL'S TOPS ARE AT THE BAND'S UNDERSIDE (-0.35), IN THE GROUP MARKED "slab"`,
      S.length === 4 && S.every((s) => near(s.top, -0.35, 1e-6) && s.inSlab), S.map((s) => `${s.wall} ${f3(s.top)}`).join(" "));
    ok(`${tag}: ⚠️ EVERY VERTEX OF ITS BOTTOM EDGE IS UNDER THE DRAWN GRASS (by its 3 in embed, a foot apart or less)`,
      S.every((s) => s.n >= 2 * (W / 2) && s.worst <= -0.2), S.map((s) => `${s.wall} ${s.n} verts, worst ${f3(s.worst)}`).join(" | "));
    ok(`${tag}: no skirt, no runners, no supports under the building, no shade`, m.skirtN === 0 && m.runnerN === 0 && m.supports.length === 0 && m.shades.length === 0,
      `${m.skirtN} ${m.runnerN} ${m.supports.length} ${m.shades.length}`);
    // ── the porch, the lean-to, the ramp ──
    const DS = m.deckSupports;
    const dBad = DS.filter((t) => !(near(t.bottom, t.grassLow, 0.015) && t.bottom <= t.grassC + 0.015 && near(t.top, m.rimBottom, 0.002)));
    ok(`${tag}: ⚠️ THE DECK'S PIERS STAND ON THE DRAWN GRASS, FROM THE AT-GRADE RIM (${DS.length})`, DS.length >= 2 && dBad.length === 0 && near(m.rimBottom, -0.32, 0.002),
      dBad.slice(0, 3).map((t) => `(${f3(t.cx)},${f3(t.cz)}) ${f3(t.bottom)}..${f3(t.top)} grass ${f3(t.grassLow)}`).join(" | ") + ` rim ${f3(m.rimBottom)}`);
    const st = m.steps[0];
    const rd = PURE.d3PorchReadout(c.d3, c.size);
    const count = st ? st.treads : 0, h = st ? -st.bottom : NaN, rise = h / (count + 1);
    ok(`${tag}: ⚠️ THE STEPS' FOOT IS ON THE GRASS: at the lowest grass under the flight`,
      st && near(st.bottom, st.grassMin, 0.015) && st.bottom <= st.grassMax + 0.015, st && `foot ${f3(st.bottom)} grass ${f3(st.grassMin)}..${f3(st.grassMax)}`);
    ok(`${tag}: ${count} steps down to it, risers of ${f3(rise * 12)} in (7.5 in or less), the panel's readout counting the same`,
      st && count >= 2 && rise <= 7.5 / 12 + 1e-9 && rd && rd.steps && rd.steps.count === count && near(-rd.steps.grade, h, 0.02), rd && rd.steps && `${rd.steps.count} at ${f3(-rd.steps.grade)}`);
    const lp = m.leanPosts;
    ok(`${tag}: the lean-to's posts stand on the drawn grass at their own foot (${lp.length})`, lp.length >= 2 && lp.every((q) => near(q.bottom, q.grassLow, 0.015) && q.bottom <= q.grassC + 0.015),
      lp.map((q) => `${f3(q.bottom)}/${f3(q.grassLow)}`).join(" "));
    const r = m.ramps.find((q) => q.wall === "east");
    ok(`${tag}: ⚠️ THE RAMP RUNS FROM THE FLOOR TO THE DRAWN GRASS AT ITS FOOT, 1 in 4 or gentler`,
      r && near(r.bottom, r.grassFar, 0.08) && r.top <= 0.13 && r.out >= Math.max(3, 4 * -r.grassFar) - 0.15, r && `${f3(r.bottom)} grass ${f3(r.grassFar)} out ${f3(r.out)}`);
    ok(`${tag}: the ground labels lie on it`, m.labels.length >= 2 && m.labels.every((s) => s.n > 4 && s.min >= 0.028 && s.max <= 0.052), m.labels.map((s) => `${f3(s.min)}..${f3(s.max)}`).join(" "));
    // ── the camera ──
    const deep = Math.max(want.fl, want.fr, want.bl, want.br), maxLift = PURE.d3GradeLiftFt(c.d3), fH = PURE.d3FrameHeightFt(c.d3, W, L);
    ok(`${tag}: the cameras frame from the deepest corner (lift ${f3(maxLift)} = its drop), the orbit target down with it`,
      near(maxLift, deep, 1e-9) && near(m.target[1], fH * 0.45 - maxLift, 1e-6), f3(m.target[1]));
    const inNdc = (p) => Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1 && p[2] < 1;
    ok(`${tag}: the 3D editor frames every deck pier's foot`, m.framed.every(inNdc), m.framed.filter((p) => !inNdc(p)).slice(0, 3).map((p) => p.map(f3).join(",")).join(" | "));
    if (c.selfCheck) {
      const wantEye = SELF.SS_SHOT.EYE_FT + SELF.D3.FLOOR_T;
      const cams = SELF.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: c.d3 }, WALK_MAP).filter((q) => q.viewpoint !== "eaveCorner");
      const gu = await grassUnder(page, cams.map((q) => [q.eye[0], q.eye[2]]));
      const gaps = cams.map((q, i) => ({ v: q.viewpoint, gap: q.eye[1] - gu[i] }));
      ok(`${tag}: the self-check's phone stands on the grass: every walk view's eye ${f3(wantEye)} ft over the drawn grass under it`,
        cams.length === 5 && gaps.every((q) => near(q.gap, wantEye, 0.01)), gaps.map((q) => `${q.v} ${f3(q.gap)}`).join(" "));
    }
    if (shots) {
      const R = Math.max(W, L);
      await aim(page, join(shots, `${c.id}-slab-deep.png`), [R * 1.3, 3 - deep / 2, -R * 1.5], [0, 0.4 - deep / 2, -2]);
      await aim(page, join(shots, `${c.id}-slab-side.png`), [R * 2.1, 1.6 - deep / 2, 0], [0, 0.2 - deep / 2, 0]);
    }
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    if (page) await page.close();
  }
}

// ── 14. STEPS OFF A DECK'S END, AND A RECESSED PORCH'S STEPS ────────────────────────────────────
async function runFlightCase(ctx, c, ok, shots) {
  const tag = `${c.id} ${c.label} ${c.size} (${c.recessed ? "recessed" : "deck end"}, ${c.wall})`;
  let page = null;
  try {
    const o = await openCase(ctx, c, ok, tag, null);
    page = o.page;
    const { W, L, errors } = o;
    const m = await measure(page, W, L);
    const st = m.steps[0];
    const rd = c.recessed ? PURE.d3RecessedPorchReadout(c.d3, c.size) : PURE.d3PorchReadout(c.d3, c.size);
    const s = rd && rd.steps;
    ok(`${tag}: one flight, "${c.d3.roof.porchSteps}", and the readout has it`, m.steps.length === 1 && st.where === c.d3.roof.porchSteps && !!s && s.where === st.where,
      JSON.stringify({ n: m.steps.length, where: st && st.where, readout: s && s.where }));
    if (!st || !s) return;
    // ⚠️ THE PLACED FLIGHT IS THE PURE MAP. A flight off a deck's end is turned onto it, by the turn, end and
    // middle of the flight as built (model.porch.steps: the drawn porch's side, which on a cladding other
    // than panel is a hair wider than the readout's); a recessed one is not turned.
    const b = c.recessed ? m.recessedSteps : m.porchSteps;
    const toRoot = c.recessed ? PURE.d3RecessedPorchToRoot(c.d3.roof, W, L, c.d3.wallHeightFt) : PURE.d3PorchToRoot(c.d3.roof, W, L);
    const pureAt = (x, d) => (b.turn ? toRoot(b.edgeX + b.turn * d, b.atD - b.turn * x) : toRoot(x, d));
    const mapBad = b ? st.map.filter((q) => { const w = pureAt(q.x, q.d); return !(near(w[0], q.at[0], 1e-6) && near(w[1], q.at[1], 1e-6)); }) : [];
    ok(`${tag}: ⚠️ THE PLACED FLIGHT LANDS WHERE ${c.recessed ? "d3RecessedPorchToRoot" : "d3PorchToRoot, TURNED ONTO THE DECK'S END,"} PUTS IT`,
      !!b && !!toRoot && mapBad.length === 0 && (c.recessed && !c.side ? !b.turn : !!b.turn && b.turn === s.turn && near(Math.abs(b.edgeX), Math.abs(s.edgeX), 0.1)),
      b ? mapBad.slice(0, 2).map((q) => `(${q.x},${q.d}) drawn ${q.at.map(f3)} pure ${pureAt(q.x, q.d).map(f3)}`).join(" | ") : "no model steps");
    const count = st.treads, h = -st.bottom, rise = h / (count + 1);
    ok(`${tag}: ⚠️ THE STEPS' FOOT IS ON THE GRASS: at the lowest grass under the flight, nothing floating`,
      near(st.bottom, st.grassMin, 0.015) && st.bottom <= st.grassMax + 0.015, `foot ${f3(st.bottom)} grass ${f3(st.grassMin)}..${f3(st.grassMax)}`);
    ok(`${tag}: ${count} steps, risers of ${f3(rise * 12)} in (7.5 in or less), treads rising evenly`,
      count >= 1 && st.risers === count && rise <= 7.5 / 12 + 1e-9 && st.treadTops.every((y, i) => near(y, -h + (i + 1) * rise, 0.003)), st.treadTops.map(f3).join(" "));
    ok(`${tag}: the panel's readout counts the same steps on the same ground (${s.count} at ${f3(-s.grade)})`, s.count === count && near(-s.grade, h, 0.02), `${count} at ${f3(h)}`);
    ok(`${tag}: deeper than the floor's own grade: the flight reaches the lower ground`, h > m.grade + 0.2, `${f3(h)} vs grade ${f3(m.grade)}`);
    if (shots) {
      const n = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] }[c.wall];
      const R = Math.max(W, L);
      await aim(page, join(shots, `${c.id}-flight.png`), [n[0] * R * 1.2 + n[1] * R * 0.6, 3 - h / 2, n[1] * R * 1.2 - n[0] * R * 0.6], [n[0] * W / 2, -h / 2, n[1] * L / 2]);
    }
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    if (page) await page.close();
  }
}

// ── 8. THE PANEL ────────────────────────────────────────────────────────────────────────────
const PANEL_STYLES = [
  { value: "cabin", label: "Harness Fall Cabin", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.8 }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { value: "tri", label: "Harness Fall Tri", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 1 }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "left" } },
  // Case K's porch in the panel (runPanelSteps): the back porch's steps over 2 ft of fall to the back.
  { value: "porch", label: "Harness Fall Porch", d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 1, porchOutFt: 6, porchEnd: "back", porchSteps: "center" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "back" } },
].map((s) => ({ ...s, img: null, sizes: ["16x24"], sizeInclusions: {}, sizeInclusionQty: {} }));
const PANEL_CONFIG = {
  clientId: "harness-gradefall-panel",
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: PANEL_STYLES,
  defaultSizes: ["16x24"],
  sizePricing: Object.fromEntries(PANEL_STYLES.map((s) => [s.value, { "16x24": { widthFt: 16, lengthFt: 24, basePrice: 9000 } }])),
  options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};

async function runPanel(ctx, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const calls = await stubSupabase(page, { config: PANEL_CONFIG, fixtures: { ramp: FIXTURES.ramp, items: [], windowColors: [] } });
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  // THE PANEL SENDS THE FALL'S KEYS AND THE CORNERS ON EVERY SAVE, null when there is none (review BC-1,
  // 2026-09-29, extended to gradeCornersFt). The server carries a stored value over any save that OMITS
  // the key, so this panel's "level ground" is an explicit null, which the sanitiser drops.
  const sentNull = (o, k) => has(o, k) && o[k] === null;
  const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
  const save = async () => {
    const before = saves().length;
    await page.getByRole("button", { name: "Save to config" }).click();
    const t0 = Date.now();
    while (saves().length === before) {
      if (Date.now() - t0 > 15000) throw new Error("Save sent no admin-save-settings call");
      await settle(page, 100);
    }
    await page.getByText("Saved — reload the page to see it live.").waitFor({ state: "visible", timeout: 15000 });
    return saves()[saves().length - 1].body;
  };
  const select = () => page.locator('select[data-ss-foundation="ss-grid"]');
  const group = () => page.locator('[data-ss-grade-corners="ss-grid"]');
  const box = (k) => group().locator(`input[data-ss-grade-corner="${k}"]`);
  const say = async (k) => (await group().locator(`[data-ss-grade-corner-say="${k}"]`).innerText()).replace(/\s+/g, " ").trim();
  const says = async () => { const o = {}; for (const k of ["fl", "fr", "bl", "br"]) o[k] = await say(k); return o; };
  const values = async () => { const o = {}; for (const k of ["fl", "fr", "bl", "br"]) o[k] = await box(k).inputValue(); return o; };
  const levelBtn = () => page.locator('button[data-ss-grade-level="ss-grid"]');
  const typeCorner = async (k, v) => {
    await box(k).click();
    await box(k).fill(String(v));
    await page.keyboard.press("Tab");
    await settle(page, 300);
  };
  const fhText = async () => (await page.locator('input[data-ss-floor-height="ss-grid"]').locator("xpath=..").innerText()).replace(/\s+/g, " ");
  const openStyle = async (label) => {
    const btn = page.getByRole("button", { name: label, exact: true });
    await btn.first().waitFor({ state: "visible", timeout: 30000 });
    await btn.first().click();
    await select().waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 400);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  try {
    await page.goto(`${BASE}/?client=${encodeURIComponent(PANEL_CONFIG.clientId)}&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    await openStyle("Harness Fall Cabin");
    const fhLevel = await fhText();
    ok("panel: level ground keeps the height box's hint it always had", fhLevel.includes("Ground to the top of the floor where the door or porch is. A door is 6 ft 8 in tall"), fhLevel);
    ok("panel: ...its ramp sentence and number too (4 x the 1.5 ft floor)",
      fhLevel.includes("Blank draws 1 ft 6 in. Porch steps climb the whole height, and a ramp a customer adds is drawn 6 ft long so it reaches the ground.") && !fhLevel.includes("4 ft for every foot"), fhLevel);
    ok("panel: ...and its label says at the front", /^Floor height off the ground, at the front \(ft\)/.test(fhLevel), fhLevel.slice(0, 60));
    const gText = (await group().innerText()).replace(/\s+/g, " ").trim();
    ok("panel: piers show 'Ground at each corner (in lower)', four blank boxes (placeholder 0), each reading 'level', no 'Level ground' button",
      (await group().count()) === 1 && /^Ground at each corner \(in lower\)/.test(gText) && same(await values(), { fl: "", fr: "", bl: "", br: "" })
      && (await box("fl").getAttribute("placeholder")) === "0" && same(await says(), { fl: "level", fr: "level", bl: "level", br: "level" }) && (await levelBtn().count()) === 0, gText);
    ok("panel: ...in plain words: 0 is the highest corner, the floor height measured there, the directions the 3D Views'",
      gText.includes("0 is the highest corner. Floor height is measured there. The piers stand taller where the ground is lower. Front, back, left and right are the sides the 3D's Views menu calls F, B, L and R."), gText);
    ok("panel: ...and the fall's two boxes are gone", (await page.locator("[data-ss-grade-fall],[data-ss-grade-fall-toward]").count()) === 0);
    let body = await save();
    ok("panel: ⚠️ AN UNTOUCHED LEVEL STYLE SAVES NO SLOPE: gradeCornersFt and both fall keys sent as an explicit null",
      sentNull(body.d3, "gradeCornersFt") && sentNull(body.d3, "gradeFallFt") && sentNull(body.d3, "gradeFallToward") && body.d3.foundation === "piers" && body.d3.floorHeightFt === 1.5,
      JSON.stringify({ c: body.d3.gradeCornersFt, f: body.d3.gradeFallFt, t: body.d3.gradeFallToward }));
    ok("panel: ...and every save says slabGround: true beside frame \"front\" (2026-10-03)", body.slabGround === true && body.frame === "front", JSON.stringify({ s: body.slabGround, f: body.frame }));
    // The boxes take INCHES (2026-10-03); the corners are stored, and read out, in feet.
    await typeCorner("fr", 24);
    ok("panel: a typed front-right 2 reads '2 ft lower' there and 'highest' at the other three",
      same(await says(), { fl: "highest", fr: "2 ft lower", bl: "highest", br: "highest" }), JSON.stringify(await says()));
    const fhSlope = await fhText();
    ok("panel: ...the height box now says it is taken at the highest corner", /^Floor height off the ground, at the highest corner \(ft\)/.test(fhSlope)
      && fhSlope.includes("Ground to the top of the floor at the highest corner, the one that reads “highest” below.") && !fhSlope.includes("where the door or porch is"), fhSlope);
    ok("panel: ⚠️ ...and no longer promises one ramp length: the ramp's rule instead",
      fhSlope.includes("a ramp runs 4 ft for every foot it drops.") && !fhSlope.includes("drawn 6 ft long"), fhSlope);
    ok("panel: ...and a 'Level ground' button appears", (await levelBtn().count()) === 1);
    body = await save();
    ok("panel: ⚠️ it saves all four corners, and the fall keys as null", same(body.d3.gradeCornersFt, { fl: 0, fr: 2, bl: 0, br: 0 }) && sentNull(body.d3, "gradeFallFt") && sentNull(body.d3, "gradeFallToward"),
      JSON.stringify(body.d3.gradeCornersFt));
    ok("panel: ...the box shows the 24 in typed", (await box("fr").inputValue()) === "24", await box("fr").inputValue());
    await typeCorner("bl", 18);
    await typeCorner("br", 30);
    ok("panel: back-left 18 in and back-right 30 in read '1 ft 6 in lower' and '2 ft 6 in lower'",
      same(await says(), { fl: "highest", fr: "2 ft lower", bl: "1 ft 6 in lower", br: "2 ft 6 in lower" }), JSON.stringify(await says()));
    body = await save();
    ok("panel: ...and save as typed", same(body.d3.gradeCornersFt, { fl: 0, fr: 2, bl: 1.5, br: 2.5 }), JSON.stringify(body.d3.gradeCornersFt));
    await typeCorner("fl", 108);
    ok("panel: past the band (72 in) a corner is held at 6 ft; the highest (zero) corner moves to back-left; under a foot is said in inches",
      same(await says(), { fl: "4 ft 6 in lower", fr: "6 in lower", bl: "highest", br: "1 ft lower" }), JSON.stringify(await says()));
    body = await save();
    ok("panel: ...saved at 6", body.d3.gradeCornersFt && body.d3.gradeCornersFt.fl === 6, JSON.stringify(body.d3.gradeCornersFt));
    await typeCorner("fl", "");
    body = await save();
    ok("panel: a cleared box is 0 there", same(body.d3.gradeCornersFt, { fl: 0, fr: 2, bl: 1.5, br: 2.5 }), JSON.stringify(body.d3.gradeCornersFt));
    if (shots) await group().screenshot({ path: join(shots, "panel-corners.png") }).catch(() => {});
    await levelBtn().click();
    await settle(page, 300);
    ok("panel: 'Level ground' empties every box and they read 'level'",
      same(await values(), { fl: "", fr: "", bl: "", br: "" }) && same(await says(), { fl: "level", fr: "level", bl: "level", br: "level" }) && (await levelBtn().count()) === 0);
    body = await save();
    ok("panel: ⚠️ ...AND SENDS gradeCornersFt null, an explicit clear", sentNull(body.d3, "gradeCornersFt") && sentNull(body.d3, "gradeFallFt"), JSON.stringify(body.d3.gradeCornersFt));
    await typeCorner("br", 12);
    // As a builder does it: a click on the select (which leaves the box it was in), then the pick.
    await select().focus();
    await select().selectOption("skids");
    await settle(page);
    ok("panel: skids hides the corners", (await group().count()) === 0);
    body = await save();
    ok("panel: ⚠️ LEAVING PIERS CLEARS THE CORNERS (sent as null)", body.d3.foundation === "skids" && sentNull(body.d3, "gradeCornersFt") && sentNull(body.d3, "gradeFallFt"), JSON.stringify(body.d3.gradeCornersFt));
    // A SLAB keeps the boxes (2026-10-03): a typed corner saves on it, with no floor height.
    await select().focus();
    await select().selectOption("slab");
    await settle(page);
    const slabText = (await group().innerText()).replace(/\s+/g, " ").trim();
    ok("panel: a slab shows the corners, with the slab's own sentence", (await group().count()) === 1 && slabText.includes("0 is the highest corner, where the slab meets the ground. More of the slab's concrete edge shows where the ground is lower."), slabText);
    await typeCorner("br", 12);
    body = await save();
    ok("panel: ⚠️ ...AND A CORNER TYPED ON A SLAB SAVES THERE, slabGround true, no floor height",
      body.d3.foundation === "slab" && same(body.d3.gradeCornersFt, { fl: 0, fr: 0, bl: 0, br: 1 }) && !has(body.d3, "floorHeightFt") && body.slabGround === true, JSON.stringify({ f: body.d3.foundation, c: body.d3.gradeCornersFt, h: body.d3.floorHeightFt, s: body.slabGround }));

    // A style storing a FALL (2 ft toward the left): it opens as corners, saves the fall back untouched,
    // and an edited corner saves corners in its place.
    await openStyle("Harness Fall Tri");
    ok("panel: a style storing a 2 ft fall to the left opens with it as corners: both left corners 24 in",
      same(await values(), { fl: "24", fr: "", bl: "24", br: "" }) && same(await says(), { fl: "2 ft lower", fr: "highest", bl: "2 ft lower", br: "highest" }), JSON.stringify(await values()));
    body = await save();
    ok("panel: ⚠️ ...AND SAVES THE FALL BACK EXACTLY, untouched, with no corners",
      body.d3.gradeFallFt === 2 && body.d3.gradeFallToward === "left" && sentNull(body.d3, "gradeCornersFt") && body.frame === "front",
      JSON.stringify({ c: body.d3.gradeCornersFt, f: body.d3.gradeFallFt, t: body.d3.gradeFallToward, frame: body.frame }));
    await typeCorner("br", 6);
    body = await save();
    ok("panel: ⚠️ editing a corner of it writes the four corners and drops the fall",
      same(body.d3.gradeCornersFt, { fl: 2, fr: 0, bl: 2, br: 0.5 }) && sentNull(body.d3, "gradeFallFt") && sentNull(body.d3, "gradeFallToward"),
      JSON.stringify({ c: body.d3.gradeCornersFt, f: body.d3.gradeFallFt, t: body.d3.gradeFallToward }));
    if (shots) await select().locator("xpath=../..").screenshot({ path: join(shots, "panel-fields.png") }).catch(() => {});
    // The preview draws the DRAFT: these corners, not the stored fall.
    await page.getByRole("button", { name: /Preview in 3D/ }).first().click();
    await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.gradeCorners && E.model.gradeCorners.br === 0.5); }, null, { timeout: 60000 });
    await settle(page, 800);
    const specNow = { ...PANEL_STYLES[1].d3, gradeFallFt: undefined, gradeFallToward: undefined, gradeCornersFt: { fl: 2, fr: 0, bl: 2, br: 0.5 } };
    const pv = await page.evaluate(() => { const E = window.__ss3dEngine; return { grade: E.model.grade, gc: E.model.gradeCorners, fall: E.model.gradeFall, target: E.controls.target.y }; });
    ok("panel: the 3D preview draws the typed corners, not the fall, its orbit target down by the deepest one",
      Math.abs(pv.grade - 1.5) < 1e-9 && same(pv.gc, { fl: 2, fr: 0, bl: 2, br: 0.5 }) && pv.fall === null
      && Math.abs(pv.target - (PURE.d3FrameHeightFt(specNow, 16, 24) * 0.45 - PURE.d3GradeLiftFt(specNow))) < 1e-6, JSON.stringify(pv));
    if (shots) await cornerShot(page, join(shots, "panel-preview-corners.png"), 16, 24, "left", 1.5 + 1);
    ok("panel: zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("panel: ran to the end", false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

// ── 8b. THE STEP BOX OVER FALLING GROUND (review, 2026-09-29) ──────────────────────────────────
// "Number of steps" said "blank = 3", the count at the FRONT's 1.5 ft, beside a back porch whose
// flight is drawn with 6 steps down to the lower ground (case K). Blank now says the drawn count, the
// rise hint under it agrees, and on the sanitiser's steepest fall (13 drawn) the hint says a typed
// count stops at 12. The 3D preview draws the placeholder's number.
async function runPanelSteps(ctx, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const calls = await stubSupabase(page, { config: PANEL_CONFIG, fixtures: { ramp: FIXTURES.ramp, items: [], windowColors: [] } });
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
  const save = async () => {
    const before = saves().length;
    await page.getByRole("button", { name: "Save to config" }).click();
    const t0 = Date.now();
    while (saves().length === before) {
      if (Date.now() - t0 > 15000) throw new Error("Save sent no admin-save-settings call");
      await settle(page, 100);
    }
    await page.getByText("Saved — reload the page to see it live.").waitFor({ state: "visible", timeout: 15000 });
    return saves()[saves().length - 1].body;
  };
  const count = () => page.locator('input[data-ss-step-count="ss-grid"]');
  const rise = async () => (await page.locator('div[data-ss-step-rise="ss-grid"]').innerText()).replace(/\s+/g, " ").trim();
  // The fall to the back is typed as its two back corners (2026-09-29: a box per corner), in inches
  // (2026-10-03): `ft` feet is typed as ft x 12.
  const cornerBox = (k) => page.locator(`[data-ss-grade-corners="ss-grid"] input[data-ss-grade-corner="${k}"]`);
  const fill = async (loc, v) => { await loc.click(); await loc.fill(String(v)); await page.keyboard.press("Tab"); await settle(page, 300); };
  const fallBack = async (ft) => { await fill(cornerBox("bl"), ft * 12); await fill(cornerBox("br"), ft * 12); };
  const spec = PANEL_STYLES.find((s) => s.value === "porch").d3;
  // The count the drawn flight has with the box blank, from the designer's own readout at the style's size.
  const drawnAt = (fall) => PURE.d3PorchReadout({ ...spec, gradeFallFt: fall }, "16x24").steps.count;
  const tag = "panel steps";
  try {
    await page.goto(`${BASE}/?client=${encodeURIComponent(PANEL_CONFIG.clientId)}&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    const btn = page.getByRole("button", { name: "Harness Fall Porch", exact: true });
    await btn.first().waitFor({ state: "visible", timeout: 30000 });
    await btn.first().click();
    await count().waitFor({ state: "visible", timeout: 15000 });
    await settle(page, 400);
    ok(`${tag}: the readout draws 6 steps over the 2 ft fall (3 at the front's own 1.5 ft)`, drawnAt(2) === 6, String(drawnAt(2)));
    ok(`${tag}: ⚠️ THE BLANK SAYS THE DRAWN COUNT: "blank = 6", not the front's 3`,
      (await count().inputValue()) === "" && (await count().getAttribute("placeholder")) === `blank = ${drawnAt(2)}`, await count().getAttribute("placeholder"));
    let r = await rise();
    ok(`${tag}: ...and the rise hint under it is of that flight, with nothing about the box's 12`, /^Each step rises 6\.\d in\.$/.test(r), r);
    const fh = (await page.locator('input[data-ss-floor-height="ss-grid"]').locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok(`${tag}: the height box's hint gives the ramp's rule over the fall, not one length`,
      fh.includes("a ramp runs 4 ft for every foot it drops.") && !fh.includes("drawn 6 ft long"), fh);
    const note = (await page.locator('[data-ss-grade-corners="ss-grid"]').innerText()).replace(/\s+/g, " ");
    ok(`${tag}: the corners say the directions are the 3D Views', wherever the porch is`,
      note.includes("Front, back, left and right are the sides the 3D's Views menu calls F, B, L and R, wherever the porch is."), note);
    if (shots) await count().locator("xpath=../..").screenshot({ path: join(shots, "panel-steps-fall2.png") }).catch(() => {});
    let body = await save();
    ok(`${tag}: ⚠️ SAVED UNTOUCHED, NO COUNT IS SENT (the placeholder is only words)`, !has(body.d3.roof, "porchStepCount") && body.d3.gradeFallFt === 2, JSON.stringify(body.d3.roof));

    // The sanitiser's steepest fall: blank draws 13, past the 12 a typed count may be.
    await fallBack(6);
    ok(`${tag}: a 6 ft fall: "blank = 13", the drawn count`, drawnAt(6) === 13 && (await count().getAttribute("placeholder")) === "blank = 13", await count().getAttribute("placeholder"));
    r = await rise();
    ok(`${tag}: ⚠️ ...AND THE HINT SAYS BLANK DRAWS 13 WHILE A TYPED COUNT STOPS AT 12`,
      /^Each step rises \d+(\.\d)? in\. Left blank, it draws 13 steps; a number typed here can be 12 at most\.$/.test(r), r);
    if (shots) await count().locator("xpath=../..").screenshot({ path: join(shots, "panel-steps-fall6.png") }).catch(() => {});
    await fill(count(), 12);
    r = await rise();
    ok(`${tag}: a typed 12 drops that sentence (the box is not blank)`, !r.includes("Left blank") && /^Each step rises/.test(r), r);
    ok(`${tag}: ...and the placeholder still says what blank would draw`, (await count().getAttribute("placeholder")) === "blank = 13", await count().getAttribute("placeholder"));
    body = await save();
    ok(`${tag}: ...and saves 12`, body.d3.roof.porchStepCount === 12, String(body.d3.roof.porchStepCount));
    await fill(count(), "");
    r = await rise();
    ok(`${tag}: cleared, the sentence is back`, r.includes("Left blank, it draws 13 steps"), r);
    body = await save();
    ok(`${tag}: ⚠️ ...AND THE KEY IS DELETED`, !has(body.d3.roof, "porchStepCount"), JSON.stringify(body.d3.roof));

    // Back to 2 ft; the 3D preview draws the placeholder's number.
    await fallBack(2);
    const ph = await count().getAttribute("placeholder");
    await page.getByRole("button", { name: /Preview in 3D/ }).first().click();
    await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.porch && E.model.porch.steps && E.model.gradeCorners); }, null, { timeout: 90000 });
    await settle(page, 800);
    const m = await page.evaluate(() => {
      const M = window.__ss3dEngine.model;
      let treads = 0;
      M.root.traverse((q) => { if (q.userData && q.userData.ssPorchPart === "stepTread") treads++; });
      return { treads, count: M.porch.steps.count, wall: M.porch.wall, gc: M.gradeCorners };
    });
    ok(`${tag}: ⚠️ THE 3D PREVIEW DRAWS THE PLACEHOLDER'S NUMBER (${ph})`,
      ph === `blank = ${m.count}` && m.treads === m.count && m.wall === "north" && m.gc && m.gc.bl === 2 && m.gc.br === 2 && m.gc.fl === 0, JSON.stringify({ ph, ...m }));
    if (shots) {
      await page.evaluate(() => { const E = window.__ss3dEngine; E.camera.position.set(30, 4, -34); E.controls.target.set(0, -1.5, -14); E.controls.update(); E.render(); });
      await settle(page, 300);
      await page.evaluate(() => window.__ss3dEngine.render());
      await page.locator("canvas").last().screenshot({ path: join(shots, "panel-steps-preview.png") }).catch(() => {});
    }
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran to the end`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

const { ok, failed } = reporter();
const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
const todo = CASES.filter((c) => !only || only.includes(c.id));
const shots = process.env.SS_SHOTS ? shotsDir("gradeFall") : null;
const base = baseBundle();
const { browser, ctx } = await launch({ width: 1280, height: 900 });
try {
  const N = Number(process.env.SS_CONC || 3);
  const q = todo.map((c) => () => runCase(ctx, c, ok, shots));
  if (!only || only.includes("level")) {
    if (base.js) LEVEL.forEach((c) => q.push(() => runLevel(ctx, c, ok, base, shots)));
    else console.log(`SKIP  level ground against ${base.rev}: that revision is not in this repository (set SS_LEVEL_BASE)`);
  }
  if (!only || only.includes("corners")) CORNER_CASES.forEach((c) => q.push(() => runCornerCase(ctx, c, ok, shots)));
  else CORNER_CASES.filter((c) => only.includes(c.id)).forEach((c) => q.push(() => runCornerCase(ctx, c, ok, shots)));
  SLAB_CASES.filter((c) => !only || only.includes("slab") || only.includes(c.id)).forEach((c) => q.push(() => runSlabCase(ctx, c, ok, shots)));
  FLIGHT_CASES.filter((c) => !only || only.includes("flights") || only.includes(c.id)).forEach((c) => q.push(() => runFlightCase(ctx, c, ok, shots)));
  if (!only || only.includes("legacy")) {
    const fb = fallBaseBundle();
    if (fb.js) CASES.filter((c) => LEGACY.includes(c.id)).forEach((c) => q.push(() => runLegacy(ctx, c, ok, fb)));
    else console.log(`SKIP  a stored fall against ${fb.rev}: that revision is not in this repository (set SS_FALL_BASE)`);
  }
  if (!only || only.includes("panel")) q.push(() => runPanel(ctx, ok, shots));
  if (!only || only.includes("panel") || only.includes("panelSteps")) q.push(() => runPanelSteps(ctx, ok, shots));
  await Promise.all(Array.from({ length: N }, async () => { while (q.length) await q.shift()(); }));
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL PASS");
process.exit(bad.length ? 1 : 0);
