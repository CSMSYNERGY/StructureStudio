/**
 * Postmark transport: sender-domain provisioning (Account API) and email sending (Server API).
 *
 * This is the QuickBooks-adapter split applied to email (see qboToken.ts / qboInvoice.ts):
 * this file is TRANSPORT ONLY — typed errors, request-time secrets, safe error surfaces. It
 * holds no supabase client, writes no ledger, and never decides whether an email SHOULD be
 * sent; `emailSend.ts` owns outcomes and the `email_sends` rows. Keeping the transport a
 * leaf module with zero imports is also what lets the preflight gate unit-test it offline
 * with a stubbed fetch (see postmark.test.ts).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: every failure carries a verdict — is a retry
 * pointless? A Postmark ErrorCode 406 (recipient suppressed after a hard bounce) fails
 * identically forever; offering a Retry for it is the same dead end the QuickBooks
 * disconnect-tombstone bug produced on 2026-08-03. A 429 or a 5xx is the opposite: retrying
 * IS the correct response. `permanent` is claimed only on positive evidence (the known
 * ErrorCodes below); anything ambiguous stays retryable, because a wrongly-permanent
 * verdict strands an email that would have gone through on the next attempt, and that is
 * the more expensive mistake — the exact polarity qboFetch settled.
 *
 * Two Postmark facts callers must not have to re-learn:
 *   - "Verified" means DKIM AND Return-Path BOTH. With only DKIM green, Postmark falls back
 *     to its own return path (`pm.mtasv.net`), which leaks the provider in customer-visible
 *     headers and breaks bounce alignment — so a domain is usable only when BOTH verified
 *     flags on the normalized `PmDomain` are true. Nothing here auto-activates a tenant on
 *     verify; activation is an explicit human switch in the portal (see the week plan).
 *   - Postmark RENAMES its DKIM fields across the verify boundary (`DKIMPendingHost` /
 *     `DKIMPendingTextValue` before, `DKIMHost` / `DKIMTextValue` after). `toPmDomain`
 *     folds both shapes into one, so no caller ever branches on which side of verification
 *     a domain currently sits.
 *
 * Error bodies are never surfaced raw. Postmark echoes RECIPIENT ADDRESSES into `Message`
 * ("…recipient(s) … marked as inactive: lead@example.com"), and a lead's email must not
 * land in app_errors or a tenant-facing string — the same posture as qboFetch dropping
 * Intuit's fault Detail. The enum-ish `ErrorCode` plus the HTTP status are the safe
 * substitutes, and they are also what Postmark's own docs key their troubleshooting on.
 */

const API_BASE = "https://api.postmarkapp.com";

/** Read at REQUEST time, never at module top: a module-top read needs a redeploy to pick
 *  up a rotated secret, which cost us a debugging session on Deposyt. */
function accountToken(): string | null {
  return Deno.env.get("POSTMARK_ACCOUNT_TOKEN") || null;
}
function serverToken(): string | null {
  return Deno.env.get("POSTMARK_SERVER_TOKEN") || null;
}

/** Both halves present — the ONE test for "may the email path run at all". Callers gate on
 *  this (emailSend's dark-by-construction guard); the per-call requires below are the
 *  belt-and-braces for anyone reaching a single API directly. */
export function postmarkConfigured(): boolean {
  return accountToken() !== null && serverToken() !== null;
}

export class PostmarkNotConfigured extends Error {
  constructor(msg = "Postmark is not configured on this deployment.") {
    super(msg);
    this.name = "PostmarkNotConfigured";
  }
}

/**
 * A Postmark API call that answered non-OK, or could not be reached at all.
 *
 * `permanent` answers "is a Retry pointless?". Claimed only on positive evidence — the
 * ErrorCodes in PERMANENT_ERROR_CODES — so a rate limit, a 5xx, a network failure, an
 * unreadable body, or a bad token (ErrorCode 10, which a secret rotation fixes without a
 * code change) all stay retryable. `status` is 0 when no HTTP answer arrived; `errorCode`
 * is 0 when the body carried none.
 */
export class PostmarkApiError extends Error {
  readonly status: number;
  readonly errorCode: number;
  readonly permanent: boolean;
  constructor(init: { message: string; status: number; errorCode: number; permanent: boolean }) {
    super(init.message);
    this.name = "PostmarkApiError";
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.permanent = init.permanent;
  }
}

/**
 * ErrorCodes where an identical retry fails identically:
 *   300  invalid email request — the request itself is malformed (bad From/To/body)
 *   400  sender signature or domain not found on this account
 *   401  sender signature not confirmed
 *   405  account not allowed to send (pending approval or blocked — a human unblocks
 *        this, not a retry loop)
 *   406  inactive recipient — suppressed after a hard bounce or spam complaint
 */
const PERMANENT_ERROR_CODES = new Set([300, 400, 401, 405, 406]);

/** Pull ONLY the enum-ish ErrorCode out of a Postmark error body. `Message` is never read —
 *  see the header: it echoes recipient addresses. */
function errorCodeOf(body: string): number {
  try {
    const code = (JSON.parse(body) as { ErrorCode?: unknown })?.ErrorCode;
    return typeof code === "number" && Number.isFinite(code) ? code : 0;
  } catch {
    return 0;
  }
}

type PmAuth = {
  header: "X-Postmark-Account-Token" | "X-Postmark-Server-Token";
  token: string;
};
const acct = (token: string): PmAuth => ({ header: "X-Postmark-Account-Token", token });
const srv = (token: string): PmAuth => ({ header: "X-Postmark-Server-Token", token });

function requireAccountToken(): string {
  const token = accountToken();
  if (!token) throw new PostmarkNotConfigured("POSTMARK_ACCOUNT_TOKEN is not set.");
  return token;
}
function requireServerToken(): string {
  const token = serverToken();
  if (!token) throw new PostmarkNotConfigured("POSTMARK_SERVER_TOKEN is not set.");
  return token;
}

/** One authenticated round trip. Failures throw PostmarkApiError with the verdict attached;
 *  successes return the parsed JSON (null when the body is empty or unparsable). */
async function pmFetch(auth: PmAuth, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        [auth.header]: auth.token,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (e) {
    // Could not reach Postmark at all — nothing about the REQUEST has been judged, so
    // permanence cannot be claimed. The message carries only our own URL and the runtime's
    // network error text, never provider or customer data.
    throw new PostmarkApiError({
      message: `Could not reach Postmark: ${(e as Error).message}`,
      status: 0,
      errorCode: 0,
      permanent: false,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    const errorCode = errorCodeOf(text);
    throw new PostmarkApiError({
      message: `Postmark API ${res.status} on ${path.split("?")[0]}`
        + (errorCode ? ` — error code ${errorCode}` : ""),
      status: res.status,
      errorCode,
      permanent: PERMANENT_ERROR_CODES.has(errorCode),
    });
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * One sender domain, normalized. `dkimHost`/`dkimValue` are the TXT record the tenant must
 * hold in DNS; `returnPathHost`/`returnPathValue` are the CNAME (canonically pointing at
 * `pm.mtasv.net`). The two `verified` flags are independent switches — see the header for
 * why a caller must require BOTH before treating a domain as usable.
 */
export type PmDomain = {
  id: number;
  dkimHost: string;
  dkimValue: string;
  dkimVerified: boolean;
  returnPathHost: string;
  returnPathValue: string;
  returnPathVerified: boolean;
};

/**
 * Fold Postmark's two domain shapes into one. Before verification the DKIM record lives in
 * `DKIMPendingHost`/`DKIMPendingTextValue` (`DKIMHost` is empty); after, it moves to
 * `DKIMHost`/`DKIMTextValue` and the pending pair empties. During a DKIM rotation BOTH are
 * set and the PENDING pair is the record the tenant must add — so pending wins whenever
 * present.
 */
function toPmDomain(raw: unknown): PmDomain {
  const d = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    id: typeof d.ID === "number" ? d.ID : Number(d.ID) || 0,
    dkimHost: str(d.DKIMPendingHost) || str(d.DKIMHost),
    dkimValue: str(d.DKIMPendingTextValue) || str(d.DKIMTextValue),
    dkimVerified: d.DKIMVerified === true,
    returnPathHost: str(d.ReturnPathDomain),
    returnPathValue: str(d.ReturnPathDomainCNAMEValue),
    returnPathVerified: d.ReturnPathDomainVerified === true,
  };
}

/**
 * Create a sender domain on the Postmark account. The custom Return-Path is requested at
 * creation (`pm-bounces.<name>`) rather than patched in later, so the DNS records handed to
 * the tenant are complete on the FIRST render — a tenant who adds records from an
 * incomplete first read would "verify" into the leaking pm.mtasv.net default.
 */
export async function pmCreateDomain(name: string): Promise<PmDomain> {
  const token = requireAccountToken();
  const raw = await pmFetch(acct(token), "/domains", {
    method: "POST",
    body: JSON.stringify({ Name: name, ReturnPathDomain: `pm-bounces.${name}` }),
  });
  return toPmDomain(raw);
}

/** Read one domain's current records + verification state. */
export async function pmGetDomain(id: number): Promise<PmDomain> {
  const token = requireAccountToken();
  return toPmDomain(await pmFetch(acct(token), `/domains/${id}`));
}

/**
 * Ask Postmark to re-check BOTH DNS records, then report one consolidated read.
 *
 * The two PUTs each return a domain object, but the final GET is what we hand back — one
 * read taken after both checks ran, so a caller can never see a half-updated shape (the
 * verifyDkim response predates the Return-Path check by definition). A verification that
 * simply finds the records absent is NOT an error — it comes back 200 with the verified
 * flags still false; a thrown PostmarkApiError here means the API call itself failed.
 */
export async function pmVerifyDomain(id: number): Promise<PmDomain> {
  const token = requireAccountToken();
  await pmFetch(acct(token), `/domains/${id}/verifyDkim`, { method: "PUT" });
  await pmFetch(acct(token), `/domains/${id}/verifyReturnPath`, { method: "PUT" });
  return toPmDomain(await pmFetch(acct(token), `/domains/${id}`));
}

/** Remove a domain from the Postmark account (the disconnect path). */
export async function pmDeleteDomain(id: number): Promise<void> {
  const token = requireAccountToken();
  await pmFetch(acct(token), `/domains/${id}`, { method: "DELETE" });
}

/**
 * One outgoing email. Field names are Postmark's own (they land in the request body as-is):
 * `From` must be on a verified sender domain or the platform domain; `To` is the single
 * recipient (the beta-mode redirect happens in emailSend.ts BEFORE this is built);
 * `Metadata` carries `{client_id, short_code, kind}` and `Tag` the client_id, which is how
 * one shared server stays filterable per tenant in Postmark's Activity view.
 */
export type PmSendInput = {
  From: string;
  To: string;
  Subject: string;
  HtmlBody: string;
  TextBody?: string;
  ReplyTo?: string;
  Tag?: string;
  Metadata?: Record<string, string>;
  MessageStream?: string;
};

/**
 * Send one email via the Server API. Returns Postmark's MessageID — persist it on the
 * `email_sends` row IMMEDIATELY: it is the only key the delivery/bounce webhook can match
 * on, so a lost MessageID is a send whose fate is unknowable.
 */
export async function pmSendEmail(input: PmSendInput): Promise<{ MessageID: string }> {
  const token = requireServerToken();
  const raw = await pmFetch(srv(token), "/email", {
    method: "POST",
    // The spread lets a caller override the stream; JSON.stringify drops an explicit
    // `MessageStream: undefined`, so the default survives that shape too.
    body: JSON.stringify({ MessageStream: "outbound", ...input }),
  });
  const msg = (raw ?? {}) as Record<string, unknown>;
  return { MessageID: typeof msg.MessageID === "string" ? msg.MessageID : "" };
}
