// Picking a streamed draft up from its ledger row (2026-09-25): the two pure halves of
// calibrate_style_ai_recover, parseRecoverSince and recoverDraftAnswer (styleD3.ts). The handler's
// half -- the gate, and the filters that keep every other tenant's, user's and style's rows out -- is
// driven through the shipped portal-settings handler in _test_stubs/aiDraftStreamWiring_test.ts.
//
// What only these two can get wrong, and what is pinned here:
//   1. `since` is bounded (fifteen minutes back, a minute of skew forward), and a `clientNow` moves it
//      onto the server's clock, less a five-second slack.
//   2. A drafted row answers the success body's keys in the success body's order, with the three
//      fields the row cannot give said to be missing (dropped, balanceCents, frameMap) and
//      `recovered: true`; a row whose draft does not read back is a fault, never a draft.
//   3. No draft yet is `pending` for exactly as long as a draft can still arrive; after that, and with
//      no row at all, it is `pending: false` with a sentence -- and a row that was CHARGED and has no
//      draft says so, as a fault.
//
// Dependency-free (no jsr:/npm: imports), like every test in the _shared group.

import {
  DRAFT_RECOVER_MAX_AGE_MS, DRAFT_RECOVER_PENDING_MS, DRAFT_RECOVER_SETTLE_MS, DRAFT_RECOVER_SKEW_MS,
  DRAFT_RECOVER_SLACK_MS, DRAFT_STREAM_DEADLINE_MS, type DraftRecoverRow, parseModelSpec, parseRecoverSince,
  recoverDraftAnswer,
} from "./styleD3.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DIMS = { widthFt: 30, lengthFt: 20, wallHeightFt: 8 };
const parsed = parseModelSpec(JSON.stringify({ roof: { type: "gable", front: "gable", pitch: 0.5 }, roofMaterial: "metal" }), DIMS);
if (!parsed.ok) throw new Error(`fixture: ${parsed.error}`);
const D3 = JSON.parse(JSON.stringify(parsed.d3));   // as jsonb hands it back
const ROW = (o: Partial<DraftRecoverRow> = {}): DraftRecoverRow => ({
  id: "11111111-2222-4333-8444-555555555555", called_at: iso(NOW - 30_000), drafted: null, observed: null,
  frames: 12, dims: DIMS, draft_ms: null, charged_cents: null, ...o,
});

Deno.test("the numbers: the answer closes at 300 s, a row is waited on to the 400 s wall clock", () => {
  assertEquals(DRAFT_STREAM_DEADLINE_MS, 300_000);
  assertEquals(DRAFT_RECOVER_PENDING_MS, 400_000);
  assertEquals([DRAFT_RECOVER_MAX_AGE_MS, DRAFT_RECOVER_SKEW_MS, DRAFT_RECOVER_SLACK_MS, DRAFT_RECOVER_SETTLE_MS], [900_000, 60_000, 5_000, 90_000]);
});

Deno.test("parseRecoverSince: bounded, and moved onto the server's clock by clientNow", () => {
  const ok = (r: ReturnType<typeof parseRecoverSince>) => (r.ok ? r.fromIso : `refused: ${r.error}`);
  // Same clocks: from `since` less the slack.
  assertEquals(ok(parseRecoverSince(iso(NOW - 60_000), undefined, NOW)), iso(NOW - 65_000));
  // A browser 40 s fast: its `since` and its `clientNow` are both 40 s ahead; the window is the server's.
  assertEquals(ok(parseRecoverSince(iso(NOW - 60_000 + 40_000), NOW + 40_000, NOW)), iso(NOW - 65_000));
  // And 3 minutes slow.
  assertEquals(ok(parseRecoverSince(iso(NOW - 60_000 - 180_000), NOW - 180_000, NOW)), iso(NOW - 65_000));
  // Bounds, measured on the browser's own clock when it gives one.
  assert(!parseRecoverSince(iso(NOW - 16 * 60_000), undefined, NOW).ok, "older than fifteen minutes");
  assert(parseRecoverSince(iso(NOW - 14 * 60_000), undefined, NOW).ok, "inside fifteen minutes");
  assert(!parseRecoverSince(iso(NOW + 61_000), undefined, NOW).ok, "more than a minute in the future");
  assert(parseRecoverSince(iso(NOW + 59_000), undefined, NOW).ok, "a little skew is allowed");
  assert(parseRecoverSince(iso(NOW + 3_600_000 - 1_000), NOW + 3_600_000, NOW).ok, "a clock an hour fast, with clientNow");
  for (const bad of [undefined, null, 12345, "", "not a time", "x".repeat(100), { at: NOW }]) {
    assert(!parseRecoverSince(bad, undefined, NOW).ok, `refused: ${JSON.stringify(bad)}`);
  }
  // A clientNow that is not a finite number is ignored, never trusted.
  assertEquals(ok(parseRecoverSince(iso(NOW - 60_000), "later", NOW)), iso(NOW - 65_000));
  assertEquals(ok(parseRecoverSince(iso(NOW - 60_000), Infinity, NOW)), iso(NOW - 65_000));
});

Deno.test("a drafted row: the success body's keys in its order, the missing three said to be missing, recovered", () => {
  const out = recoverDraftAnswer(ROW({ drafted: D3, observed: { roofNote: "gable" }, frames: 11 }), NOW);
  assertEquals(out.kind, "draft");
  if (out.kind !== "draft") return;
  // calibrate_style_ai's success: { ok, d3, frames, dropped, observed, balanceCents, dims, frameMap, checkId }.
  assertEquals(Object.keys(out.body), ["ok", "d3", "frames", "dropped", "observed", "balanceCents", "dims", "frameMap", "checkId", "recovered"]);
  assertEquals(out.body, {
    ok: true, d3: D3, frames: 11, dropped: null, observed: { roofNote: "gable" }, balanceCents: null,
    dims: DIMS, frameMap: null, checkId: "11111111-2222-4333-8444-555555555555", recovered: true,
  });
  assertEquals([out.code, out.severity], ["ai_draft_recovered", "info"]);
  // A draft is a draft however old, and whatever else the row says.
  assertEquals(recoverDraftAnswer(ROW({ drafted: D3, called_at: iso(NOW - 14 * 60_000), charged_cents: 2000, draft_ms: 1 }), NOW).kind, "draft");
  // No dims on the row (247 not applied when it ran): null, as the answer said then.
  const noDims = recoverDraftAnswer(ROW({ drafted: D3, dims: null }), NOW);
  assertEquals(noDims.kind === "draft" && noDims.body.dims, null);
});

Deno.test("a row whose draft is not a spec object is a fault, never a draft to apply", () => {
  for (const drafted of [[1, 2], "gable", 7, true]) {
    const out = recoverDraftAnswer(ROW({ drafted }), NOW);
    assertEquals([out.kind, out.kind === "lost" && out.why, out.kind === "lost" && out.severity], ["lost", "unreadable", "error"], JSON.stringify(drafted));
  }
});

Deno.test("no draft yet: pending while one can still arrive, then pending:false with a sentence", () => {
  const pending = { ok: true, pending: true };
  const at = (ageMs: number, o: Partial<DraftRecoverRow> = {}) => recoverDraftAnswer(ROW({ called_at: iso(NOW - ageMs), ...o }), NOW);
  assertEquals(at(10_000).body, pending, "the reads are out");
  assertEquals(at(DRAFT_RECOVER_PENDING_MS - 1).body, pending, "no usage written yet, inside the wall clock");
  const stale = at(DRAFT_RECOVER_PENDING_MS + 1);
  assertEquals([stale.kind, stale.kind === "lost" && stale.why], ["lost", "stale"]);
  // The reads ended (draft_ms written) and the draft is being written: pending for the settle window.
  assertEquals(at(120_000, { draft_ms: 100_000 }).body, pending);
  assertEquals(at(100_000 + DRAFT_RECOVER_SETTLE_MS, { draft_ms: 100_000 }).body, pending);
  const failed = at(100_000 + DRAFT_RECOVER_SETTLE_MS + 1, { draft_ms: 100_000 });
  assertEquals([failed.kind, failed.kind === "lost" && failed.why, failed.kind === "lost" && failed.severity], ["lost", "failed", "info"]);
  assert(failed.kind === "lost" && failed.body.pending === false && /not charged/.test(failed.body.message), "said plainly, with the charge");
  // A row with no draft that was CHARGED: the capture ran and the draft never reached the row.
  const charged = at(300_000, { draft_ms: 100_000, charged_cents: 2000 });
  assert(charged.kind === "lost" && charged.why === "charged_unsaved" && charged.severity === "error", JSON.stringify(charged));
  assert(charged.kind === "lost" && /charged once/.test(charged.body.message) && /not been charged twice/.test(charged.body.message), "never 'not charged'");
  // No row at all.
  const none = recoverDraftAnswer(null, NOW);
  assert(none.kind === "lost" && none.why === "no_row" && none.severity === "info", JSON.stringify(none));
  // An unreadable called_at can never be waited on for ever.
  assertEquals(recoverDraftAnswer(ROW({ called_at: "garbage" }), NOW).kind, "lost");
});
