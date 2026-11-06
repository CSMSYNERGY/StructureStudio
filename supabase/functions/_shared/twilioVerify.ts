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
 * Three Twilio facts callers must not have to re-learn:
 *   - HTTP 403 with code 60204 on the START path means the Verify service refused a premium
 *     parameter it has not been enabled for. For us that was `CustomFriendlyName` ("Custom
 *     Company Name", which only Twilio Sales can switch on): it refused EVERY send that carried
 *     it, every branded text login request from 2026-08-26 to 2026-09-16 died that way behind a
 *     502 "try again", and from then until 2026-10-21 each isolate paid one refused request
 *     before resending unbranded. ⛔ NOTHING SENDS IT NOW. The builder's name comes from the
 *     SERVICE instead: each builder has their own Verify service inside their own Twilio
 *     sub-account, named after them (_shared/twilioVerifyService.ts), and a caller passes it as a
 *     VerifyTarget. Do not bring the parameter back: a Sales enable would only make it work on the
 *     parent's service, and it would still name the vendor on any service that lacks it.
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
 *  up a rotated secret, which cost us a debugging session on Deposyt.
 *
 *  ⚠️ VERIFY MAY LIVE ON A DIFFERENT TWILIO ACCOUNT FROM MESSAGING, and each reader below
 *  prefers a `TWILIO_VERIFY_*` override before falling back to the shared platform value.
 *
 *  Why the seam exists: since 2026-08-30 each builder registers their own A2P brand on the
 *  shared parent account (ISV architecture #4). Twilio can suspend that parent account over
 *  ONE builder's non-compliant messaging — and Verify is what sends the login code for
 *  `my-quotes`, so a messaging suspension would lock every customer out of their own quotes.
 *  Moving Verify to its own account removes it from that blast radius.
 *
 *  ⛔ THE OVERRIDES ARE ALL-OR-NOTHING IN PRACTICE. A Verify Service SID belongs to exactly
 *  one account, so pointing TWILIO_VERIFY_SERVICE_SID at a service in another account while
 *  leaving the credentials shared authenticates against the WRONG account and fails. If you
 *  set one override, set the matching key pair too. With none set, this behaves exactly as it
 *  did before the seam existed. */
function verifyEnv(suffix: string): string | null {
  return Deno.env.get(`TWILIO_VERIFY_${suffix}`) || Deno.env.get(`TWILIO_${suffix}`) || null;
}
function accountSid(): string | null {
  return verifyEnv("ACCOUNT_SID");
}
function authToken(): string | null {
  return verifyEnv("AUTH_TOKEN");
}
function apiKey(): string | null {
  return verifyEnv("API_KEY");
}
function apiSecret(): string | null {
  return verifyEnv("API_SECRET");
}
function verifyServiceSid(): string | null {
  return Deno.env.get("TWILIO_VERIFY_SERVICE_SID") || null;
}

/** Twilio's REST API accepts Basic auth as EITHER AccountSid:AuthToken OR
 *  ApiKeySid:ApiKeySecret ("SK…" keys — rotatable, revocable, and what the Twilio CLI's
 *  env-var profile uses). The API-key pair wins when both are present: keys are the
 *  better practice, and on 2026-08-11 the deployment's TWILIO_AUTH_TOKEN landed as an
 *  EMPTY STRING precisely because the operator's shell only had the key pair — auth-token
 *  auth must not be the only door. */
function basicAuthPair(): { user: string; pass: string } | null {
  const key = apiKey();
  const secret = apiSecret();
  if (key && secret) return { user: key, pass: secret };
  const sid = accountSid();
  const token = authToken();
  if (sid && token) return { user: sid, pass: token };
  return null;
}

/** Credentials + service SID present — the ONE test for "may the verification path run at
 *  all". Callers gate on this before offering SMS verification; requireCreds below is the
 *  belt-and-braces for anyone reaching an API call directly. It is about the PARENT's service:
 *  a builder's own service is only ever used next to it, and every builder falls back to it. */
export function twilioConfigured(): boolean {
  return basicAuthPair() !== null && verifyServiceSid() !== null;
}

/**
 * A Verify service to start and check codes on, with the credentials of the account that owns
 * it. Omitted, the parent's service and credentials come from the environment (above).
 *
 * A builder's target is their OWN service inside their OWN sub-account, read by the caller from
 * twilio_accounts.verify_service_sid (migration 323) with the sub's credentials from Vault
 * (twilioAccount.ts resolveTwilioAccount). ⚠️ The pair must belong together: a sub's service
 * with the parent's credentials (or the reverse) answers 404/20404, which reads as "not found".
 * The credentials travel as a value, never through Deno.env (twilioAccount.ts's rule).
 */
export type VerifyTarget = { serviceSid: string; user: string; pass: string };

/** The parent's own target, or null when it is not configured. For code that must ask the
 *  parent's service something (twilioVerifyService.ts reads its settings to copy them). */
export function parentVerifyTarget(): VerifyTarget | null {
  const pair = basicAuthPair();
  const serviceSid = verifyServiceSid();
  return pair && serviceSid ? { serviceSid, user: pair.user, pass: pair.pass } : null;
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
 *   60204  premium feature not enabled on the Verify service (it was Custom Company Name,
 *          which nothing sends any more); only Twilio can switch one on, so an identical
 *          retry fails identically
 *   21608  (HTTP 403) the account's messaging compliance profile is missing, so Twilio
 *          refuses sends to every number until an operator completes it (seen 22 times
 *          2026-08-12..08-19, each answered "try again")
 */
const PERMANENT_CODES = new Set([60200, 20404, 60205, 60203, 60202, 60204, 21608]);

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

type TwCreds = { user: string; pass: string; verifySid: string };

/** The target's own pair when there is one (a builder's service), else the parent's from the
 *  environment. A target with an empty field is a caller bug, refused like a missing secret. */
function requireCreds(target?: VerifyTarget): TwCreds {
  if (target) {
    if (!target.serviceSid || !target.user || !target.pass) {
      throw new TwilioNotConfigured("The builder's Verify service is missing its SID or credentials.");
    }
    return { user: target.user, pass: target.pass, verifySid: target.serviceSid };
  }
  const pair = basicAuthPair();
  const verifySid = verifyServiceSid();
  if (!pair || !verifySid) {
    const missing = [
      pair ? null : "TWILIO_API_KEY+TWILIO_API_SECRET (or TWILIO_ACCOUNT_SID+TWILIO_AUTH_TOKEN)",
      verifySid ? null : "TWILIO_VERIFY_SERVICE_SID",
    ].filter((name): name is string => name !== null).join(", ");
    throw new TwilioNotConfigured(`${missing} is not set.`);
  }
  return { user: pair.user, pass: pair.pass, verifySid };
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
        Authorization: `Basic ${btoa(`${creds.user}:${creds.pass}`)}`,
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
 * A builder's business name as a Verify service FriendlyName, which is what Twilio's default
 * text puts in "Your <friendly name> verification code is 123456". twilioVerifyService.ts names
 * each builder's own service with it.
 *
 * Twilio's rules for the name (Verify Services API): at most 30 characters, letters, digits,
 * spaces, dashes and underscores, no links or phone numbers, and NO MORE THAN 4 DIGITS in all.
 * A name it cannot take must not leave a builder's customers on our name forever, so this
 * sanitizes rather than trusts: letters, digits and spaces only, collapsed, digits kept only while
 * the total stays at 4 or fewer (a whole run of digits that would pass 4 is dropped, so "Route 66
 * Sheds 2024" keeps "66" and loses "2024"), capped at 30. A tenant's business name is free text
 * they typed: "Example Barns & Sheds, LLC" is a normal thing to type. Empty means nothing usable
 * survived: the builder gets no service of their own and their codes stay on the parent's.
 */
export function twSanitizeBrand(name: unknown): string {
  if (typeof name !== "string") return "";
  let digits = 0;
  return name
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/[0-9]+/g, (run) => {
      if (digits + run.length > 4) return " ";
      digits += run.length;
      return run;
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30)
    .trim();
}

/**
 * Start an SMS verification: Twilio texts a one-time code to `toE164`. Returns the
 * verification's `status` (normally "pending") and its `sid`. The sid is informational —
 * the CHECK path keys on the phone number, not the sid, so nothing breaks if it is lost.
 *
 * `target` is the service to send on (a builder's own, see VerifyTarget); omitted, the parent's.
 * The request is exactly `To` + `Channel`, one request, never retried here: what the text says
 * comes from the service, and a caller that wants another service after a refusal asks again
 * itself (customer-auth falls back from a builder's service to the parent's).
 */
export async function twStartVerification(
  toE164: string,
  target?: VerifyTarget,
): Promise<{ status: string; sid: string }> {
  const creds = requireCreds(target);
  const raw = await twFetch(creds, "Verifications", { To: toE164, Channel: "sms" });
  return {
    status: typeof raw.status === "string" ? raw.status : "",
    sid: typeof raw.sid === "string" ? raw.sid : "",
  };
}

/** What a failed START means for the person waiting on the code. */
export type TwStartFailure = "locked" | "number" | "config" | "transient";

/**
 * Sort a thrown start failure into what the caller should tell the customer, so the caller
 * branches on meaning instead of keeping its own copy of the code list in step with this file.
 *   transient  anything not permanent (429, 5xx, network, unknown codes): retrying may work
 *   locked     60203/60202: Twilio's own attempt lock, lifted when the verification expires
 *   config     60204/20404/21608: the Verify service or account refuses the send for EVERY
 *              number (a feature not enabled, a service SID that points at nothing, a missing
 *              messaging compliance profile). The customer cannot fix it; an operator has to
 *   number     60200/60205, and any other permanent code: this number cannot get a text
 */
export function twStartFailureKind(e: TwilioApiError): TwStartFailure {
  if (!e.permanent) return "transient";
  if (e.code === 60203 || e.code === 60202) return "locked";
  if (e.code === 60204 || e.code === 20404 || e.code === 21608) return "config";
  return "number";
}

/**
 * Did a BUILDER's service refuse in a way that says the service or its account cannot be used,
 * whoever the customer is? Then the caller should ask the parent's service instead (it sent
 * nothing, so that is still one text). True for a config refusal (60204, 20404: the service was
 * deleted, 21608) and for credentials Twilio rejects (HTTP 401, code 20003: the sub's key revoked,
 * or the sub suspended). Everything else is about this request or this number, and a second
 * service would fail it identically (60200, 60203) or might double-send it (429, 5xx, network).
 */
export function twBuilderServiceUnusable(e: TwilioApiError): boolean {
  return e.status === 401 || e.code === 20003 || twStartFailureKind(e) === "config";
}

/**
 * Check a code the user typed against the pending verification for `toE164`.
 * `approved` is the ONLY success signal — any other status ("pending" after a wrong code,
 * "expired") means the user is not verified. See the header for why an HTTP 404 here comes
 * back as `{approved: false, status: "expired"}` instead of throwing.
 *
 * `target` must be the service the code was STARTED on (a verification lives in one service):
 * checked anywhere else it reads "expired". customer-auth asks the parent's service once more
 * when a builder's says expired, for a code started there before the builder had their own.
 */
export async function twCheckVerification(
  toE164: string,
  code: string,
  target?: VerifyTarget,
): Promise<{ approved: boolean; status: string }> {
  const creds = requireCreds(target);
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
