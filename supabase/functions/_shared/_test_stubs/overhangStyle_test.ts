// How an overhang is FRAMED — the derived default, and the one function both drawings read.
//
// WHAT IS BEING PINNED, and why it needed pinning. `roof.overhangStyle` chooses between an
// EXTENDED rafter tail (the whole rafter carried past the wall, a full-depth fascia hung off
// the deck edge) and a NOTCHED one (the tail cut back on its underside right up to the deck,
// closed by a level soffit). Carolyn drew both off paused walk-around frames on 2026-09-18.
//
// ABSENT means "derive it from the overhang, at half a foot, AT RENDER TIME". That makes the
// derived default the most dangerous kind of default there is — it changes what an existing
// style LOOKS like without anyone editing anything — so three things have to stay true and
// none of them was covered by a test that runs:
//
//   1. The threshold and the fallback order. One copy now (d3DefaultOverhangStyle in the two
//      hand-mirrored twins); a second copy in supabase/functions/_shared/styleD3.ts was DELETED
//      rather than mirrored, because two copies of a rule drift and only one of them ships.
//   2. The derived default must reach ONLY the renderer. Nothing may write it into a tenant's
//      stored column: not sanitizeD3Spec, not d3ResolveStyleSpec, not the AI draft, not the AR
//      scan. Store it once and raising the style's overhang stops re-framing its eave.
//   3. It must not touch an OPEN eave. Those rafter tails were MEASURED off Junior Barns'
//      Urban at a 1.0 ft overhang (3.5 in drop, 1.5 in stock; work log 2026-08-21), and the
//      first cut of the notch tied them to the derived flag — which would have halved the
//      exposed tails of every shipped open-eave style with nobody touching a setting.
//
// HOW, given the rules live in a browser file. The same slice-and-run idiom shedProfile_test,
// ventGable_test and porchGeom_test already use here: the shipped text is LIFTED between stable
// anchors and executed. Nothing is copied out, so nothing can drift. Both twins are lifted and
// asserted byte-identical, and the logic is exercised from the COMPONENT — the copy index.html
// actually serves.
//
// ⚠️ WHAT THIS DOES NOT PROVE. It does not render anything. Whether the soffit board really
// sits under the slab, and how far below the wall plate each eave finishes, are measured in the
// browser by tests/harness/overhangNotch.mjs, which needs a static server and is manual.

import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));
const STYLE_D3 = await Deno.readTextFile(new URL("../styleD3.ts", import.meta.url));

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `overhangStyle_test: could not find the block starting ${JSON.stringify(start)} in ${file} ` +
        `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
    );
  }
  return src.slice(i, j);
}

/** The same slice with every comment removed — these assertions are about CODE, and the
 *  comments in these very blocks discuss the thing being asserted absent. */
function codeOnly(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ");
}

const REGIONS: Array<[string, string]> = [
  // D3.ROOF_T (the deck) and D3.OVERHANG (the fallback size the default derives from).
  ["const D3 = {", "// The casing reveal every opening"],
  // d3DefaultOverhangStyle and d3OverhangStyle: the derived default and the explicit override.
  ["function d3DefaultOverhangStyle(", "// ── WHERE THE EAVE FINISH ENDS"],
  // D3_EAVE and d3EaveFinishDrop: the one answer both the 3D and the elevation drawing read.
  ["const D3_EAVE = {", "// ── THE PROJECTING PORCH'S NUMBERS"],
];
const blocks = REGIONS.map(([a, b]) => ({
  a,
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
  cmp: lift(CMP, "structure-studio.component.js", a, b),
}));

Deno.test("every lifted overhang region is byte-identical in the two twins", () => {
  for (const { a, jsx, cmp } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
const api: any = new Function(
  `${blocks.map((b) => b.cmp).join("\n")}\n` +
    "return { D3, D3_EAVE, d3DefaultOverhangStyle, d3OverhangStyle, d3EaveFinishDrop };",
)();

// ── 1. The derived default ────────────────────────────────────────────────────────────────
Deno.test("half a foot is the line, and the boundary itself is extended", () => {
  assertEquals(api.d3DefaultOverhangStyle({ overhang: 4 / 12 }), "extended");
  assertEquals(api.d3DefaultOverhangStyle({ overhang: 0.5 }), "extended", "0.5 ft exactly is NOT notched");
  assertEquals(api.d3DefaultOverhangStyle({ overhang: 0.51 }), "notched");
  assertEquals(api.d3DefaultOverhangStyle({ overhang: 1.0 }), "notched");
});

Deno.test("no overhang at all falls back to the renderer's own default size", () => {
  // D3.OVERHANG is 0.6, so a style that stores neither key still derives "notched".
  assertEquals(api.D3.OVERHANG, 0.6);
  assertEquals(api.d3DefaultOverhangStyle({}), api.D3.OVERHANG > 0.5 ? "notched" : "extended");
  assertEquals(api.d3DefaultOverhangStyle(null), api.d3DefaultOverhangStyle({}));
  assertEquals(api.d3DefaultOverhangStyle({ overhang: "nonsense" }), api.d3DefaultOverhangStyle({}));
});

Deno.test("an explicit pick beats the derived default, and only the two literals count", () => {
  assertEquals(api.d3OverhangStyle({ overhang: 1.0, overhangStyle: "extended" }), "extended");
  assertEquals(api.d3OverhangStyle({ overhang: 0.25, overhangStyle: "notched" }), "notched");
  // null is what the calibration panel stores when the builder picks the derived value, and
  // anything else is junk from an old row — both have to fall back rather than throw.
  assertEquals(api.d3OverhangStyle({ overhang: 1.0, overhangStyle: null }), "notched");
  assertEquals(api.d3OverhangStyle({ overhang: 0.25, overhangStyle: "NOTCHED" }), "extended");
});

// ── 2. The eave finish, as a RELATION rather than a number ────────────────────────────────
const NY = Math.cos(Math.atan(0.4));   // pitch 0.4, the built-in gable default

Deno.test("an OPEN eave ignores the framing entirely — the regression that shipped once", () => {
  for (const ov of [4 / 12, 1.0, 2.0]) {
    const derived = api.d3EaveFinishDrop({ eave: "open", overhang: ov }, NY);
    const notched = api.d3EaveFinishDrop({ eave: "open", overhang: ov, overhangStyle: "notched" }, NY);
    const extended = api.d3EaveFinishDrop({ eave: "open", overhang: ov, overhangStyle: "extended" }, NY);
    assertEquals(derived, notched, `open eave moved when notched (overhang ${ov})`);
    assertEquals(derived, extended, `open eave moved when extended (overhang ${ov})`);
    // And it is the depth measured off the building, not a value derived from anything —
    // dropped ALONG THE SLOPE NORMAL, the way buildShed3DModel hangs the tails
    // (eaveY + ny * (DECK_N - TAIL_DROP)), so ny multiplies the whole offset.
    assertAlmostEquals(derived, NY * (3.5 / 12 - 0.02), 1e-12);
  }
});

Deno.test("an open eave's tails hang along the NORMAL, at every pitch", () => {
  // The shape of a real bug: written as `TAIL_DROP - ny * DECK_N` — the form the fascia cases
  // take, where the board's own height IS vertical — every open eave moves by (1 - ny)*TAIL_DROP.
  for (const pitch of [0.2, 0.4, 0.75]) {
    const ny = Math.cos(Math.atan(pitch));
    assertAlmostEquals(
      api.d3EaveFinishDrop({ eave: "open" }, ny),
      ny * (api.D3_EAVE.TAIL_DROP - api.D3_EAVE.DECK_N),
      1e-12,
    );
  }
});

Deno.test("a NOTCHED tail is cut back to the deck: one soffit board and nothing else", () => {
  const drop = api.d3EaveFinishDrop({ overhang: 1.0, overhangStyle: "notched" }, NY);
  // The deck's underside sits DECK_N along the normal above the profile line; the finish is one
  // soffit board below that. Stated as the relation, so a pitch or an overhang change cannot
  // turn it back into a magic constant.
  assertAlmostEquals(drop, api.D3_EAVE.SOFFIT_T - NY * api.D3_EAVE.DECK_N, 1e-12);
  // Independent of how far the tail projects — the notch removes the rafter depth, and the
  // rafter depth does not grow with the overhang.
  for (const ov of [4 / 12, 1.0, 2.5]) {
    assertEquals(api.d3EaveFinishDrop({ overhang: ov, overhangStyle: "notched" }, NY), drop);
  }
  // And it holds at any pitch, which is the point of taking ny as a parameter.
  for (const pitch of [0.2, 0.4, 0.75]) {
    const ny = Math.cos(Math.atan(pitch));
    assertAlmostEquals(
      api.d3EaveFinishDrop({ overhangStyle: "notched" }, ny),
      api.D3_EAVE.SOFFIT_T - ny * api.D3_EAVE.DECK_N,
      1e-12,
    );
  }
});

Deno.test("an EXTENDED tail still hangs exactly where the shipped fascia mesh puts it", () => {
  // The mesh is `fascia.position.set(edgeU, edgeY - 0.14, ...)` with height 0.4, and
  // edgeY = eaveY + ny * (ROOF_T / 2 + 0.02) — so its bottom is 0.14 + 0.2 below edgeY.
  const edge = NY * (api.D3.ROOF_T / 2 + api.D3_EAVE.DECK_N);
  assertAlmostEquals(
    api.d3EaveFinishDrop({ overhang: 1.0, overhangStyle: "extended" }, NY),
    0.14 + 0.2 - edge,
    1e-12,
  );
});

Deno.test("the notch lifts the finish, and only for a fascia eave", () => {
  const ext = api.d3EaveFinishDrop({ overhang: 1.0, overhangStyle: "extended" }, NY);
  const notch = api.d3EaveFinishDrop({ overhang: 1.0, overhangStyle: "notched" }, NY);
  assert(notch < ext, `notched (${notch}) must hang less than extended (${ext})`);
  // The derived default at a 12 in overhang is the notched one — that IS the fix.
  assertEquals(api.d3EaveFinishDrop({ overhang: 1.0 }, NY), notch);
  // …and at a four-inch tail it is not, because a builder really does just run that one out.
  assertEquals(api.d3EaveFinishDrop({ overhang: 4 / 12 }, NY), ext);
});

// ── 3. The derived value must never be WRITTEN DOWN ───────────────────────────────────────
// Source-level, because the damage is done by a layer that persists, not by a value that
// renders: openCalEditor seeds adminCal.spec from d3ResolveStyleSpec and saveCalSpec posts
// adminCal.spec straight back as `d3`.
Deno.test("d3ResolveStyleSpec does not invent overhangStyle — the panel posts its output back", () => {
  for (const [file, src] of [["StructureStudio.jsx", JSX], ["structure-studio.component.js", CMP]] as const) {
    const body = codeOnly(lift(src, file, "function d3ResolveStyleSpec(", "    wallHeightFt: customerWallHeightFt"));
    assert(
      !body.includes("overhangStyle"),
      `${file}: d3ResolveStyleSpec mentions overhangStyle again. Whatever it puts on the returned ` +
        "roof is frozen into the tenant's column the first time a builder saves the panel, after " +
        "which raising the overhang no longer re-frames the eave.",
    );
  }
});

Deno.test("the AR scan hands over a measured spec with no derived framing in it", () => {
  for (const [file, src] of [["StructureStudio.jsx", JSX], ["structure-studio.component.js", CMP]] as const) {
    const body = codeOnly(lift(src, file, "const scanApplyMeasured = (m) => {", "const scanApply = () => {"));
    assert(
      !body.includes("overhangStyle"),
      `${file}: scanApplyMeasured writes a derived overhangStyle into the spec again.`,
    );
  }
});

Deno.test("styleD3.ts keeps an explicit pick and derives nothing", () => {
  assert(
    !STYLE_D3.includes("overhangStyleFor") && !STYLE_D3.includes("D3_NOTCH_MIN_OVERHANG_FT"),
    "styleD3.ts grew a second copy of the threshold again — one rule, one place, and the " +
      "renderer's copy is the one that ships.",
  );
  assert(
    STYLE_D3.includes('if (rawRoof.overhangStyle === "notched" || rawRoof.overhangStyle === "extended")'),
    "the sanitiser must still round-trip an EXPLICIT pick, or a builder's choice is dropped " +
      "silently on save — which looks exactly like 'the save didn't work'.",
  );
});

// ── 4. The drawing and the 3D must not disagree about an open eave ────────────────────────
Deno.test("the elevation gates its eave finish on roof.eave and reads the shared drop", () => {
  for (const [file, src] of [["StructureStudio.jsx", JSX], ["structure-studio.component.js", CMP]] as const) {
    const block = lift(src, file, "{/* THE EAVE FINISH,", "{/* OVERHANG, at the left eave */}");
    assert(block.includes("d3EaveFinishDrop("), `${file}: the elevation computes its own eave depth again`);
    const head = lift(src, file, "const EAVE_OPEN = roof.eave === \"open\";", "const dedup = d3RoofProfile(");
    assert(head.includes("!EAVE_OPEN && d3OverhangStyle(roof)"), `${file}: the soffit is no longer gated on the eave`);
  }
});

Deno.test("the 3D open-eave branch is untouched by the framing choice", () => {
  for (const [file, src] of [["StructureStudio.jsx", JSX], ["structure-studio.component.js", CMP]] as const) {
    const branch = lift(src, file, "        // OPEN EAVE — raw 2x rafter tails", "    // Ridge cap:");
    assert(
      !codeOnly(branch).includes("OV_NOTCHED"),
      `${file}: the open-eave branch reads OV_NOTCHED again. OV_NOTCHED is DERIVED from the ` +
        "overhang, so that silently resizes the exposed rafter tails of every shipped open-eave " +
        "style — the Urban's signature look — with nobody touching a setting.",
    );
    assert(branch.includes("D3_EAVE.TAIL_DROP"), `${file}: the tail drop is no longer the measured constant`);
  }
});
