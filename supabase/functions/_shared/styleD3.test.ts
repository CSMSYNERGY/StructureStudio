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

import { sanitizePhotoUrls, parseModelSpec, parseObservedNotes, sanitizeD3Spec } from "./styleD3.ts";

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
