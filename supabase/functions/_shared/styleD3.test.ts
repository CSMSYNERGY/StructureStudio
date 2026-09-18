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

import {
  sanitizePhotoUrls, parseModelSpec, parseObservedNotes, sanitizeD3Spec, combinedShapePrompt, VIDEO_SHAPE_PROMPT,
  SPEC_PROMPT, gambrelRoofWarning, flagObservedNotes, GAMBREL_MIN_BEND_DEG, modelReplyText,
  foldOverhangInches, porchAgreementWarning, draftPorchKind, OBSERVED_PORCH_KINDS,
  videoShapePrompt, parseKnownDims, applyKnownDims, knownDimsNote,
} from "./styleD3.ts";
import type { KnownDims } from "./styleD3.ts";

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

Deno.test("roofProfile: both metal profiles round-trip, absent stays absent, junk is dropped", () => {
  // Absent is every row that predates the key and it must STAY absent: the renderer reads
  // absent as AG Panel, and a default written here would pin each tenant's column to whatever
  // the default was on the day they saved. The editor only ever sends "standingseam" or null.
  const absent = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, roofMaterial: "metal" });
  assert(absent.ok && !("roofProfile" in absent.d3), "absent stays absent");
  for (const id of ["agpanel", "standingseam"]) {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, roofMaterial: "metal", roofProfile: id });
    assert(r.ok, `${id} should be accepted`);
    if (r.ok) assertEquals(r.d3.roofProfile, id, `${id} must survive the round trip`);
  }
  for (const junk of ["Standing Seam", "corrugated", "", 3, null, { id: "agpanel" }]) {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, roofProfile: junk });
    assert(r.ok && !("roofProfile" in r.d3), `${JSON.stringify(junk)} must not persist`);
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
  // The CLOSING instruction, whatever it currently says. It changed on 2026-09-19 — the old
  // "use a typical value" was the mechanism behind every zero-variance wrong answer — and what
  // this assertion is for is unchanged: the splice must not eat the last paragraph.
  assert(p.includes("Do not fill a field with the middle of its stated range."), "the closing instruction survives the splice");
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

// ─── the gambrel that drew as a gable (2026-09-16) ─────────────────────────────────────────
// A walk-around of a lofted barn drafted kneeU 0.55 / kneeRise 0.35 / ridgeRise 0.75: both
// slopes within two degrees of each other, so the render was a plain gable. The head-on frame
// measured 0.75 / 0.72 / 1.03. The prompts never said kneeU is measured from the CENTRELINE,
// and a model measures in from the eave by default.

const DRAFTED_0916 = { type: "gambrel", kneeU: 0.55, kneeRise: 0.35, ridgeRise: 0.75 };
const MEASURED_0916 = { type: "gambrel", kneeU: 0.75, kneeRise: 0.72, ridgeRise: 1.03 };

Deno.test("every prompt says kneeU is measured from the CENTRELINE, and what a gambrel looks like", () => {
  for (const [name, p] of [
    ["SPEC_PROMPT", SPEC_PROMPT],
    ["VIDEO_SHAPE_PROMPT", VIDEO_SHAPE_PROMPT],
    ["combinedShapePrompt", combinedShapePrompt(8, 4)],
  ] as const) {
    const kneeU = p.split("\n").find((l) => l.includes('"kneeU"')) ?? "";
    assert(kneeU.includes("CENTRELINE"), `${name}: kneeU must name the centreline as its datum`);
    assert(kneeU.includes("NOT measured in from the eave"), `${name}: kneeU must rule out the eave datum`);
    assert(kneeU.includes("0.7-0.85"), `${name}: kneeU must give the typical near-the-wall range`);
    // The knee's height had no datum either, and the 09-16 draft had it at half the real value.
    const kneeRise = p.split("\n").find((l) => l.includes('"kneeRise"')) ?? "";
    assert(kneeRise.includes("TOP OF THE WALL"), `${name}: kneeRise must be measured from the top of the wall`);
    assert(/STEEP lower slope/.test(p) && /SHALLOW upper slope/.test(p), `${name}: must describe a real gambrel's two slopes`);
    // The old phrase is the bug. It must not survive anywhere, or a model gets two datums.
    assert(!p.includes("where the lower slope breaks"), `${name}: the old datum-less wording is gone`);
  }
});

Deno.test("the shape-first prompt's worked gambrel example is itself a gambrel", () => {
  // A worked example that fails the very check it teaches would train the defect in.
  const m = VIDEO_SHAPE_PROMPT.match(/kneeU (\d\.\d+), kneeRise (\d\.\d+), ridgeRise (\d\.\d+)/);
  assert(m, "the GAMBREL NUMBERS paragraph carries a worked example");
  if (!m) return;
  const roof = { type: "gambrel", kneeU: Number(m[1]), kneeRise: Number(m[2]), ridgeRise: Number(m[3]) };
  assertEquals(gambrelRoofWarning(roof), null, "the example passes the check");
  assert(combinedShapePrompt(8, 0).includes(m[0]), "the combined prompt carries the same example");
});

Deno.test("gambrelRoofWarning flags the 09-16 draft and passes the measured barn", () => {
  const w = gambrelRoofWarning(DRAFTED_0916);
  assert(w && w.includes("plain gable"), "the flat draft is flagged in plain words");
  assertEquals(gambrelRoofWarning(MEASURED_0916), null, "the measured roof passes");
});

Deno.test("a bare 'lower steeper than upper' would have PASSED the 09-16 draft, which is why there is a margin", () => {
  const { kneeU, kneeRise, ridgeRise } = DRAFTED_0916;
  const lower = kneeRise / (1 - kneeU), upper = (ridgeRise - kneeRise) / kneeU;
  assert(lower > upper, `the literal inequality holds (${lower.toFixed(3)} > ${upper.toFixed(3)}) and catches nothing`);
  assert(GAMBREL_MIN_BEND_DEG >= 10, "the bend floor is a real margin, not a rounding guard");
  assert(gambrelRoofWarning(DRAFTED_0916), "the bend check catches it anyway");
});

Deno.test("gambrelRoofWarning judges what the RENDERER draws, defaults included", () => {
  // d3RoofProfile reads `kneeU || 0.55`, `kneeRise || 0.55`, `ridgeRise || 0.8`, and that is a
  // 26-degree bend. A gambrel with no knee keys, or with zeros, draws like that and must pass.
  assertEquals(gambrelRoofWarning({ type: "gambrel" }), null, "absent keys draw the default, which is fine");
  assertEquals(gambrelRoofWarning({ type: "gambrel", kneeU: 0, kneeRise: 0, ridgeRise: 0 }), null, "zeros draw the default too");
  assertEquals(gambrelRoofWarning({ type: "gambrel", kneeU: 0.55, kneeRise: 0.55, ridgeRise: 0.8, overhang: 0.5 }), null, "farmland's built-in spec passes");
  // A knee right above the wall is a vertical lower slope: steep, not undefined.
  assertEquals(gambrelRoofWarning({ type: "gambrel", kneeU: 1, kneeRise: 0.6, ridgeRise: 1 }), null, "kneeU 1 is a vertical lower slope");
  // A zero kneeU renders at 0.55, so it is judged there: 0.55 / 0.35 / 0.75 is the flat draft.
  assert(gambrelRoofWarning({ type: "gambrel", kneeU: 0, kneeRise: 0.35, ridgeRise: 0.75 }), "a zero kneeU is judged at the default it draws");
});

Deno.test("gambrelRoofWarning catches an inside-out roof the angle test alone would pass", () => {
  // Ridge below the knee makes the upper "slope" negative, which scores as a huge bend.
  const w = gambrelRoofWarning({ type: "gambrel", kneeU: 0.75, kneeRise: 0.9, ridgeRise: 0.5 });
  assert(w && w.includes("Ridge rise has to be higher than Knee rise"), "a ridge below the knee is flagged");
  assert(gambrelRoofWarning({ type: "gambrel", kneeU: 0.75, kneeRise: 0.7, ridgeRise: 0.7 }), "a ridge level with the knee is flagged");
  // Upper steeper than lower is not a gambrel either.
  assert(gambrelRoofWarning({ type: "gambrel", kneeU: 0.3, kneeRise: 0.2, ridgeRise: 1.2 }), "an upside-down bend is flagged");
});

Deno.test("gambrelRoofWarning leaves every other roof alone", () => {
  assertEquals(gambrelRoofWarning({ type: "gable", pitch: 0.42, kneeU: 0.55, kneeRise: 0.35, ridgeRise: 0.75 }), null, "stray knee keys on a gable are not a gambrel");
  assertEquals(gambrelRoofWarning({ type: "shed", pitch: 0.25 }), null);
  assertEquals(gambrelRoofWarning(null), null);
  assertEquals(gambrelRoofWarning(undefined), null);
});

Deno.test("flagObservedNotes puts the warning first, keeps the model's note, and forces low confidence", () => {
  const notes = { roofNote: "Gambrel with a porch roof on the front.", doors: "one, gable end", confidence: "high" };
  assertEquals(flagObservedNotes(notes, null), notes, "no warning leaves the notes untouched");
  assertEquals(flagObservedNotes(null, null), null, "no notes and no warning stays null");

  const w = gambrelRoofWarning(DRAFTED_0916)!;
  const flagged = flagObservedNotes(notes, w)!;
  assert(flagged.roofNote!.startsWith(w), "the warning leads");
  assert(flagged.roofNote!.endsWith("The model's own reading: Gambrel with a porch roof on the front."), "the model's sentence is kept");
  assertEquals(flagged.confidence, "low", "low is what turns the panel's confidence line amber");
  assertEquals(flagged.doors, "one, gable end", "the other notes ride along");
  assertEquals(notes.confidence, "high", "the input is not mutated");

  // A reply with no observed block still gets the warning somewhere the builder will see it.
  assertEquals(flagObservedNotes(null, w), { roofNote: w, confidence: "low" });

  // Bounded: our fixed warning plus the model's note, which parseObservedNotes caps at 240.
  const long = parseObservedNotes(JSON.stringify({ observed: { roofNote: "x".repeat(1000) } }));
  assert(flagObservedNotes(long, w)!.roofNote!.length <= w.length + 26 + 240, "the flagged note stays bounded");
});

Deno.test("a flagged draft still parses to the spec the builder reviews: nothing is repaired", () => {
  const r = parseModelSpec(JSON.stringify({ roof: DRAFTED_0916, colors: {}, wallHeightFt: 8 }));
  assert(r.ok, "the flat draft parses");
  if (!r.ok) return;
  assertEquals(r.d3.roof, DRAFTED_0916, "the numbers reach the builder exactly as drafted");
});

// ─── modelReplyText: reading the whole reply, not its first block (2026-09-17) ─────────────
// The model thinks adaptively by default. When it does, the reply opens with a `thinking`
// block whose visible text is empty, and the old `content[0].text ?? ""` handed the parser an
// empty string: "The model did not return a spec." on a reply that contained a good one. These
// fixtures are shaped like Messages API replies; the thinking text is empty and the signature is
// an opaque placeholder, as the API returns them by default.
const THINKING_FIRST_REPLY = {
  type: "message",
  role: "assistant",
  content: [
    { type: "thinking", thinking: "", signature: "sig-placeholder" },
    { type: "text", text: VIDEO_REPLY },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 12000, output_tokens: 1450 },
};

Deno.test("REGRESSION: the old content[0] read turns a thinking-first reply into 'did not return a spec'", () => {
  // Exactly what portal-settings did before this fix. Kept as a test so the failure stays
  // reproducible from the fixture rather than from memory.
  // deno-lint-ignore no-explicit-any
  const oldText = (THINKING_FIRST_REPLY as any)?.content?.[0]?.text ?? "";
  const old = parseModelSpec(oldText);
  assert(!old.ok, "the old path must fail on this fixture, or the fixture no longer reproduces the bug");
  if (old.ok) return;
  assertEquals(old.error, "The model did not return a spec.");
});

Deno.test("modelReplyText: a thinking-first reply yields the text block, which parses", () => {
  const reply = modelReplyText(THINKING_FIRST_REPLY);
  const r = parseModelSpec(reply.text);
  assert(r.ok, "the spec after the thinking block must parse");
  if (!r.ok) return;
  assertEquals(r.d3.roof, { type: "gable", pitch: 0.42, ridgeOffset: 0, overhang: 1 });
  // portal-settings reads `observed` from the same joined text, so it must survive too.
  assertEquals(parseObservedNotes(reply.text)?.confidence, "high");
  assertEquals(reply.stopReason, "end_turn");
  assertEquals(reply.blockTypes, ["thinking", "text"]);
  assertEquals(reply.outputTokens, 1450);
});

Deno.test("modelReplyText: thinking that used the whole budget is empty text with stop_reason max_tokens", () => {
  const reply = modelReplyText({
    content: [{ type: "thinking", thinking: "", signature: "sig-placeholder" }],
    stop_reason: "max_tokens",
    usage: { output_tokens: 8000 },
  });
  assertEquals(reply.text, "");
  assertEquals(reply.stopReason, "max_tokens");
  assertEquals(reply.blockTypes, ["thinking"]);
  assertEquals(reply.outputTokens, 8000);
  // The parser's sentence is unchanged; the CALLER uses stopReason to give it its own code.
  const r = parseModelSpec(reply.text);
  assert(!r.ok, "an empty answer does not parse");
});

Deno.test("modelReplyText: a refusal with empty content has no text and no blocks", () => {
  const reply = modelReplyText({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null } });
  assertEquals(reply.text, "");
  assertEquals(reply.stopReason, "refusal");
  assertEquals(reply.blockTypes, []);
  assertEquals(reply.outputTokens, null, "no usage means null, not zero");
});

Deno.test("modelReplyText: several text blocks are joined in order", () => {
  const reply = modelReplyText({
    content: [
      { type: "text", text: '{"roof": {"type": "gable", ' },
      { type: "thinking", thinking: "", signature: "sig-placeholder" },
      { type: "text", text: '"pitch": 0.4}}' },
    ],
    stop_reason: "end_turn",
  });
  assertEquals(reply.text, '{"roof": {"type": "gable", "pitch": 0.4}}');
  assertEquals(reply.blockTypes, ["text", "thinking", "text"]);
  const r = parseModelSpec(reply.text);
  assert(r.ok, "the joined text parses");
});

Deno.test("modelReplyText: junk in, empty shapes out, never a throw", () => {
  for (const junk of [null, undefined, "text", 42, [], {}, { content: "nope" }, { content: [null, 7, { type: 3 }] }]) {
    const reply = modelReplyText(junk);
    assertEquals(reply.text, "", `no text from ${JSON.stringify(junk)}`);
    assertEquals(reply.stopReason, null);
    assertEquals(reply.outputTokens, null);
  }
  // Unknown or malformed blocks are named "unknown" rather than dropped, so the log still
  // shows how many there were. A text block whose text is not a string contributes nothing.
  assertEquals(modelReplyText({ content: [null, { type: 3 }] }).blockTypes, ["unknown", "unknown"]);
  assertEquals(modelReplyText({ content: [{ type: "text", text: 5 }] }).text, "");
  // The logged list is capped, so a pathological reply cannot bloat an app_errors row.
  const many = modelReplyText({ content: Array.from({ length: 30 }, () => ({ type: "text", text: "x" })) });
  assertEquals(many.blockTypes.length, 8);
  assertEquals(many.text.length, 30, "the cap is on the LOG, never on the answer");
});

// ─── the projecting porch, the plate band and the wood colour (2026-09-17) ─────────────────
// A porch that STANDS OUT in front of a gable end under its own lower roof, instead of being cut
// into it. It is a new key, porchOutFt, rather than porchDepthFt with a flag, because the older
// renderer reads porchDepthFt and would set the end wall back into the building. The sanitizer
// is a whitelist rebuild, so every one of these keys is dropped in silence unless it is listed,
// and a silent drop looks to a builder exactly like "the save did not work".

Deno.test("a projecting-porch reply keeps porchOutFt, porchEnd and the wood colour", () => {
  const r = parseModelSpec(`{
    "roof": { "type": "gambrel", "kneeU": 0.72, "kneeRise": 0.72, "ridgeRise": 1.0, "overhang": 0.15,
              "porchOutFt": 6.5, "porchEnd": "front" },
    "colors": { "body": "#EEEBE0", "trim": "#686C70", "roof": "#5F6266", "wood": "#C4965A" },
    "wallHeightFt": 9
  }`);
  assert(r.ok, "a projecting-porch reply must parse");
  if (!r.ok) return;
  assertEquals(r.d3.roof.porchOutFt, 6.5, "porchOutFt survives");
  assertEquals(r.d3.roof.porchEnd, "front", "porchEnd survives beside a projecting porch");
  assertEquals(r.d3.colors.wood, "#C4965A", "the wood colour survives");
  assertEquals(r.d3.wallHeightFt, 9);
  assert(!("porchDepthFt" in r.d3.roof), "no recessed porch appears out of nowhere");
});

Deno.test("a projecting porch drops the recessed porch's depth and truss; an off one does not", () => {
  // Storing both would make production, which reads only porchDepthFt, draw a recessed porch
  // into a building that has a projecting one.
  const on = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchDepthFt: 6, porchTruss: true, porchOutFt: 6 } });
  assert(on.ok, "both kinds at once is resolved, not refused");
  if (on.ok) assertEquals(on.d3.roof, { type: "gable", pitch: 0.4, porchOutFt: 6 }, "the projecting porch wins");

  // At 0.5 or below the projecting porch is off, so the recessed one is left exactly alone.
  // porchOutFt is appended AFTER porchDepthFt in the numeric list, so existing key order holds.
  const low = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchDepthFt: 6, porchTruss: true, porchOutFt: 0.4 } });
  assert(low.ok, "an off projecting porch parses");
  if (low.ok) assertEquals(low.d3.roof, { type: "gable", pitch: 0.4, porchDepthFt: 6, porchOutFt: 0.4, porchTruss: true });
  const zero = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchDepthFt: 6, porchTruss: true, porchOutFt: 0 } });
  assert(zero.ok, "a zero projecting porch parses");
  if (zero.ok) assertEquals(zero.d3.roof, { type: "gable", pitch: 0.4, porchDepthFt: 6, porchOutFt: 0, porchTruss: true });

  // porchEnd is shared by both kinds, so the exclusion must not take it.
  const end = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchDepthFt: 6, porchOutFt: 6, porchEnd: "back" } });
  assert(end.ok && end.d3.roof.porchEnd === "back", "porchEnd survives the exclusion");
});

Deno.test("porchOutFt clamps to 0..12, reads a numeric string, drops junk and stays absent", () => {
  const out = (v: unknown) => {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchOutFt: v } });
    assert(r.ok, "the roof is valid, so the spec is accepted whatever porchOutFt says");
    return r.ok ? r.d3.roof : {};
  };
  assertEquals(out(40).porchOutFt, 12, "clamped to the deepest porch anyone sells");
  assertEquals(out(-3).porchOutFt, 0, "a negative projection is no porch, not an error");
  assert(!("porchOutFt" in out("six")), "a word is dropped");
  assertEquals(out("6").porchOutFt, 6, "a numeric string reads as its number, like every other clamp");
  const absent = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(absent.ok && !("porchOutFt" in absent.d3.roof), "no porch unless one was reported");
});

Deno.test("plateBand round-trips as a real boolean only, and absent stays absent", () => {
  const band = (v: unknown) => {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, plateBand: v } });
    assert(r.ok, "plateBand never fails the spec");
    return r.ok ? r.d3.roof : {};
  };
  assertEquals(band(true).plateBand, true);
  assertEquals(band(false).plateBand, false, "false is stored, not dropped");
  assert(!("plateBand" in band("yes")), "a string is not a boolean");
  const absent = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 } });
  assert(absent.ok && !("plateBand" in absent.d3.roof), "no band unless one was asked for");
});

Deno.test("colors.wood keeps a hex and drops anything else without failing the spec", () => {
  const wood = (v: unknown) => {
    const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, colors: { body: "#EEEBE0", wood: v } });
    assert(r.ok, `a wood colour of ${JSON.stringify(v)} must not fail the spec`);
    return r.ok ? r.d3.colors : {};
  };
  assertEquals(wood("#C4965A").wood, "#C4965A");
  for (const junk of ["tan", "url(x)", 12]) {
    const c = wood(junk);
    assert(!("wood" in c), `${JSON.stringify(junk)} must not persist`);
    assertEquals(c.body, "#EEEBE0", "the other colours ride along");
  }
  // The renderer has its own fallback. Writing it here would pin every tenant's column to it.
  const absent = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4 }, colors: { body: "#EEEBE0" } });
  assert(absent.ok && !("wood" in absent.d3.colors), "no wood colour is ever defaulted");
});

Deno.test("porchRoofPitch is not a key: it is dropped like any other unknown", () => {
  // Designed, then cut from this change. The renderer asks for 2:12 and lowers it for headroom.
  // If it is ever added, it is added on purpose and this test changes with it.
  const r = sanitizeD3Spec({ roof: { type: "gable", pitch: 0.4, porchOutFt: 6, porchRoofPitch: 0.25 } });
  assert(r.ok, "an unknown key never fails the spec");
  if (r.ok) assert(!("porchRoofPitch" in r.d3.roof), "porchRoofPitch must not persist");
});

Deno.test("the shape-first prompt tells a projecting porch from a recessed one", () => {
  // Before this, a porch standing in front of a gable end under its own roof had nowhere to go but
  // porchDepthFt, which draws the end wall set back INTO the building under the main roof.
  for (const [name, p] of [["VIDEO_SHAPE_PROMPT", VIDEO_SHAPE_PROMPT], ["combinedShapePrompt", combinedShapePrompt(8, 4)]] as const) {
    assert(p.includes('"porchOutFt"'), `${name} must ask for porchOutFt`);
    assert(/PROJECTING PORCH:/.test(p), `${name} must explain what a projecting porch is`);
    assert(p.includes("its own separate roof"), `${name} must name the separate roof that tells the two kinds apart`);
    assert(p.includes("leave porchDepthFt and porchTruss out"), `${name} must say a porch is one kind or the other`);
    // The recessed porch is still asked for, word for word where other tests and drafts rely on it.
    assert(p.includes('"porchDepthFt"'), `${name} must still ask for porchDepthFt`);
    assert(p.includes('"porchEnd"'), `${name} must still ask for porchEnd`);
    assert(/PORCH:/.test(p), `${name} must still explain the recessed porch`);
    assert(/GABLE END/.test(p), `${name} must still place a porch at the gable end`);
    assert(p.includes("that is not a lean-to"), `${name} must still rule out calling a gable-end porch a lean-to`);
    // Cut from this change: the renderer picks the porch pitch, so the model is not asked for one.
    assert(!p.includes("porchRoofPitch"), `${name} must not ask for porchRoofPitch`);
  }
});

Deno.test("only the walk-around prompt learned about the projecting porch", () => {
  // SPEC_PROMPT is the photo path and asks for no appendages at all; the band and the wood colour
  // are the builder's settings, not something to read off a video.
  assert(!SPEC_PROMPT.includes("porchOutFt"), "SPEC_PROMPT is unchanged");
  for (const [name, p] of [["VIDEO_SHAPE_PROMPT", VIDEO_SHAPE_PROMPT], ["combinedShapePrompt", combinedShapePrompt(8, 4)]] as const) {
    assert(!p.includes("plateBand"), `${name} must not ask for plateBand`);
    assert(!p.includes('"wood"'), `${name} must not ask for a wood colour`);
  }
  // The JSON shape is still valid JSON-with-placeholders: the line before porchOutFt gained its comma.
  assert(VIDEO_SHAPE_PROMPT.includes("porch opening>,\n"), "porchTruss is no longer the last roof key");
});

// ─── the answers that never varied (2026-09-19) ───────────────────────────────────────────
// Three findings off 19 recorded generations, one prompt paragraph behind each:
//
//   * `overhang` came back EXACTLY 1.0 in 53 % of them, and in 3 of 3 on a building whose eave
//     measures 0.15 ft. 1.0 is the top of "typically 0.3-1.5". Zero variance at a wrong value
//     is the signature of a default, not of a measurement.
//   * `porchOutFt` came back 0 times in 19, on a lot where a deck and posts in front of the
//     gable end are ordinary. Two replies said "recessed"; one said there was no porch at all.
//   * The prompt ENDED by telling the model to default: "use a typical value". That one
//     sentence explains every zero-variance answer at once, including wall height 7 (inside
//     6-10) and porch depth 6 (the exact midpoint of 4-8).
//
// These tests pin the three paragraphs that changed and the two server halves that read them.
// SPEC_PROMPT is deliberately NOT in this list: the photo path feeds the scan card, which
// replaces the AI's roof with a measured one, and it is out of scope for this change.
const SHAPE_FIRST = [
  ["VIDEO_SHAPE_PROMPT", VIDEO_SHAPE_PROMPT],
  ["combinedShapePrompt", combinedShapePrompt(8, 4)],
] as const;

Deno.test("no prompt still offers a middle overhang to answer", () => {
  // Across ALL THREE, including the photo path: the range whose top came back 53 % of the time.
  for (const [name, p] of [["SPEC_PROMPT", SPEC_PROMPT], ...SHAPE_FIRST] as const) {
    assert(!p.includes("typically 0.3-1.5"), `${name}: the range whose top was answered 53 % of the time is gone`);
  }
  for (const [name, p] of SHAPE_FIRST) {
    assert(!p.includes("use a typical value"), `${name}: the instruction to default is gone`);
    assert(!p.includes('"overhang":'), `${name}: the feet key is not asked for any more`);
  }
});

Deno.test("the overhang is asked in inches, with the flush case named and 0 an ordinary answer", () => {
  for (const [name, p] of SHAPE_FIRST) {
    assert(p.includes('"overhangIn"'), `${name} must ask for overhangIn`);
    const line = p.split("\n").find((l) => l.includes('"overhangIn"')) ?? "";
    assert(line.includes("inches"), `${name}: the schema line must say inches`);
    assert(line.includes("0 to 36"), `${name}: the schema line must give the 0 floor and a ceiling`);
    assert(/OVERHANG:/.test(p), `${name} must still explain how to read it`);
    assert(p.includes("in INCHES"), `${name}: the paragraph must say inches too, not only the schema line`);
    // The flush eave named PHYSICALLY. "0" on its own is not a thing a model looks for; a wall
    // with no shadow under the roof edge is.
    assert(p.includes("the wall running straight up into the roof edge"), `${name} must describe a flush eave`);
    assert(p.includes("no shadow under it"), `${name} must give the flush eave its giveaway`);
    assert(p.includes("0 is a real answer"), `${name} must say 0 is an answer, not a failure to measure`);
    assert(p.includes("as common as one with a deep eave"), `${name} must say flush is as ordinary as deep`);
    assert(p.includes("2 inches and 16 inches are both common answers"), `${name} must say the two ends look nothing alike`);
  }
});

Deno.test("the closing paragraph asks for an OMISSION, not a typical value", () => {
  for (const [name, p] of SHAPE_FIRST) {
    assert(p.includes("say so in observed and OMIT the key"), `${name} must ask for the key to be left out`);
    // Safe because absence already means "keep what is stored": three tests above pin it
    // ("eave, tailSpacingIn and gableVent are omitted when absent", "a video reply that saw
    // none of it", "a style that mentions neither stays byte-identical").
    assert(p.includes("leaves the builder's existing setting alone"), `${name} must say why omitting is the better answer`);
    assert(p.includes("Do not fill a field with the middle of its stated range"), `${name} must forbid the midpoint outright`);
  }
});

Deno.test("both shape-first prompts force a three-way porch answer", () => {
  for (const [name, p] of SHAPE_FIRST) {
    assert(p.includes('"porch": "projecting" | "recessed" | "none"'), `${name} must carry the porch key in observed`);
    assert(/PORCH DECISION, REQUIRED:/.test(p), `${name} must say the answer is required`);
    for (const kind of OBSERVED_PORCH_KINDS) {
      assert(p.includes(`"${kind}"`), `${name} must name ${kind} as one of the three answers`);
    }
    // The two escapes a model takes when a question is merely asked rather than required.
    assert(p.includes('Answer it even when the answer is "none"'), `${name} must close the "nothing to report" escape`);
    assert(p.includes("answer it even when you are unsure"), `${name} must close the "I am not sure" escape`);
    assert(p.includes("Naming a porch obliges you to give its field"), `${name} must tie the word to the number`);
  }
});

Deno.test("the false-positive deck sentence is gone from the recessed porch", () => {
  // "Look for the floor deck continuing past the front wall to the posts" described a
  // PROJECTING porch exactly as well as a recessed one - a deck out to the posts is what a
  // projecting porch IS - so it read as evidence for whichever kind the model reached first,
  // and the recorded history reached "recessed" twice and "projecting" never. Not pinned by
  // any test when it was cut. What replaces it are discriminators a GROUND-LEVEL walk can see.
  for (const [name, p] of SHAPE_FIRST) {
    assert(!p.includes("floor deck continuing past the front wall"), `${name}: the ambiguous sentence is gone`);
    assert(p.includes("the end wall runs UNBROKEN from the floor to the top of the wall"), `${name}: the unbroken end wall`);
    assert(p.includes("the porch ceiling is nearly level"), `${name}: the porch ceiling against the main slope`);
    assert(p.includes("sticks out PAST the end of the building"), `${name}: what it looks like from the side`);
    // The recessed porch keeps the discriminator that is genuinely its own.
    assert(p.includes("standing BACK from the end of the roof"), `${name}: the recessed porch's set-back wall survives`);
  }
});

Deno.test("the door the wall is measured against is a real door", () => {
  // 6.5 ft is not a door height anyone builds. A residential door is 6 ft 8 in, and it is the
  // scale for everything else in a ground-level frame.
  for (const [name, p] of SHAPE_FIRST) {
    assert(p.includes("a door is about 6 ft 8 in"), `${name} measures against a real door`);
    assert(!p.includes("about 6.5 ft"), `${name}: the old anchor is gone`);
  }
});

Deno.test("the photo-only path is untouched by any of this", () => {
  // Out of scope, deliberately (brief section 8). The scan card replaces the AI's roof with a
  // measured one and never reads `observed`, so nothing here would reach a builder.
  assert(!SPEC_PROMPT.includes("overhangIn"), "SPEC_PROMPT still asks in feet");
  assert(SPEC_PROMPT.includes('"overhang":'), "and still asks for the same key it always did");
  assert(!SPEC_PROMPT.includes('"porch"'), "SPEC_PROMPT has no observed block to force a porch answer into");
});

// ─── overhangIn on the wire, feet in the column ───────────────────────────────────────────
// The conversion is NOT in the sanitiser and must not drift into it: `overhangIn` is a
// model-reply key, and a CLAMPS entry would make it a second way to persist an eave in a
// column the production renderer reads.

Deno.test("overhangIn folds to feet, and 0 survives as a flush eave", () => {
  const r = parseModelSpec(`{"roof":{"type":"gable","pitch":0.42,"overhangIn":6},"colors":{},"wallHeightFt":8}`);
  assert(r.ok, "an inches reply parses");
  if (r.ok) {
    assertEquals(r.d3.roof.overhang, 0.5, "6 inches is half a foot");
    assert(!("overhangIn" in r.d3.roof), "the inches key is never stored");
  }
  // ⚠️ THE ONE THE WHOLE CHANGE IS FOR. A flush eave is 0, and 0 must not be read as absent -
  // absent means "keep the builder's setting", which is the opposite of what the model said.
  const flush = parseModelSpec(`{"roof":{"type":"gable","pitch":0.42,"overhangIn":0},"colors":{}}`);
  assert(flush.ok, "a flush eave parses");
  if (flush.ok) {
    assert("overhang" in flush.d3.roof, "0 is an answer that reaches the spec, not a missing key");
    assertEquals(flush.d3.roof.overhang, 0, "0 inches is a flush eave");
  }
  // The two answers the prompt says look nothing alike must not round together.
  const at = (inches: number) => {
    const s = sanitizeD3Spec(foldOverhangInches({ roof: { type: "gable", pitch: 0.4, overhangIn: inches } }));
    return s.ok ? Math.round(Number(s.d3.roof.overhang) * 1000) / 1000 : null;
  };
  assertEquals(at(2), 0.167, "2 inches");
  assertEquals(at(16), 1.333, "16 inches");
  // Over the roof's EXISTING 0..3 ft clamp: clamped by the sanitiser, no new clamp added.
  assertEquals(at(120), 3, "the existing feet clamp does the work, so no clamp had to move");
  assertEquals(at(-4), 0, "the 0 floor is the existing one too");
});

Deno.test("foldOverhangInches is the identity without an overhangIn, which is what keeps old replies byte-identical", () => {
  const spec = { roof: { type: "gable", pitch: 0.42, overhang: 1 }, colors: {}, wallHeightFt: 7 };
  assert(foldOverhangInches(spec) === spec, "no inches key: returned by reference, so nothing can drift");
  // A reply that still answers the OLD key alone is still understood. That is what lets this
  // commit deploy on its own, ahead of any browser release.
  const old = parseModelSpec(`{"roof":{"type":"gable","pitch":0.42,"overhang":0.75},"colors":{}}`);
  assert(old.ok, "a feet reply still parses");
  if (old.ok) assertEquals(old.d3.roof.overhang, 0.75, "the feet key still works");
  // Junk in the inches key drops it rather than writing a 0 the model never said.
  const junk = sanitizeD3Spec(foldOverhangInches({ roof: { type: "gable", pitch: 0.4, overhang: 0.9, overhangIn: "a couple" } }));
  assert(junk.ok, "junk does not fail the whole spec");
  if (junk.ok) assertEquals(junk.d3.roof.overhang, 0.9, "the reply's own feet answer survives junk inches");
  // Inches WIN over feet in the same reply, because inches is what the prompt now asks for.
  const both = sanitizeD3Spec(foldOverhangInches({ roof: { type: "gable", pitch: 0.4, overhang: 1.0, overhangIn: 3 } }));
  assert(both.ok, "both keys parse");
  if (both.ok) assertEquals(both.d3.roof.overhang, 0.25, "the asked-for key wins");
  // Never throws on a shape that is not a spec at all.
  assertEquals(foldOverhangInches(null), null);
  assertEquals(foldOverhangInches("nope"), "nope");
  assertEquals(foldOverhangInches({ roof: 5 }), { roof: 5 });
  assertEquals(foldOverhangInches({ roof: { type: "gable", overhangIn: null } }), { roof: { type: "gable" } });
});

Deno.test("observed.porch survives as one of three words and nothing else", () => {
  const o = parseObservedNotes(`{"observed":{"porch":"projecting","roofNote":"Gambrel, deck out front."}}`);
  assertEquals(o!.porch, "projecting");
  assertEquals(parseObservedNotes(`{"observed":{"porch":"Recessed"}}`)!.porch, "recessed", "case is not a different answer");
  // A sentence is NOT an answer to a three-way question. Dropped rather than guessed at, so the
  // "you did not answer" warning still fires instead of being silenced by a reading of the prose.
  const prose = parseObservedNotes(`{"observed":{"porch":"there is a porch on the front","doors":"one"}}`)!;
  assert(!("porch" in prose), "prose is not an answer");
  assertEquals(prose.doors, "one", "and the rest of the block still survives");
  assertEquals(parseObservedNotes(`{"observed":{"porch":"maybe"}}`), null, "an out-of-vocabulary answer alone leaves nothing to say");
  // And it is DROPPED by the sanitiser like the rest of `observed`: it is a note, not geometry.
  const r = parseModelSpec(`{"roof":{"type":"gable","pitch":0.4},"observed":{"porch":"none"}}`);
  assert(r.ok, "the spec still parses");
  if (r.ok) assert(!("porch" in (r.d3 as Record<string, unknown>)), "observed.porch never reaches the stored spec");
});

// ─── porchAgreementWarning ────────────────────────────────────────────────────────────────
const PORCH_DRAFT = { type: "gambrel", kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1.0, porchOutFt: 6, porchEnd: "front" };

Deno.test("porchAgreementWarning: agreement is silent, all three ways", () => {
  assertEquals(porchAgreementWarning(PORCH_DRAFT, { porch: "projecting" }), null);
  assertEquals(porchAgreementWarning({ type: "gable", porchDepthFt: 6, porchEnd: "front" }, { porch: "recessed" }), null);
  assertEquals(porchAgreementWarning({ type: "gable", pitch: 0.42 }, { porch: "none" }), null);
  // A porch key sitting at 0 is not a porch: the renderer tests the NUMBER, not the key, and
  // this has to read the draft the way the renderer draws it or it will warn about nothing.
  assertEquals(draftPorchKind({ type: "gable", porchOutFt: 0, porchDepthFt: 0 }), "none");
  assertEquals(porchAgreementWarning({ type: "gable", porchOutFt: 0, porchDepthFt: 0 }, { porch: "none" }), null);
  assertEquals(draftPorchKind(PORCH_DRAFT), "projecting");
  assertEquals(draftPorchKind({ type: "gable", porchDepthFt: 4 }), "recessed");
  assertEquals(draftPorchKind(null), "none");
});

Deno.test("porchAgreementWarning: the 09-17 run 2 case, where the notes said porch and the roof said nothing", () => {
  // The real one. The reply wrote "under the porch" in its own roofNote and handed back a roof
  // with no porch key at all. Nothing caught it, because until observed.porch existed there was
  // nowhere for a reply to state a porch except the geometry it was failing to state.
  const w = porchAgreementWarning(
    { type: "gambrel", kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1.0 },
    { porch: "projecting", roofNote: "Gambrel roof, dark metal, deck under the porch at the front." },
  );
  assert(w, "a porch in words with no porch in the numbers is a contradiction");
  assert(w!.includes("standing out in front of one end"), "it says what the reading claimed");
  assert(w!.includes("no porch"), "and what was actually drawn");
  assert(w!.includes("only the building settles which"), "and that neither side can be believed over the other");
  assert(!w!.includes("porchOutFt"), "in the builder's words, not the schema's");
});

Deno.test("porchAgreementWarning: a drafted porch the reading denies, and the wrong KIND", () => {
  const denied = porchAgreementWarning(PORCH_DRAFT, { porch: "none" });
  assert(denied && denied.includes("no porch") && denied.includes("standing out in front"), "the other direction is caught too");
  const kind = porchAgreementWarning(PORCH_DRAFT, { porch: "recessed" });
  assert(kind && kind.includes("cut into one end") && kind.includes("standing out in front"), "recessed against projecting names both");
});

Deno.test("porchAgreementWarning: a missing answer is a DIFFERENT sentence from a contradiction", () => {
  // Two failures, two acts. "Nothing could be checked" sends the builder to look; "these two
  // disagree" tells them the draft is wrong for certain, one way or the other. One sentence for
  // both would send a builder with a perfectly good draft off to re-check it, which is how a
  // warning stops being read.
  const silent = porchAgreementWarning(PORCH_DRAFT, { roofNote: "Gambrel." });
  assert(silent, "no answer is still worth saying");
  assert(silent!.includes("never said whether this building has a porch"), "it names the missing answer");
  assert(!silent!.includes("One of those is wrong"), "a missing answer is not a contradiction");
  assert(silent!.includes("standing out in front of one end"), "and it still says what was drawn");
  assertEquals(porchAgreementWarning(PORCH_DRAFT, null), silent, "no observed block at all reads the same way");
  assertEquals(porchAgreementWarning(PORCH_DRAFT, { porch: "maybe" } as never), silent, "an unparseable answer is no answer");
  assertEquals(porchAgreementWarning(null, { porch: "none" }), null, "no roof and no porch reported is agreement, not a warning");
});

Deno.test("two warnings compose without eating each other, and the model's note stays capped at 240", () => {
  // A draft can be wrong about the roof AND the porch. Dropping either warning would send the
  // builder to look at half the problem, which is worse than sending them to look at all of it.
  const roof = { type: "gambrel", kneeU: 0.55, kneeRise: 0.35, ridgeRise: 0.75, porchOutFt: 6 };
  const observed = parseObservedNotes(JSON.stringify({ observed: { porch: "none", roofNote: "y".repeat(1000) } }))!;
  const g = gambrelRoofWarning(roof)!, pw = porchAgreementWarning(roof, observed)!;
  assert(g && pw, "this draft is wrong about both the roof and the porch");
  const flagged = flagObservedNotes(observed, g, pw)!;
  assert(flagged.roofNote!.startsWith(g), "the first warning leads");
  assert(flagged.roofNote!.includes(pw), "and the second is not eaten by it");
  assert(flagged.roofNote!.includes(`The model's own reading: ${"y".repeat(240)}`), "the model's own note still rides along, capped");
  assertEquals(flagged.confidence, "low", "either warning turns the panel amber");
  assertEquals(flagged.porch, "none", "the porch answer itself rides along untouched");
  assert(flagged.roofNote!.length <= g.length + 1 + pw.length + 26 + 240, "two fixed warnings plus the model's 240 is the whole bound");
  // A null among the warnings is skipped rather than joined as a gap, which is what lets the
  // caller pass every check it has without testing each one first.
  assertEquals(flagObservedNotes(observed, null, pw)!.roofNote, `${pw} The model's own reading: ${"y".repeat(240)}`);
  assertEquals(flagObservedNotes(observed, null, null), observed, "no warnings at all leaves the notes alone, by reference");
});

// ─── the builder's three numbers, on the wire (2026-09-19) ───────────────────────────────
// Wall height came back 7 in 74 % of every recorded generation and never once above 8, against
// a measured 9. A ground-level phone has no datum to measure a wall against, so the builder is
// asked instead, and the prompt drops the field rather than asking for a number it already has.
//
// EVERY TEST BELOW IS ULTIMATELY ABOUT ONE PROPERTY: with no dims, nothing changed. Production
// runs an older browser bundle that cannot send them, against this same function, so "byte-
// identical when absent" is not tidiness — it is the only thing standing between a beta feature
// and every production builder's paid generation.

const DIMS: KnownDims = { widthFt: 16, lengthFt: 24, wallHeightFt: 9 };

Deno.test("videoShapePrompt(null) IS the constant, which is what proves production is untouched", () => {
  // ⚠️ THE LOAD-BEARING ONE. `VIDEO_SHAPE_PROMPT` is now derived from this function rather than
  // written beside it, so the no-dims path cannot drift from the string that has been in
  // production since August: there is nothing to keep in step, only this identity to hold.
  assertEquals(videoShapePrompt(null), VIDEO_SHAPE_PROMPT);
  assertEquals(videoShapePrompt(undefined), VIDEO_SHAPE_PROMPT, "an omitted argument is the same as a null one");
  assertEquals(videoShapePrompt(), VIDEO_SHAPE_PROMPT, "and so is no argument at all");
  // Reference identity, not merely equal content: the function returns the base, it does not
  // rebuild it. A rebuild would pass assertEquals and still be a second copy to get wrong.
  assert(videoShapePrompt(null) === VIDEO_SHAPE_PROMPT, "the no-dims prompt is the same string object");
});

Deno.test("a two-argument combinedShapePrompt is byte-identical to what shipped", () => {
  // The four shapes the existing suite already pins by content. Here they are pinned by
  // EQUALITY against the explicit-null call, so the new third parameter cannot change what an
  // old caller gets, and against the no-dims body, which is what "byte-identical" means.
  for (const [v, p] of [[8, 4], [1, 1], [8, 0], [0, 4]] as const) {
    assertEquals(combinedShapePrompt(v, p), combinedShapePrompt(v, p, null), `combinedShapePrompt(${v}, ${p})`);
    assertEquals(combinedShapePrompt(v, p), combinedShapePrompt(v, p, undefined), `combinedShapePrompt(${v}, ${p}) undefined`);
  }
  // And the body really is the no-dims body, verbatim from the first blank line on.
  const tail = VIDEO_SHAPE_PROMPT.slice(VIDEO_SHAPE_PROMPT.indexOf("\n\n"));
  assert(combinedShapePrompt(8, 4).endsWith(tail), "the combined prompt carries the unchanged body");
  assertEquals(combinedShapePrompt(0, 4), VIDEO_SHAPE_PROMPT, "no walk still means the video prompt, untouched");
});

Deno.test("the dims prompt states all three numbers as facts and calls them the ruler", () => {
  for (const [name, p] of [
    ["videoShapePrompt", videoShapePrompt(DIMS)],
    ["combinedShapePrompt", combinedShapePrompt(8, 4, DIMS)],
  ] as const) {
    assert(p.includes("16 ft wide across the gable end"), `${name} states the width`);
    assert(p.includes("24 ft long down the side"), `${name} states the length`);
    assert(p.includes("wall is 9 ft high at the eave"), `${name} states the wall height`);
    assert(p.includes("facts, not estimates"), `${name} says they are not to be second-guessed`);
    assert(p.includes("they are your ruler"), `${name} names them as the scale`);
    assert(p.includes("never against a scale of your own"), `${name} forbids substituting one`);
  }
  // Trailing zeros off: "9" and not "9.0". A model reconciling "9.00 ft" against a frame is being
  // handed false precision it did not ask for.
  assert(videoShapePrompt({ widthFt: 12, lengthFt: 16.5, wallHeightFt: 8 }).includes("16.5 ft long"), "a real fraction survives");
  assert(!videoShapePrompt(DIMS).includes("16.0 ft"), "a whole number reads as a whole number");
});

Deno.test("⚠️ the splice does not eat the known-dimensions paragraph", () => {
  // The sibling of "the FALSE opening sentence is gone, not merely preceded", and the same
  // class of invisible failure. combinedShapePrompt replaces everything up to the first blank
  // line; a ruler written ABOVE that line would vanish on every combined generation, and the
  // prompt that went out would still read perfectly well and still return a parseable spec.
  // The only symptom would be a wall height nobody could explain.
  const p = combinedShapePrompt(8, 4, DIMS);
  assert(p.includes("KNOWN DIMENSIONS, MEASURED BY THE BUILDER."), "the ruler survives the splice");
  assert(p.startsWith("These images are all of ONE portable building"), "and the combined opening still leads");
  assert(p.indexOf("KNOWN DIMENSIONS") > p.indexOf("The FIRST 8 images are frames"), "the ruler sits inside the inherited body");
  assert(p.includes("How to read it:") && p.includes('"observed"'), "and the rest of the body is still there");
});

Deno.test("⚠️ the dims prompt does not ask for a wall height it already knows", () => {
  // A number that is known must not also be estimated. If either replacement silently became a
  // no-op — a reword of the schema line or of the WALL HEIGHT paragraph would do it — the model
  // would be told the wall is 9 ft in one paragraph and asked to guess it in the next.
  for (const [name, p] of [
    ["videoShapePrompt", videoShapePrompt(DIMS)],
    ["combinedShapePrompt", combinedShapePrompt(8, 4, DIMS)],
  ] as const) {
    assert(!p.includes("wallHeightFt"), `${name}: the key is gone from the schema entirely`);
    assert(!p.includes("typically 6-10"), `${name}: and so is the range that invited a midpoint`);
    assert(!p.includes("WALL HEIGHT: the wall at the eave, not at the peak."), `${name}: the estimate paragraph is replaced`);
    assert(p.includes("Do not estimate it, do not report it"), `${name}: and replaced by a refusal to estimate`);
    assert(p.includes("do not bend the other numbers to fit some other wall height"), `${name}: nor to work backwards from it`);
  }
  // The NO-DIMS prompt still asks, because nothing told it. Pinned here rather than trusted:
  // a replacement applied to the base by accident would break production, not beta.
  assert(VIDEO_SHAPE_PROMPT.includes('"wallHeightFt"'), "with no dims the model is still asked");
  assert(VIDEO_SHAPE_PROMPT.includes("WALL HEIGHT: the wall at the eave, not at the peak."), "and still told where to measure");
});

Deno.test("the gambrel ratios are word-for-word the same with dims as without", () => {
  // Brief section 2.1, reversing the dims design: the ratios measurably WORK (0.78 / 0.70 / 1.00
  // against a truth of 0.72 / 0.72 / 1.00, in 3 of 3) and a mistyped width would silently corrupt
  // anything converted from them. So dims add a ruler and change nothing about how the roof is
  // asked for. Deliberately NOT folded into the existing "every prompt says kneeU is measured
  // from the CENTRELINE" loop: that loop guards a real shipped defect and is not the place to
  // hang a fourth prompt off.
  const withDims = videoShapePrompt(DIMS), without = VIDEO_SHAPE_PROMPT;
  for (const marker of ['"kneeU"', '"kneeRise"', '"ridgeRise"', "GAMBREL NUMBERS", "CENTRELINE", "0.7-0.85"]) {
    assert(withDims.includes(marker), `the dims prompt still carries ${marker}`);
  }
  const line = (p: string, k: string) => p.split("\n").find((l) => l.includes(k)) ?? "";
  for (const k of ['"kneeU"', '"kneeRise"', '"ridgeRise"', '"pitch"', '"overhangIn"']) {
    assertEquals(line(withDims, k), line(without, k), `the ${k} line is unchanged by dims`);
  }
  const para = (p: string) => p.split("\n").find((l) => l.startsWith("GAMBREL NUMBERS")) ?? "";
  assertEquals(para(withDims), para(without), "the whole GAMBREL NUMBERS paragraph is unchanged");
});

// ─── parseKnownDims: absent is not an error, and an error is not absent ───────────────────

Deno.test("parseKnownDims: absent means null, and null is not a refusal", () => {
  for (const raw of [undefined, null, {}]) {
    const r = parseKnownDims(raw);
    assert(r.ok, `${JSON.stringify(raw) ?? "undefined"} is not an error`);
    if (r.ok) assertEquals(r.dims, null, "and it carries no dims");
  }
});

Deno.test("parseKnownDims: three good numbers come back as three good numbers", () => {
  const r = parseKnownDims({ widthFt: 16, lengthFt: 24, wallHeightFt: 9 });
  assert(r.ok, "a plain set parses");
  if (r.ok) assertEquals(r.dims, { widthFt: 16, lengthFt: 24, wallHeightFt: 9 });
  // Numeric strings, because an <input type="number"> hands its value over as text and a
  // caller that stringifies its own state is not doing anything wrong.
  const s = parseKnownDims({ widthFt: "16", lengthFt: "24", wallHeightFt: "9.5" });
  assert(s.ok, "numeric strings parse");
  if (s.ok) assertEquals(s.dims, { widthFt: 16, lengthFt: 24, wallHeightFt: 9.5 });
});

Deno.test("⚠️ parseKnownDims: OUT OF BAND IS A REFUSAL, NOT AN ABSENCE", () => {
  // THE WHOLE SAFETY PROPERTY, and the reason the return type carries three outcomes. If a bad
  // number collapsed to `null`, a mistyped 140 ft width would read as "this builder sent no
  // dimensions": the ledger row would be written, $20 would be held, and the draft would come
  // back read against a scale nobody stated and nobody could see afterwards. A refusal is
  // answered 400 before either of those happens.
  const bad: [string, unknown][] = [
    ["a width past any building anyone hauls", { widthFt: 140, lengthFt: 24, wallHeightFt: 9 }],
    ["a width under any building at all", { widthFt: 0, lengthFt: 24, wallHeightFt: 9 }],
    ["a length past the band", { widthFt: 16, lengthFt: 400, wallHeightFt: 9 }],
    ["a wall height in inches", { widthFt: 16, lengthFt: 24, wallHeightFt: 108 }],
    ["a wall height the sanitiser would silently DROP", { widthFt: 16, lengthFt: 24, wallHeightFt: 30 }],
    ["a negative", { widthFt: -16, lengthFt: 24, wallHeightFt: 9 }],
  ];
  for (const [why, raw] of bad) {
    const r = parseKnownDims(raw);
    assert(!r.ok, `${why} must be refused, never read as absent`);
    if (!r.ok) assert(r.error.length > 10 && /Check what you typed/.test(r.error), `${why}: the builder is told what to do`);
  }
  // A 30 ft wall is the sharp case. sanitizeD3Spec accepts 3..20 and DROPS anything outside, so
  // letting a 30 through would mean a prompt that states a 30 ft wall and a spec that keeps
  // whatever the style had. Refused instead, which is why the band here is the sanitiser's own
  // accept band and not its 5..14 clamp.
  const thirty = parseKnownDims({ widthFt: 16, lengthFt: 24, wallHeightFt: 30 });
  assert(!thirty.ok && thirty.error.includes("wall height"), "the refusal names the field");
});

Deno.test("parseKnownDims: a missing number is refused by name, and junk never throws", () => {
  for (const [key, raw] of [
    ["width", { lengthFt: 24, wallHeightFt: 9 }],
    ["length", { widthFt: 16, wallHeightFt: 9 }],
    ["wall height", { widthFt: 16, lengthFt: 24 }],
  ] as const) {
    const r = parseKnownDims(raw);
    assert(!r.ok, `a set missing the ${key} is refused`);
    if (!r.ok) assert(r.error.includes(key), `and the message names it: ${r.error}`);
  }
  // Junk of every shape. None of these may throw: this runs inside a function that has to
  // ANSWER a caller, and a throw here would be a 500 on a typo.
  for (
    const raw of ["16x24", 16, true, [16, 24, 9], { widthFt: {}, lengthFt: [], wallHeightFt: null },
      { widthFt: "wide", lengthFt: "long", wallHeightFt: "tall" }, { widthFt: NaN, lengthFt: 24, wallHeightFt: 9 },
      { widthFt: Infinity, lengthFt: 24, wallHeightFt: 9 }]
  ) {
    const r = parseKnownDims(raw);
    assert(!r.ok, `${JSON.stringify(raw)} is refused rather than accepted`);
  }
});

Deno.test("parseKnownDims: the overhang is optional, and absent is not zero", () => {
  const none = parseKnownDims({ widthFt: 16, lengthFt: 24, wallHeightFt: 9 });
  assert(none.ok && none.dims && !("overhangIn" in none.dims), "no chip pressed means no key");
  // ⚠️ 0 IS A REAL ANSWER — the flush eave the inches rewrite exists to make sayable — so it must
  // survive as 0 and never be mistaken for "the builder did not say".
  const flush = parseKnownDims({ widthFt: 16, lengthFt: 24, wallHeightFt: 9, overhangIn: 0 });
  assert(flush.ok && flush.dims && flush.dims.overhangIn === 0, "a flush eave is an answer");
  // The three ways a form says "nothing here".
  for (const v of [null, undefined, ""]) {
    const r = parseKnownDims({ widthFt: 16, lengthFt: 24, wallHeightFt: 9, overhangIn: v });
    assert(r.ok && r.dims && !("overhangIn" in r.dims), `${JSON.stringify(v)} means "read it off the video"`);
  }
  const deep = parseKnownDims({ widthFt: 16, lengthFt: 24, wallHeightFt: 9, overhangIn: 16 });
  assert(deep.ok && deep.dims && deep.dims.overhangIn === 16, "16 inches rides along");
  const wild = parseKnownDims({ widthFt: 16, lengthFt: 24, wallHeightFt: 9, overhangIn: 96 });
  assert(!wild.ok, "an eight-foot eave is a typo, not an eave");
});

// ─── applyKnownDims: the builder's numbers over the model's ───────────────────────────────

Deno.test("applyKnownDims with no dims is the identity, BY REFERENCE", () => {
  // Deep-equal would pass on a rebuilt copy, and a rebuilt copy is a second place for a key to
  // be lost. The no-dims path returns what it was given.
  const spec = { roof: { type: "gable", pitch: 0.42, overhang: 0.5 }, colors: { body: "#fff" }, wallHeightFt: 7 };
  assert(applyKnownDims(spec, null) === spec, "null dims returns the same object");
  assert(applyKnownDims(spec, undefined) === spec, "absent dims returns the same object");
  assert(applyKnownDims(spec) === spec, "no argument at all returns the same object");
  assertEquals(applyKnownDims(spec, null), spec);
  // Junk in, junk back out untouched: sanitizeD3Spec is the thing that judges a spec.
  for (const junk of [null, undefined, "spec", 5, []]) assertEquals(applyKnownDims(junk, DIMS), junk);
});

Deno.test("⚠️ the builder's 9 beats the model's 7, which is the whole point", () => {
  // 7 is what the model answered in 74 % of every recorded generation, on buildings measuring 9.
  const reply = `{"roof":{"type":"gambrel","pitch":0.5,"kneeU":0.75,"kneeRise":0.72,"ridgeRise":1.03},"colors":{},"wallHeightFt":7}`;
  const withOut = parseModelSpec(reply);
  assert(withOut.ok && withOut.d3.wallHeightFt === 7, "without dims the model's answer stands");
  const withDims = parseModelSpec(reply, DIMS);
  assert(withDims.ok, "with dims it still parses");
  if (withDims.ok) {
    assertEquals(withDims.d3.wallHeightFt, 9, "the tape measure wins");
    // Nothing else moved. The ratios are the model's job and stay the model's job (section 2.1).
    assertEquals(withDims.d3.roof.kneeU, 0.75);
    assertEquals(withDims.d3.roof.ridgeRise, 1.03);
  }
  // A model that says nothing about the wall still gets the builder's number, because the dims
  // prompt does not ask and a reply with no wallHeightFt is the EXPECTED reply.
  const silent = parseModelSpec(`{"roof":{"type":"gable","pitch":0.42},"colors":{}}`, DIMS);
  assert(silent.ok && silent.d3.wallHeightFt === 9, "the expected silent reply still gets the wall");
});

Deno.test("a dims wall height outside 5-14 hits the EXISTING clamp, not a second one", () => {
  // One clamp, not two. `sanitizeD3Spec` has drawn walls at 5..14 since before any of this, and
  // writing the builder's number in BEFORE it is what keeps that the only place the bound lives.
  const tall = parseModelSpec(`{"roof":{"type":"gable","pitch":0.4},"colors":{}}`, { widthFt: 16, lengthFt: 24, wallHeightFt: 16 });
  assert(tall.ok && tall.d3.wallHeightFt === 14, "16 is drawn at 14");
  const short = parseModelSpec(`{"roof":{"type":"gable","pitch":0.4},"colors":{}}`, { widthFt: 16, lengthFt: 24, wallHeightFt: 4 });
  assert(short.ok && short.d3.wallHeightFt === 5, "4 is drawn at 5");
  // And the builder is TOLD, because a silent clamp on a number they measured is the worst kind:
  // they typed it, the preview disagrees, and nothing on screen connects the two.
  assert(knownDimsNote({ widthFt: 16, lengthFt: 24, wallHeightFt: 16 })!.includes("drawn at 14"), "the note names what was drawn");
  assert(knownDimsNote({ widthFt: 16, lengthFt: 24, wallHeightFt: 16 })!.includes("you gave 16 ft"), "and what was typed");
  assertEquals(knownDimsNote(DIMS), null, "a wall inside the band is silent");
  assertEquals(knownDimsNote(null), null, "and no dims at all is silent");
  assertEquals(knownDimsNote(undefined), null);
});

Deno.test("⚠️ the builder's overhang is converted ONCE, not twice", () => {
  // The trap this commit was warned about. The MODEL's `overhangIn` is consumed by
  // foldOverhangInches one step earlier; `dims.overhangIn` is a different number from a
  // different source. Dividing whatever is already sitting in `overhang` by 12 a second time
  // would put a 16 in eave at 0.11 ft, which reads as flush — the exact defect the inches
  // rewrite exists to end.
  const reply = `{"roof":{"type":"gable","pitch":0.42,"overhangIn":16},"colors":{}}`;
  const modelOnly = parseModelSpec(reply, DIMS);
  assert(modelOnly.ok, "the model's inches parse with dims present");
  if (modelOnly.ok) {
    assertEquals(Math.round((modelOnly.d3.roof.overhang as number) * 1000) / 1000, 1.333, "16 in is 1.333 ft, converted once");
    assert(!("overhangIn" in modelOnly.d3.roof), "and the inches key is never stored");
  }
  // The builder measured it, so the builder wins — same posture as the wall height above.
  const builder = parseModelSpec(reply, { ...DIMS, overhangIn: 2 });
  assert(builder.ok && Math.abs((builder.d3.roof.overhang as number) - 2 / 12) < 1e-9, "the chip beats the model's read");
  // A flush chip is 0 ft and reaches the spec as 0, not as "absent".
  const flush = parseModelSpec(reply, { ...DIMS, overhangIn: 0 });
  assert(flush.ok && flush.d3.roof.overhang === 0, "flush means 0, and 0 is stored");
  // No chip pressed leaves the model's read exactly alone.
  const readIt = parseModelSpec(reply, DIMS);
  assert(readIt.ok && (readIt.d3.roof.overhang as number) > 1, "'read it off the video' does not overwrite the reading");
});

Deno.test("nothing dims brought in survives sanitizeD3Spec except the wall height", () => {
  // Width and length are the ruler for ONE reading, not properties of a style: one style sells
  // at up to 21 sizes and the renderer takes its width from the customer's pick. They must never
  // reach `building_styles.d3`, where they would be a second, lying answer.
  const r = parseModelSpec(
    `{"roof":{"type":"gable","pitch":0.42,"overhangIn":6},"colors":{},"widthFt":99,"lengthFt":99}`,
    { ...DIMS, overhangIn: 6 },
  );
  assert(r.ok, "it parses");
  if (!r.ok) return;
  const flat = JSON.stringify(r.d3);
  for (const key of ["widthFt", "lengthFt", "overhangIn", "sizeFt"]) {
    assert(!flat.includes(key), `${key} must not reach the stored spec`);
  }
  assertEquals(r.d3.wallHeightFt, 9, "the wall height is the one thing that stays, because d3 already has that key");
  assertEquals(Object.keys(r.d3.roof).sort(), ["overhang", "pitch", "type"], "and the roof carries only roof keys");
});
