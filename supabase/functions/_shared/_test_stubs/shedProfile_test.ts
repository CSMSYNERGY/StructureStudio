// The single-slant siding fix — the DECISION LOGIC itself, plus the geometry premises it
// rests on — tested against BOTH SHIPPED designer twins.
//
// WHAT IS BEING PINNED. `buildShed3DModel` repaints ONE swept side of the extruded roof cap
// with the wall material, because on a single-slant roof that side is not a soffit — it is the
// high eave wall's band above the plate, and it was drawing in flat body colour while the wall
// directly beneath it carried cladding (Carolyn, 2026-09-01: "the siding needs ... go all the
// way up"). Two things had to be right: WHICH material group the band lands in, and the UV
// rewrite that puts it in the wall's frame instead of the extruder's.
//
// HOW, given the code needs THREE. It does not need much of THREE. The repaint reads
// `attributes.position`, writes `attributes.uv`, and re-cuts `groups` — about eight methods.
// So the shipped block is LIFTED between stable anchors and run against a stub geometry built
// from the REAL `d3RoofProfile` output, which is the same slice-and-run idiom wallSlab_test and
// electrical_test already use here. Nothing is copied out, so nothing can drift.
//
// WHY NOT EXTRACT IT INTO A _shared MODULE. Because the caller is a browser file. Both twins
// are loaded straight by the browser (index.html Babel-compiles the .jsx; the component is a
// plain script), so they cannot import from supabase/functions/_shared — a module there would
// have to be duplicated back into both twins by hand, which is the drift this whole technique
// exists to prevent. Lifting the shipped text is strictly stronger.
//
// ⚠️ WHAT THIS DOES NOT PROVE, stated plainly so nobody reads green as more than it is:
//
//   * The fix rides an UNDOCUMENTED three.js internal — that `ExtrudeGeometry` emits exactly
//     two material groups, group 0 = the two caps and group 1 = the swept sides, non-indexed,
//     three vertices per triangle. That is not in three's public API and can change in any
//     release. These tests ENCODE that assumption in the stub; they cannot verify it, because
//     the suite is deliberately run with no --allow-net and three is loaded from esm.sh at
//     runtime, never vendored.
//   * On drift the guard falls through SILENTLY: no error, no warning, the band simply goes
//     back to flat body colour and the bug returns looking exactly like it did before.
//   * Two tests below get as close to catching that as a hermetic test can. One pins
//     THREE_VERSION, so a version bump has to walk past a failing test that says re-verify the
//     group ordering. The other feeds the block a SWAPPED geometry (group 0 = sides) and
//     asserts the guard declines — proving the drift failure mode is a no-op rather than
//     cladding painted onto the underside of a roof slope, which would be worse and would
//     still look "fixed" to a green suite.
//   * Nothing here renders. Pixels, the material's texture, and the deliberately-omitted
//     proud relief strips on the band (see the RESIDUAL note in the shipped comment) remain
//     uncovered by any automated test.
//
// AND IT PINS BOTH TWINS. `StructureStudio.jsx` and `structure-studio.component.js` are
// hand-mirrored, and until 2026-09-02 this file read only the .jsx — so the component could
// have lost the fix entirely with the suite still green. Every lifted region is now asserted
// byte-identical across the two, and the logic is exercised from the component (the copy
// index.html actually serves).

import { assert, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(
  new URL("../../../../StructureStudio.jsx", import.meta.url),
);
const CMP = await Deno.readTextFile(
  new URL("../../../../structure-studio.component.js", import.meta.url),
);

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, what: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `shedProfile_test: could not find the ${what} block in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

// ── Region 1: the pure roof geometry (axes + profile) ────────────────────────────────────
const PROFILE_START = "function d3RoofAxes(";
const PROFILE_END = "function d3FtIn(";
const PROFILE_JSX = lift(JSX, "StructureStudio.jsx", "roof-profile", PROFILE_START, PROFILE_END);
const PROFILE_CMP = lift(CMP, "structure-studio.component.js", "roof-profile", PROFILE_START, PROFILE_END);
for (const name of ["d3RoofAxes", "d3RoofProfile", "tallNeg"]) {
  assert(PROFILE_CMP.includes(name), `extracted profile block is missing ${name}`);
}

// ── Region 2: the single-slant repaint, up to and including the mesh's material wiring ───
// The END anchor deliberately sits AFTER `rg.add(new THREE.Mesh(...))`, because the group
// re-cut is meaningless without the array that gives materialIndex 0 its meaning.
const REPAINT_START = "// ── SINGLE SLANT: the tall band above the plate is a WALL";
const REPAINT_END = "const profYAt = (u) =>";
const REPAINT_JSX = lift(JSX, "StructureStudio.jsx", "single-slant repaint", REPAINT_START, REPAINT_END);
const REPAINT_CMP = lift(CMP, "structure-studio.component.js", "single-slant repaint", REPAINT_START, REPAINT_END);
for (const frag of ["inTallPlane", "triTall", "clearGroups()", "addGroup(", "setXY(", "[wallMat, gableMat]"]) {
  assert(REPAINT_CMP.includes(frag), `extracted repaint block is missing ${frag}`);
}

type Pt = [number, number];
type Axes = { uAxisIsX: boolean; S: number; L: number; tallNeg: boolean };
type Profile = { prof: Pt[]; slopes: Pt[][]; dedup: Pt[] };

const { d3RoofAxes, d3RoofProfile } = new Function(
  `${PROFILE_CMP}; return { d3RoofAxes, d3RoofProfile };`,
)() as {
  d3RoofAxes: (cfg: unknown, wFt: number, lFt: number) => Axes;
  d3RoofProfile: (cfg: unknown, S: number, H: number, tallNeg: boolean) => Profile;
};

const SHED = { type: "shed", pitch: 0.5 };
const H = 8;

/** Edges of the closed profile polygon, as the extruder walks them. */
const edgesOf = (dedup: Pt[]) =>
  dedup.map((a, k) => [a, dedup[(k + 1) % dedup.length]] as [Pt, Pt]);

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 1 — the pure geometry premises the repaint rests on.
// ═══════════════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 2 — the twins carry the same code.
// ═══════════════════════════════════════════════════════════════════════════════════════

Deno.test("both twins carry a byte-identical roof-profile block", () => {
  assertEquals(
    PROFILE_CMP,
    PROFILE_JSX,
    "StructureStudio.jsx and structure-studio.component.js disagree about d3RoofAxes/d3RoofProfile",
  );
});

Deno.test("both twins carry a byte-identical single-slant repaint block", () => {
  // Until this existed the suite read the .jsx only, so the component could have shipped
  // WITHOUT the fix and every test above would still have been green.
  assertEquals(
    REPAINT_CMP,
    REPAINT_JSX,
    "StructureStudio.jsx and structure-studio.component.js disagree about the single-slant repaint",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 3 — the repaint itself, lifted and run.
// ═══════════════════════════════════════════════════════════════════════════════════════

/** The sliver of BufferAttribute the repaint touches — nothing more is stubbed. */
class Attr {
  needsUpdate = false;
  constructor(readonly rows: number[][]) {}
  get count(): number { return this.rows.length; }
  getX(i: number): number { return this.rows[i][0]; }
  getY(i: number): number { return this.rows[i][1]; }
  getZ(i: number): number { return this.rows[i][2]; }
  setXY(i: number, x: number, y: number): void { this.rows[i][0] = x; this.rows[i][1] = y; }
}

type Group = { start: number; count: number; materialIndex: number };

/** The sliver of BufferGeometry the repaint touches. */
class Geom {
  groups: Group[] = [];
  attributes: { position: Attr; uv: Attr };
  constructor(pos: number[][], uv: number[][]) {
    this.attributes = { position: new Attr(pos), uv: new Attr(uv) };
  }
  clearGroups(): void { this.groups = []; }
  addGroup(start: number, count: number, materialIndex: number): void {
    this.groups.push({ start, count, materialIndex });
  }
}

/** UV value no real mapping produces, so "untouched" is provable rather than assumed. */
const UNTOUCHED = -999;

/**
 * A stand-in for `new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false })`.
 *
 * ⚠️ THIS IS WHERE THE UNDOCUMENTED ASSUMPTION LIVES. Caps first as ONE group, swept sides
 * second as ONE group, non-indexed, three vertices per triangle, one quad per closed-polygon
 * edge in polygon order. Everything the repaint reads is reproduced faithfully to that model;
 * winding and the cap's triangulation order are NOT, because the repaint reads neither.
 */
function extrudeStub(poly: Pt[], L: number): { g: Geom; capCount: number; sideCount: number } {
  const capV: number[][] = [];
  for (let i = 1; i + 1 < poly.length; i++) {
    for (const z of [0, L]) {
      capV.push(
        [poly[0][0], poly[0][1], z],
        [poly[i][0], poly[i][1], z],
        [poly[i + 1][0], poly[i + 1][1], z],
      );
    }
  }
  const sideV: number[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    sideV.push([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], L]);
    sideV.push([a[0], a[1], 0], [b[0], b[1], L], [a[0], a[1], L]);
  }
  const pos = [...capV, ...sideV];
  const g = new Geom(pos, pos.map(() => [UNTOUCHED, UNTOUCHED]));
  g.addGroup(0, capV.length, 0);
  g.addGroup(capV.length, sideV.length, 1);
  return { g, capCount: capV.length, sideCount: sideV.length };
}

const WALL_MAT = { tag: "wallMat" };
const GABLE_MAT = { tag: "gableMat" };

type Mesh = { geometry: unknown; material: unknown };

const runRepaint = new Function(
  "roofCfg", "S", "L", "uAxisIsX", "gableGeom", "rg", "THREE", "wallMat", "gableMat",
  REPAINT_CMP,
) as (
  roofCfg: unknown, S: number, L: number, uAxisIsX: boolean, gableGeom: Geom,
  rg: { add: (m: Mesh) => void }, THREE: { Mesh: new (g: unknown, m: unknown) => Mesh },
  wallMat: unknown, gableMat: unknown,
) => void;

/** Run the SHIPPED block over a stub geometry and report what it did. */
function repaint(cfg: unknown, S: number, L: number, uAxisIsX: boolean, g: Geom) {
  const added: Mesh[] = [];
  const THREE = {
    Mesh: class implements Mesh {
      constructor(readonly geometry: unknown, readonly material: unknown) {}
    },
  };
  runRepaint(cfg, S, L, uAxisIsX, g, { add: (m: Mesh) => added.push(m) }, THREE, WALL_MAT, GABLE_MAT);
  return { groups: g.groups.map((x) => ({ ...x })), mesh: added[0], added };
}

/** A shed cap geometry built from the REAL profile, so no number below is hand-copied. */
function shedFixture(w: number, l: number) {
  const { uAxisIsX, S, L, tallNeg } = d3RoofAxes(SHED, w, l);
  const { dedup } = d3RoofProfile(SHED, S, H, tallNeg);
  return { uAxisIsX, S, L, dedup, ...extrudeStub(dedup, L) };
}

/**
 * The vertices of the band, by the same rule the shipped code uses: a side triangle counts
 * only when ALL THREE of its vertices sit in the plane u = -S/2. Filtering per-vertex instead
 * would sweep in the slope's upper corner, which shares that plane but belongs to a roof face.
 */
function bandVertices(capCount: number, g: Geom, S: number): number[] {
  const pos = g.attributes.position, out: number[] = [];
  for (let i = capCount; i < pos.count; i += 3) {
    if (![0, 1, 2].every((j) => Math.abs(pos.getX(i + j) + S / 2) < 1e-4)) continue;
    out.push(i, i + 1, i + 2);
  }
  return out;
}

/** materialIndex per triangle, and proof the cut has no hole and no overlap. */
function perTriangle(groups: Group[], vertexCount: number): number[] {
  const out = new Array<number>(vertexCount / 3).fill(-1);
  for (const gr of groups) {
    assertEquals(gr.start % 3, 0, `group start ${gr.start} is not on a triangle boundary`);
    assertEquals(gr.count % 3, 0, `group count ${gr.count} is not a whole number of triangles`);
    for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) {
      assertEquals(out[t], -1, `triangle ${t} is covered by two groups`);
      out[t] = gr.materialIndex;
    }
  }
  assert(!out.includes(-1), "the re-cut left triangles in NO group — they would vanish");
  return out;
}

Deno.test("the tall band lands on materialIndex 0 and every other side stays on 1", () => {
  for (const [w, l] of [[12, 16], [16, 12]]) {
    const f = shedFixture(w, l);
    const { groups } = repaint(SHED, f.S, f.L, f.uAxisIsX, f.g);
    const tri = perTriangle(groups, f.capCount + f.sideCount);
    const capTris = f.capCount / 3;
    // Caps keep cladding (the 2026-08-18 gable fix) …
    for (let t = 0; t < capTris; t++) assertEquals(tri[t], 0, `${w}x${l}: cap triangle ${t}`);
    // … and exactly the two triangles of the vertical face join them.
    const sideMats = tri.slice(capTris);
    assertEquals(sideMats.filter((m) => m === 0).length, 2, `${w}x${l}: expected 2 clad side triangles`);
    // The clad ones must be precisely those whose three vertices all sit at u = -S/2.
    const pos = f.g.attributes.position;
    for (let t = 0; t < sideMats.length; t++) {
      const i = f.capCount + t * 3;
      const inPlane = [0, 1, 2].every((j) => Math.abs(pos.getX(i + j) + f.S / 2) < 1e-4);
      assertEquals(sideMats[t] === 0, inPlane, `${w}x${l}: side triangle ${t} painted against its plane`);
    }
  }
});

Deno.test("the tall band is re-UV'd into the wall's own absolute frame", () => {
  // The claim in the shipped comment is that the band "lands in phase with the wall below by
  // construction rather than by a tuned offset". Concretely: v is the ABSOLUTE height in feet,
  // and u is the ABSOLUTE run along that wall — so it must sweep the full 0..L, not 0..1 and
  // not some extruder-local range.
  for (const [w, l] of [[12, 16], [16, 12]]) {
    const f = shedFixture(w, l);
    repaint(SHED, f.S, f.L, f.uAxisIsX, f.g);
    const pos = f.g.attributes.position, uv = f.g.attributes.uv;
    const us: number[] = [], vs: number[] = [];
    const band = bandVertices(f.capCount, f.g, f.S);
    assertEquals(band.length, 6, `${w}x${l}: the band is exactly two triangles`);
    for (const i of band) {
      us.push(uv.getX(i));
      vs.push(uv.getY(i));
      assertEquals(uv.getY(i), pos.getY(i), `${w}x${l}: v must be the world height`);
    }
    assertEquals(Math.min(...us), 0, `${w}x${l}: u must start at the wall's origin`);
    assertEquals(Math.max(...us), f.L, `${w}x${l}: u must reach the far end of the wall`);
    assertEquals(Math.min(...vs), H, `${w}x${l}: the band starts at the plate`);
    assertEquals(Math.max(...vs), H + f.S * 0.5, `${w}x${l}: and ends at the high eave`);
  }
});

Deno.test("west and north are MIRRORS of each other, which is the whole of the branch", () => {
  // uAxisIsX -> u = local z (west wall); else -> u = L - local z (north wall). Forcing both
  // over the SAME geometry proves the branch is a mirror and not two unrelated formulas — if
  // one side is ever "fixed" in isolation the battens run backwards on half the buildings.
  const a = shedFixture(12, 16), b = shedFixture(12, 16);
  repaint(SHED, a.S, a.L, true, a.g);
  repaint(SHED, b.S, b.L, false, b.g);
  const band = bandVertices(a.capCount, a.g, a.S);
  assertEquals(band.length, 6, "expected the band's two triangles");
  for (const i of band) {
    assertEquals(a.g.attributes.uv.getX(i) + b.g.attributes.uv.getX(i), a.L, `vertex ${i}`);
    assertEquals(a.g.attributes.uv.getY(i), b.g.attributes.uv.getY(i), `vertex ${i} v must not mirror`);
  }
});

Deno.test("only the band's UVs move — caps and soffit keep the extruder's mapping", () => {
  // The caps were already phase-shifted by the U-PHASE block ABOVE this one. If the repaint
  // touched them it would double-shift the gable cladding and undo the 2026-08-18 fix.
  const f = shedFixture(12, 16);
  repaint(SHED, f.S, f.L, f.uAxisIsX, f.g);
  const pos = f.g.attributes.position, uv = f.g.attributes.uv;
  const band = new Set(bandVertices(f.capCount, f.g, f.S));
  for (let i = 0; i < pos.count; i++) {
    if (band.has(i)) continue;
    assertEquals(uv.getX(i), UNTOUCHED, `vertex ${i} u was rewritten and should not have been`);
    assertEquals(uv.getY(i), UNTOUCHED, `vertex ${i} v was rewritten and should not have been`);
  }
  // The slope's upper corner shares the plane u = -S/2 but belongs to a ROOF triangle. It is
  // the one vertex a per-vertex plane test would wrongly drag into the band, so name it.
  const stray = [...Array(pos.count).keys()].filter((i) =>
    i >= f.capCount && !band.has(i) && Math.abs(pos.getX(i) + f.S / 2) < 1e-4
  );
  assert(stray.length > 0, "the fixture must contain a roof vertex that shares the tall plane");
  assert(uv.needsUpdate, "the rewrite must flag the attribute or the GPU never sees it");
});

Deno.test("materialIndex 0 IS the cladding — the mesh's array says so", () => {
  const f = shedFixture(12, 16);
  const { mesh } = repaint(SHED, f.S, f.L, f.uAxisIsX, f.g);
  assertEquals(mesh.geometry, f.g);
  assertEquals(mesh.material, [WALL_MAT, GABLE_MAT]);
  // Without this the group numbers above are arithmetic with no meaning.
  assertEquals((mesh.material as unknown[])[0], WALL_MAT);
  assertEquals((mesh.material as unknown[])[1], GABLE_MAT);
});

Deno.test("a wall face SPLIT across the side list still resolves into correct runs", () => {
  // The shipped comment claims the run-coalescing exists so "a future profile with the wall
  // face split across the list still resolves correctly". Today's shed profile has its tall
  // edge contiguous, so that claim is untested by any real shape — this is a synthetic
  // polygon with TWO separate edges in the tall plane, which is the only way to exercise it.
  const S = 16, L = 12;
  const poly: Pt[] = [[-8, 8], [-8, 10], [0, 10], [0, 12], [-8, 12], [-8, 14], [8, 8]];
  const { g, capCount, sideCount } = extrudeStub(poly, L);
  const { groups } = repaint(SHED, S, L, true, g);
  const tri = perTriangle(groups, capCount + sideCount);
  const sideMats = tri.slice(capCount / 3);
  // Edges 0 and 4 are the two in-plane ones -> triangles 0,1 and 8,9.
  assertEquals(sideMats, [0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1]);
  // And they must be FOUR groups over the sides, not two runs merged across the gap.
  assertEquals(groups.length, 5, "caps + four contiguous side runs");
});

// ── The guards. Every one of these must DECLINE and leave the geometry exactly as found. ──

/** Snapshot everything the repaint could touch, so "nothing moved" is provable. */
function snapshot(g: Geom) {
  return JSON.stringify({
    groups: g.groups,
    uv: g.attributes.uv.rows,
    needsUpdate: g.attributes.uv.needsUpdate,
  });
}

Deno.test("NO side triangle in the tall plane (a gable): the repaint declines", () => {
  const { S, tallNeg } = d3RoofAxes({ type: "gable", pitch: 0.4 }, 12, 16);
  const { dedup } = d3RoofProfile({ type: "gable", pitch: 0.4 }, S, H, tallNeg);
  const { g } = extrudeStub(dedup, 12);
  const before = snapshot(g);
  // roofCfg still says "shed" on purpose: this isolates the NONE guard from the type guard.
  repaint(SHED, S, 12, true, g);
  assertEquals(snapshot(g), before, "a gable cap must come through untouched");
});

Deno.test("EVERY side triangle in the tall plane: the repaint declines", () => {
  // Degenerate, but it is the guard's stated reason — "the whole side set in one plane cannot
  // be a roof" — and without the !every() half the block would repaint all of it.
  const S = 12, L = 16;
  const { g } = extrudeStub([[-6, 8], [-6, 14], [-6, 10]], L);
  const before = snapshot(g);
  repaint(SHED, S, L, true, g);
  assertEquals(snapshot(g), before);
});

Deno.test("a non-shed roofCfg never reaches the repaint, even on shed geometry", () => {
  const f = shedFixture(12, 16);
  const before = snapshot(f.g);
  for (const cfg of [{ type: "gable" }, { type: "gambrel" }, {}, null, undefined]) {
    repaint(cfg, f.S, f.L, f.uAxisIsX, f.g);
    assertEquals(snapshot(f.g), before, `${JSON.stringify(cfg)} reached the repaint`);
  }
});

Deno.test("⚠️ THE UNDOCUMENTED INTERNAL: a group count that is not 2 declines SILENTLY", () => {
  // ExtrudeGeometry emitting exactly [caps, sides] is a three.js implementation detail. If a
  // future release splits or merges them, THIS is what happens: no error, no warning, the band
  // simply goes back to flat body colour and Carolyn's bug is live again. Pinned so the
  // failure mode is on the record rather than discovered in a demo.
  const three = shedFixture(12, 16);
  three.g.addGroup(0, 0, 1);
  const beforeThree = snapshot(three.g);
  repaint(SHED, three.S, three.L, three.uAxisIsX, three.g);
  assertEquals(snapshot(three.g), beforeThree, "3 groups must fall through");

  // One group falls through too, AND drops the mesh back to a single material — so the caps
  // lose their cladding as well. Same silence.
  const one = shedFixture(12, 16);
  one.g.groups = [{ start: 0, count: one.capCount + one.sideCount, materialIndex: 0 }];
  const { mesh, groups } = repaint(SHED, one.S, one.L, one.uAxisIsX, one.g);
  assertEquals(groups.length, 1);
  assertEquals(mesh.material, GABLE_MAT, "a single group takes the scalar material, not the array");
});

Deno.test("⚠️ if three.js ever SWAPS caps and sides, the guard declines rather than cladding a roof", () => {
  // The one drift outcome that would be WORSE than the bug returning: painting siding onto the
  // underside of the roof slope, which still looks "fixed" to a suite that only counts groups.
  // Swapping the two groups is exactly what that drift looks like from in here. The cap
  // triangles of a shed span both u = -S/2 and u = +S/2, so none is wholly in the tall plane,
  // triTall is all-false, and the NONE guard declines. Incidental, but real, and now pinned.
  const f = shedFixture(12, 16);
  f.g.groups = [
    { start: f.capCount, count: f.sideCount, materialIndex: 1 },
    { start: 0, count: f.capCount, materialIndex: 0 },
  ];
  const before = snapshot(f.g);
  repaint(SHED, f.S, f.L, f.uAxisIsX, f.g);
  assertEquals(snapshot(f.g), before, "a swapped group order must NOT repaint anything");
});

Deno.test("⚠️ THREE_VERSION is still the release the group ordering was verified against", () => {
  // The nearest thing to a real check on the assumption that a no-network suite can give.
  // three is loaded from esm.sh at runtime and never vendored, so nothing here can import it.
  // What this CAN do is stand in the way of a silent bump: if you are changing this constant,
  // go and confirm ExtrudeGeometry still emits group 0 = caps / group 1 = swept sides before
  // you change it, because every assertion in Part 3 assumes it and the fix fails silently.
  const PIN = '"0.167.0"';
  for (const [name, src] of [["StructureStudio.jsx", JSX], ["structure-studio.component.js", CMP]] as const) {
    const m = src.match(/const THREE_VERSION = ("[^"]+")/);
    assert(m, `${name}: THREE_VERSION declaration not found`);
    assertEquals(m![1], PIN, `${name}: three.js was bumped — re-verify the ExtrudeGeometry group order`);
  }
});
