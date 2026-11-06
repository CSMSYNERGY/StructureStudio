// THE FRAMING VIEW (Carolyn, 2026-10-26; roadmap "Show interior 2x4 studs at 16" or 24" OC, set per building"),
// tested against BOTH SHIPPED designer twins.
//
// The 3D's Framing button draws the building with its siding off: studs at the style's own on-centre spacing
// (building_styles.d3.framing.studOcIn), plates, framed openings, rafters with a gable's or a barn's gussets and
// collar tie, 4x8 floor sheets. Everything about it that is not a mesh is the FRAMING LAYOUT block at module scope
// (pure: no THREE, no DOM), lifted here by its markers and run. The meshes are proved on the compiled bundle by
// tests/harness/framing.mjs, which holds the drawn lumber against this same block.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const JSX = await read("../../../../StructureStudio.jsx");
const CMP = await read("../../../../structure-studio.component.js");

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `framing_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const LAYOUT = ["// ── FRAMING LAYOUT ──", "// ── END FRAMING LAYOUT ──"];
const DRAW = ["// ── FRAMING 3D ──", "// ── END FRAMING 3D ──"];
const layoutCmp = lift(CMP, "structure-studio.component.js", LAYOUT[0], LAYOUT[1]);
const layoutJsx = lift(JSX, "StructureStudio.jsx", LAYOUT[0], LAYOUT[1]);

// deno-lint-ignore no-explicit-any
type Any = any;
const F: Any = new Function(`${layoutCmp}; return { ssFrameOcIn, ssFrameLayout, ssFrameHeaderFt, ssFrameWall, ssFrameSpanAt, ssFrameFace, ssFrameTruss, ssFloorSheets, ssLoftJoists, SS_FRAME_T, SS_FRAME_D, SS_FRAME_OC_IN };`)();
const count = (ms: Any[], k: string) => ms.filter((m) => m.kind === k).length;
const T = 1.5 / 12;

Deno.test("both FRAMING blocks are byte-identical in the two twins", () => {
  assertEquals(layoutJsx, layoutCmp, "twins differ in the FRAMING LAYOUT block");
  assertEquals(lift(JSX, "StructureStudio.jsx", DRAW[0], DRAW[1]), lift(CMP, "structure-studio.component.js", DRAW[0], DRAW[1]), "twins differ in the FRAMING 3D block");
});

Deno.test("the layout block is pure: literals only at its top level", () => {
  const top = layoutCmp.split("\n").filter((l) => /^(const|let|var) /.test(l));
  assertEquals(top, ["const SS_FRAME_OC_IN = [16, 24];", "const SS_FRAME_T = 1.5 / 12;", "const SS_FRAME_D = 3.5 / 12;"]);
  assert(!/THREE|document|window/.test(layoutCmp.replace(/^\s*\/\/.*$/gm, "")), "no THREE, no DOM in the code");
});

Deno.test("the spacing: 16 or 24 from the style, nothing else, and none by default", () => {
  assertEquals(F.ssFrameOcIn({ framing: { studOcIn: 16 } }), 16);
  assertEquals(F.ssFrameOcIn({ framing: { studOcIn: 24 } }), 24);
  for (const s of [null, {}, { framing: null }, { framing: { studOcIn: 12 } }, { framing: { studOcIn: 20 } }, { framing: {} }]) {
    assertEquals(F.ssFrameOcIn(s), null, JSON.stringify(s));
  }
});

Deno.test("a 12 ft wall lays out 10 studs at 16 in and 7 at 24 in, ends flush, marks on centre", () => {
  const a16 = F.ssFrameLayout(0, 12, 16), a24 = F.ssFrameLayout(0, 12, 24);
  assertEquals([a16.length, a24.length], [10, 7]);
  assertAlmostEquals(a16[0], T / 2, 1e-12, "the first stud flush with the end");
  assertAlmostEquals(a16[a16.length - 1], 12 - T / 2, 1e-12, "the last flush with the other end");
  assertAlmostEquals(a16[1], 16 / 12, 1e-12, "the marks at 16 in");
  assertAlmostEquals(a24[3], 6, 1e-12, "and at 24 in");
  // A mark closer to the end than a stud is dropped, not doubled up against the end stud.
  const tight = F.ssFrameLayout(0, 16 / 12 * 3 + 0.1, 16);
  assert(tight.every((a: number, i: number) => i === 0 || a - tight[i - 1] >= T - 1e-9), JSON.stringify(tight));
  // A 16 ft run (a gable body's ridge) gives 13 truss stations at 16 in and 9 at 24 in.
  assertEquals([F.ssFrameLayout(0, 16, 16).length, F.ssFrameLayout(0, 16, 24).length], [13, 9]);
});

Deno.test("a 3 ft door: 2 kings, 2 jacks, 1 header, and no bottom plate across it", () => {
  const ms = F.ssFrameWall({ a0: 0, a1: 12, bot: 0, top: 8, ocIn: 16, ops: [{ a0: 4.5, a1: 7.5, y0: 0, y1: 6.5 }] });
  assertEquals([count(ms, "king"), count(ms, "jack"), count(ms, "header")], [2, 2, 1]);
  const plates = ms.filter((m: Any) => m.kind === "plate");
  assert(plates.every((p: Any) => p.a1 <= 4.5 + 1e-9 || p.a0 >= 7.5 - 1e-9), "the plate is cut at the doorway");
  assertEquals(plates.length, 2);
  // No stud in the doorway, and nothing but the header (and the cripples over it) above it.
  assert(!ms.some((m: Any) => m.a0 < 7.5 && m.a1 > 4.5 && m.y0 < 6.5 && m.kind !== "plate" && m.kind !== "top"), "the doorway is clear");
  const hd = ms.find((m: Any) => m.kind === "header");
  assertAlmostEquals(hd.y0, 6.5, 1e-12, "the header sits on the jacks at the opening's head");
  assertAlmostEquals(hd.y1 - hd.y0, 5.5 / 12, 1e-12, "a doubled 2x6 over a 3 ft span");
  assert(ms.filter((m: Any) => m.kind === "cripple").every((m: Any) => m.y0 >= hd.y1 - 1e-9), "cripples over the header");
  // The doubled top plate.
  assertEquals(ms.filter((m: Any) => m.kind === "top").length, 2);
});

Deno.test("a window: a rough sill with cripples under it, a header with cripples over it", () => {
  const ms = F.ssFrameWall({ a0: 0, a1: 12, bot: 0, top: 8, ocIn: 16, ops: [{ a0: 4, a1: 7, y0: 3.5, y1: 6.5 }] });
  assertEquals([count(ms, "sill"), count(ms, "header"), count(ms, "king"), count(ms, "jack")], [1, 1, 2, 2]);
  const sill = ms.find((m: Any) => m.kind === "sill");
  assertAlmostEquals(sill.y1, 3.5, 1e-12, "the sill's top is the opening's bottom");
  const under = ms.filter((m: Any) => m.kind === "cripple" && m.y1 <= sill.y0 + 1e-9);
  assert(under.length >= 2, `cripples under the sill: ${under.length}`);
  assertEquals(count(ms, "plate"), 1, "the bottom plate runs under a window");
});

Deno.test("a wall stepped in its top, a wide opening, and the 3-stud corner", () => {
  const step = F.ssFrameWall({ a0: 0, a1: 10, bot: 0, tops: [[0, 4, 8], [4, 10, 12]], ocIn: 24, ops: [] });
  assertEquals(step.filter((m: Any) => m.kind === "top").length, 4, "a doubled plate on each piece");
  assert(step.filter((m: Any) => m.kind === "stud" && m.a1 <= 4).every((m: Any) => m.y1 <= 8 - 2 * T + 1e-9), "studs under the low piece stop under its plate");
  assert(step.some((m: Any) => m.kind === "stud" && m.a0 >= 4 && m.y1 > 11), "studs under the high piece run up to it");
  assertAlmostEquals(F.ssFrameHeaderFt(5), 7.25 / 12, 1e-12, "a 2x8 over 5 ft");
  assertAlmostEquals(F.ssFrameHeaderFt(8), 9.25 / 12, 1e-12, "a 2x10 over 8 ft");
  const corner = F.ssFrameWall({ a0: 0, a1: 8, bot: 0, top: 8, ocIn: 16, ops: [], ends: [1, 1] });
  assertEquals(count(corner, "corner"), 2, "the through wall's second stud at each end");
  // A clerestory stands on a wing roof: its plate is there, not at the floor.
  const high = F.ssFrameWall({ a0: 0, a1: 8, bot: 9, top: 14, ocIn: 16, ops: [] });
  assert(high.every((m: Any) => m.y0 >= 9 - 1e-9), "nothing below its bottom");
});

Deno.test("a gable's studs are cut to the roof line, under the rafter", () => {
  const tri = [[[-6, 8], [6, 8], [0, 10.4]]];
  const f = F.ssFrameFace(tri, 16, { cut: 3.5 / 12 });
  assert(f.studs.length >= 6, `${f.studs.length} studs`);
  for (const s of f.studs) {
    const roof = 10.4 - Math.abs(s.u) * 0.4 - 0.4 * T / 2;   // the lower of the two edges a stud spans
    assert(s.y1 <= roof - 3.5 / 12 + 1e-6, `stud at ${s.u} stops under the rafter (${s.y1} vs ${roof})`);
    assertAlmostEquals(s.y0, 8, 1e-9, "on the wall's plate");
  }
  assertEquals(f.plate, null, "a gable over a wall gets no plate of its own");
  const leanEnd = F.ssFrameFace([[[0, 0], [6, 0], [6, 7]], [[0, 0], [6, 7], [0, 8]]], 24, { cut: 0.29, plate: true });
  assert(leanEnd.plate && leanEnd.studs.every((s: Any) => s.y0 >= T - 1e-9), "a wall from the floor stands on a bottom plate");
});

Deno.test("trusses: a gable's peak gusset and collar tie; a barn's gussets at both knees and the peak", () => {
  const gable = F.ssFrameTruss([[-6, 8], [0, 10.4], [6, 8]], 8);
  assertEquals(gable.gussets.map((g: Any) => g.kind), ["peak"]);
  assertEquals(gable.ties.length, 1);
  assertAlmostEquals(gable.ties[0].y, 10.4 - 2.4 / 3, 1e-9, "the collar tie a third of the way down from the ridge");
  const barn = F.ssFrameTruss([[-6, 8], [-3.3, 11.3], [0, 12.8], [3.3, 11.3], [6, 8]], 8);
  assertEquals(barn.gussets.map((g: Any) => g.kind), ["knee", "peak", "knee"]);
  assertEquals(barn.ties.length, 1, "one collar tie, knee to knee");
  assert(barn.ties[0].u1 - barn.ties[0].u0 > 6, "across between the knees");
  // No bottom chord (Ahsan, 10-27): no tie anywhere near the plate.
  for (const t of [...gable.ties, ...barn.ties]) assert(t.y > 8.5, `no bottom chord: tie at ${t.y}`);
  // A shed's single slope has no joint: rafters only.
  const shed = F.ssFrameTruss([[-6, 8], [-6, 11], [6, 8]], 8);
  assertEquals([shed.gussets.length, shed.ties.length], [0, 0]);
});

Deno.test("a 12x16 floor is 3 rows of 4x8 sheets, the middle row offset 4 ft", () => {
  const sh = F.ssFloorSheets(12, 16, null);
  const rows = [...new Set(sh.map((s: Any) => s.x0))].sort((a: Any, b: Any) => a - b);
  assertEquals(rows, [0, 4, 8], "three rows 4 ft wide across the 12 ft");
  const joints = (x: number) => sh.filter((s: Any) => s.x0 === x).map((s: Any) => s.z1).filter((z: number) => z < 16).sort((a: number, b: number) => a - b);
  assertEquals(joints(0), [8], "outer rows: a joint at 8 ft");
  assertEquals(joints(4), [4, 12], "the middle row starts 4 ft in");
  assertEquals(joints(8), [8]);
  assertAlmostEquals(sh.reduce((a: number, s: Any) => a + (s.x1 - s.x0) * (s.z1 - s.z0), 0), 192, 1e-9, "the whole floor, no overlap");
  // Cut round the open ground beside a part-wall wing.
  const cut = F.ssFloorSheets(12, 16, [{ x0: 8, x1: 12, y0: 0, y1: 6 }]);
  assertAlmostEquals(cut.reduce((a: number, s: Any) => a + (s.x1 - s.x0) * (s.z1 - s.z0), 0), 192 - 24, 1e-9);
  assert(cut.every((s: Any) => !(s.x0 < 12 && s.x1 > 8 && s.z0 < 6 && s.z1 > 0)), "nothing on the open ground");
});

Deno.test("a loft's joists: a rim at each side and the layout between", () => {
  assertEquals(F.ssLoftJoists(12, 16).length, 10);
  assertEquals(F.ssLoftJoists(4, 24).length, 3);
});

// ── The wiring, statically, in both twins ──────────────────────────────────────────────────────────
const TWINS: Array<[string, string]> = [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]];
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

Deno.test("framing is never built by the model or the estimate's renderers, only by the viewer's toggle", () => {
  for (const [name, src] of TWINS) {
    const code = codeOnly(src);
    const model = codeOnly(lift(src, name, "function buildShed3DModel(", "\nfunction d3UnbindFixtureMats("));
    assert(!model.includes("buildFraming3D("), `${name}: buildShed3DModel never builds it`);
    const shots = codeOnly(lift(src, name, "async function renderDefault3DShot(", "// ─── THE SELF-CHECK'S OWN CAMERAS"));
    assert(!shots.includes("buildFraming3D(") && !shots.includes("ssFraming"), `${name}: the estimate's picture and its four corners never build it`);
    assertEquals((code.match(/buildFraming3D\(/g) || []).length, 2, `${name}: defined once, called once (applyShellMode)`);
    // The estimate's picture from the open viewer reads a frame with framing put away.
    const capture = lift(code, name, "  const capture = () => {", "  const awaitFixturePhotos = ");
    assert(/const framed = !!e\.framing;\s*if \(framed\) \{ e\.framing = false; e\.applyShellMode\(e\); \}/.test(capture), `${name}: capture puts framing away first`);
    assert(/finally \{\s*if \(framed\) \{ e\.framing = true; e\.applyShellMode\(e\); e\.render\(\); \}/.test(capture), `${name}: and brings it back`);
    // No button on a style without a spacing.
    assert(code.includes("const frameOc = ssFrameOcIn(style3d);") && code.includes("{frameOc && ("), `${name}: the button is gated on the spacing`);
  }
});

// ── The two save paths carry a stored spacing over an older designer's silence, before they compare or write ──
const PORTAL_SETTINGS = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const ADMIN_SAVE = (await Deno.readTextFile(new URL("../../admin-save-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
Deno.test("both save paths run carryForwardFraming inside save_style_d3, before the guard and the write", () => {
  for (const src of [PORTAL_SETTINGS, ADMIN_SAVE]) assert(src.includes('import { carryForwardFraming } from "../_shared/styleD3.ts";'), "imported");
  const act = PORTAL_SETTINGS.indexOf('if (action === "save_style_d3") {');
  const call = PORTAL_SETTINGS.indexOf("carryForwardFraming(clean.d3, payload.d3, found.style!.d3);", act);
  const guard = PORTAL_SETTINGS.indexOf("const decision = guardDecision(", act);
  assert(act > 0 && call > act && guard > call, `portal-settings: inside save_style_d3, before the guard (${act}, ${call}, ${guard})`);
  const aCall = ADMIN_SAVE.indexOf("carryForwardFraming(clean.d3, d3, lockRow?.d3);");
  const aWrite = ADMIN_SAVE.indexOf("const { error: upErr, count } = await supabase");
  assert(aCall > 0 && aWrite > aCall, `admin-save-settings: before the write (${aCall}, ${aWrite})`);
  // "Not set" puts a null in the panel's spec, never deletes the key, so the save that follows says it.
  for (const [name, src] of TWINS) assert(src.includes("pick: (v) => calSet({ framing: v ? { studOcIn: v } : null }),"), `${name}: Not set is a null`);
});

Deno.test("the resolver keeps framing only when it is 16 or 24, without calling anything", () => {
  for (const [name, src] of TWINS) {
    const resolve = lift(src, name, "function d3ResolveStyleSpec(", "\nfunction d3SidingOverride(");
    assert(resolve.includes("...(o.framing && (o.framing.studOcIn === 16 || o.framing.studOcIn === 24) ? { framing: { studOcIn: o.framing.studOcIn } } : {}),"), `${name}: the literal names it`);
  }
});
