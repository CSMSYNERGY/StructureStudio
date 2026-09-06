// Unit tests for postmark-events' pure pieces: mapEvent (provider payload → email_sends
// patch) and timingSafeEqual (the shared-secret compare that gates the webhook). The
// webhook cannot be exercised end-to-end without a live provider, so the mapping and the
// key check are pinned here.
//
// PROVIDER SWAPPED 2026-08-21 (Postmark → Resend, migration 113). These tests moved with
// the function: the payload is Resend's ({ type, created_at, data: { email_id } }), the
// legacy Postmark shape must now map to null, and the update must key on
// email_sends.provider_message_id — postmark_message_id is documented DEAD and matching it
// is what made this consumer a no-op.
//
// Run (from supabase/functions/):
//   deno test --quiet --allow-env --allow-read --node-modules-dir=none \
//     --import-map=_shared/_test_stubs/import_map.json \
//     _shared/_test_stubs/postmarkEvents_test.ts
//
// Why the import is DYNAMIC: index.ts ends in Deno.serve(...) at module top level — the
// standard edge-function shape. A static import would evaluate that line before any test
// code runs, and under the preflight gate (--allow-env, no net permission) it would throw
// at load. So Deno.serve is stubbed FIRST, the module is loaded with a string-literal
// `await import(...)` (literal, so it is part of the module graph and needs no
// --allow-read), and the real serve is restored after. The stub also proves exactly one
// handler was registered. Note this puts index.ts + _shared/logError.ts into this file's
// type-check graph, where the import map substitutes supabase_stub.ts for supabase-js —
// which is why the stub's createClient carries its type-only `from` member.

// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "jsr:@std/assert@1";

const realServe = Deno.serve;
let serveCalls = 0;
(Deno as any).serve = () => {
  serveCalls++;
  return { finished: Promise.resolve() };
};
const { mapEvent, timingSafeEqual } = await import("../../postmark-events/index.ts");
(Deno as any).serve = realServe;

Deno.test("module registered exactly one handler through Deno.serve", () => {
  assertEquals(serveCalls, 1);
});

// ── The ledger column the webhook keys on ─────────────────────────────────────
//
// The handler needs a database, so the one thing a unit test can still pin is WHICH column
// the update matches — and that is exactly what broke: the function filtered on
// postmark_message_id, a column 113 declares dead and null on every row, so every event
// matched zero rows and the ledger never left 'sent'. Read the source and assert the
// filter, since a passing mapEvent test says nothing about it.

Deno.test("the update matches provider_message_id, never the dead postmark column", async () => {
  const src = await Deno.readTextFile(new URL("../../postmark-events/index.ts", import.meta.url));
  assertEquals(src.includes('.eq("provider_message_id"'), true, "must filter on provider_message_id");
  assertEquals(src.includes('.eq("postmark_message_id"'), false, "must not filter on the dead column");
});

// ── mapEvent: the recorded events ─────────────────────────────────────────────

Deno.test("email.delivered → status delivered + delivered_at from the event", () => {
  const r = mapEvent({
    type: "email.delivered",
    created_at: "2026-08-22T12:00:00.000Z",
    data: { email_id: "rs-1", created_at: "2026-08-22T11:59:00.000Z" },
  });
  assertEquals(r, {
    messageId: "rs-1",
    patch: { status: "delivered", delivered_at: "2026-08-22T12:00:00.000Z" },
  });
});

Deno.test("delivered_at is the EVENT time, not the email's created_at", () => {
  const r = mapEvent({
    type: "email.delivered",
    created_at: "2026-08-22T12:00:00.000Z",
    data: { email_id: "rs-2", created_at: "2026-08-22T09:00:00.000Z" },
  });
  assertEquals(r?.patch.delivered_at, "2026-08-22T12:00:00.000Z");
});

Deno.test("email.delivered without created_at still stamps a timestamp", () => {
  const r = mapEvent({ type: "email.delivered", data: { email_id: "rs-3" } });
  assertEquals(r?.patch.status, "delivered");
  assertEquals(typeof r?.patch.delivered_at, "string");
});

Deno.test("email.bounced → bounced + bounced_at + 'Type/SubType: message' reason", () => {
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
    patch: {
      status: "bounced",
      bounced_at: "2026-08-22T12:34:56.000Z",
      bounce_reason: "Permanent/General: The recipient's address does not exist",
    },
  });
});

Deno.test("email.bounced without a bounce object still records a bounce", () => {
  const r = mapEvent({ type: "email.bounced", created_at: "2026-08-22T13:00:00.000Z", data: { email_id: "rs-5" } });
  assertEquals(r?.patch.status, "bounced");
  assertEquals(r?.patch.bounce_reason, "Bounce");
});

Deno.test("bounce reason is capped at 300 chars", () => {
  const r = mapEvent({
    type: "email.bounced",
    created_at: "2026-08-22T00:00:00.000Z",
    data: { email_id: "rs-6", bounce: { type: "Transient", message: "x".repeat(500) } },
  });
  const reason = String(r?.patch.bounce_reason ?? "");
  assertEquals(reason.length, 300);
  assertEquals(reason.startsWith("Transient: xxx"), true);
});

Deno.test("email.complained → bounced, authored reason, no bounced_at", () => {
  const r = mapEvent({ type: "email.complained", created_at: "2026-08-22T14:00:00.000Z", data: { email_id: "rs-7" } });
  assertEquals(r, {
    messageId: "rs-7",
    patch: { status: "bounced", bounce_reason: "Complaint: recipient reported this as spam" },
  });
});

Deno.test("every patch stays inside the email_sends status CHECK", () => {
  const allowed = ["claimed", "sent", "failed", "delivered", "bounced"];
  for (const type of ["email.delivered", "email.bounced", "email.complained"]) {
    const r = mapEvent({ type, created_at: "2026-08-22T15:00:00.000Z", data: { email_id: "rs-8" } });
    assertEquals(allowed.includes(String(r?.patch.status)), true, `${type} wrote an out-of-vocabulary status`);
  }
});

// ── mapEvent: everything we deliberately do not record ────────────────────────

Deno.test("delivery_delayed is ignored — it is not terminal", () => {
  assertEquals(mapEvent({ type: "email.delivery_delayed", data: { email_id: "rs-9" } }), null);
});

Deno.test("anything else → null (answer 200, record nothing)", () => {
  assertEquals(mapEvent({ type: "email.sent", data: { email_id: "rs-10" } }), null);
  assertEquals(mapEvent({ type: "email.opened", data: { email_id: "rs-11" } }), null);
  assertEquals(mapEvent({ type: "email.clicked", data: { email_id: "rs-12" } }), null);
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
  assertEquals(mapEvent({ type: "email.delivered", data: {} }), null);
  assertEquals(mapEvent({ type: "email.bounced", data: { email_id: "" } }), null);
  assertEquals(mapEvent({ type: "email.complained", data: { email_id: 42 } }), null);
});

// ── timingSafeEqual ───────────────────────────────────────────────────────────

Deno.test("timingSafeEqual accepts only the exact key", () => {
  assertEquals(timingSafeEqual("hunter2", "hunter2"), true);
  assertEquals(timingSafeEqual("hunter2", "hunter3"), false); // same length, wrong value
  assertEquals(timingSafeEqual("hunter2", "hunter"), false); // different length
  assertEquals(timingSafeEqual("", "hunter2"), false); // empty ?key= vs a real secret
});
