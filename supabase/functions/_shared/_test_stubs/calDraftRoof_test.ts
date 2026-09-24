// The roof half of a video draft's merge (calDraftRoof), lifted out of the calibration panel and
// run: what a draft is the AUTHORITY on is the only source of it.
//
// It exists because every mistake this merge can make is invisible until a customer sees it.
// A plain spread keeps a stored key that the new draft said nothing about, so the preview goes on
// drawing the last draft's porch, wings or front wall under a draft that has none -- and Save
// writes it. The porch rule has been here since 09-17; the 2026-09-24 keys follow it:
//
//   porchAttachFt / porchWidthFt  belong to ONE projecting porch, and come from the draft that
//                                 reported it or not at all
//   wings                         a draft that reports a roof and no wings means NO wings
//   roof.front / roof.highSide    the frame of reference the draft's own frame labels used
//
// Lifted by stable anchors from BOTH twins, which must be byte-identical (the wallSlab_test /
// selfCheckPanel_test technique). calDraftRoof is an arrow inside the component, so it is
// lifted with the one constant it reads.

import { assert, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `calDraftRoof_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j + end.length);
}

const REGIONS: Array<[string, string]> = [
  ["const CAL_WING_KEYS = ", ";\n"],
  ["const calDraftRoof = (stored, drafted) => {", "\n    return roof;\n  };"],
];
const blocks = REGIONS.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));

Deno.test("the lifted merge is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const calDraftRoof = new Function(`${blocks.map((b) => b.cmp).join("\n")}; return calDraftRoof;`)() as (
  stored: Any,
  drafted: Any,
) => Any;

const has = (o: Any, k: string) => Object.prototype.hasOwnProperty.call(o, k);

Deno.test("the porch-kind rule still holds, in both directions", () => {
  const out = calDraftRoof({ type: "gable", porchDepthFt: 5, porchTruss: true }, { type: "gable", porchOutFt: 6 });
  assertEquals(out.porchOutFt, 6);
  assert(!has(out, "porchDepthFt") && !has(out, "porchTruss"), JSON.stringify(out));
  const back = calDraftRoof({ type: "gable", porchOutFt: 6 }, { type: "gable", porchDepthFt: 4 });
  assert(!has(back, "porchOutFt"), JSON.stringify(back));
  // A draft that reports neither keeps the stored porch, as it always has.
  assertEquals(calDraftRoof({ type: "gable", porchOutFt: 6 }, { type: "gable" }).porchOutFt, 6);
});

Deno.test("⚠️ a stored porch attach height never lands on a porch it was not measured on", () => {
  const stored = { type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 };
  // A redraft reporting a projecting porch brings its own numbers or none.
  const fresh = calDraftRoof(stored, { type: "shed", porchOutFt: 5 });
  assertEquals(fresh.porchOutFt, 5);
  assert(!has(fresh, "porchAttachFt") && !has(fresh, "porchWidthFt"), JSON.stringify(fresh));
  const own = calDraftRoof(stored, { type: "shed", porchOutFt: 5, porchAttachFt: 8 });
  assertEquals([own.porchAttachFt, has(own, "porchWidthFt")], [8, false]);
  // A recessed porch has neither.
  const recessed = calDraftRoof(stored, { type: "shed", porchDepthFt: 4 });
  assert(!has(recessed, "porchAttachFt") && !has(recessed, "porchWidthFt") && !has(recessed, "porchOutFt"), JSON.stringify(recessed));
  // And a draft that says nothing about the porch keeps the whole stored porch, numbers included.
  const quiet = calDraftRoof(stored, { type: "shed" });
  assertEquals([quiet.porchOutFt, quiet.porchAttachFt, quiet.porchWidthFt], [4, 7.5, 16]);
});

Deno.test("⚠️ the porch's posts, roof pitch and steps follow the attach height's rule (2026-09-25)", () => {
  const stored = { type: "shed", porchOutFt: 4, porchPosts: 4, porchPitch: 0.25, porchSteps: "left" };
  // A redraft reporting a projecting porch brings its own framing or none.
  const fresh = calDraftRoof(stored, { type: "shed", porchOutFt: 5 });
  for (const k of ["porchPosts", "porchPitch", "porchSteps"]) assert(!has(fresh, k), `${k} survived: ${JSON.stringify(fresh)}`);
  const own = calDraftRoof(stored, { type: "shed", porchOutFt: 5, porchPosts: 3, porchSteps: "right" });
  assertEquals([own.porchPosts, own.porchSteps, has(own, "porchPitch")], [3, "right", false]);
  // The porch stops projecting: none of it is left behind.
  const recessed = calDraftRoof(stored, { type: "shed", porchDepthFt: 4 });
  for (const k of ["porchPosts", "porchPitch", "porchSteps", "porchOutFt"]) assert(!has(recessed, k), `${k} survived: ${JSON.stringify(recessed)}`);
  // A draft silent about the porch keeps all of it.
  const quiet = calDraftRoof(stored, { type: "shed" });
  assertEquals([quiet.porchPosts, quiet.porchPitch, quiet.porchSteps], [4, 0.25, "left"]);
});

Deno.test("⚠️ A REDRAFT THAT REPORTS NO WINGS CLEARS THE STORED ONES", () => {
  const stored = { type: "gable", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 16 };
  const plain = calDraftRoof(stored, { type: "gable", pitch: 0.5 });
  for (const k of ["wingSide", "wingWidthFt", "wingPitch", "centerEaveFt"]) assert(!has(plain, k), `${k} survived: ${JSON.stringify(plain)}`);
  // 0 is off, the same as absent.
  const zero = calDraftRoof(stored, { type: "gable", wingWidthFt: 0 });
  assert(!has(zero, "wingSide") && !has(zero, "wingWidthFt"), JSON.stringify(zero));
  // A draft WITH wings carries its own, and the stored ones it did not mention stand beside them
  // only where the draft is silent about that key -- which is how a spread has always merged.
  const wings = calDraftRoof(stored, { type: "gable", wingSide: "left", wingWidthFt: 6 });
  assertEquals([wings.wingSide, wings.wingWidthFt, wings.centerEaveFt], ["left", 6, 16]);
});

Deno.test("the frame of reference comes from the draft or not at all", () => {
  const stored = { type: "gable", front: "eave" };
  assert(!has(calDraftRoof(stored, { type: "gable" }), "front"), "a draft with no front drops the stored one");
  assertEquals(calDraftRoof(stored, { type: "gable", front: "gable" }).front, "gable");
  const shed = calDraftRoof({ type: "shed", highSide: "back" }, { type: "shed", highSide: "front" });
  assertEquals(shed.highSide, "front");
  assert(!has(calDraftRoof({ type: "shed", highSide: "back" }, { type: "shed" }), "highSide"));
  // A gable redraft of a stored shed does not inherit the shed's high side.
  assert(!has(calDraftRoof({ type: "shed", highSide: "front" }, { type: "gable", front: "eave" }), "highSide"));
});

Deno.test("dev/score.mjs's mergeDraft clears exactly what calDraftRoof clears", async () => {
  // The scorer re-implements the browser's merge so it can run anywhere; a scorer that keeps a
  // key the browser drops scores a building nobody sees. Same cases, same roof, key for key.
  const { mergeDraft } = await import("../../../../dev/score.mjs");
  const cases: Array<[Any, Any]> = [
    [{ type: "gable", porchDepthFt: 5, porchTruss: true }, { type: "gable", porchOutFt: 6 }],
    [{ type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 }, { type: "shed", porchOutFt: 5 }],
    [{ type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 }, { type: "shed", porchOutFt: 5, porchAttachFt: 8 }],
    [{ type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 }, { type: "shed", porchDepthFt: 4 }],
    [{ type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 }, { type: "shed" }],
    [{ type: "shed", porchOutFt: 4, porchPosts: 4, porchPitch: 0.25, porchSteps: "left" }, { type: "shed", porchOutFt: 5, porchPosts: 3 }],
    [{ type: "shed", porchOutFt: 4, porchPosts: 4, porchPitch: 0.25, porchSteps: "left" }, { type: "shed", porchDepthFt: 4 }],
    [{ type: "shed", porchOutFt: 4, porchPosts: 4, porchPitch: 0.25, porchSteps: "left" }, { type: "shed" }],
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 16 }, { type: "gable", pitch: 0.5 }],
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, centerEaveFt: 16 }, { type: "gable", wingSide: "left", wingWidthFt: 6 }],
    [{ type: "gable", front: "eave" }, { type: "gable" }],
    [{ type: "shed", highSide: "front" }, { type: "gable", front: "eave" }],
    [{ type: "gable", front: "eave", wingSide: "both", wingWidthFt: 8 }, { pitch: 0.4 }],
  ];
  for (const [stored, drafted] of cases) {
    const scored = mergeDraft({ roof: stored }, { roof: drafted }, "video").roof;
    assertEquals(scored, calDraftRoof(stored, drafted), `${JSON.stringify(stored)} <- ${JSON.stringify(drafted)}`);
  }
});

Deno.test("⚠️ a draft with no roof type is not a shape read, and clears nothing", () => {
  // The self-check's `d3` and the photo path both carry a type; anything that does not is not an
  // authority on the building's massing, so the stored keys stand.
  const stored = { type: "gable", front: "eave", wingSide: "both", wingWidthFt: 8 };
  assertEquals(calDraftRoof(stored, { pitch: 0.4 }), { ...stored, pitch: 0.4 });
  assertEquals(calDraftRoof(stored, null), stored);
});
