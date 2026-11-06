// deno test --allow-read supabase/functions/_shared/doorPrompt.test.ts
// What the model is asked about a door (doorLookPrompt.ts): the Stage A prompt's sections in the plan's
// order, the bases as drawn today, 6-panel doors drafted and never refused, the answer shape doorLook.ts
// reads, the close-up and Stage B asks, the request body, the photo limits and reading an answer back.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  DOOR_EDGE_PAD_IN,
  DOOR_LOOK_PROMPT_ID,
  DOOR_PHOTO_MAX_LONG,
  DOOR_PHOTO_MAX_PIXELS,
  DOOR_STAGE_A_ANSWER,
  doorAnswerOf,
  doorCloseUpPrompt,
  doorEdgePadPx,
  doorFitSize,
  doorPhotoFits,
  doorRequestBody,
  doorStageAPrompt,
  doorStageBPrompt,
} from "./doorLookPrompt.ts";
import { DOOR_LOOK_BASES, DOOR_REFUSE_CODES, doorLookFromMeasure, type DoorLook } from "./doorLook.ts";
import { singleDoor } from "./_test_stubs/doorReads.ts";

const PROMPT = doorStageAPrompt({ widthIn: 72, heightIn: 80, leaves: 2, photo: [1092, 1213] });

Deno.test("Stage A: the plan's eleven sections, in order, then the answer shape", () => {
  const heads = ["1. KNOWN SIZE.", "2. BASE LOOKS.", "3. LEAVES and MEET.", "4. FRAME and RAILS.", "5. FIELD.", "6. BRACE and PANELS.", "7. PARTS.",
    "8. HINGES and HANDLE.", "9. OBSERVED and UNEXPLAINED.", "10. REFUSE.", "11. MEASURE."];
  let at = 0;
  for (const h of heads) {
    const i = PROMPT.indexOf(h);
    assert(i > at, `${h} after the one before`);
    at = i;
  }
  assert(PROMPT.startsWith(`${DOOR_LOOK_PROMPT_ID}. `));
  assert(PROMPT.indexOf("Answer with this JSON object only") > at);
});

Deno.test("Stage A: the known size, the straightened frame and the size to echo", () => {
  assert(PROMPT.includes("72 in wide and 80 in tall, a double door"));
  assert(PROMPT.includes("This image is 1092 x 1213 pixels."));
  assert(PROMPT.includes("measure.size: [1092, 1213]"));
  assert(doorStageAPrompt({ widthIn: 36, heightIn: 80, leaves: 1, photo: [700, 1556] }).includes("36 in wide and 80 in tall, a single door"));
  assertFalse(PROMPT.includes("close-up"), "no close-ups, no words about them");
  const ups = doorStageAPrompt({ widthIn: 72, heightIn: 80, leaves: 2, photo: [1092, 1213], closeUps: ["hinge", "meet"] });
  assert(ups.includes("The 2 images after the first are the builder's own close-ups: a close-up of one hinge; a close-up of the middle of the double door"));
  assert(ups.includes("never give a point on them"), "close-ups are not measured against the door");
});

Deno.test("V2's edge strips: where the door is in the photo, a butt hinge's knuckle as its pivot, Stage B told the same", () => {
  // 2 in past each side of a 72 in door on a 1092 px photo: 1092 x 2 / 76 = 28.7 px a strip.
  assertEquals([DOOR_LOOK_PROMPT_ID, DOOR_EDGE_PAD_IN, Math.round(doorEdgePadPx(1092, 72) * 10) / 10, doorEdgePadPx(1092, 72, 0)], ["DOOR_LOOK_V5", 2, 28.7, 0]);
  const strips = "The door's leaves fill it across from x = 29 to x = 1063, and down from the top of the leaves (the top edge) to the top of the threshold (the bottom edge). " +
    "The strip 29 pixels wide down each side is just past the leaves' outer edges: the jamb or casing, and the knuckles of butt hinges, which sit on the edge.";
  assert(PROMPT.includes(strips));
  assert(PROMPT.includes("give a point in them only for a hinge"));
  assert(PROMPT.includes("on a butt hinge, the middle of its knuckle"));
  // "barn" is what the built trim and plank looks draw: a lever on a back plate on the mid rail. Described
  // as a bare "barn-door latch", 12 of 12 reads of the American and Classic reference doors said lever.
  const barn = "barn (the standard shed and barn-door latch: a lever or bar on a back plate, mounted on a rail or stile, or a bar that drops into a catch)";
  assert(PROMPT.includes(barn) && doorCloseUpPrompt("handle", { crops: 1, builderPhoto: false }).includes(barn));
  assert(PROMPT.includes("lever (a lever handle on its own, with no back plate, as on a house or steel door)"));
  // The wider photo shows the dark jamb down both sides, and reads of a steel door's ribbed sheet drifted
  // to plank (4 of 6, against 1 of 3 before the strips); the truth files call a framed sheet a trim look:
  // basic, or american, classic or dutch by what is laid over it.
  assert(PROMPT.includes("A frame filled with one sheet (ribbed or corrugated metal, or grooved siding) is a trim look with field grooved"));
  assert(PROMPT.includes("american, classic or dutch when it has their pickets, octagon and X, or vent, and basic otherwise"));
  assertFalse(PROMPT.includes("Its edges are the outer edges of the leaves"));
  // A photo cut at the leaves (padIn 0) keeps the old words.
  const cut = doorStageAPrompt({ widthIn: 72, heightIn: 80, leaves: 2, photo: [1092, 1213], padIn: 0 });
  assert(cut.includes("Its edges are the outer edges of the leaves, inside the casing, from the top of the threshold to the top of the leaves."));
  assertFalse(cut.includes("pixels wide down each side"));
  const spec = { v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" } } as DoorLook;
  const b = doorStageBPrompt({ photo: [1092, 1213], widthIn: 72, heightIn: 80, spec, missing: [], unexplained: ["an arched top"] });
  assert(b.includes(strips));
});

Deno.test("Stage A: every base by its drawn look, the slab and any raised-panel door drafted as basic", () => {
  for (const b of DOOR_LOOK_BASES) assert(PROMPT.includes(`\n- ${b}: `), b);
  assert(PROMPT.includes("zbrace: plank plus one diagonal brace across the whole leaf, laid over the mid rail, rising from the hinge side."));
  assert(PROMPT.includes("dutch: a trim frame with a mid rail and a small dark louvred vent in the lower panel. A door split to open top and bottom is a split part, not dutch."));
  assert(PROMPT.includes("A plain flat door with no frame showing is basic with field smooth."));
  // V5: any count of raised panels, not only six (a white 7-panel door was read as "6-panel style", 10-29).
  assert(PROMPT.includes('A door of raised panels (any number: a 4-panel, 6-panel or 7-panel door) is basic with field smooth, each panel given as a raised part, and its count ("6-panel", "7-panel") in unexplained; never refuse a raised-panel door.'));
  assertFalse(PROMPT.includes("a 6-panel door)."), "the unexplained examples no longer name a panel door");
});

Deno.test("V5: unexplained names only the door, never the light or the photo, in Stage A and Stage B alike", () => {
  const only = "Only the door itself: never the light, shadows or reflections, the photo, or the wall, floor or casing round it.";
  const nine = PROMPT.slice(PROMPT.indexOf("9. OBSERVED and UNEXPLAINED."), PROMPT.indexOf("10. REFUSE."));
  assert(nine.includes(`(an arched top, a knob, leaves of different widths). ${only} Leave it empty when everything is said.`));
  const b = doorStageBPrompt({ photo: [700, 1556], widthIn: 36, heightIn: 80, spec: { v: 1, base: "basic", src: { leaves: 1, hinge: "left" } } as DoorLook, missing: [], unexplained: ["an arched top"] });
  assert(b.includes(`List anything still not said in unexplained, as short phrases. ${only}`));
});

Deno.test("Stage A: REFUSE lists the plan's five words, and a 6-panel door is not unsupported", () => {
  const refuse = PROMPT.slice(PROMPT.indexOf("10. REFUSE."), PROMPT.indexOf("11. MEASURE."));
  for (const w of ["not_door", "open", "blocked", "angled", "unsupported"]) {
    assert(refuse.includes(`${w} (`), w);
    assert((DOOR_REFUSE_CODES as readonly string[]).includes(w), `${w} is a code doorLook.ts reads`);
  }
  assert(refuse.includes("a garage, roll-up, overhead or sliding track door, a bi-fold, or a door of 3 or more leaves"));
  assert(refuse.includes("A 6-panel door is not unsupported."));
  const unsupported = refuse.slice(refuse.indexOf("unsupported ("), refuse.indexOf(")", refuse.indexOf("unsupported (")));
  assertFalse(/6-panel|six/i.test(unsupported), "6-panel is never listed under unsupported");
});

Deno.test("the answer shape is the one doorLook.ts reads: the example measures, the words are the vocabulary", () => {
  const a = DOOR_STAGE_A_ANSWER;
  assertEquals(Object.keys(a)[0], "measure", "points come first");
  assertEquals(Object.keys(a.measure), ["size", "leaves", "meet", "rails", "stiles", "seams", "braces", "hinges", "handle", "parts", "colorAt"]);
  assert(PROMPT.includes(JSON.stringify(a)));
  // A perfect answer in this shape (the test fixture) measures cleanly.
  const { read, ctx } = singleDoor();
  assertEquals(Object.keys(read.measure as object).every((k) => k in a.measure), true);
  assert(doorLookFromMeasure(read, ctx).ok);
});

Deno.test("close-ups: hinges and handle decide type and finish; the meeting edge decides astragal or overlap and its width", () => {
  const h = doorCloseUpPrompt("hinges", { crops: 3, builderPhoto: true });
  assert(h.startsWith("These images are 3 close-ups cut out of a photo of a closed door and enlarged 6 times, then the builder's own photo"));
  for (const t of ["tstrap", "strap", "scroll", "butt", "hidden", "pintle", "black", "galv", "bronze"]) assert(h.includes(`${t} (`), t);
  assert(h.endsWith('{"type": "tstrap", "finish": "black"}'));
  const k = doorCloseUpPrompt("handle", { crops: 1, builderPhoto: false });
  for (const t of ["barn", "lever", "pull", "ring", "thumb", "none"]) assert(k.includes(`${t} (`), t);
  const m = doorCloseUpPrompt("meet", { crops: 2, builderPhoto: false, widthIn: 72 });
  assert(m.includes("Each crop is 9 in wide on the door.") && m.includes("astragal (") && m.includes("overlap (") && m.includes('"wIn"'));
});

Deno.test("Stage B: the draft, what may be missing, parts only, the size echo", () => {
  const spec = { v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" } } as DoorLook;
  const b = doorStageBPrompt({ photo: [700, 1556], widthIn: 36, heightIn: 80, spec, missing: ["a window high up"], unexplained: ["an arched top"] });
  assert(b.startsWith(`${DOOR_LOOK_PROMPT_ID}, second look.`));
  assert(b.includes(JSON.stringify(spec)));
  assert(b.includes('"a window high up" (you saw it, and the draft does not draw it); "an arched top" (you said our words cannot say it)'));
  assert(b.includes("measure.size: [700, 1556]"));
  assert(b.includes("Do not repeat what the draft already has."));
});

Deno.test("the request: images first (a signed URL, or base64), then the text; adaptive thinking at the effort given", () => {
  const body = doorRequestBody({ model: "claude-opus-5-5", maxTokens: 12000, effort: "high", images: [{ url: "https://x/sign/a" }, { base64: "QUJD", mediaType: "image/jpeg" }], text: "go" });
  assertEquals(body, {
    model: "claude-opus-5-5", max_tokens: 12000, thinking: { type: "adaptive" }, output_config: { effort: "high" },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://x/sign/a" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
      { type: "text", text: "go" },
    ] }],
  });
});

Deno.test("the photo limits: 1568 px on the long side and 1.15 MP, never enlarged", () => {
  assertEquals([DOOR_PHOTO_MAX_LONG, DOOR_PHOTO_MAX_PIXELS], [1568, 1205862]);
  for (const src of [[4032, 3024], [3024, 4032], [6000, 1000], [1000, 6000], [1092, 1092], [500, 400], [2000, 2000]] as [number, number][]) {
    const out = doorFitSize(src);
    assert(doorPhotoFits(out), `${src} -> ${out}`);
    assert(out[0] <= src[0] && out[1] <= src[1], "never enlarged");
    assert(Math.abs(out[0] / out[1] - src[0] / src[1]) / (src[0] / src[1]) < 0.01, "the shape kept");
  }
  assertEquals(doorFitSize([500, 400]), [500, 400]);
  // A straightened door: the shape is the typed width over height.
  const door = doorFitSize([3000, 3000], 36 / 80);
  assert(doorPhotoFits(door) && Math.abs(door[0] / door[1] - 0.45) < 0.002, String(door));
  assertFalse(doorPhotoFits([1569, 100]));
  assertFalse(doorPhotoFits([1200, 1100]));
});

Deno.test("an answer read back: the object, through a fence or a sentence; anything else is none", () => {
  assertEquals(doorAnswerOf('{"a": 1}'), { a: 1 });
  assertEquals(doorAnswerOf('Here it is:\n```json\n{"a": {"b": [1, 2]}}\n```'), { a: { b: [1, 2] } });
  for (const bad of ["", "no", "[1, 2]", '{"a": ', null, 7]) assertEquals(doorAnswerOf(bad), null, String(bad));
});
