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
// lifted with the two constants it reads.

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
  // The three front step words a recessed porch keeps (2026-10-03), from the porch region.
  ["const D3_PORCH_STEP_FRONT = ", ";\n"],
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
  // A typed draft that reports no porch means NO porch (2026-09-25): the draft replaces the roof.
  assert(!has(calDraftRoof({ type: "gable", porchOutFt: 6 }, { type: "gable" }), "porchOutFt"));
  // The open porch gable (roof.porchGable, 2026-10-07) is a recessed porch's, and goes with it, typed or not.
  const open = { type: "gable", porchDepthFt: 6, porchTruss: true, porchGable: "open" };
  for (const dr of [{ porchOutFt: 6 }, { type: "gable", porchOutFt: 6 }]) {
    const out2 = calDraftRoof(open, dr);
    assert(!has(out2, "porchGable") && !has(out2, "porchTruss") && !has(out2, "porchDepthFt"), JSON.stringify(out2));
  }
  // An untyped recessed redraft keeps it, and a draft that reads it brings it.
  assertEquals(calDraftRoof(open, { porchDepthFt: 5 }).porchGable, "open");
  assertEquals(calDraftRoof({ type: "gable", porchDepthFt: 6 }, { type: "gable", porchDepthFt: 6, porchGable: "open" }).porchGable, "open");
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
  // And a typed draft that says nothing about the porch has no porch, numbers included.
  const quiet = calDraftRoof(stored, { type: "shed" });
  for (const k of ["porchOutFt", "porchAttachFt", "porchWidthFt"]) assert(!has(quiet, k), `${k} survived: ${JSON.stringify(quiet)}`);
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
  // A typed draft silent about the porch keeps none of it.
  const quiet = calDraftRoof(stored, { type: "shed" });
  for (const k of ["porchPosts", "porchPitch", "porchSteps"]) assert(!has(quiet, k), `${k} survived: ${JSON.stringify(quiet)}`);
});

Deno.test("⚠️ a recessed porch keeps its steps along its front, and their count, under a draft silent on them (2026-10-03)", () => {
  // No draft is asked about a recessed porch's steps, so they are the builder's: a draft with no type
  // that reports the recessed porch keeps them, and the projecting porch's own framing still goes.
  const stored = { type: "gable", porchDepthFt: 4, porchSteps: "center", porchStepCount: 3 };
  assertEquals(calDraftRoof(stored, { porchDepthFt: 5 }), { type: "gable", porchDepthFt: 5, porchSteps: "center", porchStepCount: 3 });
  // A draft that gives front steps brings its own.
  assertEquals(calDraftRoof(stored, { porchDepthFt: 5, porchSteps: "left" }).porchSteps, "left");
  // A projecting porch's front steps carry onto the recessed porch an untyped draft reports, as switching
  // the kind on the panel does; its posts and pitch do not.
  const fromDeck = calDraftRoof({ type: "gable", porchOutFt: 6, porchPosts: 4, porchPitch: 0.25, porchSteps: "right", porchStepCount: 2 }, { porchDepthFt: 4 });
  assertEquals(fromDeck, { type: "gable", porchDepthFt: 4, porchSteps: "right", porchStepCount: 2 });
  // A flight off an end of a deck has nowhere to go on a recessed porch: it goes, with its count.
  const side = calDraftRoof({ type: "gable", porchOutFt: 6, porchSteps: "leftSide", porchStepCount: 2 }, { porchDepthFt: 4 });
  for (const k of ["porchSteps", "porchStepCount", "porchOutFt"]) assert(!has(side, k), `${k} survived: ${JSON.stringify(side)}`);
  // A typed draft replaces the roof: front steps it gives are all there is ...
  assertEquals(calDraftRoof(stored, { type: "gable", porchDepthFt: 4, porchSteps: "right" }), { type: "gable", porchDepthFt: 4, porchSteps: "right" });
  // ... and one silent on them takes the stored recessed porch's back, with their count (2026-10-04): a
  // regenerated walk-around never erases them.
  assertEquals(calDraftRoof(stored, { type: "gable", porchDepthFt: 4 }), { type: "gable", porchDepthFt: 4, porchSteps: "center", porchStepCount: 3 });
  // Never a projecting porch's front steps, which the draft was asked about, nor a flight off a deck's end.
  assertEquals(calDraftRoof({ type: "gable", porchOutFt: 6, porchSteps: "right", porchStepCount: 2 }, { type: "gable", porchDepthFt: 4 }), { type: "gable", porchDepthFt: 4 });
  assertEquals(calDraftRoof({ type: "gable", porchOutFt: 6, porchSteps: "leftSide", porchStepCount: 2 }, { type: "gable", porchDepthFt: 4 }), { type: "gable", porchDepthFt: 4 });
  // A flight off one of a RECESSED porch's open sides (2026-10-07): a draft's own is kept (the v2 prompt asks
  // for it), and a stored recessed porch's comes back under a draft silent on its steps, typed or not; one
  // off a stored projecting deck's end never lands on a recessed draft.
  assertEquals(calDraftRoof(stored, { type: "gable", porchDepthFt: 4, porchSteps: "leftSide" }), { type: "gable", porchDepthFt: 4, porchSteps: "leftSide" });
  assertEquals(calDraftRoof(stored, { porchDepthFt: 5, porchSteps: "rightSide" }).porchSteps, "rightSide");
  const recSide = { type: "gable", porchDepthFt: 6, porchSteps: "rightSide", porchStepCount: 2 };
  assertEquals(calDraftRoof(recSide, { type: "gable", porchDepthFt: 5 }), { type: "gable", porchDepthFt: 5, porchSteps: "rightSide", porchStepCount: 2 });
  assertEquals(calDraftRoof(recSide, { porchDepthFt: 5 }), { type: "gable", porchDepthFt: 5, porchSteps: "rightSide", porchStepCount: 2 });
  assertEquals(calDraftRoof(recSide, { porchDepthFt: 5, porchSteps: "center" }), { type: "gable", porchDepthFt: 5, porchSteps: "center", porchStepCount: 2 });
});

Deno.test("⚠️ a flight off an end of the deck, and its count, survive a draft silent on the steps (2026-10-04)", () => {
  // The prompt tells the model to leave a side flight out, so it is the builder's: a redraft of the
  // projecting porch, typed or not, keeps it.
  const stored = { type: "gable", porchOutFt: 6, porchPosts: 4, porchSteps: "leftSide", porchStepCount: 2 };
  assertEquals(calDraftRoof(stored, { type: "gable", porchOutFt: 6 }), { type: "gable", porchOutFt: 6, porchSteps: "leftSide", porchStepCount: 2 });
  assertEquals(calDraftRoof(stored, { porchOutFt: 5 }), { type: "gable", porchOutFt: 5, porchSteps: "leftSide", porchStepCount: 2 });
  assertEquals(calDraftRoof({ type: "gable", porchOutFt: 6, porchSteps: "rightSide" }, { type: "gable", porchOutFt: 6 }).porchSteps, "rightSide");
  // A draft that gives front steps brings its own, and the side flight's count goes with it.
  assertEquals(calDraftRoof(stored, { type: "gable", porchOutFt: 6, porchSteps: "center" }), { type: "gable", porchOutFt: 6, porchSteps: "center" });
  // A typed draft with no porch has none, steps included.
  assertEquals(calDraftRoof(stored, { type: "gable" }), { type: "gable" });
  // ⚠️ Only a stored PROJECTING porch's (review, 2026-10-08): a stored RECESSED porch's flight off one of its open
  // sides never lands on a projecting draft as an end flight, typed or not -- the recessed branch's rule turned
  // round. A projecting draft that gives one itself still brings its own.
  const recSide = { type: "gable", porchDepthFt: 6, porchSteps: "rightSide", porchStepCount: 2 };
  assertEquals(calDraftRoof(recSide, { type: "gable", porchOutFt: 6 }), { type: "gable", porchOutFt: 6 });
  assertEquals(calDraftRoof(recSide, { porchOutFt: 6 }), { type: "gable", porchOutFt: 6 });
  assertEquals(calDraftRoof(recSide, { porchOutFt: 6, porchSteps: "leftSide" }), { type: "gable", porchOutFt: 6, porchSteps: "leftSide" });
});

Deno.test("⚠️ the porch's step count follows its steps: a redraft brings its own or none (2026-09-28)", () => {
  const stored = { type: "gable", porchOutFt: 6, porchSteps: "left", porchStepCount: 5 };
  // Not builder-only: a typed draft replaces the roof, and the count goes with the stored steps.
  for (const dr of [{ type: "gable", porchOutFt: 6 }, { type: "gable", porchOutFt: 6, porchSteps: "right" }, { type: "gable", porchDepthFt: 4 }, { type: "gable" }]) {
    assert(!has(calDraftRoof(stored, dr), "porchStepCount"), `survived ${JSON.stringify(dr)}`);
  }
  // An untyped draft reporting a projecting porch brings its own count or none, the posts' rule.
  assert(!has(calDraftRoof(stored, { porchOutFt: 5 }), "porchStepCount"));
  assertEquals(calDraftRoof(stored, { porchOutFt: 5, porchSteps: "left", porchStepCount: 3 }).porchStepCount, 3);
  // An untyped draft that says nothing about the porch clears nothing.
  assertEquals(calDraftRoof(stored, { pitch: 0.5 }).porchStepCount, 5);
});

Deno.test("⚠️ A REDRAFT THAT REPORTS NO WINGS CLEARS THE STORED ONES", () => {
  const stored = { type: "gable", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 16 };
  const plain = calDraftRoof(stored, { type: "gable", pitch: 0.5 });
  for (const k of ["wingSide", "wingWidthFt", "wingPitch", "centerEaveFt"]) assert(!has(plain, k), `${k} survived: ${JSON.stringify(plain)}`);
  // 0 is off, the same as absent.
  const zero = calDraftRoof(stored, { type: "gable", wingWidthFt: 0 });
  assert(!has(zero, "wingSide") && !has(zero, "wingWidthFt"), JSON.stringify(zero));
  // A draft WITH wings carries its own, and only its own: a typed draft replaces the roof, so the
  // stored centre eave it did not mention does not stand beside them (2026-09-25).
  const wings = calDraftRoof(stored, { type: "gable", wingSide: "left", wingWidthFt: 6 });
  assertEquals([wings.wingSide, wings.wingWidthFt, has(wings, "centerEaveFt")], ["left", 6, false]);
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
    // The open porch gable (2026-10-07) goes with the recessed porch under a projecting draft, typed or not.
    [{ type: "gable", porchDepthFt: 6, porchTruss: true, porchGable: "open" }, { porchOutFt: 6 }],
    [{ type: "gable", porchDepthFt: 6, porchTruss: true, porchGable: "open" }, { type: "gable", porchOutFt: 6 }],
    [{ type: "gable", porchDepthFt: 6, porchGable: "open" }, { porchDepthFt: 5 }],
    [{ type: "gable", porchDepthFt: 6 }, { type: "gable", porchDepthFt: 6, porchGable: "open" }],
    [{ type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 }, { type: "shed", porchOutFt: 5 }],
    [{ type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 }, { type: "shed", porchOutFt: 5, porchAttachFt: 8 }],
    [{ type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 }, { type: "shed", porchDepthFt: 4 }],
    [{ type: "shed", porchOutFt: 4, porchAttachFt: 7.5, porchWidthFt: 16 }, { type: "shed" }],
    [{ type: "shed", porchOutFt: 4, porchPosts: 4, porchPitch: 0.25, porchSteps: "left" }, { type: "shed", porchOutFt: 5, porchPosts: 3 }],
    [{ type: "shed", porchOutFt: 4, porchPosts: 4, porchPitch: 0.25, porchSteps: "left" }, { type: "shed", porchDepthFt: 4 }],
    [{ type: "shed", porchOutFt: 4, porchPosts: 4, porchPitch: 0.25, porchSteps: "left" }, { type: "shed" }],
    [{ type: "gable", porchOutFt: 6, porchSteps: "left", porchStepCount: 5 }, { type: "gable", porchOutFt: 6, porchSteps: "right" }],
    [{ type: "gable", porchOutFt: 6, porchSteps: "left", porchStepCount: 5 }, { porchOutFt: 5 }],
    [{ type: "gable", porchOutFt: 6, porchSteps: "left", porchStepCount: 5 }, { pitch: 0.5 }],
    // A recessed porch's front steps (2026-10-03): kept under an untyped draft, a side flight dropped.
    [{ type: "gable", porchDepthFt: 4, porchSteps: "center", porchStepCount: 3 }, { porchDepthFt: 5 }],
    [{ type: "gable", porchOutFt: 6, porchPosts: 4, porchSteps: "right" }, { porchDepthFt: 4 }],
    [{ type: "gable", porchOutFt: 6, porchSteps: "leftSide", porchStepCount: 2 }, { porchDepthFt: 4 }],
    [{ type: "gable", porchDepthFt: 4, porchSteps: "center" }, { type: "gable", porchDepthFt: 4, porchSteps: "left" }],
    // ...and taken back by a typed draft silent on them, from a recessed porch only (2026-10-04).
    [{ type: "gable", porchDepthFt: 4, porchSteps: "center", porchStepCount: 3 }, { type: "gable", porchDepthFt: 5 }],
    [{ type: "gable", porchOutFt: 6, porchSteps: "right", porchStepCount: 2 }, { type: "gable", porchDepthFt: 4 }],
    [{ type: "gable", porchOutFt: 6, porchSteps: "leftSide", porchStepCount: 2 }, { type: "gable", porchDepthFt: 4 }],
    // A flight off a recessed porch's open side (2026-10-07): the draft's own, or a stored recessed porch's.
    [{ type: "gable", porchDepthFt: 6, porchSteps: "rightSide", porchStepCount: 2 }, { porchDepthFt: 5 }],
    [{ type: "gable", porchDepthFt: 6, porchSteps: "rightSide", porchStepCount: 2 }, { type: "gable", porchDepthFt: 5 }],
    [{ type: "gable", porchDepthFt: 4, porchSteps: "center" }, { type: "gable", porchDepthFt: 4, porchSteps: "leftSide" }],
    // ...and never onto a projecting draft as an end flight (review, 2026-10-08).
    [{ type: "gable", porchDepthFt: 6, porchSteps: "rightSide", porchStepCount: 2 }, { type: "gable", porchOutFt: 6 }],
    [{ type: "gable", porchDepthFt: 6, porchSteps: "rightSide", porchStepCount: 2 }, { porchOutFt: 6 }],
    [{ type: "gable", porchDepthFt: 6, porchSteps: "rightSide", porchStepCount: 2 }, { porchOutFt: 6, porchSteps: "leftSide" }],
    // A flight off an end of a deck stays under a draft silent on the steps, typed or not (2026-10-04).
    [{ type: "gable", porchOutFt: 6, porchPosts: 4, porchSteps: "leftSide", porchStepCount: 2 }, { type: "gable", porchOutFt: 6 }],
    [{ type: "gable", porchOutFt: 6, porchPosts: 4, porchSteps: "leftSide", porchStepCount: 2 }, { porchOutFt: 5 }],
    [{ type: "gable", porchOutFt: 6, porchSteps: "leftSide", porchStepCount: 2 }, { type: "gable", porchOutFt: 6, porchSteps: "center" }],
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 16 }, { type: "gable", pitch: 0.5 }],
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, centerEaveFt: 16 }, { type: "gable", wingSide: "left", wingWidthFt: 6 }],
    [{ type: "gable", front: "eave" }, { type: "gable" }],
    [{ type: "shed", highSide: "front" }, { type: "gable", front: "eave" }],
    [{ type: "gable", front: "eave", wingSide: "both", wingWidthFt: 8 }, { pitch: 0.4 }],
    [{ type: "gable", dormerWidthFt: 6, dormerRiseFt: 4, plateBand: true, overhangStyle: "notched" }, { type: "gable", front: "gable", wingSide: "both", wingWidthFt: 11 }],
    // Where the roof sits on the wall (2026-10-06) is the builder's, kept by a typed draft like the band.
    [{ type: "gable", pitch: 0.4, seat: "raised", rafterDepthIn: 5.5, dormerWidthFt: 6 }, { type: "gable", pitch: 0.5 }],
    [{ type: "gable", pitch: 0.4, rafterDepthIn: 7.25 }, { type: "shed", pitch: 0.25 }],
    // Where a lean-to / the wings meet the building (2026-09-28) is the builder's, but a typed draft
    // replaces the roof: a stale attach must never override the wing pitch the draft measured.
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, wingAttach: "roof", wingAttachFt: 2 }, { type: "gable", pitch: 0.5 }],
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, wingAttach: "wall", wingAttachFt: 1 }, { type: "gable", wingSide: "both", wingWidthFt: 10, wingPitch: 0.3 }],
    [{ type: "gable", leanToWidthFt: 8, leanToSide: "left", leanToAttach: "roof", leanToAttachFt: 1.5 }, { type: "gable" }],
    // The lean-to list (roof.leanTos, 2026-09-29) is the builder's own, set on the Advanced page: a typed
    // draft replaces the roof and it goes, like the single lean-to; a draft with no type keeps it.
    [{ type: "gable", leanTos: [{ wall: "left", widthFt: 8 }, { wall: "front", widthFt: 5, enclosed: true }] }, { type: "gable", pitch: 0.5 }],
    [{ type: "gable", leanTos: [{ wall: "left", widthFt: 8 }] }, { pitch: 0.5 }],
    // Each wing set on its own (roof.wingSides, 2026-09-29) and the wing list (roof.wingList, 2026-10-01) are
    // the builder's, set on the Advanced page: a typed draft replaces the roof and they go, with or without
    // wings of its own; a draft with no type keeps them.
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, wingSides: { left: { widthFt: 6 } } }, { type: "gable", pitch: 0.5 }],
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, wingSides: { left: { widthFt: 6 } } }, { type: "gable", wingSide: "both", wingWidthFt: 10 }],
    [{ type: "gable", wingSide: "both", wingWidthFt: 8, wingSides: { left: { widthFt: 6 } } }, { pitch: 0.5 }],
    [{ type: "gable", wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }] }, { type: "gable", pitch: 0.5 }],
    [{ type: "gable", wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }] }, { type: "gable", wingSide: "both", wingWidthFt: 10 }],
    [{ type: "gable", wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }] }, { pitch: 0.5 }],
    // A typed draft that carries a list but no wings: the wing set is cleared as one, list included.
    [{ type: "gable" }, { type: "gable", wingList: [{ wall: "left", widthFt: 8 }] }],
    [{ type: "gable" }, { type: "gable", wingSides: { left: { widthFt: 6 } } }],
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


Deno.test("⚠️ A TYPED DRAFT REPLACES THE ROOF: no stale dormer or lean-to, the builder's band and notch kept (2026-09-25)", () => {
  // The live 2026-09-25 Tri Home regeneration: the stored roof had the old style's 6 ft dormer, the
  // draft and all three check rounds had none, and the merge saved it anyway.
  const stored = { type: "gable", pitch: 0.47, dormerWidthFt: 6, dormerRiseFt: 4, dormerOffsetU: 0, leanToWidthFt: 8, leanToSide: "left",
    tailSpacingIn: 24, plateBand: true, overhangStyle: "notched" };
  const out = calDraftRoof(stored, { type: "gable", front: "gable", pitch: 0.7, wingSide: "both", wingWidthFt: 11 });
  for (const k of ["dormerWidthFt", "dormerRiseFt", "dormerOffsetU", "leanToWidthFt", "leanToSide", "tailSpacingIn"]) {
    assert(!has(out, k), `${k} survived: ${JSON.stringify(out)}`);
  }
  assertEquals([out.plateBand, out.overhangStyle, out.pitch, out.wingWidthFt], [true, "notched", 0.7, 11]);
  // Where the lean-to and the wings met the building goes with them (2026-09-28): the draft measured
  // its own wing pitch, and an attach left behind would override it.
  const att = calDraftRoof({ ...stored, leanToAttach: "roof", leanToAttachFt: 1.5, wingSide: "both", wingWidthFt: 8, wingAttach: "wall", wingAttachFt: 1 },
    { type: "gable", front: "gable", pitch: 0.7, wingSide: "both", wingWidthFt: 11, wingPitch: 0.3 });
  for (const k of ["leanToAttach", "leanToAttachFt", "wingAttach", "wingAttachFt"]) assert(!has(att, k), `${k} survived: ${JSON.stringify(att)}`);
  assertEquals(att.wingPitch, 0.3);
  const noWings = calDraftRoof({ type: "gable", wingSide: "both", wingWidthFt: 8, wingAttach: "roof", wingAttachFt: 2 }, { pitch: 0.4 });
  assertEquals([noWings.wingAttach, noWings.wingAttachFt], ["roof", 2], "an untyped draft clears nothing");
  // A draft that reports a dormer keeps its own.
  assertEquals(calDraftRoof(stored, { type: "gable", dormerWidthFt: 5 }).dormerWidthFt, 5);
});

Deno.test("⚠️ A TYPED REDRAFT KEEPS WHERE THE ROOF SITS (roof.seat / roof.rafterDepthIn, 2026-10-06)", () => {
  // The walk-around never sees the heel, so the model is never asked: the builder's pick survives a
  // shape read that replaces everything else on the roof, and an untyped draft keeps it as it keeps all.
  const stored = { type: "gable", pitch: 0.4, seat: "raised", rafterDepthIn: 5.5, dormerWidthFt: 6 };
  const out = calDraftRoof(stored, { type: "gable", front: "gable", pitch: 0.5 });
  assertEquals([out.seat, out.rafterDepthIn, out.pitch], ["raised", 5.5, 0.5]);
  assert(!has(out, "dormerWidthFt"), "the rest of the roof is still replaced");
  // A rafter stored without a seat is remembered too (the leanToSide posture).
  assertEquals(calDraftRoof({ type: "gable", rafterDepthIn: 7.25 }, { type: "shed" }).rafterDepthIn, 7.25);
  // Absent stays absent: nothing is invented for a roof that never had it.
  const plain = calDraftRoof({ type: "gable", pitch: 0.4 }, { type: "gable", pitch: 0.5 });
  assert(!has(plain, "seat") && !has(plain, "rafterDepthIn"), JSON.stringify(plain));
  assertEquals(calDraftRoof(stored, { pitch: 0.45 }).seat, "raised", "an untyped draft clears nothing");
});

Deno.test("⚠️ the lean-to list (roof.leanTos, 2026-09-29) goes with a typed draft and stays without one", () => {
  const stored = { type: "gable", pitch: 0.4, leanTos: [{ wall: "left", widthFt: 8 }, { wall: "front", widthFt: 5, enclosed: true }] };
  assert(!("leanTos" in calDraftRoof(stored, { type: "gable", pitch: 0.5 })), "a typed draft is the video's roof: no stale lean-tos");
  assertEquals(calDraftRoof(stored, { pitch: 0.5 }).leanTos, stored.leanTos, "a draft with no type keeps them");
});

Deno.test("⚠️ the wing list, the per-side wings and the corners switch (2026-09-29 / 10-01 / 10-05) go with a typed draft and stay without one", () => {
  const list = [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }, { wall: "front", widthFt: 8 }];
  const sides = { left: { widthFt: 6, attach: "wall", attachFt: 1 }, right: { widthFt: 10 } };
  for (const [k, v] of [["wingList", list], ["wingSides", sides], ["wingCornersMeet", true]] as const) {
    const stored = { type: "gable", wingSide: "both", wingWidthFt: 8, [k]: v };
    assert(!has(calDraftRoof(stored, { type: "gable", pitch: 0.5 }), k), `${k}: a typed draft without wings clears it`);
    assert(!has(calDraftRoof(stored, { type: "gable", wingSide: "both", wingWidthFt: 10 }), k), `${k}: a typed draft with its own wings replaces it`);
    assertEquals(calDraftRoof(stored, { pitch: 0.5 })[k], v, `${k}: a draft with no type keeps it`);
    // A typed draft that reports no wings clears the whole wing set, even a list it carries itself.
    assert(!has(calDraftRoof({ type: "gable" }, { type: "gable", [k]: v }), k), `${k}: cleared with the wing set`);
  }
});

Deno.test("⚠️ dev/score.mjs's WING_KEYS is the browser's CAL_WING_KEYS, key for key and in order", async () => {
  // The scorer's list is module-private, so it is read the way the browser's is: lifted from the text.
  const score = await Deno.readTextFile(new URL("../../../../dev/score.mjs", import.meta.url));
  const scored = new Function(`${lift(score, "dev/score.mjs", "const WING_KEYS = ", "];")} return WING_KEYS;`)() as string[];
  const browser = new Function(`${blocks[0].cmp} return CAL_WING_KEYS;`)() as string[];
  assertEquals(browser, scored);
  assertEquals(browser.slice(-2), ["wingList", "wingCornersMeet"], "the list, then its corners switch, end the set");
});
