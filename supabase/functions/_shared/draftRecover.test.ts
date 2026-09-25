// Picking a streamed draft up after its connection dropped (2026-09-25, by key since 253): the pure
// halves of calibrate_style_ai_recover in styleD3.ts -- draftIdemKey, pickRecoverRow,
// isRecoverableDraft, draftMoneyState and recoverDraftAnswer. The handler's half -- the gate, and
// the filters that keep every other tenant's, user's, key's and style's rows out -- is driven
// through the shipped portal-settings handler in _test_stubs/aiDraftStreamWiring_test.ts.
//
// What only these can get wrong, and what is pinned here:
//   1. The key is cut exactly one way, for the insert, the hold and the pickup alike.
//   2. A key that owns several rows (a failed attempt, then the retry of the same intent) answers
//      from the NEWEST, drafted or not -- whatever order they arrive in.
//   3. The money is read from the press's own wallet rows: captured beats held beats released.
//   4. A drafted row answers the success body's keys in the success body's order, with its own
//      frame map (253) so the self-check runs, and `recovered: true`.
//   5. ⚠️ THE MONEY SENTENCE COMES FROM THE MONEY STATE, NEVER FROM TIMING. "Not charged" is said
//      only when the press's hold was released or there never was one, however young or old the
//      row; a captured press with no draft is "charged once", an error; a hold still open is
//      pending. Timing only ever decides whether to keep waiting.
//
// Dependency-free (no jsr:/npm: imports), like every test in the _shared group.

import {
  DRAFT_RECOVER_MAX_ROWS, DRAFT_RECOVER_PENDING_MS, DRAFT_RECOVER_SETTLE_MS, DRAFT_STREAM_DEADLINE_MS,
  type DraftMoney, type DraftRecoverRow, draftIdemKey, draftMoneyState, isRecoverableDraft, parseModelSpec,
  pickRecoverRow, recoverDraftAnswer,
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
const MAP = { front: { frame: 1, azimuthDeg: 0 }, side: { frame: 4, azimuthDeg: 90 }, back: { frame: 7, azimuthDeg: 180 } };
const ROW = (o: Partial<DraftRecoverRow> = {}): DraftRecoverRow => ({
  id: "11111111-2222-4333-8444-555555555555", called_at: iso(NOW - 30_000), source: "video", drafted: null,
  observed: null, frames: 12, video_count: 12, dims: DIMS, draft_ms: null, frame_map: null, ...o,
});
const NONE: DraftMoney = { kind: "none" };
const HELD: DraftMoney = { kind: "held" };
const RELEASED: DraftMoney = { kind: "released" };
const UNKNOWN: DraftMoney = { kind: "unknown" };
const CAPTURED = (agoMs: number | null): DraftMoney => ({ kind: "captured", postedMs: agoMs === null ? null : NOW - agoMs });
const NOT_CHARGED = /you are not charged/;
const CHARGED_ONCE = /charged once/;

Deno.test("the numbers: the answer closes at 300 s; a row no wallet speaks for is waited on to the 400 s wall clock", () => {
  assertEquals(DRAFT_STREAM_DEADLINE_MS, 300_000);
  assertEquals(DRAFT_RECOVER_PENDING_MS, 400_000);
  assertEquals([DRAFT_RECOVER_SETTLE_MS, DRAFT_RECOVER_MAX_ROWS], [90_000, 20]);
});

Deno.test("draftIdemKey: one cut for the insert, wallet_hold and the pickup", () => {
  assertEquals(draftIdemKey("11111111-2222-4333-8444-555555555555"), "11111111-2222-4333-8444-555555555555");
  for (const none of [undefined, null, ""]) assertEquals(draftIdemKey(none), null, JSON.stringify(none));
  assertEquals(draftIdemKey("k".repeat(200)), "k".repeat(120), "the same 120-character cut wallet_hold's p_idem always had");
  // Exactly `String(v ?? "").slice(0, 120) || null`, whatever the body carried.
  for (const v of [7, true, "  spaced  ", "x".repeat(121)]) {
    assertEquals(draftIdemKey(v), String(v ?? "").slice(0, 120) || null, JSON.stringify(v));
  }
});

Deno.test("pickRecoverRow: the NEWEST row under the key, drafted or not, whatever order they arrive in", () => {
  const failed = ROW({ id: "a", called_at: iso(NOW - 200_000), draft_ms: 100_000 });
  const retried = ROW({ id: "b", called_at: iso(NOW - 60_000), drafted: D3 });
  // A failed attempt then the retry that drafted: the retry, in either order.
  assertEquals(pickRecoverRow([failed, retried])?.id, "b");
  assertEquals(pickRecoverRow([retried, failed])?.id, "b");
  // A later attempt still running is newer than a draft of the same intent: it is the one answered.
  const running = ROW({ id: "c", called_at: iso(NOW - 5_000) });
  assertEquals(pickRecoverRow([running, failed, retried])?.id, "c");
  assertEquals(pickRecoverRow([retried, running, failed])?.id, "c");
  // Two drafted: the newest of them.
  const olderDraft = ROW({ id: "d", called_at: iso(NOW - 300_000), drafted: D3 });
  assertEquals(pickRecoverRow([olderDraft, retried])?.id, "b");
  // An unreadable called_at is never the newest.
  assertEquals(pickRecoverRow([ROW({ id: "e", called_at: "garbage", drafted: D3 }), failed])?.id, "a");
  // Nothing.
  for (const none of [[], null, undefined]) assertEquals(pickRecoverRow(none as DraftRecoverRow[] | null), null);
});

Deno.test("draftMoneyState: the press's own wallet rows, captured over held over released", () => {
  const tx = (state: string, postedAgo: number | null = null) => ({ state, posted_at: postedAgo === null ? null : iso(NOW - postedAgo) });
  assertEquals(draftMoneyState([]), { kind: "none" });
  assertEquals(draftMoneyState(null), { kind: "none" }, "the meter inactive: wallet_hold wrote nothing");
  assertEquals(draftMoneyState([tx("released")]), { kind: "released" });
  assertEquals(draftMoneyState([tx("released"), tx("released")]), { kind: "released" }, "several released attempts (248)");
  assertEquals(draftMoneyState([tx("released"), tx("held")]), { kind: "held" }, "an earlier attempt released, this one running");
  assertEquals(draftMoneyState([tx("released"), tx("posted", 5_000)]), { kind: "captured", postedMs: NOW - 5_000 });
  assertEquals(draftMoneyState([tx("posted")]), { kind: "captured", postedMs: null }, "a posted row with no time is still captured");
  assertEquals(draftMoneyState([tx("void")]), { kind: "unknown" }, "a state nobody writes is not guessed at");
  assertEquals(draftMoneyState([tx("released"), tx("void")]), { kind: "unknown" });
});

Deno.test("a drafted row: the success body's keys in its order, its own frame map, recovered", () => {
  const out = recoverDraftAnswer(ROW({ drafted: D3, observed: { roofNote: "gable" }, frames: 11, video_count: 11, frame_map: MAP }), NONE, NOW);
  assertEquals(out.kind, "draft");
  if (out.kind !== "draft") return;
  // calibrate_style_ai's success: { ok, d3, frames, dropped, observed, balanceCents, dims, frameMap, checkId }.
  assertEquals(Object.keys(out.body), ["ok", "d3", "frames", "dropped", "observed", "balanceCents", "dims", "frameMap", "checkId", "recovered"]);
  assertEquals(out.body, {
    ok: true, d3: D3, frames: 11, dropped: null, observed: { roofNote: "gable" }, balanceCents: null,
    dims: DIMS, frameMap: MAP, checkId: "11111111-2222-4333-8444-555555555555", recovered: true,
  });
  assertEquals([out.code, out.severity], ["ai_draft_recovered", "info"]);
  // A draft is a draft whatever the money says, and however old.
  for (const money of [NONE, HELD, RELEASED, UNKNOWN, CAPTURED(1_000), CAPTURED(3_600_000)]) {
    assertEquals(recoverDraftAnswer(ROW({ drafted: D3, called_at: iso(NOW - 60 * 60_000), draft_ms: 1 }), money, NOW).kind, "draft", money.kind);
  }
  // No map on the row (written before 253, or the reply had none): null, and the designer skips the check.
  const noMap = recoverDraftAnswer(ROW({ drafted: D3 }), NONE, NOW);
  assertEquals(noMap.kind === "draft" && noMap.body.frameMap, null);
  // No dims on the row (247 not applied when it ran): null, as the answer said then.
  const noDims = recoverDraftAnswer(ROW({ drafted: D3, dims: null }), NONE, NOW);
  assertEquals(noDims.kind === "draft" && noDims.body.dims, null);
});

Deno.test("the row's frame map is read back through the parser that made it, bounded by the walk frames that request sent", () => {
  const mapOf = (o: Partial<DraftRecoverRow>) => {
    const out = recoverDraftAnswer(ROW({ drafted: D3, ...o }), NONE, NOW);
    return out.kind === "draft" ? out.body.frameMap : "not a draft";
  };
  // "video": every image was a walk frame, so `frames` bounds it.
  assertEquals(mapOf({ frames: 8, frame_map: { front: { frame: 8, azimuthDeg: 0 }, side: { frame: 9, azimuthDeg: 90 } } }), { front: { frame: 8, azimuthDeg: 0 } });
  // "combined": only the leading video_count were walk frames; the builder's photos never are.
  assertEquals(mapOf({ source: "combined", frames: 12, video_count: 6, frame_map: { front: { frame: 6, azimuthDeg: 0 }, side: { frame: 7, azimuthDeg: 90 } } }), { front: { frame: 6, azimuthDeg: 0 } });
  // Junk on the row is nothing, never a guess.
  for (const junk of [[1, 2], "front", 7, { front: "one" }, { nonsense: { frame: 1, azimuthDeg: 0 } }]) {
    assertEquals(mapOf({ frame_map: junk }), null, JSON.stringify(junk));
  }
  assertEquals(mapOf({ frames: null, frame_map: MAP }), null, "no bound, no map");
});

Deno.test("isRecoverableDraft: our own sanitised spec, and nothing else", () => {
  assertEquals(isRecoverableDraft(ROW({ drafted: D3 })), true);
  for (const drafted of [null, undefined, [1, 2], "gable", 7, true]) {
    assertEquals(isRecoverableDraft(ROW({ drafted })), false, JSON.stringify(drafted));
  }
  assertEquals(isRecoverableDraft(null), false, "no row");
  // Exactly the rows recoverDraftAnswer hands back as a draft.
  for (const drafted of [D3, null, [1, 2], "gable", 7, true]) {
    for (const money of [NONE, CAPTURED(200_000)]) {
      const row = ROW({ drafted });
      assertEquals(recoverDraftAnswer(row, money, NOW).kind === "draft", isRecoverableDraft(row), JSON.stringify([drafted, money.kind]));
    }
  }
});

Deno.test("a row whose draft is not a spec object is a fault, never a draft to apply", () => {
  for (const drafted of [[1, 2], "gable", 7, true]) {
    const out = recoverDraftAnswer(ROW({ drafted }), NONE, NOW);
    assertEquals([out.kind, out.kind === "lost" && out.why, out.kind === "lost" && out.severity], ["lost", "unreadable", "error"], JSON.stringify(drafted));
  }
  const paid = recoverDraftAnswer(ROW({ drafted: "gable" }), CAPTURED(200_000), NOW);
  assert(paid.kind === "lost" && CHARGED_ONCE.test(paid.body.message), "and a paid one never says 'not charged'");
});

Deno.test("⚠️ no draft: the MONEY decides the sentence, whatever the timing", () => {
  const at = (money: DraftMoney, o: Partial<DraftRecoverRow> = {}) => recoverDraftAnswer(ROW(o), money, NOW);
  const pending = { ok: true, pending: true };
  // RELEASED: the draft failed and the hold went back. Not charged, however young the row, and
  // whatever draft_ms says (the old cut needed draft_ms + 90 s to say this).
  for (const o of [{ called_at: iso(NOW - 5_000) }, { draft_ms: null }, { draft_ms: 100_000, called_at: iso(NOW - 101_000) }]) {
    const r = at(RELEASED, o);
    assert(r.kind === "lost" && r.why === "failed" && r.severity === "info" && NOT_CHARGED.test(r.body.message), JSON.stringify([o, r]));
  }
  // CAPTURED, no draft: the draft is written a moment after the capture, so it is waited on for the
  // settle window, and then it is "charged once, and lost" -- never "not charged", and a fault.
  assertEquals(at(CAPTURED(1_000)).body, pending, "captured a moment ago");
  assertEquals(at(CAPTURED(DRAFT_RECOVER_SETTLE_MS)).body, pending);
  for (const money of [CAPTURED(DRAFT_RECOVER_SETTLE_MS + 1), CAPTURED(3_600_000), CAPTURED(null)]) {
    const r = at(money, { called_at: iso(NOW - 10_000) });
    assert(r.kind === "lost" && r.why === "charged_unsaved" && r.severity === "error", JSON.stringify(r));
    assert(r.kind === "lost" && CHARGED_ONCE.test(r.body.message) && /not been charged twice/.test(r.body.message) && !NOT_CHARGED.test(r.body.message), r.kind === "lost" ? r.body.message : "");
  }
  // HELD: the work is still running. Pending, however old the row.
  for (const ageMs of [1_000, DRAFT_RECOVER_PENDING_MS + 1, 60 * 60_000]) {
    assertEquals(at(HELD, { called_at: iso(NOW - ageMs), draft_ms: 100_000 }).body, pending, `held at ${ageMs}`);
  }
  // A state nobody writes: said without a claim either way, as a fault.
  const unsure = at(UNKNOWN);
  assert(unsure.kind === "lost" && unsure.why === "money_unknown" && unsure.severity === "error" && !NOT_CHARGED.test(unsure.body.message), JSON.stringify(unsure));
});

Deno.test("no wallet row at all (the meter inactive, today's live state): nothing was held, and the ledger says whether to wait", () => {
  const at = (ageMs: number, o: Partial<DraftRecoverRow> = {}) => recoverDraftAnswer(ROW({ called_at: iso(NOW - ageMs), ...o }), NONE, NOW);
  const pending = { ok: true, pending: true };
  assertEquals(at(10_000).body, pending, "the reads are out");
  assertEquals(at(DRAFT_RECOVER_PENDING_MS - 1).body, pending, "no usage written yet, inside the wall clock");
  const stale = at(DRAFT_RECOVER_PENDING_MS + 1);
  assert(stale.kind === "lost" && stale.why === "stale" && NOT_CHARGED.test(stale.body.message), JSON.stringify(stale));
  // The reads ended (draft_ms) and no draft: the success path writes `drafted` a moment after
  // draft_ms, so it is waited on for the settle window, and then it failed -- not charged, which is
  // TRUE here because nothing was held.
  assertEquals(at(120_000, { draft_ms: 100_000 }).body, pending);
  assertEquals(at(100_000 + DRAFT_RECOVER_SETTLE_MS, { draft_ms: 100_000 }).body, pending);
  const failed = at(100_000 + DRAFT_RECOVER_SETTLE_MS + 1, { draft_ms: 100_000 });
  assert(failed.kind === "lost" && failed.why === "failed" && failed.severity === "info" && NOT_CHARGED.test(failed.body.message), JSON.stringify(failed));
  // An unreadable called_at is never waited on for ever.
  assertEquals(recoverDraftAnswer(ROW({ called_at: "garbage" }), NONE, NOW).kind, "lost");
});

Deno.test("no row for the key: reason no_row (the shell waits 90 s on it), and the sentence is the money's", () => {
  const none = recoverDraftAnswer(null, NONE, NOW);
  assertEquals(none.body, { ok: true, pending: false, reason: "no_row", message: none.kind === "lost" ? none.body.message : "" });
  assert(none.kind === "lost" && none.severity === "info" && NOT_CHARGED.test(none.body.message), JSON.stringify(none));
  const released = recoverDraftAnswer(null, RELEASED, NOW);
  assert(released.kind === "lost" && released.why === "no_row" && NOT_CHARGED.test(released.body.message), JSON.stringify(released));
  // A charge under this key and no row that carries it (an insert that fell back without the key):
  // charged once, never "not charged", and a fault.
  const paid = recoverDraftAnswer(null, CAPTURED(10_000), NOW);
  assert(paid.kind === "lost" && paid.why === "no_row" && paid.severity === "error" && CHARGED_ONCE.test(paid.body.message), JSON.stringify(paid));
  const held = recoverDraftAnswer(null, HELD, NOW);
  assert(held.kind === "lost" && held.why === "no_row" && held.severity === "error" && !NOT_CHARGED.test(held.body.message), JSON.stringify(held));
});

Deno.test("⚠️ 'not charged' is said ONLY for a released hold or none at all, across every row and money state", () => {
  const rows: (DraftRecoverRow | null)[] = [
    null,
    ROW({ called_at: iso(NOW - 5_000) }),
    ROW({ called_at: iso(NOW - 10 * 60_000) }),
    ROW({ called_at: iso(NOW - 10 * 60_000), draft_ms: 100_000 }),
    ROW({ called_at: "garbage" }),
    ROW({ drafted: [1] }),
  ];
  const monies = [NONE, RELEASED, HELD, UNKNOWN, CAPTURED(1_000), CAPTURED(10 * 60_000), CAPTURED(null)];
  for (const row of rows) {
    for (const money of monies) {
      const out = recoverDraftAnswer(row, money, NOW);
      if (out.kind !== "lost") continue;
      assert(typeof out.body.reason === "string" && out.body.reason === out.why, "every lost body says why");
      const saysNotCharged = NOT_CHARGED.test(out.body.message);
      assertEquals(saysNotCharged, money.kind === "released" || money.kind === "none", `${JSON.stringify(row && { called_at: row.called_at, draft_ms: row.draft_ms, drafted: row.drafted })} / ${money.kind}: ${out.body.message}`);
      if (money.kind === "captured") assert(CHARGED_ONCE.test(out.body.message) && out.severity === "error", `captured: ${out.body.message}`);
    }
  }
});
