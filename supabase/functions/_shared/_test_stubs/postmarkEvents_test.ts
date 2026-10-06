// Unit tests for postmark-events: mapEvent (provider payload → the event record_email_event
// applies), eventKey (the idempotency key), timingSafeEqual (the shared-secret compare that
// gates the webhook), and the handler itself driven end to end against a fake database call —
// the key gate, a duplicate, an unknown email id, a bounce, an open, and a database error that
// must not echo the payload.
//
// PROVIDER SWAPPED 2026-08-21 (Postmark → Resend, migration 113). These tests moved with
// the function: the payload is Resend's ({ type, created_at, data: { email_id } }), and the
// legacy Postmark shape must map to null.
//
// OPENS (B4, migration 262, 2026-10-04): email.opened is recorded now, and the write is ONE call
// to record_email_event, which matches provider_message_id, keeps the earliest time, counts an
// open once per event id and lets no late delivery undo a bounce. That function's own behaviour is
// pinned in tests/sql/migration262.test.cjs (PGlite); this file pins what the handler hands it.
//
// Run (from supabase/functions/):
//   deno test --quiet --allow-env --allow-read --node-modules-dir=none \
//     --import-map=_shared/_test_stubs/import_map.json \
//     _shared/_test_stubs/postmarkEvents_test.ts
//
// Why the import is DYNAMIC: index.ts ends in Deno.serve(...) at module top level — the
// standard edge-function shape. A static import would evaluate that line before any test
// code runs, and under the preflight gate (--allow-env, no net permission) it would throw
// at load. So Deno.serve is stubbed FIRST (keeping the handler it is given, so the tests can
// drive it), the module is loaded with a string-literal `await import(...)` (literal, so it is
// part of the module graph and needs no --allow-read), and the real serve is restored after.
// The stub also proves exactly one handler was registered. Note this puts index.ts +
// _shared/logError.ts into this file's type-check graph, where the import map substitutes
// supabase_stub.ts for supabase-js — which is why the stub's createClient carries `from`/`rpc`.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubDb, stubRpc } from "./supabase_stub.ts";

const realServe = Deno.serve;
let serveCalls = 0;
let served: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  serveCalls++;
  served = h;
  return { finished: Promise.resolve() };
};
const { mapEvent, eventKey, timingSafeEqual } = await import("../../postmark-events/index.ts");
(Deno as any).serve = realServe;

Deno.test("module registered exactly one handler through Deno.serve", () => {
  assertEquals(serveCalls, 1);
});

// ── mapEvent: the recorded events ─────────────────────────────────────────────

Deno.test("email.delivered → delivered, at the event time", () => {
  const r = mapEvent({
    type: "email.delivered",
    created_at: "2026-08-22T12:00:00.000Z",
    data: { email_id: "rs-1", created_at: "2026-08-22T11:59:00.000Z" },
  });
  assertEquals(r, { messageId: "rs-1", event: "delivered", at: "2026-08-22T12:00:00.000Z", reason: null });
});

Deno.test("the time is the EVENT's, not the email's created_at", () => {
  const r = mapEvent({
    type: "email.opened",
    created_at: "2026-08-22T12:00:00.000Z",
    data: { email_id: "rs-2", created_at: "2026-08-22T09:00:00.000Z" },
  });
  assertEquals(r?.at, "2026-08-22T12:00:00.000Z");
});

Deno.test("no created_at, or one that is not a time, still gives a time (now), never the raw string", () => {
  for (const created_at of [undefined, "", "yesterday-ish", 42]) {
    const r = mapEvent({ type: "email.delivered", created_at, data: { email_id: "rs-3" } });
    assertEquals(r?.event, "delivered");
    assert(Number.isFinite(Date.parse(String(r?.at))), `a usable time for ${JSON.stringify(created_at)}: ${r?.at}`);
    assert(Math.abs(Date.parse(String(r?.at)) - Date.now()) < 60_000, "now");
  }
});

Deno.test("email.opened → opened (B4: read tracking)", () => {
  const r = mapEvent({ type: "email.opened", created_at: "2026-10-04T14:00:00.000Z", data: { email_id: "rs-o" } });
  assertEquals(r, { messageId: "rs-o", event: "opened", at: "2026-10-04T14:00:00.000Z", reason: null });
});

Deno.test("email.bounced → bounced with a 'Type/SubType: message' reason", () => {
  const r = mapEvent({
    type: "email.bounced",
    created_at: "2026-08-22T12:34:56.000Z",
    data: {
      email_id: "rs-4",
      bounce: { type: "Permanent", subType: "General", message: "The recipient's address does not exist" },
    },
  });
  assertEquals(r, {
    messageId: "rs-4",
    event: "bounced",
    at: "2026-08-22T12:34:56.000Z",
    reason: "Permanent/General: The recipient's address does not exist",
  });
});

Deno.test("email.bounced without a bounce object still records a bounce", () => {
  const r = mapEvent({ type: "email.bounced", created_at: "2026-08-22T13:00:00.000Z", data: { email_id: "rs-5" } });
  assertEquals(r?.event, "bounced");
  assertEquals(r?.reason, "Bounce");
});

Deno.test("bounce reason is capped at 300 chars", () => {
  const r = mapEvent({
    type: "email.bounced",
    created_at: "2026-08-22T00:00:00.000Z",
    data: { email_id: "rs-6", bounce: { type: "Transient", message: "x".repeat(500) } },
  });
  const reason = String(r?.reason ?? "");
  assertEquals(reason.length, 300);
  assertEquals(reason.startsWith("Transient: xxx"), true);
});

Deno.test("email.complained → complained (record_email_event keeps it in complained_at, not as a bounce)", () => {
  const r = mapEvent({ type: "email.complained", created_at: "2026-08-22T14:00:00.000Z", data: { email_id: "rs-7" } });
  assertEquals(r, { messageId: "rs-7", event: "complained", at: "2026-08-22T14:00:00.000Z", reason: null });
});

Deno.test("email.suppressed → bounced, with a reason that says it never left and why", () => {
  // Resend accepts the send (so the row reads 'sent'), then skips it: the address is on the
  // account-wide suppression list after an earlier bounce or complaint, possibly another builder's.
  const r = mapEvent({
    type: "email.suppressed",
    created_at: "2026-10-04T17:00:00.000Z",
    data: {
      email_id: "rs-s1",
      suppressed: { message: "Resend has suppressed sending to this address because it is on the account-level suppression list.", type: "OnAccountSuppressionList" },
    },
  });
  assertEquals(r, {
    messageId: "rs-s1",
    event: "bounced",
    at: "2026-10-04T17:00:00.000Z",
    reason: "Not sent: an earlier email to this address bounced or was marked as spam (OnAccountSuppressionList)",
  });
  const bare = mapEvent({ type: "email.suppressed", created_at: "2026-10-04T17:00:00.000Z", data: { email_id: "rs-s2" } });
  assertEquals(bare?.reason, "Not sent: an earlier email to this address bounced or was marked as spam");
});

Deno.test("email.failed → failed (not a bounce: the address is not the problem), with Resend's reason", () => {
  const r = mapEvent({ type: "email.failed", created_at: "2026-10-04T17:30:00.000Z", data: { email_id: "rs-f1", failed: { reason: "reached_daily_quota" } } });
  assertEquals(r, { messageId: "rs-f1", event: "failed", at: "2026-10-04T17:30:00.000Z", reason: "Not sent: reached_daily_quota" });
  assertEquals(mapEvent({ type: "email.failed", data: { email_id: "rs-f2" } })?.reason, "Not sent");
  const long = mapEvent({ type: "email.failed", data: { email_id: "rs-f3", failed: { reason: "x".repeat(500) } } });
  assertEquals(String(long?.reason).length, 300, "capped like a bounce reason");
});

Deno.test("every event is one migration 262's email_send_events CHECK accepts", async () => {
  const sql = await Deno.readTextFile(new URL("../../../migrations/262_email_opens.sql", import.meta.url));
  assert(sql.includes("check (event in ('delivered', 'opened', 'bounced', 'complained', 'failed'))"), "262's CHECK moved — re-point this test");
  for (const type of ["email.delivered", "email.opened", "email.bounced", "email.complained", "email.suppressed", "email.failed"]) {
    const r = mapEvent({ type, created_at: "2026-08-22T15:00:00.000Z", data: { email_id: "rs-8" } });
    assert(["delivered", "opened", "bounced", "complained", "failed"].includes(String(r?.event)), `${type} mapped to ${r?.event}`);
  }
});

// ── mapEvent: everything we deliberately do not record ────────────────────────

Deno.test("delivery_delayed is ignored — it is not terminal", () => {
  assertEquals(mapEvent({ type: "email.delivery_delayed", data: { email_id: "rs-9" } }), null);
});

Deno.test("anything else → null (answer 200, record nothing)", () => {
  assertEquals(mapEvent({ type: "email.sent", data: { email_id: "rs-10" } }), null);
  assertEquals(mapEvent({ type: "email.clicked", data: { email_id: "rs-12" } }), null);
  assertEquals(mapEvent({ type: "email.received", data: { email_id: "rs-13" } }), null);
  assertEquals(mapEvent({}), null);
  assertEquals(mapEvent(null), null);
  assertEquals(mapEvent("email.delivered"), null);
});

Deno.test("the legacy Postmark payload records nothing", () => {
  // No Postmark webhook can post here (the account was declined) and its ids were never
  // stored, so a parsed Postmark event could only ever write a patch that matches no row.
  assertEquals(mapEvent({ RecordType: "Delivery", MessageID: "pm-1", DeliveredAt: "2026-08-10T12:00:00Z" }), null);
  assertEquals(mapEvent({ RecordType: "Bounce", MessageID: "pm-2", Type: "HardBounce" }), null);
  assertEquals(mapEvent({ RecordType: "SpamComplaint", MessageID: "pm-3" }), null);
});

Deno.test("missing email_id → null even for a recorded event type", () => {
  assertEquals(mapEvent({ type: "email.delivered", created_at: "2026-08-22T12:00:00.000Z" }), null);
  assertEquals(mapEvent({ type: "email.opened", data: {} }), null);
  assertEquals(mapEvent({ type: "email.bounced", data: { email_id: "" } }), null);
  assertEquals(mapEvent({ type: "email.complained", data: { email_id: 42 } }), null);
});

// ── eventKey: the idempotency key ─────────────────────────────────────────────

Deno.test("eventKey: Resend's svix-id first; a key built from the event when there is none; null with neither", () => {
  const body = { type: "email.opened", created_at: "2026-10-04T14:00:00.000Z", data: { email_id: "rs-o" } };
  const m = mapEvent(body)!;
  assertEquals(eventKey("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W", body, m), "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W");
  assertEquals(eventKey(null, body, m), "derived:opened:rs-o:2026-10-04T14:00:00.000Z");
  assertEquals(eventKey(null, body, m), eventKey("", body, m), "a retry of the same post builds the same key");
  assertEquals(eventKey("not a key; drop table", body, m), "derived:opened:rs-o:2026-10-04T14:00:00.000Z",
    "a header outside the svix-id shape is not trusted as a key");
  assertEquals(eventKey(null, { ...body, created_at: undefined }, m), null);
  assert(String(eventKey(null, { ...body, created_at: "x".repeat(400) }, m)).length <= 200, "fits email_send_events' 200");
});

// ── timingSafeEqual ───────────────────────────────────────────────────────────

Deno.test("timingSafeEqual accepts only the exact key", () => {
  assertEquals(timingSafeEqual("hunter2", "hunter2"), true);
  assertEquals(timingSafeEqual("hunter2", "hunter3"), false); // same length, wrong value
  assertEquals(timingSafeEqual("hunter2", "hunter"), false); // different length
  assertEquals(timingSafeEqual("", "hunter2"), false); // empty ?key= vs a real secret
});

// ── The handler, end to end against a fake record_email_event ─────────────────

const SECRET = "test-events-secret-123";
const URL_OK = `https://project.supabase.co/functions/v1/postmark-events?key=${SECRET}`;
const OPEN = { type: "email.opened", created_at: "2026-10-04T14:00:00.000Z", data: { email_id: "rs-live-1", to: ["cam@example.test"] } };

type Rpc = { fn: string; args: any };
async function drive(
  opts: { url?: string; body?: unknown; headers?: Record<string, string>; secret?: string | null; answer?: { data: unknown; error: unknown } },
): Promise<{ res: Response; json: any; rpcs: Rpc[]; logged: any[] }> {
  const rpcs: Rpc[] = [];
  const logged: any[] = [];
  Deno.env.delete("POSTMARK_WEBHOOK_SECRET");
  if (opts.secret === null) Deno.env.delete("EMAIL_EVENTS_SECRET");
  else Deno.env.set("EMAIL_EVENTS_SECRET", opts.secret ?? SECRET);
  Deno.env.set("SUPABASE_URL", "https://project.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  stubRpc.rpc = (fn: string, args: any) => {
    rpcs.push({ fn, args });
    return Promise.resolve(opts.answer ?? { data: "recorded", error: null });
  };
  stubDb.from = (table: string) => ({
    insert: (row: any) => { if (table === "app_errors") logged.push(row); return Promise.resolve({ error: null }); },
  });
  try {
    const res = await served!(new Request(opts.url ?? URL_OK, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? OPEN),
    }));
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { res, json, rpcs, logged };
  } finally {
    stubRpc.rpc = null;
    stubDb.from = null;
    Deno.env.delete("EMAIL_EVENTS_SECRET");
  }
}

Deno.test("handler: no secret configured refuses everything — the inert state is closed, not open", async () => {
  const { res, rpcs } = await drive({ secret: null });
  assertEquals(res.status, 401);
  assertEquals(rpcs.length, 0);
});

Deno.test("handler: a wrong or missing ?key= is a 401 and nothing is written", async () => {
  for (const url of [URL_OK.replace(SECRET, "wrong-key-of-same-len"), URL_OK.split("?")[0]]) {
    const { res, rpcs } = await drive({ url });
    assertEquals(res.status, 401, url);
    assertEquals(rpcs.length, 0);
  }
});

Deno.test("handler: an open is handed to record_email_event with the svix-id as its key", async () => {
  const { res, json, rpcs } = await drive({ headers: { "svix-id": "msg_abc123" } });
  assertEquals(res.status, 200);
  assertEquals(json, { ok: true, updated: 1 });
  assertEquals(rpcs, [{
    fn: "record_email_event",
    args: { p_provider_message_id: "rs-live-1", p_event: "opened", p_at: "2026-10-04T14:00:00.000Z", p_reason: null, p_event_id: "msg_abc123" },
  }]);
});

Deno.test("handler: a replay the database has seen is a 200 duplicate, so Resend stops retrying", async () => {
  const { res, json } = await drive({ headers: { "svix-id": "msg_abc123" }, answer: { data: "duplicate", error: null } });
  assertEquals(res.status, 200);
  assertEquals(json, { ok: true, duplicate: true, updated: 0 });
});

Deno.test("handler: an email id nobody sent is a 200 with nothing updated", async () => {
  const { res, json } = await drive({ answer: { data: "unknown", error: null } });
  assertEquals(res.status, 200);
  assertEquals(json, { ok: true, updated: 0 });
});

Deno.test("handler: an open past the 25 cap is a 200 with nothing updated, so Resend stops retrying", async () => {
  // Anyone holding the email can fetch its tracking image in a loop; 262 stops counting at 25 and
  // answers 'capped'. A 5xx here would make Resend retry every one of those for a day.
  const { res, json } = await drive({ headers: { "svix-id": "msg_cap_26" }, answer: { data: "capped", error: null } });
  assertEquals(res.status, 200);
  assertEquals(json, { ok: true, updated: 0 });
});

Deno.test("handler: a bounce carries its reason; a type we don't record writes nothing", async () => {
  const bounce = {
    type: "email.bounced", created_at: "2026-10-04T16:00:00.000Z",
    data: { email_id: "rs-live-2", bounce: { type: "Permanent", subType: "Suppressed", message: "On the suppression list" } },
  };
  const b = await drive({ body: bounce, headers: { "svix-id": "msg_b1" } });
  assertEquals(b.res.status, 200);
  assertEquals(b.rpcs[0].args.p_event, "bounced");
  assertEquals(b.rpcs[0].args.p_reason, "Permanent/Suppressed: On the suppression list");
  const clicked = await drive({ body: { type: "email.clicked", data: { email_id: "rs-live-2" } } });
  assertEquals(clicked.res.status, 200);
  assertEquals(clicked.json.ignored, "unhandled record type");
  assertEquals(clicked.rpcs.length, 0);
});

Deno.test("handler: a suppressed send reaches the database as a bounce, a failed one as failed", async () => {
  // Both were accepted by the API and stored as 'sent'; without these they read Sent for good.
  const sup = await drive({
    body: { type: "email.suppressed", created_at: "2026-10-04T17:00:00.000Z", data: { email_id: "rs-live-3", suppressed: { type: "OnAccountSuppressionList" } } },
    headers: { "svix-id": "msg_s1" },
  });
  assertEquals(sup.res.status, 200);
  assertEquals([sup.rpcs[0].args.p_event, sup.rpcs[0].args.p_event_id], ["bounced", "msg_s1"]);
  assert(String(sup.rpcs[0].args.p_reason).startsWith("Not sent: an earlier email to this address bounced"), sup.rpcs[0].args.p_reason);
  const failed = await drive({
    body: { type: "email.failed", created_at: "2026-10-04T17:30:00.000Z", data: { email_id: "rs-live-4", failed: { reason: "reached_daily_quota" } } },
    headers: { "svix-id": "msg_f1" },
  });
  assertEquals(failed.res.status, 200);
  assertEquals(failed.rpcs[0].args, {
    p_provider_message_id: "rs-live-4", p_event: "failed", p_at: "2026-10-04T17:30:00.000Z", p_reason: "Not sent: reached_daily_quota", p_event_id: "msg_f1",
  });
});

Deno.test("handler: unreadable JSON is a 400 and nothing is written", async () => {
  const { res, rpcs } = await drive({ body: "{not json" });
  assertEquals(res.status, 400);
  assertEquals(rpcs.length, 0);
});

Deno.test("handler: a database error is a 500 (Resend retries it) and echoes nothing from the payload", async () => {
  const { res, json, logged } = await drive({
    answer: { data: null, error: { code: "PGRST202", message: "Could not find the function public.record_email_event" } },
  });
  assertEquals(res.status, 500);
  assertEquals(json, { ok: false, error: "update failed" });
  const row = logged.find((r) => r.code === "email_event_record_failed");
  assert(row, `the failure is filed: ${JSON.stringify(logged)}`);
  assertEquals(row.context, { event: "opened", pgCode: "PGRST202" });
  assert(!JSON.stringify(logged).includes("cam@example.test"), "no address from the payload reaches app_errors");
  assert(!JSON.stringify(json).includes("rs-live-1"), "the response says nothing about the payload");
});
