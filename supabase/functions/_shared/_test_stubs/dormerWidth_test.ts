// A DORMER AS WIDE AS THE BUILDING, and a 24 in OVERHANG (the 10-01 call), tested against BOTH SHIPPED
// designer twins and the sanitiser they save through.
//
// The 10-01 call: a dormer may run the whole width of the building, and builders sometimes want 24 in of
// overhang. Three things have to agree for either to work, and each is where one went wrong before:
//   1. the server keeps what the page lets a builder type. The dormer cap was 12, so a 16 ft dormer
//      typed on the Advanced page was saved as 12; it is now the longest building the dimensions card
//      accepts (CAL_DIM_BANDS.lengthFt, 100 ft), past the Advanced page's largest (ADV_MAX_FT).
//      Every overhang chip and preset, 24 in included, survives Save as the same number;
//   2. the drawing holds a wide dormer inside the gable ends of the building it is drawn on
//      (d3DormerWidthFt), and every dormer that fits draws at exactly its own width, as before;
//   3. the dormer's seat, the lean-to cover check and the window fit read that same drawn width.
// The pure code is lifted by stable anchors and run (the wingsMassing_test technique), and every lifted
// region is asserted byte-identical across the two hand-mirrored twins.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { applyKnownDims, parseKnownDims, sanitizeD3Spec } from "../styleD3.ts";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `dormerWidth_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}
const both = (start: string, end: string) => ({
  cmp: lift(CMP, "structure-studio.component.js", start, end),
  jsx: lift(JSX, "StructureStudio.jsx", start, end),
});
const count = (src: string, s: string) => src.split(s).length - 1;

const REGIONS: Array<[string, string]> = [
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_CASE_F =", "// Built-in 3D appearance per building style"],
  // d3RoofAxes, d3Massing, the lean-tos, the roof step and every dormer function.
  ["function d3RoofAxes(", "function d3FtIn("],
  ["function ssVentSpan(", "function buildFixtureTools("],
];
const blocks = REGIONS.map(([a, b]) => ({ a, ...both(a, b) }));

Deno.test("every lifted dormer region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `const isVentItem = (it) => !!(it && it.isVent);\n${blocks.map((b) => b.cmp).join("\n")}; return { D3, D3_DORMER_END_IN, d3DormerWidthFt, ` +
    `d3RoofAxes, d3Massing, d3DormerFaceFt, d3DormerWindowFit };`,
)() as Record<string, Any>;

// ── 2. the drawn width ────────────────────────────────────────────────────────────────────────

Deno.test("⚠️ a dormer that fits its building is drawn at exactly its own width, as before", () => {
  // Every stored dormer is one of these: the clamp must not move a single one of them.
  for (const L of [8, 10, 12, 16, 24, 40, 60]) {
    for (const w of [0, 0.5, 1, 4, 6.5, 11.5, L / 2, L - 1, L - 0.5]) {
      if (w > L - 0.5) continue;
      assertEquals(F.d3DormerWidthFt({ type: "gable", dormerWidthFt: w }, L), w, `${w} ft on a ${L} ft ridge`);
    }
  }
  assertEquals(F.d3DormerWidthFt({ type: "gable" }, 16), 0, "no dormer is no width");
  assertEquals(F.d3DormerWidthFt(null, 16), 0, "no roof is no width");
});

Deno.test("a dormer wider than its building is drawn 3 in in from each gable end", () => {
  assertEquals(F.D3_DORMER_END_IN, 0.25, "3 in");
  // Typed the full length on the Advanced page: the ridge's run, less 3 in at each end.
  assertEquals(F.d3DormerWidthFt({ dormerWidthFt: 16 }, 16), 15.5);
  assertEquals(F.d3DormerWidthFt({ dormerWidthFt: 24 }, 24), 23.5);
  // Saved off a longer building and drawn on a shorter size of the same style.
  assertEquals(F.d3DormerWidthFt({ dormerWidthFt: 24 }, 16), 15.5);
  assertEquals(F.d3DormerWidthFt({ dormerWidthFt: 60 }, 12), 11.5);
  // A transom's own roof runs 3 in past each cheek (dormW + 0.5 in the renderer), so at the widest its
  // edge lands on the gable walls' line, z = 0 and z = L.
  const L = 16, dw = F.d3DormerWidthFt({ dormerWidthFt: 99 }, L);
  assertEquals(L / 2 - (dw + 0.5) / 2, 0);
  assertEquals(L / 2 + (dw + 0.5) / 2, L);
});

Deno.test("the ridge's run is the length the clamp reads, on a portrait, a landscape and an eave-front building", () => {
  // Portrait 12x16: the ridge runs the 16. Landscape 37x22: it runs the 37. A new-frame eave front
  // (roof.front "eave") runs the ridge along W.
  assertEquals(F.d3RoofAxes({ type: "gable" }, 12, 16).L, 16);
  assertEquals(F.d3RoofAxes({ type: "gable" }, 37, 22).L, 37);
  assertEquals(F.d3RoofAxes({ type: "gable", front: "eave" }, 30, 12).L, 30);
  assertEquals(F.d3Massing({ type: "gable" }, 12, 16, 8).L, 16, "the renderer's L is the massing's, the same run");
});

// ── 3. everything that reads the width reads the drawn one ────────────────────────────────────

Deno.test("⚠️ the renderer, the dormer's seat, the lean-to cover check and the window fit all read d3DormerWidthFt", () => {
  for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]] as const) {
    assertEquals(count(src, "const dormW = d3DormerWidthFt(roofCfg, L);"), 1, `${file}: the renderer`);
    assertEquals(count(src, "const dormW = d3DormerWidthFt(roofCfg, m.L);"), 1, `${file}: d3RoofLands`);
    assertEquals(count(src, "d3DormerSeatYAt(own, rear, m.L, d3DormerWidthFt(roof, m.L), st.stepFt)"), 1, `${file}: d3DormerRoof`);
    assertEquals(count(src, "const dW = d3DormerWidthFt(roofSpec, d3RoofAxes(roofSpec, bldgW, bldgH).L);"), 1, `${file}: the 3D footer's window row`);
    assertEquals(count(src, "d3DormerWindowFit(fx, d3DormerWidthFt(dRoof, d3RoofAxes(dRoof, bldgW, bldgH).L)"), 1, `${file}: the quote's window line`);
    // And nothing draws or fits from the raw key any more (an "is there a dormer" test still may).
    assertEquals(count(src, "roofCfg.dormerWidthFt || 0;"), 0, `${file}: no raw width in the renderer`);
    assertEquals(count(src, "d3DormerWindowFit(fx, Number(dRoof.dormerWidthFt)"), 0, `${file}: no raw width in the quote`);
  }
});

Deno.test("a full-length dormer's window fits the dormer as drawn, not the number typed", () => {
  // A 3 ft window in a gable dormer typed 16 ft on a 12x16: the dormer is 15.5 ft wide as drawn, and the
  // window slides inside that, never into a cheek that is not there.
  const spec = { roof: { type: "gable", pitch: 0.5, dormerWidthFt: 16, dormerRiseFt: 3 }, wallHeightFt: 8 };
  const face = F.d3DormerFaceFt(spec, 12, 16);
  const drawn = F.d3DormerWidthFt(spec.roof, F.d3RoofAxes(spec.roof, 12, 16).L);
  assertEquals(drawn, 15.5);
  const fx = { widthIn: 36, heightIn: 24 };
  const asDrawn = F.d3DormerWindowFit(fx, drawn, face, 1);
  const asTyped = F.d3DormerWindowFit(fx, 16, face, 1);
  assert(asDrawn && asTyped, "it fits either way");
  assertEquals(asDrawn.w, asTyped.w, "the same window");
  assertAlmostEquals(asDrawn.travel, asTyped.travel - 0.25, 1e-12, "it slides 3 in less each way: the cheeks are 3 in further in");
});

// ── 1. the server keeps what the page offers ──────────────────────────────────────────────────

Deno.test("⚠️ the server keeps every dormer width the panels offer, up to the longest building they take", () => {
  const sizes = both("const ADV_MIN_FT = ", ";");
  assertEquals(sizes.jsx, sizes.cmp);
  const m = /ADV_MAX_FT = (\d+)/.exec(sizes.cmp);
  assert(m, "ADV_MAX_FT is a number");
  const top = Number(m[1]);
  // The page's dormer box runs to the previewed building's ridge, which is at most the page's largest size.
  for (const src of [CMP, JSX]) {
    assertEquals(count(src, "const dLen = d3RoofAxes(roof, bldgW, bldgH).L;"), 1, "the dormer box's top is the ridge's run");
    assertEquals(count(src, `label: "Dormer width (ft)", value: roof.dormerWidthFt != null ? roof.dormerWidthFt : 0, min: 1, max: dLen, step: 0.5,`), 1, "…and the box uses it");
  }
  const kept = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, dormerWidthFt: top } });
  assert(kept.ok && kept.d3.roof.dormerWidthFt === top, `${top} ft is saved as ${top} ft`);
  // The operator panel's dimensions card takes a longer building than the Advanced page, and its dormer
  // box has no top of its own: the cap is the card's longest building.
  const bandsSrc = both("const CAL_DIM_BANDS = ", ";");
  assertEquals(bandsSrc.jsx, bandsSrc.cmp);
  const bands = new Function(`${bandsSrc.cmp}; return CAL_DIM_BANDS;`)() as Record<string, [number, number]>;
  const longest = bands.lengthFt[1];
  assert(longest >= top, `the card's longest building (${longest} ft) is at least the page's (${top} ft)`);
  const full = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, dormerWidthFt: longest } });
  assert(full.ok && full.d3.roof.dormerWidthFt === longest, `${longest} ft is saved as ${longest} ft`);
  const past = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, dormerWidthFt: longest + 0.5 } });
  assert(past.ok && past.d3.roof.dormerWidthFt === longest, "past the longest building it is held there");
});

Deno.test("⚠️ every overhang chip and preset, 24 in included, survives Save as the same number", () => {
  // The calibration panel's chips (inches, sent as dims.overhangIn) ...
  const chipsSrc = both("const CAL_OVERHANG_CHIPS = ", "]];");
  assertEquals(chipsSrc.jsx, chipsSrc.cmp);
  const chips = new Function(`${chipsSrc.cmp}]]; return CAL_OVERHANG_CHIPS;`)() as Array<[number | null, string]>;
  const inches = chips.map(([v]) => v).filter((v): v is number => v != null);
  assert(inches.includes(24), `the chips offer 24 in: ${JSON.stringify(inches)}`);
  for (const v of inches) {
    const k = parseKnownDims({ widthFt: 12, lengthFt: 16, wallHeightFt: 8, overhangIn: v });
    assert(k.ok && k.dims, `${v} in is a known dimension`);
    const s = sanitizeD3Spec(applyKnownDims({ roof: { type: "gable", pitch: 0.4, overhang: 0.6 } }, k.dims));
    assert(s.ok && s.d3.roof.overhang === v / 12, `${v} in is stored as ${v / 12} ft`);
  }
  // ... and the Advanced page's presets (inches, written as round(n / 12 * 10000) / 10000 ft), whose
  // box goes to 24.
  const presetSrc = both(`aria-label="Overhang presets">`, `.map(([n, l]) => (`);
  assertEquals(presetSrc.jsx, presetSrc.cmp);
  const presets = new Function(`return ${presetSrc.cmp.slice(presetSrc.cmp.indexOf("[["))};`)() as Array<[number, string]>;
  assertEquals(presets.map(([n]) => n), [0, 2, 6, 12, 16, 24]);
  for (const src of [CMP, JSX]) assertEquals(count(src, `{advNum({ k: "overhang", label: "Overhang", unit: "in", value: ohIn, min: 0, max: 24, step: 1,`), 1, "the box goes to 24 too");
  for (const [n] of presets) {
    const ft = Math.round((n / 12) * 10000) / 10000;
    const s = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, overhang: ft } });
    assert(s.ok && s.d3.roof.overhang === ft, `${n} in (${ft} ft) is stored as written`);
  }
});
