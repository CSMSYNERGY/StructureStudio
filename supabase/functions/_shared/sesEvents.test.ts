/**
 * Unit tests for sesEvents.ts: Amazon SES delivery events as the ledger records them.
 *
 * WHY THESE EXIST. The mapping decides what a builder is told happened to their email, and it is
 * wrong silently: a suppressed send shown as "Sent", a complaint counted as a bounce, a bounce
 * reason that prints the customer's address. The shapes below are SES's own (the Delivery event
 * was read off a live one, 2026-11-10). No network: the SNS check is injected.
 *
 * Dependency-free (no jsr:/npm: imports), the rule every _shared test follows.
 * Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/sesEvents.test.ts
 */

import { mapSesEvent, readSesEvent, type SesEventDeps, type SesEventResult } from "./sesEvents.ts";
import type { SnsMessage, SnsVerdict } from "./snsVerify.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const ID = "010f01a1c6b229be-542a255c-410e-405a-8597-40c0c2f29108-000000";
const ROW = "3f2a9c1e-0b7d-4e55-9a31-6c1d2e3f4a5b";
const TOPIC = "arn:aws:sns:us-east-2:123456789012:example-events";

function mail(tags: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-11-10T18:22:07.294Z",
    source: "info@example.com",
    sendingAccountId: "123456789012",
    messageId: ID,
    destination: ["jane@example.org"],
    headersTruncated: false,
    headers: [],
    commonHeaders: {},
    tags: {
      "ses:configuration-set": ["ss-default"], "ses:from-domain": ["example.com"], "ses:operation": ["SendEmail"],
      client_id: ["example-sheds"], kind: ["estimate"], ss_send: [ROW], ...tags,
    },
  };
}

// ── mapSesEvent ──────────────────────────────────────────────────────────────────────────────

Deno.test("Delivery maps to delivered, at the delivery's own time, with the row id and builder from the tags", () => {
  const e = mapSesEvent({
    eventType: "Delivery", mail: mail(),
    delivery: { timestamp: "2026-11-10T18:22:08.100Z", processingTimeMillis: 806, recipients: ["jane@example.org"], smtpResponse: "250 2.0.0 OK", reportingMTA: "e226-1.smtp-out.us-east-2.amazonses.com" },
  });
  assertEquals(e, { messageId: ID, sendId: ROW, clientId: "example-sheds", event: "delivered", at: "2026-11-10T18:22:08.100Z", reason: null });
});

Deno.test("a hard bounce carries type, subtype and the server's reason with the address MASKED", () => {
  const e = mapSesEvent({
    eventType: "Bounce", mail: mail(),
    bounce: {
      feedbackId: "f-1", bounceType: "Permanent", bounceSubType: "General", timestamp: "2026-11-10T18:30:00.000Z",
      bouncedRecipients: [{ emailAddress: "jane@example.org", action: "failed", status: "5.1.1", diagnosticCode: "smtp; 550 5.1.1 <jane@example.org>: Recipient address rejected: User unknown" }],
    },
  });
  assertEquals([e?.event, e?.at], ["bounced", "2026-11-10T18:30:00.000Z"]);
  assertEquals(e?.reason, "Permanent/General: smtp; 550 5.1.1 <[address]>: Recipient address rejected: User unknown");
  assert(!JSON.stringify(e).includes("jane@"), "the customer's address is nowhere in what gets stored");
});

Deno.test("a transient bounce is still an email that did not arrive, and says it was transient", () => {
  const e = mapSesEvent({ eventType: "Bounce", mail: mail(), bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", timestamp: "2026-11-10T18:30:00Z", bouncedRecipients: [] } });
  assertEquals([e?.event, e?.reason], ["bounced", "Transient/MailboxFull"]);
});

Deno.test("a send to a suppressed address reads as Resend's suppressed did: accepted, never sent", () => {
  for (const sub of ["OnAccountSuppressionList", "OnTenantSuppressionList", "Suppressed"]) {
    const e = mapSesEvent({ eventType: "Bounce", mail: mail(), bounce: { bounceType: "Permanent", bounceSubType: sub, timestamp: "2026-11-10T18:30:00Z", bouncedRecipients: [{ emailAddress: "jane@example.org" }] } });
    assertEquals([e?.event, e?.reason], ["bounced", `Not sent: an earlier email to this address bounced or was marked as spam (${sub})`], sub);
  }
});

Deno.test("a complaint is NOT a bounce: the email arrived. A 'complaint' that is really the suppression list is one", () => {
  const real = mapSesEvent({ eventType: "Complaint", mail: mail(), complaint: { complainedRecipients: [{ emailAddress: "jane@example.org" }], timestamp: "2026-11-11T09:00:00Z", feedbackId: "f-2", complaintFeedbackType: "abuse" } });
  assertEquals([real?.event, real?.reason, real?.at], ["complained", null, "2026-11-11T09:00:00.000Z"]);
  const listed = mapSesEvent({ eventType: "Complaint", mail: mail(), complaint: { complaintSubType: "OnAccountSuppressionList", timestamp: "2026-11-11T09:00:00Z" } });
  assertEquals([listed?.event, listed?.reason], ["bounced", "Not sent: an earlier email to this address bounced or was marked as spam (OnAccountSuppressionList)"]);
});

Deno.test("Reject is failed, not bounced; Open is mapped for the day opens are switched on", () => {
  const rej = mapSesEvent({ eventType: "Reject", mail: mail(), reject: { reason: "Bad content" } });
  assertEquals([rej?.event, rej?.reason, rej?.at], ["failed", "Not sent: Bad content", "2026-11-10T18:22:07.294Z"]);
  const open = mapSesEvent({ eventType: "Open", mail: mail(), open: { timestamp: "2026-11-10T19:00:00Z", userAgent: "x", ipAddress: "192.0.2.1" } });
  assertEquals([open?.event, open?.at], ["opened", "2026-11-10T19:00:00.000Z"]);
});

Deno.test("events we do not record, and an event with no message id, map to null", () => {
  for (const t of ["Send", "DeliveryDelay", "Click", "Rendering Failure", "Subscription", "SomethingNew", ""]) {
    assertEquals(mapSesEvent({ eventType: t, mail: mail() }), null, t || "(no type)");
  }
  assertEquals(mapSesEvent({ eventType: "Delivery", mail: { ...mail(), messageId: "" }, delivery: {} }), null);
  assertEquals(mapSesEvent(null), null);
  assertEquals(mapSesEvent("Delivery"), null);
});

Deno.test("an identity-level notification (notificationType) maps the same", () => {
  const e = mapSesEvent({ notificationType: "Delivery", mail: mail(), delivery: { timestamp: "2026-11-10T18:22:08.100Z" } });
  assertEquals(e?.event, "delivered");
});

Deno.test("the tags are only believed in the shape we wrote them; an unreadable time becomes now, never a failed call", () => {
  const noTags = mapSesEvent({ eventType: "Delivery", mail: { ...mail(), tags: undefined }, delivery: { timestamp: "2026-11-10T18:22:08.100Z" } });
  assertEquals([noTags?.sendId, noTags?.clientId], [null, null], "an email sent before the tag existed");
  const junk = mapSesEvent({ eventType: "Delivery", mail: mail({ ss_send: ["not-a-uuid"], client_id: ["Bad Slug!"] }), delivery: { timestamp: "nonsense" } });
  assertEquals([junk?.sendId, junk?.clientId], [null, null]);
  assert(Math.abs(Date.parse(String(junk?.at)) - Date.now()) < 5000, "falls back to now");
  const upper = mapSesEvent({ eventType: "Delivery", mail: mail({ ss_send: [ROW.toUpperCase()] }), delivery: {} });
  assertEquals(upper?.sendId, ROW, "a uuid is compared lower-cased");
});

Deno.test("a reason is capped at 300 characters", () => {
  const e = mapSesEvent({ eventType: "Bounce", mail: mail(), bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ diagnosticCode: "x".repeat(900) }] } });
  assertEquals(e?.reason?.length, 300);
});

// ── readSesEvent ─────────────────────────────────────────────────────────────────────────────

function sns(type: SnsMessage["Type"], message: string): SnsMessage {
  return {
    Type: type, MessageId: "8a1b2c3d-sns", TopicArn: TOPIC, Message: message, Timestamp: "2026-11-10T18:22:09.000Z",
    SignatureVersion: "2", Signature: "sig", SigningCertURL: "https://sns.us-east-2.amazonaws.com/cert.pem",
    ...(type === "Notification" ? {} : { Token: "tok", SubscribeURL: "https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription" }),
  };
}
function deps(over: Partial<SesEventDeps> & { message?: SnsMessage; verdict?: SnsVerdict } = {}): { d: Partial<SesEventDeps>; confirmed: () => number } {
  let confirmed = 0;
  return {
    confirmed: () => confirmed,
    d: {
      topics: () => [TOPIC],
      verify: () => Promise.resolve(over.verdict ?? { ok: true, message: over.message ?? sns("Notification", JSON.stringify({ eventType: "Delivery", mail: mail(), delivery: { timestamp: "2026-11-10T18:22:08.100Z" } })) }),
      confirm: () => { confirmed++; return Promise.resolve(true); },
      ...over,
    },
  };
}
const answerOf = (r: SesEventResult) => { if (r.kind !== "answer") throw new Error("expected an answer"); return r; };

Deno.test("a verified event comes back mapped, keyed by the SNS MessageId so a redelivery is a duplicate", async () => {
  const r = await readSesEvent("{}", deps().d);
  assert(r.kind === "event", "an event");
  if (r.kind === "event") {
    assertEquals(r.eventId, "sns:8a1b2c3d-sns");
    assertEquals([r.event.event, r.event.messageId, r.event.sendId], ["delivered", ID, ROW]);
  }
});

Deno.test("refusals: 403 for anything unproven, 503 only where a second delivery could succeed", async () => {
  assertEquals(answerOf(await readSesEvent("{}", deps({ topics: () => [] }).d)).status, 503, "not set up yet");
  for (const reason of ["bad_signature", "wrong_topic", "stale", "bad_shape"] as const) {
    const a = answerOf(await readSesEvent("{}", deps({ verdict: { ok: false, reason } }).d));
    assertEquals([a.status, a.log?.severity], [403, "warn"], reason);
  }
  assertEquals(answerOf(await readSesEvent("{}", deps({ verdict: { ok: false, reason: "cert_fetch_failed" } }).d)).status, 503);
  assertEquals(answerOf(await readSesEvent("{}", deps({ verify: () => { throw new Error("boom"); } }).d)).status, 503, "never throws");
});

Deno.test("the handshake is confirmed; an unsubscribe is not confirmed back and is logged as an outage", async () => {
  const sub = deps({ message: sns("SubscriptionConfirmation", "subscribe") });
  const a = answerOf(await readSesEvent("{}", sub.d));
  assertEquals([a.status, a.body.confirmed, sub.confirmed()], [200, true, 1]);
  const failed = deps({ message: sns("SubscriptionConfirmation", "subscribe"), confirm: () => Promise.resolve(false) });
  assertEquals(answerOf(await readSesEvent("{}", failed.d)).status, 503);
  const un = deps({ message: sns("UnsubscribeConfirmation", "bye") });
  const u = answerOf(await readSesEvent("{}", un.d));
  assertEquals([u.status, u.log?.code, un.confirmed()], [200, "ses_events_unsubscribed", 0]);
});

Deno.test("a message that is not an event, or one we do not record, is answered 200 and dropped", async () => {
  assertEquals(answerOf(await readSesEvent("{}", deps({ message: sns("Notification", "plain text") }).d)).body.ignored, "not an event");
  const delay = sns("Notification", JSON.stringify({ eventType: "DeliveryDelay", mail: mail() }));
  const a = answerOf(await readSesEvent("{}", deps({ message: delay }).d));
  assertEquals([a.status, a.body.ignored], [200, "unhandled record type"]);
});
