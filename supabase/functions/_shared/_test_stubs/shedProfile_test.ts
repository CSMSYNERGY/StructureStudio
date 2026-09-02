// The shed roof profile and its axes, tested against the SHIPPED designer source.
//
// Why this exists: `buildShed3DModel` now repaints ONE swept side of the extruded roof cap
// with the wall material, because on a single-slant roof that side is not a soffit — it is the
// high eave wall's band above the plate, and it was drawing in flat body colour while the wall
// directly beneath it carried cladding (Carolyn, 2026-09-01: "the siding needs ... go all the
// way up").
//
// That code cannot be unit-tested here — it needs THREE. What CAN be pinned is the premise it
// rests on, which is pure geometry and is the part that would silently invalidate it:
//
//   1. a shed profile has EXACTLY ONE vertical edge, and it is at u = -S/2 spanning H..H+rise;
//   2. `tallNeg` is a fixed convention, not a derivation;
//   3. the shed axes SWAP relative to gable/gambrel, which is what decides whether the tall
//      wall is west or north — and therefore which of the two UV mappings is correct.
//
// If any of those moves, the repaint silently targets the wrong face (or none) and the only
// symptom is a wrongly-textured wall in a 3D view nobody diffs. So: fail the push instead.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../StructureStudio.jsx", import.meta.url),
);

const START = "function d3RoofAxes(";
const END = "function d3FtIn(";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    "shedProfile_test: could not find the roof-profile block in StructureStudio.jsx " +
      `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
  );
}
const BLOCK = SRC.slice(i, j);
for (const name of ["d3RoofAxes", "d3RoofProfile", "tallNeg"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

type Pt = [number, number];
type Axes = { uAxisIsX: boolean; S: number; L: number; tallNeg: boolean };
type Profile = { prof: Pt[]; slopes: Pt[][]; dedup: Pt[] };

const factory = new Function(`${BLOCK}; return { d3RoofAxes, d3RoofProfile };`);
const { d3RoofAxes, d3RoofProfile } = factory() as {
  d3RoofAxes: (cfg: unknown, wFt: number, lFt: number) => Axes;
  d3RoofProfile: (cfg: unknown, S: number, H: number, tallNeg: boolean) => Profile;
};

const SHED = { type: "shed", pitch: 0.5 };
const H = 8;

/** Edges of the closed profile polygon, as the extruder walks them. */
const edgesOf = (dedup: Pt[]) =>
  dedup.map((a, k) => [a, dedup[(k + 1) % dedup.length]] as [Pt, Pt]);

Deno.test("a shed profile has EXACTLY ONE vertical edge", () => {
  const { S, tallNeg } = d3RoofAxes(SHED, 12, 16);
  const { dedup } = d3RoofProfile(SHED, S, H, tallNeg);
  const vertical = edgesOf(dedup).filter(([a, b]) => Math.abs(a[0] - b[0]) < 1e-9);
  assertEquals(vertical.length, 1, `expected one vertical edge, got ${vertical.length}`);
});

Deno.test("that edge sits at u = -S/2 and spans the plate to the high eave", () => {
  // This is the face the repaint targets. Its plane (-S/2) is the test the geometry code
  // uses to FIND it, so if the profile ever put the tall end at +S/2 the repaint would miss
  // entirely and the bug would return with no error anywhere.
  const { S, tallNeg } = d3RoofAxes(SHED, 12, 16);
  const { dedup } = d3RoofProfile(SHED, S, H, tallNeg);
  const [a, b] = edgesOf(dedup).find(([p, q]) => Math.abs(p[0] - q[0]) < 1e-9)!;
  assertEquals(a[0], -S / 2);
  assertEquals(b[0], -S / 2);
  const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
  assertEquals(lo, H, "the vertical edge must start at the plate");
  assert(hi > H, "and rise above it");
  assertEquals(hi, H + S * 0.5, "rise = span x pitch");
});

Deno.test("tallNeg is a FIXED convention — geometry cannot name a high end", () => {
  // Both orientations and both aspect ratios. If this ever becomes a derivation, the
  // -S/2 assumption above stops holding for half of all buildings.
  for (const [w, l] of [[12, 16], [16, 12], [10, 10], [8, 24]]) {
    assertEquals(d3RoofAxes(SHED, w, l).tallNeg, true, `${w}x${l}`);
  }
});

Deno.test("the shed axes SWAP against gable — this is what picks the UV mapping", () => {
  // uAxisIsX decides which wall the band belongs to, and therefore which of the two
  // derivations the repaint uses: west (u = local z) or north (u = L - local z).
  const GABLE = { type: "gable", pitch: 0.4 };
  for (const [w, l] of [[12, 16], [16, 12]]) {
    const shed = d3RoofAxes(SHED, w, l);
    const gable = d3RoofAxes(GABLE, w, l);
    assertEquals(shed.uAxisIsX, !gable.uAxisIsX, `${w}x${l}: shed must swap against gable`);
  }
});

Deno.test("S and L follow uAxisIsX, which is what makes the cancellation exact", () => {
  // The west mapping (u = local z) only reduces to that because L = bldgH when uAxisIsX;
  // the north mapping (u = L - local z) only because L = bldgW when it is not.
  for (const [w, l] of [[12, 16], [16, 12], [8, 24]]) {
    const { uAxisIsX, S, L } = d3RoofAxes(SHED, w, l);
    assertEquals(S, uAxisIsX ? w : l);
    assertEquals(L, uAxisIsX ? l : w);
  }
});

Deno.test("gable and gambrel have NO vertical edge, so the repaint must never fire", () => {
  // The guard in buildShed3DModel is `type === "shed"`, but if a future profile grew a
  // vertical edge the plane test would start matching a real soffit and paint cladding on
  // the underside of a roof.
  for (const cfg of [{ type: "gable", pitch: 0.4 }, { type: "gambrel", kneeU: 0.55, kneeRise: 0.55, ridgeRise: 0.8 }]) {
    const { S, tallNeg } = d3RoofAxes(cfg, 12, 16);
    const { dedup } = d3RoofProfile(cfg, S, H, tallNeg);
    const vertical = edgesOf(dedup).filter(([a, b]) => Math.abs(a[0] - b[0]) < 1e-9);
    assertEquals(vertical.length, 0, `${(cfg as { type: string }).type} grew a vertical edge`);
  }
});

Deno.test("the roof SLOPE is still reported, so the slab pass is unaffected", () => {
  // The repaint re-cuts the geometry's material groups. It must not disturb which edges the
  // renderer treats as roof slopes — those come from here, not from the groups.
  const { S, tallNeg } = d3RoofAxes(SHED, 12, 16);
  const { slopes } = d3RoofProfile(SHED, S, H, tallNeg);
  assertEquals(slopes.length, 1, "a shed has exactly one roof plane");
});
