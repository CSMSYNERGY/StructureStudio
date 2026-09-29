// THE CUSTOMER'S PIERS, DRAWN (2026-09-28), tested against BOTH SHIPPED designer twins.
//
// Carolyn, opening Designer > Foundation on the 09-28 call: "if they choose piers, we could show it on
// the building." The customer's Foundation tab is priced site work (sel.foundation); until today it
// never reached the 3D, which drew only the style's own d3.foundation. d3CustomerFoundation reads the
// pick and d3ResolveStyleSpec takes it as a NEW TRAILING argument, so:
//
//   · every call that does not pass it -- above all openCalEditor's, whose result the calibration
//     panel posts back AS THE STYLE -- gets exactly the object it always got, and a customer's pick
//     can never be frozen into a tenant's column;
//   · a style at grade (a slab, skids, nothing said) goes up on piers at the renderer's own 1.5 ft,
//     a style on blocks keeps the floor height it was drawn at (its measured one, or the blocks'
//     own 1 ft when it stores none: the floor never jumps), a style already on piers does not move;
//   · every customer-facing call site passes it, so the docked 3D, the full-screen viewer, the quote's
//     shot, the gable-vent placement and the dormer-window price gate agree about the building.
//
// Lifted by stable anchors (the raisedFloor_test technique), each region asserted byte-identical in
// the two hand-mirrored twins. The meshes are checked in tests/harness/stepsPiers.mjs.

import { assert, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `customerFoundation_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_STYLE_DEFAULTS = {", "// ── CLADDING ──"],
  // d3RaisedFoundation and d3GradeFt with them: a blocks style's piers are pinned to d3GradeFt.
  ["const D3_FOUNDATIONS = [", "// How much further down the ground is than it has always been"],
  // The resolver names the ground's fall beside the floor height (the slope branch, merged 2026-09-29).
  ["const D3_GRADE_FALL_TOWARD = [", "// { fallFt, toward }"],
  // ...and the ground at each corner (2026-09-29), which it names the same way (d3GradeCornersGiven).
  ["const D3_GRADE_CORNERS = [", "// THE GROUND UNDER THE FOUR CORNERS"],
  ["const FOUNDATION_ITEM_LABEL = {", "function foundationLabelOf("],
  ["function d3ResolveStyleSpec(", "// Carolyn (2026-07-02): horizontal lap siding"],
  ["function d3CustomerFoundation(", "// Natural-material fallbacks"],
];
const blocks = REGIONS.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));

Deno.test("every lifted region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `${blocks.map((b) => b.cmp).join("\n")}; return { d3ResolveStyleSpec, d3CustomerFoundation, resolveFoundation, d3GradeFt };`,
)() as Record<string, Any>;

const ROOF = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, porchOutFt: 6, porchSteps: "left" };
const style = (d3: Any) => ({ value: "tri", label: "Tri", d3 });
const STYLES: Record<string, Any> = {
  none: style({ roof: ROOF, siding: "batten", wallHeightFt: 8 }),
  slab: style({ roof: ROOF, siding: "batten", wallHeightFt: 8, foundation: "slab" }),
  skids: style({ roof: ROOF, siding: "batten", wallHeightFt: 8, foundation: "skids", floorHeightFt: 2 }),
  blocks: style({ roof: ROOF, siding: "batten", wallHeightFt: 8, foundation: "blocks", floorHeightFt: 1.1 }),
  blocksDefault: style({ roof: ROOF, siding: "batten", wallHeightFt: 8, foundation: "blocks" }),
  piers: style({ roof: ROOF, siding: "batten", wallHeightFt: 8, foundation: "piers", floorHeightFt: 2 }),
};
const resolve = (s: Any, cf?: Any) => cf === undefined
  ? F.d3ResolveStyleSpec(s, s.value, 8, null, 0)
  : F.d3ResolveStyleSpec(s, s.value, 8, null, 0, cf);

Deno.test("⚠️ without the customer's pick the resolver returns exactly what it always did", () => {
  for (const [k, s] of Object.entries(STYLES)) {
    for (const cf of [undefined, null, "", "Piers", "concrete_slab", "gravel_pad", true, 1]) {
      assertEquals(JSON.stringify(resolve(s, cf)), JSON.stringify(resolve(s)), `${k} with ${String(cf)}`);
    }
  }
  // The three-argument call openCalEditor makes, too.
  assertEquals(JSON.stringify(F.d3ResolveStyleSpec(STYLES.blocks, "tri", 8)), JSON.stringify(F.d3ResolveStyleSpec(STYLES.blocks, "tri", 8, undefined, undefined, undefined)));
});

Deno.test("customer piers: a style at grade goes up on piers at the renderer's default height", () => {
  for (const k of ["none", "slab", "skids"]) {
    const was = resolve(STYLES[k]), now = resolve(STYLES[k], "piers");
    assertEquals(now.foundation, "piers", k);
    assert(!("floorHeightFt" in now), `${k}: no floor height, so d3GradeFt draws the piers' own 1.5 ft`);
    // Nothing else moves, and the keys keep their order (the panel signature hashes the object).
    assertEquals(JSON.stringify({ ...now, foundation: was.foundation }), JSON.stringify(was), k);
  }
});

Deno.test("customer piers: a raised style keeps the floor where it was drawn; one already on piers does not move", () => {
  const b = resolve(STYLES.blocks, "piers");
  assertEquals([b.foundation, b.floorHeightFt], ["piers", 1.1]);
  assertEquals(JSON.stringify({ ...b, foundation: "blocks" }), JSON.stringify(resolve(STYLES.blocks)));
  // ⚠️ A BLOCKS STYLE THAT STORES NO HEIGHT is drawn at the blocks' own 1 ft. Left absent, the piers'
  // 1.5 ft default would drop the ground 6 in when all the customer ticked was the site work.
  const bdWas = resolve(STYLES.blocksDefault), bd = resolve(STYLES.blocksDefault, "piers");
  assertEquals([bd.foundation, bd.floorHeightFt], ["piers", 1]);
  assertEquals(F.d3GradeFt(bd), F.d3GradeFt(bdWas));
  // Whatever height the blocks were drawn at, the piers are: out-of-band stored heights included
  // (d3GradeFt's own rule decides both).
  for (const h of [0.2, 0.3, 0.8, 1.1, 2.75, 6, 7.5, 9, -1, 0]) {
    const s = style({ roof: ROOF, siding: "batten", wallHeightFt: 8, foundation: "blocks", floorHeightFt: h });
    const was = resolve(s), now = resolve(s, "piers");
    assertEquals(now.foundation, "piers", `blocks at ${h}`);
    assertEquals(F.d3GradeFt(now), F.d3GradeFt(was), `blocks at ${h}`);
  }
  assertEquals(JSON.stringify(resolve(STYLES.piers, "piers")), JSON.stringify(resolve(STYLES.piers)));
  // The style's own object is never written to.
  assertEquals(STYLES.none.d3.foundation, undefined);
  assertEquals(STYLES.blocks.d3.foundation, "blocks");
});

Deno.test("the ground at each corner (2026-09-29): named beside a raised floor, kept onto piers, gone from a style at grade", () => {
  const gc = { fl: 0, fr: 1.5, bl: "0.5", br: 9 };
  const raised = style({ roof: ROOF, siding: "batten", wallHeightFt: 8, foundation: "blocks", floorHeightFt: 1.1, gradeCornersFt: gc });
  const r = resolve(raised);
  assertEquals(r.gradeCornersFt, { fl: 0, fr: 1.5, bl: 0.5, br: 6 }, "all four, held to 0..6");
  assert(r.gradeCornersFt !== gc, "a copy, never the style's own object");
  assertEquals(resolve(raised, "piers").gradeCornersFt, r.gradeCornersFt, "blocks to the customer's piers: the same ground");
  for (const f of [undefined, "slab", "skids"]) {
    const s = style({ roof: ROOF, siding: "batten", wallHeightFt: 8, ...(f ? { foundation: f } : {}), gradeCornersFt: gc });
    assert(!("gradeCornersFt" in resolve(s)), `${String(f)}: not raised, not named`);
    assert(!("gradeCornersFt" in resolve(s, "piers")), `${String(f)}: the customer's piers stand on level ground`);
  }
  // All zeros, or junk, is level ground: not named, so the object is the one it always was.
  for (const junk of [{ fl: 0, fr: 0, bl: 0, br: 0 }, {}, [], "2", null, { fl: -1, br: "x" }]) {
    const s = style({ roof: ROOF, siding: "batten", wallHeightFt: 8, foundation: "piers", floorHeightFt: 2, gradeCornersFt: junk });
    assertEquals(JSON.stringify(resolve(s)), JSON.stringify(resolve(STYLES.piers)), JSON.stringify(junk));
  }
});

const OFFER = { id: "piers", label: "Piers", basis: "each", rate: 100, charged: true };
Deno.test("d3CustomerFoundation: piers only when ticked AND offered by this tenant", () => {
  const C = { foundationItems: [{ id: "gravel_pad", basis: "sqft_building", rate: 2, charged: true }, OFFER] };
  assertEquals(F.d3CustomerFoundation(C, { foundation: [{ id: "piers", qty: null }] }), "piers");
  assertEquals(F.d3CustomerFoundation(C, { foundation: [{ id: "gravel_pad", qty: null }, { id: "piers", qty: "6" }] }), "piers");
  // A rep's internal-only item still counts: resolveFoundation is the pricing rule, and it prices it.
  assertEquals(F.d3CustomerFoundation({ foundationItems: [{ ...OFFER, internalOnly: true }] }, { foundation: [{ id: "piers" }] }), "piers");
  // Not ticked, other site work only, not offered, or nothing to read: the style's own foundation.
  for (const [cfg, sel] of [
    [C, { foundation: [] }],
    [C, { foundation: [{ id: "gravel_pad" }, { id: "concrete_slab" }] }],
    [C, {}],
    [C, { foundation: "piers" }],
    [C, { foundation: [null, { id: "Piers" }] }],
    [{ foundationItems: [] }, { foundation: [{ id: "piers" }] }],
    [{}, { foundation: [{ id: "piers" }] }],
    [null, { foundation: [{ id: "piers" }] }],
    [C, null],
  ] as Array<[Any, Any]>) {
    assertEquals(F.d3CustomerFoundation(cfg, sel), null, JSON.stringify([cfg, sel]));
  }
});

Deno.test("⚠️ every customer-facing resolver call passes the pick, and the calibration seed never does", () => {
  for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]]) {
    const calls = src.split("d3ResolveStyleSpec(").slice(1).map((t) => t.slice(0, 260));
    const customer = calls.filter((t) => t.startsWith("selectedStyle, sel.style,"));
    assertEquals(customer.length, 5, `${file}: ventRoof2D, the quote's shot, the dormer price gate, the dock and the viewer`);
    for (const t of customer) assert(t.includes("d3CustomerFoundation(C, sel))"), `${file}: ${t.slice(0, 200)}`);
    // Two seeds, and neither passes a customer choice: openCalEditor's, and the Advanced page's
    // "Start from" copy of a style (2026-09-28). Both become a draft a builder can save as a style.
    const seed = calls.filter((t) => t.startsWith("s, s.value,"));
    assertEquals(seed.length, 2, `${file}: openCalEditor's seed and the Advanced page's start-from seed`);
    assert(seed[0].startsWith("s, s.value, C.wallHeightFt);"), `${file}: openCalEditor passes no customer choice: ${seed[0].slice(0, 80)}`);
    assert(seed[1].startsWith("s, s.value, C.wallHeightFt || 8)"), `${file}: the Advanced seed passes no customer choice: ${seed[1].slice(0, 80)}`);
  }
});
