// Tests for the Amazon SNS message verifier (2026-11-10).
//
// snsVerify.ts is the only thing standing between a public edge function URL and the tables
// that hold inbound email and bounce events, so every refusal it can give is pinned here, along
// with the two things that must work for real traffic to get through at all: the exact text SNS
// signs, and reading the public key out of the signing certificate.
//
// Nothing here reaches the network. The global fetch is swapped for a stub and always put back.
// Nothing here is real AWS material either (the repo is public): the RSA key is made fresh on
// each run, the certificate is built around it below with a tiny DER encoder, and the account
// number is AWS's documentation placeholder.
//
// Dependency-free (no jsr:/npm: imports), the same rule the other _shared tests follow, so the
// suite runs on a machine with no registry access.
//
// The verifier caches keys per certificate URL for the life of the module, so each test uses
// its own /cert-<n>.pem path and cannot be helped or hurt by a test that ran before it.

import { confirmSnsSubscription, parseTopicArns, snsStringToSign, spkiFromCertPem, verifySnsMessage } from "./snsVerify.ts";
import type { SnsMessage, SnsVerdict } from "./snsVerify.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
/** JSON with object keys sorted, so two objects with the same fields compare equal whatever
 *  order they were built in (the verifier rebuilds the message field by field). */
function stable(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = stable(actual), e = stable(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

// ---- A tiny DER encoder, just enough to build a certificate -------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
/** DER length bytes: one byte under 128, otherwise a count byte and the length big-endian. */
function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}
const seq = (...content: Uint8Array[]) => tlv(0x30, ...content);
const ascii = (s: string) => new TextEncoder().encode(s);

const OID_SHA256_WITH_RSA = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b);
const OID_COMMON_NAME = Uint8Array.of(0x55, 0x04, 0x03);

/**
 * A small but structurally real X.509 certificate around `spki`:
 *   SEQUENCE { tbs SEQUENCE { [0]{INTEGER 2}, INTEGER serial, AlgorithmIdentifier, issuer Name,
 *              validity, subject Name, SPKI }, AlgorithmIdentifier, BIT STRING }
 * Its own signature is filler. The verifier trusts a certificate for the host it was fetched
 * from and does not chain-validate, so nothing ever reads those bytes.
 */
function buildCertDer(spki: Uint8Array, o: { version?: boolean; serial?: boolean } = {}): Uint8Array {
  const algorithm = seq(tlv(0x06, OID_SHA256_WITH_RSA), tlv(0x05));
  const name = (cn: string) => seq(tlv(0x31, seq(tlv(0x06, OID_COMMON_NAME), tlv(0x0c, ascii(cn)))));
  const validity = seq(tlv(0x17, ascii("250101000000Z")), tlv(0x17, ascii("450101000000Z")));
  const tbs = seq(
    ...(o.version === false ? [] : [tlv(0xa0, tlv(0x02, Uint8Array.of(2)))]),
    ...(o.serial === false ? [] : [tlv(0x02, Uint8Array.of(0x01, 0x23, 0x45, 0x67))]),
    algorithm,
    name("Example Test CA"),
    validity,
    name("sns.example.test"),
    spki,
  );
  const fillerSignature = tlv(0x03, Uint8Array.of(0x00), new Uint8Array(32).fill(0xab));
  return seq(tbs, algorithm, fillerSignature);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function toPem(der: Uint8Array): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
const hex = (bytes: Uint8Array | null) => bytes === null ? null : Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// ---- One key pair for the whole file (making a 2048-bit key is the slow part) -------------

type Keys = {
  /** The public key as Web Crypto exports it. The certificate is built around these bytes. */
  spki: Uint8Array;
  certDer: Uint8Array;
  pem: string;
  /** Sign `text` the way SNS does for that SignatureVersion; base64, like the wire. */
  sign: (version: string, text: string) => Promise<string>;
};
let keysOnce: Promise<Keys> | null = null;
function keys(): Promise<Keys> {
  keysOnce ??= makeKeys();
  return keysOnce;
}
async function makeKeys(): Promise<Keys> {
  const rsa = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const pair = await crypto.subtle.generateKey({ ...rsa, hash: "SHA-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  // A Web Crypto key is tied to one hash, so the same private key is imported a second time
  // for SHA-1 (SignatureVersion "1").
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const sha1Key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["sign"]);
  const certDer = buildCertDer(spki);
  return {
    spki,
    certDer,
    pem: toPem(certDer),
    sign: async (version, text) => {
      const key = version === "2" ? pair.privateKey : sha1Key;
      return toBase64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, ascii(text))));
    },
  };
}

// ---- Messages ----------------------------------------------------------------------------

const TOPIC = "arn:aws:sns:us-east-2:123456789012:example-topic";
const OTHER_TOPIC = "arn:aws:sns:us-east-2:123456789012:example-events";
const NOW = new Date("2026-01-15T12:00:00.000Z");
const FRESH = "2026-01-15T11:59:30.000Z";
const certUrl = (n: number | string) => `https://sns.us-east-2.amazonaws.com/cert-${n}.pem`;
const SUBSCRIBE_URL =
  "https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:us-east-2:123456789012:example-topic&Token=0123456789abcdef";

type Draft = Omit<SnsMessage, "Signature">;

function notification(n: number | string, over: Partial<Draft> = {}): Draft {
  return {
    Type: "Notification",
    MessageId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    TopicArn: TOPIC,
    Message: JSON.stringify({ notificationType: "Received", mail: { source: "someone@example.com" } }),
    Timestamp: FRESH,
    SignatureVersion: "2",
    SigningCertURL: certUrl(n),
    ...over,
  };
}
function subscriptionConfirmation(n: number | string, over: Partial<Draft> = {}): Draft {
  return {
    Type: "SubscriptionConfirmation",
    MessageId: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
    TopicArn: TOPIC,
    Message: `You have chosen to subscribe to the topic ${TOPIC}.\nTo confirm the subscription, visit the SubscribeURL included in this message.`,
    Timestamp: FRESH,
    SignatureVersion: "2",
    SigningCertURL: certUrl(n),
    Token: "0123456789abcdef",
    SubscribeURL: SUBSCRIBE_URL,
    ...over,
  };
}

/** The text SNS signs, written out a second time here on purpose. Signing the test messages
 *  with the verifier's own snsStringToSign would let a mistake in it pass on both sides. */
function canonical(m: Draft): string {
  const lines: string[] = [];
  const add = (name: string, value: string | undefined) => lines.push(name, value ?? "");
  add("Message", m.Message);
  add("MessageId", m.MessageId);
  if (m.Type === "Notification") {
    if (m.Subject !== undefined) add("Subject", m.Subject);
  } else {
    add("SubscribeURL", m.SubscribeURL);
  }
  add("Timestamp", m.Timestamp);
  if (m.Type !== "Notification") add("Token", m.Token);
  add("TopicArn", m.TopicArn);
  add("Type", m.Type);
  return lines.join("\n") + "\n";
}
async function signed(draft: Draft): Promise<SnsMessage> {
  const k = await keys();
  return { ...draft, Signature: await k.sign(draft.SignatureVersion, canonical(draft)) };
}

const reasonOf = (v: SnsVerdict) => (v.ok ? "ok" : v.reason);

// ---- The fetch stub ----------------------------------------------------------------------

type Stub = { impl: typeof fetch; calls: { url: string; init: RequestInit }[] };
/** A fetch that records every request and answers from `answer`. A throw becomes a rejected
 *  promise, like a real network failure. */
function fetchStub(answer: (url: string) => Response): Stub {
  const calls: Stub["calls"] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init: init ?? {} });
    try {
      return Promise.resolve(answer(url));
    } catch (e) {
      return Promise.reject(e);
    }
  }) as typeof fetch;
  return { impl, calls };
}
/** A stub that serves the test certificate for any URL. */
async function certStub(): Promise<Stub> {
  const k = await keys();
  return fetchStub(() => new Response(k.pem, { status: 200 }));
}
/** A stub for tests where any fetch at all is the failure. */
const noFetchStub = () => fetchStub(() => new Response("no fetch was expected", { status: 500 }));

/** Swap the global fetch for one test and always put the real one back. */
async function withGlobalFetch<T>(stub: Stub, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub.impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

// ---- Messages that must verify -----------------------------------------------------------

Deno.test("1. a valid SignatureVersion 2 (SHA-256) Notification verifies", async () => {
  const msg = await signed(notification(1));
  const stub = await certStub();
  const verdict = await withGlobalFetch(stub, () => verifySnsMessage(JSON.stringify(msg), [OTHER_TOPIC, TOPIC], { now: NOW }));
  assert(verdict.ok, `expected ok, got ${reasonOf(verdict)}`);
  assertEquals(verdict.message, msg, "the verified message is handed back");
  assertEquals(stub.calls.map((c) => c.url), [certUrl(1)], "one GET, for the certificate, at the URL the message named");
  assert(stub.calls[0].init.signal instanceof AbortSignal, "the certificate fetch carries a timeout");
});

Deno.test("2. a valid SignatureVersion 1 (SHA-1) Notification verifies", async () => {
  const msg = await signed(notification(2, { SignatureVersion: "1" }));
  const stub = await certStub();
  await withGlobalFetch(stub, async () => {
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(msg), [TOPIC], { now: NOW })), "ok");
    // The version is not part of the signed text. Relabelling a SHA-1 signature as version 2
    // only makes the verifier use the wrong hash, and the signature must then fail.
    const relabelled = { ...msg, SignatureVersion: "2" };
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(relabelled), [TOPIC], { now: NOW })), "bad_signature");
  });
});

Deno.test("3. a Notification with a Subject verifies, and changing the Subject breaks it", async () => {
  const msg = await signed(notification(3, { Subject: "Amazon SES Email Receipt Notification" }));
  const stub = await certStub();
  await withGlobalFetch(stub, async () => {
    const good = await verifySnsMessage(JSON.stringify(msg), [TOPIC], { now: NOW });
    assert(good.ok, `expected ok, got ${reasonOf(good)}`);
    assertEquals(good.message.Subject, "Amazon SES Email Receipt Notification");

    const altered = { ...msg, Subject: "Amazon SES Email Receipt Notification!" };
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(altered), [TOPIC], { now: NOW })), "bad_signature", "Subject altered");
    const { Subject: _dropped, ...removed } = msg;
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(removed), [TOPIC], { now: NOW })), "bad_signature", "Subject removed");

    // The other direction: a message signed with no Subject, then given one.
    const plain = await signed(notification(3));
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify({ ...plain, Subject: "added later" }), [TOPIC], { now: NOW })), "bad_signature", "Subject added");
    // "Subject": null means no Subject, so it is left out of the signed text and the verdict.
    const withNull = await verifySnsMessage(JSON.stringify({ ...plain, Subject: null }), [TOPIC], { now: NOW });
    assert(withNull.ok, `a null Subject is no Subject, got ${reasonOf(withNull)}`);
    assert(!("Subject" in withNull.message), "a null Subject is not handed on");
  });
});

Deno.test("4. a valid SubscriptionConfirmation verifies, and confirmSnsSubscription visits only a real SNS link", async () => {
  const msg = await signed(subscriptionConfirmation(4));
  const verdict = await withGlobalFetch(await certStub(), () => verifySnsMessage(JSON.stringify(msg), [TOPIC], { now: NOW }));
  assert(verdict.ok, `expected ok, got ${reasonOf(verdict)}`);
  assertEquals(verdict.message.SubscribeURL, SUBSCRIBE_URL);
  assertEquals(verdict.message.Token, "0123456789abcdef");

  const ok200 = fetchStub(() => new Response("<ConfirmSubscriptionResponse/>", { status: 200 }));
  assertEquals(await withGlobalFetch(ok200, () => confirmSnsSubscription(verdict.message)), true, "200 confirms");
  assertEquals(ok200.calls.map((c) => c.url), [SUBSCRIBE_URL], "exactly the SubscribeURL, once");
  assertEquals(ok200.calls[0].init.method ?? "GET", "GET");

  const fail500 = fetchStub(() => new Response("InternalFailure", { status: 500 }));
  assertEquals(await withGlobalFetch(fail500, () => confirmSnsSubscription(verdict.message)), false, "500 does not confirm");
  assertEquals(fail500.calls.length, 1);

  const down = fetchStub(() => {
    throw new TypeError("network down");
  });
  assertEquals(await withGlobalFetch(down, () => confirmSnsSubscription(verdict.message)), false, "a network error is false, not a throw");

  // The option is honoured too, and the global is then left alone.
  const viaOption = fetchStub(() => new Response(null, { status: 204 }));
  const untouched = noFetchStub();
  assertEquals(await withGlobalFetch(untouched, () => confirmSnsSubscription(verdict.message, { fetchImpl: viaOption.impl })), true, "any 2xx confirms");
  assertEquals([viaOption.calls.length, untouched.calls.length], [1, 0]);

  const query = "?Action=ConfirmSubscription&Token=0123456789abcdef";
  const refused: [string, SnsMessage][] = [
    ["not https", { ...verdict.message, SubscribeURL: `http://sns.us-east-2.amazonaws.com/${query}` }],
    ["another host", { ...verdict.message, SubscribeURL: `https://evil.example/${query}` }],
    ["SNS host as a prefix", { ...verdict.message, SubscribeURL: `https://sns.us-east-2.amazonaws.com.evil.example/${query}` }],
    ["SNS host as a path", { ...verdict.message, SubscribeURL: `https://evil.example/sns.us-east-2.amazonaws.com/${query}` }],
    ["SNS host as userinfo", { ...verdict.message, SubscribeURL: `https://sns.us-east-2.amazonaws.com@evil.example/${query}` }],
    ["a port", { ...verdict.message, SubscribeURL: `https://sns.us-east-2.amazonaws.com:8443/${query}` }],
    ["not a region host", { ...verdict.message, SubscribeURL: `https://s3.us-east-2.amazonaws.com/${query}` }],
    ["not a URL", { ...verdict.message, SubscribeURL: "not a url" }],
    ["no SubscribeURL", { ...verdict.message, SubscribeURL: undefined }],
    // Visiting an UnsubscribeConfirmation's link would subscribe again behind someone's back.
    ["an UnsubscribeConfirmation", { ...verdict.message, Type: "UnsubscribeConfirmation" }],
  ];
  for (const [label, bad] of refused) {
    const stub = noFetchStub();
    assertEquals(await withGlobalFetch(stub, () => confirmSnsSubscription(bad)), false, label);
    assertEquals(stub.calls.length, 0, `${label}: nothing may be fetched`);
  }
});

// ---- Messages that must be refused -------------------------------------------------------

Deno.test("5. a tampered Message fails bad_signature", async () => {
  const msg = await signed(notification(5));
  await withGlobalFetch(await certStub(), async () => {
    const check = async (label: string, altered: SnsMessage) =>
      assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(altered), [TOPIC], { now: NOW })), "bad_signature", label);
    await check("Message", { ...msg, Message: msg.Message.replace("someone@", "someone.else@") });
    await check("MessageId", { ...msg, MessageId: msg.MessageId.replace(/.$/, "9") });
    await check("Timestamp, still fresh", { ...msg, Timestamp: "2026-01-15T11:59:31.000Z" });
    await check("Type", { ...msg, Type: "SubscriptionConfirmation", Token: "0123456789abcdef", SubscribeURL: SUBSCRIBE_URL });
    await check("Signature that is not base64", { ...msg, Signature: "not base64 !!" });
    await check("Signature cut short", { ...msg, Signature: msg.Signature.slice(0, 40) });
    // And the untouched message still verifies, so the refusals above are about the changes.
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(msg), [TOPIC], { now: NOW })), "ok");
  });
});

Deno.test("6. a TopicArn that is not on the allow-list is wrong_topic, and nothing is fetched", async () => {
  const stub = await certStub();
  await withGlobalFetch(stub, async () => {
    // Correctly signed by SNS, for somebody else's topic.
    const stranger = await signed(notification(6, { TopicArn: "arn:aws:sns:us-east-2:123456789012:someone-elses-topic" }));
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(stranger), [TOPIC, OTHER_TOPIC], { now: NOW })), "wrong_topic");
    // Exact match only: a longer or shorter name is a different topic.
    const ours = await signed(notification(6));
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(ours), [`${TOPIC}-2`, TOPIC.slice(0, -1)], { now: NOW })), "wrong_topic");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(ours), [TOPIC.toUpperCase()], { now: NOW })), "wrong_topic");
  });
  assertEquals(stub.calls.length, 0, "a stranger's message must never make us fetch anything");
});

Deno.test("7. an empty allow-list refuses everything", async () => {
  const msg = await signed(notification(7));
  const stub = await certStub();
  await withGlobalFetch(stub, async () => {
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(msg), [], { now: NOW })), "wrong_topic");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(msg), parseTopicArns(undefined), { now: NOW })), "wrong_topic", "an unset setting");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(msg), parseTopicArns("  "), { now: NOW })), "wrong_topic", "a blank setting");
  });
  assertEquals(stub.calls.length, 0);
});

Deno.test("8. a SigningCertURL that is not the topic region's SNS host is bad_cert_url, and nothing is fetched", async () => {
  const msg = await signed(notification(8));
  const bad: [string, string][] = [
    ["http", "http://sns.us-east-2.amazonaws.com/cert-8.pem"],
    ["SNS host as a prefix of another host", "https://sns.us-east-2.amazonaws.com.evil.example/cert-8.pem"],
    ["SNS host as a path on another host", "https://evil.example/sns.us-east-2.amazonaws.com.pem"],
    ["a port", "https://sns.us-east-2.amazonaws.com:8443/cert-8.pem"],
    ["userinfo", "https://user:secret@sns.us-east-2.amazonaws.com/cert-8.pem"],
    ["SNS host as userinfo", "https://sns.us-east-2.amazonaws.com@evil.example/cert-8.pem"],
    ["path not ending .pem", "https://sns.us-east-2.amazonaws.com/cert-8.txt"],
    ["another region than the topic's", "https://sns.us-west-2.amazonaws.com/cert-8.pem"],
    ["a bucket that looks like SNS", "https://sns.us-east-2.amazonaws.com.s3.amazonaws.com/cert-8.pem"],
    ["no region label", "https://sns.amazonaws.com/cert-8.pem"],
    ["a query string", "https://sns.us-east-2.amazonaws.com/cert-8.pem?Action=GetTopicAttributes"],
    ["a fragment", "https://sns.us-east-2.amazonaws.com/cert-8.pem#x"],
    [".pem only in the query", "https://sns.us-east-2.amazonaws.com/?file=cert-8.pem"],
    ["not a URL", "cert-8.pem"],
  ];
  const stub = await certStub();
  await withGlobalFetch(stub, async () => {
    for (const [label, url] of bad) {
      const verdict = await verifySnsMessage(JSON.stringify({ ...msg, SigningCertURL: url }), [TOPIC], { now: NOW });
      assertEquals(reasonOf(verdict), "bad_cert_url", label);
    }
  });
  assertEquals(stub.calls.length, 0, "a refused certificate URL is never fetched");
});

Deno.test("9. a Timestamp two hours old is stale", async () => {
  const stub = await certStub();
  await withGlobalFetch(stub, async () => {
    const old = await signed(notification(9, { Timestamp: "2026-01-15T10:00:00.000Z" }));
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(old), [TOPIC], { now: NOW })), "stale", "two hours old");
    const early = await signed(notification(9, { Timestamp: "2026-01-15T14:00:00.000Z" }));
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(early), [TOPIC], { now: NOW })), "stale", "two hours in the future");
    const unreadable = await signed(notification(9, { Timestamp: "yesterday afternoon" }));
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(unreadable), [TOPIC], { now: NOW })), "stale", "a Timestamp that is not a date");
    assertEquals(stub.calls.length, 0, "freshness is settled before the certificate is fetched");

    // SNS retries for up to an hour, so a late retry must still get through by default.
    const retry = await signed(notification(9, { Timestamp: "2026-01-15T11:01:00.000Z" }));
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(retry), [TOPIC], { now: NOW })), "ok", "59 minutes old");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(retry), [TOPIC], { now: NOW, maxAgeMs: 5 * 60 * 1000 })), "stale", "a caller's tighter window");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(old), [TOPIC], { now: NOW, maxAgeMs: 3 * 60 * 60 * 1000 })), "ok", "a caller's wider window");
    // With no `now`, the real clock is used: a 2026-01 message is long stale by the time this runs.
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(retry), [TOPIC])), "stale", "the real clock");
  });
});

Deno.test("10. a certificate that cannot be fetched is cert_fetch_failed, and one that cannot be read is bad_cert", async () => {
  const k = await keys();

  // Fetch failures. Neither is remembered: the same URL works as soon as the fetch does.
  const msgA = await signed(notification("10a"));
  const notFound = fetchStub(() => new Response("NoSuchKey", { status: 404 }));
  assertEquals(reasonOf(await withGlobalFetch(notFound, () => verifySnsMessage(JSON.stringify(msgA), [TOPIC], { now: NOW }))), "cert_fetch_failed", "404");
  const down = fetchStub(() => {
    throw new TypeError("network down");
  });
  assertEquals(reasonOf(await withGlobalFetch(down, () => verifySnsMessage(JSON.stringify(msgA), [TOPIC], { now: NOW }))), "cert_fetch_failed", "network error");
  const recovered = await certStub();
  assertEquals(reasonOf(await withGlobalFetch(recovered, () => verifySnsMessage(JSON.stringify(msgA), [TOPIC], { now: NOW }))), "ok", "a failure is not cached");
  assertEquals(recovered.calls.length, 1);

  // Bodies that came back 200 but are not a usable certificate.
  const bogusKey = seq(seq(tlv(0x06, OID_SHA256_WITH_RSA), tlv(0x05)), tlv(0x03, Uint8Array.of(0x00, 0x01, 0x02, 0x03)));
  const garbage: [string, string][] = [
    ["plain text", "this is not a certificate"],
    ["an empty body", ""],
    ["PEM armour around random bytes", toPem(Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256))],
    ["PEM armour around text that is not base64", "-----BEGIN CERTIFICATE-----\n*** not base64 ***\n-----END CERTIFICATE-----\n"],
    ["a certificate cut off in transit", k.pem.slice(0, 400)],
    ["a certificate shape around something that is not an RSA key", toPem(buildCertDer(bogusKey))],
    // This host also serves the SNS API. An answer that merely quotes a certificate somewhere
    // inside it is not a certificate file.
    ["a page that quotes a certificate", `<ErrorResponse><Message>\n${k.pem}</Message></ErrorResponse>`],
    ["an oversized body", k.pem + " ".repeat(70_000)],
  ];
  let n = 0;
  for (const [label, body] of garbage) {
    const msg = await signed(notification(`10b${n++}`));
    const stub = fetchStub(() => new Response(body, { status: 200 }));
    assertEquals(reasonOf(await withGlobalFetch(stub, () => verifySnsMessage(JSON.stringify(msg), [TOPIC], { now: NOW }))), "bad_cert", label);
    assertEquals(stub.calls.length, 1, label);
  }
});

Deno.test("11. the certificate is fetched once for two messages with the same SigningCertURL", async () => {
  const k = await keys();
  const first = await signed(notification(11));
  const second = await signed(notification(11, { MessageId: "00000000-0000-4000-8000-0000000011ff", Message: "a second message" }));
  const counting = fetchStub(() => new Response(k.pem, { status: 200 }));
  // The certificate comes through the fetchImpl option here, so the global must stay untouched.
  const untouched = noFetchStub();
  await withGlobalFetch(untouched, async () => {
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(first), [TOPIC], { now: NOW, fetchImpl: counting.impl })), "ok");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(second), [TOPIC], { now: NOW, fetchImpl: counting.impl })), "ok");
    assertEquals(counting.calls.length, 1, "the second message used the cached key");

    // The cached key is for one hash. The same certificate for a SHA-1 message is its own entry.
    const sha1 = await signed(notification(11, { SignatureVersion: "1" }));
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(sha1), [TOPIC], { now: NOW, fetchImpl: counting.impl })), "ok");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(sha1), [TOPIC], { now: NOW, fetchImpl: counting.impl })), "ok");
    assertEquals(counting.calls.length, 2, "one more fetch for the other hash, then cached too");

    // A cached key does not soften anything: a tampered message on a warm cache still fails.
    const tampered = { ...second, Message: "a different second message" };
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(tampered), [TOPIC], { now: NOW, fetchImpl: counting.impl })), "bad_signature");
  });
  assertEquals(untouched.calls.length, 0, "fetchImpl was used, not the global fetch");
});

Deno.test("12. a body that is not JSON is not_json, and JSON that is not an SNS envelope is bad_shape", async () => {
  const msg = await signed(notification(12));
  const confirmation = await signed(subscriptionConfirmation(12));
  const without = (m: SnsMessage, field: keyof SnsMessage) => {
    const copy: Partial<SnsMessage> = { ...m };
    delete copy[field];
    return JSON.stringify(copy);
  };
  const stub = await certStub();
  await withGlobalFetch(stub, async () => {
    for (const body of ["", "not json", "{", "<xml/>", '{"Type":"Notification"']) {
      assertEquals(reasonOf(await verifySnsMessage(body, [TOPIC], { now: NOW })), "not_json", JSON.stringify(body));
    }
    const badShapes: [string, string][] = [
      ["Signature missing", without(msg, "Signature")],
      ["Type is not one SNS sends", JSON.stringify({ ...msg, Type: "Other" })],
      ["Type missing", without(msg, "Type")],
      ["MessageId empty", JSON.stringify({ ...msg, MessageId: "" })],
      ["TopicArn missing", without(msg, "TopicArn")],
      ["Message missing", without(msg, "Message")],
      ["Message not a string", JSON.stringify({ ...msg, Message: { nested: true } })],
      ["Timestamp missing", without(msg, "Timestamp")],
      ["SigningCertURL missing", without(msg, "SigningCertURL")],
      ["SignatureVersion 3", JSON.stringify({ ...msg, SignatureVersion: "3" })],
      ["SignatureVersion as a number", JSON.stringify({ ...msg, SignatureVersion: 1 })],
      ["Subject not a string", JSON.stringify({ ...msg, Subject: 42 })],
      ["confirmation without Token", without(confirmation, "Token")],
      ["confirmation without SubscribeURL", without(confirmation, "SubscribeURL")],
      ["JSON null", "null"],
      ["a JSON array", "[]"],
      ["a JSON string", '"Notification"'],
      ["a JSON number", "42"],
    ];
    for (const [label, body] of badShapes) {
      assertEquals(reasonOf(await verifySnsMessage(body, [TOPIC], { now: NOW })), "bad_shape", label);
    }
  });
  assertEquals(stub.calls.length, 0, "nothing is fetched for a body that is not an envelope");
});

// ---- The exported helpers ----------------------------------------------------------------

Deno.test("13. parseTopicArns keeps well-formed ARNs, drops junk, splits on commas and whitespace", () => {
  assertEquals(parseTopicArns(`${TOPIC},${OTHER_TOPIC}`), [TOPIC, OTHER_TOPIC]);
  assertEquals(parseTopicArns(`  ${TOPIC}\n\t${OTHER_TOPIC} , ,, `), [TOPIC, OTHER_TOPIC], "spaces, tabs, newlines and stray commas");
  assertEquals(parseTopicArns(`${TOPIC} ${TOPIC}`), [TOPIC], "a repeat is listed once");
  assertEquals(parseTopicArns("arn:aws:sns:us-east-2:123456789012:orders.fifo"), ["arn:aws:sns:us-east-2:123456789012:orders.fifo"], "a FIFO topic");
  const junk = [
    "example-topic",
    "arn:aws:sqs:us-east-2:123456789012:example-queue",
    "arn:aws:sns:us-east-2:12345:example-topic",
    "arn:aws:sns:us-east-2:1234567890123:example-topic",
    "arn:aws:sns:us-east-2:123456789012:",
    "arn:aws:sns::123456789012:example-topic",
    "arn:aws:sns:us-east-2:123456789012:example-topic:subscription-id",
    "arn:aws:sns:us-east-2:123456789012:*",
    "ARN:AWS:SNS:us-east-2:123456789012:example-topic",
    "*",
  ];
  assertEquals(parseTopicArns(junk.join(", ")), [], "nothing loose survives");
  assertEquals(parseTopicArns(`junk, ${TOPIC}, ${junk[1]}`), [TOPIC], "junk is dropped around a good one");
  assertEquals(parseTopicArns(""), []);
  assertEquals(parseTopicArns(null), []);
  assertEquals(parseTopicArns(undefined), []);
});

Deno.test("14. snsStringToSign is AWS's documented text, exactly", () => {
  const base: SnsMessage = {
    Type: "Notification",
    MessageId: "11111111-2222-4333-8444-555555555555",
    TopicArn: TOPIC,
    Message: "hello world",
    Timestamp: "2026-01-15T11:59:30.000Z",
    SignatureVersion: "2",
    Signature: "c2lnbmF0dXJl",
    SigningCertURL: certUrl(14),
  };
  assertEquals(
    snsStringToSign(base),
    "Message\nhello world\n" +
      "MessageId\n11111111-2222-4333-8444-555555555555\n" +
      "Timestamp\n2026-01-15T11:59:30.000Z\n" +
      "TopicArn\narn:aws:sns:us-east-2:123456789012:example-topic\n" +
      "Type\nNotification\n",
    "Notification without Subject",
  );
  assertEquals(
    snsStringToSign({ ...base, Subject: "A subject line" }),
    "Message\nhello world\n" +
      "MessageId\n11111111-2222-4333-8444-555555555555\n" +
      "Subject\nA subject line\n" +
      "Timestamp\n2026-01-15T11:59:30.000Z\n" +
      "TopicArn\narn:aws:sns:us-east-2:123456789012:example-topic\n" +
      "Type\nNotification\n",
    "Notification with Subject",
  );
  assertEquals(
    snsStringToSign({
      ...base,
      Type: "SubscriptionConfirmation",
      Message: "You have chosen to subscribe.\nTo confirm, visit the SubscribeURL.",
      Token: "0123456789abcdef",
      SubscribeURL: SUBSCRIBE_URL,
    }),
    "Message\nYou have chosen to subscribe.\nTo confirm, visit the SubscribeURL.\n" +
      "MessageId\n11111111-2222-4333-8444-555555555555\n" +
      `SubscribeURL\n${SUBSCRIBE_URL}\n` +
      "Timestamp\n2026-01-15T11:59:30.000Z\n" +
      "Token\n0123456789abcdef\n" +
      "TopicArn\narn:aws:sns:us-east-2:123456789012:example-topic\n" +
      "Type\nSubscriptionConfirmation\n",
    "SubscriptionConfirmation",
  );
  // The fields a Notification does not sign stay out even when they are present.
  assertEquals(snsStringToSign({ ...base, Token: "t", SubscribeURL: SUBSCRIBE_URL }), snsStringToSign(base), "unsigned fields on a Notification");
  // And a confirmation does not sign a Subject.
  const confirmation: SnsMessage = { ...base, Type: "UnsubscribeConfirmation", Token: "t", SubscribeURL: SUBSCRIBE_URL };
  assertEquals(snsStringToSign({ ...confirmation, Subject: "ignored" }), snsStringToSign(confirmation), "Subject on a confirmation");
  assert(snsStringToSign(confirmation).endsWith("Type\nUnsubscribeConfirmation\n"), "UnsubscribeConfirmation uses the confirmation layout");
  // A null Subject is no Subject. An empty one is present, so it is signed as an empty value.
  assertEquals(snsStringToSign({ ...base, Subject: null as unknown as string }), snsStringToSign(base), "null Subject");
  assert(snsStringToSign({ ...base, Subject: "" }).includes("MessageId\n11111111-2222-4333-8444-555555555555\nSubject\n\nTimestamp\n"), "empty Subject");
});

Deno.test("15. spkiFromCertPem returns the certificate's public key bytes, and null for anything broken", async () => {
  const k = await keys();
  assertEquals(hex(spkiFromCertPem(k.pem)), hex(k.spki), "the SPKI inside the built certificate is the exported key, byte for byte");
  assertEquals(hex(spkiFromCertPem(toPem(buildCertDer(k.spki, { version: false })))), hex(k.spki), "a version 1 certificate has no [0] version to skip");
  assertEquals(hex(spkiFromCertPem(`\n  ${k.pem.replace(/\n/g, "\r\n")}  \n`)), hex(k.spki), "CRLF line ends and outer whitespace");
  assertEquals(hex(spkiFromCertPem(String.fromCharCode(0xfeff) + k.pem)), hex(k.spki), "a leading byte order mark");
  assertEquals(hex(spkiFromCertPem(k.pem + k.pem)), hex(k.spki), "the first certificate of a chain file");

  const der = k.certDer;
  const broken: [string, string][] = [
    ["one byte short", toPem(der.slice(0, der.length - 1))],
    ["cut in half", toPem(der.slice(0, der.length >> 1))],
    ["cut inside the first header", toPem(der.slice(0, 3))],
    ["cut inside the issuer", toPem(der.slice(0, 40))],
    ["bytes after the certificate", toPem(concat(der, Uint8Array.of(0x00)))],
    ["no serial number", toPem(buildCertDer(k.spki, { serial: false }))],
    ["not a SEQUENCE", toPem(tlv(0x04, der))],
    ["a length byte that claims more than is there", toPem(Uint8Array.of(0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0x30, 0x00))],
    ["an indefinite length", toPem(Uint8Array.of(0x30, 0x80, 0x30, 0x00, 0x00, 0x00))],
    ["a long-form length where the short form is required", toPem(Uint8Array.of(0x30, 0x81, 0x02, 0x30, 0x00))],
    ["no PEM armour", toBase64(der)],
    ["the wrong PEM label", k.pem.replace(/CERTIFICATE/g, "PUBLIC KEY")],
    ["no END line", k.pem.replace("-----END CERTIFICATE-----", "")],
    ["empty", ""],
  ];
  for (const [label, pem] of broken) assertEquals(spkiFromCertPem(pem), null, label);
});

// ---- Two rules of this module beyond the per-message checks ------------------------------

Deno.test("16. the key cache holds eight certificates: the oldest is fetched again, the newest is not", async () => {
  const k = await keys();
  const counting = fetchStub(() => new Response(k.pem, { status: 200 }));
  const untouched = noFetchStub();
  await withGlobalFetch(untouched, async () => {
    const msgs: SnsMessage[] = [];
    for (let i = 0; i < 9; i++) msgs.push(await signed(notification(`16-${i}`)));
    for (const m of msgs) {
      assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(m), [TOPIC], { now: NOW, fetchImpl: counting.impl })), "ok");
    }
    assertEquals(counting.calls.length, 9, "nine different certificate URLs, nine fetches");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(msgs[8]), [TOPIC], { now: NOW, fetchImpl: counting.impl })), "ok");
    assertEquals(counting.calls.length, 9, "the newest is still cached");
    assertEquals(reasonOf(await verifySnsMessage(JSON.stringify(msgs[0]), [TOPIC], { now: NOW, fetchImpl: counting.impl })), "ok");
    assertEquals(counting.calls.length, 10, "the ninth pushed the first out, so it is fetched again");
    assertEquals(counting.calls[9].url, certUrl("16-0"));
  });
  assertEquals(untouched.calls.length, 0);
});

Deno.test("17. fields the signature does not cover are not handed on, so a relayed Notification cannot point us at a link", async () => {
  // A Notification signs neither Token nor SubscribeURL. Someone relaying a real one can add
  // them and the signature still holds, so the verdict must not carry them.
  const msg = await signed(notification(17));
  const dressedUp = {
    ...msg,
    Token: "added-in-transit",
    SubscribeURL: "https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&Token=added-in-transit",
    UnsubscribeURL: "https://sns.us-east-2.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=added-in-transit",
    MessageAttributes: { added: { Type: "String", Value: "in transit" } },
  };
  const verdict = await withGlobalFetch(await certStub(), () => verifySnsMessage(JSON.stringify(dressedUp), [TOPIC], { now: NOW }));
  assert(verdict.ok, `the signature still holds, got ${reasonOf(verdict)}`);
  assertEquals(verdict.message, msg, "only the signed fields and the signature fields come back");

  const stub = noFetchStub();
  assertEquals(await withGlobalFetch(stub, () => confirmSnsSubscription(verdict.message)), false);
  assertEquals(await withGlobalFetch(stub, () => confirmSnsSubscription(dressedUp as SnsMessage)), false, "even handed the raw object, a Notification is never confirmed");
  assertEquals(stub.calls.length, 0);
});
