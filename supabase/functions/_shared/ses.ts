/**
 * Amazon SES transport: sending, sender-domain identities, and reading a received email.
 *
 * WHY THIS FILE EXISTS (2026-11-10). Email moves from Resend to Amazon SES. This is the SES
 * twin of resend.ts and keeps its shape on purpose: TRANSPORT ONLY, typed errors, secrets read
 * at request time, safe error text. It holds no supabase client, writes no ledger and never
 * decides whether an email SHOULD be sent; emailSend.ts owns outcomes and the email_sends rows,
 * and mailTransport.ts picks which of the two leaves a send goes through.
 *
 * ZERO IMPORTS, like resend.ts. The AWS SDK is not used: the request signing (SigV4) is ~80
 * lines of Web Crypto below, and the edge runtime has no SMTP ports, so everything is the SES
 * v2 JSON API over HTTPS. A leaf with no imports is what lets the pre-push gate test it offline
 * with a stubbed fetch (ses.test.ts), the same rule as resend.ts and twilioSms.ts.
 *
 * SES facts callers must not have to re-learn:
 *   - TWO secrets, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY, for one IAM user that may send,
 *     manage identities and read the inbound bucket. Region, configuration set and bucket are
 *     plain settings (SES_REGION, SES_CONFIGURATION_SET, SES_INBOUND_BUCKET). The bucket name
 *     carries the AWS account number, so it lives in a setting and never in this public source.
 *   - SES REPLACES THE Message-ID. Whatever we send, the delivered email carries
 *     `<{MessageId}@{region}.amazonses.com>`, where MessageId is exactly what SendEmail returns
 *     (read off a real message, 2026-11-10). SES also REFUSES `Message-ID` as a custom header,
 *     with a 400 that would fail the whole send, so sesHeaders drops it. A reply is threaded by
 *     matching its In-Reply-To against the id we stored (see email-inbound).
 *   - NO IDEMPOTENCY KEY. Resend's Idempotency-Key has no SES equivalent: a second SendEmail is a
 *     second email. A caller that retries must decide for itself whether the first try went
 *     (emailSend.ts does, from the ledger).
 *   - A domain identity verifies through DKIM alone. With "bring your own DKIM" that is ONE TXT
 *     record (we make the key pair, SES keeps the private half); with Easy DKIM it is three
 *     CNAMEs. SES re-checks DNS by itself, so there is no "verify now" call: reading the identity
 *     IS the check, and a read never parks the status the way Resend's verify POST did.
 *   - An identity covers its subdomains, for sending and for receiving. The reply address
 *     (reply.<domain>) therefore needs only an MX record, no identity of its own.
 *   - A display name in From must be 7-bit. SES rejects raw UTF-8 there, so encodeFrom turns a
 *     non-ASCII business name into RFC 2047 encoded-words.
 *   - A suppressed address is ACCEPTED and then not delivered: SendEmail returns an id and the
 *     event feed reports a bounce with subtype OnAccountSuppressionList (postmark-events).
 *
 * THE VERDICT RULE (inherited from resend.ts): every failure says whether a retry is pointless.
 * `permanent` is claimed only on positive evidence that an identical request fails identically:
 * a 400 BadRequestException (the request is malformed), a 404 NotFoundException, a 409
 * AlreadyExistsException. Everything else stays retryable, including the ones a person fixes
 * within hours and a retrying caller should wait out: a 403 (the key or its policy), a paused or
 * suspended account, a throttle, MessageRejected (which covers "this identity is not verified",
 * true for an afternoon when a builder's DNS is moved), any 5xx, a timeout.
 *
 * Error bodies are never surfaced. SES's `message` names recipient addresses ("Email address is
 * not verified. The following identities failed the check: jane@…"), and a customer's address
 * must not land in app_errors or on a builder's screen. Only the HTTP status and the exception
 * NAME survive, and the name only when it is plain letters and digits.
 */

/** How long one SES call may take before we stop waiting. A hang bound, not a slow bound: see
 *  resend.ts RS_TIMEOUT_MS for why it sits far past any slow answer. A timed-out send MAY HAVE
 *  BEEN SENT. */
export const SES_TIMEOUT_MS = 30_000;

/** Reading one received email from the bucket. Short, because the function that calls it must
 *  answer Amazon SNS inside 15 seconds or the notice is delivered again. */
export const SES_S3_TIMEOUT_MS = 8_000;

/** The most of one received email we read. Text comes first in a message and attachments last,
 *  so a cut-off email still yields the words; the edge function's memory is the reason to cap. */
export const SES_INBOUND_MAX_BYTES = 10 * 1024 * 1024;

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ── Settings (request-time reads, never module-top: the Deposyt lesson in resend.ts) ─────────

type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken: string | null };

function creds(): Creds | null {
  const accessKeyId = (Deno.env.get("SES_ACCESS_KEY_ID") ?? "").trim();
  const secretAccessKey = (Deno.env.get("SES_SECRET_ACCESS_KEY") ?? "").trim();
  if (!accessKeyId || !secretAccessKey) return null;
  // Only for running this module by hand with short-lived sign-in credentials. The deployed
  // key is a plain IAM user key and has no token.
  const sessionToken = (Deno.env.get("SES_SESSION_TOKEN") ?? "").trim() || null;
  return { accessKeyId, secretAccessKey, sessionToken };
}

/** us-east-2 is where the account's production access, receiving rule set and bucket live. */
export function sesRegion(): string {
  const r = (Deno.env.get("SES_REGION") ?? "").trim().toLowerCase();
  return /^[a-z]{2}(-[a-z]+)+-\d$/.test(r) ? r : "us-east-2";
}

/** The configuration set every send goes through: it is what publishes bounce, complaint and
 *  delivery events, so a send outside it is a send whose fate is never reported. */
function configurationSet(): string {
  const c = (Deno.env.get("SES_CONFIGURATION_SET") ?? "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(c) ? c : "ss-default";
}

/** The ONE test for "may the SES path run at all": both halves of the key. */
export function sesConfigured(): boolean {
  return creds() !== null;
}

/** Whether received mail can be read: the key AND the bucket's name. */
export function sesInboundConfigured(): boolean {
  return creds() !== null && inboundBucket() !== null;
}

function inboundBucket(): string | null {
  const b = (Deno.env.get("SES_INBOUND_BUCKET") ?? "").trim();
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b) ? b : null;
}

function inboundPrefix(): string {
  const p = (Deno.env.get("SES_INBOUND_PREFIX") ?? "").trim();
  return /^[A-Za-z0-9_-]+\/$/.test(p) ? p : "inbound/";
}

export class SesNotConfigured extends Error {
  constructor(msg = "Amazon SES is not configured on this deployment.") {
    super(msg);
    this.name = "SesNotConfigured";
  }
}

/**
 * An SES (or S3) call that answered non-OK, or could not be reached at all. Same fields as
 * ResendApiError so mailTransport.ts can treat the two alike: `status` is 0 when no HTTP answer
 * arrived, `name_` is AWS's exception name ("BadRequestException", "NoSuchKey", …) or "" when
 * none could be trusted, or our own "timeout".
 */
export class SesApiError extends Error {
  readonly status: number;
  readonly name_: string;
  readonly permanent: boolean;
  constructor(init: { message: string; status: number; name_: string; permanent: boolean }) {
    super(init.message);
    this.name = "SesApiError";
    this.status = init.status;
    this.name_ = init.name_;
    this.permanent = init.permanent;
  }
}

/** Positive evidence that an identical retry fails identically. See the header for what is
 *  deliberately left retryable. */
function verdictOf(status: number, name_: string): boolean {
  if (status === 400 && name_ === "BadRequestException") return true;
  if (status === 404 && (name_ === "NotFoundException" || name_ === "NoSuchKey")) return true;
  if (status === 409 && name_ === "AlreadyExistsException") return true;
  return false;
}

/**
 * AWS's exception NAME, and nothing else from the answer. The JSON API puts it in the
 * `x-amzn-errortype` header ("BadRequestException:http://…"), sometimes in a `__type` body field
 * ("com.amazonaws.ses#MessageRejected"); S3 answers XML with a `<Code>`. The charset gate is
 * what makes it safe to surface: letters and digits cannot spell an email address.
 */
function errorNameOf(res: Response, body: string): string {
  const gate = (s: string): string => (/^[A-Za-z0-9]{1,64}$/.test(s) ? s : "");
  const header = (res.headers.get("x-amzn-errortype") ?? "").split(":")[0].trim();
  if (gate(header)) return header;
  try {
    const t = (JSON.parse(body) as { __type?: unknown })?.__type;
    if (typeof t === "string") {
      const tail = t.split("#").pop() ?? "";
      if (gate(tail)) return tail;
    }
  } catch { /* not JSON: try the XML shape */ }
  const code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(body)?.[1] ?? "";
  return gate(code);
}

// ── SigV4 ────────────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function hex(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ is percent-encoded.
 *  encodeURIComponent leaves ! ' ( ) * alone, so those are finished by hand. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export type SigV4Input = {
  method: string;
  host: string;
  /** The path as RAW segments joined by "/", e.g. "/v2/email/identities/example.com". Each
   *  segment is encoded here; never pass one that is already percent-encoded. */
  path: string;
  query?: Record<string, string>;
  /** Extra headers to send AND sign (content-type, x-amz-content-sha256, …). Names in any case. */
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
  now?: Date;
  /** S3 signs the path as sent; every other service signs it encoded a second time. */
  s3?: boolean;
};

/**
 * Sign one request (AWS Signature Version 4). Returns the URL to fetch and the headers to send
 * with it, Authorization included. Pure apart from Web Crypto, and exported so ses.test.ts can
 * hold it against AWS's own published test vectors.
 */
export async function signV4(input: SigV4Input): Promise<{ url: string; headers: Record<string, string> }> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20260101T000000Z
  const dateStamp = amzDate.slice(0, 8);

  const segments = input.path.split("/").map((s) => uriEncode(s));
  const urlPath = segments.join("/") || "/";
  const canonicalPath = input.s3 ? urlPath : (segments.map((s) => uriEncode(s)).join("/") || "/");

  const queryPairs = Object.entries(input.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");

  const send: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) send[k.toLowerCase()] = String(v);
  send["x-amz-date"] = amzDate;
  if (input.sessionToken) send["x-amz-security-token"] = input.sessionToken;

  // Host is signed but never SENT by us: fetch sets it from the URL, and it must match.
  const signed: Record<string, string> = { ...send, host: input.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");

  const payloadHash = send["x-amz-content-sha256"] ?? await sha256Hex(input.body ?? "");
  const canonicalRequest = [
    input.method.toUpperCase(), canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key: ArrayBuffer = await hmac(enc.encode("AWS4" + input.secretAccessKey), dateStamp);
  key = await hmac(key, input.region);
  key = await hmac(key, input.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  send["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${input.host}${urlPath}${canonicalQuery ? `?${canonicalQuery}` : ""}`, headers: send };
}

// ── One round trip ───────────────────────────────────────────────────────────────────────────

function requireCreds(): Creds {
  const c = creds();
  if (!c) throw new SesNotConfigured("SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY are not set.");
  return c;
}

/** A failure to reach AWS at all, or a timeout. Nothing about the REQUEST has been judged, so
 *  permanence is never claimed. The message carries our own words and the runtime's network
 *  error text, never provider or customer data. */
function unreachable(what: string, e: unknown, timeoutMs: number): SesApiError {
  const timedOut = (e as Error)?.name === "TimeoutError";
  return new SesApiError({
    message: timedOut
      ? `${what} did not answer within ${Math.round(timeoutMs / 1000)} s`
      : `Could not reach ${what}: ${(e as Error)?.message ?? e}`,
    status: 0,
    name_: timedOut ? "timeout" : "",
    permanent: false,
  });
}

/** One signed call to the SES v2 JSON API. Failures throw SesApiError with the verdict attached;
 *  successes return the parsed JSON (null when the body is empty or unparsable). */
async function sesFetch(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = SES_TIMEOUT_MS,
): Promise<unknown> {
  const c = requireCreds();
  const region = sesRegion();
  const payload = body === undefined ? "" : JSON.stringify(body);
  const { url, headers } = await signV4({
    method,
    host: `email.${region}.amazonaws.com`,
    path,
    headers: payload ? { "content-type": "application/json" } : {},
    body: payload,
    service: "ses",
    region,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
  });

  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method,
      headers: { ...headers, accept: "application/json" },
      ...(payload ? { body: payload } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw unreachable("Amazon SES", e, timeoutMs);
  }

  if (!res.ok) {
    const name_ = errorNameOf(res, text);
    throw new SesApiError({
      // The path is ours and names a domain at most, never a person.
      message: `SES API ${res.status} on ${method} ${path}` + (name_ ? ` (${name_})` : ""),
      status: res.status,
      name_,
      permanent: verdictOf(res.status, name_),
    });
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────

/** One outgoing email. The same field names as RsSendInput, so mailTransport.ts hands either
 *  leaf the same object. `idempotencyKey` is absent on purpose: SES has nothing to give it to. */
export type SesSendInput = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string | string[];
  tags?: { name: string; value: string }[];
  /** `content` is BASE64 of the file's bytes, exactly as resend.ts takes it. */
  attachments?: { filename: string; content: string; contentType?: string }[];
  /** Custom headers (the List-Unsubscribe pair). `Message-ID` and the others SES refuses are
   *  dropped: see sesHeaders. */
  headers?: Record<string, string>;
};

/** Header names SES refuses as custom headers on a Simple message (its developer guide's list,
 *  read 2026-11-10). One of these in the request fails the WHOLE send with a 400. */
const REFUSED_HEADERS = new Set([
  "bcc", "cc", "content-disposition", "content-type", "date", "from", "message-id",
  "mime-version", "reply-to", "return-path", "subject", "to",
]);
const MAX_HEADERS = 15;

/**
 * The custom headers as SES will accept them: refused names out, and any header SES's own
 * pattern would reject (a name with a colon or a space, a value that is not printable ASCII or is
 * over 995 characters) out too. Dropping one costs that header; sending it costs the email.
 * Exported for the tests.
 */
export function sesHeaders(h: Record<string, string> | undefined): { Name: string; Value: string }[] {
  const out: { Name: string; Value: string }[] = [];
  for (const [name, raw] of Object.entries(h ?? {})) {
    const value = typeof raw === "string" ? raw : "";
    if (REFUSED_HEADERS.has(name.toLowerCase())) continue;
    if (!/^[!-9;-~]{1,126}$/.test(name)) continue;
    if (!value || value.length > 995 || name.length + value.length > 996 || !/^[ -~]*$/.test(value)) continue;
    out.push({ Name: name, Value: value });
    if (out.length === MAX_HEADERS) break;
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * The From header as SES accepts it. An all-ASCII value goes through untouched. A display name
 * with anything else in it ("Café Sheds" <info@…>) is re-written as RFC 2047 encoded-words,
 * because SES rejects raw UTF-8 in a display name and Resend never did. Words are cut on whole
 * characters and kept under the 75-character limit. Exported for the tests.
 */
export function encodeFrom(from: string): string {
  const s = String(from ?? "");
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^>]+)>\s*$/.exec(s);
  if (!m) return s;
  const name = (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? "")).trim();
  const addr = m[3].trim();
  if (!name) return addr;
  const words: string[] = [];
  let chunk: number[] = [];
  for (const ch of name) {
    const bytes = enc.encode(ch);
    // 45 bytes is 60 base64 characters, plus the 12 of "=?UTF-8?B?" and "?=": under 75.
    if (chunk.length + bytes.length > 45) {
      words.push(`=?UTF-8?B?${b64(new Uint8Array(chunk))}?=`);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(`=?UTF-8?B?${b64(new Uint8Array(chunk))}?=`);
  return `${words.join(" ")} <${addr}>`;
}

/** SES tag names and values take ASCII letters, digits, underscore and dash only, and a value
 *  may not be empty. A dotted slug degrades the TAG rather than failing the send (resend.ts's
 *  sanitizeTag rule). */
function sesTag(s: string): string {
  return String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 256);
}

function replyToList(v: string | string[] | undefined): string[] {
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
  return list.filter((a): a is string => typeof a === "string").map((a) => a.trim()).filter(Boolean);
}

/**
 * Send one email. Returns SES's MessageId: persist it on the email_sends row IMMEDIATELY. It is
 * what the delivery and bounce events name, AND it is the delivered email's Message-ID (with
 * `@{region}.amazonses.com` after it), so it is also how a reply finds its way back.
 *
 * ONE TRY, ALWAYS, like rsSendEmail. And unlike Resend there is no key that makes a second try
 * safe, so a caller that retries after a timeout must first find out whether this one went.
 *
 * `opts` is for tests (a short timeout) and nothing else.
 */
export async function sesSendEmail(
  input: SesSendInput,
  opts: { timeoutMs?: number } = {},
): Promise<{ id: string }> {
  const replyTo = replyToList(input.replyTo);
  const headers = sesHeaders(input.headers);
  const tags = (input.tags ?? [])
    .map((t) => ({ Name: sesTag(t.name), Value: sesTag(t.value) }))
    .filter((t) => t.Name && t.Value);
  const attachments = (input.attachments ?? []).map((a) => ({
    RawContent: a.content,
    FileName: String(a.filename ?? "").slice(0, 255),
    ...(a.contentType && a.contentType.length <= 78 ? { ContentType: a.contentType } : {}),
    ContentDisposition: "ATTACHMENT",
    ContentTransferEncoding: "BASE64",
  }));
  const raw = await sesFetch("POST", "/v2/email/outbound-emails", {
    FromEmailAddress: encodeFrom(input.from),
    Destination: { ToAddresses: [input.to] },
    ...(replyTo.length ? { ReplyToAddresses: replyTo } : {}),
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: input.html, Charset: "UTF-8" },
          ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}),
        },
        ...(headers.length ? { Headers: headers } : {}),
        ...(attachments.length ? { Attachments: attachments } : {}),
      },
    },
    ConfigurationSetName: configurationSet(),
    ...(tags.length ? { EmailTags: tags } : {}),
  }, opts.timeoutMs ?? SES_TIMEOUT_MS);
  const id = (raw as { MessageId?: unknown } | null)?.MessageId;
  return { id: typeof id === "string" ? id : "" };
}

/** The local part SES puts in a delivered email's Message-ID is the id sesSendEmail returned.
 *  Given an id from a reply's In-Reply-To or References (`<…@us-east-2.amazonses.com>`, angle
 *  brackets or not), this hands back that id, or null when the host is not an SES one. us-east-1
 *  spells its host `email.amazonses.com`; every other region uses its own name. */
export function sesMessageIdOf(rfcMessageId: unknown): string | null {
  const s = String(rfcMessageId ?? "").trim().replace(/^<|>$/g, "");
  const at = s.lastIndexOf("@");
  if (at <= 0) return null;
  const local = s.slice(0, at);
  const host = s.slice(at + 1).toLowerCase();
  if (!/^([a-z0-9-]+\.)?amazonses\.com$/.test(host)) return null;
  return /^[A-Za-z0-9-]{16,128}$/.test(local) ? local : null;
}

// ── Identities (a builder's sending domain) ──────────────────────────────────────────────────

/** One domain identity, normalized. `verified` is AWS's own "may this identity send". The
 *  status strings are AWS's: PENDING | SUCCESS | FAILED | TEMPORARY_FAILURE | NOT_STARTED. */
export type SesIdentity = {
  name: string;
  verified: boolean;
  verificationStatus: string;
  dkim: {
    status: string;
    /** "EXTERNAL" for bring-your-own DKIM, "AWS_SES" for Easy DKIM. */
    origin: string;
    /** Easy DKIM: three tokens. Bring-your-own: the one selector. */
    tokens: string[];
  };
  /** Present only once a custom MAIL FROM was asked for. */
  mailFrom: { domain: string; status: string } | null;
  /** Whether AWS emails bounce notices to the From address. null when the answer did not say. */
  feedbackForwarding: boolean | null;
};

function toIdentity(name: string, raw: unknown): SesIdentity {
  const d = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const dk = (d.DkimAttributes ?? {}) as Record<string, unknown>;
  const mf = (d.MailFromAttributes ?? null) as Record<string, unknown> | null;
  const mfDomain = mf ? str(mf.MailFromDomain) : "";
  return {
    name,
    verified: d.VerifiedForSendingStatus === true,
    verificationStatus: str(d.VerificationStatus),
    dkim: {
      status: str(dk.Status),
      origin: str(dk.SigningAttributesOrigin),
      tokens: Array.isArray(dk.Tokens) ? dk.Tokens.map((t) => str(t)).filter(Boolean) : [],
    },
    mailFrom: mfDomain ? { domain: mfDomain, status: str(mf?.MailFromDomainStatus) } : null,
    feedbackForwarding: typeof d.FeedbackForwardingStatus === "boolean" ? d.FeedbackForwardingStatus : null,
  };
}

/** The ONE meaning of "this domain may send": AWS says so, and its DKIM check has passed.
 *  Everything else, including a domain that passed once and is now TEMPORARY_FAILURE, is
 *  not-yet or no-longer. */
export function sesIdentityVerified(i: SesIdentity): boolean {
  return i.verified && i.dkim.status === "SUCCESS";
}

/** AWS has stopped looking (it gives up after 72 hours without the record), or a domain that
 *  passed has failed a re-check. The builder has to act; waiting will not fix it. */
export function sesIdentityGivenUp(i: SesIdentity): "failed" | "temporary_failure" | null {
  if (i.dkim.status === "FAILED") return "failed";
  if (i.dkim.status === "TEMPORARY_FAILURE") return "temporary_failure";
  return null;
}

/** A DKIM key pair for "bring your own DKIM". `privateKey` is what SES takes (base64 PKCS #8,
 *  no PEM header lines); `publicKey` is what goes after `p=` in the builder's TXT record.
 *
 *  1024 bits on purpose: its public half is 216 base64 characters, so the whole TXT value fits
 *  the single 255-character string every DNS panel accepts, the same size Resend handed out. A
 *  2048-bit value is 394 characters and has to be split in two, which is where a web person's
 *  DNS panel refuses it. SES accepts either; change the argument, nothing else. */
export async function sesGenerateDkimKey(bits: 1024 | 2048 = 1024): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: b64(priv), publicKey: b64(pub) };
}

/**
 * Create a domain identity.
 *
 * With `dkim` (a selector and the private key from sesGenerateDkimKey) the identity uses
 * bring-your-own DKIM: ONE TXT record for the builder. Without it SES makes its own keys (Easy
 * DKIM, 2048-bit) and the builder publishes THREE CNAMEs; that path is kept so the choice is a
 * caller's argument and not a rewrite.
 *
 * ⚠️ The private key is sent to AWS once, here, and must not be stored or logged by the caller.
 * AWS keeps it; nobody can read it back, including us.
 *
 * An identity that already exists answers 409 AlreadyExistsException (permanent). The caller
 * decides what that means: for a domain this builder already holds, delete and create again.
 */
export async function sesCreateIdentity(
  domain: string,
  dkim?: { selector: string; privateKey: string },
): Promise<SesIdentity> {
  const raw = await sesFetch("POST", "/v2/email/identities", {
    EmailIdentity: domain,
    DkimSigningAttributes: dkim
      ? { DomainSigningSelector: dkim.selector, DomainSigningPrivateKey: dkim.privateKey }
      : { NextSigningKeyLength: "RSA_2048_BIT" },
  });
  return toIdentity(domain, raw);
}

/** Read one identity: its verification state, DKIM state and tokens. This IS the check. */
export async function sesGetIdentity(domain: string): Promise<SesIdentity> {
  return toIdentity(domain, await sesFetch("GET", `/v2/email/identities/${domain}`));
}

/** Remove an identity (the disconnect path, and a builder's deletion). */
export async function sesDeleteIdentity(domain: string): Promise<void> {
  await sesFetch("DELETE", `/v2/email/identities/${domain}`);
}

/**
 * Stop AWS emailing bounce and complaint notices to the identity's From address.
 *
 * They are Amazon-branded "Delivery Status Notification" emails, on by default for every new
 * identity, and they would land in a builder's own inbox. Bounces reach us through the
 * configuration set's event feed instead (postmark-events), which is what AWS requires before it
 * honours this switch.
 */
export async function sesDisableFeedbackForwarding(domain: string): Promise<void> {
  await sesFetch("PUT", `/v2/email/identities/${domain}/feedback`, { EmailForwardingEnabled: false });
}

/** One DNS record a builder must hold, in the shape the Email screen's table already draws
 *  (portal-settings' DnsRow). `host` is always the absolute name. */
export type SesDnsRecord = {
  purpose: "DKIM" | "Receiving";
  type: string;
  host: string;
  value: string;
  verified: boolean;
  priority?: number;
};

/**
 * The DKIM record(s) for an identity.
 *
 * Bring-your-own DKIM: one TXT at `<selector>._domainkey.<domain>` holding `p=<public key>`.
 * `publicKey` must be the one made with the private key SES was given; AWS never returns it, so
 * the caller keeps it (it is public, and it is in the builder's DNS anyway).
 * Easy DKIM: one CNAME per token, pointing at AWS.
 */
export function sesDkimRecords(i: SesIdentity, byo?: { selector: string; publicKey: string }): SesDnsRecord[] {
  const verified = i.dkim.status === "SUCCESS";
  if (byo) {
    return [{
      purpose: "DKIM",
      type: "TXT",
      host: `${byo.selector}._domainkey.${i.name}`,
      value: `p=${byo.publicKey}`,
      verified,
    }];
  }
  return i.dkim.tokens.map((t) => ({
    purpose: "DKIM" as const,
    type: "CNAME",
    host: `${t}._domainkey.${i.name}`,
    value: `${t}.dkim.amazonses.com`,
    verified,
  }));
}

/** Where a domain's MX must point for SES to receive its mail. AWS documents the name as
 *  `inbound-smtp.<region>.amazonaws.com`; unlike Resend there is no API that returns it. */
export function sesInboundMxHost(region = sesRegion()): string {
  return `inbound-smtp.${region}.amazonaws.com`;
}

/** The one record that makes `inboundDomain` (reply.<sending domain>) receive mail. */
export function sesInboundRecord(inboundDomain: string, verified: boolean): SesDnsRecord {
  return { purpose: "Receiving", type: "MX", host: inboundDomain, value: sesInboundMxHost(), verified, priority: 10 };
}

// ── Reading a received email ─────────────────────────────────────────────────────────────────

/**
 * The raw bytes of one received email, from the bucket the receiving rule stores them in.
 *
 * `objectKey` comes from an SNS notice, so it is checked before it is used: it must be the
 * configured prefix followed by ONE plain name (letters, digits, dash, underscore), which is the
 * shape SES writes. No slash after the prefix and no dot, so `..` cannot walk out of the folder
 * and a notice can never point this at another object. The BUCKET is never taken from the
 * notice at all.
 *
 * At most `maxBytes` are read (a Range request); `truncated` says the email was longer. A 404
 * (NoSuchKey: the object expired, or never arrived) is permanent; anything else is worth another
 * try, and the caller answers SNS so that it gets one.
 */
export async function sesGetInboundObject(
  objectKey: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const c = requireCreds();
  const bucket = inboundBucket();
  if (!bucket) throw new SesNotConfigured("SES_INBOUND_BUCKET is not set.");
  const prefix = inboundPrefix();
  const key = String(objectKey ?? "");
  if (!key.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,200}$/.test(key.slice(prefix.length))) {
    throw new SesApiError({ message: "refused an inbound object key of the wrong shape", status: 0, name_: "bad_key", permanent: true });
  }
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? SES_INBOUND_MAX_BYTES));
  const timeoutMs = opts.timeoutMs ?? SES_S3_TIMEOUT_MS;
  const region = sesRegion();
  const { url, headers } = await signV4({
    method: "GET",
    host: `${bucket}.s3.${region}.amazonaws.com`,
    path: `/${key}`,
    headers: { "x-amz-content-sha256": EMPTY_SHA256, range: `bytes=0-${maxBytes - 1}` },
    service: "s3",
    region,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
    s3: true,
  });

  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const text = await res.text();
      const name_ = errorNameOf(res, text);
      throw new SesApiError({
        message: `S3 ${res.status} reading a received email` + (name_ ? ` (${name_})` : ""),
        status: res.status,
        name_,
        permanent: verdictOf(res.status, name_),
      });
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof SesApiError) throw e;
    throw unreachable("the inbound mail bucket", e, timeoutMs);
  }
  // A 206 names the whole size after the slash ("bytes 0-99/5290"); a 200 is the whole object.
  const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? NaN);
  return { bytes, truncated: Number.isFinite(total) ? total > bytes.length : false };
}
