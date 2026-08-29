/**
 * Twilio Messaging transport: send one SMS, and validate an inbound webhook's signature
 * (Programmable Messaging REST API, https://api.twilio.com/2010-04-01).
 *
 * Same architecture as twilioVerify.ts, and deliberately a SEPARATE file rather than more
 * exports on that one: Verify is the login path and must keep working if messaging is
 * misconfigured, unregistered, or switched off. A leaf module with zero imports is also
 * what lets the preflight gate unit-test it offline with a stubbed fetch.
 *
 * THE RULE THIS FILE ENFORCES, as in twilioVerify: every failure carries a verdict — is a
 * retry pointless? `permanent` is claimed only on positive evidence, because a
 * wrongly-permanent verdict strands a message that would have gone through, and that is
 * the more expensive mistake.
 *
 * ⚠️ NO ERROR MESSAGE FROM TWILIO IS EVER PROPAGATED. Their body echoes the `To` number
 * back, and these errors are logged and shown in a browser. Only the numeric code travels.
 */

const API_BASE = "https://api.twilio.com/2010-04-01";

/** Read at REQUEST time, never at module top: a module-top read needs a redeploy to pick
 *  up a rotated secret, which cost us a debugging session on Deposyt. */
function accountSid(): string | null {
  return Deno.env.get("TWILIO_ACCOUNT_SID") || null;
}
function authToken(): string | null {
  return Deno.env.get("TWILIO_AUTH_TOKEN") || null;
}
function apiKey(): string | null {
  return Deno.env.get("TWILIO_API_KEY") || null;
}
function apiSecret(): string | null {
  return Deno.env.get("TWILIO_API_SECRET") || null;
}
/** ⚠️ REMOVED, deliberately: there is no platform-wide Messaging Service any more.
 *  Under the ISV model each BUILDER has their own service (their own A2P campaign), so the
 *  SID is a per-tenant column (sms_registrations.messaging_service_sid), never an env var.
 *  A platform default here would silently send one builder's text under another builder's
 *  carrier registration — which is the exact campaign-sharing carriers prohibit. */

/** Basic auth as EITHER ApiKeySid:ApiKeySecret or AccountSid:AuthToken — the key pair
 *  wins. This deployment's TWILIO_AUTH_TOKEN landed as an EMPTY STRING on 2026-08-11
 *  because the operator's shell only had the key pair, so auth-token auth must never be
 *  the only door. (Signature validation below is the one place the token is required and
 *  cannot be substituted — see validateTwilioSignature.) */
function basicAuthPair(): { user: string; pass: string } | null {
  const key = apiKey();
  const secret = apiSecret();
  if (key && secret) return { user: key, pass: secret };
  const sid = accountSid();
  const token = authToken();
  if (sid && token) return { user: sid, pass: token };
  return null;
}

/** Credentials only — "does this DEPLOYMENT have Twilio at all".
 *
 *  ⚠️ This deliberately no longer asks about a Messaging Service. It used to, and that
 *  coupling was the shared-campaign model: one platform service, every tenant on it. Under
 *  the ISV model the service is the BUILDER'S, so "is this tenant able to send" is a
 *  different question with a different answer per tenant, and it is asked in smsSend.ts
 *  against sms_registrations. Keeping both questions in one boolean is how a tenant with no
 *  registration would inherit the platform's.
 *
 *  The account SID is needed separately because it is in the request PATH, not just the
 *  auth header, and an API-key pair does not carry it. */
export function smsCredentialsConfigured(): boolean {
  return basicAuthPair() !== null && !!accountSid();
}

export class SmsNotConfigured extends Error {
  constructor(msg = "Twilio Messaging is not configured on this deployment.") {
    super(msg);
    this.name = "SmsNotConfigured";
  }
}

export class SmsApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly permanent: boolean;
  constructor(init: { message: string; status: number; code: number; permanent: boolean }) {
    super(init.message);
    this.name = "SmsApiError";
    this.status = init.status;
    this.code = init.code;
    this.permanent = init.permanent;
  }
}

/**
 * Codes where an identical retry fails identically:
 *   21211  invalid `To` number
 *   21610  the recipient replied STOP — sending again is a compliance violation, not a retry
 *   21408  no permission to send to that region
 *   21606  the `From` number cannot send messages (wrong number, or not on the service)
 *   21612  unreachable carrier route
 *   30034  the number is not registered to an A2P campaign — every US send fails until it is
 */
const PERMANENT_CODES = new Set([21211, 21610, 21408, 21606, 21612, 30034]);

/** Pull ONLY the enum-ish `code` out of a Twilio error body. `message` is never read — it
 *  echoes the phone number. */
function codeOf(body: string): number {
  try {
    const code = (JSON.parse(body) as { code?: unknown })?.code;
    return typeof code === "number" && Number.isFinite(code) ? code : 0;
  } catch {
    return 0;
  }
}

export type SmsSendResult = { sid: string; segments: number; status: string };

/**
 * Send one message.
 *
 * BOTH `MessagingServiceSid` AND `From` are sent. The service supplies THAT BUILDER'S A2P
 * campaign registration, the opt-out handling and the status-callback URL; the explicit
 * `From` overrides the service's sender pool so the customer sees THEIR builder's number
 * rather than whichever number the pool would have picked. Sending only the service SID
 * would make the number non-deterministic, and inbound attribution depends on it being the
 * tenant's own — see migration 148.
 */
export async function sendSms(opts: {
  to: string;                  // E.164
  from: string;                // E.164, the tenant's own number
  /** ⚠️ THE TENANT'S OWN Messaging Service (MG...), passed in — never read from the
   *  environment. This is what binds the message to THAT BUILDER'S A2P campaign. */
  messagingServiceSid: string;
  body: string;
  statusCallback?: string | null;
}): Promise<SmsSendResult> {
  const pair = basicAuthPair();
  const svc = opts.messagingServiceSid;
  const acct = accountSid();
  if (!pair || !svc || !acct) {
    const missing = [
      pair ? null : "TWILIO_API_KEY+TWILIO_API_SECRET (or TWILIO_ACCOUNT_SID+TWILIO_AUTH_TOKEN)",
      svc ? null : "the tenant's messaging_service_sid",
      acct ? null : "TWILIO_ACCOUNT_SID",
    ].filter((n): n is string => n !== null).join(", ");
    throw new SmsNotConfigured(`${missing} is not set.`);
  }

  const form: Record<string, string> = {
    To: opts.to,
    From: opts.from,
    MessagingServiceSid: svc,
    Body: opts.body,
  };
  if (opts.statusCallback) form.StatusCallback = opts.statusCallback;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/Accounts/${acct}/Messages.json`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${pair.user}:${pair.pass}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (e) {
    // Never reached Twilio, so nothing about the request has been judged and permanence
    // cannot be claimed.
    throw new SmsApiError({
      message: `Could not reach Twilio Messaging: ${(e as Error).message}`,
      status: 0,
      code: 0,
      permanent: false,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    const code = codeOf(text);
    throw new SmsApiError({
      message: `Twilio Messaging refused the send (HTTP ${res.status}, code ${code}).`,
      status: res.status,
      code,
      permanent: PERMANENT_CODES.has(code),
    });
  }

  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(text) as Record<string, unknown>; } catch { /* success with an
    unparsable body: the message is away, and inventing a failure here would double-send on
    the retry. Fall through with empty fields. */ }
  const segs = Number(raw.num_segments);
  return {
    sid: typeof raw.sid === "string" ? raw.sid : "",
    segments: Number.isFinite(segs) && segs > 0 ? segs : 1,
    status: typeof raw.status === "string" ? raw.status : "queued",
  };
}

/**
 * Validate an inbound webhook's `X-Twilio-Signature`.
 *
 * Twilio's scheme: HMAC-SHA1, base64, over the exact configured URL with every POST
 * parameter appended as key then value, sorted by key.
 *
 * ⚠️ THE AUTH TOKEN IS THE ONLY KEY THAT WORKS HERE. Twilio signs with the account's auth
 * token; an API key/secret pair cannot validate a signature. On this deployment
 * TWILIO_AUTH_TOKEN is currently an empty string, which is why the caller must treat "no
 * token" as a distinct state (see hasSignatureKey) rather than as a failed check — failing
 * closed with no token would silently drop every customer's reply, and failing open
 * without saying so would be worse.
 *
 * ⚠️ REBUILD THE URL, DO NOT TRUST req.url. The Supabase gateway rewrites the incoming
 * URL, and the signature was computed over the URL configured in the Twilio console. A
 * mismatch there fails every message with a perfectly valid signature.
 */
export function hasSignatureKey(): boolean {
  return !!authToken();
}

export async function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  const token = authToken();
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // Constant-time-ish compare: same length check first, then accumulate differences rather
  // than returning early, so the comparison does not leak the matching prefix length.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/**
 * Digits → E.164, US-only. Twin of toE164US in twilioVerify.ts, duplicated deliberately:
 * these are leaf transports with no shared imports, and importing one into the other would
 * couple the login path to the messaging path.
 */
export function smsE164US(digits: string): string | null {
  if (/^\d{10}$/.test(digits)) return "+1" + digits;
  if (/^1\d{10}$/.test(digits)) return "+" + digits;
  return null;
}

/**
 * The 10-digit NANP key, matching public.crm_phone_key in SQL (migration 132).
 *
 * ⚠️ A 10-DIGIT KEY BEGINNING WITH 1 IS NOT A REAL NUMBER and is returned as-is so the
 * caller can refuse it. No NANP area code starts with 1 — that shape is the fingerprint of
 * the phone formatter that truncated `+1` numbers to ten digits and destroyed the last
 * one, fixed 2026-08-25. Texting it would burn a Twilio 21211 and, worse, would look to
 * the builder like the customer's number simply does not work.
 */
export function smsPhoneKey(raw: string): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

export function isDamagedPhoneKey(key: string): boolean {
  return key.length === 10 && key.startsWith("1");
}

/** GSM-7 vs UCS-2 segment maths, for the composer's counter and for sanity-checking what
 *  Twilio bills. Any character outside the GSM-7 alphabet (a curly quote, an emoji) forces
 *  the whole message to UCS-2 and roughly halves the per-segment budget — which is why one
 *  pasted apostrophe can turn a one-segment message into two. */
const GSM7 = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\r\n\f\[\]{}\\~^|€]*$/;

export function smsSegments(body: string): { chars: number; segments: number; unicode: boolean } {
  const unicode = !GSM7.test(body);
  const per = unicode ? 70 : 160;
  const perConcat = unicode ? 67 : 153;
  const chars = body.length;
  if (chars === 0) return { chars: 0, segments: 0, unicode };
  const segments = chars <= per ? 1 : Math.ceil(chars / perConcat);
  return { chars, segments, unicode };
}
