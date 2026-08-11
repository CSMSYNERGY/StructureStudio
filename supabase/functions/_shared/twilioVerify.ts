/**
 * Twilio Verify transport: SMS one-time-code start + check (Verify v2 REST API,
 * https://verify.twilio.com/v2).
 *
 * This is the postmark.ts architecture applied to phone verification: this file is
 * TRANSPORT ONLY — typed errors, request-time secrets, safe error surfaces. It holds no
 * supabase client, writes no tables, and never decides whether a phone SHOULD be verified;
 * callers own outcomes. Keeping the transport a leaf module with zero imports is also what
 * lets the preflight gate unit-test it offline with a stubbed fetch (see
 * twilioVerify.test.ts).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: every failure carries a verdict — is a retry
 * pointless? A Twilio 60200 (invalid `To` parameter — the number is malformed or
 * unreachable) fails identically forever; offering a Retry for it is the same dead end the
 * QuickBooks disconnect-tombstone bug produced on 2026-08-03. A 429 or a 5xx is the
 * opposite: retrying IS the correct response. `permanent` is claimed only on positive
 * evidence (the known codes below); anything ambiguous stays retryable, because a
 * wrongly-permanent verdict strands a verification that would have gone through on the
 * next attempt, and that is the more expensive mistake — the exact polarity qboFetch and
 * postmark.ts settled.
 *
 * Two Twilio facts callers must not have to re-learn:
 *   - On VerificationCheck, HTTP 404 with code 20404 is the NORMAL wrong-flow case, not an
 *     outage: the verification expired (Twilio's default 10-minute TTL) or was already
 *     consumed by a prior approved check. `twCheckVerification` maps it to
 *     `{approved: false, status: "expired"}` instead of throwing, so callers branch on a
 *     value ("code expired — request a new one") rather than catching an error for a flow
 *     every real user hits. The SAME 404/20404 on the START path stays a thrown permanent
 *     error — there it means the Verify Service SID points at nothing a retry will find.
 *   - 60203 (max SEND attempts) and 60202 (max CHECK attempts) are permanent-with-a-twist:
 *     Twilio locks the verification until its TTL expires, so an immediate identical retry
 *     fails identically — but the code is preserved on the error so callers can say "too
 *     many attempts, try again later" instead of treating the number as bad.
 *
 * Error bodies are never surfaced raw. Twilio echoes the PHONE NUMBER into `message`
 * ("Invalid parameter `To`: +15551234567"), and a customer's phone must not land in
 * app_errors or a tenant-facing string — the same posture as postmark.ts dropping
 * Postmark's `Message` (which echoes recipient addresses). What we keep is capped to the
 * enum-ish `code` plus the HTTP status — also what Twilio's own docs key their
 * troubleshooting on. The error message names the ENDPOINT, not the request path, because
 * the real path carries the Verify Service SID, which has no business landing in a log row.
 */

const API_BASE = "https://verify.twilio.com/v2";

/** Read at REQUEST time, never at module top: a module-top read needs a redeploy to pick
 *  up a rotated secret, which cost us a debugging session on Deposyt. */
function accountSid(): string | null {
  return Deno.env.get("TWILIO_ACCOUNT_SID") || null;
}
function authToken(): string | null {
  return Deno.env.get("TWILIO_AUTH_TOKEN") || null;
}
function verifyServiceSid(): string | null {
  return Deno.env.get("TWILIO_VERIFY_SERVICE_SID") || null;
}

/** All three secrets present — the ONE test for "may the verification path run at all".
 *  Callers gate on this before offering SMS verification; requireCreds below is the
 *  belt-and-braces for anyone reaching an API call directly. */
export function twilioConfigured(): boolean {
  return accountSid() !== null && authToken() !== null && verifyServiceSid() !== null;
}

export class TwilioNotConfigured extends Error {
  constructor(msg = "Twilio Verify is not configured on this deployment.") {
    super(msg);
    this.name = "TwilioNotConfigured";
  }
}

/**
 * A Twilio Verify API call that answered non-OK, or could not be reached at all.
 *
 * `permanent` answers "is a Retry pointless?". Claimed only on positive evidence — the
 * codes in PERMANENT_CODES — so a rate limit (HTTP 429 / code 20429), a 5xx, a network
 * failure, an unreadable body, or an unknown code all stay retryable. `status` is 0 when
 * no HTTP answer arrived; `code` is 0 when the body carried none. For 60203/60202 the
 * verdict is permanent but callers should branch on the code to message "too many
 * attempts, try again later" — see the header.
 */
export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly permanent: boolean;
  constructor(init: { message: string; status: number; code: number; permanent: boolean }) {
    super(init.message);
    this.name = "TwilioApiError";
    this.status = init.status;
    this.code = init.code;
    this.permanent = init.permanent;
  }
}

/**
 * Codes where an identical retry fails identically:
 *   60200  invalid parameter — the `To` number is malformed or not a reachable phone
 *   20404  not found — on the start path the Verify Service SID resolves to nothing
 *          (the check path intercepts this one as "expired" BEFORE the verdict applies)
 *   60205  SMS is not supported by this landline number
 *   60203  max send attempts reached — locked until the verification's TTL expires
 *   60202  max check attempts reached — same lock, on the check side
 */
const PERMANENT_CODES = new Set([60200, 20404, 60205, 60203, 60202]);

/** Pull ONLY the enum-ish `code` out of a Twilio error body. `message` is never read —
 *  see the header: it echoes the phone number. */
function codeOf(body: string): number {
  try {
    const code = (JSON.parse(body) as { code?: unknown })?.code;
    return typeof code === "number" && Number.isFinite(code) ? code : 0;
  } catch {
    return 0;
  }
}

type TwCreds = { sid: string; token: string; verifySid: string };

function requireCreds(): TwCreds {
  const sid = accountSid();
  const token = authToken();
  const verifySid = verifyServiceSid();
  if (!sid || !token || !verifySid) {
    const missing = [
      sid ? null : "TWILIO_ACCOUNT_SID",
      token ? null : "TWILIO_AUTH_TOKEN",
      verifySid ? null : "TWILIO_VERIFY_SERVICE_SID",
    ].filter((name): name is string => name !== null).join(", ");
    throw new TwilioNotConfigured(`${missing} is not set.`);
  }
  return { sid, token, verifySid };
}

/** One authenticated form-encoded POST round trip. Failures throw TwilioApiError with the
 *  verdict attached; successes return the parsed JSON body ({} when empty/unparsable). */
async function twFetch(
  creds: TwCreds,
  endpoint: "Verifications" | "VerificationCheck",
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/Services/${creds.verifySid}/${endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${creds.sid}:${creds.token}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (e) {
    // Could not reach Twilio at all — nothing about the REQUEST has been judged, so
    // permanence cannot be claimed. The message carries only the runtime's network error
    // text, never the phone number (that lives in the request body, not the error).
    throw new TwilioApiError({
      message: `Could not reach Twilio Verify: ${(e as Error).message}`,
      status: 0,
      code: 0,
      permanent: false,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    const code = codeOf(text);
    throw new TwilioApiError({
      message: `Twilio Verify API ${res.status} on ${endpoint}`
        + (code ? ` — error code ${code}` : ""),
      status: res.status,
      code,
      permanent: PERMANENT_CODES.has(code),
    });
  }
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Start an SMS verification: Twilio texts a one-time code to `toE164`. Returns the
 * verification's `status` (normally "pending") and its `sid`. The sid is informational —
 * the CHECK path keys on the phone number, not the sid, so nothing breaks if it is lost.
 */
export async function twStartVerification(toE164: string): Promise<{ status: string; sid: string }> {
  const creds = requireCreds();
  const raw = await twFetch(creds, "Verifications", { To: toE164, Channel: "sms" });
  return {
    status: typeof raw.status === "string" ? raw.status : "",
    sid: typeof raw.sid === "string" ? raw.sid : "",
  };
}

/**
 * Check a code the user typed against the pending verification for `toE164`.
 * `approved` is the ONLY success signal — any other status ("pending" after a wrong code,
 * "expired") means the user is not verified. See the header for why an HTTP 404 here comes
 * back as `{approved: false, status: "expired"}` instead of throwing.
 */
export async function twCheckVerification(
  toE164: string,
  code: string,
): Promise<{ approved: boolean; status: string }> {
  const creds = requireCreds();
  let raw: Record<string, unknown>;
  try {
    raw = await twFetch(creds, "VerificationCheck", { To: toE164, Code: code });
  } catch (e) {
    if (e instanceof TwilioApiError && e.status === 404 && e.code === 20404) {
      return { approved: false, status: "expired" };
    }
    throw e;
  }
  const status = typeof raw.status === "string" ? raw.status : "";
  return { approved: status === "approved", status };
}

/**
 * Digits → E.164, US-only. The app stores US 10-digit phones (`designs.contact.phone`
 * caps at 10 digits), so the ONLY shapes accepted are exactly 10 digits ("+1" is
 * prepended) or 11 digits starting with 1 ("+" is prepended). The caller strips
 * formatting FIRST — this function takes digits only, so "(555) 123-4567", a 9-digit
 * fragment, or anything non-US returns null and the caller must not start a verification.
 */
export function toE164US(digits: string): string | null {
  if (/^\d{10}$/.test(digits)) return "+1" + digits;
  if (/^1\d{10}$/.test(digits)) return "+" + digits;
  return null;
}
