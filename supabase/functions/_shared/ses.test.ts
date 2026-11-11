/**
 * Unit tests for the Amazon SES transport (ses.ts).
 *
 * WHY THESE EXIST. The module can only otherwise be exercised against live AWS, which needs a
 * real key, creates real identities and sends real email. So the request signing, the wire
 * shape of a send, the error verdicts, the "never surface AWS's message" rule and the inbound
 * object-key check are pinned here with `fetch` stubbed: no network, no AWS.
 *
 * The signing is held against AWS's own published SigV4 examples, so a change that breaks it
 * fails here and not as a 403 on a customer's quote.
 *
 * Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/ses.test.ts
 * (the pre-push gate discovers _shared/*.test.ts automatically: see scripts/preflight.mjs)
 */

import {
  encodeFrom,
  SES_INBOUND_MAX_BYTES,
  SesApiError,
  sesConfigured,
  sesCreateIdentity,
  sesDeleteIdentity,
  sesDisableFeedbackForwarding,
  sesDkimRecords,
  sesGenerateDkimKey,
  sesGetIdentity,
  sesGetInboundObject,
  sesHeaders,
  sesIdentityGivenUp,
  sesIdentityVerified,
  sesInboundConfigured,
  sesInboundMxHost,
  sesInboundRecord,
  sesMessageIdOf,
  SesNotConfigured,
  sesRegion,
  sesSendEmail,
  signV4,
  type SesIdentity,
} from "./ses.ts";

// Local assertions rather than jsr:@std/assert, deliberately: the pre-push gate runs this file
// and must not need a registry (the rule every _shared test follows).
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}` + (msg ? ` (${msg})` : ""));
}

async function expectApiError(fn: () => Promise<unknown>, label: string): Promise<SesApiError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof SesApiError) return e;
    throw new Error(`${label}: expected SesApiError, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
  }
  throw new Error(`${label}: expected SesApiError, but the call resolved`);
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
const realFetch = globalThis.fetch;

function stub(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call = { url: String(input), method: String(init?.method ?? "GET"), headers, body: String(init?.body ?? "") };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const ENV = ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_SESSION_TOKEN", "SES_REGION", "SES_CONFIGURATION_SET", "SES_INBOUND_BUCKET", "SES_INBOUND_PREFIX"];
function setup() {
  for (const k of ENV) Deno.env.delete(k);
  Deno.env.set("SES_ACCESS_KEY_ID", "AKIDEXAMPLE");
  Deno.env.set("SES_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
  Deno.env.set("SES_INBOUND_BUCKET", "example-inbound-bucket");
}
function teardown() {
  for (const k of ENV) Deno.env.delete(k);
  globalThis.fetch = realFetch;
}

// ── SigV4: AWS's own published examples ──────────────────────────────────────────────────────

const EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  now: new Date("2015-08-30T12:36:00Z"),
};

Deno.test("signV4 matches AWS's get-vanilla test vector", async () => {
  const { url, headers } = await signV4({ ...EXAMPLE, method: "GET", host: "example.amazonaws.com", path: "/", service: "service" });
  assertEquals(url, "https://example.amazonaws.com/");
  assertEquals(headers["x-amz-date"], "20150830T123600Z");
  assertEquals(
    headers["authorization"],
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

Deno.test("signV4 matches AWS's post-vanilla test vector", async () => {
  const { headers } = await signV4({ ...EXAMPLE, method: "POST", host: "example.amazonaws.com", path: "/", service: "service" });
  assert(
    headers["authorization"].endsWith("Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"),
    headers["authorization"],
  );
});

Deno.test("signV4 matches the IAM ListUsers example in AWS's signing guide (query + a signed content-type)", async () => {
  const { url, headers } = await signV4({
    ...EXAMPLE,
    method: "GET",
    host: "iam.amazonaws.com",
    path: "/",
    query: { Version: "2010-05-08", Action: "ListUsers" }, // given out of order: signing must sort
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    service: "iam",
  });
  assertEquals(url, "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08");
  assertEquals(
    headers["authorization"],
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
      "SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
});

Deno.test("signV4 signs a session token when there is one, and never sends a Host header itself", async () => {
  const { headers } = await signV4({ ...EXAMPLE, method: "GET", host: "example.amazonaws.com", path: "/", service: "service", sessionToken: "TOKEN" });
  assertEquals(headers["x-amz-security-token"], "TOKEN");
  assert(headers["authorization"].includes("SignedHeaders=host;x-amz-date;x-amz-security-token"), "token must be signed");
  assert(!("host" in headers), "fetch sets Host from the URL; sending our own could disagree with it");
});

Deno.test("signV4 encodes a path segment once for the URL, and S3 signs a different canonical path", async () => {
  const base = { ...EXAMPLE, method: "GET", host: "example.amazonaws.com", path: "/v2/email/identities/a b@example.com" };
  const ses = await signV4({ ...base, service: "ses" });
  const s3 = await signV4({ ...base, service: "ses", s3: true });
  assertEquals(ses.url, "https://example.amazonaws.com/v2/email/identities/a%20b%40example.com");
  assertEquals(s3.url, ses.url, "the URL sent is the same either way");
  assert(ses.headers["authorization"] !== s3.headers["authorization"], "only the signed (canonical) path differs");
});

// ── Configured-ness ──────────────────────────────────────────────────────────────────────────

Deno.test("sesConfigured needs BOTH halves of the key; inbound also needs the bucket", () => {
  setup();
  try {
    assert(sesConfigured(), "both set");
    assert(sesInboundConfigured(), "key + bucket");
    Deno.env.delete("SES_INBOUND_BUCKET");
    assert(!sesInboundConfigured(), "no bucket, no inbound");
    Deno.env.delete("SES_SECRET_ACCESS_KEY");
    assert(!sesConfigured(), "an id without its secret is not configured");
  } finally { teardown(); }
});

Deno.test("a missing key throws SesNotConfigured BEFORE any fetch", async () => {
  setup();
  Deno.env.delete("SES_ACCESS_KEY_ID");
  const calls = stub(() => json({}));
  try {
    let threw = false;
    try { await sesSendEmail({ from: "a@example.com", to: "b@example.com", subject: "s", html: "<p>h</p>" }); }
    catch (e) { threw = e instanceof SesNotConfigured; }
    assert(threw, "must throw SesNotConfigured");
    assertEquals(calls.length, 0);
  } finally { teardown(); }
});

Deno.test("the region falls back to us-east-2 on a missing or malformed setting", () => {
  setup();
  try {
    assertEquals(sesRegion(), "us-east-2");
    Deno.env.set("SES_REGION", "eu-west-1");
    assertEquals(sesRegion(), "eu-west-1");
    Deno.env.set("SES_REGION", "evil.example/");
    assertEquals(sesRegion(), "us-east-2", "a region is spliced into a hostname, so its shape is checked");
  } finally { teardown(); }
});

// ── Sending ──────────────────────────────────────────────────────────────────────────────────

Deno.test("sesSendEmail posts the SES v2 shape, signed, through the configuration set, and returns MessageId", async () => {
  setup();
  const calls = stub(() => json({ MessageId: "010f0123456789ab-11111111-2222-3333-4444-555555555555-000000" }));
  try {
    const out = await sesSendEmail({
      from: '"Example Sheds" <info@example.com>',
      to: "jane@example.org",
      subject: "Your quote",
      html: "<p>Hi</p>",
      text: "Hi",
      replyTo: ["d.ss-abc@reply.example.com", "rep@example.com"],
      tags: [{ name: "client_id", value: "example.sheds" }, { name: "kind", value: "estimate" }],
      headers: { "List-Unsubscribe": "<https://example.com/u/1>", "Message-ID": "<ours@example.com>" },
      attachments: [{ filename: "invite.ics", content: "QkVHSU4=", contentType: "text/calendar" }],
    });
    assertEquals(out.id, "010f0123456789ab-11111111-2222-3333-4444-555555555555-000000");
    assertEquals(calls.length, 1);
    const c = calls[0];
    assertEquals(c.method, "POST");
    assertEquals(c.url, "https://email.us-east-2.amazonaws.com/v2/email/outbound-emails");
    assert(c.headers["authorization"].startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"), "signed");
    assert(c.headers["authorization"].includes("/us-east-2/ses/aws4_request"), "scope names region and service");
    assertEquals(c.headers["content-type"], "application/json");
    assertEquals(JSON.parse(c.body), {
      FromEmailAddress: '"Example Sheds" <info@example.com>',
      Destination: { ToAddresses: ["jane@example.org"] },
      ReplyToAddresses: ["d.ss-abc@reply.example.com", "rep@example.com"],
      Content: {
        Simple: {
          Subject: { Data: "Your quote", Charset: "UTF-8" },
          Body: { Html: { Data: "<p>Hi</p>", Charset: "UTF-8" }, Text: { Data: "Hi", Charset: "UTF-8" } },
          // Message-ID is gone: SES refuses it and would fail the whole send.
          Headers: [{ Name: "List-Unsubscribe", Value: "<https://example.com/u/1>" }],
          Attachments: [{
            RawContent: "QkVHSU4=", FileName: "invite.ics", ContentType: "text/calendar",
            ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64",
          }],
        },
      },
      ConfigurationSetName: "ss-default",
      // A dotted slug degrades the TAG; it never fails the email.
      EmailTags: [{ Name: "client_id", Value: "example-sheds" }, { Name: "kind", Value: "estimate" }],
    });
  } finally { teardown(); }
});

Deno.test("omitted optional fields never appear on the wire", async () => {
  setup();
  const calls = stub(() => json({ MessageId: "id" }));
  try {
    await sesSendEmail({ from: "a@example.com", to: "b@example.org", subject: "s", html: "<p>h</p>" });
    const body = JSON.parse(calls[0].body);
    assertEquals(Object.keys(body).sort(), ["ConfigurationSetName", "Content", "Destination", "FromEmailAddress"]);
    assertEquals(Object.keys(body.Content.Simple).sort(), ["Body", "Subject"]);
    assertEquals(Object.keys(body.Content.Simple.Body), ["Html"]);
  } finally { teardown(); }
});

Deno.test("a single replyTo string becomes a one-address list; blanks are dropped", async () => {
  setup();
  const calls = stub(() => json({ MessageId: "id" }));
  try {
    await sesSendEmail({ from: "a@example.com", to: "b@example.org", subject: "s", html: "h", replyTo: " rep@example.com " });
    await sesSendEmail({ from: "a@example.com", to: "b@example.org", subject: "s", html: "h", replyTo: ["", "  "] });
    assertEquals(JSON.parse(calls[0].body).ReplyToAddresses, ["rep@example.com"]);
    assert(!("ReplyToAddresses" in JSON.parse(calls[1].body)), "an empty list leaves the key off");
  } finally { teardown(); }
});

Deno.test("the configuration set comes from the setting when it is well-formed", async () => {
  setup();
  Deno.env.set("SES_CONFIGURATION_SET", "other-set");
  const calls = stub(() => json({ MessageId: "id" }));
  try {
    await sesSendEmail({ from: "a@example.com", to: "b@example.org", subject: "s", html: "h" });
    assertEquals(JSON.parse(calls[0].body).ConfigurationSetName, "other-set");
  } finally { teardown(); }
});

Deno.test("sesHeaders drops what SES refuses and what its patterns reject, and stops at 15", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 20; i++) many[`X-Test-${i}`] = "v";
  assertEquals(sesHeaders(many).length, 15);
  assertEquals(
    sesHeaders({
      "Message-ID": "<x@example.com>", "reply-to": "a@example.com", "Subject": "no", "Content-Type": "text/x",
      "List-Unsubscribe": "<https://example.com/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "References": "<a@example.com>", "X-Bad Name": "v", "X-Colon:": "v", "X-Unicode": "café",
      "X-Empty": "", "X-Long": "x".repeat(996),
    }),
    [
      { Name: "List-Unsubscribe", Value: "<https://example.com/u>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
      { Name: "References", Value: "<a@example.com>" },
    ],
  );
  assertEquals(sesHeaders(undefined), []);
});

Deno.test("encodeFrom leaves ASCII alone and turns a non-ASCII display name into encoded-words", () => {
  assertEquals(encodeFrom('"Example Sheds" <info@example.com>'), '"Example Sheds" <info@example.com>');
  assertEquals(encodeFrom("info@example.com"), "info@example.com");
  const one = encodeFrom('"Café Sheds" <info@example.com>');
  assertEquals(one, "=?UTF-8?B?Q2Fmw6kgU2hlZHM=?= <info@example.com>");
  // A long name is cut on whole characters into several words, each within RFC 2047's 75.
  const long = encodeFrom(`"${"é".repeat(60)}" <info@example.com>`);
  const words = long.replace(/ <info@example\.com>$/, "").split(" ");
  assert(words.length > 1, "must be split");
  for (const w of words) {
    assert(w.length <= 75, `encoded-word too long: ${w.length}`);
    const bytes = Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0));
    // fatal: a word that ends mid-character would throw here.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  // An escaped quote inside the name is unescaped before encoding.
  assertEquals(encodeFrom('"A \\"B\\" é" <a@example.com>'), `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode('A "B" é')))}?= <a@example.com>`);
});

Deno.test("sesMessageIdOf reads SES's id back out of a Message-ID, and refuses any other host", () => {
  const id = "010f01a1c6ab6244-97c93344-1283-410a-bb48-6ec62d26202b-000000";
  assertEquals(sesMessageIdOf(`<${id}@us-east-2.amazonses.com>`), id);
  assertEquals(sesMessageIdOf(`${id}@email.amazonses.com`), id, "us-east-1's spelling");
  assertEquals(sesMessageIdOf(`<${id}@amazonses.com.evil.example>`), null);
  assertEquals(sesMessageIdOf("<CAF=abc@mail.gmail.com>"), null);
  assertEquals(sesMessageIdOf("<short@us-east-2.amazonses.com>"), null);
  assertEquals(sesMessageIdOf(""), null);
  assertEquals(sesMessageIdOf(null), null);
});

// ── Verdicts and the "never surface AWS's message" rule ──────────────────────────────────────

function awsError(status: number, type: string, message = "Email address is not verified: jane@example.org"): Response {
  return json({ message }, status, { "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazonaws.ses/` });
}

Deno.test("400 BadRequestException is PERMANENT: the request itself is malformed", async () => {
  setup();
  stub(() => awsError(400, "BadRequestException"));
  try {
    const e = await expectApiError(() => sesSendEmail({ from: "a@example.com", to: "b@example.org", subject: "s", html: "h" }), "400");
    assertEquals([e.status, e.name_, e.permanent], [400, "BadRequestException", true]);
  } finally { teardown(); }
});

Deno.test("MessageRejected, a paused account, a throttle, a 403 and a 5xx all stay RETRYABLE", async () => {
  setup();
  try {
    for (const [status, type] of [
      [400, "MessageRejected"], [400, "SendingPausedException"], [400, "AccountSuspendedException"],
      [400, "MailFromDomainNotVerifiedException"], [429, "TooManyRequestsException"], [400, "LimitExceededException"],
      [403, "AccessDeniedException"], [403, "InvalidSignatureException"], [500, "InternalFailure"], [503, "ServiceUnavailable"],
    ] as const) {
      stub(() => awsError(status, type));
      const e = await expectApiError(() => sesSendEmail({ from: "a@example.com", to: "b@example.org", subject: "s", html: "h" }), type);
      assertEquals([e.status, e.name_, e.permanent], [status, type, false], type);
    }
  } finally { teardown(); }
});

Deno.test("404 NotFoundException and 409 AlreadyExistsException are PERMANENT; a concurrent-modification 409 is not", async () => {
  setup();
  try {
    stub(() => awsError(404, "NotFoundException", "Identity not found"));
    assertEquals((await expectApiError(() => sesGetIdentity("example.com"), "404")).permanent, true);
    stub(() => awsError(409, "AlreadyExistsException", "exists"));
    assertEquals((await expectApiError(() => sesCreateIdentity("example.com"), "409")).permanent, true);
    stub(() => awsError(409, "ConcurrentModificationException", "busy"));
    assertEquals((await expectApiError(() => sesCreateIdentity("example.com"), "409b")).permanent, false);
  } finally { teardown(); }
});

Deno.test("AWS's message is NEVER surfaced: it names recipient addresses", async () => {
  setup();
  stub(() => awsError(400, "MessageRejected", "Email address is not verified. The following identities failed the check: jane@example.org"));
  try {
    const e = await expectApiError(() => sesSendEmail({ from: "a@example.com", to: "jane@example.org", subject: "s", html: "h" }), "leak");
    assert(!e.message.includes("jane@example.org"), "no address in the error message");
    assert(!JSON.stringify({ ...e, message: e.message }).includes("failed the check"), "no provider text anywhere on the error");
  } finally { teardown(); }
});

Deno.test("an exception name that is not plain letters and digits is DROPPED; a __type body is read when the header is absent", async () => {
  setup();
  try {
    stub(() => json({ message: "x" }, 400, { "x-amzn-errortype": "jane@example.org" }));
    assertEquals((await expectApiError(() => sesGetIdentity("example.com"), "gate")).name_, "");
    stub(() => json({ __type: "com.amazonaws.ses#MessageRejected", message: "x" }, 400));
    assertEquals((await expectApiError(() => sesGetIdentity("example.com"), "type")).name_, "MessageRejected");
    stub(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const e = await expectApiError(() => sesGetIdentity("example.com"), "html");
    assertEquals([e.status, e.name_, e.permanent], [502, "", false]);
  } finally { teardown(); }
});

Deno.test("a network error is retryable with status 0; a timeout is named", async () => {
  setup();
  try {
    globalThis.fetch = (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch;
    const net = await expectApiError(() => sesGetIdentity("example.com"), "net");
    assertEquals([net.status, net.name_, net.permanent], [0, "", false]);

    globalThis.fetch = ((_i: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
      })) as typeof fetch;
    const t = await expectApiError(() => sesSendEmail({ from: "a@example.com", to: "b@example.org", subject: "s", html: "h" }, { timeoutMs: 20 }), "timeout");
    assertEquals([t.status, t.name_, t.permanent], [0, "timeout", false]);
  } finally { teardown(); }
});

// ── Identities ───────────────────────────────────────────────────────────────────────────────

const GET_IDENTITY = {
  IdentityType: "DOMAIN",
  FeedbackForwardingStatus: true,
  VerifiedForSendingStatus: true,
  VerificationStatus: "SUCCESS",
  DkimAttributes: { SigningEnabled: true, Status: "SUCCESS", Tokens: ["ss1"], SigningAttributesOrigin: "EXTERNAL" },
  MailFromAttributes: { MailFromDomain: "bounce.example.com", MailFromDomainStatus: "PENDING", BehaviorOnMxFailure: "USE_DEFAULT_VALUE" },
};

Deno.test("sesCreateIdentity sends the bring-your-own key when given one, and asks for Easy DKIM otherwise", async () => {
  setup();
  const calls = stub(() => json({ IdentityType: "DOMAIN", VerifiedForSendingStatus: false, DkimAttributes: { Status: "NOT_STARTED", Tokens: ["ss1"], SigningAttributesOrigin: "EXTERNAL" } }));
  try {
    const i = await sesCreateIdentity("example.com", { selector: "ss1", privateKey: "QUJD" });
    assertEquals(calls[0].url, "https://email.us-east-2.amazonaws.com/v2/email/identities");
    assertEquals(JSON.parse(calls[0].body), {
      EmailIdentity: "example.com",
      DkimSigningAttributes: { DomainSigningSelector: "ss1", DomainSigningPrivateKey: "QUJD" },
    });
    assertEquals([i.name, i.verified, i.dkim.status, i.dkim.origin], ["example.com", false, "NOT_STARTED", "EXTERNAL"]);
    assert(!sesIdentityVerified(i), "a fresh identity is not verified");

    await sesCreateIdentity("example.org");
    assertEquals(JSON.parse(calls[1].body).DkimSigningAttributes, { NextSigningKeyLength: "RSA_2048_BIT" });
  } finally { teardown(); }
});

Deno.test("sesGetIdentity normalizes the answer; verified needs AWS's flag AND a passed DKIM check", async () => {
  setup();
  const calls = stub(() => json(GET_IDENTITY));
  try {
    const i = await sesGetIdentity("example.com");
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[0].url, "https://email.us-east-2.amazonaws.com/v2/email/identities/example.com");
    assertEquals(i, {
      name: "example.com", verified: true, verificationStatus: "SUCCESS",
      dkim: { status: "SUCCESS", origin: "EXTERNAL", tokens: ["ss1"] },
      mailFrom: { domain: "bounce.example.com", status: "PENDING" },
      feedbackForwarding: true,
    });
    assert(sesIdentityVerified(i), "verified");
    const pending: SesIdentity = { ...i, dkim: { ...i.dkim, status: "PENDING" } };
    assert(!sesIdentityVerified(pending), "the flag alone is not enough");
    assertEquals(sesIdentityGivenUp(pending), null);
    assertEquals(sesIdentityGivenUp({ ...i, dkim: { ...i.dkim, status: "FAILED" } }), "failed");
    assertEquals(sesIdentityGivenUp({ ...i, dkim: { ...i.dkim, status: "TEMPORARY_FAILURE" } }), "temporary_failure");
  } finally { teardown(); }
});

Deno.test("an answer missing every optional field still normalizes", async () => {
  setup();
  stub(() => json({}));
  try {
    assertEquals(await sesGetIdentity("example.com"), {
      name: "example.com", verified: false, verificationStatus: "",
      dkim: { status: "", origin: "", tokens: [] }, mailFrom: null, feedbackForwarding: null,
    });
  } finally { teardown(); }
});

Deno.test("sesDeleteIdentity issues a DELETE; sesDisableFeedbackForwarding a PUT that switches it off", async () => {
  setup();
  const calls = stub(() => new Response("{}", { status: 200 }));
  try {
    await sesDeleteIdentity("example.com");
    await sesDisableFeedbackForwarding("example.com");
    assertEquals([calls[0].method, calls[0].url], ["DELETE", "https://email.us-east-2.amazonaws.com/v2/email/identities/example.com"]);
    assertEquals([calls[1].method, calls[1].url], ["PUT", "https://email.us-east-2.amazonaws.com/v2/email/identities/example.com/feedback"]);
    assertEquals(JSON.parse(calls[1].body), { EmailForwardingEnabled: false });
  } finally { teardown(); }
});

Deno.test("sesDkimRecords: ONE TXT for bring-your-own DKIM, three CNAMEs for Easy DKIM", () => {
  const byo: SesIdentity = { name: "example.com", verified: false, verificationStatus: "PENDING", dkim: { status: "PENDING", origin: "EXTERNAL", tokens: ["ss1"] }, mailFrom: null, feedbackForwarding: null };
  assertEquals(sesDkimRecords(byo, { selector: "ss1", publicKey: "MIGf" }), [
    { purpose: "DKIM", type: "TXT", host: "ss1._domainkey.example.com", value: "p=MIGf", verified: false },
  ]);
  const easy: SesIdentity = { ...byo, dkim: { status: "SUCCESS", origin: "AWS_SES", tokens: ["aaa", "bbb", "ccc"] } };
  assertEquals(sesDkimRecords(easy), [
    { purpose: "DKIM", type: "CNAME", host: "aaa._domainkey.example.com", value: "aaa.dkim.amazonses.com", verified: true },
    { purpose: "DKIM", type: "CNAME", host: "bbb._domainkey.example.com", value: "bbb.dkim.amazonses.com", verified: true },
    { purpose: "DKIM", type: "CNAME", host: "ccc._domainkey.example.com", value: "ccc.dkim.amazonses.com", verified: true },
  ]);
});

Deno.test("the receiving record is one MX with its priority, at the region's inbound host", () => {
  setup();
  try {
    assertEquals(sesInboundMxHost(), "inbound-smtp.us-east-2.amazonaws.com");
    assertEquals(sesInboundRecord("reply.example.com", false), {
      purpose: "Receiving", type: "MX", host: "reply.example.com", value: "inbound-smtp.us-east-2.amazonaws.com", verified: false, priority: 10,
    });
  } finally { teardown(); }
});

Deno.test("sesGenerateDkimKey makes a 1024-bit pair whose TXT value fits one 255-character DNS string", async () => {
  const k = await sesGenerateDkimKey();
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(k.privateKey), "private key is plain base64 (SES's own pattern)");
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(k.publicKey), "public key is plain base64");
  assert(`p=${k.publicKey}`.length <= 255, `TXT value is ${`p=${k.publicKey}`.length} characters`);
  // The two halves belong together: what the private key signs, the public key verifies.
  const der = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const priv = await crypto.subtle.importKey("pkcs8", der(k.privateKey), alg, false, ["sign"]);
  const pub = await crypto.subtle.importKey("spki", der(k.publicKey), alg, false, ["verify"]);
  const data = new TextEncoder().encode("dkim");
  assert(await crypto.subtle.verify(alg, pub, await crypto.subtle.sign(alg, priv, data), data), "pair matches");
  assert((await sesGenerateDkimKey()).publicKey !== k.publicKey, "a fresh pair every call");
});

// ── Reading a received email ─────────────────────────────────────────────────────────────────

Deno.test("sesGetInboundObject reads the pinned bucket with a signed Range request", async () => {
  setup();
  const calls = stub(() => new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-range": "bytes 0-2/3" } }));
  try {
    const out = await sesGetInboundObject("inbound/5lrsn4pa8evv7tsoef11e9akcq3hkkpj83fk6v81");
    assertEquals(Array.from(out.bytes), [1, 2, 3]);
    assertEquals(out.truncated, false);
    const c = calls[0];
    assertEquals(c.url, "https://example-inbound-bucket.s3.us-east-2.amazonaws.com/inbound/5lrsn4pa8evv7tsoef11e9akcq3hkkpj83fk6v81");
    assertEquals(c.headers["range"], `bytes=0-${SES_INBOUND_MAX_BYTES - 1}`);
    assertEquals(c.headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert(c.headers["authorization"].includes("/us-east-2/s3/aws4_request"), "signed for S3");
    assert(c.headers["authorization"].includes("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"), c.headers["authorization"]);
  } finally { teardown(); }
});

Deno.test("a longer email than the cap comes back truncated", async () => {
  setup();
  stub(() => new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 0-3/5290" } }));
  try {
    const out = await sesGetInboundObject("inbound/abc", { maxBytes: 4 });
    assertEquals([out.bytes.length, out.truncated], [4, true]);
  } finally { teardown(); }
});

Deno.test("an object key of the wrong shape is REFUSED before any request", async () => {
  setup();
  const calls = stub(() => new Response("x"));
  try {
    for (const key of ["inbound/../secrets", "inbound/a/b", "other/abc", "inbound/", "abc", "inbound/a.b", "inbound/a%2Fb", ""]) {
      const e = await expectApiError(() => sesGetInboundObject(key), key);
      assertEquals([e.name_, e.permanent], ["bad_key", true], key);
    }
    assertEquals(calls.length, 0, "nothing may be fetched for a bad key");
  } finally { teardown(); }
});

Deno.test("a missing object is PERMANENT (NoSuchKey); a 503 from S3 is worth another try", async () => {
  setup();
  try {
    stub(() => new Response("<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>", { status: 404 }));
    const gone = await expectApiError(() => sesGetInboundObject("inbound/abc"), "404");
    assertEquals([gone.status, gone.name_, gone.permanent], [404, "NoSuchKey", true]);
    stub(() => new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }));
    const slow = await expectApiError(() => sesGetInboundObject("inbound/abc"), "503");
    assertEquals([slow.status, slow.name_, slow.permanent], [503, "SlowDown", false]);
  } finally { teardown(); }
});

Deno.test("no bucket setting means SesNotConfigured, not a request to a guessed bucket", async () => {
  setup();
  Deno.env.delete("SES_INBOUND_BUCKET");
  const calls = stub(() => new Response("x"));
  try {
    let threw = false;
    try { await sesGetInboundObject("inbound/abc"); } catch (e) { threw = e instanceof SesNotConfigured; }
    assert(threw, "must throw SesNotConfigured");
    assertEquals(calls.length, 0);
  } finally { teardown(); }
});
