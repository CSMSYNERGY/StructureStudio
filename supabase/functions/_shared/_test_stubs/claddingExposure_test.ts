// A BUILDER'S OWN LAP COURSE (migration 275, 2026-10-05), tested against BOTH SHIPPED designer twins.
//
// A builder, on the portal: "I will need an option for 4.5" vinyl siding". Their lap row already sells
// it, renamed; what was wrong was the look, because every lap wall was drawn in D3_CLADDING's 6 in
// courses. Now style_cladding.exposure_in reaches the designer as the cladding entry's exposureIn, and:
//
//   · d3CladdingExposureIn(C, sel) reads it for the customer's LAP pick only (resolveCladding, the
//     pricing lookup), held to 3..12 in, else null;
//   · d3ResolveStyleSpec takes it as a NEW 7TH argument and names spec.sidingExposureIn only when it
//     is given and the siding is lap. Every call that does not pass it, above all openCalEditor's,
//     whose result the calibration panel posts back AS THE STYLE, gets exactly the object it always
//     got, so a customer's pick can never be frozen into building_styles.d3;
//   · the five customer-facing calls pass it, and only they do (the customerFoundation pattern);
//   · d3CladdingFor(siding, exposureIn) is what the renderer's clad line reads: the D3_CLADDING entry
//     ITSELF in every case but a valid lap size, and then lap with stepFt and tileFtV scaled together.
//
// AND THE LAP RENAMED, VINYL ADDED (2026-10-06, Carolyn's Q20 answers): the built-in lap is called
// 7" LP Lap Siding and draws EXACTLY as it did ("keep its profile, treating the current lap as 7""),
// and a fifth id, "vinyl" (4.5" Vinyl Siding), draws lap's profile at 4.5/7 of its course. The 275
// course size moved onto the same nominal scale (D3_LAP_NOMINAL_IN = 7): blank or 7 is lap's own
// drawing, 4.5 is vinyl's, bit for bit. Vinyl takes no size.
//
// Lifted by stable anchors (the raisedFloor_test technique), each region asserted byte-identical in the
// two hand-mirrored twins. The meshes (the course count on a real wall) are checked in
// tests/harness/lapCourses.mjs.

import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `claddingExposure_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  // What the resolver needs (customerFoundation_test's list).
  ["const D3 = {", "// The casing reveal every opening"],
  ["const D3_STYLE_DEFAULTS = {", "// ── CLADDING ──"],
  ["const D3_FOUNDATIONS = [", "// How much further down the ground is than it has always been"],
  ["const D3_GRADE_FALL_TOWARD = [", "// { fallFt, toward }"],
  ["const D3_GRADE_CORNERS = [", "// THE GROUND UNDER THE FOUR CORNERS"],
  ["const FOUNDATION_ITEM_LABEL = {", "function foundationLabelOf("],
  // The five claddings, D3_LAP_NOMINAL_IN, the normaliser and d3CladdingFor.
  ["const D3_CLADDING = {", "// ── METAL ROOF PROFILE"],
  // The builder's offered list and the pricing lookup d3CladdingExposureIn reads.
  ["function claddingOptionsFor(", "function resolveWallHeight("],
  // The resolver, d3SidingOverride and d3CladdingExposureIn.
  ["function d3ResolveStyleSpec(", "// THE CUSTOMER'S PIERS, DRAWN"],
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
  `${blocks.map((b) => b.cmp).join("\n")}; return { D3_CLADDING, D3_LAP_NOMINAL_IN, d3NormalizeCladding, d3CladdingFor, d3CladdingExposureIn, d3ResolveStyleSpec, d3SidingOverride, claddingOptionsFor };`,
)() as Record<string, Any>;
const LAP = F.D3_CLADDING.lap;
const VINYL = F.D3_CLADDING.vinyl;
const LAP_COPY = JSON.stringify(LAP);
const GEOMETRY = (c: Any) => ({ tex: c.tex, relief: c.relief, stepFt: c.stepFt, tileFtU: c.tileFtU, tileFtV: c.tileFtV, bump: c.bump });
const STYLE_PLAIN = { value: "deluxe", label: "Deluxe Gable", d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, wallHeightFt: 7 } };

// ── The rename and the fifth cladding (2026-10-06) ──────────────────────────────────────────────
Deno.test("\"keep its profile\": lap is renamed 7\" LP Lap Siding and draws exactly what it always drew", () => {
  assertEquals(LAP.label, '7" LP Lap Siding');
  assertEquals(LAP.id, "lap");
  // The numbers every lap wall was drawn with before the rename (ea0a0de0), pinned.
  assertEquals(GEOMETRY(LAP), { tex: "lap", relief: "lap", stepFt: 0.5, tileFtU: 8, tileFtV: 4, bump: 0.45 });
  assertEquals(Object.keys(LAP).sort(), ["bump", "id", "label", "relief", "stepFt", "tex", "tileFtU", "tileFtV"]);
  // ASCII quote, never the inch prime: the quote PDF's standard fonts are WinAnsi only.
  for (const c of Object.values(F.D3_CLADDING) as Any[]) assert(/^[\x20-\x7e]+$/.test(c.label), `${c.id}: ${c.label}`);
});

Deno.test("4.5\" Vinyl Siding: lap's profile at 4.5/7 of lap's course, bit for bit what a 4.5 lap size draws", () => {
  assertEquals([VINYL.id, VINYL.label], ["vinyl", '4.5" Vinyl Siding']);
  assertStrictEquals(VINYL.stepFt, 0.32142857142857145);
  assertStrictEquals(VINYL.tileFtV, 2.5714285714285716);
  assertStrictEquals(VINYL.tileFtV / VINYL.stepFt, 8, "8 boards a tile, as lap: the raster lands on the relief courses");
  const { id: _i, label: _l, ...vinylRest } = VINYL;
  const { id: _i2, label: _l2, ...sizedRest } = F.d3CladdingFor("lap", 4.5);
  assertEquals(vinylRest, sizedRest, "the same object as lap at 4.5, apart from id and label");
  for (const k of ["stepFt", "tileFtV"]) assertStrictEquals(VINYL[k], F.d3CladdingFor("lap", 4.5)[k], `${k}, bit for bit`);
  assertEquals([VINYL.tex, VINYL.relief, VINYL.tileFtU, VINYL.bump], [LAP.tex, LAP.relief, LAP.tileFtU, LAP.bump], "the same profile");
  assertEquals(F.D3_LAP_NOMINAL_IN, 7);
  assertEquals(Object.keys(F.D3_CLADDING), ["lap", "vinyl", "panel", "agpanel", "batten"], "five ids, vinyl right after lap");
});

Deno.test("vinyl is its own id end to end: the normaliser, the override, the resolver, the renderer's lookup", () => {
  for (const v of ["vinyl", " Vinyl ", "VINYL"]) assertEquals(F.d3NormalizeCladding(v), "vinyl", JSON.stringify(v));
  // Nothing else turns into vinyl.
  for (const v of ["vinylsiding", "vinyl-lap", "4.5 vinyl"]) assertEquals(F.d3NormalizeCladding(v), "panel", JSON.stringify(v));
  // A size never reaches it: vinyl is fixed at 4.5, its name says so.
  for (const ex of [undefined, null, "", 4.5, 3, 7, 12, "abc"]) {
    assertStrictEquals(F.d3CladdingFor("vinyl", ex), VINYL, `vinyl with ${JSON.stringify(ex)}`);
  }
  const cfg = { claddingOptions: { deluxe: [
    { id: "lap", label: null, rate: 0, charged: false, exposureIn: 4.5 },
    { id: "vinyl", label: null, rate: 2, charged: true },
  ] } };
  const sel = { style: "deluxe", cladding: "vinyl" };
  assertEquals(F.d3SidingOverride(cfg, sel), "vinyl");
  assertStrictEquals(F.d3CladdingExposureIn(cfg, sel), null, "the lap row's size is the lap's, never the vinyl's");
  const spec = F.d3ResolveStyleSpec(STYLE_PLAIN, sel.style, 8, F.d3SidingOverride(cfg, sel), 0, null, F.d3CladdingExposureIn(cfg, sel));
  assertEquals(spec.siding, "vinyl");
  assert(!("sidingExposureIn" in spec), "no size is named for vinyl");
  // Even if a size were handed in, the resolver names it on lap only.
  assert(!("sidingExposureIn" in F.d3ResolveStyleSpec(STYLE_PLAIN, sel.style, 8, "vinyl", 0, null, 4.5)));
  assertStrictEquals(F.d3CladdingFor(spec.siding, spec.sidingExposureIn), VINYL);
});

Deno.test("claddingOptionsFor keeps a vinyl entry and still drops an id we ship nothing for", () => {
  const C = { claddingOptions: { deluxe: [
    { id: "panel", label: null }, { id: "vinyl", label: null }, { id: "barn", label: "Barn Siding" }, { id: "lap", label: null },
  ] } };
  assertEquals(F.claddingOptionsFor(C, "deluxe", false).map((o: Any) => o.id), ["panel", "vinyl", "lap"]);
});

// ── d3CladdingFor ──────────────────────────────────────────────────────────────────────────────
Deno.test("d3CladdingFor: no size means the D3_CLADDING entry itself, by identity", () => {
  for (const ex of [undefined, null, ""]) {
    assertStrictEquals(F.d3CladdingFor("lap", ex), LAP, `lap with ${String(ex)}`);
    assertStrictEquals(F.d3CladdingFor("panel", ex), F.D3_CLADDING.panel);
    assertStrictEquals(F.d3CladdingFor("batten", ex), F.D3_CLADDING.batten);
    assertStrictEquals(F.d3CladdingFor("agpanel", ex), F.D3_CLADDING.agpanel);
  }
  // The renderer's old line read D3_CLADDING[d3NormalizeCladding(siding)] || panel: every siding a
  // style can hold resolves to the entry it always did.
  for (const s of [null, undefined, "", "groove", "t111", "nonsense", "Lap", "lapsiding", "board-and-batten", "metal", "PANEL", "vinyl", " Vinyl "]) {
    const old = F.D3_CLADDING[["lap", "lapsiding", "lap-siding"].includes(String(s ?? "").trim().toLowerCase()) ? "lap"
      : String(s ?? "").trim().toLowerCase() === "vinyl" ? "vinyl"
      : ["batten", "board-and-batten", "bnb"].includes(String(s ?? "").trim().toLowerCase()) ? "batten"
      : ["agpanel", "ag", "metal", "panel-loc", "panelloc"].includes(String(s ?? "").trim().toLowerCase()) ? "agpanel" : "panel"];
    assertStrictEquals(F.d3CladdingFor(s, null), old, String(s));
  }
});

Deno.test("d3CladdingFor: a lap size is on the nominal scale, where 7 is lap's own drawing and 4.5 is vinyl's", () => {
  const c = F.d3CladdingFor("lap", 4.5);
  // 4.5/7 of lap's 0.5 ft course and 4 ft tile (it was 0.375 and 3, true inches, before 2026-10-06).
  assertStrictEquals(c.stepFt, 0.5 * 4.5 / 7);
  assertStrictEquals(c.tileFtV, 4.0 * 4.5 / 7);
  assertEquals(c.tileFtV / c.stepFt, LAP.tileFtV / LAP.stepFt, "the raster's boards land on the relief courses");
  const { stepFt: _s, tileFtV: _t, ...rest } = c;
  const { stepFt: _s0, tileFtV: _t0, ...lapRest } = LAP;
  assertEquals(rest, lapRest, "nothing else about lap changes: id, name, texture, relief, tile width, bump");
  assertEquals(JSON.stringify(LAP), LAP_COPY, "D3_CLADDING.lap itself is never written to");
  // A string from the config, and the ends of the range: 0.5 x n / 7.
  assertStrictEquals(F.d3CladdingFor("lap", "4.5").stepFt, 0.5 * 4.5 / 7);
  assertStrictEquals(F.d3CladdingFor("lap", 3).stepFt, 0.5 * 3 / 7);
  assertStrictEquals(F.d3CladdingFor("lap", 12).stepFt, 0.5 * 12 / 7);
  assertStrictEquals(F.d3CladdingFor("lap", 12).tileFtV, 4.0 * 12 / 7);
  // 7 in is lap's own numbers, exactly (a fresh object, but the same drawing): a builder who types
  // the size in its name draws what blank draws.
  assertEquals(F.d3CladdingFor("lap", 7), LAP);
  assertStrictEquals(F.d3CladdingFor("lap", 7).stepFt, 0.5);
  assertStrictEquals(F.d3CladdingFor("lap", 7).tileFtV, 4);
  // 6, which was lap's own before the scale moved, is now 6/7 of it.
  assertStrictEquals(F.d3CladdingFor("lap", 6).stepFt, 0.5 * 6 / 7);
});

Deno.test("d3CladdingFor: a size never touches any other cladding, and a size out of range is ignored", () => {
  for (const id of ["panel", "batten", "agpanel", "vinyl"]) {
    for (const ex of [3, 4.5, 6, 12]) assertStrictEquals(F.d3CladdingFor(id, ex), F.D3_CLADDING[id], `${id} at ${ex}`);
  }
  for (const ex of [0, 2.99, 12.01, 20, -4.5, NaN, Infinity, "abc", true, {}, []]) {
    assertStrictEquals(F.d3CladdingFor("lap", ex), LAP, `lap with ${JSON.stringify(ex)}`);
  }
});

// ── d3CladdingExposureIn ───────────────────────────────────────────────────────────────────────
const C = (list: Any[]) => ({ claddingOptions: { deluxe: list, utility: [{ id: "lap", label: null, rate: 0, charged: false }] } });
const DELUXE = [
  { id: "panel", label: null, rate: 0, charged: false },
  { id: "lap", label: "Vinyl Siding", rate: 0, charged: false, exposureIn: 4.5 },
];

Deno.test("d3CladdingExposureIn: the builder's size for the customer's lap pick", () => {
  assertStrictEquals(F.d3CladdingExposureIn(C(DELUXE), { style: "deluxe", cladding: "lap" }), 4.5);
  // An internal-only lap row a rep picked draws the size it prices at (resolveCladding includes it).
  assertStrictEquals(F.d3CladdingExposureIn(C([{ ...DELUXE[1], internalOnly: true }]), { style: "deluxe", cladding: "lap" }), 4.5);
  // jsonb numeric arrives as a number, but a string must not change the answer's type.
  assertStrictEquals(F.d3CladdingExposureIn(C([{ ...DELUXE[1], exposureIn: "5" }]), { style: "deluxe", cladding: "lap" }), 5);
  assertStrictEquals(F.d3CladdingExposureIn(C([{ ...DELUXE[1], exposureIn: 3 }]), { style: "deluxe", cladding: "lap" }), 3);
  assertStrictEquals(F.d3CladdingExposureIn(C([{ ...DELUXE[1], exposureIn: 12 }]), { style: "deluxe", cladding: "lap" }), 12);
});

Deno.test("d3CladdingExposureIn: null for everything else", () => {
  const cases: Array<[string, Any, Any]> = [
    ["no config", null, { style: "deluxe", cladding: "lap" }],
    ["no selections", C(DELUXE), null],
    ["no cladding picked (the builder's standard)", C(DELUXE), { style: "deluxe" }],
    ["panel picked", C(DELUXE), { style: "deluxe", cladding: "panel" }],
    ["vinyl picked (it takes no size)", C([...DELUXE, { id: "vinyl", label: null, rate: 0, charged: false, exposureIn: 4.5 }]), { style: "deluxe", cladding: "vinyl" }],
    ["a lap row with no size", C(DELUXE), { style: "utility", cladding: "lap" }],
    ["a style without the row", C(DELUXE), { style: "other", cladding: "lap" }],
    ["no claddingOptions at all (a config from before 207)", {}, { style: "deluxe", cladding: "lap" }],
    ["a size below 3", C([{ ...DELUXE[1], exposureIn: 2 }]), { style: "deluxe", cladding: "lap" }],
    ["a size above 12", C([{ ...DELUXE[1], exposureIn: 13 }]), { style: "deluxe", cladding: "lap" }],
    ["a size that is not a number", C([{ ...DELUXE[1], exposureIn: "wide" }]), { style: "deluxe", cladding: "lap" }],
    ["a null size", C([{ ...DELUXE[1], exposureIn: null }]), { style: "deluxe", cladding: "lap" }],
    ["an empty size", C([{ ...DELUXE[1], exposureIn: "" }]), { style: "deluxe", cladding: "lap" }],
    // The legacy "Siding" option path of d3SidingOverride draws lap with no row to read a size from.
    ["the legacy siding option", C(DELUXE), { style: "deluxe", Siding: "Lap Siding" }],
  ];
  for (const [what, cfg, sel] of cases) assertStrictEquals(F.d3CladdingExposureIn(cfg, sel), null, what);
});

// ── d3ResolveStyleSpec's 7th argument ──────────────────────────────────────────────────────────
const ROOF = { type: "gable", pitch: 0.4, overhang: 0.6 };
const style = (d3: Any) => ({ value: "deluxe", label: "Deluxe Gable", d3 });
const STYLES: Record<string, Any> = {
  plain: style({ roof: ROOF, wallHeightFt: 7 }),
  batten: style({ roof: ROOF, siding: "batten", wallHeightFt: 8, colors: { body: "#cccccc" } }),
  ownLap: style({ roof: ROOF, siding: "lap", wallHeightFt: 8 }),
  raised: style({ roof: ROOF, wallHeightFt: 8, foundation: "blocks", floorHeightFt: 1.1 }),
};

Deno.test("⚠️ without the size the resolver returns exactly what it always did", () => {
  for (const [k, s] of Object.entries(STYLES)) {
    for (const override of [null, "lap", "panel", "agpanel"]) {
      const was = JSON.stringify(F.d3ResolveStyleSpec(s, s.value, 8, override, 0, null));
      for (const ex of [undefined, null]) {
        assertEquals(JSON.stringify(F.d3ResolveStyleSpec(s, s.value, 8, override, 0, null, ex)), was, `${k} / ${override} / ${String(ex)}`);
      }
    }
    // The three-argument call openCalEditor makes, and the call with every trailing argument unset.
    assertEquals(JSON.stringify(F.d3ResolveStyleSpec(s, s.value, 8)), JSON.stringify(F.d3ResolveStyleSpec(s, s.value, 8, undefined, undefined, undefined, undefined)));
    assert(!("sidingExposureIn" in F.d3ResolveStyleSpec(s, s.value, 8)), `${k}: openCalEditor's object never carries it`);
  }
});

Deno.test("the customer's lap with a size: spec.sidingExposureIn, appended, nothing else moves", () => {
  for (const [k, s] of Object.entries(STYLES)) {
    const was = F.d3ResolveStyleSpec(s, s.value, 8, "lap", 0, null);
    const now = F.d3ResolveStyleSpec(s, s.value, 8, "lap", 0, null, 4.5);
    assertEquals(now.sidingExposureIn, 4.5, k);
    // Appended last, so the docked panel's geomSig (the whole object, stringified) moves only by it.
    assertEquals(Object.keys(now).slice(-1)[0], "sidingExposureIn", k);
    const { sidingExposureIn: _x, ...rest } = now;
    assertEquals(JSON.stringify(rest), JSON.stringify(was), k);
    // With the customer's piers too: the two trailing picks compose.
    const both = F.d3ResolveStyleSpec(s, s.value, 8, "lap", 0, "piers", 4.5);
    assertEquals([both.foundation, both.sidingExposureIn], ["piers", 4.5], k);
  }
  // A style whose own siding is lap, with no override: lap, so the size applies (only a customer
  // call can pass it, and d3CladdingExposureIn answers null without a lap pick anyway).
  assertEquals(F.d3ResolveStyleSpec(STYLES.ownLap, "deluxe", 8, null, 0, null, 4.5).sidingExposureIn, 4.5);
});

Deno.test("a size with any siding but lap is never named", () => {
  for (const [k, s] of Object.entries(STYLES)) {
    for (const override of [null, "panel", "batten", "agpanel"]) {
      if (k === "ownLap" && override === null) continue;
      const spec = F.d3ResolveStyleSpec(s, s.value, 8, override, 0, null, 4.5);
      assert(!("sidingExposureIn" in spec), `${k} / ${override}`);
    }
  }
});

Deno.test("end to end, as the designer calls it: config row → selection → resolver → the cladding drawn", () => {
  const cfg = C(DELUXE);
  const sel = { style: "deluxe", cladding: "lap" };
  const spec = F.d3ResolveStyleSpec(STYLES.plain, sel.style, 8, F.d3SidingOverride(cfg, sel), 0, null, F.d3CladdingExposureIn(cfg, sel));
  const drawn = F.d3CladdingFor(spec.siding, spec.sidingExposureIn);
  assertEquals([spec.siding, drawn.stepFt, drawn.tileFtV], ["lap", VINYL.stepFt, VINYL.tileFtV], "a lap row at 4.5 draws vinyl's courses");
  // The customer switches to panel: the size goes with the lap.
  const sel2 = { style: "deluxe", cladding: "panel" };
  const spec2 = F.d3ResolveStyleSpec(STYLES.plain, sel2.style, 8, F.d3SidingOverride(cfg, sel2), 0, null, F.d3CladdingExposureIn(cfg, sel2));
  assertStrictEquals(F.d3CladdingFor(spec2.siding, spec2.sidingExposureIn), F.D3_CLADDING.panel);
  assert(!("sidingExposureIn" in spec2));
});

// ── Who passes it, in both twins ───────────────────────────────────────────────────────────────
// The design's metal roof profile follows it as the 8th argument since 2026-10-06 (roofProfilePick_test).
const CUSTOMER_CALL = "d3ResolveStyleSpec(selectedStyle, sel.style, C.wallHeightFt, d3SidingOverride(C, sel), d3CustomerWallHeightFt(C, selectedStyle, sel.style, sel, bldgW), d3CustomerFoundation(C, sel), d3CladdingExposureIn(C, sel), d3CustomerRoofProfile(sel))";

Deno.test("the five customer-facing calls pass it, and nothing else does", () => {
  for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]]) {
    assertEquals(src.split(CUSTOMER_CALL).length - 1, 5, `${file}: the docked 3D, the full-screen viewer, the quote's off-screen shots, the vent placement and the dormer-window gate`);
    // Every other use of d3CladdingExposureIn( is its own definition and the comments naming it.
    const uses = [...src.matchAll(/d3CladdingExposureIn\(C, sel\)/g)].length;
    assertEquals(uses, 5, `${file}: no other call site reads the size`);
    // openCalEditor resolves the style with three arguments, so the panel can never save a size.
    assert(src.includes("const openCalEditor = (s) => {\n    setAdminCalMsg(null);\n    setAdminCalPreview(false);\n    const spec = d3ResolveStyleSpec(s, s.value, C.wallHeightFt);\n"),
      `${file}: openCalEditor's call moved — re-check that it does not pass the size`);
    // Every resolver CALL (not its definition) that carries a size is the customer call.
    const calls = [...src.matchAll(/(?<!function )d3ResolveStyleSpec\(([^;\n]*)/g)].map((m) => m[0]).filter((c) => /d3CladdingExposureIn|sidingExposureIn\)/.test(c));
    assertEquals(calls.length, 5, `${file}: ${calls.length} sized calls`);
    for (const c of calls) assert(c.startsWith(CUSTOMER_CALL), `${file}: ${c.slice(0, 160)}`);
  }
});

Deno.test("the renderer's clad line reads d3CladdingFor with the resolved size", () => {
  const CLAD = "const clad = d3CladdingFor(p.styleSpec && p.styleSpec.siding, p.styleSpec && p.styleSpec.sidingExposureIn);";
  for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]]) {
    const model = lift(src, file, "function buildShed3DModel(", "function d3UnbindFixtureMats(");
    assertEquals(model.split(CLAD).length - 1, 1, `${file}: one clad line, through d3CladdingFor`);
    assert(!/D3_CLADDING\[d3NormalizeCladding\(/.test(model), `${file}: no second lookup that would bypass the size`);
    // Every course in the model is stepped by clad.stepFt (the walls, the gable caps, the wing
    // triangles), and the raster by clad.tileFtV: no literal 0.5 ft course anywhere.
    assert(model.includes("wallTex.repeat.set(1 / clad.tileFtU, 1 / clad.tileFtV);"), `${file}: the raster's repeat`);
    assertEquals([...model.matchAll(/for \(let y = clad\.stepFt; y < /g)].length, 3, `${file}: the three lap course loops`);
  }
});
