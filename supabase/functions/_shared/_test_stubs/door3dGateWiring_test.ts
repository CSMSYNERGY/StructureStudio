// generate_door_look's gates (plan "Door looks from a photo", section 4 steps 1-2, section 9; phase P4),
// driven through the SHIPPED portal-settings handler (doorLookFake.ts). The pilot tenant is internal and
// billing-exempt, so it passes the 3D check whatever its grants: `ai_door_no_3d` cannot be reached live,
// and this file is its proof.
//
// WHAT IS PINNED: with no 3D, or a 3D check that throws, the press answers 403 ai_door_no_3d before any
// ledger row, hold, photo read or model call. The kill switch DOOR_LOOK_AI_ENABLED (unset is off) and the
// tenant flag refuse the same way. (P5's door_look_check gets the same kill switch when it is built.)
// Tenants and users are made up; the repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { call, FakeDb, OWN, type Row } from "./doorLookFake.ts";
import { fakeImageLibrary, fakeModel, pngHead } from "./doorModel.ts";
import { singleDoor } from "./doorReads.ts";
import { doorGenHooks } from "../../portal-settings/doorGenerate.ts";

doorGenHooks.loadImageLibrary = (() => Promise.resolve(fakeImageLibrary().lib)) as any;
const FRONT = `${OWN}/door-ref-00000000-0000-4000-8000-000000000f01.png`;
const BODY = { action: "generate_door_look", idempotencyKey: "press-1", widthIn: 36, heightIn: 80, leaves: 1, photos: { front: FRONT } };
const ON = { DOOR_LOOK_AI_ENABLED: "1", ANTHROPIC_API_KEY: "test-key" };
const R = singleDoor().read;

function seed(settings: Row): FakeDb {
  const db = new FakeDb({
    client_settings: [{ client_id: OWN, door_looks_beta: true, internal_account: false, billing_exempt: false, ...settings }],
    billing_plans: [{ id: "plan-3d", feature: "view_3d", billing_interval: "month", operator_grantable: true }],
    client_feature_grants: [],
    billing_subscriptions: [],
  });
  db.files[`door-refs/${FRONT}`] = pngHead(700, 1556);
  return db;
}
function untouched(db: FakeDb, sent: number) {
  assertEquals(db.writes.length, 0, "no ledger row, no hold, no look");
  assertEquals(db.rpcCalls.length, 0, "no wallet call");
  assertEquals(db.storage.length, 0, "no photo read or signed");
  assertEquals(sent, 0, "no model call");
}

Deno.test("no 3D on the account: 403 ai_door_no_3d before any row, hold, photo or model call", async () => {
  const db = seed({});
  const m = fakeModel({ stageA: [R, R, R] });
  const r = await call(db, BODY, { env: ON, fetch: m.fetch });
  assertEquals([r.status, r.body.code, r.body.error], [403, "ai_door_no_3d", "Making door looks from photos needs 3D on your account."]);
  untouched(db, m.sent.length);
});

Deno.test("a 3D check that throws refuses too (it is a paid action), and files why", async () => {
  const db = seed({});
  db.failing.add("billing_plans");
  const m = fakeModel({ stageA: [R, R, R] });
  const r = await call(db, BODY, { env: ON, fetch: m.fetch });
  assertEquals([r.status, r.body.code], [403, "ai_door_no_3d"]);
  untouched(db, m.sent.length);
  assert(db.errors.some((e) => e.code === "ai_door_no_3d" && String(e.message).includes("billing_plans")), JSON.stringify(db.errors));
});

Deno.test("3D by a grant, a payment, or an internal or billing-exempt account passes the check", async () => {
  const grant = seed({});
  grant.rows("client_feature_grants").push({ client_id: OWN, feature: "view_3d", expires_at: null });
  const exempt = seed({ billing_exempt: true });
  const internal = seed({ internal_account: true });
  for (const db of [grant, exempt, internal]) {
    const r = await call(db, BODY, { env: ON, fetch: fakeModel({ stageA: [R, R, R], hinges: { type: "tstrap" }, handle: { type: "barn" } }).fetch });
    assertEquals(r.status, 200, JSON.stringify(r.body));
  }
  // An expired grant is no grant.
  const expired = seed({});
  expired.rows("client_feature_grants").push({ client_id: OWN, feature: "view_3d", expires_at: "2026-01-01T00:00:00Z" });
  assertEquals((await call(expired, BODY, { env: ON, fetch: fakeModel({ stageA: [R] }).fetch })).body.code, "ai_door_no_3d");
});

Deno.test("the kill switch: unset, empty or anything but 1 / true is OFF, and refuses before anything is read", async () => {
  for (const v of [undefined, "", "0", "false", "yes", "on"]) {
    const db = seed({ internal_account: true });
    const m = fakeModel({ stageA: [R, R, R] });
    const env: Record<string, string> = { ANTHROPIC_API_KEY: "test-key", ...(v === undefined ? {} : { DOOR_LOOK_AI_ENABLED: v }) };
    const r = await call(db, BODY, { env, fetch: m.fetch });
    assertEquals([r.status, r.body.code, r.body.error], [403, "door_looks_ai_off", "Making door looks from photos is turned off right now."], String(v));
    untouched(db, m.sent.length);
    assertEquals(db.readsOf("client_settings").length, 0, "not even the flag is read");
  }
});

Deno.test("the tenant flag: off, no settings row, unreadable, or a database without 337 all refuse with nothing done", async () => {
  const off = seed({ internal_account: true, door_looks_beta: false });
  const none = new FakeDb({});
  const unread = seed({ internal_account: true });
  unread.failing.add("client_settings");
  const old = seed({ internal_account: true });
  old.missingColumns.add("client_settings.door_looks_beta");
  for (const [db, status, code] of [[off, 403, "door_looks_off"], [none, 403, "door_looks_off"], [unread, 503, "door_looks_flag_unread"], [old, 503, "door_looks_unavailable"]] as const) {
    const m = fakeModel({ stageA: [R, R, R] });
    const r = await call(db, BODY, { env: ON, fetch: m.fetch });
    assertEquals([r.status, r.body.code], [status, code]);
    untouched(db, m.sent.length);
  }
});
