// The quote's four-corner page (migration 276), and the quote's one-view page that must not move
// because of it.
//
// Carolyn, 2026-08-20: a 3D page that "gets 4 sides. So 4 quadrants"; 2026-09-08: "we want to see 4
// images... one from each corner". d3QuoteCornerCameras walks the quote camera (d3DefaultShotCamera's
// lens, distance, height and aim) round to the four corners, and renderQuoteCornerSheet composes the
// four renders onto one letter-sized sheet. What is pinned here:
//
//   * the twins carry the same text, for the cameras, the sheet and submitQuote's page-2 choice;
//   * the quote's own shot is still 1200 x 900 at 0.9 with its one camera (selfCheckShots_test pins
//     the same literals; this file pins them again because it is the change that sits beside them);
//   * the corner sheet asks for 800 x 600 at 0.92 and is letter-shaped, so the PDF wrapper lays it
//     edge to edge (buildPdfFromJpegPages: no margin when the aspect matches letter);
//   * four cameras at 45 / 135 / 225 / 315 from the front, labelled so that "Front right" really is
//     the corner between the plan sheet's FRONT and RIGHT walls, for every front wall;
//   * each camera is the quote camera's framing, moved, and the WHOLE building is in its frame on a
//     range of shapes, raised floors included;
//   * submitQuote: the sheet goes on page 2 only with 3D on and the switch on, falls back to the
//     single view, and the 3D image (view3dImageUrl) stays the single view.
//
// The arithmetic is lifted out of the shipped source by stable anchors and run — the
// selfCheckShots_test technique. Whether the picture LOOKS right needs a GPU: that is
// tests/harness/quoteCornerViews.mjs, which submits a real quote headless and reads the PDF.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `quoteCornerShots_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  // 0. D3.WALL_H / FLOOR_T / OVERHANG.
  ["const D3 = {", "// The casing reveal every opening"],
  // 1. d3RoofAxes through d3FrameHeightFt, d3GradeLiftFt and d3ModelTopFt: the quote framing's inputs.
  ["function d3RoofAxes(", "function d3FtIn("],
  // 2. The quote's own camera.
  ["function d3DefaultShotCamera(", "// A default 3/4 view of the building"],
  // 3. The quote's own function, as TEXT (it awaits loadThree and touches a canvas).
  ["async function renderDefault3DShot(", "// ─── THE QUOTE'S FOUR CORNERS"],
  // 4. The four corners: the table, the cameras, the sheet. The sheet is lifted for its text.
  ["// ─── THE QUOTE'S FOUR CORNERS", "// ─── THE SELF-CHECK'S OWN CAMERAS"],
  // 5. The azimuth convention the corners share with the self-check.
  ["const D3_WALL_AZIMUTH = {", "// Which wall the model's azimuth 0 is looking at."],
  // 6. The plan sheet's FRONT / BACK / LEFT / RIGHT, which the labels must agree with.
  ["function getDisplayLabel(", "// How to name a wall in a sentence"],
  // 7. submitQuote's page 2.
  ["      const offscreenShotArgs = () => ({", "      const blob = buildPdfFromJpegPages(pdfPages);"],
];
const blocks = REGIONS.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));

Deno.test("every lifted region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

const QUOTE_SRC = blocks[3].cmp;
const CORNER_SRC = blocks[4].cmp;
const SUBMIT_SRC = blocks[7].cmp;
const RUNNABLE = [blocks[0], blocks[1], blocks[2], blocks[4], blocks[5], blocks[6]].map((b) => b.cmp).join("\n");

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `${RUNNABLE}; return { D3, d3RoofAxes, d3FrameHeightFt, d3GradeLiftFt, d3ModelTopFt, d3DefaultShotCamera, ` +
    `D3_QUOTE_CORNERS, d3QuoteCornerCameras, D3_QUOTE_SHEET, D3_WALL_AZIMUTH, ssAzimuthDir, getDisplayLabel };`,
)() as Record<string, Any>;

// ── The quote's one-view page has not moved ─────────────────────────────────────────────────

Deno.test("⚠️ the quote's single view is still 1200 x 900 at JPEG 0.9, with its one camera", () => {
  assert(QUOTE_SRC.includes("{ w: 1200, h: 900, quality: 0.9, cameras: d3DefaultShotCamera }"), QUOTE_SRC);
  assert(QUOTE_SRC.includes("return { url: shots[0].url, w: shots[0].w, h: shots[0].h };"), QUOTE_SRC);
  assertEquals(F.d3DefaultShotCamera({ bldgW: 12, bldgH: 16, frontWall: "south" }).length, 1);
});

// ── The sheet ───────────────────────────────────────────────────────────────────────────────

Deno.test("⚠️ the corner shots are 800 x 600 at JPEG 0.92, off ONE model build, through the corner cameras", () => {
  assert(
    CORNER_SRC.includes("await d3OffscreenShots(p, { w: 800, h: 600, quality: 0.92, cameras: d3QuoteCornerCameras });"),
    "renderQuoteCornerSheet no longer asks d3OffscreenShots for the four corners at 800 x 600 / 0.92:\n" + CORNER_SRC,
  );
  // One call, not four: the model build is the expensive part (d3OffscreenShots' header).
  assertEquals((CORNER_SRC.match(/d3OffscreenShots\(/g) || []).length, 1);
});

Deno.test("the sheet is letter-shaped, so the PDF lays it edge to edge like the floor plan", () => {
  const S = F.D3_QUOTE_SHEET;
  // buildPdfFromJpegPages: margin 0 when |w/h - 612/792| < 0.01, else an 18 pt border and a shrink.
  assert(Math.abs(S.W / S.H - 612 / 792) < 0.001, `${S.W} x ${S.H} is not letter-shaped`);
  assertEquals([S.W, S.H], [1632, 2112], "8.5 x 11 in at 192 px an inch");
  // Half an inch of paper all round, where every office printer can print.
  assertEquals(S.MARGIN, 96);
  // Two 4:3 cells across the inside width, and four of them (with labels and the title) fit the height.
  const cellW = (S.W - S.MARGIN * 2 - S.GAP) / 2;
  const cellH = Math.round(cellW * 3 / 4);
  assertEquals([cellW, cellH], [700, 525]);
  assert(46 + 18 + 26 + 56 + (30 + 14 + cellH) * 2 + S.GAP <= S.H - S.MARGIN * 2, "the block fits inside the margins");
});

Deno.test("the sheet returns the three keys every caller reads, and null rather than a broken page", () => {
  assert(CORNER_SRC.includes("return { url, w: S.W, h: S.H };"), CORNER_SRC);
  assert(CORNER_SRC.includes("if (!shots || shots.length !== D3_QUOTE_CORNERS.length) return null;"), "a missing corner means no sheet, not three quadrants");
  assert(CORNER_SRC.includes("if (!url || url.length < 512) return null;"), "a lost context reads as no sheet");
  assert(/catch \(_e\) \{\s*return null;\s*\}/.test(CORNER_SRC), "it never throws");
  // A browser that never fires onload must not hold the customer's submit open.
  assert(CORNER_SRC.includes("Promise.race(") && CORNER_SRC.includes("D3_QUOTE_SHEET_DECODE_MS"), "the decode wait is bounded");
});

Deno.test("each quadrant carries its corner's name, in the sheet's reading order", () => {
  for (const c of F.D3_QUOTE_CORNERS) assert(CORNER_SRC.includes("ctx.fillText(D3_QUOTE_CORNERS[i].label"), c.label);
  assertEquals(F.D3_QUOTE_CORNERS.map((c: Any) => c.label), ["Front left", "Front right", "Back left", "Back right"]);
});

// ── The cameras ─────────────────────────────────────────────────────────────────────────────

const WALLS = ["south", "east", "north", "west"];
// Each wall's outward normal in world (x, z): renderDefault3DShot's own OUT map, squared up.
const NORMAL: Record<string, number[]> = { south: [0, 1], east: [1, 0], north: [0, -1], west: [-1, 0] };

Deno.test("four cameras, 45 / 135 / 225 / 315 from the front, one per corner", () => {
  const cams = F.d3QuoteCornerCameras({ bldgW: 12, bldgH: 16, frontWall: "south" });
  assertEquals(cams.length, 4);
  assertEquals(cams.map((c: Any) => c.azimuthDeg), [315, 45, 225, 135]);
  assertEquals(cams.map((c: Any) => c.corner), ["frontLeft", "frontRight", "backLeft", "backRight"]);
});

Deno.test("⚠️ 'Front right' is the corner between the plan's FRONT and RIGHT walls, for every front wall", () => {
  // The two walls a corner camera sees are the two whose outward normals point toward it. Their
  // names on the plan sheet (getDisplayLabel, relative to the front wall) must be the label's two
  // words. Mirror the azimuth and "Front right" shows the customer the left-hand wall.
  for (const fw of WALLS) {
    for (const cam of F.d3QuoteCornerCameras({ bldgW: 12, bldgH: 16, frontWall: fw })) {
      const seen = WALLS
        .filter((w) => NORMAL[w][0] * cam.eye[0] + NORMAL[w][1] * cam.eye[2] > 1e-6)
        .map((w) => String(F.getDisplayLabel(w, fw)).toLowerCase())
        .sort();
      const want = cam.label.toLowerCase().split(" ").sort();
      assertEquals(seen, want, `front wall ${fw}, ${cam.label}: the camera sees ${seen.join(" + ")}`);
    }
  }
});

Deno.test("no front wall yet (no door): the front is the south wall, as for the single view", () => {
  const none = F.d3QuoteCornerCameras({ bldgW: 12, bldgH: 16 });
  const south = F.d3QuoteCornerCameras({ bldgW: 12, bldgH: 16, frontWall: "south" });
  assertEquals(none, south);
});

Deno.test("each corner is the quote camera's framing, walked round: same lens, distance, height and aim", () => {
  const shapes = [
    { bldgW: 12, bldgH: 16, frontWall: "south" },
    { bldgW: 10, bldgH: 40, frontWall: "east", style3d: { roof: { type: "gable" }, wallHeightFt: 9 } },
    { bldgW: 16, bldgH: 24, frontWall: "north", style3d: { roof: { type: "gambrel" }, wallHeightFt: 14 } },
    { bldgW: 12, bldgH: 20, frontWall: "west", style3d: { roof: { type: "gable" }, wallHeightFt: 8, foundation: "piers", floorHeightFt: 3 } },
  ];
  for (const p of shapes) {
    const one = F.d3DefaultShotCamera(p)[0];
    const r1 = Math.hypot(one.eye[0], one.eye[2]);
    for (const c of F.d3QuoteCornerCameras(p)) {
      const tag = `${p.bldgW}x${p.bldgH} ${p.frontWall} ${c.label}`;
      assertEquals(c.fov, one.fov, tag);
      assertAlmostEquals(Math.hypot(c.eye[0], c.eye[2]), r1, 1e-9, tag);
      assertAlmostEquals(c.eye[1], one.eye[1], 1e-9, tag);
      assertEquals(c.at, one.at, tag);
      assertAlmostEquals(c.far, one.far, 1e-9, tag);
      // The sun stands behind the camera, as on every off-screen shot (nothing casts a shadow there).
      assertAlmostEquals(c.sun[0], c.eye[0] * 0.8, 1e-9, tag);
      assertAlmostEquals(c.sun[2], c.eye[2] * 0.8, 1e-9, tag);
    }
  }
});

Deno.test("a raised floor brings the eye and the aim down by its lift, like the single view", () => {
  const flat = { bldgW: 12, bldgH: 20, style3d: { roof: { type: "gable" }, wallHeightFt: 8 } };
  const raised = { bldgW: 12, bldgH: 20, style3d: { roof: { type: "gable" }, wallHeightFt: 8, foundation: "piers", floorHeightFt: 3 } };
  const lift = F.d3GradeLiftFt(raised.style3d);
  assert(lift > 0, "the raised case is raised");
  for (const [c, p] of [[F.d3QuoteCornerCameras(raised)[0], raised], [F.d3QuoteCornerCameras(flat)[0], flat]] as Array<[Any, Any]>) {
    const frameH = F.d3FrameHeightFt(p.style3d, p.bldgW, p.bldgH);
    const l = F.d3GradeLiftFt(p.style3d);
    assertAlmostEquals(c.at[1], frameH * 0.45 - l, 1e-9);
  }
});

/** Is world point `pt` inside this camera's frustum at 4:3? Pinhole, zero roll, three.js conventions. */
function inFrame(cam: Any, pt: number[]): boolean {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: number[]) => {
    const l = Math.sqrt(dot(a, a));
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const f = norm(sub(cam.at, cam.eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const v = sub(pt, cam.eye);
  const z = dot(v, f);
  if (z <= 0 || z > cam.far) return false;
  const vHalf = Math.tan((cam.fov / 2) * Math.PI / 180);
  const hHalf = vHalf * (800 / 600);
  return Math.abs(dot(v, u)) <= z * vHalf && Math.abs(dot(v, r)) <= z * hHalf;
}

Deno.test("⚠️ the WHOLE building is in every quadrant, on every shape tried", () => {
  // The ground under the footprint (the lowered ground on a raised floor), the eaves out to the
  // overhang, and the ridge's two ends at the model's top: a cropped ridge or far end on the page
  // the customer is shown reads as a wrong building.
  const sizes = [[16, 24], [10, 40], [24, 16], [12, 12], [8, 10], [40, 10], [12, 40]];
  const roofs = ["gable", "gambrel"];
  const walls = [7, 9, 14];
  const floors: Array<Record<string, unknown>> = [{}, { foundation: "piers", floorHeightFt: 3 }];
  let checked = 0;
  for (const [W, L] of sizes) {
    for (const type of roofs) {
      for (const wallHeightFt of walls) {
        for (const floor of floors) {
          const spec = { roof: { type }, wallHeightFt, ...floor };
          const ov = F.D3.OVERHANG;
          const base = -(F.d3GradeLiftFt(spec) + F.D3.FLOOR_T);
          const top = F.d3ModelTopFt(spec, W, L);
          const ridgeAlongZ = L >= W;
          const pts: number[][] = [];
          for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
              pts.push([sx * W / 2, base, sz * L / 2]);
              pts.push([sx * (W / 2 + ov), wallHeightFt, sz * (L / 2 + ov)]);
            }
          }
          for (const s of [-1, 1]) pts.push(ridgeAlongZ ? [0, top, s * (L / 2 + ov)] : [s * (W / 2 + ov), top, 0]);
          for (const fw of WALLS) {
            for (const cam of F.d3QuoteCornerCameras({ bldgW: W, bldgH: L, frontWall: fw, style3d: spec })) {
              for (const pt of pts) {
                assert(inFrame(cam, pt), `${W}x${L} ${type} wall ${wallHeightFt}${floor.foundation ? " on piers" : ""} front ${fw}, ${cam.label}: ${JSON.stringify(pt)} is outside the frame`);
                checked++;
              }
            }
          }
        }
      }
    }
  }
  assert(checked > 10000, `only ${checked} points checked`);
});

// ── submitQuote's page 2 ────────────────────────────────────────────────────────────────────

Deno.test("⚠️ page 2 is the sheet only with 3D on AND the switch on, and falls back to the single view", () => {
  assert(SUBMIT_SRC.includes("if (view3dOn && C.quoteCornerViews === true) {"), SUBMIT_SRC);
  assert(SUBMIT_SRC.includes("const sheet = await renderQuoteCornerSheet(offscreenShotArgs());"), SUBMIT_SRC);
  assert(SUBMIT_SRC.includes("if (sheet) page3d = sheet;"), "a null sheet leaves the single view");
  assert(SUBMIT_SRC.includes("let page3d = shot3d;"), SUBMIT_SRC);
  assert(SUBMIT_SRC.includes("if (page3d) pdfPages.push({ bytes: dataUrlToBytes(page3d.url), w: page3d.w, h: page3d.h });"), SUBMIT_SRC);
  // The single view keeps both of its gates (the 2026-09-21 fix: no 3D page with 3D off).
  assert(SUBMIT_SRC.includes("let shot3d = view3dOn ? render3DSnapshotRef.current : null;"), SUBMIT_SRC);
  assert(SUBMIT_SRC.includes("if (!shot3d && view3dOn) {"), SUBMIT_SRC);
});

Deno.test("the 3D image beside the PDF stays the single view (the order screen's card is 4:3)", () => {
  for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]]) {
    const upload = lift(src, file, "      let view3dImageUrl = null;", "      // 4. Save the design row");
    assert(upload.includes("if (shot3d) {") && upload.includes("dataUrlToBytes(shot3d.url)"), `${file}: the -3d- upload is still shot3d`);
    assert(!upload.includes("page3d"), `${file}: page3d never reaches the 3D image upload`);
  }
});
