// Unit tests for postmark-events' pure pieces: mapEvent (Postmark payload → email_sends
// patch) and timingSafeEqual (the shared-secret compare that gates the webhook). The
// webhook cannot be exercised end-to-end without a live Postmark server, so the mapping
// and the key check are pinned here.
//
// Run (from supabase/functions/):
//   deno test --quiet --allow-env --node-modules-dir=none \
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

// ── mapEvent: the four spec'd cases ───────────────────────────────────────────

Deno.test("Delivery → status delivered + delivered_at from the event", () => {
  const r = mapEvent({ RecordType: "Delivery", MessageID: "pm-1", DeliveredAt: "2026-08-10T12:00:00Z" });
  assertEquals(r, {
    messageId: "pm-1",
    patch: { status: "delivered", delivered_at: "2026-08-10T12:00:00Z" },
  });
});

Deno.test("Delivery without DeliveredAt still stamps a timestamp", () => {
  const r = mapEvent({ RecordType: "Delivery", MessageID: "pm-2" });
  assertEquals(r?.patch.status, "delivered");
  assertEquals(typeof r?.patch.delivered_at, "string");
});

Deno.test("Bounce → status bounced + bounced_at + 'Type: Description' reason", () => {
  const r = mapEvent({
    RecordType: "Bounce",
    MessageID: "pm-3",
    BouncedAt: "2026-08-10T12:34:56Z",
    Type: "HardBounce",
    Description: "The server was unable to deliver your message",
  });
  assertEquals(r, {
    messageId: "pm-3",
    patch: {
      status: "bounced",
      bounced_at: "2026-08-10T12:34:56Z",
      bounce_reason: "HardBounce: The server was unable to deliver your message",
    },
  });
});

Deno.test("Bounce reason is capped at 300 chars", () => {
  const r = mapEvent({
    RecordType: "Bounce",
    MessageID: "pm-4",
    BouncedAt: "2026-08-10T00:00:00Z",
    Type: "Transient",
    Description: "x".repeat(500),
  });
  const reason = String(r?.patch.bounce_reason ?? "");
  assertEquals(reason.length, 300);
  assertEquals(reason.startsWith("Transient: xxx"), true);
});

Deno.test("SpamComplaint → status bounced, fixed reason, no bounced_at", () => {
  const r = mapEvent({ RecordType: "SpamComplaint", MessageID: "pm-5" });
  assertEquals(r, { messageId: "pm-5", patch: { status: "bounced", bounce_reason: "SpamComplaint" } });
});

Deno.test("anything else → null (answer 200, record nothing)", () => {
  assertEquals(mapEvent({ RecordType: "Open", MessageID: "pm-6" }), null);
  assertEquals(mapEvent({ RecordType: "Click", MessageID: "pm-7" }), null);
  assertEquals(mapEvent({ RecordType: "SubscriptionChange", MessageID: "pm-8" }), null);
  assertEquals(mapEvent({}), null);
  assertEquals(mapEvent(null), null);
  assertEquals(mapEvent("Delivery"), null);
});

Deno.test("missing MessageID → null even for a known RecordType", () => {
  assertEquals(mapEvent({ RecordType: "Delivery", DeliveredAt: "2026-08-10T12:00:00Z" }), null);
  assertEquals(mapEvent({ RecordType: "Bounce", MessageID: "" }), null);
  assertEquals(mapEvent({ RecordType: "SpamComplaint", MessageID: 42 }), null);
});

// ── timingSafeEqual ───────────────────────────────────────────────────────────

Deno.test("timingSafeEqual accepts only the exact key", () => {
  assertEquals(timingSafeEqual("hunter2", "hunter2"), true);
  assertEquals(timingSafeEqual("hunter2", "hunter3"), false); // same length, wrong value
  assertEquals(timingSafeEqual("hunter2", "hunter"), false); // different length
  assertEquals(timingSafeEqual("", "hunter2"), false); // empty ?key= vs a real secret
});
