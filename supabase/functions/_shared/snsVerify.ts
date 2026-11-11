/**
 * Proof that an HTTPS POST really came from Amazon SNS, and from one of OUR topics.
 *
 * WHY THIS FILE EXISTS (2026-11-10). Email moves to Amazon SES, and SES tells us things through
 * Amazon SNS: one topic says "an email arrived", another carries bounce, complaint and delivery
 * events. SNS delivers each one by POSTing to a public edge function URL. Anyone can POST there
 * and SNS sends no shared secret, so the only proof of origin is the signature inside the
 * message. Without this check a stranger could invent a customer's reply on a builder's thread,
 * or mark a good address as bounced.
 *
 * ZERO IMPORTS, like ses.ts and resend.ts: Web Crypto and fetch only. A leaf with no imports is
 * what lets the pre-push gate test it offline with a stubbed fetch (snsVerify.test.ts).
 *
 * WHAT IS PROVEN, IN THIS ORDER
 *   1. The body is an SNS envelope (JSON with the fields SNS always sends).
 *   2. It names a topic on our allow-list. This comes BEFORE any network call, so a stranger's
 *      POST never makes us fetch anything.
 *   3. Its signing certificate lives on sns.<region>.amazonaws.com, over https, in the topic's
 *      own region. That host is the whole trust anchor. The certificate is NOT chain-validated
 *      here: it is believed because of where it was fetched from, the same rule AWS's own
 *      validators follow. The message does not sign its own SigningCertURL, so a forger is free
 *      to write anything there, and the URL check is strict for that reason.
 *   4. It is recent (an hour either way by default; SNS retries a delivery for up to an hour).
 *   5. The signature over AWS's documented "string to sign" verifies with the certificate's key.
 *
 * WHAT IS NOT PROVEN: uniqueness. SNS delivers at least once, and a captured message can be
 * replayed while it is still fresh. Callers must make their writes idempotent on MessageId.
 *
 * WHAT THE CALLER GETS BACK. Only the fields the signature covers, plus the three signature
 * fields themselves. UnsubscribeURL, MessageAttributes and, on a Notification, any Token or
 * SubscribeURL sit outside the signature: someone relaying a real message could add or change
 * them without breaking it. They are left out so no caller can act on them by accident.
 *
 * RAW MESSAGE DELIVERY MUST STAY OFF on the subscription. A raw delivery has no envelope and no
 * signature, so it is refused here as not_json or bad_shape.
 *
 * NOTHING HERE THROWS, and no refusal carries text from the message. The Message field holds
 * customer email addresses, and a refusal reason is likely to be logged.
 */

export type SnsMessage = {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string; // "1" (SHA1) or "2" (SHA256)
  Signature: string; // base64
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
};

export type SnsVerdict =
  | { ok: true; message: SnsMessage }
  | { ok: false; reason: "not_json" | "bad_shape" | "wrong_topic" | "bad_cert_url" | "cert_fetch_failed" | "bad_cert" | "bad_signature" | "stale" };

type Refusal = Extract<SnsVerdict, { ok: false }>["reason"];

/** SNS keeps retrying a failed HTTPS delivery for up to an hour, so an honest message can be
 *  that old. Anything older is a replay or a badly wrong clock. */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
/** The function calling this must answer SNS inside 15 seconds or the notice is sent again, so
 *  neither outbound call may wait long. */
const CERT_FETCH_TIMEOUT_MS = 5_000;
const CONFIRM_TIMEOUT_MS = 5_000;
/** A real SNS certificate file is about 2 KB. This only stops a huge body being decoded. */
const MAX_CERT_PEM_CHARS = 64 * 1024;
/** Two topics and the odd certificate rotation need two to four entries. The cap is there so
 *  the map can never grow without bound in a long-lived isolate. */
const KEY_CACHE_MAX = 8;

/** The only host SNS serves certificates and confirmation links from. Group 1 is the region. */
const SNS_HOST = /^sns\.([a-z0-9-]+)\.amazonaws\.com$/;
const TOPIC_ARN = /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}(\.fifo)?$/;

/**
 * Imported verify keys, by hash algorithm and certificate URL, so a warm isolate does not fetch
 * the certificate for every message. A Web Crypto key is tied to one hash, which is why the hash
 * is part of the key. No expiry is needed: when AWS rotates the certificate the file name in the
 * URL changes, so a new certificate is a new entry and the old one falls out at the cap.
 * Only successes are stored. A failed fetch must be free to succeed on the next delivery.
 */
const keyCache = new Map<string, CryptoKey>();

const refuse = (reason: Refusal): SnsVerdict => ({ ok: false, reason });

/** The comma/space separated allow-list setting -> clean ARN list (only strings shaped like
 *  arn:aws:sns:<region>:<12 digits>:<name>). Exported for the callers and tests. */
export function parseTopicArns(setting: string | null | undefined): string[] {
  if (typeof setting !== "string") return [];
  const out: string[] = [];
  for (const part of setting.split(/[\s,]+/)) {
    // A typo in the setting must not become a loose match, so anything not shaped like a topic
    // ARN is dropped. The list is then compared by exact equality only.
    if (TOPIC_ARN.test(part) && !out.includes(part)) out.push(part);
  }
  return out;
}

/** Exported for tests: the canonical string SNS signs. */
export function snsStringToSign(m: SnsMessage): string {
  // AWS's documented format: each field is its name, a newline, its value, a newline, in this
  // fixed order. The order and the set of fields differ by message type, and nothing else in
  // the envelope is signed.
  const pair = (name: string, value: string | undefined) => `${name}\n${value ?? ""}\n`;
  if (m.Type === "Notification") {
    // Subject is the one optional field. SNS leaves it out of the signed text when the
    // publisher gave none, so adding an empty pair here would break every such signature.
    const subject = m.Subject !== undefined && m.Subject !== null ? pair("Subject", m.Subject) : "";
    return pair("Message", m.Message) + pair("MessageId", m.MessageId) + subject +
      pair("Timestamp", m.Timestamp) + pair("TopicArn", m.TopicArn) + pair("Type", m.Type);
  }
  return pair("Message", m.Message) + pair("MessageId", m.MessageId) + pair("SubscribeURL", m.SubscribeURL) +
    pair("Timestamp", m.Timestamp) + pair("Token", m.Token) + pair("TopicArn", m.TopicArn) + pair("Type", m.Type);
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    // atob throws on anything that is not base64.
    return null;
  }
}

const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";
const PEM_END = "-----END CERTIFICATE-----";

function pemToDer(pem: string): Uint8Array | null {
  if (typeof pem !== "string") return null;
  // trim() also drops a leading byte order mark, which JavaScript counts as whitespace.
  const text = pem.trim();
  // The body must START with the certificate. Searching for a PEM block anywhere would accept
  // an error page or an API answer that merely quotes one, and this host also serves the SNS
  // API. If the file ever holds a chain, the first certificate is the signing one.
  if (!text.startsWith(PEM_BEGIN)) return null;
  const end = text.indexOf(PEM_END, PEM_BEGIN.length);
  if (end < 0) return null;
  const b64 = text.slice(PEM_BEGIN.length, end).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  return base64ToBytes(b64);
}

const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;
/** The explicit [0] wrapper around the certificate version. Version 1 certificates omit it. */
const DER_VERSION_WRAPPER = 0xa0;

/** One DER element: where it starts, where its content starts, and where it ends (exclusive). */
type Tlv = { tag: number; start: number; body: number; end: number };

/** Read the element at `at`, which must fit entirely before `limit`. Null when it does not. */
function readTlv(der: Uint8Array, at: number, limit: number): Tlv | null {
  if (at < 0 || at + 2 > limit) return null;
  const tag = der[at];
  // Tag number 31 means "the tag continues in the next bytes". Nothing on the way to the public
  // key uses that form, so meeting one means this is not a certificate.
  if ((tag & 0x1f) === 0x1f) return null;
  const first = der[at + 1];
  let body = at + 2;
  let length = first;
  if (first >= 0x80) {
    // Long form: the low seven bits say how many bytes hold the length. Zero would be the
    // indefinite form, which DER forbids, and more than four would describe gigabytes.
    const count = first & 0x7f;
    if (count === 0 || count > 4 || body + count > limit) return null;
    length = 0;
    // Multiplication, not bit shifts: a four byte length would turn negative as a 32-bit int.
    for (let i = 0; i < count; i++) length = length * 256 + der[body + i];
    // DER allows only the shortest encoding: no long form under 128, no leading zero byte.
    if (length < 0x80 || der[body] === 0) return null;
    body += count;
  }
  if (length > limit - body) return null;
  return { tag, start: at, body, end: body + length };
}

/** Exported for tests: pull the SubjectPublicKeyInfo (DER bytes) out of an X.509 certificate PEM. Returns null if it cannot. */
export function spkiFromCertPem(pem: string): Uint8Array | null {
  try {
    const der = pemToDer(pem);
    if (!der) return null;
    // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
    // It must fill the file exactly. A length that runs past the end is a truncated download.
    const cert = readTlv(der, 0, der.length);
    if (!cert || cert.tag !== DER_SEQUENCE || cert.end !== der.length) return null;
    const tbs = readTlv(der, cert.body, cert.end);
    if (!tbs || tbs.tag !== DER_SEQUENCE) return null;

    // tbsCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber, signature, issuer,
    //                               validity, subject, subjectPublicKeyInfo, ... }
    let at = tbs.body;
    const version = readTlv(der, at, tbs.end);
    if (!version) return null;
    if (version.tag === DER_VERSION_WRAPPER) at = version.end;
    // serialNumber, then signature, issuer, validity and subject. Each tag is checked so a
    // file that is not a certificate fails here and never hands some other field to importKey.
    for (const tag of [DER_INTEGER, DER_SEQUENCE, DER_SEQUENCE, DER_SEQUENCE, DER_SEQUENCE]) {
      const skipped = readTlv(der, at, tbs.end);
      if (!skipped || skipped.tag !== tag) return null;
      at = skipped.end;
    }
    const spki = readTlv(der, at, tbs.end);
    if (!spki || spki.tag !== DER_SEQUENCE) return null;
    // Web Crypto's "spki" import wants the whole element, header included.
    return der.slice(spki.start, spki.end);
  } catch {
    return null;
  }
}

/**
 * The envelope as a clean SnsMessage, or null when a field SNS always sends is missing or of the
 * wrong kind. Built field by field, never by casting what was parsed, so the result holds only
 * what the signature covers (see WHAT THE CALLER GETS BACK at the top).
 */
function shapeOf(parsed: unknown): SnsMessage | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const text = (name: string): string | null => {
    const v = o[name];
    return typeof v === "string" && v !== "" ? v : null;
  };

  const Type = o.Type;
  if (Type !== "Notification" && Type !== "SubscriptionConfirmation" && Type !== "UnsubscribeConfirmation") return null;
  const MessageId = text("MessageId");
  const TopicArn = text("TopicArn");
  const Message = text("Message");
  const Timestamp = text("Timestamp");
  const Signature = text("Signature");
  const SigningCertURL = text("SigningCertURL");
  const SignatureVersion = o.SignatureVersion;
  if (!MessageId || !TopicArn || !Message || !Timestamp || !Signature || !SigningCertURL) return null;
  if (SignatureVersion !== "1" && SignatureVersion !== "2") return null;

  const m: SnsMessage = { Type, MessageId, TopicArn, Message, Timestamp, SignatureVersion, Signature, SigningCertURL };
  if (Type === "Notification") {
    // A null Subject counts as no Subject, which is how AWS's own validators read it.
    const subject = o.Subject;
    if (subject !== undefined && subject !== null) {
      if (typeof subject !== "string") return null;
      m.Subject = subject;
    }
  } else {
    const Token = text("Token");
    const SubscribeURL = text("SubscribeURL");
    if (!Token || !SubscribeURL) return null;
    m.Token = Token;
    m.SubscribeURL = SubscribeURL;
  }
  return m;
}

/**
 * The certificate URL we are willing to fetch for this message, or null. The returned string is
 * rebuilt from the checked parts, so what is fetched is exactly what was checked.
 */
function certUrlFor(m: SnsMessage): string | null {
  let url: URL;
  try {
    url = new URL(m.SigningCertURL);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  // `hostname` is the parsed host, so "sns.us-east-2.amazonaws.com.evil.example" and
  // "evil.example/sns.us-east-2.amazonaws.com.pem" both fail the anchored match.
  const host = SNS_HOST.exec(url.hostname);
  if (!host) return null;
  if (!url.pathname.endsWith(".pem")) return null;
  // A topic's messages are signed by its own region's certificate. A different region here
  // means the URL was rewritten.
  if (host[1] !== m.TopicArn.split(":")[3]) return null;
  // No query string and no fragment. Real certificate URLs have neither, and this host is also
  // the SNS API, where a query string selects an API action. Comparing against the rebuilt URL
  // is also the backstop for the checks above: anything the parser kept besides https, the
  // host and the path fails here.
  const clean = `https://${url.hostname}${url.pathname}`;
  return url.href === clean ? clean : null;
}

/** The verify key for one certificate URL and hash, from the cache or fetched and imported. */
async function loadVerifyKey(
  certUrl: string,
  hash: "SHA-1" | "SHA-256",
  fetchImpl: typeof fetch,
): Promise<CryptoKey | "cert_fetch_failed" | "bad_cert"> {
  const cacheKey = `${hash} ${certUrl}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  let pem: string;
  try {
    // redirect "error": the certificate is trusted for the host it came from, so an answer
    // that sends us to another host must not be followed.
    const res = await fetchImpl(certUrl, { redirect: "error", signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return "cert_fetch_failed";
    }
    pem = await res.text();
  } catch {
    // Timeout, network error, or a refused redirect.
    return "cert_fetch_failed";
  }

  const spki = pem.length <= MAX_CERT_PEM_CHARS ? spkiFromCertPem(pem) : null;
  if (!spki) return "bad_cert";
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", spki as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
  } catch {
    // The bytes were shaped like a certificate but the key inside is not a usable RSA key.
    return "bad_cert";
  }

  if (keyCache.size >= KEY_CACHE_MAX) {
    // A Map lists its keys in insertion order, so the first key is the oldest entry.
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  keyCache.set(cacheKey, key);
  return key;
}

/** Parse and verify one raw SNS POST body. `allowedTopicArns` is the exact allow-list; an empty
 *  list refuses everything. Never throws. */
export async function verifySnsMessage(
  rawBody: string,
  allowedTopicArns: string[],
  opts?: { now?: Date; maxAgeMs?: number; fetchImpl?: typeof fetch },
): Promise<SnsVerdict> {
  // `stage` is the refusal the step now running would give. If something throws where no throw
  // is expected, the catch at the bottom answers with it. So this never throws, and an error
  // can only ever refuse a message, never let one through.
  let stage: Refusal = "not_json";
  try {
    const parsed: unknown = JSON.parse(rawBody);

    stage = "bad_shape";
    const m = shapeOf(parsed);
    if (!m) return refuse(stage);

    // Exact equality against the allow-list, and before any network call.
    stage = "wrong_topic";
    if (!Array.isArray(allowedTopicArns) || !allowedTopicArns.includes(m.TopicArn)) return refuse(stage);

    stage = "bad_cert_url";
    const certUrl = certUrlFor(m);
    if (!certUrl) return refuse(stage);

    // Written as "not within" so an unreadable Timestamp (NaN) or a broken clock option refuses.
    stage = "stale";
    const now = (opts?.now ?? new Date()).getTime();
    const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (!(Math.abs(now - Date.parse(m.Timestamp)) <= maxAgeMs)) return refuse(stage);

    // Version "1" is SHA-1 and is still what a topic sends unless it was switched to "2", so
    // both are accepted. The version is not signed, but lying about it only picks the wrong
    // hash and the signature then fails.
    stage = "cert_fetch_failed";
    const hash = m.SignatureVersion === "2" ? "SHA-256" : "SHA-1";
    const key = await loadVerifyKey(certUrl, hash, opts?.fetchImpl ?? fetch);
    if (typeof key === "string") return refuse(key);

    stage = "bad_signature";
    const signature = base64ToBytes(m.Signature);
    if (!signature) return refuse(stage);
    const signed = new TextEncoder().encode(snsStringToSign(m));
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, signed);
    return ok ? { ok: true, message: m } : refuse(stage);
  } catch {
    return refuse(stage);
  }
}

/** GET the SubscribeURL of an already-verified SubscriptionConfirmation. Only https and only a
 *  host of the form sns.<region>.amazonaws.com; anything else returns false without fetching.
 *  Returns true on a 2xx. Never throws. */
export async function confirmSnsSubscription(
  message: SnsMessage,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<boolean> {
  try {
    // Only the first confirmation is answered. An UnsubscribeConfirmation carries a
    // SubscribeURL too, and visiting it would quietly subscribe again after someone chose to
    // unsubscribe. On a Notification the field is not signed at all.
    if (message.Type !== "SubscriptionConfirmation" || typeof message.SubscribeURL !== "string") return false;
    const url = new URL(message.SubscribeURL);
    if (url.protocol !== "https:" || !SNS_HOST.test(url.hostname)) return false;
    if (url.username !== "" || url.password !== "" || url.port !== "") return false;
    const res = await (opts?.fetchImpl ?? fetch)(url.href, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(opts?.timeoutMs ?? CONFIRM_TIMEOUT_MS),
    });
    // The answer is a small XML receipt nobody reads. Dropping it frees the connection, and a
    // failure to drop it must not turn a confirmed subscription into a "false".
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    // A bad URL, a timeout or a network error. SNS sends the confirmation again, so the caller
    // only needs to know it has not happened yet.
    return false;
  }
}
