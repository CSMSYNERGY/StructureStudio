// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// What this pins, and why each one is here rather than left to a manual click-through:
//
//  * The photo cap is a PARAMETER now. The default guards `d3_photos`, a persisted jsonb
//    column the editor renders as exactly four slots; the video path passes eight. Both
//    halves of that have to stay true, and the failure mode of getting it wrong is silent —
//    sanitizePhotoUrls slices without erroring, so a truncated walk-around returns HTTP 200,
//    a full-price ledger row, and a spec drafted from half the building.
//  * `observed` must SURVIVE parseObservedNotes and be DROPPED by sanitizeD3Spec. It is
//    model prose on its way into a builder's browser, and it is not geometry.
//  * sanitizeD3Spec always emits `siding`. That is the trap applyDraftedShape exists for:
//    a video draft that said nothing about cladding must not reset the builder's choice.
//  * combinedShapePrompt must actually REPLACE the opening paragraph, not merely prepend to
//    it. Its failure mode is the quietest one in this file: a prompt that still reads well,
//    still returns a parseable spec, and still asserts that the builder's four staged
//    photographs are consecutive frames of one lap. Nothing downstream can notice — the only
//    symptom is a shape reconciled against a walk that never happened.

import { sanitizePhotoUrls, parseModelSpec, parseObservedNotes, sanitizeD3Spec, combinedShapePrompt, VIDEO_SHAPE_PROMPT } from "./styleD3.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://example.test/f${i}.jpg`);

Deno.test("sanitizePhotoUrls still caps at four by default", () => {
  // Every existing caller — save_style_d3, admin-save-settings, the photo draft — relies on
  // this. d3_photos is four slots wide.
  assertEquals(sanitizePhotoUrls(urls(9)).length, 4);
});

Deno.test("sanitizePhotoUrls honours a raised cap for the video path", () => {
  assertEquals(sanitizePhotoUrls(urls(9), 8).length, 8);
  assertEquals(sanitizePhotoUrls(urls(3), 8).length, 3, "a shorter walk is not padded");
});

Deno.test("sanitizePhotoUrls clamps a nonsense cap instead of trusting it", () => {
  assertEquals(sanitizePhotoUrls(urls(30), 999).length, 12, "hard ceiling");
  assertEquals(sanitizePhotoUrls(urls(30), 0).length, 4, "zero falls back to the default");
  assertEquals(sanitizePhotoUrls(urls(30), -5).length, 1, "negative floors at one");
});

Deno.test("sanitizePhotoUrls rejects non-http and over-long URLs at any cap", () => {
  const mixed = ["javascript:alert(1)", "https://ok.test/a.jpg", "data:image/jpeg;base64,AAAA", `https://x.test/${"a".repeat(700)}.jpg`];
  assertEquals(sanitizePhotoUrls(mixed, 8), ["https://ok.test/a.jpg"]);
});

// A reply shaped like the one VIDEO_SHAPE_PROMPT asks for.
const VIDEO_REPLY = `Here is the spec:
{
  "roof": { "type": "gable", "pitch": 0.42, "ridgeOffset": 0, "overhang": 1.0 },
  "siding": null,
  "colors": { "body": "#CDB794", "trim": "#BBB29C", "roof": "#46443F" },
  "wallHeightFt": 7,
  "observed": {
    "roofNote": "Simple symmetric gable read from the\\n rake edge against the sky.",
    "eave": "Exposed rafter tails, no fascia board",
    "doors": "One single door centred on a gable end",
    "windows": "none",
    "vents": "Louvered gable vent on both ends",
    "confidence": "high"
  }
}`;

Deno.test("a video reply parses to a clean spec and drops observed", () => {
  const r = parseModelSpec(VIDEO_REPLY);
  assert(r.ok, "spec should parse");
  if (!r.ok) return;
  assertEquals(r.d3.roof, { type: "gable", pitch: 0.42, ridgeOffset: 0, overhang: 1 });
  assertEquals(r.d3.wallHeightFt, 7);
  assert(!("observed" in (r.d3 as Record<string, unknown>)), "observed must not reach the stored spec");
});

Deno.test("wallHeightFt clamps a near-miss and drops a wrong-unit answer", () => {
  const wh = (v: unknown) => {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, wallHeightFt: v });
    assert(r.ok, "the roof is valid, so the spec is accepted whatever the height says");
    return r.ok ? r.d3.wallHeightFt : undefined;
  };
  // In range: untouched.
  assertEquals(wh(7), 7, "a plausible height passes through");
  assertEquals(wh(5), 5, "the low bound is inclusive");
  assertEquals(wh(14), 14, "the high bound is inclusive");
  // Near-miss: pulled to the bound. Before 2026-08-25 these were DROPPED, which left the
  // style default (often 8) standing -- further from the truth than the bound.
  assertEquals(wh(4.5), 5, "a low near-miss clamps up rather than vanishing");
  assertEquals(wh(16), 14, "a high near-miss clamps down rather than vanishing");
  // Wrong unit or nonsense: dropped, so the builder's own value survives. Clamping 96 in
  // would draw a two-storey wall on a garden shed and look like the model read it that way.
  assertEquals(wh(96), undefined, "inches are not feet");
  assertEquals(wh(0), undefined, "zero is not a wall");
  assertEquals(wh(-8), undefined, "negative is not a wall");
  assertEquals(wh("tall"), undefined, "non-numeric is dropped");
});

Deno.test("sanitizeD3Spec always emits siding, which is why the video merge cannot trust it", () => {
  // The regression applyDraftedShape guards: `siding` is present and null even though the
  // model never mentioned cladding, so a `!== undefined` check would wipe the builder's
  // setting on every draft.
  const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(r.ok, "minimal spec should be accepted");
  if (!r.ok) return;
  assert("siding" in r.d3, "siding is always present");
  assertEquals(r.d3.siding, null);
});

Deno.test("all four claddings round-trip; anything else collapses to null", () => {
  // Until 2026-08-25 this test would have failed on "panel" and "agpanel": the sanitiser
  // accepted only batten and lap and rewrote everything else to null WITHOUT erroring. A
  // builder setting a style to Metal got a success toast and Panel on reload — the whole
  // reason "change plain to panel siding, add metal" looked like a frontend bug.
  for (const id of ["panel", "lap", "batten", "agpanel"]) {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, siding: id });
    assert(r.ok, `${id} should be accepted`);
    if (r.ok) assertEquals(r.d3.siding, id, `${id} must survive the round trip`);
  }
  for (const junk of ["plain", "vinyl", "", 7, null, undefined, { id: "lap" }]) {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, siding: junk });
    assert(r.ok, "an unknown cladding is dropped, never an error");
    // null is what the renderer already draws as panel, so this is the safe direction:
    // an old row that says nothing looks exactly as it did before the list widened.
    if (r.ok) assertEquals(r.d3.siding, null, `${JSON.stringify(junk)} must not persist`);
  }
});

Deno.test("claddingChoices is rebuilt in canonical order, never echoed back", () => {
  const r = sanitizeD3Spec({
    roof: { type: "gable", pitch: 0.4 },
    // Caller's order is arbitrary and carries junk; neither may reach the column.
    claddingChoices: ["agpanel", "vinyl", "panel", "agpanel", "<script>"],
  });
  assert(r.ok, "spec should be accepted");
  if (!r.ok) return;
  assertEquals(r.d3.claddingChoices, ["panel", "agpanel"], "canonical order, junk dropped, deduped");
});

Deno.test("claddingChoices: absent and empty both mean all four", () => {
  // Absent is every existing row. Empty is a builder who unticked every box — a slip,
  // not an instruction, and honouring it literally would leave the customer no cladding
  // to pick at all.
  const absent = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(absent.ok && !("claddingChoices" in absent.d3), "absent stays absent");
  const empty = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, claddingChoices: [] });
  assert(empty.ok && !("claddingChoices" in empty.d3), "empty falls back to unset");
  const allJunk = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, claddingChoices: ["nope"] });
  assert(allJunk.ok && !("claddingChoices" in allJunk.d3), "all-unknown falls back to unset");
});

Deno.test("lean-to and dormer round-trip as additive roof keys, clamped", () => {
  // They are extra keys on `roof` rather than new roof TYPES on purpose: one shared
  // building_styles.d3 serves beta and production, and the production profile builder's
  // `else` draws a GABLE for any type it does not know. A new type would therefore show
  // production a plain gable the moment someone calibrated a lean-to on beta. Extra keys
  // degrade to "appendage missing", which is honest; a wrong roof is not.
  const r = sanitizeD3Spec({
    roof: {
      type: "gable", pitch: 0.4,
      leanToWidthFt: 8, leanToDropFt: 1.5, leanToSide: "left",
      dormerWidthFt: 4, dormerRiseFt: 2.5, dormerOffsetU: 0.45,
    },
  });
  assert(r.ok, "spec should be accepted");
  if (!r.ok) return;
  assertEquals(r.d3.roof.leanToWidthFt, 8);
  assertEquals(r.d3.roof.leanToSide, "left");
  assertEquals(r.d3.roof.dormerWidthFt, 4);
  assertEquals(r.d3.roof.dormerOffsetU, 0.45);

  // Clamped, not rejected -- same posture as every other numeric here.
  const c = sanitizeD3Spec({
    roof: { type: "gable", pitch: 0.4, leanToWidthFt: 999, dormerOffsetU: -7, leanToDropFt: -3 },
  });
  assert(c.ok, "out-of-range values clamp rather than erroring");
  if (!c.ok) return;
  assertEquals(c.d3.roof.leanToWidthFt, 16, "capped at the widest real lean-to");
  assertEquals(c.d3.roof.dormerOffsetU, -1, "held inside the span");
  assertEquals(c.d3.roof.leanToDropFt, 0, "a negative drop is zero, not a rise");

  // An unknown side is dropped rather than stored, so the renderer's default (right) wins.
  const s = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, leanToSide: "north" } });
  assert(s.ok && !("leanToSide" in s.d3.roof), "an unknown side never persists");
});

Deno.test("dormerType round-trips transom, defaults by ABSENCE, and drops junk", () => {
  // Carolyn, 2026-08-28 @52:43, naming the second shape: "we have two different dormers.
  // This one runs the pitch that way, the other works like a lean-to."
  //
  // This test exists because the sanitiser is a WHITELIST REBUILD: a key missing from the
  // list is dropped in silence, which to a builder is indistinguishable from "the save
  // didn't work". That is the failure the file's own warning is about, and it is only
  // catchable here.
  const t = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, dormerWidthFt: 4, dormerType: "transom" } });
  assert(t.ok, "a transom dormer should be accepted");
  if (!t.ok) return;
  assertEquals(t.d3.roof.dormerType, "transom");

  const g = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, dormerType: "gable" } });
  assert(g.ok && g.d3.roof.dormerType === "gable", "an explicit gable persists");

  // ABSENT IS THE DEFAULT, and it must stay absent rather than being written out. The
  // renderer tests `=== "transom"`, so an untouched row keeps its exact render -- and
  // emitting "gable" here would also break the deep-equal on `roof` above the first time
  // anyone opened and saved the calibration panel.
  const a = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, dormerWidthFt: 4 } });
  assert(a.ok && !("dormerType" in a.d3.roof), "an unset dormer type is never materialised");

  const j = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, dormerType: "hip" } });
  assert(j.ok && !("dormerType" in j.d3.roof), "an unknown dormer type never persists");
});

Deno.test("a style that mentions neither stays byte-identical", () => {
  // The whole back-compat claim in one assertion: adding five clamps and a side enum must
  // not put a single new key on a spec that did not ask for them.
  const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(r.ok, "minimal spec accepted");
  if (!r.ok) return;
  assertEquals(Object.keys(r.d3.roof).sort(), ["pitch", "type"]);
});

Deno.test("parseObservedNotes lifts the block, collapses newlines and caps length", () => {
  const o = parseObservedNotes(VIDEO_REPLY);
  assert(o !== null, "observed should parse");
  assertEquals(o!.roofNote, "Simple symmetric gable read from the rake edge against the sky.");
  assertEquals(o!.eave, "Exposed rafter tails, no fascia board");
  assertEquals(o!.confidence, "high");
});

Deno.test("parseObservedNotes drops junk rather than passing it through", () => {
  const o = parseObservedNotes(`{"roof":{"type":"gable"},"observed":{
    "doors":"${"x".repeat(400)}",
    "windows": 12,
    "confidence": "certain",
    "extra": "not a known key"
  }}`);
  assert(o !== null, "should still return the salvageable part");
  assertEquals(o!.doors!.length, 240, "capped");
  assert(!("windows" in o!), "a non-string value is dropped");
  assert(!("confidence" in o!), "an out-of-vocabulary confidence is dropped");
  assert(!("extra" in (o as Record<string, unknown>)), "unknown keys are dropped");
});

Deno.test("parseObservedNotes returns null when there is nothing to say", () => {
  assertEquals(parseObservedNotes(`{"roof":{"type":"gable"},"siding":null}`), null, "no observed block");
  assertEquals(parseObservedNotes("not json at all"), null);
  assertEquals(parseObservedNotes(`{"observed":{"doors":"   "}}`), null, "whitespace-only is nothing");
});

// ── Open eave / rafter tails / gable vent (2026-08-25) ────────────────────────────────
// The whole safety property of these three fields is that ABSENCE is the old behaviour.
// The test above at "a video reply parses to a clean spec" is an exact deep-equal on the
// roof object, so defaulting either roof field would fail it — that is the guard working,
// not a nuisance. Worse than a red test: openCalEditor seeds its draft from
// d3ResolveStyleSpec and onSaveSpec writes that draft straight back, so a default here
// gets PERSISTED into every tenant's column the first time a builder opens the 3D panel.

Deno.test("eave, tailSpacingIn and gableVent are omitted when absent, so no stored spec moves", () => {
  const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(r.ok, "minimal spec should be accepted");
  if (!r.ok) return;
  assert(!("eave" in r.d3.roof), "eave must not be defaulted into the roof object");
  assert(!("tailSpacingIn" in r.d3.roof), "tailSpacingIn must not be defaulted");
  assert(!("gableVent" in (r.d3 as Record<string, unknown>)), "gableVent must not be defaulted");
});

Deno.test("eave round-trips both values; junk is dropped without erroring", () => {
  for (const v of ["open", "fascia"]) {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, eave: v } });
    assert(r.ok, `${v} should be accepted`);
    if (r.ok) assertEquals(r.d3.roof.eave, v);
  }
  for (const junk of ["exposed", "", 1, null, {}]) {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, eave: junk } });
    assert(r.ok, "an unknown eave is dropped, never an error");
    if (r.ok) assert(!("eave" in r.d3.roof), `${JSON.stringify(junk)} must not persist`);
  }
});

Deno.test("tailSpacingIn clamps to real framing; gableVent widthFrac clamps to the triangle", () => {
  const a = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, tailSpacingIn: 400 }, gableVent: { widthFrac: 9 } });
  assert(a.ok, "out-of-range values clamp rather than reject");
  if (!a.ok) return;
  assertEquals(a.d3.roof.tailSpacingIn, 96, "96 in is looser than any real framing");
  assertEquals(a.d3.gableVent, { widthFrac: 0.6 });
  const b = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, tailSpacingIn: 1 }, gableVent: { widthFrac: 0 } });
  assert(b.ok, "still accepted");
  if (!b.ok) return;
  assertEquals(b.d3.roof.tailSpacingIn, 8);
  assert(!("gableVent" in (b.d3 as Record<string, unknown>)), "a zero-width vent is no vent");
});

Deno.test("the measured Urban spec survives the sanitiser intact", () => {
  // The actual values written to junior-barns' Urban row, as read off the walk-around
  // video. If a future clamp or key rename quietly drops one of these, this fails.
  const r = sanitizeD3Spec({
    roof: { type: "gable", pitch: 0.42, overhang: 1.0, eave: "open", tailSpacingIn: 24 },
    gableVent: { widthFrac: 0.25 },
    colors: { body: "#CDB794", trim: "#BBB29C", roof: "#46443F" },
  });
  assert(r.ok, "the measured spec must be accepted");
  if (!r.ok) return;
  // Key order matters here only because this file's assertEquals compares JSON strings:
  // the sanitiser emits the numeric loop first, so tailSpacingIn precedes the eave enum.
  assertEquals(r.d3.roof, { type: "gable", pitch: 0.42, overhang: 1, tailSpacingIn: 24, eave: "open" });
  assertEquals(r.d3.gableVent, { widthFrac: 0.25 });
});

Deno.test("foundation round-trips skids/slab, is omitted when absent, drops junk", () => {
  const bare = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(bare.ok, "minimal spec accepted");
  if (bare.ok) assert(!("foundation" in (bare.d3 as Record<string, unknown>)), "absent stays absent, so no existing row grows a slab it did not ask for");
  for (const v of ["skids", "slab"]) {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, foundation: v });
    assert(r.ok, `${v} accepted`);
    if (r.ok) assertEquals(r.d3.foundation, v);
  }
  for (const junk of ["piers", "", 3, null, {}]) {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, foundation: junk });
    assert(r.ok, "junk is dropped, never an error");
    if (r.ok) assert(!("foundation" in (r.d3 as Record<string, unknown>)), `${JSON.stringify(junk)} must not persist`);
  }
});

Deno.test("a full video reply carries the eave, vent and foundation through the sanitiser", () => {
  // The end-to-end shape of what VIDEO_SHAPE_PROMPT now asks for. If a future prompt edit
  // renames one of these keys, this fails here rather than silently producing drafts that
  // look right and set nothing — which is exactly what the prompt did before 2026-08-25,
  // when it predated all four fields.
  const r = parseModelSpec(`{
    "roof": { "type": "gable", "pitch": 0.42, "overhang": 1.0, "eave": "open", "tailSpacingIn": 24 },
    "gableVent": { "widthFrac": 0.25 },
    "foundation": "skids",
    "colors": { "body": "#CDB794", "trim": "#BBB29C", "roof": "#46443F" },
    "wallHeightFt": 7,
    "observed": { "confidence": "high" }
  }`);
  assert(r.ok, "the reply the prompt asks for must parse");
  if (!r.ok) return;
  assertEquals(r.d3.roof.eave, "open");
  assertEquals(r.d3.roof.tailSpacingIn, 24);
  assertEquals(r.d3.gableVent, { widthFrac: 0.25 });
  assertEquals(r.d3.foundation, "skids");
});

Deno.test("a video reply that saw none of it leaves every new field unset", () => {
  // "I could not see under the eave" and "there is no vent" must both come back as
  // ABSENCE, so the client merge keeps whatever the builder already had.
  const r = parseModelSpec(`{
    "roof": { "type": "gable", "pitch": 0.42, "overhang": 1.0 },
    "colors": {}, "wallHeightFt": 7,
    "observed": { "eave": "unclear", "vents": "none", "confidence": "low" }
  }`);
  assert(r.ok, "a partial read is still a valid spec");
  if (!r.ok) return;
  assert(!("eave" in r.d3.roof), "an unreadable eave must not default to fascia in the spec");
  assert(!("tailSpacingIn" in r.d3.roof), "spacing is meaningless without an open eave");
  assert(!("gableVent" in (r.d3 as Record<string, unknown>)), "no vent seen must mean no vent set");
  assert(!("foundation" in (r.d3 as Record<string, unknown>)), "an unseen base must not default to slab");
});

Deno.test("roofMaterial and the appendages survive a video reply", () => {
  // roofMaterial is the THIRD top-level field the draft merge dropped before anyone
  // noticed — the renderer textures the roof from it, so losing it shows shingles on a
  // metal building and reads as the model getting it wrong. Lean-to and dormer ride on
  // `roof`, so the spread merge already carried them; this pins that they survive the
  // SANITISER, which is the other place they could vanish.
  const r = parseModelSpec(`{
    "roof": { "type": "gable", "pitch": 0.4, "leanToWidthFt": 8, "leanToDropFt": 1.5,
              "leanToSide": "left", "dormerWidthFt": 4, "dormerRiseFt": 2, "dormerOffsetU": 0.5 },
    "roofMaterial": "metal", "colors": {}, "wallHeightFt": 8
  }`);
  assert(r.ok, "the reply the prompt asks for must parse");
  if (!r.ok) return;
  assertEquals(r.d3.roofMaterial, "metal");
  assertEquals(r.d3.roof.leanToWidthFt, 8);
  assertEquals(r.d3.roof.leanToSide, "left");
  assertEquals(r.d3.roof.dormerWidthFt, 4);
  const bare = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(bare.ok, "minimal spec accepted");
  if (bare.ok) assert(!("roofMaterial" in (bare.d3 as Record<string, unknown>)), "absent stays absent");
});

// ─── combinedShapePrompt ────────────────────────────────────────────────────────────────
// The claim being defended: a combined generation (2026-09-10) sends walk-around frames FIRST
// and the builder's staged photographs after them, and the model has to be told which is
// which. Before this function existed, `combined` was handed VIDEO_SHAPE_PROMPT verbatim,
// whose first sentence says every image is a consecutive frame of one orbit.

Deno.test("combinedShapePrompt: no frames means the video prompt is left exactly alone", () => {
  // The whole point of the videoCount===0 branch: a photos-only set has no walk to describe,
  // so inventing a two-source preamble for it would be its own lie.
  assertEquals(combinedShapePrompt(0, 4), VIDEO_SHAPE_PROMPT);
  assertEquals(combinedShapePrompt(-3, 4), VIDEO_SHAPE_PROMPT, "a negative count is not a walk");
  assertEquals(combinedShapePrompt(NaN, 4), VIDEO_SHAPE_PROMPT, "an unparseable count is not a walk");
});

Deno.test("combinedShapePrompt: the FALSE opening sentence is gone, not merely preceded", () => {
  // ⚠️ THE ONE THAT MATTERS. combinedShapePrompt splits on the first blank line and keeps the
  // remainder; if a future edit puts a blank line inside the opening paragraph, the split
  // lands early and the old claim survives INSIDE a prompt that also carries the new one —
  // strictly worse than not having fixed it, and completely invisible from the outside.
  const p = combinedShapePrompt(8, 4);
  assert(
    !p.includes("These images are frames from ONE continuous walk-around video"),
    "the old single-source claim must not survive anywhere in a combined prompt",
  );
  assert(p.startsWith("These images are all of ONE portable building"), "combined prompts open by naming two sources");
});

Deno.test("combinedShapePrompt: both counts are stated, and the body is carried over whole", () => {
  const p = combinedShapePrompt(8, 4);
  assert(p.includes("The FIRST 8 images are frames"), "the frame count is stated");
  assert(p.includes("The REMAINING 4 images are photographs"), "the photo count is stated");
  assert(p.includes("prefer them wherever the two disagree"), "staged photos are named as the tie-break");
  // Carried over from VIDEO_SHAPE_PROMPT rather than re-copied. If any of these go missing the
  // split ate part of the spec, and the model would be asked for a shape it was never shown.
  assert(p.includes('"roof": {'), "the JSON shape survives the splice");
  assert(p.includes("How to read it:"), "the reading instructions survive the splice");
  assert(p.includes('"observed"'), "the observed block survives the splice");
  assert(p.includes("Estimate conservatively."), "the closing instruction survives the splice");
  assert(p.length > VIDEO_SHAPE_PROMPT.length - 400, "a splice that shortened the prompt by a lot ate something");
});

Deno.test("combinedShapePrompt: singulars, and a walk with no photos beside it", () => {
  const one = combinedShapePrompt(1, 1);
  assert(one.includes("The FIRST 1 image is a frame"), "one frame reads as singular");
  assert(one.includes("The REMAINING 1 image is a photograph"), "one photo reads as singular");
  // videoCount>0 with photoCount 0 is reachable: the client budgets 12 and a builder could in
  // principle generate from frames alone. It must not promise photographs that are not there.
  const none = combinedShapePrompt(8, 0);
  assert(!none.includes("REMAINING"), "no staged photos means no clause about them");
  assert(none.includes("The FIRST 8 images are frames"), "the walk is still described");
});

// ─── the porch the renderer could always draw ───────────────────────────────────────────
// A recessed gable-end porch has been in D3_NUM_RANGES, sanitizeD3Spec, buildShed3DModel and
// the calibration form since the appendages shipped. The PROMPT never asked for it, so the AI
// path could not produce one: Ahsan filmed a porch shed on 2026-09-10 and got a plain gable box
// back. Nothing was broken; the model simply had no field to report it in.

Deno.test("the shape-first prompt ASKS for a porch, not just a lean-to", () => {
  for (const [name, p] of [["VIDEO_SHAPE_PROMPT", VIDEO_SHAPE_PROMPT], ["combinedShapePrompt", combinedShapePrompt(8, 4)]] as const) {
    assert(p.includes('"porchDepthFt"'), `${name} must ask for porchDepthFt`);
    assert(p.includes('"porchEnd"'), `${name} must ask for porchEnd`);
    assert(/PORCH:/.test(p), `${name} must explain what a porch is`);
    // The distinction that makes it usable. A lean-to projects OUT from a long side; a porch is
    // recessed INTO a gable end under the same ridge. Told only about the lean-to, a model
    // reports a porch shed as a lump on the wrong side of the wrong wall.
    assert(/GABLE END/.test(p), `${name} must say a porch is at the gable end`);
    assert(p.includes("that is not a lean-to"), `${name} must tell the model NOT to call a gable-end porch a lean-to`);
  }
});

Deno.test("a porch survives the sanitiser, and its bounds hold", () => {
  const r = parseModelSpec(`{
    "roof": { "type": "gable", "pitch": 0.4, "porchDepthFt": 8, "porchEnd": "front" },
    "colors": {}, "wallHeightFt": 8
  }`);
  assert(r.ok, "a porch reply must parse");
  if (!r.ok) return;
  assertEquals(r.d3.roof.porchDepthFt, 8);
  assertEquals(r.d3.roof.porchEnd, "front");
  // Clamped, not rejected — the renderer clamps again against the real building, so an
  // over-deep porch must not throw the whole draft away.
  const big = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchDepthFt: 40, porchEnd: "back" } });
  assert(big.ok, "an over-deep porch is clamped, not refused");
  if (big.ok) {
    assertEquals(big.d3.roof.porchDepthFt, 12);
    assertEquals(big.d3.roof.porchEnd, "back");
  }
  // Absent stays absent: an enclosed building must not gain a porch by default.
  const plain = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(plain.ok, "a plain gable still parses");
  if (plain.ok) assert(!("porchDepthFt" in (plain.d3.roof as Record<string, unknown>)), "no porch unless one was reported");
});

Deno.test("the porch truss round-trips, and absent stays absent", () => {
  // The decorative king-post frame over the porch. A BOOLEAN, which is why it is handled beside
  // porchEnd rather than in the numeric loop — clamped() destructures CLAMPS[key] and throws on
  // a key with no entry, so putting it in that list would take the whole sanitiser down.
  const r = parseModelSpec(`{
    "roof": { "type": "gable", "pitch": 0.42, "porchDepthFt": 6, "porchEnd": "front", "porchTruss": true },
    "colors": {}, "wallHeightFt": 7
  }`);
  assert(r.ok, "a truss reply must parse");
  if (r.ok) assertEquals(r.d3.roof.porchTruss, true);

  // ABSENT MEANS NO TRUSS, and that is what keeps every style saved before today rendering
  // exactly as it did — the renderer tests the value as truthy.
  const plain = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchDepthFt: 6 } });
  assert(plain.ok, "a porch with no truss key still parses");
  if (plain.ok) assert(!("porchTruss" in (plain.d3.roof as Record<string, unknown>)), "no truss unless one was reported");

  // Junk is dropped rather than coerced: "true" the string must not become true the boolean,
  // or a model that answers in prose silently grows timber on every building.
  const junk = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchTruss: "yes" } });
  assert(junk.ok, "junk does not fail the whole spec");
  if (junk.ok) assert(!("porchTruss" in (junk.d3.roof as Record<string, unknown>)), "only a real boolean is stored");

  // And false is STORED, not dropped, so a builder who unticks it is remembered.
  const off = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchTruss: false } });
  assert(off.ok, "false parses");
  if (off.ok) assertEquals(off.d3.roof.porchTruss, false);
});

Deno.test("the shape-first prompt asks about the porch truss", () => {
  for (const [name, p] of [["VIDEO_SHAPE_PROMPT", VIDEO_SHAPE_PROMPT], ["combinedShapePrompt", combinedShapePrompt(4, 8)]] as const) {
    assert(p.includes('"porchTruss"'), `${name} must ask for porchTruss`);
    assert(/PORCH TRUSS:/.test(p), `${name} must explain what one looks like`);
    // The distinguishing detail. Without it a model reports any gable above a porch as framed.
    assert(p.includes("porchTruss false"), `${name} must say a plain gable is false`);
  }
});
