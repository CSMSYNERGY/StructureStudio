// WINGS — the raised-centre ("monitor") massing, tested against BOTH SHIPPED designer twins.
//
// A two-storey centre under the style's own gable, enclosed single-storey wings down its eave
// sides (roof.wingSide / wingWidthFt / wingPitch / centerEaveFt, 2026-09-24). Everything about the
// shape that is not a mesh lives in pure module-scope functions: d3Massing (the centre's span,
// offset and eave, and each wing's roof line), d3WallTops / d3WallTopFt (how tall each wall stands
// along its length, which is what an opening is clamped under), d3CeilingFt, d3PorchSpanWings, and
// d3FrameHeightFt (what the orbit cameras frame for). They are lifted out of the source by stable
// anchors and run — the porchGeom_test technique — and each lifted region is asserted
// byte-identical across the two hand-mirrored twins.
//
// Two promises matter most and are tested hardest:
//   1. NO WING KEYS, NO CHANGE. Every one of these answers exactly what the building without wings
//      always had: the full span, H on every wall, D3.WALL_H for every camera.
//   2. The numbers the renderer, the cameras and the vent fit build from agree with each other.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `wingsMassing_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  // The casing reveal, which d3DormerWindowFit fits a dormer window inside.
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  // d3RoofAxes, d3RoofProfile, d3MakeProfYAt, d3ProfSpanAt, and the whole wings block.
  ["function d3RoofAxes(", "function d3FtIn("],
  // ssGableEndWalls, ssPorchTrussWall, d3ProjectingPorch, ssGableVentFit and the vent constants.
  ["function ssVentSpan(", "function buildFixtureTools("],
  ["function d3DefaultShotCamera(", "// A default 3/4 view of the building"],
  ["const SS_SHOT = {", "// Render the draft the builder just paid for"],
];
const blocks = REGIONS.map(([a, b]) => ({ a, cmp: lift(CMP, "structure-studio.component.js", a, b), jsx: lift(JSX, "StructureStudio.jsx", a, b) }));

Deno.test("every lifted wings region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; return { D3, d3RoofAxes, d3Massing, d3MassingTopAt, d3WallTops, d3WallTopFt, d3CeilingFt, ` +
    `d3PorchSpanWings, d3PorchSpan, d3PorchWallTopFt, d3ModelTopFt, d3FrameHeightFt, d3DefaultShotCamera, ssSelfCheckCameras, ssGableVentFit, SS_SHOT, ` +
    `d3DormerFaceFt, d3DormerReadout, d3TransomDormerGeom, d3MakeProfYAt, d3RoofProfile, d3DormerWindowFit, d3RoofEnd, d3LeanToGeom };`,
)() as Record<string, Any>;

// The Tri Home, as the task drew it: 24 wide across the gable end, 28 deep, 9 ft outer walls, 8 ft
// wings both sides at 3:12, the centre's eave at 17 ft under a 6:12 gable with a 1 ft overhang.
// A portrait footprint, so today's axes put the gable ends north/south and the eave sides west/east.
const TRI = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 17 };

// ── ONE: no wing keys, no change ──────────────────────────────────────────────────────────

Deno.test("⚠️ without wing keys the massing IS the building, on every roof and size", () => {
  const roofs = [{ type: "gable", pitch: 0.4 }, { type: "gambrel" }, { type: "shed", pitch: 0.25 }, null, { type: "gable", ridgeOffset: 0.2 }];
  for (const roof of roofs) {
    for (const [W, L] of [[8, 10], [12, 16], [16, 24], [24, 12], [10, 40]]) {
      for (const H of [7, 9, 14, 20]) {
        const m = F.d3Massing(roof, W, L, H);
        const ax = F.d3RoofAxes(roof, W, L);
        assertEquals(m.wings, []);
        assertEquals(m.Sc, ax.S);
        assertEquals(m.uc, 0);
        assertEquals(m.Hc, H);
        for (const wall of ["north", "south", "east", "west"]) {
          assertEquals(F.d3WallTops(roof, W, L, H, wall), null, `${JSON.stringify(roof)} ${W}x${L} ${wall}`);
          assertEquals(F.d3WallTopFt(roof, W, L, H, wall, 1, 3), H);
        }
        assertEquals(F.d3CeilingFt(roof, W, L, H, 0, 0), H);
        assertEquals(F.d3PorchSpanWings(roof, W, L, H), null);
      }
    }
  }
});

Deno.test("⚠️ a zero width is OFF, like the lean-to's: every other wing key is inert", () => {
  const m = F.d3Massing({ ...TRI, wingWidthFt: 0 }, 24, 28, 9);
  assertEquals(m.wings, []);
  assertEquals(m.Hc, 9);
  assertEquals(F.d3Massing({ ...TRI, wingWidthFt: 0.4 }, 24, 28, 9).wings, []);
});

Deno.test("⚠️ the orbit cameras keep D3.WALL_H for every building the old frame already held", () => {
  // The roofs stored styles have, walls to the old 14 ft top, footprints from 8x8 up. The one family
  // that moves is left out on purpose and pinned below: 14 ft walls under a steep roof on a tiny
  // footprint, whose far ridge the old frame clipped.
  let n = 0;
  for (const roof of [{ type: "gable", pitch: 0.25 }, { type: "gable", pitch: 0.4 }, { type: "gable", pitch: 0.6 }, { type: "gambrel" }, { type: "shed", pitch: 0.25 }]) {
    for (const [W, L] of [[8, 8], [8, 12], [10, 12], [12, 16], [14, 20], [16, 24], [24, 16], [12, 32], [20, 40]]) {
      for (const H of [7, 8, 10, 12, 14]) {
        if (H === 14 && W <= 8 && L <= 8 && roof.type === "gambrel") continue;
        assertEquals(F.d3FrameHeightFt({ roof, wallHeightFt: H }, W, L), F.D3.WALL_H, `${JSON.stringify(roof)} ${W}x${L} walls ${H}`);
        n++;
      }
    }
  }
  assert(n > 200);
  // The family that does move, and only just.
  const moved = F.d3FrameHeightFt({ roof: { type: "gambrel" }, wallHeightFt: 14 }, 8, 8);
  assert(moved > F.D3.WALL_H && moved < F.D3.WALL_H + 0.5, String(moved));
  // No spec at all (the quote's own test call) is the old framing too.
  assertEquals(F.d3FrameHeightFt(undefined, 12, 16), F.D3.WALL_H);
});

// ── TWO: the Tri Home's numbers ───────────────────────────────────────────────────────────

Deno.test("the Tri Home: two 8 ft wings carve a 8 ft centre whose ridge stands at 19 ft", () => {
  const m = F.d3Massing(TRI, 24, 28, 9);
  assertEquals(m.uAxisIsX, true, "gable ends north/south on a portrait footprint (today's axes)");
  assertEquals(m.S, 24);
  assertEquals(m.Sc, 8);
  assertEquals(m.uc, 0);
  assertEquals(m.wings.map((g: Any) => [g.side, g.wall]), [[-1, "west"], [1, "east"]]);
  for (const g of m.wings) {
    assertEquals(g.ye, 9, "the outer wall is H");
    assertAlmostEquals(g.ya, 9 + 8 * 0.25, 1e-12, "the wing roof meets the centre at H + w*pitch");
    assertEquals(g.u1, g.side * 12);
    assertEquals(g.u0, g.side * 4);
  }
  assertEquals(m.Hc, 17);
  assertEquals(m.hcRaised, false);
  assertAlmostEquals(F.d3ModelTopFt({ roof: TRI, wallHeightFt: 9 }, 24, 28), 17 + 4 * 0.5, 1e-12, "ridge = Hc + (Sc/2)*pitch");
  // The outline: H at the outer wall, ya at the centre wall, the centre's roof between.
  assertAlmostEquals(F.d3MassingTopAt(m, -12), 9, 1e-12);
  assertAlmostEquals(F.d3MassingTopAt(m, -8), 10, 1e-12);
  assertAlmostEquals(F.d3MassingTopAt(m, 0), 19, 1e-12);
  assertAlmostEquals(F.d3MassingTopAt(m, 4), 17, 1e-12);
});

Deno.test("the gable ends step H | Hc | H, the centre piece closing on the clerestory's outer face", () => {
  const T = F.D3.WALL_T;
  for (const wall of ["north", "south"]) {
    const t = F.d3WallTops(TRI, 24, 28, 9, wall);
    assertEquals(t.length, 3);
    assertAlmostEquals(t[0][1], 8 - T / 2, 1e-12);
    assertAlmostEquals(t[1][0], 8 - T / 2, 1e-12);
    assertAlmostEquals(t[1][1], 16 + T / 2, 1e-12);
    assertEquals([t[0][2], t[1][2], t[2][2]], [9, 17, 9]);
    assertEquals([t[0][0], t[2][1]], [0, 24]);
  }
  // The wings' outer walls are H end to end.
  assertEquals(F.d3WallTops(TRI, 24, 28, 9, "west"), null);
  assertEquals(F.d3WallTops(TRI, 24, 28, 9, "east"), null);
  // An opening is clamped under the LOWEST top across it: a window in the centre may reach Hc, one
  // straddling the step only H, a door on a wing's end wall H.
  assertEquals(F.d3WallTopFt(TRI, 24, 28, 9, "south", 10, 14), 17);
  assertEquals(F.d3WallTopFt(TRI, 24, 28, 9, "south", 6, 10), 9);
  assertEquals(F.d3WallTopFt(TRI, 24, 28, 9, "south", 1, 4), 9);
  assertEquals(F.d3WallTopFt(TRI, 24, 28, 9, "east", 10, 14), 9);
});

Deno.test("one wing: the other eave wall IS the centre's, Hc tall, and the centre shifts toward it", () => {
  const left = { ...TRI, wingSide: "left" };
  const m = F.d3Massing(left, 24, 28, 9);
  assertEquals(m.wings.map((g: Any) => g.wall), ["west"]);
  assertEquals(m.Sc, 16);
  assertEquals(m.uc, 4);
  assertEquals(F.d3WallTops(left, 24, 28, 9, "west"), null);
  assertEquals(F.d3WallTops(left, 24, 28, 9, "east"), [[0, 28, 17]]);
  const t = F.d3WallTops(left, 24, 28, 9, "south");
  assertEquals(t.map((p: Any) => p[2]), [9, 17]);
  assertEquals(t[1][1], 24, "the centre piece runs out to the tall eave wall");
  // The right-hand one mirrors it.
  const right = F.d3Massing({ ...TRI, wingSide: "right" }, 24, 28, 9);
  assertEquals(right.uc, -4);
  assertEquals(right.wings.map((g: Any) => g.wall), ["east"]);
});

Deno.test("a side that is a gable end is DROPPED and said so, never drawn on another wall", () => {
  // Today's axes on a portrait footprint put the gable ends north/south: front and back are gables.
  const m = F.d3Massing({ ...TRI, wingSide: "front" }, 24, 28, 9);
  assertEquals(m.wings, []);
  assertEquals(m.dropped, ["south"]);
  // On a landscape footprint the eave sides ARE north/south, so front and back are wings there.
  const land = F.d3Massing({ ...TRI, wingSide: "front" }, 28, 24, 9);
  assertEquals(land.uAxisIsX, false);
  assertEquals(land.wings.map((g: Any) => g.wall), ["south"]);
  assertEquals(land.dropped, []);
  assertEquals(F.d3Massing({ ...TRI, wingSide: "left" }, 28, 24, 9).dropped, ["west"]);
});

Deno.test("wings are for gable and gambrel only; a single slant ignores them", () => {
  assertEquals(F.d3Massing({ ...TRI, type: "shed" }, 24, 28, 9).wings, []);
  assertEquals(F.d3Massing({ ...TRI, type: "gambrel" }, 24, 28, 9).wings.length, 2);
});

Deno.test("the centre keeps 4 ft: wider wings shrink, both alike", () => {
  const m = F.d3Massing({ ...TRI, wingWidthFt: 16 }, 20, 28, 9);
  assertEquals(m.Sc, 4);
  assertEquals(m.wings.map((g: Any) => g.w), [8, 8]);
  // Too narrow to leave a wing worth drawing: none.
  assertEquals(F.d3Massing(TRI, 5, 28, 9).wings, []);
});

Deno.test("the centre's eave: default wing top + 3, floor wing top + 1, raised to clear its own fascia", () => {
  const { centerEaveFt: _drop, ...noEave } = TRI;
  assertAlmostEquals(F.d3Massing(noEave, 24, 28, 9).Hc, 11 + 3, 1e-12);
  const low = F.d3Massing({ ...TRI, centerEaveFt: 10 }, 24, 28, 9);
  assertAlmostEquals(low.Hc, 12, 1e-12);
  assertEquals(low.hcRaised, true);
  // A 12:12 centre over 3:12 wings with a 1 ft overhang: its fascia falls 0.75 ft further than the
  // wing roof under it, so 1 ft of clerestory is not enough.
  const steep = F.d3Massing({ ...TRI, pitch: 1, centerEaveFt: 1 }, 24, 28, 9);
  assert(steep.Hc > 12 + 0.3, `Hc ${steep.Hc}`);
  // Under the centre's eave edge, what it hangs clears the wing slab's top by 0.1 ft or more.
  const g = steep.wings[0];
  const eaveEdgeBottom = steep.Hc - 1 * 1 - 0.3;
  const wingTopThere = g.ya - 1 * g.pitch + F.D3.ROOF_T + 0.02;
  assert(eaveEdgeBottom - wingTopThere >= 0.1 - 1e-9, `${eaveEdgeBottom} vs ${wingTopThere}`);
});

Deno.test("the local ceiling: the centre's plate under the centre, H under a wing", () => {
  assertEquals(F.d3CeilingFt(TRI, 24, 28, 9, 0, 5), 17);
  assertEquals(F.d3CeilingFt(TRI, 24, 28, 9, -8, 5), 9);
  assertEquals(F.d3CeilingFt(TRI, 24, 28, 9, 10, -5), 9);
});

Deno.test("the porch merge hook reports the centre, where it sits and its wall's top", () => {
  assertEquals(F.d3PorchSpanWings(TRI, 24, 28, 9), { span: 8, centerU: 0, wallTopFt: 17 });
  assertEquals(F.d3PorchSpanWings({ ...TRI, wingSide: "left" }, 24, 28, 9), { span: 16, centerU: 4, wallTopFt: 17 });
});

// The merge of the two renderer branches (2026-09-24): the projecting porch reads the wings through
// d3PorchSpan, and the wall it stands on through the SAME per-wall tops the walls are built to.
const TRI_FRONT = { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.2, centerEaveFt: 15, porchOutFt: 6, porchEnd: "front" };

Deno.test("⚠️ the porch stands in front of the CENTRE: its span and middle, and the centre wall's top", () => {
  // 28x20 with the front a gable end: the profile spans the 28 ft front, wings west and east.
  assertEquals(F.d3PorchSpan(TRI_FRONT, 28, 20), { span: 12, centerU: 0, onCap: true, full: 28 });
  assertEquals(F.d3PorchWallTopFt(TRI_FRONT, 28, 20, 9), 15, "the centre's own gable wall, not a wing's");
  // porchWidthFt sizes it, still centred on the centre section.
  assertEquals(F.d3PorchSpan({ ...TRI_FRONT, porchWidthFt: 16 }, 28, 20), { span: 16, centerU: 0, onCap: true, full: 28 });
  assertEquals(F.d3PorchWallTopFt({ ...TRI_FRONT, porchWidthFt: 16 }, 28, 20, 9), 15, "read at the porch's middle");
  // One wing: the centre sits uc off the middle, and so does the porch -- slid back only as far as
  // keeps a wide one on the wall.
  const left = { ...TRI_FRONT, wingSide: "left" };
  assertEquals(F.d3PorchSpan(left, 28, 20), { span: 20, centerU: 4, onCap: true, full: 28 });
  assertEquals(F.d3PorchSpan({ ...left, porchWidthFt: 16 }, 28, 20).centerU, 4);
  assertEquals(F.d3PorchSpan({ ...left, porchWidthFt: 26 }, 28, 20).centerU, 1);
  // Without wing keys every answer is the one before the merge: the whole wall, centred, at H.
  const plain = { type: "gable", front: "gable", pitch: 0.67, porchOutFt: 6 };
  assertEquals(F.d3PorchSpan(plain, 28, 20), { span: 28, centerU: 0, onCap: true, full: 28 });
  assertEquals(F.d3PorchWallTopFt(plain, 28, 20, 9), 9);
  assertEquals(F.d3PorchWallTopFt({ type: "gable", pitch: 0.5 }, 28, 20, 9), null, "no porch, no answer");
});

Deno.test("ONE per-wall top model: a shed's tall wall is just a wall whose top is H + S x pitch", () => {
  const farm = { type: "shed", highSide: "front", pitch: 0.3 };
  assertEquals(F.d3WallTops(farm, 16, 10, 7, "south"), [[0, 16, 10]]);
  assertEquals(F.d3WallTops(farm, 16, 10, 7, "north"), null);
  assertEquals(F.d3WallTopFt(farm, 16, 10, 7, "south", 2, 5), 10);
  assertEquals(F.d3WallTopFt(farm, 16, 10, 7, "south", 2, 5, true), 7, "set back by a recessed porch");
  // A wing's gable end: the tallest top is the centre's, the lowest over a wing is H.
  assertEquals(F.d3WallTopFt(TRI_FRONT, 28, 20, 9, "south"), 15);
  assertEquals(F.d3WallTopFt(TRI_FRONT, 28, 20, 9, "south", 1, 4), 9);
  assertEquals(F.d3WallTopFt(TRI_FRONT, 28, 20, 9, "west"), 9, "a wing's outer wall is H");
});

Deno.test("a gable vent with wings is fitted into the CENTRE's gable, above the centre's eave", () => {
  const it = { isVent: true, widthIn: 18, heightIn: 12 };
  const f = F.ssGableVentFit({ ...TRI, wingSide: "left" }, 24, 28, "south", 9, it, null, null);
  assert(f, "the centre gable holds an 18 in vent");
  assert(f.y0 >= 17, `sill ${f.y0} above Hc`);
  assert(Math.abs(f.u - 4) < 8 - 0.5, `centred on the centre (u ${f.u})`);
  assertAlmostEquals(f.alongFt, f.u + 12, 1e-9);
  // Without wings the fit is exactly the old one.
  const plain = F.ssGableVentFit({ type: "gable", pitch: 0.5 }, 24, 28, "south", 9, it, null, null);
  assert(plain.y0 < 10, `plain gable sill ${plain.y0}`);
});

// ── THREE: the cameras see the whole raised building ──────────────────────────────────────

/** Is world point `pt` inside this camera's frustum? Pinhole, zero roll, three.js conventions. */
function inFrame(cam: Any, pt: number[], aspect: number): boolean {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: number[]) => { const l = Math.sqrt(dot(a, a)); return [a[0] / l, a[1] / l, a[2] / l]; };
  const f = norm(sub(cam.at, cam.eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const v = sub(pt, cam.eye);
  const z = dot(v, f);
  if (z <= 0) return false;
  const vHalf = Math.tan((cam.fov / 2) * Math.PI / 180);
  return Math.abs(dot(v, u)) <= z * vHalf && Math.abs(dot(v, r)) <= z * vHalf * aspect;
}
/** The footprint's corners at the floor and at the outer eave, plus the centre's ridge ends. */
function hull(W: number, L: number, H: number, top: number, ridgeX: number): number[][] {
  const pts: number[][] = [];
  for (const x of [-W / 2, W / 2]) for (const z of [-L / 2, L / 2]) for (const y of [0, H]) pts.push([x, y, z]);
  pts.push([ridgeX, top, -L / 2], [ridgeX, top, L / 2]);
  return pts;
}

Deno.test("⚠️ a raised centre on a small footprint grows the quote's frame until its ridge is in it", () => {
  const spec = { roof: { ...TRI, wingWidthFt: 3, centerEaveFt: 21 }, wallHeightFt: 12 };
  const fH = F.d3FrameHeightFt(spec, 12, 12);
  assert(fH > F.D3.WALL_H, `framing height ${fH} should grow`);
  const cam = F.d3DefaultShotCamera({ bldgW: 12, bldgH: 12, frontWall: "south", style3d: spec })[0];
  const top = F.d3ModelTopFt(spec, 12, 12);
  for (const pt of hull(12, 12, 12, top, 0)) assert(inFrame(cam, pt, 1200 / 900), `${JSON.stringify(pt)} outside the quote shot`);
  // ...and a 20 ft wall without wings, which the new 5-20 clamp allows, too.
  const tall = { roof: { type: "gable", pitch: 0.5 }, wallHeightFt: 20 };
  const cam2 = F.d3DefaultShotCamera({ bldgW: 10, bldgH: 12, frontWall: "south", style3d: tall })[0];
  for (const pt of hull(10, 12, 20, 20 + 2.5, 0)) assert(inFrame(cam2, pt, 1200 / 900), `${JSON.stringify(pt)} outside (20 ft wall)`);
});

Deno.test("the self-check's wide views hold the centre's ridge, at every azimuth", () => {
  for (const [W, L] of [[24, 28], [16, 16], [12, 20]]) {
    const spec = { roof: TRI, wallHeightFt: 9 };
    const top = F.d3ModelTopFt(spec, W, L);
    const m = F.d3Massing(TRI, W, L, 9);
    for (let az = 0; az < 360; az += 45) {
      const cam = F.ssSelfCheckCameras({ bldgW: W, bldgH: L, style3d: spec }, { front: { frame: 1, azimuthDeg: az } })[0];
      for (const pt of hull(W, L, 9, top, m.uc)) {
        assert(inFrame(cam, pt, F.SS_SHOT.W / F.SS_SHOT.H), `${W}x${L} az ${az}: ${JSON.stringify(pt)} outside`);
      }
    }
  }
});

// ── THE DORMER IS ON THE CENTRE (2026-09-24 review) ──────────────────────────────────────────────
// With wings the renderer builds a transom dormer on the centre's roof, span Sc at eave Hc. The face
// the viewer offers a dormer window on, and the estimate prices it by, has to be that one: measured
// across the full span it was 2.50 ft against the 3D's 1.31, and a 30x36 in window that cannot be
// drawn was offered and priced.
Deno.test("⚠️ with wings the dormer face is measured on the centre, the roof the renderer builds it on", () => {
  const roof = { type: "gable", front: "gable", pitch: 0.67, overhang: 1, wingSide: "both", wingWidthFt: 8, centerEaveFt: 15, dormerType: "transom", dormerWidthFt: 6, dormerRiseFt: 2.5 };
  const spec = { roof, wallHeightFt: 9 };
  const m = F.d3Massing(roof, 28, 20, 9);
  const built = F.d3TransomDormerGeom(roof, m.Sc, F.d3MakeProfYAt(F.d3RoofProfile(roof, m.Sc, m.Hc, m.tallNeg).dedup, m.Hc));
  assertAlmostEquals(F.d3DormerFaceFt(spec, 28, 20), built.face, 1e-12);
  assertAlmostEquals(built.face, 1.31, 0.01);
  assertAlmostEquals(F.d3DormerReadout(spec, "28x20").maxFace, built.maxFace, 1e-12);
  // So a 30x36 in window the face cannot hold is neither offered nor priced.
  assertEquals(F.d3DormerWindowFit({ widthIn: 30, heightIn: 36 }, 6, F.d3DormerFaceFt(spec, 28, 20), 0), null);
  // Without wings, the full span at the wall height, exactly as before.
  const plain = { ...roof, wingSide: undefined, wingWidthFt: undefined, centerEaveFt: undefined };
  const S = F.d3RoofAxes(plain, 28, 20).S;
  const before = F.d3TransomDormerGeom(plain, S, F.d3MakeProfYAt(F.d3RoofProfile(plain, S, 9, true).dedup, 9));
  assertEquals(F.d3DormerFaceFt({ roof: plain, wallHeightFt: 9 }, 28, 20), before.face);
  assertEquals(F.d3DormerReadout({ roof: plain, wallHeightFt: 9 }, "28x20"), before);
});

// ── WHERE THE WING ROOFS MEET THE CENTRE (roof.wingAttach / wingAttachFt, 2026-09-28) ─────────────
// Carolyn, 09-28, on the Tri Home: "It even pushed the roof up ... they need to specify if it goes on
// the roof or if it goes on the sidewall ... I don't think we want it to just automatically switch."
// With an attach the centre's eave is the builder's number EXACTLY, the wing roof's pitch is worked out
// from where it meets, and wingPitch is stored but unread. Absent (or an unknown word) is today's rule,
// push included -- every pin above.

Deno.test("⚠️ no attach, or a word the sanitiser would drop, is today's massing exactly", () => {
  for (const junk of [undefined, null, "", "sidewall", "ROOF", 1]) {
    const m = F.d3Massing({ ...TRI, centerEaveFt: 10, wingAttach: junk, wingAttachFt: 3 }, 24, 28, 9);
    assertAlmostEquals(m.Hc, 12, 1e-12, `today pushes the 10 asked to the wing top + 1 (${String(junk)})`);
    assertEquals(m.hcRaised, true);
    assertEquals(m.attach, undefined);
    for (const g of m.wings) {
      assertEquals([g.pitch, g.uIn, g.run, g.attach], [0.25, undefined, undefined, undefined]);
      assertAlmostEquals(g.ya, 11, 1e-12);
    }
  }
  // The distance alone describes nothing.
  assertEquals(F.d3Massing({ ...TRI, wingAttachFt: 2 }, 24, 28, 9).Hc, 17);
});

Deno.test("wall: the centre's eave is EXACTLY the one asked; the wing roof meets its wall d below it", () => {
  // wingPitch 1.2 is ignored while an attach is set: the pitch is worked out.
  const roof = { ...TRI, wingPitch: 1.2, wingAttach: "wall", wingAttachFt: 2 };
  const m = F.d3Massing(roof, 24, 28, 9);
  assertEquals([m.Hc, m.hcRaised, m.attach], [17, false, "wall"]);
  for (const g of m.wings) {
    assertEquals(g.ya, 15, "A = Hc - d");
    assertEquals(g.uIn, g.u0, "on the centre's wall line");
    assertEquals(g.run, 8);
    assertAlmostEquals(g.pitch, (15 - 9) / 8, 1e-12);
    assertEquals([g.attach, g.attachFt, g.clamped, g.cuts], ["wall", 2, false, false]);
  }
  // The outline follows the worked-out pitch: H at the outer wall, A at the centre's wall.
  assertAlmostEquals(F.d3MassingTopAt(m, -12), 9, 1e-12);
  assertAlmostEquals(F.d3MassingTopAt(m, -8), 12, 1e-12);
  assertAlmostEquals(F.d3MassingTopAt(m, -4.0001), 15, 1e-3);
  // The clerestory's wall is the one that holds it: the gable ends still step H | Hc | H.
  assertEquals(F.d3WallTops(roof, 24, 28, 9, "south").map((p: Any) => p[2]), [9, 17, 9]);
  // Blank centre eave: today's default, the stored wing's top + 3 -- and still not pushed.
  const { centerEaveFt: _c, ...noEave } = roof;
  assertAlmostEquals(F.d3Massing(noEave, 24, 28, 9).Hc, 9 + 8 * 1.2 + 3, 1e-12);
});

Deno.test("wall: where today would PUSH the centre up, the centre stays put", () => {
  // Carolyn's complaint in numbers: a wing top of 11 and a centre asked at 11.5. Today: 12, raised.
  const asked = { ...TRI, centerEaveFt: 11.5 };
  assertEquals(F.d3Massing(asked, 24, 28, 9).hcRaised, true);
  const m = F.d3Massing({ ...asked, wingAttach: "wall", wingAttachFt: 1 }, 24, 28, 9);
  assertEquals([m.Hc, m.hcRaised], [11.5, false]);
  for (const g of m.wings) {
    assertEquals(g.ya, 10.5);
    assertAlmostEquals(g.pitch, 1.5 / 8, 1e-12);
  }
});

Deno.test("wall: a distance the centre's eave cannot clear is moved DOWN to the least that clears, and flagged", () => {
  // A 12:12 centre, 1 ft overhang, asked 0.3 ft: its fascia hangs into the wing roof. Solved in closed
  // form, the least d is a + (k - p(d)) * ov with p(d) = (Hc - d - H) / w.
  const roof = { ...TRI, pitch: 1, wingAttach: "wall", wingAttachFt: 0.3 };
  const m = F.d3Massing(roof, 24, 28, 9);
  const a = F.D3.ROOF_T + 0.43;
  for (const g of m.wings) {
    assertEquals([m.Hc, g.clamped, g.cuts], [17, true, false]);
    assertAlmostEquals(g.attachFt, a + (1 - g.pitch) * 1, 1e-9, "exactly the clearance, not more");
    assertAlmostEquals(g.ya, 17 - g.attachFt, 1e-12);
    // What the centre's eave hangs clears the wing slab's top by today's 0.1 ft at the overhang.
    const eaveEdgeBottom = m.Hc - 1 * 1 - 0.3;
    const wingTopThere = g.ya - 1 * g.pitch + F.D3.ROOF_T + 0.02;
    assert(eaveEdgeBottom - wingTopThere >= 0.1 - 1e-9, `${eaveEdgeBottom} vs ${wingTopThere}`);
  }
  // Asked far enough down, nothing moves.
  assertEquals(F.d3Massing({ ...roof, wingAttachFt: 2 }, 24, 28, 9).wings[0].clamped, false);
  // A centre too low to clear even a flat wing roof: drawn flat at the outside walls, flagged, and the
  // centre's eave STILL where it was asked -- never pushed, never switched to "roof".
  const low = F.d3Massing({ ...TRI, centerEaveFt: 10, wingAttach: "wall", wingAttachFt: 0.5 }, 24, 28, 9);
  assertEquals([low.Hc, low.attach], [10, "wall"]);
  for (const g of low.wings) assertEquals([g.ya, g.pitch, g.clamped, g.cuts], [9, 0, true, true]);
});

Deno.test("roof: the wing roof runs up onto the centre's roof, lands d above its eave, and the pitch follows", () => {
  // Centre asked at 11 (today: pushed to 12), a 6:12 centre over 8 ft wings: 1 ft up its roof is 2 ft in.
  const roof = { ...TRI, centerEaveFt: 11, wingAttach: "roof", wingAttachFt: 1 };
  const m = F.d3Massing(roof, 24, 28, 9);
  assertEquals([m.Hc, m.hcRaised, m.attach], [11, false, "roof"]);
  for (const g of m.wings) {
    assertEquals(g.ya, 12, "A = Hc + d");
    assertAlmostEquals(g.uIn, g.side * (4 - 1 / 0.5), 1e-12, "in by d / k from the centre wall");
    assertAlmostEquals(g.run, 10, 1e-12);
    assertAlmostEquals(g.pitch, 3 / 10, 1e-12);
    assertEquals([g.k, g.clamped, g.cuts], [0.5, false, false]);
  }
  // The outline: the wing line out to where it lands, the centre's roof above it from there on.
  assertAlmostEquals(F.d3MassingTopAt(m, -8), 9 + 4 * 0.3, 1e-12);
  assertAlmostEquals(F.d3MassingTopAt(m, -3), 9 + 9 * 0.3, 1e-12, "over the centre's eave: the wing roof, above it");
  assertAlmostEquals(F.d3MassingTopAt(m, -2), 12, 1e-12);
  assertAlmostEquals(F.d3MassingTopAt(m, -1), 12.5, 1e-12, "past the landing: the centre's own roof");
  // The walls do not move: the centre's wall line is still u0, its eave Hc.
  assertEquals(F.d3WallTops(roof, 24, 28, 9, "south").map((p: Any) => p[2]), [9, 11, 9]);
});

Deno.test("roof: never past the centre's own eave leg, and a wing steeper than it is flagged, not switched", () => {
  // The 6:12 centre's leg rises 2 ft to the ridge: 5 ft up is held 0.25 ft short of it.
  const m = F.d3Massing({ ...TRI, centerEaveFt: 11, wingAttach: "roof", wingAttachFt: 5 }, 24, 28, 9);
  for (const g of m.wings) assertEquals([g.attachFt, g.ya, g.clamped], [1.75, 12.75, true]);
  // The Tri Home as the test draws it (17 ft centre): a wing roof landing 1 ft up needs 9 in 10 -- steeper
  // than the 6:12 it sits on, so the centre's eave pokes through. Built as asked, and flagged.
  const steep = F.d3Massing({ ...TRI, wingAttach: "roof", wingAttachFt: 1 }, 24, 28, 9);
  for (const g of steep.wings) {
    assertEquals([steep.Hc, g.attach, g.cuts], [17, "roof", true]);
    assertAlmostEquals(g.pitch, 0.9, 1e-12);
  }
  // A gambrel's lower leg is its eave leg: up to its knee.
  const gam = F.d3Massing({ type: "gambrel", wingSide: "both", wingWidthFt: 6, centerEaveFt: 12, wingAttach: "roof", wingAttachFt: 9 }, 24, 28, 9);
  const knee = (12 / 2) * 0.55;   // s2 * kneeRise over the centre's 12 ft span
  for (const g of gam.wings) {
    assertAlmostEquals(g.attachFt, knee - 0.25, 1e-12);
    assertEquals(g.clamped, true);
  }
});

Deno.test("the centre never stands lower than 1 ft over the outside walls with an attach, and says so", () => {
  const m = F.d3Massing({ ...TRI, centerEaveFt: 8, wingAttach: "roof", wingAttachFt: 1 }, 24, 28, 9);
  assertEquals([m.Hc, m.hcLow], [10, true]);
  assertEquals(F.d3Massing({ ...TRI, wingAttach: "roof", wingAttachFt: 1 }, 24, 28, 9).hcLow, false);
});

// d3RoofEnd, which both appendages read: the eave at a wall and the roof that rises from it.
Deno.test("d3RoofEnd: the eave and the leg rising from it, at either end, a shed's high side falling inward", () => {
  const gable = F.d3RoofProfile({ type: "gable", pitch: 0.4 }, 12, 8, true).dedup;
  const l = F.d3RoofEnd(gable, -1);
  assertEquals([l.u, l.y], [-6, 8]);
  assertAlmostEquals(l.k, 0.4, 1e-12);
  assertAlmostEquals(l.rise, 2.4, 1e-12);
  assertAlmostEquals(F.d3RoofEnd(gable, 1).k, 0.4, 1e-12);
  const shed = F.d3RoofProfile({ type: "shed", pitch: 0.25 }, 12, 8, true).dedup;
  const hi = F.d3RoofEnd(shed, -1), lo = F.d3RoofEnd(shed, 1);
  assertEquals([hi.y, hi.k, lo.y, lo.k], [11, -0.25, 8, 0.25]);
});

// ── WHERE A LEAN-TO MEETS THE BUILDING (roof.leanToAttach / leanToAttachFt) ──────────────────────
Deno.test("⚠️ a lean-to with no attach has no attach geometry: the renderer builds today's", () => {
  const base = { type: "gable", pitch: 0.4, leanToWidthFt: 8, leanToDropFt: 2, leanToSide: "left" };
  assertEquals(F.d3LeanToGeom(base, 12, 16, 8), null);
  assertEquals(F.d3LeanToGeom({ ...base, leanToAttach: "side", leanToAttachFt: 2 }, 12, 16, 8), null);
  assertEquals(F.d3LeanToGeom({ ...base, leanToWidthFt: 0.5, leanToAttach: "roof" }, 12, 16, 8), null, "no lean-to");
});

Deno.test("a lean-to on the wall meets it d below the eave; up the roof, d above it and in by d / k", () => {
  const base = { type: "gable", pitch: 0.4, leanToWidthFt: 8, leanToDropFt: 2, leanToSide: "left" };
  const wall = F.d3LeanToGeom({ ...base, leanToAttach: "wall", leanToAttachFt: 1 }, 12, 16, 8);
  assertEquals([wall.u0, wall.u1, wall.ua, wall.ya, wall.y1, wall.E, wall.mode], [-6, -14, -6, 7, 6, 8, "wall"]);
  assertAlmostEquals(wall.pitch, 1 / 8, 1e-12);
  const seat = (F.D3.ROOF_T + 0.02) * Math.sqrt(1 + 0.16);
  const roof = F.d3LeanToGeom({ ...base, leanToAttach: "roof", leanToAttachFt: 1.5 }, 12, 16, 8);
  assertAlmostEquals(roof.ua, -(6 - 1.5 / 0.4), 1e-12);
  assertAlmostEquals(roof.ya, 9.5 + seat, 1e-12, "seated on the deck's top face");
  assertEquals(roof.y1, 6, "the outer edge keeps leanToDropFt under the eave");
  // "The further out they go, the higher up in the roof they have to go": up the roof it is steeper than
  // hung at the eave, and flatter than the roof it sits on.
  assert(roof.pitch > 2 / 8 && roof.pitch < 0.4, String(roof.pitch));
  assertEquals([roof.clamped, roof.flat, roof.cuts, roof.noRoof], [false, false, false, false]);
  // The right side mirrors it.
  assertAlmostEquals(F.d3LeanToGeom({ ...base, leanToSide: "right", leanToAttach: "roof", leanToAttachFt: 1.5 }, 12, 16, 8).ua, 6 - 1.5 / 0.4, 1e-12);
  // Up past the ridge is held 0.25 ft short of it.
  assertEquals(F.d3LeanToGeom({ ...base, leanToAttach: "roof", leanToAttachFt: 8 }, 12, 16, 8).clamped, true);
});

Deno.test("a lean-to's odd cases are drawn as asked and flagged, never switched", () => {
  const shed = { type: "shed", highSide: "left", pitch: 0.25, leanToWidthFt: 8, leanToDropFt: 1 };
  // The single slant's HIGH side (west, eave 11): the wall is fine, the roof has nothing above it.
  const hw = F.d3LeanToGeom({ ...shed, leanToSide: "left", leanToAttach: "wall", leanToAttachFt: 0.5 }, 12, 16, 8);
  assertEquals([hw.E, hw.ya, hw.y1, hw.k], [11, 10.5, 10, -0.25]);
  const hr = F.d3LeanToGeom({ ...shed, leanToSide: "left", leanToAttach: "roof", leanToAttachFt: 1 }, 12, 16, 8);
  assertEquals([hr.mode, hr.noRoof, hr.clamped, hr.ua, hr.ya, hr.d], ["roof", true, true, -6, 11, 0]);
  // A roof attach steeper than the roof it sits on: the main eave pokes through it (cuts).
  const steep = F.d3LeanToGeom({ ...shed, leanToSide: "right", leanToDropFt: 2, leanToAttach: "roof", leanToAttachFt: 1 }, 12, 16, 8);
  assertEquals([steep.mode, steep.cuts], ["roof", true]);
  // A wall attach below the outer edge: a sliver of pitch is held, and flagged.
  const flat = F.d3LeanToGeom({ ...shed, leanToSide: "right", leanToAttach: "wall", leanToAttachFt: 3 }, 12, 16, 8);
  assertEquals([flat.flat, flat.mode], [true, "wall"]);
  assertAlmostEquals(flat.ya, flat.y1 + 0.05, 1e-12);
});

Deno.test("a lean-to off a wing meets the WING's roof; off the other side of one wing, the centre's tall wall", () => {
  const tri = { ...TRI, wingSide: "left", leanToWidthFt: 6, leanToDropFt: 1 };
  // Off the wing (west): the eave is H, the roof above it the wing's.
  const onWing = F.d3LeanToGeom({ ...tri, leanToSide: "left", leanToAttach: "roof", leanToAttachFt: 1 }, 24, 28, 9);
  assertEquals([onWing.E, onWing.k], [9, 0.25]);
  assertAlmostEquals(onWing.ua, -12 + 1 / 0.25, 1e-12);
  // ...a wing whose own pitch is worked out from its attach carries that pitch to the lean-to.
  const wAtt = F.d3LeanToGeom({ ...tri, wingAttach: "wall", wingAttachFt: 2, leanToSide: "left", leanToAttach: "wall", leanToAttachFt: 0 }, 24, 28, 9);
  assertAlmostEquals(wAtt.k, (15 - 9) / 8, 1e-12);
  // Off the other side (east): no wing, so it is the centre's own wall at Hc = 17 -- both the attach
  // and the outer edge's drop are measured from there.
  const offCentre = F.d3LeanToGeom({ ...tri, leanToSide: "right", leanToDropFt: 3, leanToAttach: "wall", leanToAttachFt: 2 }, 24, 28, 9);
  assertEquals([offCentre.E, offCentre.ya, offCentre.y1, offCentre.u0, offCentre.flat], [17, 15, 14, 12, false]);
});

// ── REVIEW, 2026-09-29: what "cuts" really depends on, and what is built when it happens ─────────────
// Up the roof, p(d) = (Hc - H + d) / (w + d / k): every foot further up adds k of rise per foot of run,
// so the wing roof reaches the centre's roof exactly when Hc - H <= k * w, at EVERY distance. "Move it
// higher up the roof" can never cure it; a lower centre (at most H + k * w), a steeper centre roof or
// "On the wall" can, and the panel says the height. Level with the centre's roof (p == k) is one plane.
const TRI37 = { type: "gable", front: "gable", overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 12, wingPitch: 0.333, centerEaveFt: 14 };

Deno.test("roof: whether the wing roof reaches the centre's roof does not depend on the distance; level with it, it lands", () => {
  // Carolyn's own numbers: 37 x 22, front a gable end, 12 ft wings, 8 ft walls, centre 14 -- k * w = 6 at 6:12.
  for (const d of [0, 0.5, 1, 2, 4, 8]) {
    const at = (pitch: number) => F.d3Massing({ ...TRI37, pitch, wingAttach: "roof", wingAttachFt: d }, 37, 22, 8);
    for (const g of at(5 / 12).wings) assertEquals([g.cuts, g.meets], [true, "wall"], `5:12 cannot be reached at ${d}`);
    for (const g of at(0.5).wings) {
      assertEquals([g.cuts, g.meets], [false, "roof"], `6:12 is one plane with the wing roof at ${d}`);
      assertAlmostEquals(g.pitch, 0.5, 1e-12);
    }
    for (const g of at(8 / 12).wings) assertEquals([g.cuts, g.meets], [false, "roof"], `8:12 at ${d}`);
  }
  // ...and the same line for the Tri Home the tests draw: 17 over 9 ft walls is 8 over, and 8 ft wings
  // on its 6:12 reach 4 -- every distance is flagged; bring the centre to 13 and every one lands.
  for (const d of [0, 0.5, 1, 1.5, 1.75]) {
    assertEquals(F.d3Massing({ ...TRI, wingAttach: "roof", wingAttachFt: d }, 24, 28, 9).wings.every((g: Any) => g.cuts), true, `17 at ${d}`);
    assertEquals(F.d3Massing({ ...TRI, centerEaveFt: 13, wingAttach: "roof", wingAttachFt: d }, 24, 28, 9).wings.every((g: Any) => !g.cuts), true, `13 at ${d}`);
  }
});

Deno.test("roof: a wing roof that cannot reach the roof is built as far as it shows -- to the centre's wall, under its eave", () => {
  const k = 5 / 12;
  const m = F.d3Massing({ ...TRI37, pitch: k, wingAttach: "roof", wingAttachFt: 1 }, 37, 22, 8);
  assertEquals([m.Hc, m.attach], [14, "roof"]);
  const p = (14 + 1 - 8) / (12 + 1 / k);
  for (const g of m.wings) {
    assertAlmostEquals(g.pitch, p, 1e-12);
    assertEquals([g.uIn, g.run, g.attach, g.attachFt, g.meets], [g.u0, 12, "roof", 1, "wall"], "the mode and the distance asked stay the builder's");
    assertAlmostEquals(g.ya, 8 + 12 * p, 1e-12, "where the wing line meets the centre's wall");
    assertAlmostEquals(g.meetFt, 14 - (8 + 12 * p), 1e-12);
    assert(g.ya < m.Hc);
  }
  assertAlmostEquals(m.ya, 8 + 12 * p, 1e-12);
  // The outline: the wing line out to the centre's wall, the centre's own roof from there in.
  const gW = m.wings.find((g: Any) => g.side < 0);
  assertAlmostEquals(F.d3MassingTopAt(m, gW.u0 - 1), 8 + 11 * p, 1e-12);
  assertAlmostEquals(F.d3MassingTopAt(m, gW.u0 + 0.5), 14 + 0.5 * k, 1e-9);
  // Where it does land, meets / meetFt are the attach itself.
  for (const g of F.d3Massing({ ...TRI37, pitch: 8 / 12, wingAttach: "roof", wingAttachFt: 1 }, 37, 22, 8).wings) assertEquals([g.meets, g.meetFt], ["roof", 1]);
  for (const g of F.d3Massing({ ...TRI37, pitch: 8 / 12, wingAttach: "wall", wingAttachFt: 2 }, 37, 22, 8).wings) assertEquals([g.meets, g.meetFt], ["wall", 2]);
});

Deno.test("⚠️ a transom dormer stops short of a wing roof or a lean-to that lands on the roof it sits on", () => {
  // The Tri Home (37 x 22, 10 ft walls, centre 14, 8:12): a 6 ft transom dormer runs toward +u.
  const base = { ...TRI37, pitch: 0.67, dormerType: "transom", dormerWidthFt: 6, dormerRiseFt: 2.5, dormerOffsetU: 0.45 };
  const spec = (roof: Any) => ({ roof, wallHeightFt: 10 });
  const none = F.d3DormerReadout(spec(base), "37x22");
  // On the wall nothing covers the centre's roof: the dormer is the one it always was.
  const wall = F.d3DormerReadout(spec({ ...base, wingAttach: "wall", wingAttachFt: 1 }), "37x22");
  assertEquals([wall.uTop, wall.run, wall.uOut], [none.uTop, none.run, none.uOut]);
  assertAlmostEquals(wall.face, none.face, 1e-9);
  assertAlmostEquals(none.face, 1.43, 0.01);
  for (const d of [1, 2]) {
    const roof = { ...base, wingAttach: "roof", wingAttachFt: d };
    const m = F.d3Massing(roof, 37, 22, 10);
    const land = m.wings.find((g: Any) => g.side > 0).uIn - m.uc;
    const dg = F.d3DormerReadout(spec(roof), "37x22");
    assert(dg.uOut <= land - 0.3 + 1e-9, `the face at ${dg.uOut} stands clear of the landing at ${land}`);
    assert(dg.face < none.face - 0.3, `a smaller face (${dg.face}) than the bare roof's (${none.face})`);
    assertEquals(dg.clamped, true);
    assertAlmostEquals(F.d3DormerFaceFt(spec(roof), 37, 22), dg.face, 1e-12, "the window is sized to that face");
  }
  // A lean-to 1.5 ft up a 12 x 16's right slope lands 2.25 ft from the middle, inside the dormer's own top
  // (2.7): nothing of it can stand, and the renderer draws nothing (run under 0.8), no window either.
  const lt = { type: "gable", pitch: 0.4, dormerType: "transom", dormerWidthFt: 4, dormerOffsetU: 0.45, leanToWidthFt: 8, leanToDropFt: 2 };
  const onLt = F.d3DormerReadout({ roof: { ...lt, leanToSide: "right", leanToAttach: "roof", leanToAttachFt: 1.5 }, wallHeightFt: 8 }, "12x16");
  assertEquals([onLt.run, onLt.face, onLt.clamped], [0, 0.3, true]);
  // The lean-to on the OTHER side, or on the wall, or with no attach: today's dormer.
  const plain = F.d3DormerReadout({ roof: { ...lt, leanToSide: "right" }, wallHeightFt: 8 }, "12x16");
  for (const extra of [{ leanToSide: "left", leanToAttach: "roof", leanToAttachFt: 1.5 }, { leanToSide: "right", leanToAttach: "wall", leanToAttachFt: 1 }]) {
    assertEquals(F.d3DormerReadout({ roof: { ...lt, ...extra }, wallHeightFt: 8 }, "12x16"), plain, JSON.stringify(extra));
  }
});

Deno.test("a lean-to up the roof cuts or not by its drop and width alone, wherever it meets; level with the roof it lands", () => {
  const shed = { type: "shed", highSide: "left", pitch: 0.25, leanToWidthFt: 8, leanToSide: "right", leanToAttach: "roof" };
  const seat = (F.D3.ROOF_T + 0.02) * Math.sqrt(1 + 0.25 * 0.25);
  for (const d of [0.5, 1, 2, 2.75]) {
    assertEquals(F.d3LeanToGeom({ ...shed, leanToDropFt: 1.5, leanToAttachFt: d }, 12, 16, 8).cuts, false, `drop 1.5 at ${d}`);
    for (const drop of [2, 3]) assertEquals(F.d3LeanToGeom({ ...shed, leanToDropFt: drop, leanToAttachFt: d }, 12, 16, 8).cuts, true, `drop ${drop} at ${d}`);
    const level = F.d3LeanToGeom({ ...shed, leanToDropFt: 0.25 * 8 - seat, leanToAttachFt: d }, 12, 16, 8);
    assertAlmostEquals(level.pitch, 0.25, 1e-9);
    assertEquals(level.cuts, false, `level with the roof at ${d}: one plane`);
  }
});
