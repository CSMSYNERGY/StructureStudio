// THE METAL ROOF PROFILE, PER DESIGN (2026-10-06), tested against BOTH SHIPPED designer twins.
//
// Carolyn, 10-06, on Standing Seam vs AG Panel: "there is no standard it is per individual design".
// Until then the profile was the style's alone (building_styles.d3.roofProfile). Now:
//
//   · d3CustomerRoofProfile(sel) is the design's own pick, "agpanel" or "standingseam", only on a
//     Metal roof and only when it is a real id (spelled as loosely as d3NormalizeRoofProfile reads),
//     else null;
//   · d3ResolveStyleSpec takes it as a NEW 8TH argument and puts it in spec.roofProfile, which the
//     renderer has always read. Without it the object is exactly what it always was, so openCalEditor's
//     object, which the calibration panel posts back AS THE STYLE, can never carry a design's pick;
//   · the five customer-facing calls pass it, and only they do: never openCalEditor, the Advanced
//     page's seed (whose object is saved as a style too) or reflowItems (geometry only);
//   · computeSelectionRows' Roof row (the Details panel) words a standing seam roof the way the quote
//     does (_shared/roofProfile.ts roofLineDesc), and the amount never moves;
//   · the submit body always names roofProfile (so "" is a real clear), the three sel literals carry
//     it, the Roof options card shows the Profile select in the portal only, and the plan's summary
//     bullet names a standing seam roof.
//
// Lifted by stable anchors (the claddingExposure_test technique), each region asserted byte-identical
// in the two hand-mirrored twins. The 3D itself (6 ft pans, no drawn ribs) is measured in
// tests/harness/metalRoof.mjs and tests/harness/roofProfilePick.mjs.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import { designer } from "./designerPricing.ts";
import { effectiveRoofProfile, roofLineDesc } from "../roofProfile.ts";

const JSX = (await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url))).replace(/\r\n/g, "\n");
const CMP = (await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url))).replace(/\r\n/g, "\n");
const TWINS: Array<[string, string]> = [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]];

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `roofProfilePick_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  // What the resolver needs (claddingExposure_test's list).
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_STYLE_DEFAULTS = {", "// ── CLADDING ──"],
  ["const D3_FOUNDATIONS = [", "// How much further down the ground is than it has always been"],
  ["const D3_GRADE_FALL_TOWARD = [", "// { fallFt, toward }"],
  ["const D3_GRADE_CORNERS = [", "// THE GROUND UNDER THE FOUR CORNERS"],
  ["const FOUNDATION_ITEM_LABEL = {", "function foundationLabelOf("],
  ["const D3_CLADDING = {", "// ── METAL ROOF PROFILE"],
  // The two profiles, the normaliser and the design's own pick.
  ["const D3_METAL_ROOF_PROFILES = {", "// The ONE rule for roof orientation"],
  ["function claddingOptionsFor(", "function resolveWallHeight("],
  ["function d3ResolveStyleSpec(", "// THE CUSTOMER'S PIERS, DRAWN"],
];
const blocks = REGIONS.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));

Deno.test("every lifted region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

type Any = any;
const F = new Function(
  `${blocks.map((b) => b.cmp).join("\n")}; return { D3_METAL_ROOF_PROFILES, d3NormalizeRoofProfile, d3CustomerRoofProfile, d3ResolveStyleSpec };`,
)() as Record<string, Any>;
/** What the renderer draws for a resolved spec on a METAL roof (buildShed3DModel's roofProfile line). */
const drawn = (spec: Any) => F.D3_METAL_ROOF_PROFILES[F.d3NormalizeRoofProfile(spec && spec.roofProfile)];

const ROOF = { type: "gable", pitch: 0.4, overhang: 0.6 };
const style = (d3: Any) => ({ value: "deluxe", label: "Deluxe Gable", d3 });
const STYLES: Record<string, Any> = {
  plain: style({ roof: ROOF, wallHeightFt: 8 }),
  metalAG: style({ roof: ROOF, roofMaterial: "metal", wallHeightFt: 8 }),
  metalAGsaid: style({ roof: ROOF, roofMaterial: "metal", roofProfile: "agpanel", wallHeightFt: 8 }),
  metalSS: style({ roof: ROOF, roofMaterial: "metal", roofProfile: "standingseam", wallHeightFt: 8 }),
  shingleSS: style({ roof: ROOF, roofMaterial: "shingle", roofProfile: "standingseam", wallHeightFt: 8 }),
  raised: style({ roof: ROOF, wallHeightFt: 8, foundation: "blocks", floorHeightFt: 1.1, roofProfile: "standingseam" }),
};

// ── d3CustomerRoofProfile ──────────────────────────────────────────────────────────────────────
Deno.test("d3CustomerRoofProfile: a real id on a Metal roof, else null", () => {
  for (const v of ["standingseam", "Standing Seam", " STANDING-SEAM ", "standing_seam"]) {
    assertStrictEquals(F.d3CustomerRoofProfile({ roofType: "Metal", roofProfile: v }), "standingseam", JSON.stringify(v));
  }
  for (const v of ["agpanel", "AG Panel", "ag-panel"]) assertStrictEquals(F.d3CustomerRoofProfile({ roofType: "Metal", roofProfile: v }), "agpanel", JSON.stringify(v));
  // Not a pick: nothing, empty, junk. Junk is null, never AG Panel, so it cannot override the style.
  for (const v of [undefined, null, "", "  ", "metal", "seam", "agpanelx", 3, true, {}]) {
    assertStrictEquals(F.d3CustomerRoofProfile({ roofType: "Metal", roofProfile: v }), null, JSON.stringify(v));
  }
  // Not a Metal roof: the pick is ignored (and kept on sel, so switching back finds it again).
  for (const t of ["Shingle", "", undefined, "metal", "METAL"]) {
    assertStrictEquals(F.d3CustomerRoofProfile({ roofType: t, roofProfile: "standingseam" }), null, String(t));
  }
  for (const s of [null, undefined]) assertStrictEquals(F.d3CustomerRoofProfile(s), null);
});

// ── d3ResolveStyleSpec's 8th argument ──────────────────────────────────────────────────────────
Deno.test("⚠️ without the pick the resolver returns exactly what it always did", () => {
  for (const [k, s] of Object.entries(STYLES)) {
    for (const override of [null, "lap", "agpanel"]) {
      const was = JSON.stringify(F.d3ResolveStyleSpec(s, s.value, 8, override, 0, null, null));
      for (const none of [undefined, null, "", "Standing Seam", "nonsense", "metal"]) {
        assertEquals(JSON.stringify(F.d3ResolveStyleSpec(s, s.value, 8, override, 0, null, null, none)), was, `${k} / ${override} / ${JSON.stringify(none)}`);
      }
    }
    // The three-argument call openCalEditor makes: the style's own value, or null.
    const seed = F.d3ResolveStyleSpec(s, s.value, 8);
    assertEquals(seed.roofProfile, s.d3.roofProfile === "agpanel" || s.d3.roofProfile === "standingseam" ? s.d3.roofProfile : null, k);
  }
});

Deno.test("the design's pick wins over its style's, in both directions, and moves nothing else", () => {
  for (const [k, s] of Object.entries(STYLES)) {
    const was = F.d3ResolveStyleSpec(s, s.value, 8, null, 0, "piers", null);
    for (const pick of ["agpanel", "standingseam"]) {
      const now = F.d3ResolveStyleSpec(s, s.value, 8, null, 0, "piers", null, pick);
      assertEquals(now.roofProfile, pick, `${k} picked ${pick}`);
      assertEquals(JSON.stringify({ ...now, roofProfile: was.roofProfile }), JSON.stringify(was), `${k}: only roofProfile moved`);
    }
  }
  // What the renderer then draws on a metal roof: Standing Seam's 6 ft pans over an AG Panel style,
  // and AG Panel's 3 ft sheet over a Standing Seam style.
  assertEquals(drawn(F.d3ResolveStyleSpec(STYLES.metalAG, "deluxe", 8, null, 0, null, null, "standingseam")).tileFtU, 6);
  assertEquals(drawn(F.d3ResolveStyleSpec(STYLES.metalSS, "deluxe", 8, null, 0, null, null, "agpanel")).tileFtU, 3);
  assertEquals(drawn(F.d3ResolveStyleSpec(STYLES.metalSS, "deluxe", 8, null, 0, null, null)).tileFtU, 6, "no pick: the style's own");
  assertEquals(drawn(F.d3ResolveStyleSpec(STYLES.metalAG, "deluxe", 8, null, 0, null, null)).tileFtU, 3, "no pick: AG Panel");
});

Deno.test("end to end, as the designer calls it: sel → d3CustomerRoofProfile → resolver → the profile drawn", () => {
  const spec = (sel: Any, s: Any) => F.d3ResolveStyleSpec(s, s.value, 8, null, 0, null, null, F.d3CustomerRoofProfile(sel));
  assertEquals(drawn(spec({ roofType: "Metal", roofProfile: "standingseam" }, STYLES.metalAG)).id, "standingseam");
  assertEquals(drawn(spec({ roofType: "Metal", roofProfile: "agpanel" }, STYLES.metalSS)).id, "agpanel");
  // A Shingle or empty roof type ignores the pick: the style's own stands (the renderer draws shingle
  // for a Shingle pick anyway; an empty type falls back to the style's material, and its profile).
  assertEquals(spec({ roofType: "Shingle", roofProfile: "agpanel" }, STYLES.metalSS).roofProfile, "standingseam");
  assertEquals(spec({ roofType: "", roofProfile: "standingseam" }, STYLES.metalAG).roofProfile, null);
  // An invalid string is ignored the same way.
  assertEquals(spec({ roofType: "Metal", roofProfile: "shiny" }, STYLES.metalSS).roofProfile, "standingseam");
  assertEquals(spec({ roofType: "Metal", roofProfile: "shiny" }, STYLES.metalAG).roofProfile, null);
});

// ── Who passes it, in both twins ───────────────────────────────────────────────────────────────
const CUSTOMER_CALL = "d3ResolveStyleSpec(selectedStyle, sel.style, C.wallHeightFt, d3SidingOverride(C, sel), d3CustomerWallHeightFt(C, selectedStyle, sel.style, sel, bldgW), d3CustomerFoundation(C, sel), d3CladdingExposureIn(C, sel), d3CustomerRoofProfile(sel))";

Deno.test("⚠️ exactly the five customer-facing calls pass the pick; the calibration seeds and reflowItems never do", () => {
  for (const [file, src] of TWINS) {
    assertEquals(src.split(CUSTOMER_CALL).length - 1, 5, `${file}: the vent placement, the quote's off-screen shots, the dormer-window gate, the docked 3D and the full-screen viewer`);
    // Every resolver CALL (not its definition), by the arguments it opens with.
    const calls = [...src.matchAll(/(?<!function )d3ResolveStyleSpec\(([^;\n]*)/g)].map((m) => m[1]);
    const withPick = calls.filter((c) => c.includes("d3CustomerRoofProfile"));
    assertEquals(withPick.length, 5, `${file}: ${withPick.length} calls pass the pick`);
    for (const c of withPick) assert(("d3ResolveStyleSpec(" + c).startsWith(CUSTOMER_CALL), `${file}: ${c.slice(0, 160)}`);
    // The others, named, so a new call has to be classified here before this passes. (The Advanced
    // page's two seeds share one statement, so the match for the first carries the second.)
    const others = calls.filter((c) => !c.includes("d3CustomerRoofProfile"));
    assertEquals(others.length, 3, `${file}: ${JSON.stringify(others.map((c) => c.slice(0, 60)))}`);
    // reflowItems: wall geometry only, the roof's metal is nothing to it.
    assert(others[0].startsWith("styleCfg, s.style, C.wallHeightFt, d3SidingOverride(C, s), "), `${file}: ${others[0].slice(0, 80)}`);
    // openCalEditor: its object is posted back AS THE STYLE.
    assertEquals(others[1], "s, s.value, C.wallHeightFt)", `${file}: openCalEditor`);
    // The Advanced page's "Start from" seed and its blank building: saved as a style too.
    assertEquals(others[2], 's, s.value, C.wallHeightFt || 8) : d3ResolveStyleSpec(null, "", C.wallHeightFt || 8)', `${file}: the Advanced seeds`);
    // openCalEditor's call, exactly (claddingExposure_test pins it the same way).
    assert(src.includes("const openCalEditor = (s) => {\n    setAdminCalMsg(null);\n    setAdminCalPreview(false);\n    const spec = d3ResolveStyleSpec(s, s.value, C.wallHeightFt);\n"),
      `${file}: openCalEditor's call moved — re-check that it does not pass the pick`);
  }
});

Deno.test("the renderer still reads the profile from styleSpec alone, through the normaliser", () => {
  const LINE = "const roofProfile = roofIsMetal ? D3_METAL_ROOF_PROFILES[d3NormalizeRoofProfile(p.styleSpec && p.styleSpec.roofProfile)] : null;";
  for (const [file, src] of TWINS) {
    const model = lift(src, file, "function buildShed3DModel(", "function d3UnbindFixtureMats(");
    assertEquals(model.split(LINE).length - 1, 1, `${file}: one profile line`);
    assert(!model.includes("roofProfile: ") && !model.includes("sel.roofProfile"), `${file}: the model reads no pick of its own`);
  }
});

// ── The rest of the designer's side, statically ────────────────────────────────────────────────
Deno.test("the sel literals, the submit body and the Roof options card", () => {
  for (const [file, src] of TWINS) {
    // The three sel literals: the initial state, a design load and a version load.
    assertEquals(src.split('{ style: "", size: "", roofType: "", roofColor: "", roofProfile: "", cladding: "" }').length - 1, 3, `${file}: sel literals`);
    assertEquals(src.split('{ style: "", size: "", roofType: "", roofColor: "", cladding: "" }').length - 1, 0, `${file}: an old literal left`);
    // The submit body names the key whenever it names the roof, so "" is a real clear.
    assertEquals(src.split('{ roofType: sel.roofType || "", roofColor: sel.roofColor || "", roofProfile: sel.roofProfile || "" }').length - 1, 1, `${file}: submit body`);
    // The Profile select: in the portal only, on a Metal roof only, and the card counts it.
    assertEquals(src.split('const ssRoofProfileShown = embedded && roofTypes.length > 0 && sel.roofType === "Metal";').length - 1, 1, `${file}: the gate`);
    assert(src.includes('roofTypes.length > 0 ? (ssRoofProfileShown ? 3 : 2) : 0'), `${file}: the fit key counts the third field`);
    assert(src.includes('<div className="ssd-card" style={{ "--ssd-n": ssRoofProfileShown ? "3" : "2" }}>'), `${file}: the card's field count`);
    const card = lift(src, file, "{ssRoofProfileShown && (", '<span className="ssd-fld-l"><span className="ssd-sr">Roof </span>Color</span>');
    assert(card.includes('onChange={(e) => setSel((p) => ({ ...p, roofProfile: e.target.value }))}'), `${file}: the pick is written verbatim`);
    assert(card.includes('<option value="agpanel">AG Panel</option>') && card.includes('<option value="standingseam">Standing Seam</option>'), `${file}: options`);
    // onRoofType does not clear the pick: switching to Shingle and back keeps it.
    const onRoofType = lift(src, file, "const onRoofType = (type) => {", "const onRoofColor = ");
    assert(!onRoofType.includes("roofProfile"), `${file}: onRoofType leaves the pick alone`);
    // The plan's summary bullet.
    assert(src.includes('bullets.push(`Roof — ${sel.roofType}${roofStd ? " (Standing Seam)" : ""}${sel.roofColor ? `: ${sel.roofColor}` : ""}`);'), `${file}: summary bullet`);
    // Settings: relabelled as the style's default, storing exactly what it stored.
    assert(src.includes(">Default metal roof profile\n"), `${file}: the calibration label`);
    assert(src.includes('label: "Default metal profile"'), `${file}: the Advanced label`);
    assertEquals(src.split('calSet({ roofProfile: e.target.value === "standingseam" ? "standingseam" : null })').length - 1, 1, `${file}: calibration stores what it stored`);
    assertEquals(src.split('calSet({ roofProfile: v === "standingseam" ? "standingseam" : null })').length - 1, 1, `${file}: Advanced stores what it stored`);
  }
});

// ── computeSelectionRows: the Details panel's Roof row is the quote's ──────────────────────────
const D = designer();
const C = (styleD3: Any): Any => ({
  showPricing: true, options: [],
  sizePricing: { deluxe: { "10x12": { basePrice: 9000, widthFt: 10, lengthFt: 12 } } },
  buildingStyles: [{ value: "deluxe", label: "Deluxe Gable", d3: styleD3 }],
  colors: [
    { id: "m1", label: "Black", rate: 2.5, pricingMethod: "sqft_building", metal: true },
    { id: "m2", label: "Galvalume", rate: 0, metal: true },
    { id: "s1", label: "Weathered Wood", rate: 150, pricingMethod: "each", shingle: true },
  ],
});
const roofRow = (sel: Any, styleD3: Any) => D.computeSelectionRows({ style: "deluxe", size: "10x12", ...sel }, {}, C(styleD3), []).find((r: Any) => r.key === "roof");

Deno.test("computeSelectionRows: the Roof row's words are roofLineDesc's, and the amount never moves", () => {
  const types: Array<[string, string]> = [["Metal", "Black"], ["Metal", "Galvalume"], ["Metal", ""], ["Shingle", "Weathered Wood"], ["", ""]];
  const picks = [undefined, "", "agpanel", "standingseam", "Standing Seam", "shiny"];
  const d3s = [{}, { roofProfile: "standingseam" }, { roofProfile: "agpanel" }, null];
  for (const [t, c] of types) {
    const plain = roofRow({ roofType: t, roofColor: c }, {});
    for (const pick of picks) {
      for (const d3 of d3s) {
        const row = roofRow({ roofType: t, roofColor: c, roofProfile: pick }, d3);
        const what = JSON.stringify([t, c, pick, d3]);
        assertEquals(row.detail, roofLineDesc(t, c, effectiveRoofProfile(pick, d3)), what);
        assertEquals(row.total, plain.total, `${what}: the amount`);
      }
    }
  }
  assertEquals(roofRow({ roofType: "Metal", roofColor: "Black", roofProfile: "standingseam" }, {}).detail, "Metal (Standing Seam) — Black");
  assertEquals(roofRow({ roofType: "Metal", roofColor: "Black", roofProfile: "standingseam" }, {}).total, 300);
  assertEquals(roofRow({ roofType: "Metal", roofColor: "Black" }, {}).detail, "Metal — Black", "every design today");
});
