// The self-check's cameras, and the quote PDF's camera that must not move with them.
//
// Two things are tested here and they pull in opposite directions, which is the whole reason
// the file exists.
//
// ONE. `renderDefault3DShot` renders page 2 of the customer's quote at 1200 x 900, JPEG 0.9.
// The self-check wanted 896 x 672 at 0.80 and four cameras off one model build. Editing the
// quote's function to take those as arguments would have re-cut every quote in the field the
// first time either caller changed its mind, and nothing on that path would have said so. So
// the shared body was lifted into `d3OffscreenShots`, the quote kept its own numbers, and
// those numbers are PINNED here as literal text: this test fails if anyone parameterises
// them away.
//
// TWO. The self-check's cameras are derived from the model's own per-frame azimuth labels
// rather than fixed in advance, because the measured azimuths of a real eight-frame lap are
// 0, 111, 149, 218, 272, 294, 332, 358 degrees and a uniform orbit is wrong by a mean of 37
// and a max of 66. The arithmetic that turns a label into a camera is pure, so it is lifted
// out of the source by stable anchors and run — the wallSlab_test / porchGeom_test technique
// — and every lifted region is asserted byte-identical across the two hand-mirrored twins.
//
// What this file CANNOT test is whether the resulting picture is legible: that needs a GPU
// and it lives in tests/harness/calSelfCheck.mjs, which renders the real thing headless and
// measures it. What it CAN test is that the building is inside the frame, which is the
// failure that would make a correct model look wrong to a builder comparing it with a photo.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `selfCheckShots_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  // D3.WALL_H, the fallback wall height every camera falls back to.
  ["const D3 = {", "// The casing reveal every opening"],
  // d3RoofAxes: which ends are gable ends, and the profile span the roof peak is read off.
  ["function d3RoofAxes(", "function d3FtIn("],
  // The quote's own camera, which is pure and must keep answering what it always answered.
  ["function d3DefaultShotCamera(", "// A default 3/4 view of the building"],
  // The quote's function itself — lifted as TEXT, for the size and quality pin below.
  ["async function renderDefault3DShot(", "// ─── THE SELF-CHECK'S OWN CAMERAS"],
  // Everything the self-check's camera derivation is made of.
  ["const SS_SHOT = {", "// Render the draft the builder just paid for"],
];
const blocks = REGIONS.map(([a, b]) => {
  const cmp = lift(CMP, "structure-studio.component.js", a, b);
  const jsx = lift(JSX, "StructureStudio.jsx", a, b);
  return { a, cmp, jsx };
});

Deno.test("every lifted shot region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// The quote's own function is lifted for its TEXT, not to be run: it awaits loadThree() and
// touches a canvas. Everything else runs.
const QUOTE_SRC = blocks[3].cmp;
const RUNNABLE = [blocks[0], blocks[1], blocks[2], blocks[4]].map((b) => b.cmp).join("\n");

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `${RUNNABLE}; return { D3, d3RoofAxes, d3DefaultShotCamera, SS_SHOT, SS_SELFCHECK_VIEWS, ` +
    `SS_EAVE_YAW_DEG, D3_WALL_AZIMUTH, ssAzimuthDir, d3FrontGableWall, ssFitDistance, ssSelfCheckCameras };`,
)() as Record<string, Any>;

// ── ONE: the quote PDF's shot has not moved ───────────────────────────────────────────────

Deno.test("⚠️ the quote PDF's shot is still 1200 x 900 at JPEG 0.9", () => {
  // As a literal, because that is what a refactor would take away. A caller that passed these
  // in from outside would make every quote in the field one careless argument from re-cutting.
  assert(
    QUOTE_SRC.includes("{ w: 1200, h: 900, quality: 0.9, cameras: d3DefaultShotCamera }"),
    "renderDefault3DShot no longer asks for 1200 x 900 at 0.9 by literal:\n" + QUOTE_SRC,
  );
});

Deno.test("⚠️ the quote PDF's shot returns the same three keys it always returned", () => {
  // Its callers destructure { url, w, h } and treat null as "no 3D page". d3OffscreenShots
  // hands back the whole camera object spread into the result, so the quote deliberately
  // narrows it again rather than leaking fov/eye/at into the PDF path.
  assert(QUOTE_SRC.includes("return { url: shots[0].url, w: shots[0].w, h: shots[0].h };"), QUOTE_SRC);
  assert(QUOTE_SRC.includes("if (!shots || !shots[0]) return null;"), QUOTE_SRC);
});

Deno.test("the quote's camera is the D3Viewer framing it has always been", () => {
  const cams = F.d3DefaultShotCamera({ bldgW: 12, bldgH: 16, frontWall: "south" });
  assertEquals(cams.length, 1);
  // Recomputed here from the rule the header states (34 degree lens, dist = R * 3.66, the
  // front three-quarter OUT map) rather than copied off the function, so a change to either
  // has to be a deliberate change to both.
  const R = 16 * 0.5 + F.D3.WALL_H;
  const dist = R * 3.66;
  const out = [0.35, 1];
  const len = Math.sqrt(0.35 * 0.35 + 1);
  assertEquals(cams[0].fov, 34);
  assertAlmostEquals(cams[0].eye[0], (out[0] / len) * dist, 1e-9);
  assertAlmostEquals(cams[0].eye[1], dist * 0.5, 1e-9);
  assertAlmostEquals(cams[0].eye[2], (out[1] / len) * dist, 1e-9);
  assertEquals(cams[0].at, [0, F.D3.WALL_H * 0.45, 0]);
  assertAlmostEquals(cams[0].far, dist * 10, 1e-9);
});

// ── TWO: where azimuth 0 points ───────────────────────────────────────────────────────────

Deno.test("⚠️ azimuth walks the way the prompt says it walks", () => {
  // "0 is square in front of the gable end the door is on ... toward its RIGHT side, 90 is
  // square to the right-hand long side, 180 the far gable end, 270 the left-hand long side."
  // With the front end at south, right is east. Mirror this and every pair is mirrored.
  const near = (got: number[], want: number[]) => {
    assertAlmostEquals(got[0], want[0], 1e-9);
    assertAlmostEquals(got[1], want[1], 1e-9);
  };
  near(F.ssAzimuthDir(0), [0, 1]);     // south, +z
  near(F.ssAzimuthDir(90), [1, 0]);    // east, +x — the RIGHT-hand long side
  near(F.ssAzimuthDir(180), [0, -1]);  // north, -z
  near(F.ssAzimuthDir(270), [-1, 0]);  // west, -x
});

Deno.test("the wall table is exactly the inverse of the direction function", () => {
  // Two statements of the same fact drift; this is the assertion that stops them.
  const OUT: Record<string, number[]> = { south: [0, 1], east: [1, 0], north: [0, -1], west: [-1, 0] };
  for (const wall of Object.keys(OUT)) {
    const d = F.ssAzimuthDir(F.D3_WALL_AZIMUTH[wall]);
    assertAlmostEquals(d[0], OUT[wall][0], 1e-9, wall);
    assertAlmostEquals(d[1], OUT[wall][1], 1e-9, wall);
  }
});

Deno.test("the front gable end is where the renderer puts the porch, in all four cases", () => {
  // Mirrors d3ProjectingPorch's own arithmetic. Portrait (length >= width): the gable ends are
  // south and north. Landscape: west and east.
  assertEquals(F.d3FrontGableWall({ type: "gambrel" }, 16, 24), "south");
  assertEquals(F.d3FrontGableWall({ type: "gambrel", porchEnd: "back" }, 16, 24), "north");
  assertEquals(F.d3FrontGableWall({ type: "gable" }, 24, 16), "west");
  assertEquals(F.d3FrontGableWall({ type: "gable", porchEnd: "back" }, 24, 16), "east");
  // A shed swaps the axes, and the anchor has to swap with them or the render faces the
  // long wall while the frame faces the end.
  assertEquals(F.d3FrontGableWall({ type: "shed" }, 16, 24), "west");
  // No roof config at all still answers something, because a draft can arrive before one.
  assertEquals(F.d3FrontGableWall(null, 16, 24), "south");
});

Deno.test("⚠️ porchEnd 'back' puts the azimuth-0 camera on the opposite side", () => {
  const map = { front: { frame: 1, azimuthDeg: 0 } };
  const base = { bldgW: 16, bldgH: 24, style3d: { roof: { type: "gambrel" }, wallHeightFt: 9 } };
  const f = F.ssSelfCheckCameras(base, map)[0];
  const b = F.ssSelfCheckCameras({ ...base, style3d: { roof: { type: "gambrel", porchEnd: "back" }, wallHeightFt: 9 } }, map)[0];
  assert(f.eye[2] > 0, `front-end camera should stand at +z, got ${f.eye[2]}`);
  assert(b.eye[2] < 0, `back-end camera should stand at -z, got ${b.eye[2]}`);
  assertAlmostEquals(f.eye[2], -b.eye[2], 1e-6);
});

// ── TWO: which cameras exist ──────────────────────────────────────────────────────────────

const SPEC = { bldgW: 16, bldgH: 24, style3d: { roof: { type: "gambrel" }, wallHeightFt: 9 } };
const FULL_MAP = {
  front: { frame: 1, azimuthDeg: 0 },
  side: { frame: 3, azimuthDeg: 90 },
  eaveCorner: { frame: 5, azimuthDeg: 270 },
  corner: { frame: 7, azimuthDeg: 315 },
};

Deno.test("no frame map means no cameras, and therefore no check", () => {
  // Nothing here invents an angle. A generation whose first pass named no frames gets the
  // compare step it can honestly show, which is none, rather than a render aimed at a guess.
  assertEquals(F.ssSelfCheckCameras(SPEC, null), []);
  assertEquals(F.ssSelfCheckCameras(SPEC, {}), []);
});

Deno.test("one camera per labelled viewpoint, in the order the pairs are shown", () => {
  const all = F.ssSelfCheckCameras(SPEC, FULL_MAP);
  assertEquals(all.map((c: Any) => c.viewpoint), F.SS_SELFCHECK_VIEWS);
  assertEquals(all.map((c: Any) => c.frame), [1, 3, 5, 7]);
  assertEquals(all.map((c: Any) => c.azimuthDeg), [0, 90, 270, 315]);
  // A partial map is a partial set, not a padded one.
  const two = F.ssSelfCheckCameras(SPEC, { side: FULL_MAP.side, corner: FULL_MAP.corner });
  assertEquals(two.map((c: Any) => c.viewpoint), ["side", "corner"]);
});

Deno.test("a half-answer is dropped whole rather than half-rendered", () => {
  // parseFrameMap already refuses these on the server. Defended again here because this
  // function is also reachable from a reply an older function returned, and a camera aimed at
  // NaN renders a black frame that looks like a broken 3D rather than like a missing label.
  for (const bad of [{ frame: 0, azimuthDeg: 90 }, { frame: 1 }, { azimuthDeg: 90 }, { frame: 2, azimuthDeg: "x" }]) {
    assertEquals(F.ssSelfCheckCameras(SPEC, { side: bad }), [], JSON.stringify(bad));
  }
});

Deno.test("an azimuth past one lap is wrapped, never dropped or doubled", () => {
  const a = F.ssSelfCheckCameras(SPEC, { side: { frame: 2, azimuthDeg: 450 } })[0];
  const b = F.ssSelfCheckCameras(SPEC, { side: { frame: 2, azimuthDeg: 90 } })[0];
  assertEquals(a.azimuthDeg, 90);
  assertAlmostEquals(a.eye[0], b.eye[0], 1e-9);
  assertAlmostEquals(a.eye[2], b.eye[2], 1e-9);
});

// ── TWO: the pictures are pointed at the building and contain all of it ───────────────────

/** Is world point `pt` inside this camera's frustum? Pinhole, zero roll, three.js conventions. */
function inFrame(cam: Any, pt: number[]): boolean {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
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
  const hHalf = vHalf * (F.SS_SHOT.W / F.SS_SHOT.H);
  return Math.abs(dot(v, u)) <= z * vHalf && Math.abs(dot(v, r)) <= z * hHalf;
}

/** The eight corners of the building's bounding box plus the ridge line's two ends. */
function hull(W: number, L: number, H: number, peak: number): number[][] {
  const pts: number[][] = [];
  for (const x of [-W / 2, W / 2]) {
    for (const z of [-L / 2, L / 2]) {
      for (const y of [0, H]) pts.push([x, y, z]);
    }
  }
  pts.push([0, peak, -L / 2], [0, peak, L / 2]);
  return pts;
}

Deno.test("⚠️ the WHOLE building is in frame, at every azimuth and on every shape tried", () => {
  // The failure this stops is the quiet one: a render that crops the ridge or the far end
  // reads to a builder as a wrong model, and they will answer the checklist about our
  // cropping rather than about their building. 10 x 40 and 24 x 16 are in the list because
  // every ratio in the original viewpoint design was back-solved from a 16 x 24.
  const sizes = [[16, 24], [10, 40], [24, 16], [12, 12], [8, 10], [40, 10]];
  const walls = [7, 9, 14];
  let checked = 0;
  for (const [W, L] of sizes) {
    for (const wallHeightFt of walls) {
      for (let az = 0; az < 360; az += 45) {
        const p = { bldgW: W, bldgH: L, style3d: { roof: { type: "gambrel" }, wallHeightFt } };
        const cam = F.ssSelfCheckCameras(p, { front: { frame: 1, azimuthDeg: az } })[0];
        const S = F.d3RoofAxes({ type: "gambrel" }, W, L).S;
        for (const pt of hull(W, L, wallHeightFt, wallHeightFt + S * 0.62)) {
          assert(inFrame(cam, pt), `${W}x${L} wall ${wallHeightFt} az ${az}: ${JSON.stringify(pt)} is outside the frame`);
          checked++;
        }
      }
    }
  }
  assert(checked > 800, `only ${checked} points checked`);
});

Deno.test("the camera stands outside the building, never in it", () => {
  for (const [W, L] of [[16, 24], [10, 40], [40, 10]]) {
    for (let az = 0; az < 360; az += 45) {
      const p = { bldgW: W, bldgH: L, style3d: { roof: { type: "gambrel" }, wallHeightFt: 9 } };
      for (const cam of F.ssSelfCheckCameras(p, {
        front: { frame: 1, azimuthDeg: az },
        eaveCorner: { frame: 2, azimuthDeg: az },
      })) {
        const inside = Math.abs(cam.eye[0]) < W / 2 && Math.abs(cam.eye[2]) < L / 2;
        assert(!inside, `${cam.viewpoint} at ${W}x${L} az ${az} stands inside the walls: ${JSON.stringify(cam.eye)}`);
      }
    }
  }
});

Deno.test("⚠️ the wide views are shot from a phone at chest height, not from a crane", () => {
  // A chest-height photograph beside a render taken from 12 ft looks wrong for a reason that
  // has nothing to do with the model, and the builder is being asked to judge exactly that.
  for (const cam of F.ssSelfCheckCameras(SPEC, FULL_MAP)) {
    if (cam.viewpoint === "eaveCorner") continue;
    assertEquals(cam.eye[1], 5.3, cam.viewpoint);
    assertEquals(cam.fov, 60, cam.viewpoint);
  }
});

Deno.test("the eave camera is a CLOSE view, aimed above the wall top", () => {
  const cams = F.ssSelfCheckCameras(SPEC, FULL_MAP);
  const eave = cams.find((c: Any) => c.viewpoint === "eaveCorner");
  const wide = cams.find((c: Any) => c.viewpoint === "side");
  const far = (c: Any) => Math.sqrt(c.eye[0] * c.eye[0] + c.eye[2] * c.eye[2]);
  assertEquals(eave.fov, 38);
  assert(far(eave) < far(wide), `eave ${far(eave).toFixed(1)} should be nearer than side ${far(wide).toFixed(1)}`);
  // Looking UP at the roof edge with sky behind it: the aim point is above the wall and the
  // eye below it. Flip either and the shot becomes a picture of the wall.
  assert(eave.at[1] > 9, `aim point ${eave.at[1]} should be above the 9 ft wall`);
  assert(eave.eye[1] < 9, `eye ${eave.eye[1]} should be below the 9 ft wall`);
  assert(eave.eye[1] < eave.at[1]);
});

Deno.test("the eave camera keeps the design's framing, at an angle a builder can still pair", () => {
  // THE DESIGN'S CAMERA IS NOT COPIED, AND THE DIFFERENCE IS ONE NUMBER. Its measured shot
  // stood 0.69 W out from the wall and 0.52 L along it, which is 48.6 degrees off the wall's
  // own normal — and this render is about to be put beside the builder's frame of that wall
  // and they are going to be asked whether the two match. Half a right angle away is the
  // error the whole frameMap exists to avoid. So the FRAMING is kept (the run that makes the
  // frame about 1.27 wall heights tall at a 38 degree lens, the eye below the eave, the aim
  // above it) and the yaw is reduced to SS_EAVE_YAW_DEG, which the UX work puts inside the
  // band where a pair still reads as a fair comparison.
  const H = 9;
  const eave = F.ssSelfCheckCameras(SPEC, { eaveCorner: { frame: 2, azimuthDeg: 90 } })[0];
  const run = Math.hypot(eave.eye[0] - eave.at[0], eave.eye[2] - eave.at[2]);
  const reach = Math.hypot(run, eave.eye[1] - eave.at[1]);
  const want = (1.27 * H) / (2 * Math.tan((38 / 2) * Math.PI / 180));
  assertAlmostEquals(reach, want, want * 0.05, `eye-to-target ${reach.toFixed(2)} vs ${want.toFixed(2)}`);
  assertAlmostEquals(eave.eye[1], 0.69 * H, 0.05);
  assertAlmostEquals(eave.at[1], 1.02 * H, 0.05);
  // The yaw, read back off the camera the function actually produced rather than off the
  // constant, so a sign error in the trigonometry cannot pass by agreeing with itself.
  const yaw = Math.abs(Math.atan2(eave.eye[2] - eave.at[2], eave.eye[0] - eave.at[0]) * 180 / Math.PI);
  assertAlmostEquals(yaw, F.SS_EAVE_YAW_DEG, 0.5, `yaw ${yaw.toFixed(1)}`);
  assert(F.SS_EAVE_YAW_DEG >= 15 && F.SS_EAVE_YAW_DEG <= 40, String(F.SS_EAVE_YAW_DEG));
});

Deno.test("a bigger building is shot from further back, monotonically", () => {
  // The old rule — a constant times the biggest dimension — is fine for one fixed view and
  // wrong for an arbitrary azimuth on a 10 x 40. This is the property that replaced it.
  let prev = 0;
  for (const L of [12, 24, 40, 60]) {
    const cam = F.ssSelfCheckCameras(
      { bldgW: 16, bldgH: L, style3d: { roof: { type: "gambrel" }, wallHeightFt: 9 } },
      { side: { frame: 1, azimuthDeg: 90 } },
    )[0];
    const d = Math.abs(cam.eye[0]);
    assert(d > prev, `a ${L} ft long building should be shot from further back than the last: ${d} <= ${prev}`);
    prev = d;
  }
});

Deno.test("ssFitDistance never returns a camera inside the footprint", () => {
  for (const depthHalf of [4, 8, 20]) {
    for (const crossHalf of [4, 8, 20]) {
      for (const peak of [10, 20, 34]) {
        const d = F.ssFitDistance({ depthHalf, crossHalf, peak, eyeY: 5.3, lookY: peak * 0.45, fovDeg: 60 });
        assert(d > depthHalf, `${d} <= ${depthHalf}`);
        assert(isFinite(d), String(d));
      }
    }
  }
});
