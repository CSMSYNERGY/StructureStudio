/**
 * Unit tests for sesInbound.ts: one Amazon SNS POST to "here is the received email".
 *
 * WHY THESE EXIST. Everything this file decides is silent when it goes wrong. A notice accepted
 * without proof puts a stranger's words on a builder's record; a verdict read from the email
 * instead of the signed notice lets a sender mark their own mail clean; the wrong status code
 * either loses a reply (a 2xx on a bucket hiccup) or has SNS hammer us for an hour over a
 * forgery (a 5xx on a bad signature). None of that raises. The dependencies are injected, so no
 * network, no AWS, no certificate.
 *
 * Dependency-free (no jsr:/npm: imports), the rule every _shared test follows.
 * Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/sesInbound.test.ts
 */

import { readSesInbound, senderOf, type SesInboundDeps, type SesInboundResult } from "./sesInbound.ts";
import { parseMime } from "./mimeParse.ts";
import { SesApiError } from "./ses.ts";
import { envelopeRecipients, senderVerdict } from "./emailInbound.ts";
import type { SnsMessage, SnsVerdict } from "./snsVerify.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const TOPIC = "arn:aws:sns:us-east-2:123456789012:example-inbound";
const KEY = "inbound/giq6vfmvnapujlebqj32iq3lponr5us5icirj1o1";

/** A Received notice in the shape SES really sends (read off a live one, 2026-11-10). */
function notice(over: Record<string, unknown> = {}, receiptOver: Record<string, unknown> = {}) {
  return {
    notificationType: "Received",
    mail: {
      timestamp: "2026-11-10T18:25:14.499Z",
      source: "jane@example.org",
      messageId: "giq6vfmvnapujlebqj32iq3lponr5us5icirj1o1",
      destination: ["someone-else@example.net"],
      headersTruncated: false,
      headers: [],
      commonHeaders: { from: ["Jane Doe <jane@example.org>"], to: ["d.ss-abc123@reply.example.com"], subject: "Re: Your estimate", messageId: "<reply-1@mail.example.org>" },
    },
    receipt: {
      timestamp: "2026-11-10T18:25:14.995Z",
      recipients: ["d.ss-abc123@reply.example.com"],
      spamVerdict: { status: "PASS" }, virusVerdict: { status: "PASS" },
      spfVerdict: { status: "PASS" }, dkimVerdict: { status: "PASS" }, dmarcVerdict: { status: "PASS" },
      action: { type: "S3", topicArn: TOPIC, bucketName: "a-bucket-named-in-the-notice", objectKeyPrefix: "inbound/", objectKey: KEY },
      ...receiptOver,
    },
    ...over,
  };
}

function sns(type: SnsMessage["Type"], message: string): SnsMessage {
  return {
    Type: type, MessageId: "sns-msg-1", TopicArn: TOPIC, Message: message, Timestamp: "2026-11-10T18:25:15.000Z",
    SignatureVersion: "2", Signature: "sig", SigningCertURL: "https://sns.us-east-2.amazonaws.com/cert.pem",
    ...(type === "Notification" ? {} : { Token: "tok", SubscribeURL: "https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription" }),
  };
}

const RAW = [
  "Return-Path: <jane@example.org>",
  "X-SES-Spam-Verdict: PASS",
  "X-SES-Virus-Verdict: PASS",
  "Received-SPF: pass (spfCheck: domain of example.org designates 192.0.2.1 as permitted sender)",
  "Authentication-Results: amazonses.com; spf=pass; dkim=pass header.i=@example.org; dmarc=pass header.from=example.org;",
  "From: Jane Doe <jane@example.org>",
  "To: d.ss-abc123@reply.example.com",
  "Subject: Re: Your estimate",
  "Message-ID: <reply-1@mail.example.org>",
  "In-Reply-To: <010f01a1c6ab6244-97c93344-1283-410a-bb48-6ec62d26202b-000000@us-east-2.amazonses.com>",
  "References: <010f01a1c6ab6244-97c93344-1283-410a-bb48-6ec62d26202b-000000@us-east-2.amazonses.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Yes, let's go ahead.",
  "",
].join("\r\n");

type Trace = { verified: string[][]; confirmed: number; fetched: string[] };

function deps(over: Partial<SesInboundDeps> & { message?: SnsMessage; verdict?: SnsVerdict; raw?: string; truncated?: boolean } = {}): { d: Partial<SesInboundDeps>; t: Trace } {
  const t: Trace = { verified: [], confirmed: 0, fetched: [] };
  const d: Partial<SesInboundDeps> = {
    topics: () => [TOPIC],
    configured: () => true,
    verify: (_raw, topics) => {
      t.verified.push(topics);
      return Promise.resolve(over.verdict ?? { ok: true, message: over.message ?? sns("Notification", JSON.stringify(notice())) });
    },
    confirm: () => { t.confirmed++; return Promise.resolve(true); },
    getObject: (key) => {
      t.fetched.push(key);
      return Promise.resolve({ bytes: new TextEncoder().encode(over.raw ?? RAW), truncated: over.truncated ?? false });
    },
    parse: (bytes) => parseMime(bytes),
    ...over,
  };
  return { d, t };
}

function mailOf(r: SesInboundResult) {
  if (r.kind !== "mail") throw new Error(`expected a mail, got an answer ${JSON.stringify(r)}`);
  return r;
}
function answerOf(r: SesInboundResult) {
  if (r.kind !== "answer") throw new Error("expected an answer, got a mail");
  return r;
}

// ── Refusals, and what each status tells SNS ─────────────────────────────────────────────────

Deno.test("no topic configured: 503 (try again once it is set), and nothing is verified or fetched", async () => {
  const { d, t } = deps({ topics: () => [] });
  const a = answerOf(await readSesInbound("{}", d));
  assertEquals(a.status, 503);
  assertEquals(a.log?.code, "ses_inbound_not_configured");
  assertEquals([t.verified.length, t.fetched.length], [0, 0]);
});

Deno.test("a notice that fails verification is a 403 (SNS must not retry a forgery) and is never read", async () => {
  for (const reason of ["bad_signature", "wrong_topic", "bad_cert_url", "stale", "not_json", "bad_shape", "bad_cert"] as const) {
    const { d, t } = deps({ verdict: { ok: false, reason } });
    const a = answerOf(await readSesInbound("{}", d));
    assertEquals([a.status, a.log?.severity, a.log?.context?.reason], [403, "warn", reason], reason);
    assertEquals(t.fetched.length, 0, "nothing is fetched from the bucket for an unproven notice");
  }
});

Deno.test("a certificate that could not be fetched is a 503: the next delivery may well verify", async () => {
  const { d } = deps({ verdict: { ok: false, reason: "cert_fetch_failed" } });
  const a = answerOf(await readSesInbound("{}", d));
  assertEquals([a.status, a.log?.severity], [503, "error"]);
});

Deno.test("the allow-list handed to the verifier is the setting's, and only that", async () => {
  const { d, t } = deps();
  await readSesInbound("{}", d);
  assertEquals(t.verified, [[TOPIC]]);
});

// ── The subscription handshake ───────────────────────────────────────────────────────────────

Deno.test("a SubscriptionConfirmation is confirmed and answered 200; a failed confirmation is a 503", async () => {
  const ok = deps({ message: sns("SubscriptionConfirmation", "You have chosen to subscribe") });
  const a = answerOf(await readSesInbound("{}", ok.d));
  assertEquals([a.status, a.body.confirmed, ok.t.confirmed], [200, true, 1]);
  assertEquals(ok.t.fetched.length, 0);

  const bad = deps({ message: sns("SubscriptionConfirmation", "x"), confirm: () => Promise.resolve(false) });
  assertEquals(answerOf(await readSesInbound("{}", bad.d)).status, 503);
});

Deno.test("an UnsubscribeConfirmation is NOT confirmed back, and is logged as the outage it is", async () => {
  const { d, t } = deps({ message: sns("UnsubscribeConfirmation", "You have chosen to deactivate") });
  const a = answerOf(await readSesInbound("{}", d));
  assertEquals([a.status, t.confirmed], [200, 0]);
  assertEquals(a.log?.code, "ses_inbound_unsubscribed");
  assert(a.log?.severity === undefined, "an error, not a warning: replies have stopped");
});

// ── Notices that are not a stored email ──────────────────────────────────────────────────────

Deno.test("SES's plain-text setup note, another notification type and a notice with no S3 object are answered 200 and dropped", async () => {
  const text = deps({ message: sns("Notification", "Successfully validated SNS topic for Amazon SES event publishing.") });
  assertEquals(answerOf(await readSesInbound("{}", text.d)).body.ignored, "not an email notice");
  const other = deps({ message: sns("Notification", JSON.stringify({ notificationType: "Bounce" })) });
  assertEquals(answerOf(await readSesInbound("{}", other.d)).body.ignored, "not an email notice");
  const noObj = deps({ message: sns("Notification", JSON.stringify(notice({}, { action: { type: "SNS", topicArn: TOPIC } }))) });
  const a = answerOf(await readSesInbound("{}", noObj.d));
  assertEquals([a.status, a.body.ignored, a.log?.code], [200, "no stored email", "ses_inbound_no_object"]);
  assertEquals(noObj.t.fetched.length, 0);
});

Deno.test("the key or bucket not configured: 503, so the email is delivered again once they are", async () => {
  const { d, t } = deps({ configured: () => false });
  const a = answerOf(await readSesInbound("{}", d));
  assertEquals([a.status, a.log?.code, a.log?.context?.objectKey], [503, "ses_inbound_not_configured", KEY]);
  assertEquals(t.fetched.length, 0);
});

// ── A received email ─────────────────────────────────────────────────────────────────────────

Deno.test("a reply comes back in the shape email-inbound reads, with the envelope from the SIGNED notice", async () => {
  const { d, t } = deps();
  const r = mailOf(await readSesInbound("{}", d));
  assertEquals(t.fetched, [KEY], "the object the notice names, from the bucket our settings name");
  assertEquals(r.objectKey, KEY);
  const m = r.payload.data;
  assertEquals(m.from, { email: "jane@example.org", name: "Jane Doe" });
  assertEquals([m.to, m.subject, m.text.trim()], ["d.ss-abc123@reply.example.com", "Re: Your estimate", "Yes, let's go ahead."]);
  assertEquals(m.message_id, "<reply-1@mail.example.org>");
  assert(m.in_reply_to.includes("010f01a1c6ab6244-97c93344-1283-410a-bb48-6ec62d26202b-000000@us-east-2.amazonses.com"), "In-Reply-To carried through for step B2b");
  assertEquals(m.attachments, []);
  // Stage A in email-inbound reads the tenant from exactly this, and from nothing in the email:
  // the notice's `mail.destination` (the To header) names someone else and is ignored.
  assertEquals(envelopeRecipients(r.payload, r.payload.data), ["d.ss-abc123@reply.example.com"]);
  // And the stored verdict reads as it did for Resend-era rows.
  assertEquals(senderVerdict(m.headers), "spam=PASS virus=PASS spf=pass dkim=pass dmarc=pass");
});

Deno.test("verdicts come from the signed notice: a sender who plants passing headers changes nothing", async () => {
  const forged = RAW.replace("From: Jane Doe", "X-SES-Spam-Verdict: PASS\r\nFrom: Jane Doe");
  const { d } = deps({
    raw: forged,
    message: sns("Notification", JSON.stringify(notice({}, {
      spamVerdict: { status: "FAIL" }, virusVerdict: { status: "PASS" }, spfVerdict: { status: "FAIL" },
      dkimVerdict: { status: "GRAY" }, dmarcVerdict: { status: "PROCESSING_FAILED" },
    }))),
  });
  const m = mailOf(await readSesInbound("{}", d)).payload.data;
  assertEquals(senderVerdict(m.headers), "spam=FAIL virus=PASS spf=fail dkim=gray dmarc=error");
});

Deno.test("a verdict the notice does not carry leaves no header behind, the email's own included", async () => {
  const { d } = deps({ message: sns("Notification", JSON.stringify(notice({}, { spamVerdict: undefined, virusVerdict: undefined, spfVerdict: undefined, dkimVerdict: undefined, dmarcVerdict: undefined }))) });
  const m = mailOf(await readSesInbound("{}", d)).payload.data;
  assertEquals(senderVerdict(m.headers), null, "told nothing means unknown, never the sender's own claim");
});

Deno.test("attachments are listed by name, inline ones too; a truncated read is said, not hidden", async () => {
  const raw = [
    "From: jane@example.org", "To: d.ss-abc123@reply.example.com", "Subject: photos", "Message-ID: <p-1@example.org>",
    "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "",
    "--b1", "Content-Type: text/plain; charset=utf-8", "", "Site photos attached.",
    "--b1", 'Content-Type: image/jpeg; name="site.jpg"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="site.jpg"', "", "/9j/4AAQSkZJRg==",
    "--b1--", "",
  ].join("\r\n");
  const { d } = deps({ raw, truncated: true });
  const r = mailOf(await readSesInbound("{}", d));
  assertEquals(r.payload.data.attachments, [{ filename: "site.jpg" }]);
  assertEquals([r.log?.code, r.log?.severity, r.log?.context?.objectKey], ["ses_inbound_truncated", "warn", KEY]);
});

Deno.test("an email with no Message-ID gets a stable one from SES's own id, so a redelivery is still a duplicate", async () => {
  const raw = RAW.replace("Message-ID: <reply-1@mail.example.org>\r\n", "");
  const first = deps({ raw, message: sns("Notification", JSON.stringify(notice({ mail: { source: "jane@example.org", commonHeaders: {} } }))) });
  const a = mailOf(await readSesInbound("{}", first.d)).payload.data.message_id;
  const second = deps({ raw, message: sns("Notification", JSON.stringify(notice({ mail: { source: "jane@example.org", commonHeaders: {} } }))) });
  const b = mailOf(await readSesInbound("{}", second.d)).payload.data.message_id;
  assertEquals(a, "<giq6vfmvnapujlebqj32iq3lponr5us5icirj1o1@inbound.ses>");
  assertEquals(a, b);
});

Deno.test("no usable From header: the envelope sender stands in, so the reply is still filed", async () => {
  const raw = RAW.replace("From: Jane Doe <jane@example.org>\r\n", "");
  const { d } = deps({ raw, message: sns("Notification", JSON.stringify(notice({ mail: { source: "Bounce-Path@Example.org", commonHeaders: {} } }))) });
  assertEquals(mailOf(await readSesInbound("{}", d)).payload.data.from, { email: "bounce-path@example.org", name: null });
});

// ── The bucket ───────────────────────────────────────────────────────────────────────────────

Deno.test("the bucket not answering is a 503: SNS brings the notice back and the email is read then", async () => {
  for (const err of [
    new SesApiError({ message: "S3 503", status: 503, name_: "SlowDown", permanent: false }),
    new SesApiError({ message: "timeout", status: 0, name_: "timeout", permanent: false }),
    new SesApiError({ message: "S3 403", status: 403, name_: "AccessDenied", permanent: false }),
    new Error("socket hang up"),
  ]) {
    const { d } = deps({ getObject: () => Promise.reject(err) });
    const a = answerOf(await readSesInbound("{}", d));
    assertEquals([a.status, a.log?.code, a.log?.context?.retried], [503, "inbound_body_fetch_failed", true]);
    assert(!JSON.stringify(a).includes("jane@"), "no address in the answer or the log");
  }
});

Deno.test("an object that is gone is NOT retried: the reply is filed from the notice, body missing, with a repair ticket", async () => {
  const { d } = deps({ getObject: () => Promise.reject(new SesApiError({ message: "S3 404", status: 404, name_: "NoSuchKey", permanent: true })) });
  const r = mailOf(await readSesInbound("{}", d));
  const m = r.payload.data;
  assertEquals(m.from, { email: "jane@example.org", name: "Jane Doe" });
  assertEquals([m.subject, m.text, m.html, m.message_id], ["Re: Your estimate", "", "", "<reply-1@mail.example.org>"]);
  assertEquals([r.log?.code, r.log?.context?.retried, r.log?.context?.objectKey], ["inbound_body_fetch_failed", false, KEY]);
  assertEquals(r.payload.receipt.recipients, ["d.ss-abc123@reply.example.com"], "the tenant can still be found");
});

Deno.test("nothing throws: a dependency that blows up unexpectedly becomes a 503", async () => {
  const { d } = deps({ verify: () => { throw new Error("boom"); } });
  const a = answerOf(await readSesInbound("{}", d));
  assertEquals([a.status, a.log?.code], [503, "ses_inbound_unhandled"]);
});

// ── senderOf ─────────────────────────────────────────────────────────────────────────────────

Deno.test("senderOf takes the LAST angle-bracket pair, so an address smuggled into a display name is only a name", () => {
  assertEquals(senderOf("Jane Doe <Jane@Example.org>"), { email: "jane@example.org", name: "Jane Doe" });
  assertEquals(senderOf('"Doe, Jane" <jane@example.org>'), { email: "jane@example.org", name: "Doe, Jane" });
  assertEquals(senderOf("jane@example.org"), { email: "jane@example.org", name: null });
  // What `=?utf-8?Q?=3Cboss=40example.com=3E?= <someone@example.net>` reads once decoded:
  assertEquals(senderOf("<boss@example.com> <someone@example.net>"), { email: "someone@example.net", name: "boss@example.com" });
  assertEquals(senderOf("<jane@example.org>"), { email: "jane@example.org", name: null });
  assertEquals(senderOf("undisclosed"), { email: "", name: null });
  assertEquals(senderOf(""), { email: "", name: null });
});
