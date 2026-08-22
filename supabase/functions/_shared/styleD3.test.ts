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
