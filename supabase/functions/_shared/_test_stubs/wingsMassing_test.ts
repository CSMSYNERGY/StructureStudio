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
    `d3DormerFaceFt, d3DormerReadout, d3TransomDormerGeom, d3MakeProfYAt, d3RoofProfile, d3DormerWindowFit };`,
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
