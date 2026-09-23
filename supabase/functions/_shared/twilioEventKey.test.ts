// Unit tests for the twilio-events idempotency key.
//
// WHY THESE EXIST. The bare CloudEvents id is fixed per (campaign, event type), so once a
// rejected campaign was edited in place, every later verdict collided with the first and was
// discarded as a redelivery. These pin the two directions that matter: a NEW verdict on the
// same campaign gets a new key, and a true redelivery (same payload) still gets the same one.
//
// The payloads are shaped like the rows stored in sms_registration_events.detail: `timestamp`
// and `updateddate` arrive as JSON numbers (epoch ms).

import { campaignVerdictPredatesResubmit, eventOccurrenceKey, eventOccurrenceStamp } from "./twilioEventKey.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

// One campaign's failure event: one deterministic id, whatever the date. (Made-up ids; the
// repo is public, so no real campaign, event or account SID appears here.)
const FAILURE_ID = "aaaaaaaa-bbbb-33f2-cccc-dddddddddddd";

Deno.test("two verdicts on one in-place-edited campaign get different keys", () => {
  const first = eventOccurrenceKey(FAILURE_ID, { timestamp: 1788372071569, updateddate: 1788372070474 });
  const later = eventOccurrenceKey(FAILURE_ID, { timestamp: 1789381234567, updateddate: 1788372070474 });
  check("first", first === `${FAILURE_ID}@1788372071569`, String(first));
  check("later", later === `${FAILURE_ID}@1789381234567`, String(later));
  check("distinct", first !== later);
});

Deno.test("a redelivery of the same payload gets the same key", () => {
  const payload = { timestamp: 1790110564658, updateddate: 1788372070474, campaignregistrationstatus: "success" };
  const a = eventOccurrenceKey("aaaaaaaa-bbbb-33f0-cccc-dddddddddddd", payload);
  const b = eventOccurrenceKey("aaaaaaaa-bbbb-33f0-cccc-dddddddddddd", { ...payload });
  check("same", a === b && a !== null, `${a} vs ${b}`);
});

Deno.test("timestamp wins over updateddate, which an in-place edit leaves unchanged", () => {
  check("timestamp first", eventOccurrenceStamp({ timestamp: 2, updateddate: 1 }) === "2");
});

Deno.test("campaign-deleted carries no timestamp and falls back to updateddate", () => {
  const k = eventOccurrenceKey("eeeeeeee-ffff-c7f0-aaaa-bbbbbbbbbbbb", { updateddate: 1788368849875, createddate: 1788272065299 });
  check("deleted", k === "eeeeeeee-ffff-c7f0-aaaa-bbbbbbbbbbbb@1788368849875", String(k));
});

Deno.test("no stamp at all keeps the bare id (the pre-change key)", () => {
  // Twilio's connectivity test event: its id is the account SID and its data is only test_id.
  const k = eventOccurrenceKey("ACtest-connectivity-event-id", { test_id: "x" });
  check("bare", k === "ACtest-connectivity-event-id", String(k));
  check("null data", eventOccurrenceKey("abc", null) === "abc");
});

Deno.test("empty, blank and non-finite stamps are not stamps", () => {
  check("empty string", eventOccurrenceStamp({ timestamp: "", updateddate: 5 }) === "5");
  check("blank string", eventOccurrenceStamp({ timestamp: "   " }) === "");
  check("NaN", eventOccurrenceStamp({ timestamp: NaN }) === "");
  check("object", eventOccurrenceStamp({ timestamp: { a: 1 } }) === "");
  check("iso string kept", eventOccurrenceStamp({ timestamp: "2026-09-22T20:56:04.658Z" }) === "2026-09-22T20:56:04.658Z");
});

Deno.test("no id means no key, so the row is never deduplicated", () => {
  check("empty", eventOccurrenceKey("", { timestamp: 1 }) === null);
  check("undefined", eventOccurrenceKey(undefined, { timestamp: 1 }) === null);
  check("blank", eventOccurrenceKey("  ", { timestamp: 1 }) === null);
});

// A replayed verdict must not rewrite a newer state: the 09-02 failure (stamp 1788372071569)
// arriving again after the 09-19 resubmit would otherwise demote the 09-22 approval.
Deno.test("a verdict stamped before the last copy write is stale; one after it is not", () => {
  const resubmit = "2026-09-19T19:11:00.000Z";
  check("old failure is stale", campaignVerdictPredatesResubmit({ timestamp: 1788372071569 }, resubmit) === true);
  check("09-22 approval is current", campaignVerdictPredatesResubmit({ timestamp: 1790110564658 }, resubmit) === false);
  check("string stamp", campaignVerdictPredatesResubmit({ timestamp: "1788372071569" }, resubmit) === true);
});

Deno.test("a verdict within the clock margin of the copy write is never stale", () => {
  const copied = "2026-09-02T18:01:10.850Z";
  const at = Date.parse(copied);
  check("same second, slightly earlier by Twilio's clock", campaignVerdictPredatesResubmit({ timestamp: at - 2_000 }, copied) === false);
  check("just inside the margin", campaignVerdictPredatesResubmit({ timestamp: at - 59_000 }, copied) === false);
  check("well past the margin", campaignVerdictPredatesResubmit({ timestamp: at - 61_000 }, copied) === true);
});

Deno.test("without a timestamp or a copy time the verdict is never treated as stale", () => {
  check("no stamp", campaignVerdictPredatesResubmit({ updateddate: 1788372070474 }, "2026-09-19T19:11:00.000Z") === false);
  check("no copy time", campaignVerdictPredatesResubmit({ timestamp: 1788372071569 }, null) === false);
  check("bad copy time", campaignVerdictPredatesResubmit({ timestamp: 1788372071569 }, "not a date") === false);
  check("null payload", campaignVerdictPredatesResubmit(null, "2026-09-19T19:11:00.000Z") === false);
});
