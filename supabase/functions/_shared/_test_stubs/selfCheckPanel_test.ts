// The compare step's arithmetic, and the one place the browser and the server have to agree.
//
// Everything the builder is shown after a generation — the two roof sliders, the roof read
// back in feet, the "What the check changed" list — is pure, lives in both hand-mirrored
// twins, and is lifted out and run here.
//
// THE LOAD-BEARING TEST IS THE FIRST ONE. The roof fix panel exists because a drafted gambrel
// came back with its two slopes two degrees apart and rendered as a plain gable; the server
// flags that with `gambrelRoofWarning`. A pair of sliders that could put a builder back into
// the state they opened the panel to escape would be worse than no panel, so the real
// gambrelRoofWarning — imported, not re-implemented — is run over the whole slider grid.
//
// The other reason this file exists: the change list's field names are the SERVER'S
// allow-list. A field the server can correct and the browser has no words for would reach the
// builder as `roof.tailSpacingIn`, so the two lists are compared directly.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { gambrelRoofWarning, SELF_CHECK_ALLOW } from "../styleD3.ts";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `selfCheckPanel_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  // d3FtIn, which every "in feet" line is written through.
  ["function d3FtIn(", "// ── THE PROJECTING PORCH'S NUMBERS"],
  // The whole of the compare step's pure half.
  ["const SS_RENDER_MS =", "// Upload a list with BOUNDED CONCURRENCY"],
];
const blocks = REGIONS.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));

Deno.test("every lifted compare-step region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `${blocks.map((b) => b.cmp).join("\n")}; return { SS_CHECKS, SS_VIEW_WORDS, SS_SPIN_STEP_DEG, SS_RENDER_MS, SS_CHECK_MS, ` +
    `SS_GAMBREL_BEND_DEG, ssGambrelFromSliders, ssGambrelSliders, ssRoofInFeet, ssChangeLine, SS_CHANGE_WORDS };`,
)() as Record<string, Any>;

// ── The sliders cannot build the roof the warning was written for ─────────────────────────

Deno.test("⚠️ NO PAIR OF SLIDER POSITIONS CAN PRODUCE A ROOF gambrelRoofWarning REFUSES", () => {
  // The real function, imported from the server's own module. Re-implementing the rule here
  // would let the two drift apart in exactly the direction that matters — the panel would
  // keep passing its own copy while the builder's save kept being flagged.
  let checked = 0;
  for (let bend = 0; bend <= 100; bend += 2) {
    for (let steep = 0; steep <= 100; steep += 2) {
      const roof = { type: "gambrel", ...F.ssGambrelFromSliders(bend, steep) };
      const warn = gambrelRoofWarning(roof);
      assert(warn === null, `bend ${bend} steep ${steep} -> ${JSON.stringify(roof)}: ${warn}`);
      checked++;
    }
  }
  assertEquals(checked, 51 * 51);
});

Deno.test("the derived peak is always above the bend, and inside the sanitiser's band", () => {
  for (let bend = 0; bend <= 100; bend += 5) {
    for (let steep = 0; steep <= 100; steep += 5) {
      const g = F.ssGambrelFromSliders(bend, steep);
      assert(g.ridgeRise > g.kneeRise, `${bend}/${steep}: ${JSON.stringify(g)}`);
      // sanitizeD3Spec's own clamps: kneeU 0..1, kneeRise 0..1, ridgeRise 0..1.5. A slider
      // that produced something outside them would be silently clamped on save into a roof
      // the builder never chose.
      assert(g.kneeU >= 0 && g.kneeU <= 1, String(g.kneeU));
      assert(g.kneeRise >= 0 && g.kneeRise <= 1, String(g.kneeRise));
      assert(g.ridgeRise >= 0 && g.ridgeRise <= 1.5, String(g.ridgeRise));
    }
  }
});

Deno.test("junk slider input still lands on a drawable roof", () => {
  // The value comes off a DOM range as a string, and a builder dragging past either stop is
  // the browser's business, not this function's.
  for (const pair of [["0", "0"], ["100", "100"], [NaN, 50], [-40, 400], ["x", "y"], [null, undefined]]) {
    const g = F.ssGambrelFromSliders(pair[0], pair[1]);
    assert(isFinite(g.kneeU) && isFinite(g.kneeRise) && isFinite(g.ridgeRise), JSON.stringify(pair));
    assertEquals(gambrelRoofWarning({ type: "gambrel", ...g }), null, JSON.stringify(pair));
  }
});

Deno.test("the sliders read back where a roof already is, including the drawn default", () => {
  // Mirrors d3RoofProfile's `||` defaults on purpose: a 0 or absent kneeU DRAWS at 0.55, so
  // the slider has to show 0.55 rather than the stop. gambrelRoofWarning reads it the same
  // way, and a panel that disagreed with the warning about where a roof IS would be arguing
  // with the message that opened it.
  const mid = F.ssGambrelSliders({});
  assertEquals(mid, F.ssGambrelSliders({ type: "gambrel", kneeU: 0.55, kneeRise: 0.55 }));
  assertEquals(F.ssGambrelSliders({ kneeU: 0.45, kneeRise: 0.25 }), { bendPct: 0, steepPct: 0 });
  assertEquals(F.ssGambrelSliders({ kneeU: 0.95, kneeRise: 0.95 }), { bendPct: 100, steepPct: 100 });
  // Out of the slider's own band is pinned to the stop rather than reported as a negative,
  // which would make the thumb jump off the track.
  assertEquals(F.ssGambrelSliders({ kneeU: 0.1, kneeRise: 2 }), { bendPct: 0, steepPct: 100 });
});

Deno.test("a slider round trip does not move a roof that was already in band", () => {
  for (const kneeU of [0.5, 0.6, 0.72, 0.9]) {
    for (const kneeRise of [0.3, 0.5, 0.72, 0.9]) {
      const back = F.ssGambrelFromSliders(...Object.values(F.ssGambrelSliders({ kneeU, kneeRise })) as [number, number]);
      // Within one slider step of 100, which is what the integer percentage costs.
      assert(Math.abs(back.kneeU - kneeU) <= 0.006, `${kneeU} -> ${back.kneeU}`);
      assert(Math.abs(back.kneeRise - kneeRise) <= 0.008, `${kneeRise} -> ${back.kneeRise}`);
    }
  }
});

// ── The roof, in feet, for a person holding a tape ────────────────────────────────────────

Deno.test("the confirm line reads a gambrel back in feet and inches", () => {
  // The one measured roof in the corpus, on a 16 ft span: the bend 0.28 of the half-span in from the
  // wall (2 ft 3 in), 0.72 of it up (5 ft 9 in), the peak 1.0 of it up (8 ft).
  const line = F.ssRoofInFeet({ type: "gambrel", kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1.0 }, 16);
  assertStringIncludes(line, "2 ft 3 in");
  assertStringIncludes(line, "5 ft 9 in");
  assertStringIncludes(line, "8 ft");
  // No ratios reach the screen. 0.72 is meaningless against a building, and the whole reason
  // the prompt is allowed to keep asking for ratios is that this line exists.
  assert(!/0\.\d/.test(line), line);
});

Deno.test("a gable and a shed each get their own sentence, and neither borrows the gambrel's", () => {
  const gable = F.ssRoofInFeet({ type: "gable", pitch: 0.5 }, 16);
  assertStringIncludes(gable, "4 ft");
  assert(!gable.includes("bend"), gable);
  const shed = F.ssRoofInFeet({ type: "shed", pitch: 0.25 }, 16);
  assertStringIncludes(shed, "4 ft");
  assertStringIncludes(shed, "high side");
  // An absent pitch draws at the renderer's own default rather than at nothing.
  assert(F.ssRoofInFeet({ type: "gable" }, 16).length > 0);
  assert(F.ssRoofInFeet(null, 16).length > 0);
});

// ── The change list is written in the same words the panel uses ───────────────────────────

Deno.test("⚠️ every field the SERVER may correct has words the builder can read", () => {
  // The server's allow-list is the complete set of things that can appear in `changed[]`. A
  // field missing from here reaches a builder as `roof.tailSpacingIn` in the one list they
  // are meant to read item by item.
  const missing = (SELF_CHECK_ALLOW as readonly string[]).filter((f) => !(f in F.SS_CHANGE_WORDS));
  assertEquals(missing, [], `no builder-readable words for: ${missing.join(", ")}`);
});

Deno.test("the overhang is reported in INCHES, which is the whole point of reporting it", () => {
  // 1.0 ft against a 0.15 ft truth reads as a rounding. 12 in against 2 in is obviously wrong
  // at a glance. Same number, same clamp, different boundary — and this is the field the
  // model has never once got right in nineteen recorded generations.
  const line = F.ssChangeLine({ field: "roof.overhang", from: 1.0, to: 0.15, why: "" });
  assertEquals(line.label, "How far the roof sticks out past the wall");
  assertEquals(line.text, "12 in → 2 in");
});

Deno.test("a ratio is reported as a direction, never as a number", () => {
  // There is no builder-readable value for kneeU, so the line says which way it moved. A
  // number here would be the one thing the fix panel refuses to show, printed anyway.
  const up = F.ssChangeLine({ field: "roof.kneeU", from: 0.55, to: 0.75, why: "" });
  assertEquals(up.label, "Where the barn roof's bend sits");
  assertEquals(up.text, "increased");
  assertEquals(F.ssChangeLine({ field: "roof.kneeRise", from: 0.7, to: 0.4, why: "" }).text, "reduced");
  // A non-numeric pair cannot be read as a direction and says so rather than inventing one.
  assertEquals(F.ssChangeLine({ field: "roof.dormerOffsetU", from: null, to: "x", why: "" }).text, "changed");
});

Deno.test("a roof type is named the way the fix panel's tiles name it", () => {
  assertEquals(F.ssChangeLine({ field: "roof.type", from: "gable", to: "gambrel", why: "" }).text,
    "two straight slopes → a barn roof with a bend");
  assertEquals(F.ssChangeLine({ field: "roof.porchEnd", from: "front", to: "back", why: "" }).text,
    "the end you filmed first → the other end");
});

Deno.test("an unknown field still produces a line rather than an empty bullet", () => {
  // Nothing outside the allow-list can reach here today, and a field ADDED to the server's
  // list before this file learns the words for it must still render as something.
  const line = F.ssChangeLine({ field: "roof.somethingNew", from: 1, to: 2, why: "" });
  assertEquals(line.label, "roof.somethingNew");
  assertEquals(line.text, "increased");
});

// ── The four questions, and the clocks ────────────────────────────────────────────────────

Deno.test("the four questions are the measured failure list, in order", () => {
  assertEquals(F.SS_CHECKS.map((c: Any) => c[0]), ["roof", "porch", "walls", "colours"]);
  for (const [, question, hint] of F.SS_CHECKS) {
    assert(question.endsWith("?"), question);
    assert(hint.length > 10, hint);
    // Stated as things on a building, never as fields. A question naming a spec key is a
    // question only the person who wrote the spec can answer.
    assert(!/[a-z][A-Z]/.test(question + hint), `${question} / ${hint} reads like a field name`);
  }
});

Deno.test("the clocks leave no path past the three minutes the design budgeted", () => {
  // call 1 is bounded at 110 s by the server and is deliberately NOT aborted here: abandoning
  // a call that has already taken the hold is how a slow generation becomes a lost $20.
  assert(110000 + F.SS_RENDER_MS + F.SS_CHECK_MS <= 180000,
    `110000 + ${F.SS_RENDER_MS} + ${F.SS_CHECK_MS} is over the 180 s budget`);
  // And the check's client abort has to sit ABOVE the server's own 45 s, or a server that
  // answered in time would never be heard.
  assert(F.SS_CHECK_MS > 45000, String(F.SS_CHECK_MS));
});

Deno.test("every viewpoint the server knows has a name the builder can read", () => {
  for (const v of ["front", "side", "eaveCorner", "corner"]) {
    assert(typeof F.SS_VIEW_WORDS[v] === "string" && F.SS_VIEW_WORDS[v].length > 3, v);
    assert(F.SS_VIEW_WORDS[v] !== v, `${v} is shown to a builder as its own key`);
  }
});
