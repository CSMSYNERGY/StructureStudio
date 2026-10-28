// generate_door_look's money, ledger and limits (plan "Door looks from a photo", section 4's order of
// checks and section 8; phase P4), driven through the SHIPPED portal-settings handler with the database,
// the storage, the wallet's functions, the image library and the model all stubbed (doorLookFake.ts,
// doorModel.ts). Nothing reaches the network, and no model is called.
//
// WHAT IS PINNED:
//   1. wallet_hold is called on every press (door meter, the press's own key); with the meter inactive the
//      press runs free with no capture or release. With a hold: the Draft look row, THEN the capture with
//      the cost basis, THEN the ledger row done, in that order.
//   2. Every failure releases the hold and marks the row failed: no Draft row, no capture.
//   3. hold_replayed: 409 already_charged, the press's own row deleted, an info row, and no hold, capture
//      or release; insufficient_funds 402, hold_in_flight 409, meter_unknown and a hold error 503, each
//      with the row deleted and no model call.
//   4. The daily cap: distinct keys over 24 hours leaving the press's own key out, recounted after the
//      insert with it in; refused when unreadable (fails CLOSED); a lean retry on the last slot goes ahead;
//      0 is unlimited.
//   5. One key owns two rows at most; a key that drafted is done; a retry with under 150 s of the press
//      clock left is refused as a timeout; a generation still running is a 409, and so is the recount.
//   6. The $3.00 ceiling counts the key's earlier rows.
//   7. The photos: exact paths only, read back and checked before any row or hold; the model gets
//      10-minute signed URLs, never a public one.
//   8. Streaming, and generate_door_look_recover.
// Tenants and users are made up; the repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertFalse, assertRejects } from "jsr:@std/assert";
import { call, FakeDb, OTHER, OWN, USER_ID, type Row } from "./doorLookFake.ts";
import { fakeImageLibrary, fakeModel, pngHead, type Script } from "./doorModel.ts";
import { singleDoor, withStrips } from "./doorReads.ts";
import { DOOR_EDGE_PAD_IN, DOOR_LOOK_PROMPT_ID } from "../doorLookPrompt.ts";
import { doorGenHooks, doorWalletKey } from "../../portal-settings/doorGenerate.ts";

const { lib } = fakeImageLibrary();
doorGenHooks.loadImageLibrary = (() => Promise.resolve(lib)) as any;

const KEY = "press-0000-0001";
const ON = { DOOR_LOOK_AI_ENABLED: "1", ANTHROPIC_API_KEY: "test-key" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FRONT = `${OWN}/door-ref-${uuid(0xf01)}.png`;
const HINGE = `${OWN}/door-ref-${uuid(0xf02)}.png`;
const BODY = { action: "generate_door_look", idempotencyKey: KEY, widthIn: 36, heightIn: 80, leaves: 1, name: "Our barn door", photos: { front: FRONT } };
const READ = withStrips(singleDoor(), DOOR_EDGE_PAD_IN).read; // read off the browser's photo, edge strips and all
const GOOD: Script = { stageA: [READ, READ, READ], hinges: { type: "strap", finish: "black" }, handle: { type: "barn", finish: "black" } };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
// What a first try that failed retryably leaves on its row (doorLedgerFields): the failure, and its spend.
const RETRYABLE = { failure: { code: "ai_door_unparseable", retryable: true }, ceilingCents: 30, costCents: 12 };

function seed(o: { settings?: Row; calls?: Row[] } = {}): FakeDb {
  const db = new FakeDb({
    client_settings: [{ client_id: OWN, door_looks_beta: true, internal_account: true, billing_exempt: false, ai_door_daily_cap: null, ...(o.settings ?? {}) }],
    ai_door_calls: o.calls ?? [],
    door_looks: [],
  });
  // 770 x 1540: inside the photo limits, the typed 36 x 80 plus 2 in strips each side (40 x 80), and the
  // reads' 1000 x 2000 shape within 2%.
  db.files[`door-refs/${FRONT}`] = pngHead(770, 1540);
  db.files[`door-refs/${HINGE}`] = pngHead(600, 600);
  return db;
}
function hold(db: FakeDb, answer: Row | { error: string }, capture: any = 1500) {
  db.rpcAnswer = (fn) => {
    if (fn === "wallet_hold") return "error" in answer ? { data: null, error: { message: answer.error } } : { data: answer, error: null };
    if (fn === "wallet_capture") return { data: capture, error: null };
    return { data: null, error: null };
  };
}
const rpcs = (db: FakeDb, fn?: string) => db.rpcCalls.filter((c) => !fn || c.fn === fn);
const steps = (db: FakeDb) => db.writes.filter((w) => ["ai_door_calls", "door_looks", "rpc:wallet_hold", "rpc:wallet_capture", "rpc:wallet_release"].includes(w.table))
  .map((w) => w.table.startsWith("rpc:") ? w.table.slice(4) : `${w.verb} ${w.table}${w.verb === "update" && w.row.status ? `:${w.row.status}` : ""}`);
const press = (db: FakeDb, body: Record<string, unknown> = BODY, script: Script = GOOD) => {
  const m = fakeModel(script);
  return call(db, body, { env: ON, fetch: m.fetch }).then((r) => ({ ...r, m }));
};

// ─── 1. THE MONEY ON A DRAFT ──────────────────────────────────────────────────────────────────────
Deno.test("meter inactive: wallet_hold still asked (door meter, the press's key), the press runs free, a Draft look and a done ledger row", async () => {
  const db = seed();
  const r = await press(db);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals([r.body.ok, r.body.spec.base, r.body.look.status, r.body.look.name], [true, "zbrace", "draft", "Our barn door"]);
  const h = rpcs(db, "wallet_hold");
  assertEquals(h.length, 1);
  assertEquals(h[0].args, { p_client_id: OWN, p_kind: "door_look_generation", p_idem: doorWalletKey(KEY), p_user: USER_ID });
  assertEquals(rpcs(db).map((c) => c.fn), ["wallet_hold"], "no capture and no release with no hold");
  assertEquals(steps(db), ["insert ai_door_calls", "wallet_hold", "insert door_looks", "update ai_door_calls:done"]);
  const row = db.rows("ai_door_calls")[0];
  assertEquals([row.client_id, row.user_id, row.idem_key, row.status, row.effort, row.photo_paths], [OWN, USER_ID, KEY, "done", "high", [FRONT]]);
  assertEquals([row.dims.widthIn, row.dims.heightIn, row.dims.leaves, row.dims.photo, row.dims.padIn], [36, 80, 1, [770, 1540], 2]);
  // The press clock runs from the request, which came before the row.
  assert(Date.parse(row.dims.pressStartedAt) <= Date.parse(row.created_at) && r.body.pressStartedAt === row.dims.pressStartedAt);
  assert(row.tokens.costCents > 0 && row.tokens.prompt === DOOR_LOOK_PROMPT_ID);
  assertEquals([row.charged_cents, row.wallet_tx_id], [undefined, undefined], "nothing charged");
  const look = db.rows("door_looks")[0];
  assertEquals([look.client_id, look.status, look.base, look.ai_call_id, look.created_by, look.spec.base], [OWN, "draft", "zbrace", row.id, USER_ID, "zbrace"]);
  assertEquals([r.body.lookId, r.body.checkId], [look.id, row.id]);
  // The colours came from the decoded photo (one paint all over: every part follows the Door pick).
  assertEquals(r.body.spec.colors, { infill: "door", frame: "door", members: "door" });
  // The ledger's working data never reaches the browser.
  for (const k of ["measure", "observed", "reads", "photo_paths", "unexplained"]) assertFalse(JSON.stringify(r.body).includes(`"${k}"`), k);
  assertFalse(JSON.stringify(r.body).includes("door-refs"), "no photo path or URL goes back");
});

Deno.test("metered: hold, then the Draft row, then the capture with the cost basis, then the row done with charged_cents and wallet_tx_id", async () => {
  const db = seed();
  hold(db, { hold_id: 77, price_cents: 500, balance_after: 2000, err: null }, 1500);
  const r = await press(db);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(steps(db).filter((s) => s !== "update ai_door_calls"), ["insert ai_door_calls", "wallet_hold", "insert door_looks", "wallet_capture", "update ai_door_calls:done"]);
  const row = db.rows("ai_door_calls")[0];
  const cap = rpcs(db, "wallet_capture")[0].args;
  assertEquals([cap.p_hold_id, cap.p_ref_id, cap.p_cost_cents], [77, row.id, Math.round(row.tokens.costCents)]);
  assertEquals([row.charged_cents, row.wallet_tx_id], [500, 77]);
  assertEquals(r.body.balanceCents, 1500);
  assertEquals(rpcs(db, "wallet_release").length, 0);
});

// ─── 2. EVERY FAILURE RELEASES ────────────────────────────────────────────────────────────────────
Deno.test("every failure releases the hold and marks the row failed: no Draft look, no capture, one coded row", async () => {
  const notDoor = { measure: {}, refuse: "not_door", leaves: 1 };
  const cases: [string, Script, number, string][] = [
    ["a refusal", { stageA: [notDoor, notDoor, notDoor] }, 422, "ai_door_refused"],
    ["an unsupported door", { stageA: [READ, { measure: {}, refuse: "unsupported", leaves: 1 }, READ] }, 422, "ai_door_unsupported"],
    ["a reply we cannot read", { stageA: [{ text: "a door" }, { text: "a door" }, { text: "a door" }] }, 502, "ai_door_unparseable"],
    ["an API that refuses the request", { stageA: () => ({ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}' }) }, 502, "ai_door_upstream"],
  ];
  for (const [what, script, status, code] of cases) {
    const db = seed();
    hold(db, { hold_id: 9, price_cents: 500, balance_after: 2000, err: null });
    const r = await press(db, BODY, script);
    assertEquals([r.status, r.body.code], [status, code], `${what}: ${JSON.stringify(r.body)}`);
    assertEquals(rpcs(db, "wallet_release").map((c) => c.args.p_hold_id), [9], what);
    assertEquals(rpcs(db, "wallet_capture").length, 0, what);
    assertEquals(db.rows("door_looks").length, 0, what);
    const row = db.rows("ai_door_calls")[0];
    assertEquals(row.status, "failed", what);
    assert(row.tokens.failure?.code === code || row.tokens.refuse?.code === code, `${what}: ${JSON.stringify(row.tokens)}`);
    assert(db.errorCodes().includes(code), `${what} files ${code}`);
    assertFalse("retryable" in r.body, `${what} is not retried`);
  }
});

Deno.test("a throw after the hold (a bug, an unexpected rejection) still releases it and marks the row failed, then rethrows for the error wrapper", async () => {
  const db = seed();
  hold(db, { hold_id: 12, price_cents: 500, balance_after: 2000, err: null });
  db.failing.add("storage:sign");
  const m = fakeModel(GOOD);
  await assertRejects(() => call(db, BODY, { env: ON, fetch: m.fetch }), Error, "storage went away");
  assertEquals(rpcs(db, "wallet_release").map((c) => c.args.p_hold_id), [12]);
  assertEquals([rpcs(db, "wallet_capture").length, db.rows("door_looks").length, m.sent.length], [0, 0, 0]);
  assertEquals([db.rows("ai_door_calls")[0].status, db.rows("ai_door_calls")[0].tokens.failure.code], ["failed", "ai_door_failed"]);
});

Deno.test("a cut-off first try is retryable (the browser's one lean retry); the lean retry itself never is", async () => {
  const db = seed();
  const r = await press(db, BODY, { stageA: ["cutoff", "cutoff", "cutoff"] });
  assertEquals([r.status, r.body.code, r.body.retryable], [502, "ai_door_unparseable", true]);
  // The lean retry: same key, effort low, a second row under the key.
  const again = await press(db, { ...BODY, lean: true }, { stageA: ["cutoff", "cutoff", "cutoff"] });
  assertEquals([again.status, again.body.retryable], [502, undefined]);
  assertEquals(db.rows("ai_door_calls").map((x) => [x.idem_key, x.effort, x.status]), [[KEY, "high", "failed"], [KEY, "low", "failed"]]);
  assertEquals((again.m.sent[0].body.output_config as any).effort, "low");
});

// ─── 3. THE HOLD'S OTHER ANSWERS ──────────────────────────────────────────────────────────────────
Deno.test("hold_replayed: 409 already_charged, this press's row deleted, an info row, no capture, no release, no model call", async () => {
  const db = seed();
  hold(db, { hold_id: null, price_cents: 500, balance_after: 0, err: "hold_replayed" });
  const r = await press(db);
  assertEquals([r.status, r.body.code], [409, "already_charged"]);
  assert(r.body.error.includes("its draft is in your Door looks list"));
  assertEquals(db.rows("ai_door_calls").length, 0, "the press's own row is gone");
  assertEquals(rpcs(db).map((c) => c.fn), ["wallet_hold"]);
  assertEquals(r.m.sent.length, 0);
  const info = db.errors.find((e) => e.code === "wallet_hold_replayed");
  assertEquals(info?.severity, "info");
});

Deno.test("insufficient funds 402, a hold in flight 409, no price row and a failed hold 503: each deletes its row and calls no model", async () => {
  const cases: [Row | { error: string }, number, string][] = [
    [{ hold_id: null, price_cents: 500, balance_after: 120, err: "insufficient_funds" }, 402, "insufficient_funds"],
    [{ hold_id: null, price_cents: 500, balance_after: 900, err: "hold_in_flight" }, 409, "door_look_busy"],
    [{ hold_id: null, price_cents: null, balance_after: null, err: "meter_unknown" }, 503, "ai_door_meter_missing"],
    [{ error: "connection lost" }, 503, "ai_door_hold_failed"],
  ];
  for (const [answer, status, code] of cases) {
    const db = seed();
    hold(db, answer);
    const r = await press(db);
    assertEquals([r.status, r.body.code], [status, code], JSON.stringify(r.body));
    assertEquals(db.rows("ai_door_calls").length, 0, code);
    assertEquals(r.m.sent.length, 0, code);
    assertEquals(rpcs(db).map((c) => c.fn), ["wallet_hold"], code);
  }
  const db = seed();
  hold(db, { hold_id: null, price_cents: 500, balance_after: 120, err: "insufficient_funds" });
  const r = await press(db);
  assertEquals([r.body.priceCents, r.body.balanceCents], [500, 120]);
  assertEquals(r.body.error, "A door look costs $5.00 and your wallet has $1.20. Add funds in Settings → Billing, then try again.");
});

// ─── 4. THE DAILY CAP ─────────────────────────────────────────────────────────────────────────────
const others = (n: number, msAgo = 60 * 60_000) => Array.from({ length: n }, (_, i) => ({ id: uuid(100 + i), client_id: OWN, idem_key: `other-${i}`, status: "failed", created_at: ago(msAgo) }));

Deno.test("the cap: distinct keys over 24 hours leaving this press's own out; refused at the cap before any row; older rows and other tenants never count", async () => {
  const full = seed({ calls: [...others(10), { ...others(1)[0], id: uuid(999), idem_key: "other-0" }] });
  const r = await press(full);
  assertEquals([r.status, r.body.code], [429, "ai_door_daily_cap"]);
  assertEquals(r.body.error, "You've pressed Generate 10 times in the last 24 hours, which is your limit. You can press again once your oldest press is 24 hours old.");
  assertEquals(full.writesTo("ai_door_calls", "insert").length, 0);
  assertEquals(rpcs(full).length, 0);
  // Ten keys, one of which has two rows (a press and its lean retry): still ten presses. Nine is under.
  const nine = await press(seed({ calls: others(9) }));
  assertEquals(nine.status, 200, JSON.stringify(nine.body));
  // Older than 24 hours, or another builder's: not counted.
  assertEquals((await press(seed({ calls: others(10, 25 * 60 * 60_000) }))).status, 200);
  assertEquals((await press(seed({ calls: others(10).map((x) => ({ ...x, client_id: OTHER })) }))).status, 200);
  // The tenant's own cap.
  assertEquals((await press(seed({ settings: { ai_door_daily_cap: 3 }, calls: others(3) }))).body.code, "ai_door_daily_cap");
});

Deno.test("the cap: a lean retry on the last slot goes ahead (its own key is not counted twice); 0 is unlimited and never counted", async () => {
  const mine = { id: uuid(500), client_id: OWN, idem_key: KEY, status: "failed", created_at: ago(60_000), tokens: RETRYABLE };
  const db = seed({ calls: [...others(9), mine] });
  const r = await press(db, { ...BODY, lean: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const unlimited = seed({ settings: { ai_door_daily_cap: 0 }, calls: others(50) });
  assertEquals((await press(unlimited)).status, 200);
  assertEquals(unlimited.readsOf("ai_door_calls").filter((x) => x.cols === "idem_key").length, 0, "never counted");
});

Deno.test("the cap fails CLOSED: an unreadable count or setting refuses, before a row, whether or not the meter is on", async () => {
  for (const fail of ["ai_door_calls.select:idem_key", "client_settings.select:ai_door_daily_cap"]) {
    for (const metered of [false, true]) {
      const db = seed();
      if (metered) hold(db, { hold_id: 5, price_cents: 500, balance_after: 2000, err: null });
      db.failing.add(fail);
      const r = await press(db);
      assertEquals([r.status, r.body.code], [503, "ai_door_cap_unread"], `${fail} / ${metered}`);
      assertEquals(r.body.error, "We couldn't check today's count. Try again in a few minutes.");
      assertEquals(db.writesTo("ai_door_calls", "insert").length, 0);
      assertEquals(rpcs(db).length, 0);
      assert(db.errorCodes().includes("ai_door_cap_unread"));
    }
  }
});

Deno.test("the recount after the insert: a press that raced to the last slot, or a second running row, deletes its own row and refuses", async () => {
  // Another press's row lands between this press's count and its insert.
  const race = (db: FakeDb, row: Row) => {
    let once = true;
    db.afterInsert = (t) => {
      if (t === "ai_door_calls" && once) {
        once = false;
        db.rows("ai_door_calls").push(row);
      }
    };
  };
  const capped = seed({ settings: { ai_door_daily_cap: 1 } });
  race(capped, { id: uuid(700), client_id: OWN, idem_key: "tab-two", status: "failed", created_at: ago(1_000) });
  const r = await press(capped);
  assertEquals([r.status, r.body.code], [429, "ai_door_daily_cap"]);
  assertEquals(capped.rows("ai_door_calls").map((x) => x.idem_key), ["tab-two"], "its own row deleted");
  assertEquals([rpcs(capped).length, r.m.sent.length], [0, 0]);
  const two = seed();
  race(two, { id: uuid(701), client_id: OWN, idem_key: "tab-two", status: "running", created_at: ago(1_000) });
  const t = await press(two);
  assertEquals([t.status, t.body.code], [409, "door_look_busy"]);
  assertEquals(two.rows("ai_door_calls").map((x) => x.idem_key), ["tab-two"]);
  assertEquals(rpcs(two).length, 0);
  // An unreadable recount refuses too, its row deleted.
  const unread = seed();
  let n = 0;
  unread.afterInsert = (tb) => { if (tb === "ai_door_calls" && n++ === 0) unread.failing.add("ai_door_calls.select:idem_key"); };
  const u = await press(unread);
  assertEquals([u.status, u.body.code, unread.rows("ai_door_calls").length], [503, "ai_door_cap_unread", 0]);
});

// ─── 5. ONE KEY, ONE PRESS ────────────────────────────────────────────────────────────────────────
Deno.test("one key: a third row is refused, a key that drafted is done, a retry with under 150 s of the press clock is a timeout", async () => {
  const two = [0, 1].map((i) => ({ id: uuid(800 + i), client_id: OWN, idem_key: KEY, status: "failed", created_at: ago(120_000 - i) }));
  const third = seed({ calls: two });
  const r = await press(third, { ...BODY, lean: true });
  assertEquals([r.status, r.body.code, third.writesTo("ai_door_calls", "insert").length], [409, "door_look_busy", 0]);
  const done = seed({ calls: [{ ...two[0], status: "done" }] });
  assertEquals((await press(done)).body.code, "door_look_already_made");
  const late = seed({ calls: [{ ...two[0], created_at: ago(480_000 - 140_000), tokens: RETRYABLE }] });
  const l = await press(late, { ...BODY, lean: true });
  assertEquals([l.status, l.body.code, l.body.error], [504, "ai_door_timeout", "This took too long. Please try again. You haven't been charged."]);
  assertEquals([late.writesTo("ai_door_calls", "insert").length, rpcs(late).length, l.m.sent.length], [0, 0, 0]);
  const info = late.errors.find((e) => e.code === "ai_door_timeout");
  assertEquals(info?.severity, "info");
});

Deno.test("the second row under a key is the server's call: only a lean retry, after a retryable failure that recorded its spend", async () => {
  const row = (tokens: unknown, status = "failed") => ({ id: uuid(850), client_id: OWN, idem_key: KEY, status, created_at: ago(60_000), tokens });
  const cases: [string, unknown, Record<string, unknown>][] = [
    ["not lean", RETRYABLE, BODY],
    ["after a refusal", { refuse: { code: "ai_door_refused", reason: "open" } }, { ...BODY, lean: true }],
    ["after a failure that was not retryable", { failure: { code: "ai_door_unparseable", retryable: false }, ceilingCents: 30 }, { ...BODY, lean: true }],
    ["after a row whose spend was never recorded", { failure: { code: "ai_door_failed" } }, { ...BODY, lean: true }],
    ["after a row with no tokens at all", null, { ...BODY, lean: true }],
  ];
  for (const [what, tokens, body] of cases) {
    const db = seed({ calls: [row(tokens)] });
    const r = await press(db, body);
    assertEquals([r.status, r.body.code], [409, "door_look_key_used"], what);
    assertEquals([db.writesTo("ai_door_calls", "insert").length, rpcs(db).length, r.m.sent.length], [0, 0, 0], what);
  }
  assertEquals((await press(seed({ calls: [row(RETRYABLE)] }), { ...BODY, lean: true })).status, 200, "the one lean retry");
});

Deno.test("a ledger write that fails whole still records the outcome and the spend (a NUL from the model would otherwise lose it)", async () => {
  const db = seed();
  let n = 0;
  db.failing.add("ai_door_calls.update");
  const real = db.from.bind(db);
  // Only the first update fails (the full row); the fallback lands.
  db.from = (t: string) => {
    if (t === "ai_door_calls" && db.failing.has("ai_door_calls.update")) {
      const q = real(t) as any;
      const update = q.update.bind(q);
      q.update = (patch: any) => {
        if (n++ > 0) db.failing.delete("ai_door_calls.update");
        return update(patch);
      };
      return q;
    }
    return real(t);
  };
  const r = await press(db, BODY, { stageA: ["cutoff", "cutoff", "cutoff"] });
  assertEquals([r.status, r.body.retryable], [502, true]);
  const row = db.rows("ai_door_calls")[0];
  assertEquals([row.status, row.tokens.failure.retryable, typeof row.tokens.ceilingCents], ["failed", true, "number"]);
  assert(db.errorCodes().includes("ai_door_ledger_write_failed"));
});

Deno.test("another generation running (a row under 6 minutes) is a 409 before any row; one older is a dead worker and does not block", async () => {
  const busy = seed({ calls: [{ id: uuid(900), client_id: OWN, idem_key: "tab-two", status: "running", created_at: ago(30_000) }] });
  const r = await press(busy);
  assertEquals([r.status, r.body.code, r.body.error], [409, "door_look_busy", "A door look is already being made. Wait for it to finish."]);
  assertEquals([busy.writesTo("ai_door_calls", "insert").length, rpcs(busy).length], [0, 0]);
  const stale = seed({ calls: [{ id: uuid(901), client_id: OWN, idem_key: "tab-two", status: "running", created_at: ago(7 * 60_000) }] });
  assertEquals((await press(stale)).status, 200);
  const theirs = seed({ calls: [{ id: uuid(902), client_id: OTHER, idem_key: "x", status: "running", created_at: ago(30_000) }] });
  assertEquals((await press(theirs)).status, 200, "another builder's generation is theirs");
});

// ─── 6. THE CEILING ACROSS A KEY'S ROWS ───────────────────────────────────────────────────────────
Deno.test("the $3.00 ceiling counts what the key's first try already cost: a lean retry that cannot fit Stage A calls nothing and releases", async () => {
  const first = { id: uuid(600), client_id: OWN, idem_key: KEY, status: "failed", created_at: ago(90_000), tokens: { ...RETRYABLE, ceilingCents: 280 } };
  const db = seed({ calls: [first] });
  hold(db, { hold_id: 31, price_cents: 500, balance_after: 2000, err: null });
  const r = await press(db, { ...BODY, lean: true });
  assertEquals([r.status, r.body.code], [503, "ai_door_ceiling"]);
  assertEquals(r.m.sent.length, 0, "no model call past the ceiling");
  assertEquals(rpcs(db, "wallet_release").map((c) => c.args.p_hold_id), [31]);
});

// ─── 7. THE PHOTOS ────────────────────────────────────────────────────────────────────────────────
Deno.test("photos: only this tenant's exact paths, read back and checked before any row or hold; the model gets 10-minute signed URLs", async () => {
  const bad = [
    `${OTHER}/door-ref-${uuid(1)}.png`, `${OWN}/../${OTHER}/door-ref-${uuid(1)}.png`, `${OWN}/door-ref-${uuid(1)}.gif`,
    `https://example.test/${OWN}/door-ref-${uuid(1)}.png`, `${OWN}/door-look-${uuid(1)}.png`, `${OWN}/door-ref-%2e%2e.png`,
  ];
  for (const front of bad) {
    const db = seed();
    const r = await press(db, { ...BODY, photos: { front } });
    assertEquals([r.status, r.body.code], [400, "door_look_photo"], front);
    assertEquals([db.writes.length, db.storage.length], [0, 0], front);
  }
  const missing = seed();
  delete missing.files[`door-refs/${FRONT}`];
  assertEquals((await press(missing)).body.code, "door_photo_missing");
  const svg = seed();
  svg.files[`door-refs/${FRONT}`] = new TextEncoder().encode("<svg/>");
  assertEquals((await press(svg)).body.code, "door_photo_type");
  const huge = seed();
  huge.files[`door-refs/${FRONT}`] = pngHead(2400, 3200);
  assertEquals((await press(huge)).body.code, "door_photo_too_big");
  // A front photo cut at the leaves (the typed 36 x 80, no edge strips: before DOOR_LOOK_V2) is refused
  // before anything is held: its points would land in the wrong place on the door.
  const cut = seed();
  cut.files[`door-refs/${FRONT}`] = pngHead(700, 1556);
  const refused = await press(cut);
  assertEquals([refused.status, refused.body.code, refused.body.error], [400, "door_photo_shape", "This photo isn't straightened to the door's size. Straighten it again, then press Generate."]);
  assertEquals([cut.writes.length, rpcs(cut).length], [0, 0]);
  // A wide door too: cut at the leaves, a 240 x 120 in photo is only 1.6% narrow (under 3%), and is still
  // refused; straightened with the strips (doorFitSize: 1565 x 770) it passes the check.
  const wide = { ...BODY, widthIn: 240, heightIn: 120 };
  const wideCut = seed();
  wideCut.files[`door-refs/${FRONT}`] = pngHead(1552, 776);
  assertEquals((await press(wideCut, wide)).body.code, "door_photo_shape");
  assertEquals([wideCut.writes.length, rpcs(wideCut).length], [0, 0]);
  const wideStrip = seed();
  wideStrip.files[`door-refs/${FRONT}`] = pngHead(1565, 770);
  assertFalse((await press(wideStrip, wide)).body.code === "door_photo_shape");
  // The close-ups are held to the same limits: the ceiling prices every image as one inside them.
  const bigHinge = seed();
  bigHinge.files[`door-refs/${HINGE}`] = pngHead(4000, 3000);
  assertEquals((await press(bigHinge, { ...BODY, photos: { front: FRONT, hinge: HINGE } })).body.code, "door_photo_too_big");
  for (const db of [missing, svg, huge, bigHinge]) assertEquals([db.writes.length, rpcs(db).length], [0, 0]);
  // With a hinge close-up: both read back, both signed for 600 s, both sent as URLs.
  const db = seed();
  const r = await press(db, { ...BODY, photos: { front: FRONT, hinge: HINGE } });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(db.storage.filter((s) => s.op === "sign-read-600").map((s) => [s.bucket, s.path]), [["door-refs", FRONT], ["door-refs", HINGE]]);
  const sent = JSON.stringify(r.m.sent.find((s) => s.kind === "stageA")!.body);
  assert(sent.includes(`/object/sign/door-refs/${FRONT}?token=read`) && sent.includes(`/object/sign/door-refs/${HINGE}?token=read`));
  assertFalse(sent.includes("/object/public/"), "never a public URL");
  assertEquals(db.rows("ai_door_calls")[0].photo_paths, [FRONT, HINGE]);
});

// ─── 8. STREAMING AND RECOVER ─────────────────────────────────────────────────────────────────────
Deno.test("streamed: a 200 at once with a heartbeat, then the press's own answer", async () => {
  const db = seed();
  const m = fakeModel(GOOD);
  const r = await call(db, { ...BODY, stream: true }, { env: ON, fetch: m.fetch, raw: true });
  assertEquals(r.status, 200);
  assert(r.text!.startsWith(" "), "the heartbeat's first byte");
  const body = JSON.parse(r.text!.trim());
  assertEquals([body.ok, body.spec.base], [true, "zbrace"]);
  assertEquals(db.rows("ai_door_calls")[0].streamed, true);
  // A refusal rides in the body, with its status.
  const db2 = seed();
  const notDoor = { measure: {}, refuse: "not_door", leaves: 1 };
  const r2 = await call(db2, { ...BODY, stream: true }, { env: ON, fetch: fakeModel({ stageA: [notDoor, notDoor, notDoor] }).fetch, raw: true });
  const b2 = JSON.parse(r2.text!.trim());
  assertEquals([r2.status, b2.status, b2.code], [200, 422, "ai_door_refused"]);
});

Deno.test("recover: the newest row under the key, the caller's own only; works with the kill switch off, never without the flag", async () => {
  const db = seed();
  const first = await press(db);
  assertEquals(first.status, 200);
  const look = db.rows("door_looks")[0];
  const rec = await call(db, { action: "generate_door_look_recover", idempotencyKey: KEY });
  assertEquals(rec.status, 200, JSON.stringify(rec.body));
  assertEquals([rec.body.recovered, rec.body.lookId, rec.body.spec.base, rec.body.checkId], [true, look.id, "zbrace", db.rows("ai_door_calls")[0].id]);
  assertFalse(JSON.stringify(rec.body).includes("door-refs"));
  // Another user's row under the same key: not theirs to pick up.
  db.rows("ai_door_calls")[0].user_id = "00000000-0000-4000-8000-0000000000c1";
  const none = await call(db, { action: "generate_door_look_recover", idempotencyKey: KEY });
  assertEquals([none.body.pending, none.body.reason], [false, "no_row"]);
  // A failed press: its own sentence, not charged.
  const f = seed({ calls: [{ id: uuid(1), client_id: OWN, user_id: USER_ID, idem_key: KEY, status: "failed", created_at: ago(5_000), tokens: { failure: { code: "ai_door_timeout", message: "This took too long. Please try again. You haven't been charged." } } }] });
  const fr = await call(f, { action: "generate_door_look_recover", idempotencyKey: KEY });
  assertEquals([fr.body.pending, fr.body.code, fr.body.message], [false, "ai_door_timeout", "This took too long. Please try again. You haven't been charged."]);
  const run = seed({ calls: [{ id: uuid(2), client_id: OWN, user_id: USER_ID, idem_key: KEY, status: "running", created_at: ago(5_000) }] });
  assertEquals((await call(run, { action: "generate_door_look_recover", idempotencyKey: KEY })).body, { ok: true, pending: true });
  const wallet = run.readsOf("wallet_transactions")[0];
  assert(wallet.filters.some((x: any[]) => x[1] === "idempotency_key" && x[2] === doorWalletKey(KEY)), "the press's own wallet rows, by its door key");
  const off = seed({ settings: { door_looks_beta: false } });
  assertEquals((await call(off, { action: "generate_door_look_recover", idempotencyKey: KEY })).body.code, "door_looks_off");
  assertEquals((await call(seed(), { action: "generate_door_look_recover" })).status, 400);
});

Deno.test("GATES: generate_door_look and its recover sit under settings_options at edit, as named branches", async () => {
  const src = await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url));
  for (const a of ["generate_door_look", "generate_door_look_recover"]) {
    assert(new RegExp(`\\b${a}:\\s*\\{ area: "settings_options", level: "edit" \\}`).test(src), a);
    assert(src.includes(`action === "${a}"`), `${a} is a named branch`);
  }
});
