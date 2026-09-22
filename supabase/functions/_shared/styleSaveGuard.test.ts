// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// What this pins: the late-save guard must let the two SAFE cases through (nothing wrote since
// the save's base; this exact save already landed) and stop the dangerous one (an old save
// arriving after newer ones) — INCLUDING when the newer saves put the content back the way it
// was (A -> B -> A), which is the case a content comparison cannot see and review caught.

import { canonicalJson, guardDecision, mediaList, sameInstant } from "./styleSaveGuard.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

Deno.test("canonicalJson ignores key order at every depth", () => {
  const sent = { roof: { type: "gable", pitch: 0.42, porchTruss: true }, colors: { body: "#4a3327", trim: "#b0a081" }, wallHeightFt: 7.5 };
  const reordered = { wallHeightFt: 7.5, colors: { trim: "#b0a081", body: "#4a3327" }, roof: { porchTruss: true, pitch: 0.42, type: "gable" } };
  assertEquals(canonicalJson(sent), canonicalJson(reordered), "key order must not matter");
});

Deno.test("canonicalJson keeps array order, drops undefined members, treats null and undefined alike", () => {
  assertEquals(canonicalJson(["a", "b"]) === canonicalJson(["b", "a"]), false, "array order is meaningful (walk order)");
  assertEquals(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  assertEquals(canonicalJson(null), canonicalJson(undefined));
  assertEquals(canonicalJson({ n: Number.NaN }), canonicalJson({ n: null }));
});

Deno.test("mediaList normalises NULL, junk and empty strings to a clean array", () => {
  assertEquals(mediaList(null), []);
  assertEquals(mediaList(["https://x/a.jpg", "", 3, null, "https://x/b.jpg"]), ["https://x/a.jpg", "https://x/b.jpg"]);
});

Deno.test("sameInstant matches the same moment in PostgREST and browser formats, and never matches unknowns", () => {
  assertEquals(sameInstant("2026-09-14T12:48:21.123+00:00", "2026-09-14T12:48:21.123Z"), true);
  assertEquals(sameInstant("2026-09-14T12:48:21.123+00:00", "2026-09-14T12:48:21.124+00:00"), false);
  assertEquals(sameInstant(undefined, undefined), false, "unknown is never 'unchanged'");
  assertEquals(sameInstant("not a date", "not a date"), false);
});

const T0 = "2026-09-14T12:00:00.000+00:00", T1 = "2026-09-14T12:00:30.000+00:00", T2 = "2026-09-14T12:01:00.000+00:00";
const L0 = ["a"], L1 = ["a", "b"];

Deno.test("nothing wrote since the base: write", () => {
  assertEquals(guardDecision({ baseVersion: T0, currentVersion: T0, columns: [{ current: L0, next: L1 }] }), "write");
});

Deno.test("the same save landing twice (the stalled original after its retry): duplicate, write nothing", () => {
  assertEquals(guardDecision({ baseVersion: T0, currentVersion: T1, columns: [{ current: L1, next: L1 }] }), "duplicate");
});

Deno.test("A -> B -> A: an old save arriving after the content was put BACK is still refused", () => {
  // Upload b: the original stalls, its retry lands L1 at T1. Remove b: lands L0 at T2. The stalled
  // original (base T0, next L1) now meets a row holding L0 again. Content matches its base; the
  // version does not. The first version of this guard wrote L1 back here.
  assertEquals(guardDecision({ baseVersion: T0, currentVersion: T2, columns: [{ current: L0, next: L1 }] }), "conflict");
});

Deno.test("the d3 A -> B -> A: pitch 0.42 -> 0.6 (retried) -> 0.42, then the late 0.6 arrives", () => {
  const a = { roof: { type: "gable", pitch: 0.42 } }, b = { roof: { type: "gable", pitch: 0.6 } };
  assertEquals(guardDecision({ baseVersion: T0, currentVersion: T2, columns: [{ current: a, next: b }] }), "conflict");
});

Deno.test("unguarded callers (no base sent) write unconditionally, as before", () => {
  assertEquals(guardDecision({ baseVersion: undefined, currentVersion: T2, columns: [{ current: L0, next: L1 }] }), "unguarded");
});

Deno.test("a never-stamped row: a base of null writes; a real base against an unstamped row does not pass as unchanged", () => {
  assertEquals(guardDecision({ baseVersion: null, currentVersion: null, columns: [{ current: null, next: L1 }] }), "write");
  assertEquals(guardDecision({ baseVersion: T0, currentVersion: null, columns: [{ current: null, next: L1 }] }), "conflict");
});

Deno.test("a duplicate must match on EVERY written column, not just one", () => {
  assertEquals(guardDecision({ baseVersion: T0, currentVersion: T1, columns: [{ current: L1, next: L1 }, { current: { roof: { pitch: 0.5 } }, next: { roof: { pitch: 0.6 } } }] }), "conflict");
});

Deno.test("a jsonb-reordered but identical spec still counts as a duplicate", () => {
  assertEquals(guardDecision({ baseVersion: T0, currentVersion: T1, columns: [{ current: { roof: { pitch: 0.6, type: "gable" } }, next: { roof: { type: "gable", pitch: 0.6 } } }] }), "duplicate");
});
